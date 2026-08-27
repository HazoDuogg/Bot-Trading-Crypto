import { describe, it, expect } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import { SymbolSignalEngine } from './signalEngine.js';

const H1_MS = 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;
const BASE_TIME = Date.UTC(2026, 0, 1, 0, 0, 0);

function h1(i: number, close: number, open = close, high = close + 0.05, low = close - 0.05): Candle {
  return { openTime: BASE_TIME + i * H1_MS, open, high, low, close, volume: 100 };
}
function m15(i: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime: BASE_TIME + 1000 * H1_MS + i * M15_MS, open, high, low, close, volume: 100 };
}

// Same synthetic-history construction as RT-067's original tests: 150 flat H1 candles at 100, then
// a smooth 50-candle ramp — keeps every candle's own body/range tiny (no shock/volatility false
// trip) while reliably producing UPTREND from the real classifyTrendH1 (period=200 -> the single
// EMA value is just the plain mean of all 200 closes, ~101.25 here vs a final close of 110).
// 3 extra stable candles after the ramp (still UPTREND, close held near 110) so trendAgeH1Candles
// has a chance to be > 0 by the time a signal is checked — the ramp's OWN last candle is where the
// trend first becomes computable (EMA200 needs exactly 200 candles) AND changes from null, so age
// is 0 there by construction; these extra candles let age reflect a trend that's been in place a
// little while, closer to a realistic scenario.
function seedUptrendH1(engine: SymbolSignalEngine): void {
  for (let i = 0; i < 150; i++) engine.onNewH1Candle(h1(i, 100));
  for (let i = 150; i < 200; i++) engine.onNewH1Candle(h1(i, 100 + ((i - 150) / 49) * 10));
  for (let i = 200; i < 203; i++) engine.onNewH1Candle(h1(i, 110));
}
function seedDowntrendH1(engine: SymbolSignalEngine): void {
  for (let i = 0; i < 150; i++) engine.onNewH1Candle(h1(i, 100));
  for (let i = 150; i < 200; i++) engine.onNewH1Candle(h1(i, 100 - ((i - 150) / 49) * 10));
  for (let i = 200; i < 203; i++) engine.onNewH1Candle(h1(i, 90));
}

describe('SymbolSignalEngine.checkForNewSignal — pure detection only (RT-068: no simulated fill/close)', () => {
  it('detects a bullish FVG in an uptrend and attaches the 4 regime fields', () => {
    const engine = new SymbolSignalEngine('BTCUSDT');
    seedUptrendH1(engine);

    const c1 = m15(0, 100, 101, 99, 100.5);
    const c2 = m15(1, 100.2, 104.5, 99.9, 104.2); // strong bullish body, ratio 0.87 >= 0.7
    const c3 = m15(2, 102, 104, 101.5, 103); // low=101.5 > candle1.high(101) -> bullish gap

    expect(engine.checkForNewSignal(c1, true)).toBeNull();
    expect(engine.checkForNewSignal(c2, true)).toBeNull();
    const signal = engine.checkForNewSignal(c3, true);

    expect(signal).not.toBeNull();
    expect(signal?.type).toBe('FVG_DETECTED');
    expect(signal?.direction).toBe('LONG');
    expect(signal?.gapLow).toBe(101);
    expect(signal?.gapHigh).toBe(101.5);
    expect(signal?.invalidationPrice).toBe(99);
    expect(signal?.regime.trend).toBe('UPTREND');
    expect(signal?.regime.trendAgeH1Candles).toBeGreaterThan(0);
    expect(Number.isFinite(signal?.regime.atrPercentileH1)).toBe(true);
    expect(Number.isFinite(signal?.regime.distanceFromEma200H1Pct)).toBe(true);
    expect(signal?.regime.distanceFromEma200H1Pct).toBeGreaterThan(0); // close(110) above EMA -> positive distance
  });

  it('detects a bearish FVG in a downtrend (mirror case)', () => {
    const engine = new SymbolSignalEngine('ETHUSDT');
    seedDowntrendH1(engine);

    const c1 = m15(0, 100, 101, 99, 99.5);
    const c2 = m15(1, 99.8, 100.1, 95.5, 95.8);
    const c3 = m15(2, 98, 98.5, 96, 97); // high=98.5 < candle1.low(99) -> bearish gap

    engine.checkForNewSignal(c1, true);
    engine.checkForNewSignal(c2, true);
    const signal = engine.checkForNewSignal(c3, true);

    expect(signal?.direction).toBe('SHORT');
    expect(signal?.gapLow).toBe(98.5);
    expect(signal?.gapHigh).toBe(99);
    expect(signal?.invalidationPrice).toBe(101);
    expect(signal?.regime.trend).toBe('DOWNTREND');
    expect(signal?.regime.distanceFromEma200H1Pct).toBeLessThan(0);
  });

  it('does NOT detect when freeToDetect=false (execution layer says busy) — mirrors checkpoint 1', () => {
    const engine = new SymbolSignalEngine('BTCUSDT');
    seedUptrendH1(engine);
    const c1 = m15(0, 100, 101, 99, 100.5);
    const c2 = m15(1, 100.2, 104.5, 99.9, 104.2);
    const c3 = m15(2, 102, 104, 101.5, 103);
    engine.checkForNewSignal(c1, false);
    engine.checkForNewSignal(c2, false);
    expect(engine.checkForNewSignal(c3, false)).toBeNull(); // would have been a signal if free
  });

  it('checkNoTradeZone genuinely gates detection — a shock event blocks it', () => {
    const engine = new SymbolSignalEngine('BTCUSDT');
    for (let i = 0; i < 150; i++) engine.onNewH1Candle(h1(i, 100));
    for (let i = 150; i < 199; i++) engine.onNewH1Candle(h1(i, 100 + ((i - 150) / 48) * 10));
    engine.onNewH1Candle(h1(199, 130, 100, 131, 99)); // 30% single-candle body -> isShockEvent trips

    const c1 = m15(0, 100, 101, 99, 100.5);
    const c2 = m15(1, 100.2, 104.5, 99.9, 104.2);
    const c3 = m15(2, 102, 104, 101.5, 103);
    engine.checkForNewSignal(c1, true);
    engine.checkForNewSignal(c2, true);
    expect(engine.checkForNewSignal(c3, true)).toBeNull();
  });

  it('does not throw before any H1 history has arrived, and reports no signal', () => {
    const engine = new SymbolSignalEngine('BTCUSDT');
    const c1 = m15(0, 100, 101, 99, 100.5);
    expect(engine.checkForNewSignal(c1, true)).toBeNull();
    expect(engine.getDebugState().h1Count).toBe(0);
  });
});
