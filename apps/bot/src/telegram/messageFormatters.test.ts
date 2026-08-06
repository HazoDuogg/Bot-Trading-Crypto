import { describe, expect, it } from 'vitest';
import { MarketRegime } from '../regime/types.js';
import type { CloseTradeEvent, OpenTradeEvent, PartialCloseEvent } from '../orchestrator/types.js';
import { SafetyState5m } from '../regime/htfSafetyTypes.js';
import {
  computeWeeklySummaryStats,
  formatBotStartMessage,
  formatFullCloseMessage,
  formatMomentumContextDecisionMessage,
  formatPartialCloseMessage,
  formatPositionOpenedMessage,
  formatRegimeChangeMessage,
  formatWeeklySummaryMessage,
} from './messageFormatters.js';

const baseOpenEvent: OpenTradeEvent = {
  type: 'OPEN',
  symbol: 'BTCUSDT',
  side: 'LONG',
  regime: MarketRegime.TREND_RIDER,
  setupType: 'OB',
  tpPlan: 'PLAN_A',
  entryTimestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
  entryPrice: 60000,
  riskMultiplier: 1,
  actualRiskDollar: 20,
  marginRequired: 33.33,
  slPrice: 59000,
  tpLevels: [
    { label: 'TP1', price: 61200, rMultiple: 1.2, closePercent: 0.4 },
    { label: 'TP2', price: 62500, rMultiple: 2.5, closePercent: 0.3 },
    { label: 'TP3_RUNNER', price: null, rMultiple: null, closePercent: 0.3 },
  ],
  adx1h: 32.5,
  atrPercentile5m: 78,
  riskPoolPctBefore: 3,
  riskPoolPctAfter: 8,
};

describe('formatBotStartMessage', () => {
  it('includes env label, symbols, balance, and config summary', () => {
    const text = formatBotStartMessage({
      env: 'testnet',
      symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'],
      balance: 400,
      momentumDirectEnabled: true,
      riskPoolMaxPct: 0.15,
      maxConcurrentPositionsPerSymbol: 2,
      timestamp: Date.UTC(2026, 0, 1),
    });
    expect(text).toContain('🚀 [BOT STARTED]');
    expect(text).toContain('TESTNET');
    expect(text).toContain('BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT');
    expect(text).toContain('$400.00');
    expect(text).toContain('MOMENTUM_DIRECT on');
    expect(text).toContain('Risk Pool 15%');
    expect(text).toContain('Max 2 lệnh/coin');
  });

  it('labels mainnet distinctly as TIỀN THẬT', () => {
    const text = formatBotStartMessage({
      env: 'mainnet',
      symbols: ['BTCUSDT'],
      balance: 100,
      momentumDirectEnabled: false,
      riskPoolMaxPct: 0.1,
      maxConcurrentPositionsPerSymbol: 1,
      timestamp: Date.UTC(2026, 0, 1),
    });
    expect(text).toContain('MAINNET — TIỀN THẬT');
  });
});

describe('formatPositionOpenedMessage', () => {
  it('formats a TREND (OB) LONG entry with PLAN_A 3-tier TP breakdown', () => {
    const text = formatPositionOpenedMessage(baseOpenEvent, { env: 'testnet', accountBalanceAtOpen: 400 });
    expect(text).toContain('🟢 LONG');
    expect(text).toContain('#BTCUSDT');
    expect(text).toContain('Entry: $60000.0000');
    expect(text).toContain('SL: $59000.0000');
    expect(text).toContain('TP1 $61200.0000 (40%)');
    expect(text).toContain('TP2 $62500.0000 (30%)');
    expect(text).toContain('Runner (30%, ATR trailing)');
    expect(text).toContain('Risk: $20.00 (~5.0%)'); // 20/400 = 5%
    expect(text).toContain('Setup: OB');
    expect(text).toContain('ADX(1h): 32.5');
    expect(text).toContain('ATR percentile(5m): 78%');
    expect(text).toContain('Risk Pool: 3.0% → 8.0%');
    expect(text).not.toContain('Điểm AI'); // momentumScore undefined
  });

  it('formats a COUNTER_TREND (MOMENTUM_DIRECT) SHORT entry with single fixed TP', () => {
    const event: OpenTradeEvent = {
      ...baseOpenEvent,
      side: 'SHORT',
      setupType: 'MOMENTUM_DIRECT',
      tpLevels: [{ label: 'COUNTER_TREND_TP', price: 58500, rMultiple: null, closePercent: 1 }],
      momentumScore: 0.82,
    };
    const text = formatPositionOpenedMessage(event, { env: 'mainnet', accountBalanceAtOpen: 400 });
    expect(text).toContain('🔴 SHORT');
    expect(text).toContain('TP $58500.0000 (chốt 1 lần)');
    expect(text).toContain('Setup: MOMENTUM_DIRECT');
    expect(text).toContain('Điểm AI: 82.0%');
    expect(text).toContain('MAINNET — TIỀN THẬT');
  });

  it('shows N/A when adx1h/atrPercentile5m are undefined (insufficient history)', () => {
    const event: OpenTradeEvent = { ...baseOpenEvent, adx1h: undefined, atrPercentile5m: undefined };
    const text = formatPositionOpenedMessage(event, { env: 'testnet', accountBalanceAtOpen: 400 });
    expect(text).toContain('ADX(1h): N/A');
    expect(text).toContain('ATR percentile(5m): N/A%');
  });
});

