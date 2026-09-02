import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import type { SetupSignal } from '../setup/setupDetectorA.js';
import {
  createNukidaFsm,
  type FsmEvent,
  type FsmStageEvaluation,
  type NukidaStrategyAdapter,
} from './nukidaFsm.js';

function candle(index: number, low = 98, high = 102, close = 100): Candle {
  return { openTime: index * 900_000, open: 100, high, low, close, volume: 100 };
}

function m1(openTime: number, low: number, high: number, close: number): Candle {
  return { openTime, open: close, high, low, close, volume: 10 };
}

// Expands each M15 candle into 15 flat M1 sub-candles sharing its OHLC — enough to resolve
// fill/no-fill/expiry for tests that don't need minute-level control within a single window.
function buildM1(m15Candles: readonly Candle[]): Candle[] {
  return m15Candles.flatMap((m15Candle) =>
    Array.from({ length: 15 }, (_, offset) =>
      m1(m15Candle.openTime + offset * 60_000, m15Candle.low, m15Candle.high, m15Candle.close),
    ),
  );
}

function setupA(triggerIndex = 14): SetupSignal {
  return {
    setupFamily: 'A_COMPRESSION_BREAKOUT',
    direction: 'BULL',
    triggerIndex,
    reasonTrace: {
      quality: { label: 'CLEAN', efficiency: 0.2, sweepCount: 1 },
      dominance: {
        side: 'BULL',
        brokeLevel: 100,
        counterTestFailed: true,
        counterTestIndex: triggerIndex - 4,
      },
      d3: { startIndex: 2, endIndex: 9, high: 100, low: 90 },
      d5: { bandwidthAtrRatio: 1.5, isCompressed: true },
      d2: { brokeAt: triggerIndex, level: 100 },
      d7: { bodyRatio: 0.7, rangeAtrRatio: 1.2, isStrong: true },
    },
  };
}

const cleanBull = {
  quality: { label: 'CLEAN', efficiency: 0.2, sweepCount: 1 },
  dominance: {
    side: 'BULL',
    brokeLevel: 100,
    counterTestFailed: true,
    counterTestIndex: 10,
  },
  setups: [],
} satisfies FsmStageEvaluation;

function adapterAt(overrides: Record<number, FsmStageEvaluation>): NukidaStrategyAdapter {
  return {
    onClosedCandle(_candles, index) {
      return (
        overrides[index] ?? {
          quality: { label: 'UNCLEAR', efficiency: 0.08, sweepCount: 2 },
          dominance: null,
          setups: [],
        }
      );
    },
  };
}

function config(strategyAdapter: NukidaStrategyAdapter, m1Candles: readonly Candle[] = []) {
  return {
    tickSize: 1,
    lotSize: 1,
    riskBudgetUsd: 20,
    leverage: 10,
    m1Candles,
    dataGate: () => ({ accepted: true }),
    strategyAdapter,
  };
}

function runThrough(candles: readonly Candle[], fsm: ReturnType<typeof createNukidaFsm>): FsmEvent[] {
  const events: FsmEvent[] = [];
  for (let index = 0; index < candles.length; index += 1) {
    events.push(...fsm.onClosedCandle(candles.slice(0, index + 1), index));
  }
  return events;
}

