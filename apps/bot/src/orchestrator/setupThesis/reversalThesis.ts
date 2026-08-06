/**
 * TICKET-142 — ReversalThesis (SWEEP). Own rules: liquidity sweep detected, price reclaims the swept
 * level (detectLiquiditySweep()'s own wick+pierce+close-reclaim logic already IS this), structure
 * reversal confirmation (detectRecentStructuralBreak), entry only after confirmation. Dedup by sweep
 * event is a report-level post-process (candidateId already bakes in the event identity).
 */
import type { CandleData } from '../../regime/types.js';
import { lastDefined, wilderATRSeries } from '../../regime/indicators.js';
import { RegimeConfig } from '../../regime/config.js';
import { EntryConfig } from '../../entry/config.js';
import type { Direction } from '../../entry/types.js';
import { detectLiquiditySweep } from '../../entry/detectors/liquiditySweep.js';
import { detectRecentStructuralBreak } from '../../entry/detectors/structuralBreakRecent.js';
import { computeTpLevels, type TpPlan } from '../../risk/slTpManager.js';
import { evaluateZoneGates } from '../localTradeThesis5m.js';
import type { SetupThesisCommonInput, SetupThesisResult, ThesisSide } from './types.js';

export interface ReversalThesisInput extends SetupThesisCommonInput {
  candles5m: CandleData[];
  candles1m: CandleData[];
  tpPlan: TpPlan;
}

function evaluateOne(input: ReversalThesisInput, side: ThesisSide): SetupThesisResult | null {
  const direction: Direction = side === 'LONG' ? 'BULLISH' : 'BEARISH';
  const candles5m = input.candles5m;

  const sweep = detectLiquiditySweep(candles5m, direction, { fractalN: EntryConfig.FRACTAL_N, wickRatioThreshold: EntryConfig.LIQUIDITY_SWEEP_WICK_RATIO_THRESHOLD });
  if (sweep === null) return null; // no sweep at all — caller omits this row.

  const sweepCandle = candles5m[sweep.candleIndex];
  const formedTimestamp = sweepCandle.timestamp;
  // Same style sweep-event id as T141A's SWEEP zoneId — formation candle timestamp + swept level.
  const candidateId = `${input.symbol}:SWEEP:${side}:${formedTimestamp}:${sweep.sweptLevel}`;
  const gates = evaluateZoneGates(candles5m, sweep.candleIndex, sweep.sweptLevel, sweep.sweptLevel, direction);

  const reasons: string[] = ['Có liquidity sweep (detectLiquiditySweep: wick+pierce)'];
  // detectLiquiditySweep() only returns non-null once close already reclaimed back inside — this IS
  // "giá reclaim vùng vừa sweep", not a separate check.
  reasons.push('Giá đã reclaim vùng vừa sweep (detectLiquiditySweep close-reclaim)');

  const structureReversal = input.candles1m.length > 0 && detectRecentStructuralBreak(input.candles1m, direction, { fractalN: EntryConfig.FRACTAL_N }) !== null;
  reasons.push(structureReversal ? 'Có xác nhận structure đảo chiều (detectRecentStructuralBreak 1m)' : 'Chưa có xác nhận structure đảo chiều');

  // Entry chỉ sau xác nhận: current (last) candle must be at/after the reclaim, i.e. the sweep's own
  // gates.zoneRetested holds trivially (formation candle itself) — the real "after confirmation" gate
  // is structureReversal above, checked on the independent 1m timeframe.
  const entryAfterConfirmation = structureReversal;

  const atr = lastDefined(wilderATRSeries(candles5m, RegimeConfig.ATR_PERIOD_5M));
  const currentCandle = candles5m[candles5m.length - 1];
  const entryPrice = currentCandle.close;
  const buffer = atr !== undefined ? EntryConfig.SL_BUFFER_ATR_MULTIPLIER * atr : 0;
  const rawSlPrice = side === 'LONG' ? sweepCandle.low : sweepCandle.high;
  const stopLoss = side === 'LONG' ? rawSlPrice - buffer : rawSlPrice + buffer;

  let riskReward: number | null = null;
  if (stopLoss !== entryPrice) {
    const tpLevels = computeTpLevels({ scenario: 'TREND', entryPrice, slPrice: stopLoss, side, tpPlan: input.tpPlan });
    const tp1 = tpLevels.find((t) => t.label === 'TP1');
    riskReward = tp1?.rMultiple ?? null;
  }
  reasons.push(riskReward !== null ? `Entry/SL/R hợp lệ: R:R=${riskReward}R` : 'Entry/SL/R không hợp lệ: SL trùng entry');

  const valid = entryAfterConfirmation && gates.zoneNotConsumed && riskReward !== null;
  const thesisState = valid ? 'VALID' : structureReversal || riskReward !== null ? 'WEAK' : 'NONE';

  return {
    symbol: input.symbol,
    timestamp: input.timestamp,
    setupType: 'SWEEP',
    side,
    candidateId,
    thesisState,
    qualityScore: null, // no real production confidence value exists for SWEEP — never invented.
    reasons,
    entryPrice,
    stopLoss,
    riskReward,
    htfContext: input.htfContext,
    safetyState5m: input.safetyState5m,
  };
}

export function computeReversalThesis(input: ReversalThesisInput): SetupThesisResult[] {
  const results: SetupThesisResult[] = [];
  for (const side of ['LONG', 'SHORT'] as const) {
    const r = evaluateOne(input, side);
    if (r !== null) results.push(r);
  }
  return results;
}
