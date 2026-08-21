/**
 * TICKET-151 — P0 hotfix: active reconciliation between the internal candle-driven simulation
 * (orchestrator.ts / slTpManager.ts's ManagedPositionState) and Binance's own confirmed state.
 * `stateReconciler.ts` stays exactly as it was designed (TICKET-076 Phần D): pure comparison +
 * log-only, never mutates anything itself. This module is the NEW active layer the ticket calls
 * for — it consumes stateReconciler's output (or a single fresh confirmation query) and decides
 * exactly what to do, conservatively, per TICKET-151 §5's rules:
 *   - never re-open/reverse/hedge a position from code here;
 *   - never blindly retry a mutating call after a response was already received;
 *   - exchange qty/exchange "position is gone" always wins over the internal simulation, but only
 *     after a FRESH, single re-query — never acted on stale mismatch data alone.
 *
 * Every function here is pure or takes an explicitly-injected executor `Pick<...>` (same
 * convention as stateReconciler.ts's `StateReconcilerConfig.executor`), so it can be unit tested
 * with a mocked executor exactly like binanceOrderExecutor.test.ts / stateReconciler.test.ts do —
 * no real network access needed. See liveStateSync.test.ts.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OrderSubmissionError } from './binanceOrderExecutor.js';
import type { BinanceOrderExecutor, OpenAlgoOrder, PositionSide } from './binanceOrderExecutor.js';
import type { OpenPositionEntry, SymbolState } from '../orchestrator/types.js';
import type { UnknownExposureForRisk } from '../risk/currentRisk.js';

// ---- P0-A: canonical executed quantity -------------------------------------------------------

export type QtySource = 'EXECUTED_QTY' | 'POSITION_RISK' | 'SUBMITTED_QTY_FALLBACK';

export interface CanonicalQtyResult {
  qty: number;
  source: QtySource;
}

/**
 * TICKET-151 §5 priority order for the REAL executed quantity of a just-opened position:
 *   1. `executedQty` from the MARKET order's own fill response (`raw` field of OrderResult) — the
 *      most direct confirmation Binance gives for THIS specific order.
 *   2. A fresh `getPositionRisk(symbol)` read of `positionAmt` — Binance's own ledger of the
 *      symbol's current position, stronger source of truth (reflects the account's real net
 *      position after all fills), used when (1) is missing/unparseable or looks obviously wrong
 *      (<=0 on what should be a filled order).
 *   3. The submitted (already stepSize-rounded) quantity — LAST RESORT ONLY, never the raw
 *      pre-normalization calculated quantity (that pre-normalization value is exactly the root
 *      cause TICKET-151 is fixing — it must never be used as a "confirmed" qty anywhere).
 *
 * `positionRiskAmt` should be `null` when the caller didn't/couldn't fetch it (e.g. dry-run) —
 * this function never calls the network itself, it only interprets already-fetched data.
 *
 * TICKET-151B (found during T151A testnet verification, Test H): Binance Futures one-way mode
 * (`positionSide:"BOTH"`) reports ONE MERGED `positionAmt` per symbol+side — it does NOT distinguish
 * "this specific order's fill" from "the account's total position on this side". With
 * `maxConcurrentPositionsPerSymbol>=2`, opening a 2nd same-symbol same-side position while the 1st
 * is still open means a naive `positionRiskAmt` read returns the SUM of both, not just the new
 * order's own qty — silently double-counting the new position's size (a real, reproduced-on-testnet
 * bug, not theoretical). `existingSameSideQtyBaseAsset` (sum of base-asset qty of OTHER already-open
 * same-symbol-same-side positions the caller already knows about internally, BEFORE this new one)
 * must be subtracted to recover the incremental (this order's own) qty. Defaults to 0, which
 * reproduces the exact pre-T151B single-position behavior byte-for-byte.
 */
export function resolveCanonicalOpenQty(params: {
  submittedQty: number;
  orderRaw: unknown;
  positionRiskAmt: number | null;
  existingSameSideQtyBaseAsset?: number;
}): CanonicalQtyResult {
  const raw = params.orderRaw as { executedQty?: string | number } | null | undefined;
  const executedQty = raw != null ? Number(raw.executedQty) : NaN;
  if (Number.isFinite(executedQty) && executedQty > 0) {
    return { qty: executedQty, source: 'EXECUTED_QTY' };
  }
  if (params.positionRiskAmt !== null && Number.isFinite(params.positionRiskAmt) && Math.abs(params.positionRiskAmt) > 0) {
    const existing = params.existingSameSideQtyBaseAsset ?? 0;
    const incremental = Math.abs(params.positionRiskAmt) - existing;
    // Only trust the derived incremental value when it's still a sane positive qty — if our own
    // existing-qty bookkeeping doesn't reconcile cleanly against the exchange's merged total (e.g.
    // existing >= total, which should never happen if internal state is accurate), fall through to
    // submittedQty rather than return a zero/negative/nonsensical "canonical" qty.
    if (incremental > 0) {
      return { qty: incremental, source: 'POSITION_RISK' };
    }
  }
  return { qty: params.submittedQty, source: 'SUBMITTED_QTY_FALLBACK' };
}

// ---- TICKET-G1R Checkpoint B: executed-state reconciliation (G1-F05) --------------------------

export type EntryPriceBasis = 'OBSERVED_AVG_FILL' | 'POSITION_RISK_ENTRY_PRICE';

const ENTRY_PRICE_AGREEMENT_TOLERANCE_PCT = 0.005;

export interface ReconcileExecutedOpenStateInput {
  initialSlPrice: number;
  canonicalQty: number;
  canonicalQtySource: QtySource;
  rawAvgPrice: unknown;
  freshPositionRiskEntryPrice: unknown;
  freshPositionRiskQtyAbs: number | null;
  preSubmissionBaselineQtyAbs: number | null;
  quantityTolerance: number;
  leverage: number;
}

export type ReconcileExecutedOpenStateResult =
  | {
      ok: true;
      entryPrice: number;
      entryPriceBasis: EntryPriceBasis;
      r: number;
      positionSize: number;
      actualRiskDollar: number;
      marginRequired: number;
    }
  | {
      ok: false;
      reason: 'CANONICAL_QTY_UNCONFIRMED' | 'CANONICAL_QTY_INVALID' | 'ZERO_STOP_DISTANCE_AFTER_RECONCILE' | 'ENTRY_PRICE_UNAVAILABLE' | 'ENTRY_PRICE_DISAGREEMENT' | 'QUANTITY_MISMATCH' | 'PRE_SUBMISSION_BASELINE_UNAVAILABLE' | 'POST_FILL_POSITION_UNAVAILABLE';
    };

export function reconcileExecutedOpenState(input: ReconcileExecutedOpenStateInput): ReconcileExecutedOpenStateResult {
  if (input.canonicalQtySource === 'SUBMITTED_QTY_FALLBACK') {
    return { ok: false, reason: 'CANONICAL_QTY_UNCONFIRMED' };
  }
  if (!Number.isFinite(input.canonicalQty) || input.canonicalQty <= 0) {
    return { ok: false, reason: 'CANONICAL_QTY_INVALID' };
  }
  if (input.preSubmissionBaselineQtyAbs === null || !Number.isFinite(input.preSubmissionBaselineQtyAbs) || input.preSubmissionBaselineQtyAbs < 0) {
    return { ok: false, reason: 'PRE_SUBMISSION_BASELINE_UNAVAILABLE' };
  }
  if (input.freshPositionRiskQtyAbs === null || !Number.isFinite(input.freshPositionRiskQtyAbs) || input.freshPositionRiskQtyAbs < 0) {
    return { ok: false, reason: 'POST_FILL_POSITION_UNAVAILABLE' };
  }

  const parsedAvgPrice = Number(input.rawAvgPrice);
  const hasAvgPrice = Number.isFinite(parsedAvgPrice) && parsedAvgPrice > 0;
  const parsedPositionEntryPrice = Number(input.freshPositionRiskEntryPrice);
  const hasPositionEntryPrice = Number.isFinite(parsedPositionEntryPrice) && parsedPositionEntryPrice > 0;

  let entryPrice: number;
  let entryPriceBasis: EntryPriceBasis;
  if (hasAvgPrice && hasPositionEntryPrice) {
    const relDiff = Math.abs(parsedAvgPrice - parsedPositionEntryPrice) / parsedPositionEntryPrice;
    if (relDiff > ENTRY_PRICE_AGREEMENT_TOLERANCE_PCT) {
      return { ok: false, reason: 'ENTRY_PRICE_DISAGREEMENT' };
    }
    entryPrice = parsedAvgPrice;
    entryPriceBasis = 'OBSERVED_AVG_FILL';
  } else if (hasAvgPrice) {
    entryPrice = parsedAvgPrice;
    entryPriceBasis = 'OBSERVED_AVG_FILL';
  } else if (hasPositionEntryPrice) {
    entryPrice = parsedPositionEntryPrice;
    entryPriceBasis = 'POSITION_RISK_ENTRY_PRICE';
  } else {
    return { ok: false, reason: 'ENTRY_PRICE_UNAVAILABLE' };
  }

  const expectedTotalQtyAbs = input.preSubmissionBaselineQtyAbs + input.canonicalQty;
  const qtyDiff = Math.abs(input.freshPositionRiskQtyAbs - expectedTotalQtyAbs);
  if (qtyDiff > input.quantityTolerance) {
    return { ok: false, reason: 'QUANTITY_MISMATCH' };
  }

  const r = Math.abs(entryPrice - input.initialSlPrice);
  if (r <= 0) {
    return { ok: false, reason: 'ZERO_STOP_DISTANCE_AFTER_RECONCILE' };
  }
  const slDistancePercent = r / entryPrice;
  const positionSize = input.canonicalQty * entryPrice;
  const actualRiskDollar = positionSize * slDistancePercent;
  const marginRequired = positionSize / input.leverage;

  return { ok: true, entryPrice, entryPriceBasis, r, positionSize, actualRiskDollar, marginRequired };
}

export interface PositionRiskSideEvidence {
  qtyAbs: number;
  entryPrice: unknown;
}

export async function readPositionRiskForSide(executor: Pick<BinanceOrderExecutor, 'getPositionRisk'>, symbol: string, side: PositionSide): Promise<PositionRiskSideEvidence | null> {
  try {
    const raw = await executor.getPositionRisk(symbol);
    const entries = raw as Array<{ symbol?: string; positionAmt?: string; entryPrice?: string }> | null;
    if (!Array.isArray(entries)) return null;
    const found = entries.find((e) => e.symbol === symbol);
    if (!found) return { qtyAbs: 0, entryPrice: null };
    const amt = Number(found.positionAmt);
    if (!Number.isFinite(amt)) return null;
    const matchesSide = side === 'LONG' ? amt > 0 : amt < 0;
    return matchesSide ? { qtyAbs: Math.abs(amt), entryPrice: found.entryPrice } : { qtyAbs: 0, entryPrice: null };
  } catch {
    return null;
  }
}

export function isSlGeometryValidForFill(side: PositionSide, entryPrice: number, slPrice: number): boolean {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(slPrice) || slPrice <= 0 || entryPrice === slPrice) {
    return false;
  }
  return side === 'LONG' ? slPrice < entryPrice : slPrice > entryPrice;
}

// ---- P0-B: step-size-aware tolerance + RECONCILE_QTY_SYNC ------------------------------------

// TODO_CONFIRM (PM): 1.5x stepSize covers one full lot-size rounding step either direction plus a
// small float-noise margin, without being so loose it would hide a real multi-lot mismatch.
const QUANTITY_TOLERANCE_STEP_MULTIPLIER = 1.5;

/** Replaces stateReconciler.ts's fixed `DEFAULT_QUANTITY_TOLERANCE = 1e-8` (far tighter than any real lot size) with a tolerance tied to the symbol's actual stepSize. */
export function computeQuantityTolerance(stepSize: number): number {
  if (!Number.isFinite(stepSize) || stepSize <= 0) {
    throw new Error(`computeQuantityTolerance: stepSize phải > 0, nhận được ${stepSize}`);
  }
  return stepSize * QUANTITY_TOLERANCE_STEP_MULTIPLIER;
}

export interface QtySyncFields {
  symbol: string;
  side: PositionSide;
  internalQtyBefore: number;
  exchangeQty: number;
  internalQtyAfter: number;
  stepSize: number;
  reason: string;
}

export function formatReconcileQtySyncLog(f: QtySyncFields): string {
  return `[RECONCILE_QTY_SYNC] symbol=${f.symbol} side=${f.side} internalQtyBefore=${f.internalQtyBefore} exchangeQty=${f.exchangeQty} internalQtyAfter=${f.internalQtyAfter} stepSize=${f.stepSize} reason=${f.reason}`;
}

export interface QuantityMismatchCheck {
  symbol: string;
  side: PositionSide;
  internalQty: number;
  exchangeQty: number;
  stepSize: number;
  reason: string;
}

export interface QuantityMismatchResult {
  mismatched: boolean;
  correctedQty: number;
  logLine: string | null;
}

/**
 * TICKET-151 §5 P0-B: exchange qty wins on a confirmed mismatch beyond stepSize-aware tolerance.
 * Pure decision function — caller applies `correctedQty` to whatever holds the internal qty
 * (ManagedPositionState.positionSize/remainingPositionSize expressed in quote-notional, or a raw
 * base-asset qty, depending on call site) and logs `logLine` when non-null.
 */
