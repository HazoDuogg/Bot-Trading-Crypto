/**
 * TICKET — Exchange-Authoritative Live Balance. Root cause fixed: liveRunner.ts's `accountBalance`
 * was driven by processCandle()'s own simulated bookkeeping and only corrected to the real Binance
 * value every ~7 minutes via stateReconciler.ts — Telegram messages sent in between showed a stale
 * internal number. This module fetches a FRESH `getAccountInfo()` snapshot per trade event (open/
 * partial/close), before that event's Telegram message is built, and treats the exchange as always
 * authoritative — extends TICKET-102's `resolveAccountBalanceAfterReconcile()` philosophy (internal
 * syncs TO exchange, never the reverse) to every event, not just the periodic sweep.
 *
 * HONEST LIMITATION: no WebSocket/user-data-stream infra exists anywhere in this codebase
 * (liveCandleFeed.ts: "WebSocket mainnet was confirmed not to deliver data — REST polling only").
 * There is no stream to "prefer" — this is REST-only, with a bounded timeout standing in for the
 * ticket's "if timeout, REST reconcile" fallback (there is no primary path to fall back FROM).
 */
import type { BinanceOrderExecutor } from './binanceOrderExecutor.js';

export interface ExchangeBalanceSnapshot {
  walletBalance: number; // totalWalletBalance
  marginBalance: number; // totalMarginBalance (equity, includes unrealized PnL)
  availableBalance: number; // availableBalance
  fetchedAt: number;
}

interface RawAccountInfoForBalance {
  totalWalletBalance?: string;
  totalMarginBalance?: string;
  availableBalance?: string;
}

export function parseExchangeBalanceSnapshot(raw: unknown, fetchedAt: number): ExchangeBalanceSnapshot {
  const body = raw as RawAccountInfoForBalance;
  const walletBalance = Number(body?.totalWalletBalance);
  const marginBalance = Number(body?.totalMarginBalance);
  const availableBalance = Number(body?.availableBalance);
  if (!Number.isFinite(walletBalance) || !Number.isFinite(marginBalance) || !Number.isFinite(availableBalance)) {
    throw new Error(`parseExchangeBalanceSnapshot: thiếu/không hợp lệ totalWalletBalance/totalMarginBalance/availableBalance: ${JSON.stringify(raw)}`);
  }
  return { walletBalance, marginBalance, availableBalance, fetchedAt };
}

// TODO_CONFIRM (PM): 4s — bounds how long a per-event Telegram message waits on a fresh REST read
// before falling back to "pending exchange sync" (req. 6). Long enough to absorb normal REST
// latency, short enough that a hung request doesn't stall the tick loop noticeably.
export const DEFAULT_BALANCE_FETCH_TIMEOUT_MS = 4000;

/** Never throws — returns null on any failure/timeout so callers can fall back to "pending exchange sync" (req. 6) instead of ever showing a self-calculated number as if it were confirmed. */
export async function fetchFreshBalanceSnapshot(
  executor: Pick<BinanceOrderExecutor, 'getAccountInfo'>,
  timeoutMs: number = DEFAULT_BALANCE_FETCH_TIMEOUT_MS,
): Promise<ExchangeBalanceSnapshot | null> {
  try {
    const raw = await Promise.race([
      executor.getAccountInfo(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('fetchFreshBalanceSnapshot: timeout')), timeoutMs)),
    ]);
    return parseExchangeBalanceSnapshot(raw, Date.now());
  } catch (err) {
    console.error(`[BALANCE_SYNC_ERROR] fetchFreshBalanceSnapshot lỗi/timeout: ${(err as Error).message}`);
    return null;
  }
}

// TODO_CONFIRM (PM): 1% — same value/rationale as stateReconciler.ts's DEFAULT_BALANCE_TOLERANCE_PCT
// (floating PnL/funding noise), kept identical rather than inventing a second number for the same concept.
export const DEFAULT_BALANCE_DIVERGENCE_TOLERANCE_PCT = 0.01;

export interface BalanceDivergenceCheck {
  diverged: boolean;
  diffUsd: number;
  diffPct: number;
}

