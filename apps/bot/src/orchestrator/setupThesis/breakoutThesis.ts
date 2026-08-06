/**
 * TICKET-142 — BreakoutThesis (BOX_BREAKOUT). box/compression + breakout close outside box +
 * momentum/volume confirmed all come from detectBoxBreakout() itself (production logic, unchanged).
 * Anti-chase reuses neutral5mDirectionSelector.ts's exact overextension formula. detectBoxBreakout()
 * is single-candle-triggered by construction (breakoutCandleIndex always the last candle) — one
 * breakout event = one candidate already holds, no extra dedup machinery needed (confirmed, T141A).
 */
import type { CandleData, ComputedMetrics } from '../../regime/types.js';
import { emaSeries, lastDefined, wilderATRSeries } from '../../regime/indicators.js';
import { RegimeConfig } from '../../regime/config.js';
import { EntryConfig } from '../../entry/config.js';
import { detectBoxBreakout } from '../../entry/detectors/boxBreakout.js';
import { computeTpLevels, type TpPlan } from '../../risk/slTpManager.js';
import { NEUTRAL_5M_EMA_SLOW_PERIOD, NEUTRAL_5M_OVEREXTENSION_ATR_THRESHOLD } from '../neutral5mDirectionSelector.js';
import type { SetupThesisCommonInput, SetupThesisResult, ThesisSide } from './types.js';

export interface BreakoutThesisInput extends SetupThesisCommonInput {
  candles5m: CandleData[];
  candles15m: CandleData[];
  computedMetrics: ComputedMetrics;
  tpPlan: TpPlan;
}

function evaluateOne(input: BreakoutThesisInput, side: ThesisSide, atr: number | undefined, ema21Now: number): SetupThesisResult | null {
  const currentCandle = input.candles5m[input.candles5m.length - 1];
  const bbw = input.computedMetrics.bbWidthPercentile15m as number | undefined;
  const vz = input.computedMetrics.volumeZScore5m as number | undefined;
  if (bbw === undefined || vz === undefined) return null; // insufficient metrics — no candidate at all.

  const breakout = detectBoxBreakout(input.candles15m, input.candles5m, bbw, vz, {
    boxLookbackM: EntryConfig.BOX_LOOKBACK_M,
    maxBbwPercentile: EntryConfig.BOX_MAX_BBW_PERCENTILE,
    minBodyRatio: EntryConfig.BOX_BREAKOUT_MIN_BODY_RATIO,
    minVolumeZScore: EntryConfig.BOX_BREAKOUT_MIN_VOLUME_ZSCORE,
  });
  const wantedDirection = side === 'LONG' ? 'UP' : 'DOWN';
  if (breakout === null || breakout.direction !== wantedDirection) return null;

  const reasons: string[] = ['Box/compression hợp lệ + breakout confirmed (detectBoxBreakout: bbwPercentile+bodyRatio+volumeZScore)'];

  let distanceFromEmaInAtr: number | null = null;
  if (atr !== undefined && atr !== 0 && !Number.isNaN(ema21Now)) {
    distanceFromEmaInAtr = Math.abs(currentCandle.close - ema21Now) / atr;
  }
  const notChasing = distanceFromEmaInAtr !== null && distanceFromEmaInAtr < NEUTRAL_5M_OVEREXTENSION_ATR_THRESHOLD;
  reasons.push(notChasing ? `Không chase: distanceFromEmaInAtr=${distanceFromEmaInAtr?.toFixed(3)}` : `Chase hoặc thiếu dữ liệu: distanceFromEmaInAtr=${distanceFromEmaInAtr ?? 'N/A'}`);

  const entryPrice = currentCandle.close;
  const rawSlPrice = side === 'LONG' ? breakout.boxLow : breakout.boxHigh;
  const stopLoss = rawSlPrice;
  let riskReward: number | null = null;
  if (stopLoss !== entryPrice) {
    const tpLevels = computeTpLevels({ scenario: 'TREND', entryPrice, slPrice: stopLoss, side, tpPlan: input.tpPlan });
    const tp1 = tpLevels.find((t) => t.label === 'TP1');
    riskReward = tp1?.rMultiple ?? null;
  }
  reasons.push(riskReward !== null ? `Entry/SL/R hợp lệ: R:R=${riskReward}R` : 'Entry/SL/R không hợp lệ: SL trùng entry');

  const valid = notChasing && riskReward !== null;

  return {
    symbol: input.symbol,
    timestamp: input.timestamp,
    setupType: 'BOX_BREAKOUT',
    side,
    candidateId: `${input.symbol}:BOX_BREAKOUT:${side}:${currentCandle.timestamp}:${breakout.boxHigh}:${breakout.boxLow}`,
    thesisState: valid ? 'VALID' : 'WEAK',
    qualityScore: null, // no real production confidence value exists for BOX_BREAKOUT — never invented.
    reasons,
    entryPrice,
    stopLoss,
    riskReward,
    htfContext: input.htfContext,
    safetyState5m: input.safetyState5m,
  };
}

export function computeBreakoutThesis(input: BreakoutThesisInput): SetupThesisResult[] {
  const atr = lastDefined(wilderATRSeries(input.candles5m, RegimeConfig.ATR_PERIOD_5M));
  const emaSlowSeries = emaSeries(input.candles5m, NEUTRAL_5M_EMA_SLOW_PERIOD);
  const ema21Now = emaSlowSeries[emaSlowSeries.length - 1];
  const results: SetupThesisResult[] = [];
  for (const side of ['LONG', 'SHORT'] as const) {
    const r = evaluateOne(input, side, atr, ema21Now);
    if (r !== null) results.push(r);
  }
  return results;
}