export function checkQuantityMismatch(input: QuantityMismatchCheck): QuantityMismatchResult {
  const tolerance = computeQuantityTolerance(input.stepSize);
  const diff = Math.abs(input.exchangeQty - input.internalQty);
  if (diff <= tolerance) {
    return { mismatched: false, correctedQty: input.internalQty, logLine: null };
  }
  const logLine = formatReconcileQtySyncLog({
    symbol: input.symbol,
    side: input.side,
    internalQtyBefore: input.internalQty,
    exchangeQty: input.exchangeQty,
    internalQtyAfter: input.exchangeQty,
    stepSize: input.stepSize,
    reason: input.reason,
  });
  return { mismatched: true, correctedQty: input.exchangeQty, logLine };
}

// ---- P0-E: idempotent -2011 ("Unknown order sent") handling ----------------------------------

/** Matches Binance's -2011 error code AND its literal English message text (belt-and-suspenders — signedMutate()'s error message embeds the raw response body verbatim, see binanceOrderExecutor.ts). */
export function isOrderAlreadyTerminalBinanceError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('-2011') || /unknown order sent/i.test(message);
}

export interface CleanupOrderAlreadyTerminalFields {
  symbol: string;
  algoId: number;
  context: string;
  reason: string;
}

export function formatCleanupOrderAlreadyTerminalLog(f: CleanupOrderAlreadyTerminalFields): string {
  return `[CLEANUP_ORDER_ALREADY_TERMINAL] symbol=${f.symbol} algoId=${f.algoId} context=${f.context} reason=${f.reason}`;
}

export type CancelAlgoOrderOutcome = { status: 'CANCELLED' } | { status: 'ALREADY_TERMINAL'; logLine: string } | { status: 'ERROR'; error: Error };

/**
 * TICKET-151 §5 P0-E — wraps `executor.cancelAlgoOrder()`. A -2011 is treated as "already
 * cleared, nothing to do" ONLY when `isPositionConfirmedClosed` is true (the caller must have
 * ALREADY independently confirmed via a fresh exchange query — e.g. the P0-C workflow below —
 * that this position is genuinely gone; never inferred from the -2011 itself). Outside that
 * confirmed context a -2011 stays a loud ERROR — e.g. an SL placement race or a genuinely wrong
 * algoId must never be silently swallowed, per the ticket's explicit "chỉ xử lý như terminal khi
 * position state đã được xác nhận an toàn" rule. Never retries the cancel call itself — a single
 * attempt, then interpret the outcome.
 */
export async function cancelAlgoOrderIdempotent(
  executor: Pick<BinanceOrderExecutor, 'cancelAlgoOrder'>,
  symbol: string,
  algoId: number,
  context: string,
  isPositionConfirmedClosed: boolean,
): Promise<CancelAlgoOrderOutcome> {
  try {
    await executor.cancelAlgoOrder(symbol, algoId);
    return { status: 'CANCELLED' };
  } catch (err) {
    const error = err as Error;
    if (isPositionConfirmedClosed && isOrderAlreadyTerminalBinanceError(error)) {
      const logLine = formatCleanupOrderAlreadyTerminalLog({
        symbol,
        algoId,
        context,
        reason: 'position đã được xác nhận đóng qua fresh exchange query — -2011 nghĩa là lệnh này đã tự hết hiệu lực (khớp/hủy/hết hạn), không phải lỗi thật',
      });
      return { status: 'ALREADY_TERMINAL', logLine };
    }
    return { status: 'ERROR', error };
  }
}

// ---- P0-C / §6: external-close reconciliation + conservative reason classification -----------

export type ExternalCloseReason = 'SL' | 'TP1' | 'TP2' | 'TP3_RUNNER' | 'COUNTER_TREND_TP' | 'UNKNOWN_EXCHANGE_CLOSE';

export interface KnownTpLevelForClassification {
  label: 'TP1' | 'TP2' | 'TP3_RUNNER' | 'COUNTER_TREND_TP';
  price: number | null;
  closePercent: number;
}

export interface ClassifyCloseInput {
  side: PositionSide;
  entryPrice: number;
  slPrice: number;
  remainingBaseAssetQty: number; // the ACTUAL exchange-confirmed remaining size at the time of close (not the pre-fix internal value)
  tpLevels: KnownTpLevelForClassification[];
  /** GET /fapi/v1/income entries (REALIZED_PNL type) covering the window since this position's last known-good state. Standard Binance Futures income fields: symbol, incomeType, income (string), time. */
  incomeEntries: Array<{ incomeType?: string; income?: string | number }>;
}

export interface ClassifyCloseResult {
  reason: ExternalCloseReason;
  realizedPnlUsd: number | null; // sum of REALIZED_PNL income entries found; null when none found at all
  evidence: string;
}

// Loose tolerance because the expected P&L is a pre-fee, pre-slippage estimate from known
// SL/TP prices — real fills/fees/funding shift the actual number. This is ONLY used to pick the
// closest confident match; anything outside this band (or with no income data at all) is reported
// as UNKNOWN_EXCHANGE_CLOSE rather than guessed. TODO_CONFIRM (PM): 30% relative band, chosen to
// be wide enough for fees+slippage but tight enough to still tell SL apart from TP in practice.
const CLOSE_REASON_MATCH_TOLERANCE_PCT = 0.3;

/**
 * TICKET-151 §6 — classifies an externally-observed close using ONLY real exchange evidence
 * (GET /fapi/v1/income's REALIZED_PNL entries), matched against this position's OWN known SL/TP
 * prices. Deliberately does NOT attempt to distinguish MANUAL close or LIQUIDATION from a
 * regular SL/TP fill — Binance's income response carries no reliable order-type/trigger-type tag
 * for that (see BinanceOrderExecutor.getIncome()'s own TICKET-107 doc comment on attribution
 * ambiguity), and TICKET-151's own instruction is explicit: "if you can't be sure, use
 * UNKNOWN_EXCHANGE_CLOSE, never guess from price alone." Both of those cases — along with any
 * case where no income entry matches within tolerance — fall into UNKNOWN_EXCHANGE_CLOSE.
 */
export function classifyExternalCloseReason(input: ClassifyCloseInput): ClassifyCloseResult {
  const realizedEntries = input.incomeEntries.filter((e) => e.incomeType === undefined || e.incomeType === 'REALIZED_PNL');
  if (realizedEntries.length === 0) {
    return { reason: 'UNKNOWN_EXCHANGE_CLOSE', realizedPnlUsd: null, evidence: 'không có income entry REALIZED_PNL nào trong cửa sổ thời gian tra cứu' };
  }
  const realizedPnlUsd = realizedEntries.reduce((sum, e) => sum + (Number(e.income) || 0), 0);

  const sideMultiplier = input.side === 'LONG' ? 1 : -1;
  const candidates: Array<{ label: ExternalCloseReason; expectedPnl: number }> = [
    { label: 'SL', expectedPnl: sideMultiplier * (input.slPrice - input.entryPrice) * input.remainingBaseAssetQty },
  ];
  for (const tp of input.tpLevels) {
    if (tp.price === null) continue; // TP3_RUNNER trailing tier has no fixed price to compare against
    candidates.push({ label: tp.label, expectedPnl: sideMultiplier * (tp.price - input.entryPrice) * input.remainingBaseAssetQty * tp.closePercent });
  }

  let best: { label: ExternalCloseReason; expectedPnl: number; relDiff: number } | null = null;
  for (const c of candidates) {
    if (c.expectedPnl === 0) continue;
    const relDiff = Math.abs(realizedPnlUsd - c.expectedPnl) / Math.abs(c.expectedPnl);
    if (best === null || relDiff < best.relDiff) best = { ...c, relDiff };
  }

  if (best !== null && best.relDiff <= CLOSE_REASON_MATCH_TOLERANCE_PCT) {
    return {
      reason: best.label,
      realizedPnlUsd,
      evidence: `realizedPnlUsd=${realizedPnlUsd.toFixed(4)} khớp gần nhất với ${best.label} (expected=${best.expectedPnl.toFixed(4)}, relDiff=${(best.relDiff * 100).toFixed(1)}%)`,
    };
  }
  return {
    reason: 'UNKNOWN_EXCHANGE_CLOSE',
    realizedPnlUsd,
    evidence: `realizedPnlUsd=${realizedPnlUsd.toFixed(4)} không khớp đủ gần (trong ${(CLOSE_REASON_MATCH_TOLERANCE_PCT * 100).toFixed(0)}%) với bất kỳ SL/TP nào đã biết — không đoán, báo cáo UNKNOWN`,
  };
}

// ---- P0-C: the 11-step position-missing-on-exchange workflow ---------------------------------

export interface ExternalCloseWorkflowInput {
  symbol: string;
  side: PositionSide;
  entryPrice: number;
  slPrice: number;
  tpLevels: KnownTpLevelForClassification[];
  /** The internal qty (base asset) BEFORE this reconcile — for the log line only. */
  internalQtyBeforeBaseAsset: number;
  /** actualRiskDollar/marginRequired currently attributed to this position — released (returned to caller) once reconcile confirms the close. */
  actualRiskDollar: number;
  marginRequired: number;
  /** Timestamp to start the income lookup window from — should be the position's own entryTimestamp, or last-known-good reconcile time, whichever is later; never "since epoch" (bounded, cheap query). */
  incomeWindowStartMs: number;
  incomeWindowEndMs: number;
}

export interface ExternalCloseWorkflowResult {
  /** False when the fresh re-query found the position is NOT actually missing (stale mismatch data / false alarm) — caller must NOT touch internal state in this case. */
  confirmedClosed: boolean;
  closeReason?: ExternalCloseReason;
  realizedPnlUsd?: number | null;
  releasedRiskDollar?: number;
  releasedMarginDollar?: number;
  logLine?: string;
  evidence?: string;
}

/**
 * TICKET-151 §5 P0-C — the ACTIVE reconciliation workflow for `POSITION_MISSING_ON_EXCHANGE`.
 * Deliberately conservative and read-only against the exchange (no mutating call here beyond what
 * the caller separately does via `cancelAlgoOrderIdempotent()` for any still-resting SL/TP algo
 * orders — Binance does NOT auto-cancel those when a position closes, per
 * binanceOrderExecutor.ts's own `cancelAlgoOrder()` doc comment):
 *   1. re-query getPositionRisk(symbol) — a FRESH read, not the possibly-stale mismatch snapshot
 *      that triggered this call — to rule out a race (e.g. mismatch detected mid-fill).
 *   2. if the fresh read still shows zero position -> query getIncome() for real PnL evidence.
 *   3. classify the close reason conservatively (classifyExternalCloseReason above).
 *   4. return the risk$/margin$ to release and the exact ONE `[RECONCILE_POSITION_CLOSED]` log
 *      line — the caller (liveRunner.ts) applies this to its own SymbolState.openPositions (same
 *      removal the simulator's own CLOSE event path does) and refreshes accountBalance from the
 *      exchange AFTER this, never before (see module doc + liveRunner.ts wiring).
 * Never fabricates a PnL number beyond what getIncome() actually returned — P0-D's requirement.
 */
export async function reconcileExternalPositionClose(
  executor: Pick<BinanceOrderExecutor, 'getPositionRisk' | 'getIncome'>,
  input: ExternalCloseWorkflowInput,
): Promise<ExternalCloseWorkflowResult> {
  const freshPositionRisk = (await executor.getPositionRisk(input.symbol)) as Array<{ symbol?: string; positionAmt?: string }>;
  const freshAmt = Array.isArray(freshPositionRisk) ? Number(freshPositionRisk.find((p) => p.symbol === input.symbol)?.positionAmt ?? '0') : 0;
  if (Number.isFinite(freshAmt) && freshAmt !== 0) {
    // Position is actually still there — the mismatch that triggered this call was stale/racy.
    // Do NOT touch internal state; never guess/assume it's closed without fresh confirmation.
    return { confirmedClosed: false };
  }

  let incomeEntries: Array<{ incomeType?: string; income?: string | number }> = [];
  try {
    const raw = await executor.getIncome(input.symbol, input.incomeWindowStartMs, input.incomeWindowEndMs);
    if (Array.isArray(raw)) incomeEntries = raw as Array<{ incomeType?: string; income?: string | number }>;
  } catch {
    // getIncome failure must not block closing out the internal ghost position — position IS
    // confirmed gone via getPositionRisk above; classification just degrades to UNKNOWN.
    incomeEntries = [];
  }

  const classification = classifyExternalCloseReason({
    side: input.side,
    entryPrice: input.entryPrice,
    slPrice: input.slPrice,
    remainingBaseAssetQty: input.internalQtyBeforeBaseAsset,
    tpLevels: input.tpLevels,
    incomeEntries,
  });

  const logLine =
    `[RECONCILE_POSITION_CLOSED] symbol=${input.symbol} side=${input.side} closeReason=${classification.reason} ` +
    `realizedPnlUsd=${classification.realizedPnlUsd ?? 'unknown'} releasedRiskDollar=${input.actualRiskDollar} releasedMarginDollar=${input.marginRequired} ` +
    `internalQtyBefore=${input.internalQtyBeforeBaseAsset} classification='reconciled_external_close' evidence="${classification.evidence}"`;

  return {
    confirmedClosed: true,
    closeReason: classification.reason,
    realizedPnlUsd: classification.realizedPnlUsd,
    releasedRiskDollar: input.actualRiskDollar,
    releasedMarginDollar: input.marginRequired,
    logLine,
  };
}

// ---- §11: per-symbol reconcile guard (race-condition audit) ----------------------------------

/**
 * TICKET-151 §11 — minimal guard against the specific races the ticket describes: two concurrent
 * reconcile passes for the same symbol double-closing/double-releasing risk, or a NEW entry
 * opening on a symbol while its external-close reconcile is still in flight. Deliberately NOT a
 * general concurrency redesign — just a per-symbol in-flight marker the caller checks before
 * starting a new reconcile AND before allowing handleOpenEvent() to open on that symbol.
 */
export class ReconcileGuard {
  private readonly inFlight = new Set<string>();

