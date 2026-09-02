import { M15_CANDLE_DURATION_MS } from '../backtest/intrabarExecution.js';
import { evaluateM1RetestWindow, type M1RetestWindowResult } from '../entry/retestEntry.js';
import { createAtrTracker } from '../noTradeZone/atr.js';
import type { Candle } from '../noTradeZone/types.js';
import { createTradePlan, type TradePlan } from '../risk/tradePlan.js';
import { detectSetupA, type SetupSignal } from '../setup/setupDetectorA.js';
import { detectBaseZones, type BaseZone } from '../structure/baseZone.js';
import {
  D2_BREAK_V1_ATR_PERIOD,
  D6_COUNTER_TEST_WINDOW,
  D6_RECLAIM_WINDOW,
  evaluateDominance,
  isMeaningfulBreakAtClose,
  type BreakResult,
  type DominanceEvidence,
} from '../structure/breakDetector.js';
import {
  evaluateBreakoutStrength,
  type BreakoutStrengthResult,
} from '../structure/breakoutStrength.js';
import { detectCompression, type CompressionResult } from '../structure/compression.js';
import { evaluateEmaTrendH1 } from '../structure/emaTrendFilterH1.js';
import { evaluateQuality, type QualityComposite } from '../structure/quality.js';
import {
  D1_SWING_V1_SIDE_CANDLES,
  D1_SWING_V1_WINDOW,
  detectSwingPoints,
  type SwingPoint,
} from '../structure/swingPoints.js';

export interface FsmState {
  pendingSetups: SetupSignal[];
}

export interface FsmEvent {
  index: number;
  state:
    | 'REJECTED'
    | 'SETUP_DETECTED'
    | 'ENTRY_PENDING'
    | 'TRADE_PLAN_READY'
    | 'TRADE_PLAN_REJECTED'
    | 'ENTRY_EXPIRED'
    | 'ENTRY_CANCELLED';
  reasonCode?: string;
  setupFamily?: SetupSignal['setupFamily'];
  setupSignal?: SetupSignal;
  tradePlan?: TradePlan;
  // TICKET-039: the fill that produced tradePlan, so callers don't need a separate M1 lookup.
  entry?: Extract<M1RetestWindowResult, { status: 'FILLED' }>;
}

export interface FsmStageEvaluation {
  quality: QualityComposite | null;
  dominance: DominanceEvidence | null;
  setups: SetupSignal[];
}

export interface NukidaStrategyAdapter {
  onClosedCandle(candles: readonly Candle[], index: number): FsmStageEvaluation;
}

export interface FsmDataGateResult {
  accepted: boolean;
  reasonCode?: string;
}

export interface FsmConfig {
  tickSize: number;
  lotSize: number;
  riskBudgetUsd: number;
  leverage: number;
  takeProfitRMultiple?: number;
  availableCapitalUsd?: number;
  // TICKET-038: BTC trend alignment gate. Omitted keeps current (ungated) behavior exactly.
  btcM15Candles?: readonly Candle[];
  // TICKET-039: core retest-fill mechanism now runs on M1 candles, not optional like btcM15Candles.
  m1Candles: readonly Candle[];
  dataGate: (candles: readonly Candle[], index: number) => FsmDataGateResult;
  strategyAdapter?: NukidaStrategyAdapter;
}

interface ActiveSwing extends SwingPoint {
  eligibleFrom: number;
  broken: boolean;
}

interface PendingDominance {
  breakout: BreakResult;
  breakoutStrength: BreakoutStrengthResult;
}

interface TimedDominance {
  confirmedAt: number;
  evidence: DominanceEvidence;
}

interface TrackedBase {
  zone: BaseZone;
  compression: CompressionResult;
  upBroken: boolean;
  downBroken: boolean;
}

function breakAtCurrent(
  candle: Candle,
  index: number,
  level: number,
  direction: BreakResult['direction'],
  priorAtr: number | null,
): BreakResult | null {
  if (priorAtr === null) return null;
  return isMeaningfulBreakAtClose(candle.close, level, direction, priorAtr)
    ? { brokeAt: index, direction, level }
    : null;
}

