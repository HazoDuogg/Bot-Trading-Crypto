import { describe, it, expect } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import { SymbolSignalEngine, type SignalEvent, type VirtualCloseEvent } from './signalEngine.js';

const H1_MS = 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;
const BASE_TIME = Date.UTC(2026, 0, 1, 0, 0, 0);

function h1(i: number, close: number, open = close, high = close + 0.05, low = close - 0.05): Candle {
  return { openTime: BASE_TIME + i * H1_MS, open, high, low, close, volume: 100 };
}
function m15(i: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime: BASE_TIME + 1000 * H1_MS + i * M15_MS, open, high, low, close, volume: 100 };
}

// 200 H1 candles: 150 flat at 100, then a smooth 50-candle ramp to 110 — keeps every single
// candle's own body/range tiny (no isShockEvent/isVolatilityExtreme false trip) while still
// pushing the final close comfortably above the 200-candle SMA (since exactly period=200 candles
// means computeEma's "seed" IS the only value — plain mean of all 200 closes, ~101.25 here vs a
// final close of 110), reliably producing UPTREND from the real classifyTrendH1.
function seedUptrendH1(engine: SymbolSignalEngine): void {
  for (let i = 0; i < 150; i++) engine.onNewH1Candle(h1(i, 100));
  for (let i = 150; i < 200; i++) {
    const close = 100 + ((i - 150) / 49) * 10; // 100 -> 110
    engine.onNewH1Candle(h1(i, close));
  }
}

// Mirror image for DOWNTREND: ramp DOWN from 100 to 90.
function seedDowntrendH1(engine: SymbolSignalEngine): void {
  for (let i = 0; i < 150; i++) engine.onNewH1Candle(h1(i, 100));
  for (let i = 150; i < 200; i++) {
    const close = 100 - ((i - 150) / 49) * 10; // 100 -> 90
    engine.onNewH1Candle(h1(i, close));
  }
}

function isSignal(e: unknown): e is SignalEvent {
  return !!e && (e as SignalEvent).type === 'SIGNAL';
}
function isVirtualClose(e: unknown): e is VirtualCloseEvent {
  return !!e && (e as VirtualCloseEvent).type === 'VIRTUAL_CLOSE';
}

describe('SymbolSignalEngine — bullish FVG in an uptrend', () => {
  it('goes quiet -> pending -> SIGNAL -> VIRTUAL_CLOSE, calling the real production functions throughout', () => {
    const engine = new SymbolSignalEngine('BTCUSDT');
    seedUptrendH1(engine);

    // Candle1: wick low=99, high=101. Candle2: strong bullish body (open=100.2,close=104.2,
    // range 99.9-104.5 -> body=4, range=4.6, ratio=0.87>=0.7). Candle3: low=101.5 > candle1.high(101)
    // -> confirms an unfilled bullish gap [101, 101.5], invalidation = candle1.low = 99.
    const c1 = m15(0, 100, 101, 99, 100.5);
    const c2 = m15(1, 100.2, 104.5, 99.9, 104.2);
    const c3 = m15(2, 102, 104, 101.5, 103);

    expect(engine.onNewM15Candle(c1, c1.openTime + M15_MS)).toBeNull();
    expect(engine.onNewM15Candle(c2, c2.openTime + M15_MS)).toBeNull();
    const afterC3 = engine.onNewM15Candle(c3, c3.openTime + M15_MS);
    expect(afterC3).toBeNull(); // FVG just formed -> pending, not yet a signal
    expect(engine.getDebugState().pending).not.toBeNull();
    expect(engine.getDebugState().pending?.direction).toBe('LONG');

    // Candle4 touches the gap [101, 101.5] -> fills.
    const c4 = m15(3, 102, 102.5, 101.2, 101.8);
    const fillEvent = engine.onNewM15Candle(c4, c4.openTime + M15_MS);
    expect(isSignal(fillEvent)).toBe(true);
    if (isSignal(fillEvent)) {
      expect(fillEvent.symbol).toBe('BTCUSDT');
      expect(fillEvent.direction).toBe('LONG');
      expect(fillEvent.entryPrice).toBe(101); // gapLow for a LONG fill
      expect(fillEvent.slPrice).toBe(99); // candle1.low
      expect(fillEvent.tpPrice).toBeCloseTo(101 + 2.1 * (101 - 99), 6); // TARGET_R=2.10, production config
      expect(fillEvent.riskPct).toBe(0.015); // resolveRiskPct('BTCUSDT', ...) — the real production function
    }
    expect(engine.getDebugState().pending).toBeNull();
    expect(engine.getDebugState().open).not.toBeNull();

    // No new detection while "virtually open" — mirrors checkpoint 1 (one trade at a time/symbol).
    const c5 = m15(4, 102, 103, 101.5, 102.5);
    expect(engine.onNewM15Candle(c5, c5.openTime + M15_MS)).toBeNull();

    // Price rallies to TP (101 + 2.1*2 = 105.2).
    const c6 = m15(5, 103, 106, 102.5, 105.5);
    const closeEvent = engine.onNewM15Candle(c6, c6.openTime + M15_MS);
    expect(isVirtualClose(closeEvent)).toBe(true);
    if (isVirtualClose(closeEvent)) {
      expect(closeEvent.outcome).toBe('TP');
      expect(closeEvent.exitPrice).toBeCloseTo(105.2, 6);
    }
    expect(engine.getDebugState().open).toBeNull();
  });
});

