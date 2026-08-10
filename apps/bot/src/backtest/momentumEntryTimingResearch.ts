import { EntryConfig } from '../entry/config.js';
import { detectSwingPoints, latestSwingPointBefore } from '../entry/detectors/swingPoints.js';
import type { DraftSetup } from '../entry/types.js';
import type { CandleData } from '../regime/types.js';
import { priceAtR } from '../risk/slTpManager.js';

export type MomentumEntryTimingMode = 'CURRENT_ENTRY' | 'OVEREXTENSION_GUARD' | 'BREAKOUT_PULLBACK_CONTINUATION';

export interface MomentumTimingGeometry {
  triggerLevel: number;
  triggerTimestamp: number;
  atr14: number;
  extensionAtr: number;
  structuralBoundary: number | null;
  availableRewardR: number | null;
}

export interface MomentumPullbackArm {
  triggerId: string;
  armedTimestamp: number;
  expiresTimestamp: number;
  pullbackSeen: boolean;
  geometry: MomentumTimingGeometry;
  draft: DraftSetup;
}

export interface MomentumTimingResearchConfig {
  mode: MomentumEntryTimingMode;
  maxExtensionAtr?: number;
  minAvailableRewardR?: number;
  maxWaitCandles5m?: number;
}

export function computeMomentumTimingGeometry(candles5m: CandleData[], side: 'LONG' | 'SHORT', entryPrice: number, slPrice: number, atr14: number): MomentumTimingGeometry | null {
  if (!(atr14 > 0) || candles5m.length < EntryConfig.FRACTAL_N * 2 + 2) return null;
  const decisionIndex = candles5m.length - 1;
  const swings = detectSwingPoints(candles5m, EntryConfig.FRACTAL_N);
  const trigger = latestSwingPointBefore(swings, side === 'LONG' ? 'HIGH' : 'LOW', decisionIndex);
  if (!trigger) return null;
  const risk = Math.abs(entryPrice - slPrice);
  const forward = swings
    .filter((point) => point.index < decisionIndex && (side === 'LONG' ? point.type === 'HIGH' && point.price > entryPrice : point.type === 'LOW' && point.price < entryPrice))
    .map((point) => point.price);
  const structuralBoundary = forward.length === 0 ? null : side === 'LONG' ? Math.min(...forward) : Math.max(...forward);
  const reward = structuralBoundary === null ? null : side === 'LONG' ? structuralBoundary - entryPrice : entryPrice - structuralBoundary;
  return {
    triggerLevel: trigger.price,
    triggerTimestamp: candles5m[trigger.index].timestamp,
    atr14,
    extensionAtr: (side === 'LONG' ? entryPrice - trigger.price : trigger.price - entryPrice) / atr14,
    structuralBoundary,
    availableRewardR: risk > 0 && reward !== null ? reward / risk : null,
  };
}

export function momentumGuardBlockReason(geometry: MomentumTimingGeometry | null, maxExtensionAtr: number, minAvailableRewardR: number): 'MISSING_GEOMETRY' | 'EXTENSION' | 'AVAILABLE_REWARD' | null {
  if (!geometry || geometry.availableRewardR === null) return 'MISSING_GEOMETRY';
  if (geometry.extensionAtr > maxExtensionAtr) return 'EXTENSION';
  if (geometry.availableRewardR < minAvailableRewardR) return 'AVAILABLE_REWARD';
  return null;
}

export function armMomentumPullback(draft: DraftSetup, geometry: MomentumTimingGeometry, armedTimestamp: number, maxWaitCandles5m: number): MomentumPullbackArm {
  return {
    triggerId: `${draft.side}:${geometry.triggerTimestamp}:${geometry.triggerLevel}`,
    armedTimestamp,
    expiresTimestamp: armedTimestamp + maxWaitCandles5m * 5 * 60_000,
    pullbackSeen: false,
    geometry,
    draft,
  };
}

export function advanceMomentumPullback(arm: MomentumPullbackArm, current5m: CandleData, candles1m: CandleData[], maxExtensionAtr: number, minAvailableRewardR: number, tpRMultiple: number): { status: 'WAITING' | 'INVALIDATED' | 'TIMEOUT' | 'CONFIRMED' | 'GEOMETRY_BLOCKED'; arm: MomentumPullbackArm | null; draft: DraftSetup | null } {
  if (current5m.timestamp > arm.expiresTimestamp) return { status: 'TIMEOUT', arm: null, draft: null };
  const { triggerLevel, atr14, structuralBoundary } = arm.geometry;
  const side = arm.draft.side;
  const invalidated = side === 'LONG' ? current5m.close < triggerLevel - 0.5 * atr14 : current5m.close > triggerLevel + 0.5 * atr14;
  if (invalidated) return { status: 'INVALIDATED', arm: null, draft: null };
  const pullbackSeen = arm.pullbackSeen || (side === 'LONG' ? current5m.low <= triggerLevel + 0.1 * atr14 : current5m.high >= triggerLevel - 0.1 * atr14);
  const closed = candles1m.filter((candle) => candle.timestamp > arm.armedTimestamp);
  const last = closed.at(-1);
  const previous = closed.at(-2);
  const continued = pullbackSeen && last !== undefined && previous !== undefined && (side === 'LONG' ? last.close > last.open && last.close > previous.high : last.close < last.open && last.close < previous.low);
  if (!continued) return { status: 'WAITING', arm: { ...arm, pullbackSeen }, draft: null };
  const entryPrice = last.close;
  const risk = Math.abs(entryPrice - arm.draft.slPrice);
  const extensionAtr = (side === 'LONG' ? entryPrice - triggerLevel : triggerLevel - entryPrice) / atr14;
  const reward = structuralBoundary === null ? null : side === 'LONG' ? structuralBoundary - entryPrice : entryPrice - structuralBoundary;
  const availableRewardR = risk > 0 && reward !== null ? reward / risk : null;
  if (extensionAtr > maxExtensionAtr || availableRewardR === null || availableRewardR < minAvailableRewardR) return { status: 'GEOMETRY_BLOCKED', arm: null, draft: null };
  return {
    status: 'CONFIRMED',
    arm: null,
    draft: { ...arm.draft, entryPrice, tpPriceOverride: priceAtR(entryPrice, risk, tpRMultiple, side) },
  };
}
