/**
 * TICKET-142 — PullbackThesis (OB + FVG, per the ticket's own mapping). Own rules: trend/impulse
 * trước đó (structuralBreakRecent), zone fresh/not-consumed/retested (T141A's evaluateZoneGates,
 * reused verbatim), rejection/continuation confirmation (new structural OHLC check — no production
 * precedent exists, see report's "Judgment calls"), entry/SL/R. Dedup by zoneId is a report-level
 * post-process (same convention T141A used), not done here.
 */
import type { CandleData } from '../../regime/types.js';
import { lastDefined, wilderATRSeries } from '../../regime/indicators.js';
import { RegimeConfig } from '../../regime/config.js';
import { EntryConfig } from '../../entry/config.js';
import type { Direction } from '../../entry/types.js';
import { detectOrderBlock } from '../../entry/detectors/orderBlock.js';
import { detectFairValueGap } from '../../entry/detectors/fairValueGap.js';
import { detectRecentStructuralBreak } from '../../entry/detectors/structuralBreakRecent.js';
import { computeTpLevels, type TpPlan } from '../../risk/slTpManager.js';
import { evaluateZoneGates } from '../localTradeThesis5m.js';
import type { SetupThesisCommonInput, SetupThesisResult, ThesisSide } from './types.js';

export interface PullbackThesisInput extends SetupThesisCommonInput {
  candles5m: CandleData[];
  candles1m: CandleData[];
  obSlBufferAtrMultiplier: number;
  tpPlan: TpPlan;
}

function evaluateOne(input: PullbackThesisInput, setupType: 'OB' | 'FVG', side: ThesisSide): SetupThesisResult | null {
  const direction: Direction = side === 'LONG' ? 'BULLISH' : 'BEARISH';
  const candles5m = input.candles5m;
  const currentCandle = candles5m[candles5m.length - 1];

  const raw =
    setupType === 'OB'
      ? detectOrderBlock(candles5m, direction, { fractalN: EntryConfig.FRACTAL_N, lookforwardK: EntryConfig.OB_BOS_LOOKFORWARD_K })
      : detectFairValueGap(candles5m, direction);
  if (raw === null) return null; // no geometric candidate at all — setupType==='NONE' equivalent, caller omits this row.

  const low = setupType === 'OB' ? (raw as { low: number }).low : (raw as { bottom: number }).bottom;
  const high = setupType === 'OB' ? (raw as { high: number }).high : (raw as { top: number }).top;
  const zoneFormedTimestamp = candles5m[raw.candleIndex].timestamp;
  const zoneId = `${input.symbol}:${setupType}:${side}:${zoneFormedTimestamp}:${high}:${low}`;
  const gates = evaluateZoneGates(candles5m, raw.candleIndex, low, high, direction);

  const reasons: string[] = [];

  const trend = candles1mTrend(input.candles1m, direction);
  reasons.push(trend ? 'Có xu hướng/impulse trước đó (detectRecentStructuralBreak 1m)' : 'Không có xu hướng/impulse trước đó');

  reasons.push(gates.zoneFresh ? `Zone fresh: age=${gates.zoneAgeCandles}c` : `Zone không fresh: age=${gates.zoneAgeCandles}c`);
  reasons.push(gates.zoneNotConsumed ? 'Zone chưa consumed/invalidate' : 'Zone đã bị consumed/invalidate');
  reasons.push(gates.zoneRetested ? 'Có retest thực tế' : 'Chưa có retest thực tế');

  // JUDGMENT CALL — rejection/continuation confirmation: retest candle's own close is on the
  // favorable side of the zone midpoint AND closes in the trade direction relative to its own open.
  // Structural OHLC check, no invented magnitude threshold (see report).
  const mid = (low + high) / 2;
  const rejectionConfirmed = side === 'LONG' ? currentCandle.close > currentCandle.open && currentCandle.close > mid : currentCandle.close < currentCandle.open && currentCandle.close < mid;
  reasons.push(rejectionConfirmed ? 'Có rejection/xác nhận tiếp diễn (close > mid, cùng chiều candle)' : 'Không có rejection/xác nhận tiếp diễn');

  const atr = lastDefined(wilderATRSeries(candles5m, RegimeConfig.ATR_PERIOD_5M));
  const entryPrice = currentCandle.close;
  const bufferMultiplier = setupType === 'OB' ? input.obSlBufferAtrMultiplier : EntryConfig.SL_BUFFER_ATR_MULTIPLIER;
  const buffer = atr !== undefined ? bufferMultiplier * atr : 0;
  const rawSlPrice = side === 'LONG' ? low : high;
  const stopLoss = side === 'LONG' ? rawSlPrice - buffer : rawSlPrice + buffer;

  let riskReward: number | null = null;
  if (stopLoss !== entryPrice) {
    const tpLevels = computeTpLevels({ scenario: 'TREND', entryPrice, slPrice: stopLoss, side, tpPlan: input.tpPlan });
    const tp1 = tpLevels.find((t) => t.label === 'TP1');
    riskReward = tp1?.rMultiple ?? null;
  }
  reasons.push(riskReward !== null ? `Entry/SL/R hợp lệ: R:R=${riskReward}R` : 'Entry/SL/R không hợp lệ: SL trùng entry hoặc không map được TP plan');

  const valid = trend && gates.zoneFresh && gates.zoneNotConsumed && gates.zoneRetested && rejectionConfirmed && riskReward !== null;
  const anyPass = trend || gates.zoneFresh || gates.zoneRetested || rejectionConfirmed;
  const thesisState = valid ? 'VALID' : anyPass ? 'WEAK' : 'NONE';

  return {
    symbol: input.symbol,
    timestamp: input.timestamp,
    setupType,
    side,
    candidateId: zoneId,
    thesisState,
    qualityScore: null, // no real production confidence value exists for OB/FVG — never invented.
    reasons,
    entryPrice,
    stopLoss,
    riskReward,
    htfContext: input.htfContext,
    safetyState5m: input.safetyState5m,
  };
}

function candles1mTrend(candles1m: CandleData[], direction: Direction): boolean {
  if (candles1m.length === 0) return false;
  return detectRecentStructuralBreak(candles1m, direction, { fractalN: EntryConfig.FRACTAL_N }) !== null;
}

export function computePullbackThesis(input: PullbackThesisInput): SetupThesisResult[] {
  const results: SetupThesisResult[] = [];
  for (const setupType of ['OB', 'FVG'] as const) {
    for (const side of ['LONG', 'SHORT'] as const) {
      const r = evaluateOne(input, setupType, side);
      if (r !== null) results.push(r);
    }
  }
  return results;
}