describe('SymbolSignalEngine — bearish FVG in a downtrend (mirror of the LONG case)', () => {
  it('produces a SHORT signal with SL above entry and TP below', () => {
    const engine = new SymbolSignalEngine('ETHUSDT');
    seedDowntrendH1(engine);

    // Candle1: low=99, high=101 (wick). Candle2: strong bearish body. Candle3: high=98.5 < candle1.low(99)
    // -> bearish gap [98.5, 99], invalidation = candle1.high = 101.
    const c1 = m15(0, 100, 101, 99, 99.5);
    const c2 = m15(1, 99.8, 100.1, 95.5, 95.8); // body=4, range=4.6 -> ratio=0.87
    const c3 = m15(2, 98, 98.5, 96, 97);

    engine.onNewM15Candle(c1, c1.openTime + M15_MS);
    engine.onNewM15Candle(c2, c2.openTime + M15_MS);
    engine.onNewM15Candle(c3, c3.openTime + M15_MS);
    expect(engine.getDebugState().pending?.direction).toBe('SHORT');

    const c4 = m15(3, 98.7, 98.9, 98.6, 98.7); // touches [98.5, 99]
    const fillEvent = engine.onNewM15Candle(c4, c4.openTime + M15_MS);
    expect(isSignal(fillEvent)).toBe(true);
    if (isSignal(fillEvent)) {
      expect(fillEvent.direction).toBe('SHORT');
      expect(fillEvent.entryPrice).toBe(99); // gapHigh for a SHORT fill
      expect(fillEvent.slPrice).toBe(101); // candle1.high
      expect(fillEvent.tpPrice).toBeLessThan(fillEvent.entryPrice);
    }
  });
});

describe('SymbolSignalEngine — checkNoTradeZone genuinely gates detection (not bypassed)', () => {
  it('does not open a pending FVG the candle a shock event (>7.5% single-candle body move) just happened', () => {
    const engine = new SymbolSignalEngine('BTCUSDT');
    // Same uptrend seed, but replace the LAST H1 candle with a violent single-candle move
    // (100 -> 130, 30% body) — should trip isShockEvent and block detection via checkNoTradeZone,
    // proving the real production check function is actually being consulted.
    for (let i = 0; i < 150; i++) engine.onNewH1Candle(h1(i, 100));
    for (let i = 150; i < 199; i++) {
      const close = 100 + ((i - 150) / 48) * 10;
      engine.onNewH1Candle(h1(i, close));
    }
    engine.onNewH1Candle(h1(199, 130, 100, 131, 99)); // shock candle, still closes above EMA (still "uptrend")

    const c1 = m15(0, 100, 101, 99, 100.5);
    const c2 = m15(1, 100.2, 104.5, 99.9, 104.2);
    const c3 = m15(2, 102, 104, 101.5, 103);
    engine.onNewM15Candle(c1, c1.openTime + M15_MS);
    engine.onNewM15Candle(c2, c2.openTime + M15_MS);
    engine.onNewM15Candle(c3, c3.openTime + M15_MS);

    // ntz.blocked should suppress fresh detection entirely (checked BEFORE the trend/FVG branch).
    expect(engine.getDebugState().pending).toBeNull();
  });
});

describe('SymbolSignalEngine — resolveRiskPct is genuinely symbol/breaksKeyZone-aware', () => {
  it('uses HYPEUSDT baseline risk (1.0%) via the real resolveRiskPct, not a hard-coded value', () => {
    const engine = new SymbolSignalEngine('HYPEUSDT');
    seedUptrendH1(engine);
    const c1 = m15(0, 100, 101, 99, 100.5);
    const c2 = m15(1, 100.2, 104.5, 99.9, 104.2);
    const c3 = m15(2, 102, 104, 101.5, 103);
    engine.onNewM15Candle(c1, c1.openTime + M15_MS);
    engine.onNewM15Candle(c2, c2.openTime + M15_MS);
    engine.onNewM15Candle(c3, c3.openTime + M15_MS);
    const c4 = m15(3, 102, 102.5, 101.2, 101.8);
    const fillEvent = engine.onNewM15Candle(c4, c4.openTime + M15_MS);
    expect(isSignal(fillEvent)).toBe(true);
    if (isSignal(fillEvent)) {
      // No key zone in this synthetic history (no swing points formed) -> breaksKeyZone=false -> 1.0%.
      expect(fillEvent.breaksKeyZone).toBe(false);
      expect(fillEvent.riskPct).toBe(0.01);
    }
  });
});
