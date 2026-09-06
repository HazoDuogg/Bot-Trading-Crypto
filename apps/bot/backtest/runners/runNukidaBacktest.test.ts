import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import type { FsmStageEvaluation, NukidaStrategyAdapter } from '../orchestrator/nukidaFsm.js';
import type { SetupSignal } from '../setup/setupDetectorA.js';
import type { ExecutionCostResult } from './costModel.js';
import {
  buildBacktestReport,
  runNukidaBacktest,
  type TradeLogEntry,
} from './runNukidaBacktest.js';

function m15(index: number, low = 97, high = 103, close = 100): Candle {
  return { openTime: index * 900_000, open: 100, high, low, close, volume: 100 };
}

function m1(openTime: number, low: number, high: number): Candle {
  return { openTime, open: 100, high, low, close: 100, volume: 10 };
}

function setupA(): SetupSignal {
  return {
    setupFamily: 'A_COMPRESSION_BREAKOUT',
    direction: 'BULL',
    triggerIndex: 14,
    reasonTrace: {
      quality: { label: 'CLEAN', efficiency: 0.2, sweepCount: 1 },
      dominance: {
        side: 'BULL',
        brokeLevel: 100,
        counterTestFailed: true,
        counterTestIndex: 10,
      },
      d3: { startIndex: 2, endIndex: 9, high: 100, low: 90 },
      d5: { bandwidthAtrRatio: 1.5, isCompressed: true },
      d2: { brokeAt: 14, level: 100 },
      d7: { bodyRatio: 0.7, rangeAtrRatio: 1.2, isStrong: true },
    },
  };
}

function fixtureAdapter(signal: SetupSignal): NukidaStrategyAdapter {
  const clean = signal.reasonTrace.quality;
  const dominance = signal.reasonTrace.dominance;
  return {
    onClosedCandle(_candles, index): FsmStageEvaluation {
      if (index === signal.triggerIndex) {
        return { quality: clean, dominance, setups: [signal] };
      }
      return { quality: null, dominance: null, setups: [] };
    },
  };
}

// The single M1 retest window opens the instant the trigger M15 candle (index 14) closes,
// i.e. at m15(15)'s openTime — the fill must land inside that one 15-minute window now.
const windowStart = m15(15).openTime;