describe('formatPartialCloseMessage', () => {
  it('TP1 fill: SL moves to breakeven, remaining position waits for TP2', () => {
    const event: PartialCloseEvent = {
      type: 'PARTIAL_CLOSE',
      symbol: 'BTCUSDT',
      side: 'LONG',
      tier: 'TP1',
      closePercent: 0.4,
      pnlUsd: 4.75,
      newSlPrice: 60024,
      remainingPercent: 0.6,
      accountBalanceAfter: 400,
      timestamp: Date.UTC(2026, 0, 1, 13, 0, 0),
    };
    const text = formatPartialCloseMessage(event, { env: 'testnet' });
    expect(text).toContain('CHỐT MỘT PHẦN — TP1 CHẠM');
    expect(text).toContain('Đã chốt 40%: +4.75$');
    expect(text).toContain('dời về Breakeven');
    expect(text).toContain('Còn lại 60%');
    expect(text).toContain('chờ TP2');
    expect(text).toContain('Vốn hiện tại: $400.00');
  });

  it('TP2 fill: SL moves up to TP1, remaining position waits for Runner', () => {
    const event: PartialCloseEvent = {
      type: 'PARTIAL_CLOSE',
      symbol: 'ETHUSDT',
      side: 'SHORT',
      tier: 'TP2',
      closePercent: 0.3,
      pnlUsd: 12.3,
      newSlPrice: 3400,
      remainingPercent: 0.3,
      accountBalanceAfter: 415,
      timestamp: Date.UTC(2026, 0, 1, 14, 0, 0),
    };
    const text = formatPartialCloseMessage(event, { env: 'mainnet' });
    expect(text).toContain('CHỐT MỘT PHẦN — TP2 CHẠM');
    expect(text).toContain('dời lên TP1');
    expect(text).toContain('chờ Runner chạy theo ATR trailing');
    expect(text).toContain('MAINNET — TIỀN THẬT');
  });
});

describe('formatFullCloseMessage', () => {
  const closeEvent: CloseTradeEvent = {
    type: 'CLOSE',
    symbol: 'BTCUSDT',
    side: 'LONG',
    regime: MarketRegime.TREND_RIDER,
    setupType: 'OB',
    tpPlan: 'PLAN_A',
    entryTimestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
    entryPrice: 60000,
    exitTimestamp: Date.UTC(2026, 0, 1, 15, 0, 0),
    exitPrice: 62500,
    exitReason: 'TP2',
    pnlUsd: 45.2,
    pnlPct: 12.3,
    riskMultiplier: 1,
    accountBalanceAfter: 445.2,
    adx1h: 28.1,
  };

  it('labels a positive PNL close as WIN', () => {
    const text = formatFullCloseMessage(closeEvent, { env: 'testnet' });
    expect(text).toContain('✅ WIN');
    expect(text).toContain('Tổng PNL: +45.20$');
    expect(text).toContain('Lý do đóng: TP2');
    expect(text).toContain('Entry: LONG @ $60000.0000 → Exit @ $62500.0000');
    expect(text).toContain('ADX(1h) 28.1');
    expect(text).toContain('Vốn hiện tại: $445.20');
  });

  it('labels a negative PNL close as LOSS', () => {
    const lossEvent: CloseTradeEvent = { ...closeEvent, exitReason: 'SL', pnlUsd: -20, accountBalanceAfter: 380 };
    const text = formatFullCloseMessage(lossEvent, { env: 'mainnet' });
    expect(text).toContain('❌ LOSS');
    expect(text).toContain('Tổng PNL: -20.00$');
    expect(text).toContain('MAINNET — TIỀN THẬT');
  });
});

describe('formatRegimeChangeMessage', () => {
  it('shows the transition and the destination regime\'s description', () => {
    const text = formatRegimeChangeMessage({
      symbol: 'BTCUSDT',
      fromRegime: MarketRegime.NEUTRAL_TRANSITION,
      toRegime: MarketRegime.TREND_RIDER,
      adx1h: 35.2,
      atrPercentile5m: 82,
      timestamp: Date.UTC(2026, 0, 1),
    });
    expect(text).toContain('#BTCUSDT');
    expect(text).toContain('NEUTRAL_TRANSITION → TREND_RIDER');
    expect(text).toContain('Trend mạnh');
    expect(text).toContain('ADX(1h): 35.2');
  });
});

