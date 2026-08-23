import type { Candle } from './types.js';
import { computeAtr } from './atr.js';

const ATR_PERIOD = 14; // TODO_CONFIRM: doc doesn't specify a period; using the standard default.

// N consecutive same-direction M15 candles, each range > k*ATR, with volume spiking then dying off.
export function isPumpDump(
  m15Candles: Candle[],
  minConsecutive: number,
  atrMultiplier: number,
  volumeSpikeMultiplier: number,
): boolean {
  const preWindowCandles = m15Candles.slice(0, m15Candles.length - minConsecutive);
  const atrValues = computeAtr(preWindowCandles, ATR_PERIOD);
  if (atrValues.length === 0) return false;
  // Baseline ATR frozen right before the candidate window, so the pump candles can't inflate their own yardstick.
  const baselineAtr = atrValues[atrValues.length - 1];

  const recent = m15Candles.slice(-minConsecutive);

  const allUp = recent.every((c) => c.close > c.open);
  const allDown = recent.every((c) => c.close < c.open);
  if (!allUp && !allDown) return false;

  const strongRange = recent.every((c) => c.high - c.low > baselineAtr * atrMultiplier);
  if (!strongRange) return false;

  const volumes = recent.map((c) => c.volume);
  const peakVolume = Math.max(...volumes);
  const peakIndex = volumes.indexOf(peakVolume);
  const lastVolume = volumes[volumes.length - 1];

  // Peak must occur before the final candle, and volume must have dropped off since ("rồi tắt ngấm").
  return peakIndex < volumes.length - 1 && peakVolume > lastVolume * volumeSpikeMultiplier;
}
