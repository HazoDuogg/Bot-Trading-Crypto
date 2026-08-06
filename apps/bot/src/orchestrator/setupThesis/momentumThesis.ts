/**
 * TICKET-142 — MomentumThesis (MOMENTUM_DIRECT). Reuses production's real momentum-scoring pipeline
 * (same building blocks orchestrator.ts's private scoreMomentumForSide() uses, replicated here from
 * exported primitives only — same technique ticket136Neutral5mOpportunityFunnelAudit.ts already
 * proved). No OB/FVG retest required. Each qualifying candle is its own candidate — no zone/dedup
 * concept applies to a per-candle AI score check.
 */
import type { CandleData, RegimeOutput } from '../../regime/types.js';
import { RegimeConfig } from '../../regime/config.js';
import { lastDefined, wilderATRSeries } from '../../regime/indicators.js';
import { EntryConfig } from '../../entry/config.js';
import { detectMomentumDirect } from '../../entry/momentumDirect.js';
import { detectSwingPoints, latestSwingPointBefore } from '../../entry/detectors/swingPoints.js';
import { buildFeatureVector, computeMomentumCrossFeatures, loadFeatureSchema, type FeatureSchema } from '../../xgbFilter/featureBuilder.js';
import { scoreMomentum } from '../../xgbFilter/momentumScorer.js';
import { MOMENTUM_MODEL_PATH, MOMENTUM_SCHEMA_PATH, MOMENTUM_BEARISH_MODEL_PATH, MOMENTUM_BEARISH_SCHEMA_PATH } from '../../xgbFilter/config.js';
import { SafetyState5m } from '../../regime/htfSafetyTypes.js';
import type { SetupThesisCommonInput, SetupThesisResult } from './types.js';

export interface MomentumThesisInput extends SetupThesisCommonInput {
  candles5m: CandleData[];
  candles1hMomentum: CandleData[];
  regimeOutput: RegimeOutput;
  macroDirection: 'UP' | 'DOWN' | 'FLAT' | undefined;
  correlatedRiskRatio: number | undefined;
  momentumDirectThreshold: number;
  momentumDirectMinSlPercent: number;
  momentumDirectTpRMultiple: number;
  momentumModelPath?: string;
  momentumSchemaPath?: string;
  momentumBearishModelPath?: string;
  momentumBearishSchemaPath?: string;
}

// Verbatim replica of orchestrator.ts's private computeDistanceToNearestSwingAtr() — same formula,
// built only from exported primitives (see TICKET-136 script, lines ~161-176).
function computeDistanceToNearestSwingAtr(candles5m: CandleData[]): number | undefined {
  const atr = lastDefined(wilderATRSeries(candles5m, RegimeConfig.ATR_PERIOD_5M));
  if (atr === undefined || atr <= 0) return undefined;
  const swingPoints = detectSwingPoints(candles5m, EntryConfig.FRACTAL_N);
  const lastIndex = candles5m.length - 1;
  const nearestHigh = latestSwingPointBefore(swingPoints, 'HIGH', lastIndex);
  const nearestLow = latestSwingPointBefore(swingPoints, 'LOW', lastIndex);
  if (nearestHigh === null && nearestLow === null) return undefined;
  const close = candles5m[lastIndex].close;
  const distHigh = nearestHigh !== null ? Math.abs(close - nearestHigh.price) : Infinity;
  const distLow = nearestLow !== null ? Math.abs(close - nearestLow.price) : Infinity;
  return Math.min(distHigh, distLow) / atr;
}

const schemaCache = new Map<string, FeatureSchema>();
function getSchemaCached(schemaPath: string): FeatureSchema {
  let cached = schemaCache.get(schemaPath);
  if (cached === undefined) {
    cached = loadFeatureSchema(schemaPath);
    schemaCache.set(schemaPath, cached);
  }
  return cached;
}

// Verbatim replica of orchestrator.ts's private scoreMomentumForSide() — identical formula/model
// paths/schema, built only from exported primitives.
async function scoreMomentumForSideReplica(input: MomentumThesisInput, side: 'LONG' | 'SHORT'): Promise<number | undefined> {
  const crossFeatures = computeMomentumCrossFeatures(input.candles5m, input.candles1hMomentum);
  if (crossFeatures === undefined) return undefined;
  const isLong = side === 'LONG';
  const modelPath = isLong ? (input.momentumModelPath ?? MOMENTUM_MODEL_PATH) : (input.momentumBearishModelPath ?? MOMENTUM_BEARISH_MODEL_PATH);
  const schemaPath = isLong ? (input.momentumSchemaPath ?? MOMENTUM_SCHEMA_PATH) : (input.momentumBearishSchemaPath ?? MOMENTUM_BEARISH_SCHEMA_PATH);
  const schema = getSchemaCached(schemaPath);
  const featureVector = buildFeatureVector(
    {
      symbol: input.symbol,
      adx1h: input.regimeOutput.computedMetrics.adx1h as number,
      atrPercentile5m: input.regimeOutput.computedMetrics.atrPercentile5m as number,
      bbWidthPercentile15m: input.regimeOutput.computedMetrics.bbWidthPercentile15m as number,
      volumeZScore5m: input.regimeOutput.computedMetrics.volumeZScore5m as number,
      atrTrend5m: input.regimeOutput.computedMetrics.atrTrend5m as string,
      adxDirection1h: input.regimeOutput.adxDirection1h as string,
      macroDirection: input.macroDirection,
      correlatedRiskRatio: input.correlatedRiskRatio,
      distanceToNearestSwingAtr: computeDistanceToNearestSwingAtr(input.candles5m),
      ...crossFeatures,
    },
    schema,
  );
  return scoreMomentum(modelPath, featureVector);
}