export function checkBalanceDivergence(
  exchangeWalletBalance: number,
  internalBalance: number,
  tolerancePct: number = DEFAULT_BALANCE_DIVERGENCE_TOLERANCE_PCT,
): BalanceDivergenceCheck {
  const diffUsd = Math.abs(exchangeWalletBalance - internalBalance);
  const base = Math.max(exchangeWalletBalance, internalBalance);
  const diffPct = base > 0 ? diffUsd / base : 0;
  return { diverged: diffUsd > base * tolerancePct, diffUsd, diffPct };
}

export interface BalanceSyncOutcome {
  snapshot: ExchangeBalanceSnapshot | null;
  /** Exchange wallet balance when a fresh snapshot succeeded, else the unchanged `currentInternalBalance` — never a locally-recomputed number (req. 4/6). */
  correctedInternalBalance: number;
  diverged: boolean;
  divergence: BalanceDivergenceCheck | null;
}

/**
 * Per-event balance sync: always OVERWRITES (never adds/accumulates) `correctedInternalBalance`
 * from the fresh exchange read. This is what makes it safe for two same-symbol positions closing
 * moments apart in One-Way mode (req. 5) — each call independently reads Binance's own already-
 * cumulative totalWalletBalance; there is no locally-summed PnL delta to double-apply. Calling this
 * twice for the same underlying event is likewise idempotent by construction (last read wins).
 */
export async function syncBalanceForTelegramEvent(
  executor: Pick<BinanceOrderExecutor, 'getAccountInfo'>,
  currentInternalBalance: number,
  tolerancePct: number = DEFAULT_BALANCE_DIVERGENCE_TOLERANCE_PCT,
  timeoutMs: number = DEFAULT_BALANCE_FETCH_TIMEOUT_MS,
): Promise<BalanceSyncOutcome> {
  const snapshot = await fetchFreshBalanceSnapshot(executor, timeoutMs);
  if (snapshot === null) {
    return { snapshot: null, correctedInternalBalance: currentInternalBalance, diverged: false, divergence: null };
  }
  const divergence = checkBalanceDivergence(snapshot.walletBalance, currentInternalBalance, tolerancePct);
  return { snapshot, correctedInternalBalance: snapshot.walletBalance, diverged: divergence.diverged, divergence };
}

// ---- incident record (req. 7: log full incident + Telegram warning + block entries) ----------

export interface BalanceDivergenceIncident {
  timestampMs: number;
  exchangeWalletBalance: number;
  internalBalanceBefore: number;
  diffUsd: number;
  diffPct: number;
  tolerancePct: number;
}

export function formatBalanceDivergenceIncidentLog(incident: BalanceDivergenceIncident): string {
  return (
    `[BALANCE_DIVERGENCE_INCIDENT] time=${new Date(incident.timestampMs).toISOString()} ` +
    `exchangeWalletBalance=${incident.exchangeWalletBalance.toFixed(2)} internalBalanceBefore=${incident.internalBalanceBefore.toFixed(2)} ` +
    `diffUsd=${incident.diffUsd.toFixed(2)} diffPct=${(incident.diffPct * 100).toFixed(2)}% tolerancePct=${(incident.tolerancePct * 100).toFixed(1)}% ` +
    `action=ENTRIES_BLOCKED_UNTIL_RECONCILED`
  );
}

export function formatBalanceDivergenceTelegramWarning(incident: BalanceDivergenceIncident): string {
  return [
    `⚠️ [CẢNH BÁO LỆCH SỐ DƯ — ĐÃ CHẶN LỆNH MỚI]`,
    `Sàn: $${incident.exchangeWalletBalance.toFixed(2)} | Nội bộ (trước sync): $${incident.internalBalanceBefore.toFixed(2)}`,
    `Lệch: $${incident.diffUsd.toFixed(2)} (${incident.diffPct >= 0 ? '+' : ''}${(incident.diffPct * 100).toFixed(2)}%) — vượt dung sai ${(incident.tolerancePct * 100).toFixed(1)}%`,
    `Nội bộ đã được đồng bộ theo số Sàn. Lệnh mới bị CHẶN cho tới khi đối soát tiếp theo sạch.`,
  ].join('\n');
}
