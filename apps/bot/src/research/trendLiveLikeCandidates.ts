import type { Candle } from '../noTradeZone/types.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../entry/fvgStrategyConfig.js';
import { SymbolSignalEngine } from '../live/signalEngine.js';
import type { TrendCandidate } from './trendLiveLikeExecution.js';

const H1_MS = 60 * 60_000;
const M15_MS = 15 * 60_000;

export interface CandidateGenerationResult {
  detectedSignals: number;
  floorRejected: number;
  candidates: TrendCandidate[];
}

export function generateTrendCandidates(symbol: string, m15: Candle[], h1: Candle[]): CandidateGenerationResult {
  const engine = new SymbolSignalEngine(symbol);
  const candidates: TrendCandidate[] = [];
  let h1Cursor = 0;
  let detectedSignals = 0;
  let floorRejected = 0;
  for (const candle of m15) {
    const decisionTimestamp = candle.openTime + M15_MS;
    while (h1Cursor < h1.length && h1[h1Cursor].openTime + H1_MS <= decisionTimestamp) engine.onNewH1Candle(h1[h1Cursor++]);
    const signal = engine.checkForNewSignal(candle, true);
    if (!signal) continue;
    detectedSignals++;
    const entryPrice = signal.direction === 'LONG' ? signal.gapLow : signal.gapHigh;
    const slPrice = signal.invalidationPrice;
    const risk = Math.abs(entryPrice - slPrice);
    if (risk <= 0 || (risk / entryPrice) * 100 < DEFAULT_FVG_STRATEGY_CONFIG.minSlPctFloor) {
      floorRejected++;
      continue;
    }
    const tpPrice = signal.direction === 'LONG'
      ? entryPrice + DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple * risk
      : entryPrice - DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple * risk;
    candidates.push({ symbol, signalOpenTime: candle.openTime, decisionTimestamp, direction: signal.direction, entryPrice, slPrice, tpPrice, gapLow: signal.gapLow, gapHigh: signal.gapHigh });
  }
  return { detectedSignals, floorRejected, candidates };
}