function findBtcIndexByOpenTime(btcCandles: readonly Candle[], openTime: number): number | null {
  let left = 0;
  let right = btcCandles.length - 1;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    if (btcCandles[middle].openTime === openTime) return middle;
    if (btcCandles[middle].openTime < openTime) left = middle + 1;
    else right = middle - 1;
  }
  return null;
}

// TICKET-038: BTC trend alignment gate. Undefined btcM15Candles means no gate (fail-open to
// current behavior); a missing timestamp match or unresolved EMA fails closed (no trade).
function isBtcTrendAligned(
  btcM15Candles: readonly Candle[] | undefined,
  current: Candle,
  setup: SetupSignal,
): boolean {
  if (btcM15Candles === undefined) return true;
  const matchedIndex = findBtcIndexByOpenTime(btcM15Candles, current.openTime);
  if (matchedIndex === null) return false;
  const result = evaluateEmaTrendH1(btcM15Candles, matchedIndex);
  if (result === null) return false;
  return setup.direction === 'BULL' ? result.aboveEma : !result.aboveEma;
}

export function createDefaultStrategyAdapter(options?: {
  btcM15Candles?: readonly Candle[];
}): NukidaStrategyAdapter {
  const atrTracker = createAtrTracker(D2_BREAK_V1_ATR_PERIOD);
  let priorAtr: number | null = null;
  let activeHigh: ActiveSwing | null = null;
  let activeLow: ActiveSwing | null = null;
  let baseSearchFloor = 0;
  const pendingDominance: PendingDominance[] = [];
  const dominanceTimeline: TimedDominance[] = [];
  const trackedBases: TrackedBase[] = [];

  return {
    onClosedCandle(candles, index) {
      const current = candles[index];
      for (const active of [activeHigh, activeLow]) {
        if (active === null || active.broken || index < active.eligibleFrom) continue;
        const direction = active.type === 'high' ? 'up' : 'down';
        const breakout = breakAtCurrent(current, index, active.price, direction, priorAtr);
        if (breakout !== null && priorAtr !== null) {
          active.broken = true;
          pendingDominance.push({
            breakout,
            breakoutStrength: evaluateBreakoutStrength(current, priorAtr),
          });
        }
      }

      if (index >= D1_SWING_V1_WINDOW - 1) {
        const windowStart = index - D1_SWING_V1_WINDOW + 1;
        const swings = detectSwingPoints(candles.slice(windowStart, index + 1));
        for (const swing of swings) {
          const globalSwing: ActiveSwing = {
            ...swing,
            index: windowStart + swing.index,
            eligibleFrom: windowStart + swing.index + D1_SWING_V1_SIDE_CANDLES + 1,
            broken: false,
          };
          if (swing.type === 'high') activeHigh = globalSwing;
          else activeLow = globalSwing;
        }
      }

      const baseSlice = candles.slice(baseSearchFloor, index + 1);
      const newLocalZone = detectBaseZones(baseSlice).at(-1);
      if (newLocalZone !== undefined && newLocalZone.end_index === baseSlice.length - 2) {
        const zone: BaseZone = {
          start_index: baseSearchFloor + newLocalZone.start_index,
          end_index: baseSearchFloor + newLocalZone.end_index,
          high: newLocalZone.high,
          low: newLocalZone.low,
        };
        baseSearchFloor = index;
        if (zone.end_index - zone.start_index + 1 >= 8) {
          const compression = detectCompression(candles, zone.end_index);
          if (compression !== null && compression.isCompressed) {
            trackedBases.push({ zone, compression, upBroken: false, downBroken: false });
          }
        }
      }

      const baseBreaks: Array<{
        tracked: TrackedBase;
        breakout: BreakResult;
        breakoutStrength: BreakoutStrengthResult;
      }> = [];
      for (const tracked of trackedBases) {
        if (!tracked.upBroken && index > tracked.zone.end_index) {
          const breakout = breakAtCurrent(current, index, tracked.zone.high, 'up', priorAtr);
          if (breakout !== null && priorAtr !== null) {
            tracked.upBroken = true;
            baseBreaks.push({
              tracked,
              breakout,
              breakoutStrength: evaluateBreakoutStrength(current, priorAtr),
            });
          }
        }
        if (!tracked.downBroken && index > tracked.zone.end_index) {
          const breakout = breakAtCurrent(current, index, tracked.zone.low, 'down', priorAtr);
          if (breakout !== null && priorAtr !== null) {
            tracked.downBroken = true;
            baseBreaks.push({
              tracked,
              breakout,
              breakoutStrength: evaluateBreakoutStrength(current, priorAtr),
            });
          }
        }
      }

      const newlyConfirmed: Array<{
        breakout: BreakResult;
        breakoutStrength: BreakoutStrengthResult;
        evidence: DominanceEvidence;
      }> = [];
      for (let pendingIndex = pendingDominance.length - 1; pendingIndex >= 0; pendingIndex -= 1) {
        const pending = pendingDominance[pendingIndex];
        const evidence = evaluateDominance(candles, pending.breakout);
        const counterComplete =
          evidence.counterTestIndex !== null &&
          index >= evidence.counterTestIndex + D6_RECLAIM_WINDOW;
        const searchComplete =
          evidence.counterTestIndex === null &&
          index >= pending.breakout.brokeAt + D6_COUNTER_TEST_WINDOW;
        if (evidence.side !== 'NEUTRAL') {
          dominanceTimeline.push({ confirmedAt: index, evidence });
          newlyConfirmed.push({
            breakout: pending.breakout,
            breakoutStrength: pending.breakoutStrength,
            evidence,
          });
        }
        if (evidence.side !== 'NEUTRAL' || counterComplete || searchComplete) {
          pendingDominance.splice(pendingIndex, 1);
        }
      }

      const quality = evaluateQuality(candles, index);
      const dominance = dominanceTimeline.at(-1)?.evidence ?? null;
      const setups: SetupSignal[] = [];
      if (quality?.label === 'CLEAN' && dominance !== null) {
        for (const candidate of baseBreaks) {
          const setup = detectSetupA({
            baseZone: candidate.tracked.zone,
            quality,
            compression: candidate.tracked.compression,
            dominance,
            breakout: candidate.breakout,
            breakoutStrength: candidate.breakoutStrength,
          });
          if (setup !== null && isBtcTrendAligned(options?.btcM15Candles, current, setup)) {
            setups.push(setup);
          }
        }
      }

      priorAtr = atrTracker.next(current);
      const stageDominance = newlyConfirmed.at(-1)?.evidence ?? dominance;
      return { quality, dominance: stageDominance, setups };
    },
  };
}

