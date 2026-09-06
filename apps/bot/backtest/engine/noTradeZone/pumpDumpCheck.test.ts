import { describe, it, expect } from 'vitest';
import { isPumpDump } from './pumpDumpCheck.js';
import type { Candle } from './types.js';

function candle(open: number, high: number, low: number, close: number, volume: number): Candle {
  return { openTime: 0, open, high, low, close, volume };
}

describe('isPumpDump', () => {
  it('flags N consecutive strong same-direction candles with volume spike-then-drop', () => {
    const baseline: Candle[] = [];
    for (let i = 0; i < 15; i++) baseline.push(candle(100, 101, 99, 100, 100)); // calm, ATR ~2

    const pump: Candle[] = [
      candle(100, 106, 100, 105, 500),
      candle(105, 111, 105, 110, 800), // volume peak
      candle(110, 116, 110, 115, 700),
      candle(115, 121, 115, 120, 600),
      candle(120, 126, 120, 125, 300),
      candle(125, 131, 125, 130, 150), // volume died off
    ];

    expect(isPumpDump([...baseline, ...pump], 6, 1.75, 2)).toBe(true);
  });

  it('does not flag mixed-direction candles', () => {
    const baseline: Candle[] = [];
    for (let i = 0; i < 15; i++) baseline.push(candle(100, 101, 99, 100, 100));

    const mixed: Candle[] = [
      candle(100, 106, 100, 105, 500),
      candle(105, 106, 99, 100, 800), // reverses direction
      candle(100, 106, 100, 105, 700),
      candle(105, 106, 99, 100, 600),
      candle(100, 106, 100, 105, 300),
      candle(105, 106, 99, 100, 150),
    ];

    expect(isPumpDump([...baseline, ...mixed], 6, 1.75, 2)).toBe(false);
  });

  it('does not flag calm uniform candles', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) candles.push(candle(100, 101, 99, 100, 100));
    expect(isPumpDump(candles, 6, 1.75, 2)).toBe(false);
  });
});
