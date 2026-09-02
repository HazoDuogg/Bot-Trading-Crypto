import type { Candle } from '../noTradeZone/types.js';

const M15_MS = 15 * 60 * 1000;
const H1_MS = 60 * 60 * 1000;

// Aggregates M15 candles into CLOSED H1 candles only. An H1 candle is emitted only when
// all 4 of its M15 children are present, contiguous (each exactly 15 minutes after the
// last), and the group starts on a round UTC hour boundary (:00). Any trailing partial
// group (fewer than 4 children, or a gap) at the end of `m15Candles` is silently dropped —
// this is what makes the causal contract in emaTrendFilterH1.ts work: callers pass only
// `m15Candles.slice(0, triggerIndex)`, so a forming/incomplete hour is never surfaced.
export function aggregateM15ToClosedH1(m15Candles: readonly Candle[]): Candle[] {
  const closedH1: Candle[] = [];
  let index = 0;
  while (index + 4 <= m15Candles.length) {
    const start = m15Candles[index];
    if (start.openTime % H1_MS !== 0) {
      index += 1;
      continue;
    }
    const group = m15Candles.slice(index, index + 4);
    const contiguous = group.every(
      (candle, offset) => candle.openTime === start.openTime + offset * M15_MS,
    );
    if (!contiguous) {
      index += 1;
      continue;
    }
    closedH1.push({
      openTime: start.openTime,
      open: group[0].open,
      high: Math.max(...group.map((candle) => candle.high)),
      low: Math.min(...group.map((candle) => candle.low)),
      close: group[3].close,
      volume: group.reduce((sum, candle) => sum + candle.volume, 0),
    });
    index += 4;
  }
  return closedH1;
}
