export type ResearchCandle = { timestamp: number; open: number; high: number; low: number; close: number; volume: number };

export function closedCandlesAt(candles: ResearchCandle[], decisionTimestamp: number, intervalMs: number): ResearchCandle[] {
  return candles.filter(candle => candle.timestamp + intervalMs <= decisionTimestamp);
}

export function trailingClosedWindow(candles: ResearchCandle[], decisionTimestamp: number, intervalMs: number, size: number): ResearchCandle[] {
  return closedCandlesAt(candles, decisionTimestamp, intervalMs).slice(-size);
}

export function assertNoFutureCandles(candles: ResearchCandle[], decisionTimestamp: number, intervalMs: number): void {
  if (candles.some(candle => candle.timestamp + intervalMs > decisionTimestamp)) {
    throw new Error('Decision-time feature window contains an unclosed candle');
  }
}