describe('computeWeeklySummaryStats + formatWeeklySummaryMessage', () => {
  function makeClose(overrides: Partial<CloseTradeEvent>): CloseTradeEvent {
    return {
      type: 'CLOSE',
      symbol: 'BTCUSDT',
      side: 'LONG',
      regime: MarketRegime.TREND_RIDER,
      setupType: 'OB',
      tpPlan: 'PLAN_A',
      entryTimestamp: 0,
      entryPrice: 100,
      exitTimestamp: Date.UTC(2026, 0, 3),
      exitPrice: 105,
      exitReason: 'TP1',
      pnlUsd: 10,
      pnlPct: 5,
      riskMultiplier: 1,
      accountBalanceAfter: 410,
      ...overrides,
    };
  }

  it('tallies wins/losses/PNL correctly and identifies best/worst trades', () => {
    const trades: CloseTradeEvent[] = [
      makeClose({ symbol: 'BTCUSDT', pnlUsd: 30, exitReason: 'TP2' }),
      makeClose({ symbol: 'ETHUSDT', pnlUsd: -15, exitReason: 'SL' }),
      makeClose({ symbol: 'BTCUSDT', pnlUsd: 5, exitReason: 'TP1' }),
    ];
    const stats = computeWeeklySummaryStats(trades, 'testnet', Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 7), 400);

    expect(stats.totalTrades).toBe(3);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(1);
    expect(stats.totalPnlUsd).toBe(20);
    expect(stats.balanceEnd).toBe(420);
    expect(stats.bestTrade).toMatchObject({ symbol: 'BTCUSDT', pnlUsd: 30 });
    expect(stats.worstTrade).toMatchObject({ symbol: 'ETHUSDT', pnlUsd: -15 });
    expect(stats.bySymbol).toEqual([
      { symbol: 'BTCUSDT', trades: 2, wins: 2, pnlUsd: 35 },
      { symbol: 'ETHUSDT', trades: 1, wins: 0, pnlUsd: -15 },
    ]);
  });

  it('handles an empty trade list without throwing', () => {
    const stats = computeWeeklySummaryStats([], 'testnet', Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 7), 400);
    expect(stats.totalTrades).toBe(0);
    expect(stats.bestTrade).toBeNull();
    expect(stats.worstTrade).toBeNull();
    expect(stats.balanceEnd).toBe(400);
    const text = formatWeeklySummaryMessage(stats);
    expect(text).toContain('Tổng số lệnh: 0');
  });

  it('formats a full summary message with per-symbol and per-exit-reason breakdown', () => {
    const trades: CloseTradeEvent[] = [
      makeClose({ symbol: 'BTCUSDT', pnlUsd: 30, exitReason: 'TP2' }),
      makeClose({ symbol: 'ETHUSDT', pnlUsd: -15, exitReason: 'SL' }),
    ];
    const stats = computeWeeklySummaryStats(trades, 'mainnet', Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 7), 400);
    const text = formatWeeklySummaryMessage(stats);

    expect(text).toContain('TỔNG KẾT TUẦN');
    expect(text).toContain('MAINNET — TIỀN THẬT');
    expect(text).toContain('Balance: $400.00 → $415.00');
    expect(text).toContain('Tổng PNL: +15.00$');
    expect(text).toContain('Thắng: 1 | ❌ Thua: 1 | Winrate: 50.0%');
    expect(text).toContain('#BTCUSDT');
    expect(text).toContain('#ETHUSDT');
    expect(text).toContain('TP2: 1 lệnh');
    expect(text).toContain('SL: 1 lệnh');
  });
});

describe('formatMomentumContextDecisionMessage (TICKET-144)', () => {
  const base = {
    symbol: 'SOLUSDT',
    timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
    side: 'SHORT' as const,
    macroDirection: 'UP' as const,
    macroConflict: true,
    safetyState5m: SafetyState5m.NORMAL,
    candidateId: 'SOLUSDT:MOMENTUM_DIRECT:SHORT:1234567890',
  };

  it('entry (entryAllowed=true) includes decision/riskMultiplier/candidateId, no blockReason line', () => {
    const text = formatMomentumContextDecisionMessage({ ...base, decision: 'ALLOW_REDUCED_RISK', riskMultiplier: 0.3, entryAllowed: true, blockReason: 'macro_conflict_reduced_risk' });
    expect(text).toContain('#SOLUSDT SHORT');
    expect(text).toContain('ALLOW_REDUCED_RISK');
    expect(text).toContain('riskMultiplier=0.3');
    expect(text).toContain('candidateId=SOLUSDT:MOMENTUM_DIRECT:SHORT:1234567890');
    expect(text).not.toContain('blockReason=');
    expect(text).toContain('✅');
  });

  it('macro-conflict BLOCK (entryAllowed=false) includes blockReason', () => {
    const text = formatMomentumContextDecisionMessage({ ...base, symbol: 'BTCUSDT', decision: 'BLOCK', riskMultiplier: 0, entryAllowed: false, blockReason: 'btc_macro_conflict' });
    expect(text).toContain('BLOCK');
    expect(text).toContain('blockReason=btc_macro_conflict');
    expect(text).toContain('⛔');
  });
});