describe('runNukidaBacktest', () => {
  it('wires a ready FSM trade through M1 execution, costs, reason trace, and both reports', () => {
    const signal = setupA();
    const candles = Array.from({ length: 16 }, (_, index) => m15(index));
    const firstTouchFillTimestamp = windowStart + 60_000;
    // entry=99, riskPerUnit=10: candle1 fills and jumps through TP1 (109); candle2 clears TP2 (119).
    const m1Candles = [
      m1(firstTouchFillTimestamp, 95, 120),
      m1(firstTouchFillTimestamp + 60_000, 115, 121),
    ];
    const result = runNukidaBacktest({
      coins: [
        {
          coin: 'TESTUSDT',
          m15Candles: candles,
          m1Candles,
          fsmConfig: {
            tickSize: 1,
            lotSize: 1,
            riskBudgetUsd: 20,
            leverage: 10,
            takeProfitRMultiple: 1.5,
            m1Candles,
            dataGate: () => ({ accepted: true }),
            strategyAdapter: fixtureAdapter(signal),
          },
        },
      ],
    });

    expect(result.warning).toContain('IN-SAMPLE');
    expect(result.tradeLogs).toHaveLength(1);
    expect(result.tradeLogs[0]).toMatchObject({
      coin: 'TESTUSDT',
      setupFamily: 'A_COMPRESSION_BREAKOUT',
      signalTime: windowStart,
      orderActiveTime: windowStart,
      firstTouchFillTimestamp,
      firstTouchFillPrice: 99,
      entryFillTimestamp: firstTouchFillTimestamp - 1,
      minutesSignalToFill: 1,
      MFE: 2.2,
      MAE: 0.4,
      postStopHorizons: {
        min15: { reached1_5R: false, reached2R: false, mfeR: 0 },
        min30: { reached1_5R: false, reached2R: false, mfeR: 0 },
        min60: { reached1_5R: false, reached2R: false, mfeR: 0 },
        min120: { reached1_5R: false, reached2R: false, mfeR: 0 },
        min240: { reached1_5R: false, reached2R: false, mfeR: 0 },
      },
      reasonTrace: signal.reasonTrace,
      execution: { outcome: 'TAKE_PROFIT_2', m1CandlesConsumed: 2 },
    });
    expect(result.tradeLogs[0].reasonCode).toBeUndefined();
    expect(result.tradeLogs[0].costR).toBeGreaterThan(0);
    expect(result.tradeLogs[0].costs).not.toBeNull();
    expect(result.report.overall.zeroCost).toMatchObject({
      closedTrades: 1,
      grossR: 1.5,
      netR: 1.5,
      profitFactor: null,
      expectancyPerTrade: 1.5,
      maxDrawdownR: 0,
      winRate: 1,
      ambiguousTrades: 0,
      openTrades: 0,
    });
    expect(result.report.overall.realisticCost.netR).toBeLessThan(1.5);
    expect(result.report.byCoin.TESTUSDT).toBeDefined();
    expect(result.report.bySetupFamily.A_COMPRESSION_BREAKOUT).toBeDefined();
    expect(result.report.byDirection.BULL).toBeDefined();
  });

  it('counts minimum-stop rejections separately without creating a trade log', () => {
    const signal = setupA();
    signal.reasonTrace.d3!.low = 98;
    const candles = Array.from({ length: 16 }, (_, index) => m15(index));
    const m1Candles = [m1(windowStart + 60_000, 98, 101)];
    const result = runNukidaBacktest({
      coins: [
        {
          coin: 'TESTUSDT',
          m15Candles: candles,
          m1Candles: [],
          fsmConfig: {
            tickSize: 1,
            lotSize: 1,
            riskBudgetUsd: 20,
            leverage: 10,
            m1Candles,
            dataGate: () => ({ accepted: true }),
            strategyAdapter: fixtureAdapter(signal),
          },
        },
      ],
    });

    expect(result.tradeLogs).toHaveLength(0);
    expect(result.report.minimumStopDistanceBlocked).toEqual({
      total: 1,
      byCoin: { TESTUSDT: 1 },
    });
  });

  it('prices a same-candle SL/TP1 collision as a forced taker stop-loss', () => {
    const signal = setupA();
    const candles = Array.from({ length: 16 }, (_, index) => m15(index));
    const firstTouchFillTimestamp = windowStart + 60_000;
    // entry=99, stopLoss=89, TP1=109: this candle's range covers both -> forced loss at 89.
    const m1Candles = [m1(firstTouchFillTimestamp, 88, 120)];
    const result = runNukidaBacktest({
      coins: [
        {
          coin: 'TESTUSDT',
          m15Candles: candles,
          m1Candles,
          fsmConfig: {
            tickSize: 1,
            lotSize: 1,
            riskBudgetUsd: 20,
            leverage: 10,
            m1Candles,
            dataGate: () => ({ accepted: true }),
            strategyAdapter: fixtureAdapter(signal),
          },
        },
      ],
    });

    expect(result.tradeLogs[0].execution.outcome).toBe('INITIAL_STOP');
    expect(result.tradeLogs[0].reasonCode).toBe('AMBIGUOUS_FORCED_LOSS');
    // Forced loss always exits via STOP_LOSS (taker) pricing, never the maker TAKE_PROFIT rate.
    expect(result.tradeLogs[0].costs).toMatchObject({ feeR: expect.closeTo(0.005787, 9) });
  });

  it('returns AMBIGUOUS_FORCED_LOSS when the first-touch M1 fill candle contains both SL and TP1', () => {
    const signal = setupA();
    const candles = Array.from({ length: 16 }, (_, index) => m15(index));
    const fillM1OpenTime = windowStart + 60_000;
    const m1Candles = [m1(fillM1OpenTime, 88, 120)];

    const result = runNukidaBacktest({
      coins: [
        {
          coin: 'TESTUSDT',
          m15Candles: candles,
          m1Candles,
          fsmConfig: {
            tickSize: 1,
            lotSize: 1,
            riskBudgetUsd: 20,
            leverage: 10,
            m1Candles,
            dataGate: () => ({ accepted: true }),
            strategyAdapter: fixtureAdapter(signal),
          },
        },
      ],
    });

    expect(result.tradeLogs[0].execution).toMatchObject({
      outcome: 'INITIAL_STOP',
      m1CandlesConsumed: 1,
      exitLegs: [
        {
          reason: 'INITIAL_STOP',
          fraction: 1,
          exitPrice: 89,
          exitTimestamp: fillM1OpenTime,
          reasonCode: 'AMBIGUOUS_FORCED_LOSS',
        },
      ],
    });
    expect(result.tradeLogs[0].reasonCode).toBe('AMBIGUOUS_FORCED_LOSS');
  });

  it('observes an exit a few M1 candles after fill inside the same M15 candle', () => {
    const signal = setupA();
    const candles = Array.from({ length: 16 }, (_, index) => m15(index));
    const fillM1OpenTime = windowStart + 60_000;
    // entry=99, stopLoss=89: first two candles touch neither the stop nor TP1 (109); the third
    // finally touches the original stop alone (no TP1 collision) -> clean single-leg loss.
    const m1Candles = [
      m1(fillM1OpenTime, 98, 101),
      m1(fillM1OpenTime + 60_000, 96, 105),
      m1(fillM1OpenTime + 120_000, 85, 95),
    ];

    const result = runNukidaBacktest({
      coins: [
        {
          coin: 'TESTUSDT',
          m15Candles: candles,
          m1Candles,
          fsmConfig: {
            tickSize: 1,
            lotSize: 1,
            riskBudgetUsd: 20,
            leverage: 10,
            takeProfitRMultiple: 1.5,
            m1Candles,
            dataGate: () => ({ accepted: true }),
            strategyAdapter: fixtureAdapter(signal),
          },
        },
      ],
    });

    expect(result.tradeLogs[0].execution).toMatchObject({
      outcome: 'INITIAL_STOP',
      m1CandlesConsumed: 3,
      exitLegs: [{ fraction: 1, exitPrice: 89, exitTimestamp: fillM1OpenTime + 120_000 }],
    });
    expect(result.tradeLogs[0].reasonCode).toBeUndefined();
  });

  it('attributes a 1.5R recovery at minute 20 to min30 but not min15', () => {
    const signal = setupA();
    const candles = Array.from({ length: 16 }, (_, index) => m15(index));
    const fillM1OpenTime = windowStart + 60_000;
    const m1Candles = [m1(fillM1OpenTime, 88, 101), m1(fillM1OpenTime + 20 * 60_000, 98, 114)];

    const result = runNukidaBacktest({
      coins: [
        {
          coin: 'TESTUSDT',
          m15Candles: candles,
          m1Candles,
          fsmConfig: {
            tickSize: 1,
            lotSize: 1,
            riskBudgetUsd: 20,
            leverage: 10,
            m1Candles,
            dataGate: () => ({ accepted: true }),
            strategyAdapter: fixtureAdapter(signal),
          },
        },
      ],
    });

    expect(result.tradeLogs[0]).toMatchObject({
      execution: { outcome: 'INITIAL_STOP', exitLegs: [{ exitTimestamp: fillM1OpenTime }] },
      postStopHorizons: {
        min15: { reached1_5R: false, reached2R: false, mfeR: 0 },
        min30: { reached1_5R: true, reached2R: false, mfeR: 1.5 },
        min60: { reached1_5R: true, reached2R: false, mfeR: 1.5 },
        min120: { reached1_5R: true, reached2R: false, mfeR: 1.5 },
        min240: { reached1_5R: true, reached2R: false, mfeR: 1.5 },
      },
    });
  });

  it('does not attribute a recovery after minute 300 to any bounded horizon', () => {
    const signal = setupA();
    const candles = Array.from({ length: 16 }, (_, index) => m15(index));
    const fillM1OpenTime = windowStart + 60_000;
    const m1Candles = [m1(fillM1OpenTime, 88, 101), m1(fillM1OpenTime + 300 * 60_000, 98, 120)];

    const result = runNukidaBacktest({
      coins: [
        {
          coin: 'TESTUSDT',
          m15Candles: candles,
          m1Candles,
          fsmConfig: {
            tickSize: 1,
            lotSize: 1,
            riskBudgetUsd: 20,
            leverage: 10,
            m1Candles,
            dataGate: () => ({ accepted: true }),
            strategyAdapter: fixtureAdapter(signal),
          },
        },
      ],
    });

    expect(result.tradeLogs[0].postStopHorizons).toEqual({
      min15: { reached1_5R: false, reached2R: false, mfeR: 0 },
      min30: { reached1_5R: false, reached2R: false, mfeR: 0 },
      min60: { reached1_5R: false, reached2R: false, mfeR: 0 },
      min120: { reached1_5R: false, reached2R: false, mfeR: 0 },
      min240: { reached1_5R: false, reached2R: false, mfeR: 0 },
    });
  });

  it('orders drawdown by exit time, counts a forced-loss trade normally, and keeps OPEN outside PF/expectancy', () => {
    const signal = setupA();
    const plan = {
      direction: 'BULL' as const,
      entryPrice: 100,
      stopLoss: 90,
      takeProfit: 120,
      riskPerUnit: 10,
      positionSize: 1,
      requiredMargin: 10,
    };
    const cost = (grossR: number, netR: number): ExecutionCostResult => ({
      grossR,
      feeR: 0.1,
      spreadR: Math.max(0, grossR - netR - 0.2),
      slippageR: 0.1,
      netR,
    });
    const base = {
      coin: 'TESTUSDT',
      setupFamily: signal.setupFamily,
      signalTime: 0,
      orderActiveTime: 0,
      firstTouchFillTimestamp: 1,
      firstTouchFillPrice: 100,
      minutesSignalToFill: 1 / 60_000,
      entryFillTimestamp: 0,
      tradePlan: plan,
      reasonTrace: signal.reasonTrace,
      MFE: 0,
      MAE: 0,
      costR: 0,
      postStopHorizons: {
        min15: { reached1_5R: false, reached2R: false, mfeR: 0 },
        min30: { reached1_5R: false, reached2R: false, mfeR: 0 },
        min60: { reached1_5R: false, reached2R: false, mfeR: 0 },
        min120: { reached1_5R: false, reached2R: false, mfeR: 0 },
        min240: { reached1_5R: false, reached2R: false, mfeR: 0 },
      },
    };
    const logs: TradeLogEntry[] = [
      {
        ...base,
        execution: {
          outcome: 'TAKE_PROFIT_2',
          exitLegs: [{ reason: 'TAKE_PROFIT_2', fraction: 1, exitPrice: 120, exitTimestamp: 200 }],
          grossR: 2,
          partialExitTriggered: false,
          m1CandlesConsumed: 2,
        },
        costs: cost(2, 1.8),
      },
      {
        ...base,
        execution: {
          outcome: 'INITIAL_STOP',
          exitLegs: [{ reason: 'INITIAL_STOP', fraction: 1, exitPrice: 90, exitTimestamp: 100 }],
          grossR: -1,
          partialExitTriggered: false,
          m1CandlesConsumed: 1,
        },
        costs: cost(-1, -1.1),
      },
      {
        ...base,
        // Same-candle SL/TP1 collision: forced to the loss side, but still a real, priced, closed trade.
        execution: {
          outcome: 'INITIAL_STOP',
          exitLegs: [
            {
              reason: 'INITIAL_STOP',
              fraction: 1,
              exitPrice: 90,
              exitTimestamp: 300,
              reasonCode: 'AMBIGUOUS_FORCED_LOSS',
            },
          ],
          grossR: -1,
          partialExitTriggered: false,
          m1CandlesConsumed: 3,
        },
        costs: cost(-1, -1.2),
        reasonCode: 'AMBIGUOUS_FORCED_LOSS',
      },
      {
        ...base,
        execution: {
          outcome: 'OPEN_DATA_END',
          exitLegs: [],
          grossR: 0,
          partialExitTriggered: false,
          m1CandlesConsumed: 4,
        },
        costs: null,
      },
    ];

    const report = buildBacktestReport(logs, ['TESTUSDT']);
    expect(report.overall.zeroCost).toMatchObject({
      closedTrades: 3,
      grossR: 0,
      netR: 0,
      profitFactor: 1,
      expectancyPerTrade: 0,
      maxDrawdownR: 1,
      winRate: expect.closeTo(1 / 3, 9),
      ambiguousTrades: 1,
      openTrades: 1,
    });
    expect(report.overall.realisticCost.maxDrawdownR).toBeCloseTo(1.2);
  });
});
