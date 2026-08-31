import { describe, expect, it } from 'vitest';
import { buildSegments, selectSegmentStarts } from './fetchAnnotationSegments.js';
import { renderCandlestickPng } from './renderSegmentCharts.js';
import { INTERVAL_MS, type Candle } from './shared.js';

function candles(count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    openTime: 1_700_000_000_000 + index * INTERVAL_MS,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 10 + index,
  }));
}

describe('annotation segment sampling', () => {
  it('returns exactly the same segment starts for a fixed seed', () => {
    const source = candles(4_000);
    const first = selectSegmentStarts(source, 30, 81, 'fixed-seed:sample:BTCUSDT');
    const second = selectSegmentStarts(source, 30, 81, 'fixed-seed:sample:BTCUSDT');

    expect(second).toEqual(first);
    expect(first).toHaveLength(30);
  });

  it('never permits overlap greater than 50 percent', () => {
    const starts = selectSegmentStarts(candles(4_000), 30, 81, 'overlap-check');
    for (let left = 0; left < starts.length; left += 1) {
      for (let right = left + 1; right < starts.length; right += 1) {
        const overlap = Math.max(0, 81 - Math.abs(starts[left] - starts[right]));
        expect(overlap).toBeLessThanOrEqual(Math.floor(81 * 0.5));
      }
    }
  });

  it('cuts every candle after the decision candle from each serialized segment', () => {
    const source = candles(500);
    const cutoffTime = source[source.length - 20].openTime + INTERVAL_MS;
    const first = buildSegments('BTCUSDT', source, 3, 80, 'fixed-seed', cutoffTime);
    const second = buildSegments('BTCUSDT', source, 3, 80, 'fixed-seed', cutoffTime);

    expect(second).toEqual(first);
    for (const segment of first) {
      expect(segment.candles).toHaveLength(81);
      expect(segment.candles.at(-1)?.openTime).toBe(segment.decisionOpenTime);
      expect(segment.candles.every((candle) => candle.openTime <= segment.decisionOpenTime)).toBe(true);
      expect(segment.decisionOpenTime + INTERVAL_MS).toBeLessThanOrEqual(cutoffTime);
    }
  });

  it('renders PNGs without text or metadata chunks', () => {
    const png = renderCandlestickPng(candles(81));
    const chunks: string[] = [];
    let offset = 8;
    while (offset < png.length) {
      const length = png.readUInt32BE(offset);
      chunks.push(png.toString('ascii', offset + 4, offset + 8));
      offset += 12 + length;
    }

    expect(chunks).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(png.includes(Buffer.from('BTCUSDT'))).toBe(false);
  });
});
