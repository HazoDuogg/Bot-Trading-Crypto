import { describe, it, expect } from 'vitest';
import { fromEngineStartup, fromPollError, fromLifecycleEvent, fromCircuitBreakerTripped, STRATEGY_NAME, R_MULTIPLE } from './eventRecord.js';
import type { LifecycleEvent } from './orderLifecycle.js';
import type { DetectedFvgSignal } from './signalEngine.js';
import type { SoftVetoResolution } from '../positionSizing/softVeto.js';

const signal: DetectedFvgSignal = {
  type: 'FVG_DETECTED',
  symbol: 'BTCUSDT',
  direction: 'LONG',
  gapLow: 100,
  gapHigh: 101,
  invalidationPrice: 98,
  breaksKeyZone: true,
  detectedAtOpenTime: 0,
  atrH1Pct: 1.2,
  keyZoneDistancePct: 0.3,
  regime: { trend: 'UPTREND', trendAgeH1Candles: 7, atrPercentileH1: 40, distanceFromEma200H1Pct: 0.8 },
};

const softVeto: SoftVetoResolution = { baseRiskPct: 0.015, adjustedRiskPct: 0.02, tier: 'TOP', predictedScore: 0.7 };

describe('STRATEGY_NAME / R_MULTIPLE', () => {
  it('strategy name is the fixed literal the ticket specifies', () => {
    expect(STRATEGY_NAME).toBe('FVG H1+M15');
  });
  it('R_MULTIPLE is read from production config (DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple), currently 2.1', () => {
    expect(R_MULTIPLE).toBe(2.1);
  });
});

describe('fromEngineStartup / fromPollError', () => {
  it('builds a startup record with symbols and endpoint in the note', () => {
    const rec = fromEngineStartup({ symbols: ['BTCUSDT', 'ETHUSDT'], baseUrl: 'https://testnet.binancefuture.com', isRestart: false, balanceUsdt: 1234.56 });
    expect(rec.eventKind).toBe('ENGINE_STARTUP');
    expect(rec.note).toContain('BTCUSDT');
    expect(rec.note).toContain('testnet.binancefuture.com');
  });

  // TICKET-RT-072: real balance passed through to the record for the Telegram formatter to show.
  it('carries the real startup balance through to startupBalanceUsdt', () => {
    const rec = fromEngineStartup({ symbols: ['BTCUSDT'], baseUrl: 'https://testnet.binancefuture.com', isRestart: false, balanceUsdt: 987.65 });
    expect(rec.startupBalanceUsdt).toBe(987.65);
  });

  it('carries a null balance through when the real fetch failed at startup', () => {
    const rec = fromEngineStartup({ symbols: ['BTCUSDT'], baseUrl: 'https://testnet.binancefuture.com', isRestart: false, balanceUsdt: null });
    expect(rec.startupBalanceUsdt).toBeNull();
  });

  it('builds a poll-error record with the failure count', () => {
    const rec = fromPollError({ symbol: 'ETHUSDT', message: 'timeout', consecutiveFailures: 4 });
    expect(rec.eventKind).toBe('POLL_ERROR');
    expect(rec.note).toContain('#4');
    expect(rec.note).toContain('timeout');
  });
});

// TICKET-RT-073 Part A
describe('fromCircuitBreakerTripped', () => {
  it('builds a CIRCUIT_BREAKER_TRIPPED record, symbol ALL, mentioning the error count and that entries are blocked', () => {
    const rec = fromCircuitBreakerTripped({ consecutiveErrors: 3 });
    expect(rec.eventKind).toBe('CIRCUIT_BREAKER_TRIPPED');
    expect(rec.symbol).toBe('ALL');
    expect(rec.note).toContain('3');
    expect(rec.note).toMatch(/DUNG phat hien Entry/i);
  });
});

