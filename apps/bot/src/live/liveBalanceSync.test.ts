import { describe, it, expect, vi } from 'vitest';
import {
  parseExchangeBalanceSnapshot,
  fetchFreshBalanceSnapshot,
  checkBalanceDivergence,
  syncBalanceForTelegramEvent,
  formatBalanceDivergenceIncidentLog,
  formatBalanceDivergenceTelegramWarning,
} from './liveBalanceSync.js';

function makeExecutor(accountInfo: unknown) {
  return { getAccountInfo: vi.fn().mockResolvedValue(accountInfo) };
}

describe('parseExchangeBalanceSnapshot', () => {
  it('parses totalWalletBalance/totalMarginBalance/availableBalance from the raw /fapi/v2/account shape', () => {
    const snap = parseExchangeBalanceSnapshot({ totalWalletBalance: '346.04', totalMarginBalance: '350.10', availableBalance: '312.00' }, 123);
    expect(snap).toEqual({ walletBalance: 346.04, marginBalance: 350.1, availableBalance: 312, fetchedAt: 123 });
  });

  it('throws instead of silently returning NaN when a required field is missing', () => {
    expect(() => parseExchangeBalanceSnapshot({ totalWalletBalance: '100' }, 1)).toThrow(/totalWalletBalance\/totalMarginBalance\/availableBalance/);
  });
});

describe('fetchFreshBalanceSnapshot', () => {
  it('returns a parsed snapshot on success', async () => {
    const executor = makeExecutor({ totalWalletBalance: '400', totalMarginBalance: '405', availableBalance: '390' });
    const snap = await fetchFreshBalanceSnapshot(executor);
    expect(snap).toMatchObject({ walletBalance: 400, marginBalance: 405, availableBalance: 390 });
  });

  it('returns null (never throws) when getAccountInfo() rejects', async () => {
    const executor = { getAccountInfo: vi.fn().mockRejectedValue(new Error('network down')) };
    const snap = await fetchFreshBalanceSnapshot(executor);
    expect(snap).toBeNull();
  });

  it('returns null (never throws) on timeout — REST fallback path (req. 2/6)', async () => {
    const executor = { getAccountInfo: vi.fn(() => new Promise(() => {})) }; // never resolves
    const snap = await fetchFreshBalanceSnapshot(executor, 20);
    expect(snap).toBeNull();
  });

  it('returns null when the raw payload is malformed', async () => {
    const executor = makeExecutor({ totalWalletBalance: 'not-a-number' });
    const snap = await fetchFreshBalanceSnapshot(executor);
    expect(snap).toBeNull();
  });
});

describe('checkBalanceDivergence', () => {
  it('flags divergence beyond tolerance', () => {
    const r = checkBalanceDivergence(346.04, 318.41, 0.01);
    expect(r.diverged).toBe(true);
    expect(r.diffUsd).toBeCloseTo(27.63, 2);
  });

  it('does not flag divergence within tolerance', () => {
    const r = checkBalanceDivergence(400, 401, 0.01);
    expect(r.diverged).toBe(false);
  });
});

describe('syncBalanceForTelegramEvent', () => {
  it('normal single position close: corrects internal balance to the fresh exchange read', async () => {
    const executor = makeExecutor({ totalWalletBalance: '420.50', totalMarginBalance: '420.50', availableBalance: '400' });
    const outcome = await syncBalanceForTelegramEvent(executor, 400);
    expect(outcome.correctedInternalBalance).toBe(420.5);
    expect(outcome.snapshot).not.toBeNull();
  });

  it('REST fallback path: returns "pending" (unchanged internal balance) when the fetch fails/times out', async () => {
    const executor = { getAccountInfo: vi.fn().mockRejectedValue(new Error('timeout')) };
    const outcome = await syncBalanceForTelegramEvent(executor, 318.41);
    expect(outcome.snapshot).toBeNull();
    expect(outcome.correctedInternalBalance).toBe(318.41);
    expect(outcome.diverged).toBe(false);
  });

  it('duplicate account event does not apply the balance update twice (idempotent — overwrite, not accumulate)', async () => {
    const executor = makeExecutor({ totalWalletBalance: '346.04', totalMarginBalance: '346.04', availableBalance: '330' });
    const first = await syncBalanceForTelegramEvent(executor, 318.41);
    const second = await syncBalanceForTelegramEvent(executor, first.correctedInternalBalance);
    expect(first.correctedInternalBalance).toBe(346.04);
    expect(second.correctedInternalBalance).toBe(346.04); // re-applying the same exchange read is a no-op, not +27.63 again
  });

  it('two logical positions on the same symbol closing near each other (One-Way mode): each close reads the CURRENT cumulative wallet balance, never a locally-summed delta', async () => {
    const executor = makeExecutor({ totalWalletBalance: '300', totalMarginBalance: '300', availableBalance: '290' });
    const afterFirstClose = await syncBalanceForTelegramEvent(executor, 280);
    expect(afterFirstClose.correctedInternalBalance).toBe(300);

    // Second logical position on the same symbol closes moments later — Binance's wallet balance now
    // reflects BOTH closes cumulatively; the sync must show that new cumulative number, not
    // 300 + (some separately-computed second delta).
    executor.getAccountInfo.mockResolvedValue({ totalWalletBalance: '318.41', totalMarginBalance: '318.41', availableBalance: '305' });
    const afterSecondClose = await syncBalanceForTelegramEvent(executor, afterFirstClose.correctedInternalBalance);
    expect(afterSecondClose.correctedInternalBalance).toBe(318.41);
  });

  it('reproduces the reported incident: internal=$318.41 vs real Binance=$346.04 — final balance used is the real $346.04, not $318.41', async () => {
    const executor = makeExecutor({ totalWalletBalance: '346.04', totalMarginBalance: '346.04', availableBalance: '330' });
    const outcome = await syncBalanceForTelegramEvent(executor, 318.41);
    expect(outcome.correctedInternalBalance).toBe(346.04);
    expect(outcome.correctedInternalBalance).not.toBe(318.41);
    expect(outcome.diverged).toBe(true);
    expect(outcome.divergence?.diffUsd).toBeCloseTo(27.63, 2);
  });

  it('restart/reconcile: a fresh getAccountInfo() read after restart recovers the correct Binance balance regardless of any stale prior internal value', async () => {
    const executor = makeExecutor({ totalWalletBalance: '346.04', totalMarginBalance: '346.04', availableBalance: '330' });
    const staleInternalFromBeforeRestart = 0; // simulates a restart with no carried-over internal state
    const outcome = await syncBalanceForTelegramEvent(executor, staleInternalFromBeforeRestart);
    expect(outcome.correctedInternalBalance).toBe(346.04);
  });
});

describe('formatBalanceDivergenceIncidentLog / formatBalanceDivergenceTelegramWarning', () => {
  const incident = { timestampMs: Date.UTC(2026, 0, 1), exchangeWalletBalance: 346.04, internalBalanceBefore: 318.41, diffUsd: 27.63, diffPct: 0.0798, tolerancePct: 0.01 };

  it('log line contains every incident field the ticket requires (full incident record)', () => {
    const line = formatBalanceDivergenceIncidentLog(incident);
    expect(line).toContain('346.04');
    expect(line).toContain('318.41');
    expect(line).toContain('27.63');
    expect(line).toContain('ENTRIES_BLOCKED_UNTIL_RECONCILED');
  });

  it('telegram warning states the divergence and that new entries are blocked', () => {
    const text = formatBalanceDivergenceTelegramWarning(incident);
    expect(text).toContain('346.04');
    expect(text).toContain('318.41');
    expect(text).toContain('CHẶN');
  });
});