// TICKET-039: window is now exactly 1 M15 candle wide (was RETEST_ENTRY_EXPIRY_CANDLES=8),
// so only the very next step may legitimately still be missing M1 data for it.
function isIncompleteEntryWindow(error: unknown, index: number, signal: SetupSignal): boolean {
  return (
    error instanceof Error &&
    error.message === 'm1Candles must cover the full 15-minute retest window before it can be evaluated' &&
    index < signal.triggerIndex + 2
  );
}

export function createNukidaFsm(config: FsmConfig): {
  onClosedCandle(candles: readonly Candle[], index: number): FsmEvent[];
} {
  const strategy =
    config.strategyAdapter ?? createDefaultStrategyAdapter({ btcM15Candles: config.btcM15Candles });
  const entryAtrTracker = createAtrTracker(D2_BREAK_V1_ATR_PERIOD);
  const state: FsmState = { pendingSetups: [] };
  const frozenAtrBySetup = new Map<SetupSignal, number>();
  let expectedIndex = 0;

  return {
    onClosedCandle(candles, index) {
      if (index !== expectedIndex) {
        throw new Error(`onClosedCandle must be sequential; expected index ${expectedIndex}`);
      }
      if (!Number.isSafeInteger(index) || index < 0 || index >= candles.length) {
        throw new Error('index must reference an available candle');
      }
      const visibleCandles = candles.slice(0, index + 1);
      expectedIndex += 1;
      const gate = config.dataGate(visibleCandles, index);
      if (!gate.accepted) {
        return [
          {
            index,
            state: 'REJECTED',
            reasonCode: gate.reasonCode ?? 'DATA_GATE_REJECTED',
          },
        ];
      }

      const triggerAtr = entryAtrTracker.next(visibleCandles[index]);
      const events: FsmEvent[] = [];
      const stillPending: SetupSignal[] = [];
      for (const signal of state.pendingSetups) {
        const frozenAtrAtTrigger = frozenAtrBySetup.get(signal);
        if (frozenAtrAtTrigger === undefined) throw new Error('Pending setup is missing frozen ATR');
        try {
          const windowStartTimestamp =
            visibleCandles[signal.triggerIndex].openTime + M15_CANDLE_DURATION_MS;
          const entry = evaluateM1RetestWindow({
            signal,
            m1Candles: config.m1Candles,
            windowStartTimestamp,
            frozenAtrAtTrigger,
            tickSize: config.tickSize,
          });
          if (entry.status === 'FILLED') {
            const tradePlan = createTradePlan({
              signal,
              entry,
              closedCandles: visibleCandles,
              tickSize: config.tickSize,
              lotSize: config.lotSize,
              riskBudgetUsd: config.riskBudgetUsd,
              leverage: config.leverage,
              frozenAtrAtTrigger,
              takeProfitRMultiple: config.takeProfitRMultiple,
              availableCapitalUsd: config.availableCapitalUsd,
            });
            events.push(
              tradePlan === null
                ? {
                    index,
                    state: 'TRADE_PLAN_REJECTED',
                    reasonCode: 'MIN_STOP_DISTANCE',
                    setupFamily: signal.setupFamily,
                    setupSignal: signal,
                  }
                : {
                    index,
                    state: 'TRADE_PLAN_READY',
                    setupFamily: signal.setupFamily,
                    setupSignal: signal,
                    tradePlan,
                    entry,
                  },
            );
          } else if (entry.status === 'EXPIRED_15M') {
            events.push({
              index,
              state: 'ENTRY_EXPIRED',
              reasonCode: 'ENTRY_EXPIRED',
              setupFamily: signal.setupFamily,
            });
          } else {
            events.push({
              index,
              state: 'ENTRY_CANCELLED',
              reasonCode: 'ENTRY_CANCELLED_OVER_EXTENDED',
              setupFamily: signal.setupFamily,
            });
          }
          frozenAtrBySetup.delete(signal);
        } catch (error) {
          if (!isIncompleteEntryWindow(error, index, signal)) throw error;
          stillPending.push(signal);
          events.push({
            index,
            state: 'ENTRY_PENDING',
            setupFamily: signal.setupFamily,
          });
        }
      }
      state.pendingSetups = stillPending;

      const stage = strategy.onClosedCandle(visibleCandles, index);
      if (stage.quality?.label !== 'CLEAN') {
        events.push({ index, state: 'REJECTED', reasonCode: 'QUALITY_NOT_CLEAN' });
        return events;
      }
      if (stage.dominance === null || stage.dominance.side === 'NEUTRAL') {
        events.push({ index, state: 'REJECTED', reasonCode: 'DOMINANCE_NEUTRAL' });
        return events;
      }
      if (stage.setups.length === 0) {
        events.push({ index, state: 'REJECTED', reasonCode: 'NO_SETUP' });
        return events;
      }
      if (triggerAtr === null) throw new Error('Setup detected before ATR14 was available');
      for (const signal of stage.setups) {
        if (signal.triggerIndex !== index) {
          throw new Error('Strategy adapter must emit setups at their triggerIndex');
        }
        state.pendingSetups.push(signal);
        frozenAtrBySetup.set(signal, triggerAtr);
        events.push({
          index,
          state: 'SETUP_DETECTED',
          setupFamily: signal.setupFamily,
        });
      }
      return events;
    },
  };
}