describe('fromLifecycleEvent', () => {
  it('ENTRY_PLACED: carries regime, Entry/SL/TP, R:R, and an entry reason mentioning gap + trend', () => {
    const event: LifecycleEvent = { type: 'ENTRY_PLACED', symbol: 'BTCUSDT', orderId: 1, direction: 'LONG', entryPrice: 100, slPrice: 98, tpPrice: 104.2, quantity: 0.01, riskPct: 0.02, riskUsd: 20, balanceUsedUsdt: 1000, signal, softVeto };
    const rec = fromLifecycleEvent(event);
    expect(rec.eventKind).toBe('ENTRY_PLACED');
    expect(rec.regime).toEqual(signal.regime);
    expect(rec.entryPrice).toBe(100);
    expect(rec.rMultiple).toBe(2.1);
    expect(rec.entryReasonText).toContain('UPTREND');
    expect(rec.entryReasonText).toContain('breaksKeyZone');
  });

  // TICKET-RT-077
  it('ENTRY_PLACED: carries Soft Veto score/tier and risk% before/after adjustment', () => {
    const event: LifecycleEvent = { type: 'ENTRY_PLACED', symbol: 'BTCUSDT', orderId: 1, direction: 'LONG', entryPrice: 100, slPrice: 98, tpPrice: 104.2, quantity: 0.01, riskPct: 0.02, riskUsd: 20, balanceUsedUsdt: 1000, signal, softVeto };
    const rec = fromLifecycleEvent(event);
    expect(rec.softVetoScore).toBe(0.7);
    expect(rec.softVetoTier).toBe('TOP');
    expect(rec.riskPctBeforeAdjustment).toBe(0.015);
    expect(rec.riskPctAfterAdjustment).toBe(0.02);
  });

  it('ENTRY_SKIPPED: carries the skip reason', () => {
    const event: LifecycleEvent = { type: 'ENTRY_SKIPPED', symbol: 'BTCUSDT', reason: 'slPct too small', signal };
    const rec = fromLifecycleEvent(event);
    expect(rec.note).toContain('slPct too small');
  });

  it('ENTRY_TIMEOUT_CANCELLED: mentions maxWaitCandles', () => {
    const event: LifecycleEvent = { type: 'ENTRY_TIMEOUT_CANCELLED', symbol: 'BTCUSDT', orderId: 1, waitedCandles: 20 };
    const rec = fromLifecycleEvent(event);
    expect(rec.note).toContain('maxWaitCandles=20');
  });

  it('ENTRY_FILLED: uses the real fill price/qty', () => {
    const event: LifecycleEvent = { type: 'ENTRY_FILLED', symbol: 'BTCUSDT', direction: 'LONG', entryPrice: 100.03, quantity: 0.0099, slPrice: 98, tpPrice: 104.2, slOrderId: 2, tpOrderId: 3, signal, softVeto };
    const rec = fromLifecycleEvent(event);
    expect(rec.entryPrice).toBe(100.03);
    expect(rec.note).toContain('0.0099');
  });

  // TICKET-RT-077
  it('ENTRY_FILLED: carries Soft Veto score/tier and risk% before/after adjustment', () => {
    const event: LifecycleEvent = { type: 'ENTRY_FILLED', symbol: 'BTCUSDT', direction: 'LONG', entryPrice: 100.03, quantity: 0.0099, slPrice: 98, tpPrice: 104.2, slOrderId: 2, tpOrderId: 3, signal, softVeto };
    const rec = fromLifecycleEvent(event);
    expect(rec.softVetoScore).toBe(0.7);
    expect(rec.softVetoTier).toBe('TOP');
    expect(rec.riskPctBeforeAdjustment).toBe(0.015);
    expect(rec.riskPctAfterAdjustment).toBe(0.02);
  });

  it('POSITION_CLOSED: reports outcome, real PnL, and reason; flags the rare both-filled race', () => {
    const event: LifecycleEvent = { type: 'POSITION_CLOSED', symbol: 'BTCUSDT', outcome: 'TP', exitPrice: 104.2, realizedPnlUsd: 3.14, bothOrdersReportedFilled: false };
    const rec = fromLifecycleEvent(event);
    expect(rec.resultOutcome).toBe('TP');
    expect(rec.resultPnlUsd).toBe(3.14);
    expect(rec.resultReasonText).toContain('104.2');
    expect(rec.note).toBeUndefined();

    const raceEvent: LifecycleEvent = { ...event, bothOrdersReportedFilled: true };
    const raceRec = fromLifecycleEvent(raceEvent);
    expect(raceRec.note).toContain('CANH BAO');
  });

  it('LIFECYCLE_ERROR: carries context and message', () => {
    const event: LifecycleEvent = { type: 'LIFECYCLE_ERROR', symbol: 'BTCUSDT', context: 'getOrder', message: 'timeout' };
    const rec = fromLifecycleEvent(event);
    expect(rec.note).toContain('getOrder');
    expect(rec.note).toContain('timeout');
  });
});