  isReconciling(symbol: string): boolean {
    return this.inFlight.has(symbol);
  }

  /** Returns false (and does nothing) if `symbol` is already being reconciled — caller must skip starting a second one. */
  tryStart(symbol: string): boolean {
    if (this.inFlight.has(symbol)) return false;
    this.inFlight.add(symbol);
    return true;
  }

  finish(symbol: string): void {
    this.inFlight.delete(symbol);
  }
}

// ---- TICKET-G1R Checkpoint C (G1-F14): restart persistence + startup reconciliation -----------
//
// Design: a single JSON file (schemaVersioned, written atomically) holds, per symbol, the FULL
// last-known-good SymbolState — openPositions already carries partial-fill remainingPositionSize /
// SL ratchets / TP levels exactly as slTpManager.ts left them, nothing is recomputed on restart —
// plus the algoId bookkeeping liveRunner.ts needs to keep managing each open position's real SL/TP
// orders. On restart this is combined with ONE fresh getPositionRisk() read: a persisted position is
// only "recovered" (trusted, actively managed again) when the exchange's own reported qty for that
// symbol+side is compatible with the persisted qty within a stepSize-based tolerance — this IS the
// ownership-proof rule. Anything the exchange reports that fails this proof (no persisted record at
// all, or persisted/exchange qty diverging beyond tolerance) is never adopted into openPositions —
// the caller must leave it alone and block new entries on that symbol (PENDING_RECONCILIATION),
// same "never auto-adopt/close/cancel" rule as every other active-reconcile path in this file.

export const LIVE_STATE_SCHEMA_VERSION = 1;

export interface PersistedOrderIds {
  slAlgoId: number | null;
  tpAlgoIds: number[];
}

export interface PersistedSymbolRecord {
  symbolState: SymbolState;
  /** JSON-safe form of liveRunner.ts's `Map<entryTimestamp, LiveOrderIds>`. */
  orderIds: Array<[number, PersistedOrderIds]>;
  /**
   * TICKET-G3R — the 5m candle `symbolState.regimeState` was produced from. Optional (absent in files
   * written before G3R, and null before this process has confirmed any candle), and its absence makes
   * the persisted regime state unusable rather than trusted: without a candle-boundary anchor there is
   * no way to tell a current state from one that predates a DANGER_ZONE the process slept through.
   * See regimeStateReconstruction.ts's decideRegimeStateSource(). Never read by Checkpoint C's
   * position-ownership logic, which is unchanged.
   */
  regimeStateCandleTimestamp?: number | null;
}

export type PendingEntryQuarantinePhase = 'AMBIGUOUS_SUBMISSION' | 'FILLED_UNPROTECTED' | 'FILLED_INTERNAL_STATE_MISSING' | 'RECONCILIATION_FAILED';

export interface QuarantineExposureBasis {
  side: PositionSide;
  qty: number | null;
  entryPrice: number | null;
}

export interface PendingEntryQuarantineRecord {
  symbol: string;
  side: PositionSide;
  phase: PendingEntryQuarantinePhase;
  clientOrderId: string;
  orderId: number | null;
  executedQty: number | null;
  averageFillPrice: unknown;
  plannedEntryPrice: number | null;
  plannedSlPrice: number | null;
  reconciledEntryPrice: number | null;
  reconciledPositionSize: number | null;
  protectionOutcome: string | null;
  actualRiskDollar: number | null;
  marginRequired: number | null;
  protectionStatus: string | null;
  recoveryStatus: string | null;
  recoveryDetail: string | null;
  exposureBasis: QuarantineExposureBasis | null;
  entryTimestamp: number;
  reason: string;
  detectedAtMs: number;
}

export function quarantineRecordToRiskExposure(record: PendingEntryQuarantineRecord, index: number): UnknownExposureForRisk {
  return { id: `${record.symbol}:${record.phase}:PENDING_ENTRY_QUARANTINE:${index}`, basis: null };
}

export interface LiveStateFile {
  schemaVersion: number;
  savedAtMs: number;
  symbols: Record<string, PersistedSymbolRecord>;
  pendingEntryQuarantines?: Record<string, PendingEntryQuarantineRecord[]>;
}

/**
 * Atomic write: a temp file in the SAME directory (so the rename below is a same-filesystem, single
 * metadata operation), then rename over the target. A process crash before the rename leaves only
 * the harmless temp file behind; the target either has the old complete content or the new complete
 * content, never a half-written mix.
 */
export function writeLiveStateFileAtomic(filePath: string, file: LiveStateFile): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmpPath, JSON.stringify(file, null, 2), 'utf8');
  renameSync(tmpPath, filePath);
}

export type LoadLiveStateResult = { status: 'OK'; file: LiveStateFile } | { status: 'NOT_FOUND' } | { status: 'CORRUPT'; error: string };

/**
 * Never throws. A missing file (first-ever start) and a corrupt/partial file (crash mid-write, a
 * schemaVersion this build no longer understands, manual edit) are both routine, expected inputs the
 * startup reconciliation must degrade safely from, not crash on — both end up with zero TRUSTED
 * persisted positions (see performStartupRestartRecovery), so any real exchange position is
 * quarantined rather than silently adopted. CORRUPT is reported distinctly from NOT_FOUND purely for
 * operator visibility (it means real prior state may have been lost, not just "first run").
 */
