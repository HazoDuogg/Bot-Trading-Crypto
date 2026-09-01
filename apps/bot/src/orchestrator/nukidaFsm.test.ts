import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import type { SetupSignal } from '../setup/setupDetectorA.js';
import {
  createNukidaFsm,
  type FsmEvent,
  type FsmStageEvaluation,
  type NukidaStrategyAdapter,
} from './nukidaFsm.js';

function candle(index: number, low = 95, high = 105, close = 100): Candle {
  return { openTime: index * 900_000, open: 100, high, low, close, volume: 100 };
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

function setupB(triggerIndex = 14): SetupSignal {
  return {
    setupFamily: 'B_BREAK_PULLBACK_FAILURE',
    direction: 'BEAR',
    triggerIndex,
    reasonTrace: {
      quality: { label: 'CLEAN', efficiency: 0.2, sweepCount: 1 },
      dominance: {
        side: 'BEAR',
        brokeLevel: 110,
        counterTestFailed: true,
        counterTestIndex: triggerIndex - 3,
      },
      d2: { brokeAt: triggerIndex - 6, level: 110 },
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

function config(strategyAdapter: NukidaStrategyAdapter) {
  return {
    tickSize: 1,
    lotSize: 1,
    riskBudgetUsd: 20,
    leverage: 10,
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
  it('runs a setup through pending entry to a complete trade plan', () => {
    const emittedSetup = setupA();
    const candles = [
      ...Array.from({ length: 15 }, (_, index) => candle(index)),
      candle(15, 100, 105, 103),
      candle(16, 98, 101, 100),
    ];
    const fsm = createNukidaFsm(
      config(adapterAt({ 14: { ...cleanBull, setups: [emittedSetup] } })),
    );
    const events = runThrough(candles, fsm);

    expect(events).toContainEqual({
      index: 14,
      state: 'SETUP_DETECTED',
      setupFamily: 'A_COMPRESSION_BREAKOUT',
    });
    expect(events).toContainEqual({
      index: 15,
      state: 'ENTRY_PENDING',
      setupFamily: 'A_COMPRESSION_BREAKOUT',
    });
    expect(events.find((event) => event.state === 'TRADE_PLAN_READY')).toEqual({
      index: 16,
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

  it('expires an unfilled pending setup at candle eight', () => {
    const candles = Array.from({ length: 23 }, (_, index) => candle(index, 100, 105, 103));
    const fsm = createNukidaFsm(
      config(adapterAt({ 14: { ...cleanBull, setups: [setupA()] } })),
    );
    const events = runThrough(candles, fsm);

    expect(events).toContainEqual({
      index: 22,
      state: 'ENTRY_EXPIRED',
      reasonCode: 'ENTRY_EXPIRED',
      setupFamily: 'A_COMPRESSION_BREAKOUT',
    });
  });

  it('cancels over-extension immediately and reports its reason code', () => {
    const candles = [
      ...Array.from({ length: 15 }, (_, index) => candle(index)),
      candle(15, 98, 125, 121),
    ];
    const fsm = createNukidaFsm(
      config(adapterAt({ 14: { ...cleanBull, setups: [setupA()] } })),
    );
    const events = runThrough(candles, fsm);

    expect(events).toContainEqual({
      index: 15,
      state: 'ENTRY_CANCELLED',
      reasonCode: 'ENTRY_CANCELLED_OVER_EXTENDED',
      setupFamily: 'A_COMPRESSION_BREAKOUT',
    });
  });

  it('keeps simultaneous A and B pending setups independent', () => {
    const candles = [
      ...Array.from({ length: 15 }, (_, index) => candle(index)),
      candle(15, 98, 112, 105),
    ];
    const fsm = createNukidaFsm(
      config(adapterAt({ 14: { ...cleanBull, setups: [setupA(), setupB()] } })),
    );
    const ready = runThrough(candles, fsm).filter(
      (event) => event.state === 'TRADE_PLAN_READY' && event.index === 15,
    );

    expect(ready.map((event) => event.setupFamily).sort()).toEqual([
      'A_COMPRESSION_BREAKOUT',
      'B_BREAK_PULLBACK_FAILURE',
    ]);
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
