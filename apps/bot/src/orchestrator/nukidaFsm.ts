import {
  RETEST_ENTRY_EXPIRY_CANDLES,
  evaluateRetestEntry,
} from '../entry/retestEntry.js';
import { createAtrTracker } from '../noTradeZone/atr.js';
import type { Candle } from '../noTradeZone/types.js';
import { createTradePlan, type TradePlan } from '../risk/tradePlan.js';
import { detectSetupA, type SetupSignal } from '../setup/setupDetectorA.js';
import { detectSetupB } from '../setup/setupDetectorB.js';
import { detectBaseZones, type BaseZone } from '../structure/baseZone.js';
import {
  D2_BREAK_V1_ATR_PERIOD,
  D6_COUNTER_TEST_WINDOW,
  D6_DEFAULT_MINIMUM_TEST_OCCURRENCE,
  D6_RECLAIM_WINDOW,
  D6_SECOND_TEST_COUNTER_WINDOW,
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
  setupBSlBufferAtrMultiple?: number;
  minimumTestOccurrence?: number;
  availableCapitalUsd?: number;
  // Class D — EXPERIMENTAL (TICKET-028): gates Setup B on the confirmation-candle filter
  // (structure/rejectionCandle.ts) and switches its SL to the confirmation candle's own
  // extreme. Default false preserves the exact current (source-backed) D1-D8 behavior.
  setupBConfirmationCandle?: boolean;
  // TICKET-031: which setup families may produce a trade plan. Default (both) preserves the
  // exact current behavior. A family left out here is simply dropped right after detection —
  // no trade plan is ever built for it, and the other family's detection/entry/SL/TP is
  // completely untouched. Does not affect the D1-D8/setupB fingerprint (that hashes the
  // structural rule constants, not which families are switched on for a given run).
  enabledSetupFamilies?: readonly SetupSignal['setupFamily'][];
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

export function createDefaultStrategyAdapter(
  config: Pick<FsmConfig, 'minimumTestOccurrence' | 'setupBConfirmationCandle'>,
): NukidaStrategyAdapter {
  const atrTracker = createAtrTracker(D2_BREAK_V1_ATR_PERIOD);
  let priorAtr: number | null = null;
  let activeHigh: ActiveSwing | null = null;
  let activeLow: ActiveSwing | null = null;
  let baseSearchFloor = 0;
  const pendingDominance: PendingDominance[] = [];
  const pendingSetupBDominance: PendingDominance[] = [];
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
          if (
            (config.minimumTestOccurrence ?? D6_DEFAULT_MINIMUM_TEST_OCCURRENCE) >
            D6_DEFAULT_MINIMUM_TEST_OCCURRENCE
          ) {
            pendingSetupBDominance.push({
              breakout,
              breakoutStrength: evaluateBreakoutStrength(current, priorAtr),
            });
          }
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

      const setupBConfirmed =
        (config.minimumTestOccurrence ?? D6_DEFAULT_MINIMUM_TEST_OCCURRENCE) ===
        D6_DEFAULT_MINIMUM_TEST_OCCURRENCE
          ? newlyConfirmed
          : [];
      if (
        (config.minimumTestOccurrence ?? D6_DEFAULT_MINIMUM_TEST_OCCURRENCE) >
        D6_DEFAULT_MINIMUM_TEST_OCCURRENCE
      ) {
        for (let pendingIndex = pendingSetupBDominance.length - 1; pendingIndex >= 0; pendingIndex -= 1) {
          const pending = pendingSetupBDominance[pendingIndex];
          const evidence = evaluateDominance(candles, pending.breakout, {
            minimumTestOccurrence: config.minimumTestOccurrence,
          });
          if (evidence.side !== 'NEUTRAL') {
            setupBConfirmed.push({
              breakout: pending.breakout,
              breakoutStrength: pending.breakoutStrength,
              evidence,
            });
            pendingSetupBDominance.splice(pendingIndex, 1);
          } else if (
            evidence.counterTestIndex === null &&
            index >= pending.breakout.brokeAt + D6_SECOND_TEST_COUNTER_WINDOW
          ) {
            pendingSetupBDominance.splice(pendingIndex, 1);
          }
        }
      }

      const quality = evaluateQuality(candles, index);
      const dominance = dominanceTimeline.at(-1)?.evidence ?? null;
      const setups: SetupSignal[] = [];
      if (quality?.label === 'CLEAN') {
        for (const confirmed of setupBConfirmed) {
          const setup = detectSetupB({
            closedCandles: candles,
            quality,
            breakout: confirmed.breakout,
            breakoutStrength: confirmed.breakoutStrength,
            minimumTestOccurrence: config.minimumTestOccurrence,
            confirmationCandleEnabled: config.setupBConfirmationCandle,
          });
          if (setup !== null) setups.push(setup);
        }
        if (dominance !== null) {
          for (const candidate of baseBreaks) {
            const setup = detectSetupA({
              baseZone: candidate.tracked.zone,
              quality,
              compression: candidate.tracked.compression,
              dominance,
              breakout: candidate.breakout,
              breakoutStrength: candidate.breakoutStrength,
            });
            if (setup !== null) setups.push(setup);
          }
        }
      }

      priorAtr = atrTracker.next(current);
      const stageDominance = setupBConfirmed.at(-1)?.evidence ?? dominance;
      return { quality, dominance: stageDominance, setups };
    },
  };
}

function isIncompleteEntryWindow(error: unknown, index: number, signal: SetupSignal): boolean {
  return (
    error instanceof Error &&
    error.message === 'closedCandles must reach expiry unless the entry fills or cancels earlier' &&
    index < signal.triggerIndex + RETEST_ENTRY_EXPIRY_CANDLES
  );
}

export function createNukidaFsm(config: FsmConfig): {
  onClosedCandle(candles: readonly Candle[], index: number): FsmEvent[];
} {
  const strategy = config.strategyAdapter ?? createDefaultStrategyAdapter(config);
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
          const entry = evaluateRetestEntry({
            signal,
            closedCandles: visibleCandles,
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
              setupBSlBufferAtrMultiple: config.setupBSlBufferAtrMultiple,
              availableCapitalUsd: config.availableCapitalUsd,
              setupBConfirmationCandle: config.setupBConfirmationCandle,
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
                  },
            );
          } else if (entry.status === 'EXPIRED') {
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
      // TICKET-032: A-only is now the default; B stays available via enabledSetupFamilies.
      const enabledSetupFamilies =
        config.enabledSetupFamilies ?? (['A_COMPRESSION_BREAKOUT'] as const);
      const setups = stage.setups.filter((signal) => enabledSetupFamilies.includes(signal.setupFamily));
      if (setups.length === 0) {
        events.push({ index, state: 'REJECTED', reasonCode: 'NO_SETUP' });
        return events;
      }
      if (triggerAtr === null) throw new Error('Setup detected before ATR14 was available');
      for (const signal of setups) {
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