export function readLiveStateFileSafe(filePath: string): LoadLiveStateResult {
  if (!existsSync(filePath)) return { status: 'NOT_FOUND' };
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    return { status: 'CORRUPT', error: `đọc file lỗi: ${(err as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { status: 'CORRUPT', error: `JSON không hợp lệ (có thể do crash giữa lúc ghi): ${(err as Error).message}` };
  }
  const file = parsed as Partial<LiveStateFile> | null;
  if (file === null || typeof file !== 'object' || file.schemaVersion !== LIVE_STATE_SCHEMA_VERSION || typeof file.symbols !== 'object' || file.symbols === null) {
    return {
      status: 'CORRUPT',
      error: `schemaVersion không khớp (nhận ${JSON.stringify((file as { schemaVersion?: unknown } | null)?.schemaVersion)}, cần ${LIVE_STATE_SCHEMA_VERSION}) hoặc thiếu field symbols`,
    };
  }
  return { status: 'OK', file: file as LiveStateFile };
}

// ---- ownership-proof matching, per symbol+side ------------------------------------------------

export type SideRecoveryStatus = 'CLEAN' | 'RECOVERED' | 'STALE_LOCAL' | 'QUARANTINED';

export interface SideRecoveryDecision {
  status: SideRecoveryStatus;
  /** Only set for RECOVERED — the exchange's own qty (base asset) for this side, to correct persisted remainingPositionSize onto. */
  correctedBaseQty?: number;
  detail: string;
}

function sumRemainingBaseQty(entries: OpenPositionEntry[]): number {
  return entries.reduce((sum, e) => sum + e.position.remainingPositionSize / e.position.entryPrice, 0);
}

/**
 * Ownership-proof rule, concretely: a persisted OpenPositionEntry exists for this symbol+side AND
 * the exchange's own reported qty for that side is compatible with the persisted remaining qty
 * within `quantityTolerance` (same stepSize-based tolerance as computeQuantityTolerance() elsewhere
 * in this file). Anything else — no persisted record at all, or a persisted record that doesn't
 * reconcile within tolerance — FAILS the proof; the caller must quarantine, never adopt.
 */
export function decideSideRecovery(params: { persistedEntries: OpenPositionEntry[]; exchangeBaseQty: number; quantityTolerance: number }): SideRecoveryDecision {
  const persistedBaseQty = sumRemainingBaseQty(params.persistedEntries);
  const hasPersisted = params.persistedEntries.length > 0;
  const hasExchange = Math.abs(params.exchangeBaseQty) > params.quantityTolerance;

  if (!hasPersisted && !hasExchange) {
    return { status: 'CLEAN', detail: 'không có vị thế nào (đã persist lẫn trên sàn)' };
  }
  if (hasPersisted && !hasExchange) {
    return {
      status: 'STALE_LOCAL',
      detail: `persisted có vị thế qty=${persistedBaseQty} nhưng sàn KHÔNG còn — coi là đã đóng khi bot offline (SL/TP/thao tác tay), loại khỏi trạng thái nội bộ`,
    };
  }
  if (!hasPersisted && hasExchange) {
    return {
      status: 'QUARANTINED',
      detail: `sàn có vị thế qty=${params.exchangeBaseQty} nhưng KHÔNG có bản ghi persisted nào chứng minh ownership — KHÔNG tự nhận quản lý, chuyển PENDING_RECONCILIATION`,
    };
  }
  const diff = Math.abs(persistedBaseQty - params.exchangeBaseQty);
  if (diff <= params.quantityTolerance) {
    return {
      status: 'RECOVERED',
      correctedBaseQty: params.exchangeBaseQty,
      detail: `khớp trong dung sai (persisted=${persistedBaseQty}, sàn=${params.exchangeBaseQty}, diff=${diff}, dung sai=${params.quantityTolerance})`,
    };
  }
  return {
    status: 'QUARANTINED',
    detail: `persisted=${persistedBaseQty} và sàn=${params.exchangeBaseQty} lệch ${diff} vượt dung sai ${params.quantityTolerance} — không chắc chắn ownership/khối lượng, chuyển PENDING_RECONCILIATION`,
  };
}

export interface SideRecoveryOutcome extends SideRecoveryDecision {
  side: PositionSide;
}

export interface SymbolRestartRecoveryOutcome {
  symbol: string;
  sideOutcomes: SideRecoveryOutcome[];
  symbolState: SymbolState;
  orderIds: Map<number, PersistedOrderIds>;
  /** True when ANY side on this symbol is QUARANTINED — caller blocks new entries on the WHOLE symbol (one risk pool, never split by side) until manual review. */
  blockEntries: boolean;
}

/**
 * Pure — combines one symbol's persisted record with the exchange-reported per-side qty into the
 * final recovered SymbolState. No network/executor access here; see performStartupRestartRecovery
 * for the exchange read this is fed from.
 */
export function recoverSymbolState(params: {
  symbol: string;
  persisted: PersistedSymbolRecord | undefined;
  exchangeBaseQtyBySide: Record<PositionSide, number>;
  quantityTolerance: number;
  initialSymbolState: SymbolState;
}): SymbolRestartRecoveryOutcome {
  const persistedOpenPositions = params.persisted?.symbolState.openPositions ?? [];
  const persistedOrderIdsByTimestamp = new Map(params.persisted?.orderIds ?? []);
  const sideOutcomes: SideRecoveryOutcome[] = [];
  const recoveredPositions: OpenPositionEntry[] = [];
  const orderIds = new Map<number, PersistedOrderIds>();
  let blockEntries = false;

  for (const side of ['LONG', 'SHORT'] as PositionSide[]) {
    const sidePersisted = persistedOpenPositions.filter((e) => e.position.side === side);
    const decision = decideSideRecovery({ persistedEntries: sidePersisted, exchangeBaseQty: params.exchangeBaseQtyBySide[side] ?? 0, quantityTolerance: params.quantityTolerance });
    sideOutcomes.push({ side, ...decision });

    if (decision.status === 'RECOVERED') {
      if (sidePersisted.length === 1 && decision.correctedBaseQty !== undefined) {
        const only = sidePersisted[0];
        const correctedRemaining = decision.correctedBaseQty * only.position.entryPrice;
        recoveredPositions.push({ ...only, position: { ...only.position, remainingPositionSize: correctedRemaining } });
      } else {
        // KNOWN LIMITATION: 2 concurrent same-side positions (maxConcurrentPositionsPerSymbol=2) —
        // cannot disambiguate which one absorbed a qty drift from a single merged exchange qty, same
        // conservative refusal liveRunner.ts's handlePositionMissingOnExchange() already documents
        // for the analogous case. Persisted values kept as-is (still internally consistent, just not
        // re-corrected onto the exact exchange qty).
        recoveredPositions.push(...sidePersisted);
      }
      for (const p of sidePersisted) {
        const ids = persistedOrderIdsByTimestamp.get(p.meta.entryTimestamp);
        if (ids) orderIds.set(p.meta.entryTimestamp, ids);
      }
    } else if (decision.status === 'QUARANTINED') {
      blockEntries = true;
    }
    // STALE_LOCAL / CLEAN: nothing added to recoveredPositions — dropped or never existed.
  }

  const symbolState: SymbolState = params.persisted ? { ...params.persisted.symbolState, openPositions: recoveredPositions } : params.initialSymbolState;

  return { symbol: params.symbol, sideOutcomes, symbolState, orderIds, blockEntries };
}

export type RestartRecoveryResult = { ok: true; symbols: SymbolRestartRecoveryOutcome[] } | { ok: false; reason: string };

/**
 * TICKET-G1R Checkpoint C — the full startup workflow: ONE fresh getPositionRisk() read (no
 * per-symbol query, same single-call-for-all-symbols shape stateReconciler.ts's own reconcileOnce()
 * already uses) combined with the persisted file already loaded via readLiveStateFileSafe(). Fails
 * SAFE: any exchange-read error (or a non-array response) returns `ok:false` — the caller must NOT
 * start trading on an unknown state, per the ticket's explicit "block/quarantine everything until a
 * successful read" rule.
 */
export async function performStartupRestartRecovery(params: {
  executor: Pick<BinanceOrderExecutor, 'getPositionRisk'>;
  symbols: string[];
  persisted: LoadLiveStateResult;
  quantityToleranceBySymbol: Record<string, number>;
  initialSymbolState: SymbolState;
}): Promise<RestartRecoveryResult> {
  let raw: unknown;
  try {
    raw = await params.executor.getPositionRisk();
  } catch (err) {
    return { ok: false, reason: `getPositionRisk() lỗi khi đối soát khởi động — KHÔNG an toàn để giao dịch với trạng thái chưa xác định: ${(err as Error).message}` };
  }
  const entries = raw as Array<{ symbol?: string; positionAmt?: string }> | null;
  if (!Array.isArray(entries)) {
    return { ok: false, reason: `getPositionRisk() không trả về mảng khi đối soát khởi động: ${JSON.stringify(raw)}` };
  }

  const persistedFile = params.persisted.status === 'OK' ? params.persisted.file : null;

  const symbols: SymbolRestartRecoveryOutcome[] = params.symbols.map((symbol) => {
    const exchangeBaseQtyBySide: Record<PositionSide, number> = { LONG: 0, SHORT: 0 };
    for (const e of entries) {
      if (e.symbol !== symbol) continue;
      const amt = Number(e.positionAmt);
      if (!Number.isFinite(amt) || amt === 0) continue;
      if (amt > 0) exchangeBaseQtyBySide.LONG += amt;
      else exchangeBaseQtyBySide.SHORT += Math.abs(amt);
    }
    return recoverSymbolState({
      symbol,
      persisted: persistedFile?.symbols[symbol],
      exchangeBaseQtyBySide,
      quantityTolerance: params.quantityToleranceBySymbol[symbol],
      initialSymbolState: params.initialSymbolState,
    });
  });

  return { ok: true, symbols };
}

// ---- TICKET-G1R Final Closure item 2: protective-order (SL/TP) ownership verification ----------
//
// Restart recovery (Checkpoint C, above) only proves ownership of the POSITION qty — it trusts the
// persisted slAlgoId/tpAlgoIds verbatim (documented known limitation #2 in
// data/g1r-restart-recovery-report.md). This section closes that gap: given a real
// `getOpenAlgoOrders()` read, verify the persisted algoIds actually still exist, open, on the
// correct side, with a plausible quantity — never adopted just because the ID is present in a
// local file. Pure decision function; the caller (liveRunner.ts) supplies the real exchange read.

export type ProtectiveOrderVerificationStatus =
  | 'VERIFIED'
  | 'MISSING'
  | 'WRONG_SIDE'
  | 'WRONG_QTY'
  // TICKET-G1R-A "Final Internal Closure" item 4 — new semantic failure modes. Every one of these is
  // a NON-VERIFIED result and therefore already routes through each caller's existing policy
  // (SL -> PROTECTION_DEGRADED/bounded repair, TP -> warning-only); no new escalation path is added.
  | 'WRONG_POSITION_SIDE'
  | 'WRONG_ORDER_TYPE'
  | 'WRONG_TRIGGER_PRICE'
  | 'NOT_REDUCE_ONLY'
  | 'WRONG_SYMBOL'
  | 'NO_PERSISTED_ORDERS';

/** Bot account mode. Confirmed ONE_WAY (orchestrator.ts's same-side guard doc; placement never sends a positionSide param, so Binance records 'BOTH'). */
export type PositionModeContext = 'ONE_WAY' | 'HEDGE';

/**
 * Default trigger-price tolerance: 0.1% of the expected trigger price. Rationale: the executor
 * rounds every trigger to the symbol's own tickSize before sending (roundPriceToTickSize), and
 * liveRunner rounds to 2dp on top of that, so an exact float equality check would produce false
 * WRONG_TRIGGER_PRICE alarms. 0.1% is far tighter than any real SL/TP distance (min SL is 1.0% per
 * the production config) so a genuinely wrong trigger still fails.
 */
export const DEFAULT_TRIGGER_PRICE_TOLERANCE_PCT = 0.001;

/**
 * This account runs Binance One-Way mode: orchestrator.ts's same-side guard documents it, placement
 * never sends a positionSide param (so Binance records 'BOTH'), and the confirmed testnet read
 * returned positionSide='BOTH' on every resting order.
 */
export const DEFAULT_POSITION_MODE: PositionModeContext = 'ONE_WAY';

/** Order types a protective SL may legitimately be. */
export const PROTECTIVE_SL_ORDER_TYPES = ['STOP_MARKET'] as const;
/** Order types a protective TP may legitimately be. */
export const PROTECTIVE_TP_ORDER_TYPES = ['TAKE_PROFIT_MARKET'] as const;

export interface ProtectiveOrderVerificationResult {
  status: ProtectiveOrderVerificationStatus;
  detail: string;
}

/**
 * Verifies ONLY the SL algoId (the TP tier(s) are less critical to admission safety — a missing TP
 * still leaves the position protected by its SL; a missing/wrong SL does not). `expectedQty` is the
 * position's current `remainingPositionSize / entryPrice` (base asset) at the time of verification;
 * `quantityTolerance` is the same stepSize-based tolerance `computeQuantityTolerance()` already
 * produces elsewhere in this file. Never auto-replaces/cancels anything — the caller decides what
 * to do with a non-VERIFIED result (per the ticket: quarantine, never auto-adopt/re-place).
 */
export function verifyProtectiveSlOrder(params: {
  persistedSlAlgoId: number | null;
  expectedSide: PositionSide;
  expectedQty: number;
  quantityTolerance: number;
  openAlgoOrders: OpenAlgoOrder[];
  // Semantic expectations are optional for legacy utility callers, but once supplied they are
  // strict: the exchange fields themselves are mandatory in OpenAlgoOrder and are never skipped.
  /** Symbol this order is supposed to belong to. Callers already filter per-symbol; this makes the guarantee explicit rather than assumed. */
  expectedSymbol?: string;
  /** The position's actual current SL (or this tier's TP) price. */
  expectedTriggerPrice?: number;
  /** Fraction of expectedTriggerPrice. Defaults to DEFAULT_TRIGGER_PRICE_TOLERANCE_PCT. */
  triggerPriceTolerancePct?: number;
  /** 'ONE_WAY' expects positionSide 'BOTH'; 'HEDGE' expects it to equal expectedSide. */
  positionMode?: PositionModeContext;
  /** e.g. ['STOP_MARKET'] for an SL, ['TAKE_PROFIT_MARKET'] for a TP. */
  expectedOrderTypes?: readonly string[];
  /** Label used in messages so the shared implementation reads correctly for both SL and TP callers. */
  orderLabel?: string;
}): ProtectiveOrderVerificationResult {
  const label = params.orderLabel ?? 'slAlgoId';
  if (params.persistedSlAlgoId === null) {
    return { status: 'NO_PERSISTED_ORDERS', detail: 'không có slAlgoId persisted để đối chiếu (vị thế được phục hồi nhưng chưa từng ghi nhận SL algoId)' };
  }
  const found = params.openAlgoOrders.find((o) => o.algoId === params.persistedSlAlgoId);
  if (!found) {
    return { status: 'MISSING', detail: `${label}=${params.persistedSlAlgoId} không còn trong danh sách algo order đang mở trên sàn (đã hủy/đã khớp/không tồn tại)` };
  }

  // Active/open status is NOT re-checked here: parseOpenAlgoOrderEntry() (item 3) already throws on
  // any non-active algoStatus, so anything reaching this function is guaranteed active by construction.

  if (params.expectedSymbol !== undefined && found.symbol !== params.expectedSymbol) {
    return { status: 'WRONG_SYMBOL', detail: `${label}=${params.persistedSlAlgoId} thuộc symbol=${found.symbol} nhưng đang đối chiếu cho ${params.expectedSymbol}` };
  }

  // SL for a LONG position is a SELL order (closes the long); SHORT's SL is a BUY.
  const expectedOrderSide = params.expectedSide === 'LONG' ? 'SELL' : 'BUY';
  if (found.side !== expectedOrderSide) {
    return { status: 'WRONG_SIDE', detail: `${label}=${params.persistedSlAlgoId} có side=${found.side} nhưng vị thế ${params.expectedSide} cần side=${expectedOrderSide}` };
  }

  if (params.positionMode !== undefined) {
    const expectedPositionSide = params.positionMode === 'ONE_WAY' ? 'BOTH' : params.expectedSide;
    if (found.positionSide !== expectedPositionSide) {
      return { status: 'WRONG_POSITION_SIDE', detail: `${label}=${params.persistedSlAlgoId} có positionSide=${found.positionSide} nhưng chế độ ${params.positionMode} với vị thế ${params.expectedSide} cần positionSide=${expectedPositionSide}` };
    }
  }

  if (params.expectedOrderTypes !== undefined && !params.expectedOrderTypes.includes(found.orderType)) {
    return { status: 'WRONG_ORDER_TYPE', detail: `${label}=${params.persistedSlAlgoId} có orderType=${found.orderType} nhưng kỳ vọng một trong ${params.expectedOrderTypes.join('/')} — SL và TP KHÔNG được nhận nhầm nhau` };
  }

  const diff = Math.abs(found.origQty - params.expectedQty);
  if (diff > params.quantityTolerance) {
    return { status: 'WRONG_QTY', detail: `${label}=${params.persistedSlAlgoId} có qty=${found.origQty} nhưng vị thế còn lại kỳ vọng qty=${params.expectedQty} (lệch ${diff} > dung sai ${params.quantityTolerance})` };
  }

  if (params.expectedTriggerPrice !== undefined) {
    const tolPct = params.triggerPriceTolerancePct ?? DEFAULT_TRIGGER_PRICE_TOLERANCE_PCT;
    const allowed = Math.abs(params.expectedTriggerPrice) * tolPct;
    const priceDiff = Math.abs(found.triggerPrice - params.expectedTriggerPrice);
    if (priceDiff > allowed) {
      return { status: 'WRONG_TRIGGER_PRICE', detail: `${label}=${params.persistedSlAlgoId} có triggerPrice=${found.triggerPrice} nhưng kỳ vọng ${params.expectedTriggerPrice} (lệch ${priceDiff} > dung sai ${allowed} = ${(tolPct * 100).toFixed(3)}%)` };
    }
  }

  if (found.reduceOnly !== true && found.closePosition !== true) {
    return { status: 'NOT_REDUCE_ONLY', detail: `${label}=${params.persistedSlAlgoId} có reduceOnly=${String(found.reduceOnly)} và closePosition=${String(found.closePosition)} — lệnh bảo vệ BẮT BUỘC phải là reduce-only/close-position, nếu không nó có thể MỞ THÊM vị thế` };
  }

  return { status: 'VERIFIED', detail: `${label}=${params.persistedSlAlgoId} khớp symbol/side/positionSide/type/qty/triggerPrice/reduceOnly trong dung sai` };
}

// ---- TICKET-G1R Final Closure item 3: explicit exchange-sync admission state -------------------

/**
 * Explicit union (not a boolean scattered across call sites) for whether the account's own
 * balance/position/protective-order state is currently trustworthy enough to admit new entries.
 * `SYNCED`: last full read of all three succeeded. `ACCOUNT_STATE_UNKNOWN`: at least one of
 * balance/position/protective-order reads has failed since the last successful full resync — the
 * caller must block admission for the WHOLE portfolio (reuse the existing
 * `hasUnquantifiableExposureBlockingAdmission` sentinel-over-cap mechanism, not a new one) until a
 * fresh evidence-based resync succeeds. There is no time-based auto-recovery.
 */
export type AccountSyncState = 'SYNCED' | 'ACCOUNT_STATE_UNKNOWN';

// ---- TICKET-G1R-A item 2: TP verification (differentiated policy, non-critical) ---------------

/** Per-tpAlgoId verification outcome, same statuses as verifyProtectiveSlOrder() but never triggers the SL failsafe — a missing/wrong TP still leaves the position SL-protected. */
export interface ProtectiveTpOrderVerification {
  tpAlgoId: number;
  status: ProtectiveOrderVerificationStatus;
  detail: string;
}

/**
 * Verifies every persisted TP algoId the same way verifyProtectiveSlOrder() verifies the SL one
 * (side/qty match within tolerance against a real getOpenAlgoOrders() read) — but the caller MUST
 * treat a non-VERIFIED result here as a WARNING (log + Telegram), never CRITICAL, and never route it
 * into the SL failsafe's EMERGENCY_CLOSE/OPERATOR_REQUIRED policy. `expectedQty` should be each TP
 * tier's own remaining fixed-price close quantity, not the whole position's remaining size — the
 * caller supplies one call per tpAlgoId with that tier's own expected qty (this function itself does
 * not know per-tier sizing, deliberately kept as simple/pure as verifyProtectiveSlOrder()).
 */
export function verifyProtectiveTpOrder(params: {
  tpAlgoId: number;
  expectedSide: PositionSide;
  expectedQty: number;
  quantityTolerance: number;
  openAlgoOrders: OpenAlgoOrder[];
  expectedSymbol?: string;
  expectedTriggerPrice?: number;
  triggerPriceTolerancePct?: number;
  positionMode?: PositionModeContext;
}): ProtectiveTpOrderVerification {
  const result = verifyProtectiveSlOrder({
    persistedSlAlgoId: params.tpAlgoId,
    expectedSide: params.expectedSide,
    expectedQty: params.expectedQty,
    quantityTolerance: params.quantityTolerance,
    openAlgoOrders: params.openAlgoOrders,
    expectedSymbol: params.expectedSymbol,
    expectedTriggerPrice: params.expectedTriggerPrice,
    triggerPriceTolerancePct: params.triggerPriceTolerancePct,
    positionMode: params.positionMode,
    // item 4: a TP must never be accepted as if it were an SL, or vice versa. Distinguishing by
    // WHICH persisted list the algoId came from is necessary but not sufficient — the exchange's own
    // orderType is the independent evidence.
    expectedOrderTypes: PROTECTIVE_TP_ORDER_TYPES,
    orderLabel: 'tpAlgoId',
  });
  return { tpAlgoId: params.tpAlgoId, status: result.status, detail: result.detail };
}

// ---- TICKET-G1R-A item 1: missing-protective-SL fail-safe --------------------------------------
//
// Extends Final Closure's verifyProtectiveSlOrder(): a non-VERIFIED result there used to mean
// "quarantine and give up" immediately. This section adds an evidence-based RECOVERY attempt before
// giving up, ONLY for positions that already passed Checkpoint C's ownership proof (RECOVERED —
// never for QUARANTINED/unverified-ownership positions, which this section's functions never touch).

export type MissingProtectiveSlFailsafePolicy = 'EMERGENCY_CLOSE' | 'OPERATOR_REQUIRED';

/** Default per the ticket's own guidance: OPERATOR_REQUIRED is the safer default (never auto-closes a real position without a human), unless a human explicitly opts into EMERGENCY_CLOSE. */
export const DEFAULT_MISSING_PROTECTIVE_SL_FAILSAFE_POLICY: MissingProtectiveSlFailsafePolicy = 'OPERATOR_REQUIRED';

/** Bounded retry budget for place-SL + verify — NOT "retry until success". */
export const MISSING_SL_RECOVERY_MAX_ATTEMPTS = 3;

/**
 * Restart-safe idempotency check (ticket's explicit requirement: "nếu process restart giữa lúc đang
 * retry... phải kiểm tra xem đã có SL mới được đặt trước đó chưa"). Scans a FRESH getOpenAlgoOrders()
 * read for ANY resting order matching the expected protective-SL side/qty, regardless of algoId —
 * covers the case where a PREVIOUS process's retry attempt actually succeeded and placed a real SL,
 * but the process crashed/restarted before persisting the new algoId. Never relies on an in-memory
 * counter (which would reset on restart) — this is the actual anti-duplicate mechanism.
 */
export function findExistingCandidateSlOrder(params: { expectedSide: PositionSide; expectedQty: number; quantityTolerance: number; openAlgoOrders: OpenAlgoOrder[] }): OpenAlgoOrder | null {
  const expectedOrderSide = params.expectedSide === 'LONG' ? 'SELL' : 'BUY';
  const candidate = params.openAlgoOrders.find((o) => o.side === expectedOrderSide && Math.abs(o.origQty - params.expectedQty) <= params.quantityTolerance);
  return candidate ?? null;
}

// ---- TICKET-G1R-A item 4: coherent reconciliation snapshot -------------------------------------
//
// HONEST NAMING (ticket's explicit requirement): this is a BEST-EFFORT COHERENT snapshot with a
// bounded skew and a post-hoc change check — NOT a real atomic single-read. Binance does not offer
// one API call that returns balance+positions+fills+protective-orders together, so 4 sequential
// signed GETs are still 4 sequential signed GETs. What this section adds on top: each read is
// timestamped/sourced/request-ID'd, the whole cycle is retried (never patched piecemeal) if the
// spread between reads exceeds a configurable bound OR a closing re-read of positions disagrees with
// the earlier one (proof something changed mid-cycle), and only a VALIDATED snapshot may feed
// rebuildPortfolioRisk()/admission.

export interface DataSourceRead<T> {
  data: T;
  capturedAt: number;
  source: string;
  requestId: string;
}

export interface CoherentReconciliationSnapshotData {
  balance: DataSourceRead<unknown>;
  positions: DataSourceRead<unknown>;
  /** "fills/orders" leg — this codebase's only existing fill-evidence read is getIncome() (see binanceOrderExecutor.ts TICKET-107 doc comment); there is no separate getOpenOrders() for plain MARKET/LIMIT orders. Documented honestly rather than inventing an unused/unverified 5th read. */
  fills: DataSourceRead<unknown>;
  protectiveOrders: DataSourceRead<OpenAlgoOrder[]>;
}

export type CoherentReconciliationSnapshotResult =
  | { status: 'VALIDATED'; snapshot: CoherentReconciliationSnapshotData; snapshotStart: number; snapshotEnd: number; maxSkewMs: number }
  | { status: 'RETRY_NEEDED'; reason: 'SKEW_EXCEEDED' | 'POSITION_CHANGED_MID_CYCLE'; snapshotStart: number; snapshotEnd: number; maxSkewMs: number; detail: string }
  | { status: 'READ_ERROR'; detail: string };

let requestIdCounter = 0;
function nextRequestId(): string {
  requestIdCounter += 1;
  return `${Date.now()}-${requestIdCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Structural equality on the fields admission actually cares about (per-symbol positionAmt) — avoids false "changed" from field ordering/whitespace in a raw JSON.stringify diff. */
function positionsSignature(raw: unknown): string {
  const arr = Array.isArray(raw) ? (raw as Array<{ symbol?: string; positionAmt?: string }>) : [];
  return arr
    .map((p) => `${p.symbol ?? ''}:${p.positionAmt ?? ''}`)
    .sort()
    .join('|');
}

/**
 * ONE attempt at a coherent snapshot (no internal retry — see captureCoherentReconciliationSnapshotWithRetry
 * for the retry-whole-cycle wrapper). Reads balance -> positions -> fills -> protectiveOrders -> a
 * CLOSING re-read of positions (used only for change detection, discarded otherwise — the FIRST
 * positions read is what the returned snapshot carries). `skewLimitMs` bounds the spread between the
 * earliest and latest of the 4 primary reads' capturedAt timestamps.
 */
export async function captureCoherentReconciliationSnapshotOnce(
  executor: Pick<BinanceOrderExecutor, 'getAccountInfo' | 'getPositionRisk' | 'getIncome' | 'getOpenAlgoOrders'>,
  params: { incomeWindowStartMs: number; incomeWindowEndMs: number; skewLimitMs?: number },
): Promise<CoherentReconciliationSnapshotResult> {
  const skewLimitMs = params.skewLimitMs ?? 5000;
  const snapshotStart = Date.now();
  try {
    const balanceData = await executor.getAccountInfo();
    const balance: DataSourceRead<unknown> = { data: balanceData, capturedAt: Date.now(), source: 'getAccountInfo', requestId: nextRequestId() };

    const positionsData = await executor.getPositionRisk();
    const positions: DataSourceRead<unknown> = { data: positionsData, capturedAt: Date.now(), source: 'getPositionRisk', requestId: nextRequestId() };

    // item 2: whole-account query — `undefined`, NOT `''`. An empty string used to be spread into the
    // query string as a literal `symbol=`, which is not the same request as omitting the filter.
    const fillsData = await executor.getIncome(undefined, params.incomeWindowStartMs, params.incomeWindowEndMs);
    const fills: DataSourceRead<unknown> = { data: fillsData, capturedAt: Date.now(), source: 'getIncome', requestId: nextRequestId() };

    const protectiveOrdersData = await executor.getOpenAlgoOrders();
    const protectiveOrders: DataSourceRead<OpenAlgoOrder[]> = { data: protectiveOrdersData, capturedAt: Date.now(), source: 'getOpenAlgoOrders', requestId: nextRequestId() };

    // Closing re-read of positions — change-detection only, never part of the returned snapshot.
    const closingPositionsData = await executor.getPositionRisk();
    const snapshotEnd = Date.now();

    const capturedAts = [balance.capturedAt, positions.capturedAt, fills.capturedAt, protectiveOrders.capturedAt];
    const maxSkewMs = Math.max(...capturedAts) - Math.min(...capturedAts);

    if (positionsSignature(positionsData) !== positionsSignature(closingPositionsData)) {
      return { status: 'RETRY_NEEDED', reason: 'POSITION_CHANGED_MID_CYCLE', snapshotStart, snapshotEnd, maxSkewMs, detail: 'positionRisk lúc đầu và lúc đóng chu kỳ KHÔNG khớp — có thay đổi giữa lúc đọc, không dùng snapshot rách này.' };
    }
    if (maxSkewMs > skewLimitMs) {
      return { status: 'RETRY_NEEDED', reason: 'SKEW_EXCEEDED', snapshotStart, snapshotEnd, maxSkewMs, detail: `khoảng lệch giữa các lần đọc (${maxSkewMs}ms) vượt giới hạn ${skewLimitMs}ms.` };
    }
    return { status: 'VALIDATED', snapshot: { balance, positions, fills, protectiveOrders }, snapshotStart, snapshotEnd, maxSkewMs };
  } catch (err) {
    return { status: 'READ_ERROR', detail: `một trong 4 lần đọc thất bại — không dùng snapshot một phần: ${(err as Error).message}` };
  }
}

/**
 * Retries the WHOLE cycle (never patches individual legs) up to `maxCycles` times. Only a
 * `VALIDATED` result may feed rebuildPortfolioRisk()/admission — the caller must treat every other
 * outcome as "keep the account in ACCOUNT_STATE_UNKNOWN, do not admit new entries" (reuses the
 * existing AccountSyncState sentinel, no new parallel gate).
 */
export async function captureCoherentReconciliationSnapshotWithRetry(
  executor: Pick<BinanceOrderExecutor, 'getAccountInfo' | 'getPositionRisk' | 'getIncome' | 'getOpenAlgoOrders'>,
  params: { incomeWindowStartMs: number; incomeWindowEndMs: number; skewLimitMs?: number; maxCycles?: number },
): Promise<CoherentReconciliationSnapshotResult> {
  const maxCycles = params.maxCycles ?? 3;
  let last: CoherentReconciliationSnapshotResult = { status: 'READ_ERROR', detail: 'chưa thử lần nào' };
  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    last = await captureCoherentReconciliationSnapshotOnce(executor, params);
    if (last.status === 'VALIDATED') return last;
    if (last.status === 'READ_ERROR') return last; // a real read failure is not "try the whole cycle again blindly" — surfaced immediately
  }
  return last;
}

export type MissingSlRecoveryOutcome =
  | { status: 'ALREADY_RECOVERED_ON_RESTART'; slAlgoId: number; detail: string }
  | { status: 'RECOVERED'; slAlgoId: number; attemptsUsed: number; detail: string }
  | { status: 'EXHAUSTED_EMERGENCY_CLOSED'; attemptsUsed: number; detail: string }
  | { status: 'EXHAUSTED_OPERATOR_REQUIRED'; attemptsUsed: number; detail: string }
  // TICKET-G1R-A "Final Safety Hotfix" item 2 — a market close being SENT is not proof it fully
  // filled. `residualBaseQty` is the exchange-confirmed remaining base-asset qty when a fresh
  // getPositionRisk() read succeeded (0 means the residual is within tolerance but rounding kept it
  // nonzero — never happens when confirmedZero, only present here on genuine leftover); `null` means
  // the verify READ itself failed (closeError explains why) — either case is EMERGENCY_CLOSE_FAILED,
  // never assumed closed.
  | { status: 'EXHAUSTED_EMERGENCY_CLOSE_FAILED'; attemptsUsed: number; detail: string; closeError: string; residualBaseQty: number | null };

/**
 * TICKET-G1R-A "Final Safety Hotfix" item 2 — after `closePositionMarket()` is sent, this is the
 * mandatory fresh-read verification: NEVER trust the close-order response alone. Returns the
 * exchange-confirmed residual base-asset qty (0/near-0 within `quantityTolerance` = confirmed
 * closed); a read failure is reported distinctly (not silently treated as "closed").
 */
async function verifyPositionFullyClosedViaExchange(
  executor: Pick<BinanceOrderExecutor, 'getPositionRisk'>,
  symbol: string,
  quantityTolerance: number,
): Promise<{ confirmedZero: boolean; residualBaseQty: number | null; readError?: string }> {
  try {
    const raw = (await executor.getPositionRisk(symbol)) as Array<{ symbol?: string; positionAmt?: string }>;
    if (!Array.isArray(raw)) {
      return { confirmedZero: false, residualBaseQty: null, readError: `getPositionRisk() không trả về mảng: ${JSON.stringify(raw)}` };
    }
    const amt = Number(raw.find((p) => p.symbol === symbol)?.positionAmt ?? '0');
    if (!Number.isFinite(amt)) {
      return { confirmedZero: false, residualBaseQty: null, readError: `getPositionRisk() trả về positionAmt không hợp lệ: ${JSON.stringify(raw)}` };
    }
    const residual = Math.abs(amt);
    if (residual <= quantityTolerance) return { confirmedZero: true, residualBaseQty: residual };
    return { confirmedZero: false, residualBaseQty: residual };
  } catch (err) {
    return { confirmedZero: false, residualBaseQty: null, readError: (err as Error).message };
  }
}

/**
 * The full item-1 workflow. Caller MUST have already confirmed this position is `RECOVERED` (proven
 * ownership, Checkpoint C) — never call this for a QUARANTINED/unverified position (it never places
 * or cancels an order for one, but it also never CHECKS that here; that check belongs to the caller,
 * same "caller owns the gate" convention as verifyProtectiveSlOrder()'s own doc comment).
 *
 * Steps: (1) restart-safe idempotency scan — adopt an already-resting matching SL instead of placing
 * a duplicate; (2) up to `maxAttempts` place-SL + re-verify-from-exchange cycles (never trusts the
 * placement response alone — always re-reads getOpenAlgoOrders() and re-runs verifyProtectiveSlOrder()
 * after each placement, per the ticket's explicit "không tin ngay kết quả của lệnh đặt" rule); (3) on
 * exhaustion, apply the configured policy — EMERGENCY_CLOSE calls closePositionMarket() for the WHOLE
 * remaining qty; OPERATOR_REQUIRED places no order and returns for the caller to alert CRITICAL +
 * quarantine. Every attempt uses `placeStopMarket()`'s existing reduce-only STOP_MARKET semantics —
 * no new order-side parameter needed.
 */
export async function recoverMissingProtectiveSl(params: {
  executor: Pick<BinanceOrderExecutor, 'getOpenAlgoOrders' | 'placeStopMarket' | 'closePositionMarket' | 'getPositionRisk'>;
  symbol: string;
  expectedSide: PositionSide;
  expectedQty: number;
  quantityTolerance: number;
  slTriggerPrice: number;
  policy: MissingProtectiveSlFailsafePolicy;
  maxAttempts?: number;
  skipPlacementAttempts?: boolean;
}): Promise<MissingSlRecoveryOutcome> {
  const maxAttempts = params.maxAttempts ?? MISSING_SL_RECOVERY_MAX_ATTEMPTS;

  // Step 1 — restart-safe idempotency: don't place a duplicate if a prior (possibly pre-restart) attempt already succeeded.
  if (!params.skipPlacementAttempts) {
    const preExisting = await params.executor.getOpenAlgoOrders(params.symbol);
    const already = findExistingCandidateSlOrder({ expectedSide: params.expectedSide, expectedQty: params.expectedQty, quantityTolerance: params.quantityTolerance, openAlgoOrders: preExisting });
    if (already) {
      return { status: 'ALREADY_RECOVERED_ON_RESTART', slAlgoId: already.algoId, detail: `Tìm thấy SL algoId=${already.algoId} đã tồn tại trên sàn khớp side/qty kỳ vọng — không đặt thêm (chống trùng qua restart).` };
    }
  }

  // Step 2 — bounded place+verify attempts.
  for (let attempt = 1; attempt <= (params.skipPlacementAttempts ? 0 : maxAttempts); attempt++) {
    try {
      const placed = await params.executor.placeStopMarket(params.symbol, params.expectedSide, params.slTriggerPrice, params.expectedQty);
      if ('dryRun' in placed) {
        // dryRun mode: no real order was sent, nothing to verify against a real exchange read — treat
        // as recovered so dry-run soak tests don't get stuck EXHAUSTED, but never real money at risk.
        return { status: 'RECOVERED', slAlgoId: -1, attemptsUsed: attempt, detail: 'dryRun — lệnh SL mô phỏng (log only), không có algoId thật để xác minh.' };
      }
      const freshOrders = await params.executor.getOpenAlgoOrders(params.symbol);
      // item 4 — a REPAIRED SL is held to the exact same semantic standard as the original.
      const verification = verifyProtectiveSlOrder({
        persistedSlAlgoId: placed.algoId,
        expectedSide: params.expectedSide,
        expectedQty: params.expectedQty,
        quantityTolerance: params.quantityTolerance,
        openAlgoOrders: freshOrders,
        expectedSymbol: params.symbol,
        expectedTriggerPrice: params.slTriggerPrice,
        positionMode: DEFAULT_POSITION_MODE,
        expectedOrderTypes: PROTECTIVE_SL_ORDER_TYPES,
      });
      if (verification.status === 'VERIFIED') {
        return { status: 'RECOVERED', slAlgoId: placed.algoId, attemptsUsed: attempt, detail: `Đặt lại SL thành công, xác minh lại từ sàn OK (lần thử ${attempt}/${maxAttempts}).` };
      }
      // Placement returned an ID but re-verification from the exchange disagrees — don't trust the
      // placement response alone; treat as a failed attempt and try again within budget.
    } catch {
      // placeStopMarket() itself throws with full context (already logged via onOrderFailure) — this
      // loop only needs to know the attempt failed, not swallow/re-log the detail a second time.
    }
  }

  // Step 3 — exhausted; apply policy.
  const attemptsUsedFinal = params.skipPlacementAttempts ? 0 : maxAttempts;
  const attemptsUsedLabel = params.skipPlacementAttempts ? 'không thử đặt lại SL (bỏ qua vì slTriggerPrice đã biết là sai phía)' : `Hết ${maxAttempts} lần thử đặt+xác minh lại SL`;
  if (params.policy === 'OPERATOR_REQUIRED') {
    return { status: 'EXHAUSTED_OPERATOR_REQUIRED', attemptsUsed: attemptsUsedFinal, detail: `${attemptsUsedLabel} — KHÔNG tự đóng vị thế (policy=OPERATOR_REQUIRED). Cần người can thiệp thủ công NGAY.` };
  }
  try {
    await params.executor.closePositionMarket(params.symbol, params.expectedSide, params.expectedQty);
  } catch (err) {
    return {
      status: 'EXHAUSTED_EMERGENCY_CLOSE_FAILED',
      attemptsUsed: attemptsUsedFinal,
      detail: `${attemptsUsedLabel}, VÀ market close khẩn cấp CŨNG THẤT BẠI (lệnh bị từ chối/lỗi mạng) — vị thế đang naked, cần người can thiệp thủ công NGAY LẬP TỨC.`,
      closeError: (err as Error).message,
      residualBaseQty: null,
    };
  }
  const verify = await verifyPositionFullyClosedViaExchange(params.executor, params.symbol, params.quantityTolerance);
  if (verify.confirmedZero) {
    return { status: 'EXHAUSTED_EMERGENCY_CLOSED', attemptsUsed: attemptsUsedFinal, detail: `${attemptsUsedLabel} — đã đóng NGAY vị thế bằng market order (policy=EMERGENCY_CLOSE), XÁC MINH LẠI qua getPositionRisk() cho thấy qty còn lại=0 (trong dung sai) để loại rủi ro naked position.` };
  }
  if (verify.readError) {
    return {
      status: 'EXHAUSTED_EMERGENCY_CLOSE_FAILED',
      attemptsUsed: attemptsUsedFinal,
      detail: `Market close đã gửi nhưng KHÔNG xác minh được kết quả (đọc lại getPositionRisk() lỗi: ${verify.readError}) — KHÔNG được coi là đã đóng, vị thế có thể vẫn còn naked, cần người can thiệp thủ công NGAY LẬP TỨC.`,
      closeError: verify.readError,
      residualBaseQty: null,
    };
  }
  return {
    status: 'EXHAUSTED_EMERGENCY_CLOSE_FAILED',
    attemptsUsed: attemptsUsedFinal,
    detail: `Market close đã gửi nhưng sàn XÁC NHẬN còn dư qty=${verify.residualBaseQty} (vượt dung sai ${params.quantityTolerance}, có thể là khớp lệnh một phần) — vị thế VẪN còn expose, cần người can thiệp thủ công NGAY LẬP TỨC.`,
    closeError: `residual qty ${verify.residualBaseQty} sau market close, vượt dung sai ${params.quantityTolerance}`,
    residualBaseQty: verify.residualBaseQty,
  };
}

// ---- TICKET-G1R-B (Runtime Wiring Pass) item 1+2+3: in-run protective-order monitor, powered by ONE
// periodic coherent snapshot ------------------------------------------------------------------------
//
// Runs on its own interval (liveRunner.ts wires this to a `setInterval`, NOT the 5s tick loop — see
// that file's doc comment for the exact interval chosen, consistent with stateReconciler.ts's own
// periodic-sweep design). ONE captureCoherentReconciliationSnapshotWithRetry() call per cycle supplies
// the whole-account getOpenAlgoOrders() read (never a second whole-account call, never a per-symbol
// call except recoverMissingProtectiveSl()'s own bounded per-symbol repair reads, which only fire when
// a repair is actually needed) — the sweep below filters that ONE read in memory per symbol.

/** One currently ownership-VERIFIED open position (already inside symbolState.openPositions — NEVER a QUARANTINED/entriesBlockedDueToRestartQuarantineBySymbol position) that needs its real SL/TP checked this cycle. */
export interface ProtectiveMonitorPositionInput {
  symbol: string;
  side: PositionSide;
  entryTimestamp: number;
  /** Current USD notional still open (ManagedPositionState.remainingPositionSize convention) — the SL must cover exactly this much. */
  remainingPositionSize: number;
  /** Reconciled (post-G1-F05) ORIGINAL total USD notional — TP1/TP2's own fixed order qty was sized against this at open time, not the (now-shrunk) remaining size. */
  positionSize: number;
  entryPrice: number;
  currentSlPrice: number;
  tpLevels: Array<{ label: string; price: number | null; closePercent: number }>;
  /** ManagedPositionState.filledTiers — which TP tiers have already fired (no live order expected for those). */
  filledTiers: string[];
  slAlgoId: number | null;
  tpAlgoIds: number[];
  quantityTolerance: number;
}

export type ProtectiveMonitorSlOutcome =
  | { status: 'VERIFIED' }
  | { status: 'NO_PERSISTED_ORDERS' } // dryRun, or a position with no real order to check yet — not an alarm
  | { status: 'RECOVERED'; newSlAlgoId: number; detail: string }
  // Confirmed-closed (getPositionRisk() verified remaining qty=0 within tolerance after the market
  // close) — the position is genuinely gone from the exchange; the ONLY status where the caller may
  // remove it from openPositions/orderIds.
  | { status: 'QUARANTINE'; reason: 'EMERGENCY_CLOSED'; detail: string }
  // TICKET-G1R-A "Final Safety Hotfix" item 1 — recovery budget exhausted WITHOUT a confirmed-safe
  // outcome: OPERATOR_REQUIRED (policy never auto-closes), or EMERGENCY_CLOSE_FAILED (close was sent
  // but the exchange did NOT confirm qty=0 — order rejected, read failed, or a residual/partial fill
  // remains). The position is STILL open on the exchange with NO verified protective SL — it MUST
  // stay in openPositions/orderIds/the risk ledger (distinct status from QUARANTINE specifically so
  // the caller cannot accidentally treat this the same as a confirmed close).
  | { status: 'PROTECTION_DEGRADED'; reason: 'OPERATOR_REQUIRED' | 'EMERGENCY_CLOSE_FAILED'; detail: string; residualBaseQty: number | null };

export type ProtectiveMonitorTpFindingKind =
  | 'MISSING_ACTIVE'
  | 'STALE_FILLED_TIER'
  | 'WRONG_SIDE'
  | 'WRONG_QTY'
  // item 4 — semantic mismatches are surfaced as their own kinds instead of being flattened into
  // MISSING_ACTIVE, which would have hidden "the order exists but is wrong" behind "no order".
  | 'WRONG_POSITION_SIDE'
  | 'WRONG_ORDER_TYPE'
  | 'WRONG_TRIGGER_PRICE'
  | 'NOT_REDUCE_ONLY'
  | 'WRONG_SYMBOL';

function tpFindingKindFor(status: ProtectiveOrderVerificationStatus): ProtectiveMonitorTpFindingKind {
  switch (status) {
    case 'WRONG_SIDE':
    case 'WRONG_QTY':
    case 'WRONG_POSITION_SIDE':
    case 'WRONG_ORDER_TYPE':
    case 'WRONG_TRIGGER_PRICE':
    case 'NOT_REDUCE_ONLY':
    case 'WRONG_SYMBOL':
      return status;
    default:
      return 'MISSING_ACTIVE';
  }
}

export interface ProtectiveMonitorTpFinding {
  tpAlgoId: number;
  tier: string;
  kind: ProtectiveMonitorTpFindingKind;
  detail: string;
}

export interface ProtectiveMonitorPositionResult {
  symbol: string;
  side: PositionSide;
  entryTimestamp: number;
  sl: ProtectiveMonitorSlOutcome;
  /** Only non-clean findings: an EXPECTED-ACTIVE tier that's VERIFIED, and an ALREADY-FILLED tier with no resting order, are both the clean case and never appear here. Always a WARNING, never routed through the SL failsafe (item 3's differentiated-policy requirement). */
  tpFindings: ProtectiveMonitorTpFinding[];
}

async function verifyOnePositionProtectiveOrders(params: {
  executor: Pick<BinanceOrderExecutor, 'getOpenAlgoOrders' | 'placeStopMarket' | 'closePositionMarket' | 'getPositionRisk'>;
  position: ProtectiveMonitorPositionInput;
  policy: MissingProtectiveSlFailsafePolicy;
  openAlgoOrdersForSymbol: OpenAlgoOrder[];
}): Promise<ProtectiveMonitorPositionResult> {
  const p = params.position;
  const expectedSlQty = p.remainingPositionSize / p.entryPrice;
  const slVerification = verifyProtectiveSlOrder({
    persistedSlAlgoId: p.slAlgoId,
    expectedSide: p.side,
    expectedQty: expectedSlQty,
    quantityTolerance: p.quantityTolerance,
    openAlgoOrders: params.openAlgoOrdersForSymbol,
    // item 4 — full semantic verification, not just algoId/side/qty.
    expectedSymbol: p.symbol,
    expectedTriggerPrice: p.currentSlPrice,
    positionMode: DEFAULT_POSITION_MODE,
    expectedOrderTypes: PROTECTIVE_SL_ORDER_TYPES,
  });

  let sl: ProtectiveMonitorSlOutcome;
  if (slVerification.status === 'NO_PERSISTED_ORDERS') {
    sl = { status: 'NO_PERSISTED_ORDERS' };
  } else if (slVerification.status === 'VERIFIED') {
    sl = { status: 'VERIFIED' };
  } else {
    // Not VERIFIED — SAME bounded recovery workflow as the startup path (bounded retry, restart-safe
    // idempotency, re-verify-from-exchange, never trust the placement response alone).
    const recovery = await recoverMissingProtectiveSl({
      executor: params.executor,
      symbol: p.symbol,
      expectedSide: p.side,
      expectedQty: expectedSlQty,
      quantityTolerance: p.quantityTolerance,
      slTriggerPrice: p.currentSlPrice,
      policy: params.policy,
    });
    if (recovery.status === 'RECOVERED' || recovery.status === 'ALREADY_RECOVERED_ON_RESTART') {
      sl = { status: 'RECOVERED', newSlAlgoId: recovery.slAlgoId, detail: recovery.detail };
    } else if (recovery.status === 'EXHAUSTED_EMERGENCY_CLOSED') {
      // Confirmed closed (verified qty=0) — genuinely gone, safe to remove from the ledger.
      sl = { status: 'QUARANTINE', reason: 'EMERGENCY_CLOSED', detail: recovery.detail };
    } else if (recovery.status === 'EXHAUSTED_OPERATOR_REQUIRED') {
      // Still open on the exchange, no verified SL — MUST stay managed (item 1).
      sl = { status: 'PROTECTION_DEGRADED', reason: 'OPERATOR_REQUIRED', detail: recovery.detail, residualBaseQty: null };
    } else {
      // Close was attempted but the exchange did NOT confirm qty=0 — still exposed, MUST stay managed.
      sl = { status: 'PROTECTION_DEGRADED', reason: 'EMERGENCY_CLOSE_FAILED', detail: `${recovery.detail} (closeError: ${recovery.closeError})`, residualBaseQty: recovery.residualBaseQty };
    }
  }

  // TP checks are SKIPPED once this cycle already quarantines the position — SL's CRITICAL outcome
  // must never be diluted by a co-occurring TP WARNING for a position that's being removed anyway.
  const tpFindings: ProtectiveMonitorTpFinding[] = [];
  if (sl.status !== 'QUARANTINE' && sl.status !== 'PROTECTION_DEGRADED') {
    // tpAlgoIds were pushed (liveRunner.ts placeInitialOrders) in the SAME order as tpLevels with a
    // non-null price (TP3_RUNNER is trailing-only, never a fixed order) — zip by index.
    const nonRunnerTiers = p.tpLevels.filter((t) => t.price !== null);
    const originalBaseQty = p.positionSize / p.entryPrice; // reconciled (post-G1-F05) basis — see field doc above
    for (let i = 0; i < p.tpAlgoIds.length; i++) {
      const tpAlgoId = p.tpAlgoIds[i];
      const tier = nonRunnerTiers[i];
      if (!tier) continue; // defensive — should never happen (tpAlgoIds is derived 1:1 from nonRunnerTiers at open)
      const alreadyFilled = p.filledTiers.includes(tier.label);
      const found = params.openAlgoOrdersForSymbol.find((o) => o.algoId === tpAlgoId);
      if (alreadyFilled) {
        if (found) {
          tpFindings.push({
            tpAlgoId,
            tier: tier.label,
            kind: 'STALE_FILLED_TIER',
            detail: `tier ${tier.label} đã fill nhưng algoId=${tpAlgoId} vẫn còn resting trên sàn — không nghiêm trọng bằng SL nhưng cần dọn (hủy lệnh thừa).`,
          });
        }
        continue; // ALREADY-FILLED tier with no resting order is the CLEAN, expected case — not a finding.
      }
      // EXPECTED ACTIVE tier — a live order SHOULD exist.
      const expectedTierQty = tier.closePercent * originalBaseQty;
      const verification = verifyProtectiveTpOrder({
        tpAlgoId,
        expectedSide: p.side,
        expectedQty: expectedTierQty,
        quantityTolerance: p.quantityTolerance,
        openAlgoOrders: params.openAlgoOrdersForSymbol,
        // item 4 — same semantic depth as the SL check. `tier.price` is non-null by the
        // nonRunnerTiers filter above.
        expectedSymbol: p.symbol,
        expectedTriggerPrice: tier.price ?? undefined,
        positionMode: DEFAULT_POSITION_MODE,
      });
      if (verification.status !== 'VERIFIED') {
        tpFindings.push({ tpAlgoId, tier: tier.label, kind: tpFindingKindFor(verification.status), detail: verification.detail });
      }
    }
  }

  return { symbol: p.symbol, side: p.side, entryTimestamp: p.entryTimestamp, sl, tpFindings };
}

/**
 * Item 1+3 — sweeps every ownership-VERIFIED open position across ALL symbols against ONE already-
 * fetched whole-account `openAlgoOrders` read (caller fetches it exactly once per cycle — see
 * runAccountSyncCycle below). SL findings are always computed (and therefore loggable) before TP
 * findings for the SAME position, satisfying the "SL CRITICAL must never be obscured by TP WARNING"
 * rule at the call-site logging level.
 */
export async function runProtectiveOrderMonitorSweep(params: {
  executor: Pick<BinanceOrderExecutor, 'getOpenAlgoOrders' | 'placeStopMarket' | 'closePositionMarket' | 'getPositionRisk'>;
  positions: ProtectiveMonitorPositionInput[];
  policy: MissingProtectiveSlFailsafePolicy;
  openAlgoOrders: OpenAlgoOrder[];
}): Promise<ProtectiveMonitorPositionResult[]> {
  const results: ProtectiveMonitorPositionResult[] = [];
  for (const position of params.positions) {
    const openAlgoOrdersForSymbol = params.openAlgoOrders.filter((o) => o.symbol === position.symbol);
    results.push(await verifyOnePositionProtectiveOrders({ executor: params.executor, position, policy: params.policy, openAlgoOrdersForSymbol }));
  }
  return results;
}

export type AccountSyncCycleResult =
  | { status: 'SNAPSHOT_FAILED'; snapshotStatus: 'RETRY_NEEDED' | 'READ_ERROR'; detail: string }
  | { status: 'OK'; snapshot: CoherentReconciliationSnapshotData; positionResults: ProtectiveMonitorPositionResult[] };

/**
 * Item 1+2 — THE periodic runtime entrypoint liveRunner.ts's interval calls directly (not a "module
 * nobody calls" — see that file's wiring). A non-VALIDATED snapshot NEVER reaches the protective-order
 * sweep (fail-closed, never a partial/stale read) — the caller must flip accountSyncState to
 * ACCOUNT_STATE_UNKNOWN (reusing the existing sentinel, no new parallel gate) and skip this cycle's
 * repair entirely, exactly like every other read-failure path in this file.
 */
export async function runAccountSyncCycle(params: {
  executor: Pick<BinanceOrderExecutor, 'getAccountInfo' | 'getPositionRisk' | 'getIncome' | 'getOpenAlgoOrders' | 'placeStopMarket' | 'closePositionMarket'>;
  positions: ProtectiveMonitorPositionInput[];
  policy: MissingProtectiveSlFailsafePolicy;
  incomeWindowStartMs: number;
  incomeWindowEndMs: number;
  skewLimitMs?: number;
  maxCycles?: number;
}): Promise<AccountSyncCycleResult> {
  const snapshotResult = await captureCoherentReconciliationSnapshotWithRetry(params.executor, {
    incomeWindowStartMs: params.incomeWindowStartMs,
    incomeWindowEndMs: params.incomeWindowEndMs,
    skewLimitMs: params.skewLimitMs,
    maxCycles: params.maxCycles,
  });
  if (snapshotResult.status !== 'VALIDATED') {
    return { status: 'SNAPSHOT_FAILED', snapshotStatus: snapshotResult.status, detail: snapshotResult.detail };
  }
  const positionResults = await runProtectiveOrderMonitorSweep({
    executor: params.executor,
    positions: params.positions,
    policy: params.policy,
    openAlgoOrders: snapshotResult.snapshot.protectiveOrders.data,
  });
  return { status: 'OK', snapshot: snapshotResult.snapshot, positionResults };
}

// ---- TICKET-G1R-B item 5: same-side merged-position exchange-qty safety ----------------------------
//
// Binance one-way mode merges 2+ same-symbol/same-side logical positions into ONE exchange qty (known
// limitation since Checkpoint C's recoverSymbolState). This section adds a runtime CHECK (not a new
// re-split algorithm): confirm the persisted ledger's total still reconciles with the exchange (and,
// when known, with the total protective-order qty), and flag whether the PER-ENTRY split within that
// total is provably correct or merely unverified — never guessed, never dropped from the risk ledger.

export type AllocationQuality = 'VERIFIED_SPLIT' | 'UNVERIFIED_SPLIT';

export interface MergedPositionAllocationCheck {
  /** 2+ logical entries sharing one symbol+side merged exchange qty. */
  persistedEntries: Array<{ id: string; remainingBaseQty: number }>;
  exchangeBaseQty: number;
  /** Sum of resting protective-order qty (base asset) across all algoIds covering this symbol+side — null when not read this cycle. */
  protectiveTotalBaseQty: number | null;
  quantityTolerance: number;
}

export type MergedPositionAllocationResult =
  | { status: 'RECONCILED'; allocationQuality: AllocationQuality }
  | { status: 'ACCOUNT_STATE_UNKNOWN'; reason: string };

/**
 * Sum matches (persisted vs exchange, AND protective qty vs that sum when known) but per-entry
 * allocation can't be individually proven from one merged read -> `RECONCILED`/`UNVERIFIED_SPLIT`:
 * the persisted ledger is KEPT AS-IS (never re-split by a guessed ratio) and the caller attaches this
 * flag to each entry's risk-ledger row for visibility — the full summed exposure still flows into
 * `rebuildPortfolioRisk()` via each entry's own (unchanged) `remainingBaseQty`, so allocation
 * uncertainty NEVER removes exposure from the ledger, only marks it as an approximation of the split.
 * A genuine qty mismatch (sum vs exchange, or protective vs sum) is NOT "keep the old ledger" — it's
 * `ACCOUNT_STATE_UNKNOWN`, and the caller must block the WHOLE portfolio (reuse the existing sentinel),
 * never just the affected symbol, since which entry is wrong can't be determined either.
 */
export function checkMergedPositionAllocation(input: MergedPositionAllocationCheck): MergedPositionAllocationResult {
  const persistedSum = input.persistedEntries.reduce((s, e) => s + e.remainingBaseQty, 0);
  const sumDiff = Math.abs(persistedSum - input.exchangeBaseQty);
  if (sumDiff > input.quantityTolerance) {
    return {
      status: 'ACCOUNT_STATE_UNKNOWN',
      reason: `tổng persisted (${persistedSum}) và sàn (${input.exchangeBaseQty}) lệch ${sumDiff} vượt dung sai ${input.quantityTolerance} — không chắc chắn tổng exposure, chặn TOÀN PORTFOLIO.`,
    };
  }
  if (input.protectiveTotalBaseQty !== null) {
    const protectiveDiff = Math.abs(input.protectiveTotalBaseQty - input.exchangeBaseQty);
    if (protectiveDiff > input.quantityTolerance) {
      return {
        status: 'ACCOUNT_STATE_UNKNOWN',
        reason: `tổng qty bảo vệ (SL, ${input.protectiveTotalBaseQty}) không khớp tổng exchange qty (${input.exchangeBaseQty}), lệch ${protectiveDiff} — không chắc chắn merged position được bảo vệ đủ, chặn TOÀN PORTFOLIO.`,
      };
    }
  }
  const allocationQuality: AllocationQuality = input.persistedEntries.length >= 2 ? 'UNVERIFIED_SPLIT' : 'VERIFIED_SPLIT';
  return { status: 'RECONCILED', allocationQuality };
}

// ---- TICKET-G1R-A "Final Safety Hotfix" item 3: single-flight guard for the periodic monitor ------
//
// A generic, pure/testable wrapper — liveRunner.ts's own `runAccountSyncCycleTick()` body cannot be
// unit-tested directly (that file calls main() unconditionally at import time), so the single-flight
// LOCK ITSELF is extracted here as an exported, directly-testable primitive and liveRunner.ts wires
// its real cycle body through it (see that file's `accountSyncCycleSingleFlight`).

export interface SingleFlightRunner<T> {
  /** Runs `fn` if no invocation is currently in flight; otherwise SKIPS (never queues, never runs concurrently) and resolves immediately with `{ skipped: true }`. `finally` guarantees the lock releases even if `fn` throws. */
  run(): Promise<{ skipped: true } | { skipped: false; result: T }>;
  isInFlight(): boolean;
}

export function createSingleFlightRunner<T>(fn: () => Promise<T>): SingleFlightRunner<T> {
  let inFlight = false;
  return {
    async run() {
      if (inFlight) return { skipped: true };
      inFlight = true;
      try {
        const result = await fn();
        return { skipped: false, result };
      } finally {
        inFlight = false;
      }
    },
    isInFlight: () => inFlight,
  };
}

// ---- TICKET-G1R-A "Final Safety Hotfix" item 5: hybrid multi-frequency freshness policy -----------
//
// Honestly named per the ticket's explicit instruction (never "Atomic" — this is NOT one atomic read,
// it's several independently-sourced pieces of evidence, each carrying its OWN capture time and max
// age). `refreshBalanceForTelegram()`'s fast per-event cadence is kept as-is for balance (item 5
// explicitly does not want to slow it down to the 5-minute protective cycle) — this type/helper is
// what liveRunner.ts uses to decide whether each evidence source is still trustworthy enough to admit
// a new entry on, independently of the other.

export interface FreshnessEvidence {
  capturedAtMs: number;
  maxAgeMs: number;
  source: string;
}

export function isFreshnessEvidenceStale(evidence: FreshnessEvidence | null, nowMs: number): boolean {
  if (evidence === null) return true; // never captured yet — fail closed, not "assume fresh".
  return nowMs - evidence.capturedAtMs > evidence.maxAgeMs;
}

export type MarketEntryOutcome = 'CONFIRMED_FILLED' | 'CONFIRMED_NOT_FILLED' | 'AMBIGUOUS';

export function buildDeterministicEntryClientOrderId(symbol: string, side: PositionSide, entryTimestamp: number): string {
  return `r2b-${symbol}-${side === 'LONG' ? 'L' : 'S'}-${entryTimestamp}`;
}

export function classifySubmissionError(err: Error): { kind: 'CONFIRMED_NOT_SUBMITTED' | 'DELIVERY_UNKNOWN'; detail: string } {
  if (err instanceof OrderSubmissionError) {
    return { kind: err.deliveryStatus, detail: err.message };
  }
  return { kind: 'DELIVERY_UNKNOWN', detail: err.message };
}

export type MarketSubmissionAttempt =
  | { kind: 'CONFIRMED_SUBMITTED'; orderId: number; status: string; executedQty: unknown; avgPrice: unknown }
  | { kind: 'CONFIRMED_NOT_SUBMITTED'; detail: string }
  | { kind: 'DELIVERY_UNKNOWN'; detail: string };

export type FillDeterminationResult = 'FILLED' | 'NOT_FILLED' | 'INCONCLUSIVE';

const TERMINAL_NOT_FILLED_STATUSES = ['REJECTED', 'CANCELED', 'EXPIRED'];

export function determineFillFromStatus(status: string, executedQtyRaw: unknown): FillDeterminationResult {
  const qty = Number(executedQtyRaw);
  const validQty = Number.isFinite(qty) && qty >= 0;
  if (!validQty) return 'INCONCLUSIVE';
  if ((status === 'FILLED' || status === 'PARTIALLY_FILLED') && qty > 0) return 'FILLED';
  if (TERMINAL_NOT_FILLED_STATUSES.includes(status) && qty === 0) return 'NOT_FILLED';
  return 'INCONCLUSIVE';
}

export type OrderLookupResult =
  | { status: 'FOUND'; orderId: number; orderStatus: string; executedQty: unknown; avgPrice: unknown }
  | { status: 'NOT_FOUND' }
  | { status: 'LOOKUP_ERROR'; detail: string };

export type PositionRiskLookupResult = { status: 'CONFIRMED_EXPOSURE'; qty: number } | { status: 'CONFIRMED_NO_EXPOSURE' } | { status: 'LOOKUP_ERROR'; detail: string };

export interface MarketEntryCorroboration {
  orderLookup: OrderLookupResult;
  positionRisk: PositionRiskLookupResult;
}

export interface MarketEntryOutcomeResult {
  outcome: MarketEntryOutcome;
  detail: string;
  executedQty: number | null;
  avgPrice: unknown;
  orderId: number | null;
  positionRiskQty?: number | null;
}

export function classifyMarketEntryOutcome(attempt: MarketSubmissionAttempt, corroboration: MarketEntryCorroboration | null): MarketEntryOutcomeResult {
  if (attempt.kind === 'CONFIRMED_NOT_SUBMITTED') {
    return { outcome: 'CONFIRMED_NOT_FILLED', detail: `lệnh CHƯA từng được gửi tới sàn (xác nhận): ${attempt.detail}`, executedQty: 0, avgPrice: null, orderId: null };
  }

  if (attempt.kind === 'CONFIRMED_SUBMITTED') {
    const det = determineFillFromStatus(attempt.status, attempt.executedQty);
    if (det === 'FILLED') {
      const qty = Number(attempt.executedQty);
      return { outcome: 'CONFIRMED_FILLED', detail: `phản hồi trực tiếp từ sàn xác nhận status=${attempt.status} executedQty=${qty}`, executedQty: qty, avgPrice: attempt.avgPrice, orderId: attempt.orderId };
    }
    if (det === 'NOT_FILLED') {
      return { outcome: 'CONFIRMED_NOT_FILLED', detail: `phản hồi trực tiếp từ sàn: status=${attempt.status} là terminal và executedQty=0`, executedQty: 0, avgPrice: null, orderId: attempt.orderId };
    }
  }

  if (corroboration === null) {
    const attemptDetail = attempt.kind === 'CONFIRMED_SUBMITTED' ? `status=${attempt.status} chưa terminal, executedQty=${JSON.stringify(attempt.executedQty)}` : attempt.detail;
    const knownQty = attempt.kind === 'CONFIRMED_SUBMITTED' ? Number(attempt.executedQty) : NaN;
    return {
      outcome: 'AMBIGUOUS',
      detail: `bằng chứng gửi lệnh không đủ để phân loại (${attemptDetail}) và chưa có kết quả tra cứu bổ sung`,
      executedQty: attempt.kind === 'CONFIRMED_SUBMITTED' && Number.isFinite(knownQty) ? knownQty : null,
      avgPrice: attempt.kind === 'CONFIRMED_SUBMITTED' ? attempt.avgPrice : null,
      orderId: attempt.kind === 'CONFIRMED_SUBMITTED' ? attempt.orderId : null,
    };
  }

  const { orderLookup, positionRisk } = corroboration;
  const orderLookupDet: FillDeterminationResult = orderLookup.status === 'FOUND' ? determineFillFromStatus(orderLookup.orderStatus, orderLookup.executedQty) : 'INCONCLUSIVE';
  const orderLookupTerminal = orderLookup.status === 'FOUND' && orderLookupDet !== 'INCONCLUSIVE';
  const positionRiskDet: FillDeterminationResult = positionRisk.status === 'CONFIRMED_EXPOSURE' ? 'FILLED' : positionRisk.status === 'CONFIRMED_NO_EXPOSURE' ? 'NOT_FILLED' : 'INCONCLUSIVE';
  const positionRiskTerminal = positionRisk.status !== 'LOOKUP_ERROR';

  if (orderLookupTerminal && positionRiskTerminal && orderLookupDet === positionRiskDet && orderLookup.status === 'FOUND') {
    if (orderLookupDet === 'FILLED') {
      const qty = Number(orderLookup.executedQty);
      return {
        outcome: 'CONFIRMED_FILLED',
        detail: `tra cứu lại (clientOrderId + getPositionRisk) đồng thuận ĐÃ KHỚP: orderStatus=${orderLookup.orderStatus}, executedQty=${qty}, positionRisk xác nhận exposure`,
        executedQty: qty,
        avgPrice: orderLookup.avgPrice,
        orderId: orderLookup.orderId,
      };
    }
    return {
      outcome: 'CONFIRMED_NOT_FILLED',
      detail: `tra cứu lại (clientOrderId + getPositionRisk) đồng thuận KHÔNG khớp: orderStatus=${orderLookup.orderStatus}, positionRisk xác nhận không có exposure`,
      executedQty: 0,
      avgPrice: null,
      orderId: orderLookup.orderId,
    };
  }

  const knownFromOrderLookupQty = orderLookup.status === 'FOUND' ? Number(orderLookup.executedQty) : NaN;
  return {
    outcome: 'AMBIGUOUS',
    detail: `bằng chứng tra cứu không đủ hoặc mâu thuẫn sau bounded polling: orderLookup=${JSON.stringify(orderLookup)}, positionRisk=${JSON.stringify(positionRisk)}`,
    executedQty: orderLookup.status === 'FOUND' && Number.isFinite(knownFromOrderLookupQty) ? knownFromOrderLookupQty : null,
    avgPrice: orderLookup.status === 'FOUND' ? orderLookup.avgPrice : null,
    orderId: orderLookup.status === 'FOUND' ? orderLookup.orderId : null,
    positionRiskQty: positionRisk.status === 'CONFIRMED_EXPOSURE' ? positionRisk.qty : positionRisk.status === 'CONFIRMED_NO_EXPOSURE' ? 0 : null,
  };
}

async function lookupOrderByClientOrderId(executor: Pick<BinanceOrderExecutor, 'getOrderByClientOrderId'>, symbol: string, clientOrderId: string): Promise<OrderLookupResult> {
  try {
    const found = await executor.getOrderByClientOrderId(symbol, clientOrderId);
    if (found === null) return { status: 'NOT_FOUND' };
    return { status: 'FOUND', orderId: found.orderId, orderStatus: found.status, executedQty: found.executedQty, avgPrice: found.avgPrice };
  } catch (err) {
    return { status: 'LOOKUP_ERROR', detail: (err as Error).message };
  }
}

async function lookupPositionRiskExposure(executor: Pick<BinanceOrderExecutor, 'getPositionRisk'>, symbol: string, side: PositionSide): Promise<PositionRiskLookupResult> {
  try {
    const raw = await executor.getPositionRisk(symbol);
    const entries = raw as Array<{ symbol?: string; positionAmt?: string }> | null;
    if (!Array.isArray(entries)) return { status: 'LOOKUP_ERROR', detail: `getPositionRisk trả về không phải mảng: ${JSON.stringify(raw)}` };
    const amt = Number(entries.find((e) => e.symbol === symbol)?.positionAmt ?? '0');
    if (!Number.isFinite(amt)) return { status: 'LOOKUP_ERROR', detail: `positionAmt không phải số hữu hạn: ${JSON.stringify(entries)}` };
    const matchesSide = side === 'LONG' ? amt > 0 : amt < 0;
    return matchesSide ? { status: 'CONFIRMED_EXPOSURE', qty: Math.abs(amt) } : { status: 'CONFIRMED_NO_EXPOSURE' };
  } catch (err) {
    return { status: 'LOOKUP_ERROR', detail: (err as Error).message };
  }
}

export async function submitAndClassifyMarketEntry(params: {
  executor: Pick<BinanceOrderExecutor, 'openMarketPosition' | 'getOrderByClientOrderId' | 'getPositionRisk'>;
  symbol: string;
  side: PositionSide;
  quantity: number;
  referencePrice: number;
  clientOrderId: string;
  lookupRetryDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
}): Promise<MarketEntryOutcomeResult> {
  let attempt: MarketSubmissionAttempt;
  try {
    const result = await params.executor.openMarketPosition(params.symbol, params.side, params.quantity, params.referencePrice, params.clientOrderId);
    if ('dryRun' in result) {
      return { outcome: 'CONFIRMED_NOT_FILLED', detail: 'dryRun — không có lệnh thật nào được gửi', executedQty: 0, avgPrice: null, orderId: null };
    }
    const raw = result.raw as { executedQty?: string | number; avgPrice?: unknown };
    attempt = { kind: 'CONFIRMED_SUBMITTED', orderId: result.orderId, status: result.status, executedQty: raw.executedQty, avgPrice: raw.avgPrice };
  } catch (err) {
    const classified = classifySubmissionError(err as Error);
    attempt = { kind: classified.kind, detail: classified.detail };
  }

  const needsCorroboration = attempt.kind === 'DELIVERY_UNKNOWN' || (attempt.kind === 'CONFIRMED_SUBMITTED' && determineFillFromStatus(attempt.status, attempt.executedQty) === 'INCONCLUSIVE');
  if (!needsCorroboration) {
    return classifyMarketEntryOutcome(attempt, null);
  }

  const retryDelays = params.lookupRetryDelaysMs ?? [100, 300, 750, 1_500, 2_500];
  const wait = params.wait ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let lastResult: MarketEntryOutcomeResult | null = null;
  for (let lookupAttempt = 0; lookupAttempt <= retryDelays.length; lookupAttempt += 1) {
    const orderLookup = await lookupOrderByClientOrderId(params.executor, params.symbol, params.clientOrderId);
    const positionRisk = await lookupPositionRiskExposure(params.executor, params.symbol, params.side);
    lastResult = classifyMarketEntryOutcome(attempt, { orderLookup, positionRisk });
    if (lastResult.outcome !== 'AMBIGUOUS') return lastResult;
    if (lookupAttempt < retryDelays.length) await wait(retryDelays[lookupAttempt]);
  }
  return lastResult as MarketEntryOutcomeResult;
}

export type EstablishProtectiveStopLossResult =
  | { status: 'PROTECTED'; slAlgoId: number; detail: string }
  | { status: 'PROTECTION_DEGRADED'; firstAttemptReason: string; recovery: MissingSlRecoveryOutcome };

export async function establishProtectiveStopLoss(params: {
  executor: Pick<BinanceOrderExecutor, 'placeStopMarket' | 'getOpenAlgoOrders' | 'closePositionMarket' | 'getPositionRisk'>;
  symbol: string;
  side: PositionSide;
  slPrice: number;
  quantity: number;
  quantityTolerance: number;
  policy: MissingProtectiveSlFailsafePolicy;
}): Promise<EstablishProtectiveStopLossResult> {
  let firstAttemptReason: string;
  try {
    const placed = await params.executor.placeStopMarket(params.symbol, params.side, params.slPrice, params.quantity);
    if ('dryRun' in placed) {
      return { status: 'PROTECTED', slAlgoId: -1, detail: 'dryRun — lệnh SL mô phỏng (log only), không có algoId thật để xác minh.' };
    }
    const freshOrders = await params.executor.getOpenAlgoOrders(params.symbol);
    const verification = verifyProtectiveSlOrder({
      persistedSlAlgoId: placed.algoId,
      expectedSide: params.side,
      expectedQty: params.quantity,
      quantityTolerance: params.quantityTolerance,
      openAlgoOrders: freshOrders,
      expectedSymbol: params.symbol,
      expectedTriggerPrice: params.slPrice,
      positionMode: DEFAULT_POSITION_MODE,
      expectedOrderTypes: PROTECTIVE_SL_ORDER_TYPES,
    });
    if (verification.status === 'VERIFIED') {
      return { status: 'PROTECTED', slAlgoId: placed.algoId, detail: `Đặt SL thành công, xác minh lại từ sàn OK (algoId=${placed.algoId}).` };
    }
    firstAttemptReason = `verify:${verification.status}:${verification.detail}`;
  } catch (err) {
    firstAttemptReason = `place:${(err as Error).message}`;
  }

  const recovery = await recoverMissingProtectiveSl({
    executor: params.executor,
    symbol: params.symbol,
    expectedSide: params.side,
    expectedQty: params.quantity,
    quantityTolerance: params.quantityTolerance,
    slTriggerPrice: params.slPrice,
    policy: params.policy,
  });
  if (recovery.status === 'RECOVERED' || recovery.status === 'ALREADY_RECOVERED_ON_RESTART') {
    return { status: 'PROTECTED', slAlgoId: recovery.slAlgoId, detail: `SL ban đầu thất bại (${firstAttemptReason}) nhưng phục hồi ngay lập tức thành công: ${recovery.detail}` };
  }
  return { status: 'PROTECTION_DEGRADED', firstAttemptReason, recovery };
}
