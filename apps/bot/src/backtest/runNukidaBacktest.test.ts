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

function m15(index: number, low = 95, high = 105, close = 100): Candle {
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

describe('runNukidaBacktest', () => {
  it('wires a ready FSM trade through M1 execution, costs, reason trace, and both reports', () => {
    const signal = setupA();
    const candles = [
      ...Array.from({ length: 15 }, (_, index) => m15(index)),
      m15(15, 100, 105, 103),
      m15(16, 98, 101, 100),
    ];
    const firstTouchFillTimestamp = candles[16].openTime + 60_000;
    const result = runNukidaBacktest({
      coins: [
        {
          coin: 'TESTUSDT',
          m15Candles: candles,
          m1Candles: [m1(firstTouchFillTimestamp, 95, 120)],
          fsmConfig: {
            tickSize: 1,
            lotSize: 1,
            riskBudgetUsd: 20,
            leverage: 10,
            takeProfitRMultiple: 1.5,
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
      signalTime: candles[15].openTime,
      orderActiveTime: candles[15].openTime,
      firstTouchFillTimestamp,
      firstTouchFillPrice: 99,
      entryFillTimestamp: firstTouchFillTimestamp - 1,
      minutesSignalToFill: 16,
      MFE: 2.1,
      MAE: 0.4,
      postStopHorizons: {
        min15: { reached1_5R: false, reached2R: false, mfeR: 0 },
        min30: { reached1_5R: false, reached2R: false, mfeR: 0 },
        min60: { reached1_5R: false, reached2R: false, mfeR: 0 },
        min120: { reached1_5R: false, reached2R: false, mfeR: 0 },
        min240: { reached1_5R: false, reached2R: false, mfeR: 0 },
      },
      reasonTrace: signal.reasonTrace,
      execution: { outcome: 'WIN', exitPrice: 114, m1CandlesConsumed: 1 },
    });
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
    const candles = [
      ...Array.from({ length: 15 }, (_, index) => m15(index)),
      m15(15, 100, 105, 103),
      m15(16, 98, 101, 100),
    ];
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

  it('prices an ambiguous TP-first case as maker and SL-first case as taker', () => {
    const signal = setupA();
    const candles = [
      ...Array.from({ length: 15 }, (_, index) => m15(index)),
      m15(15, 100, 105, 103),
      m15(16, 98, 101, 100),
    ];
    const firstTouchFillTimestamp = candles[16].openTime + 60_000;
    const result = runNukidaBacktest({
      coins: [
        {
          coin: 'TESTUSDT',
          m15Candles: candles,
          m1Candles: [m1(firstTouchFillTimestamp, 88, 120)],
          fsmConfig: {
            tickSize: 1,
            lotSize: 1,
            riskBudgetUsd: 20,
            leverage: 10,
            dataGate: () => ({ accepted: true }),
            strategyAdapter: fixtureAdapter(signal),
          },
        },
      ],
    });

    expect(result.tradeLogs[0].execution.outcome).toBe('AMBIGUOUS');
    expect(result.tradeLogs[0].costs).toMatchObject({
      bestCase: { feeR: 0.00436 },
      worstCase: { feeR: 0.00643 },
    });
  });

  it('returns AMBIGUOUS when the first-touch M1 fill candle contains both SL and TP', () => {
    const signal = setupA();
    const candles = [
      ...Array.from({ length: 15 }, (_, index) => m15(index)),
      m15(15, 100, 105, 103),
      m15(16, 88, 120, 100),
    ];
    const fillM1OpenTime = candles[16].openTime + 60_000;

    const result = runNukidaBacktest({
      coins: [
        {
          coin: 'TESTUSDT',
          m15Candles: candles,
          m1Candles: [m1(fillM1OpenTime, 88, 120)],
          fsmConfig: {
            tickSize: 1,
            lotSize: 1,
            riskBudgetUsd: 20,
            leverage: 10,
            dataGate: () => ({ accepted: true }),
            strategyAdapter: fixtureAdapter(signal),
          },
        },
      ],
    });

    expect(result.tradeLogs[0].execution).toMatchObject({
      outcome: 'AMBIGUOUS',
      exitTimestamp: fillM1OpenTime,
      m1CandlesConsumed: 1,
    });
  });

  it('observes an exit a few M1 candles after fill inside the same M15 candle', () => {
    const signal = setupA();
    const candles = [
      ...Array.from({ length: 15 }, (_, index) => m15(index)),
      m15(15, 100, 105, 103),
      m15(16, 98, 120, 100),
    ];
    const fillM1OpenTime = candles[16].openTime + 60_000;

    const result = runNukidaBacktest({
      coins: [
        {
          coin: 'TESTUSDT',
          m15Candles: candles,
          m1Candles: [
            m1(fillM1OpenTime, 98, 101),
            m1(fillM1OpenTime + 60_000, 96, 105),
            m1(fillM1OpenTime + 120_000, 95, 120),
          ],
          fsmConfig: {
            tickSize: 1,
            lotSize: 1,
            riskBudgetUsd: 20,
            leverage: 10,
            takeProfitRMultiple: 1.5,
            dataGate: () => ({ accepted: true }),
            strategyAdapter: fixtureAdapter(signal),
          },
        },
      ],
    });

    expect(result.tradeLogs[0].execution).toMatchObject({
      outcome: 'WIN',
      exitTimestamp: fillM1OpenTime + 120_000,
      exitPrice: 114,
      m1CandlesConsumed: 3,
    });
  });

  it('attributes a 1.5R recovery at minute 20 to min30 but not min15', () => {
    const signal = setupA();
    const candles = [
      ...Array.from({ length: 15 }, (_, index) => m15(index)),
      m15(15, 100, 105, 103),
      m15(16, 88, 101, 90),
    ];
    const fillM1OpenTime = candles[16].openTime + 60_000;

    const result = runNukidaBacktest({
      coins: [
        {
          coin: 'TESTUSDT',
          m15Candles: candles,
          m1Candles: [
            m1(fillM1OpenTime, 88, 101),
            m1(fillM1OpenTime + 20 * 60_000, 98, 114),
          ],
          fsmConfig: {
            tickSize: 1,
            lotSize: 1,
            riskBudgetUsd: 20,
            leverage: 10,
            dataGate: () => ({ accepted: true }),
            strategyAdapter: fixtureAdapter(signal),
          },
        },
      ],
    });

    expect(result.tradeLogs[0]).toMatchObject({
      execution: { outcome: 'LOSS', exitTimestamp: fillM1OpenTime },
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
    const candles = [
      ...Array.from({ length: 15 }, (_, index) => m15(index)),
      m15(15, 100, 105, 103),
      m15(16, 88, 101, 90),
    ];
    const fillM1OpenTime = candles[16].openTime + 60_000;

    const result = runNukidaBacktest({
      coins: [
        {
          coin: 'TESTUSDT',
          m15Candles: candles,
          m1Candles: [
            m1(fillM1OpenTime, 88, 101),
            m1(fillM1OpenTime + 300 * 60_000, 98, 120),
          ],
          fsmConfig: {
            tickSize: 1,
            lotSize: 1,
            riskBudgetUsd: 20,
            leverage: 10,
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

  it('orders drawdown by exit time and keeps AMBIGUOUS/OPEN outside PF and expectancy', () => {
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
        execution: { outcome: 'WIN', exitTimestamp: 200, exitPrice: 120, m1CandlesConsumed: 2 },
        costs: cost(2, 1.8),
      },
      {
        ...base,
        execution: { outcome: 'LOSS', exitTimestamp: 100, exitPrice: 90, m1CandlesConsumed: 1 },
        costs: cost(-1, -1.1),
      },
      {
        ...base,
        execution: {
          outcome: 'AMBIGUOUS',
          exitTimestamp: 300,
          bestCase: { outcome: 'WIN', exitPrice: 120 },
          worstCase: { outcome: 'LOSS', exitPrice: 90 },
          m1CandlesConsumed: 3,
        },
        costs: { bestCase: cost(2, 1.7), worstCase: cost(-1, -1.2) },
      },
      {
        ...base,
        execution: { outcome: 'OPEN', m1CandlesConsumed: 4 },
        costs: null,
      },
    ];

    const report = buildBacktestReport(logs, ['TESTUSDT']);
    expect(report.overall.zeroCost).toMatchObject({
      closedTrades: 2,
      grossR: 1,
      netR: 1,
      profitFactor: 2,
      expectancyPerTrade: 0.5,
      maxDrawdownR: 1,
      winRate: 0.5,
      ambiguousTrades: 1,
      openTrades: 1,
    });
    expect(report.overall.realisticCost.maxDrawdownR).toBeCloseTo(1.1);
    expect(report.ambiguousScenarios).toEqual({
      count: 1,
      bestCaseGrossR: 2,
      bestCaseNetR: 1.7,
      worstCaseGrossR: -1,
      worstCaseNetR: -1.2,
    });
  });
});