// Same SL formula as orchestrator.ts's private computeMomentumDirectSlPrice() — sweep-style SL
// (candle's own extreme) + ATR buffer, floored by momentumDirectMinSlPercent.
function computeMomentumSlPrice(side: 'LONG' | 'SHORT', entryPrice: number, currentCandle: CandleData, atr: number, minSlPercent: number): number {
  const rawSlPrice = side === 'LONG' ? currentCandle.low : currentCandle.high;
  const buffer = EntryConfig.SL_BUFFER_ATR_MULTIPLIER * atr;
  let slPrice = side === 'LONG' ? rawSlPrice - buffer : rawSlPrice + buffer;
  const rawSlDistancePercent = (Math.abs(entryPrice - slPrice) / entryPrice) * 100;
  if (rawSlDistancePercent < minSlPercent) {
    const flooredDistance = (minSlPercent / 100) * entryPrice;
    slPrice = side === 'LONG' ? entryPrice - flooredDistance : entryPrice + flooredDistance;
  }
  return slPrice;
}

async function evaluateSide(input: MomentumThesisInput, side: 'LONG' | 'SHORT'): Promise<SetupThesisResult> {
  const currentCandle = input.candles5m[input.candles5m.length - 1];
  const reasons: string[] = [];
  const score = await scoreMomentumForSideReplica(input, side);

  if (score === undefined) {
    reasons.push('Model/AI score không tính được (thiếu dữ liệu cross-feature EMA1h/ATR5m)');
    return {
      symbol: input.symbol,
      timestamp: input.timestamp,
      setupType: 'MOMENTUM_DIRECT',
      side,
      candidateId: `${input.symbol}:MOMENTUM_DIRECT:${side}:${input.timestamp}`,
      thesisState: 'NONE',
      qualityScore: null,
      reasons,
      entryPrice: null,
      stopLoss: null,
      riskReward: null,
      htfContext: input.htfContext,
      safetyState5m: input.safetyState5m,
    };
  }

  const momentumSideAgrees = detectMomentumDirect(score, side, input.momentumDirectThreshold);
  reasons.push(momentumSideAgrees ? `Momentum cùng side: score=${score.toFixed(4)} >= ${input.momentumDirectThreshold}` : `Momentum không cùng side: score=${score.toFixed(4)} < ${input.momentumDirectThreshold}`);

  const atr = lastDefined(wilderATRSeries(input.candles5m, RegimeConfig.ATR_PERIOD_5M));
  const entryPrice = currentCandle.close;
  let stopLoss: number | null = null;
  let riskReward: number | null = null;
  let entryTimingValid = false;
  if (atr === undefined) {
    reasons.push('Entry timing không hợp lệ: thiếu ATR5m để định SL');
  } else {
    entryTimingValid = true;
    stopLoss = computeMomentumSlPrice(side, entryPrice, currentCandle, atr, input.momentumDirectMinSlPercent);
    if (stopLoss !== entryPrice) {
      riskReward = input.momentumDirectTpRMultiple; // TP = priceAtR(entry, r, tpRMultiple) by construction — real production number, not invented.
      reasons.push(`SL/R hợp lệ: SL=${stopLoss.toFixed(6)}, R:R=${riskReward}R (momentumDirectTpRMultiple)`);
    } else {
      reasons.push('SL/R không hợp lệ: SL trùng entry');
    }
  }

  const safetyBlocked = input.safetyState5m === SafetyState5m.SHOCK || input.safetyState5m === SafetyState5m.MANIPULATED;
  if (safetyBlocked) reasons.push(`SafetyState5m=${input.safetyState5m} (hard block)`);

  const valid = momentumSideAgrees && entryTimingValid && riskReward !== null && !safetyBlocked;
  const thesisState = valid ? 'VALID' : momentumSideAgrees || entryTimingValid ? 'WEAK' : 'NONE';

  return {
    symbol: input.symbol,
    timestamp: input.timestamp,
    setupType: 'MOMENTUM_DIRECT',
    side,
    candidateId: `${input.symbol}:MOMENTUM_DIRECT:${side}:${input.timestamp}`,
    thesisState,
    qualityScore: score,
    reasons,
    entryPrice,
    stopLoss,
    riskReward,
    htfContext: input.htfContext,
    safetyState5m: input.safetyState5m,
  };
}

export async function computeMomentumThesis(input: MomentumThesisInput): Promise<SetupThesisResult[]> {
  return [await evaluateSide(input, 'LONG'), await evaluateSide(input, 'SHORT')];
}
