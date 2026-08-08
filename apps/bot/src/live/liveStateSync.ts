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
import type { BinanceOrderExecutor, PositionSide } from './binanceOrderExecutor.js';

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
 */
export function resolveCanonicalOpenQty(params: { submittedQty: number; orderRaw: unknown; positionRiskAmt: number | null }): CanonicalQtyResult {
  const raw = params.orderRaw as { executedQty?: string | number } | null | undefined;
  const executedQty = raw != null ? Number(raw.executedQty) : NaN;
  if (Number.isFinite(executedQty) && executedQty > 0) {
    return { qty: executedQty, source: 'EXECUTED_QTY' };
  }
  if (params.positionRiskAmt !== null && Number.isFinite(params.positionRiskAmt) && Math.abs(params.positionRiskAmt) > 0) {
    return { qty: Math.abs(params.positionRiskAmt), source: 'POSITION_RISK' };
  }
  return { qty: params.submittedQty, source: 'SUBMITTED_QTY_FALLBACK' };
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