describe('createNukidaFsm', () => {
  it('runs a setup through pending entry to a complete trade plan within the single M1 window', () => {
    const emittedSetup = setupA();
    const candles = Array.from({ length: 16 }, (_, index) => candle(index));
    const windowStart = candle(15).openTime;
    const m1Candles = [
      m1(windowStart, 100, 105, 103),
      m1(windowStart + 60_000, 100, 105, 103),
      m1(windowStart + 120_000, 98, 101, 100),
    ];
    const fsm = createNukidaFsm(
      config(adapterAt({ 14: { ...cleanBull, setups: [emittedSetup] } }), m1Candles),
    );
    const events = runThrough(candles, fsm);

    expect(events).toContainEqual({
      index: 14,
      state: 'SETUP_DETECTED',
      setupFamily: 'A_COMPRESSION_BREAKOUT',
    });
    expect(events.find((event) => event.state === 'TRADE_PLAN_READY')).toEqual({
      index: 15,
      state: 'TRADE_PLAN_READY',
      setupFamily: 'A_COMPRESSION_BREAKOUT',
      setupSignal: emittedSetup,
      tradePlan: {
        direction: 'BULL',
        entryPrice: 99,
        stopLoss: 89,
        takeProfit: 119,
        riskPerUnit: 10,
        positionSize: 2,
        requiredMargin: 19.8,
      },
      entry: { status: 'FILLED', fillTimestamp: windowStart + 120_000, fillPrice: 99 },
    });
  });

  it('rejects a candle when D4 quality is not CLEAN', () => {
    const fsm = createNukidaFsm(config(adapterAt({})));

    expect(fsm.onClosedCandle([candle(0)], 0)).toContainEqual({
      index: 0,
      state: 'REJECTED',
      reasonCode: 'QUALITY_NOT_CLEAN',
    });
  });

  it('uses the injected S0 data gate without exposing future candles', () => {
    const fsm = createNukidaFsm({
      ...config(adapterAt({})),
      dataGate(candles, index) {
        expect(candles).toHaveLength(index + 1);
        return { accepted: false, reasonCode: 'DATA_GAP' };
      },
    });

    expect(fsm.onClosedCandle([candle(0), candle(1)], 0)).toEqual([
      { index: 0, state: 'REJECTED', reasonCode: 'DATA_GAP' },
    ]);
  });

  it('rejects CLEAN quality with neutral dominance', () => {
    const fsm = createNukidaFsm(
      config(adapterAt({ 0: { quality: cleanBull.quality, dominance: null, setups: [] } })),
    );

    expect(fsm.onClosedCandle([candle(0)], 0)).toContainEqual({
      index: 0,
      state: 'REJECTED',
      reasonCode: 'DOMINANCE_NEUTRAL',
    });
  });

  it('rejects CLEAN dominant state when neither setup family activates', () => {
    const fsm = createNukidaFsm(config(adapterAt({ 0: cleanBull })));

    expect(fsm.onClosedCandle([candle(0)], 0)).toContainEqual({
      index: 0,
      state: 'REJECTED',
      reasonCode: 'NO_SETUP',
    });
  });

  it('expires 15M on the very first retry once the single M1 window closes with no fill', () => {
    const candles = Array.from({ length: 16 }, (_, index) => candle(index, 100, 105, 103));
    const fsm = createNukidaFsm(
      config(adapterAt({ 14: { ...cleanBull, setups: [setupA()] } }), buildM1(candles)),
    );
    const events = runThrough(candles, fsm);

    expect(events).toContainEqual({
      index: 15,
      state: 'ENTRY_EXPIRED',
      reasonCode: 'ENTRY_EXPIRED',
      setupFamily: 'A_COMPRESSION_BREAKOUT',
    });
  });

  it('cancels over-extension immediately and reports its reason code', () => {
    // low=105 stays above limitPrice=99 (no fill match) while close=125 trips the
    // over-extension check first, within the single M1 window right after trigger.
    const candles = [
      ...Array.from({ length: 15 }, (_, index) => candle(index)),
      candle(15, 105, 130, 125),
    ];
    const fsm = createNukidaFsm(
      config(adapterAt({ 14: { ...cleanBull, setups: [setupA()] } }), buildM1(candles)),
    );
    const events = runThrough(candles, fsm);

    expect(events).toContainEqual({
      index: 15,
      state: 'ENTRY_CANCELLED',
      reasonCode: 'ENTRY_CANCELLED_OVER_EXTENDED',
      setupFamily: 'A_COMPRESSION_BREAKOUT',
    });
  });

  it('emits a distinct minimum-stop rejection after entry fills', () => {
    const narrowSetup = setupA();
    narrowSetup.reasonTrace.d3!.low = 98;
    const candles = Array.from({ length: 16 }, (_, index) => candle(index));
    const windowStart = candle(15).openTime;
    const m1Candles = [
      m1(windowStart, 100, 105, 103),
      m1(windowStart + 60_000, 100, 105, 103),
      m1(windowStart + 120_000, 98, 101, 100),
    ];
    const fsm = createNukidaFsm(
      config(adapterAt({ 14: { ...cleanBull, setups: [narrowSetup] } }), m1Candles),
    );

    expect(runThrough(candles, fsm)).toContainEqual({
      index: 15,
      state: 'TRADE_PLAN_REJECTED',
      reasonCode: 'MIN_STOP_DISTANCE',
      setupFamily: 'A_COMPRESSION_BREAKOUT',
      setupSignal: narrowSetup,
    });
  });

  it('never reads a candle beyond the supplied index', () => {
    const source = [candle(0), candle(1, 1, 1_000, 500)];
    const guarded = new Proxy(source, {
      get(target, property, receiver) {
        if (property === '1') throw new Error('future candle read');
        return Reflect.get(target, property, receiver);
      },
    });
    const fsm = createNukidaFsm(config(adapterAt({})));

    expect(() => fsm.onClosedCandle(guarded, 0)).not.toThrow();
  });
});
