import { describe, expect, it } from 'vitest';
import { computeCorrelatedRiskRatio } from './correlatedRisk.js';
import type { CandleData } from './types.js';

// TICKET-030 — cross-symbol correlation. Computed once for the whole coin universe, never per-symbol.

function candlesFromCloses(closes: number[]): CandleData[] {
  const startTs = Date.UTC(2024, 0, 1);
  return closes.map((close, i) => ({ timestamp: startTs + i * 3_600_000, open: close, high: close, low: close, close, volume: 1000 }));
}

describe('computeCorrelatedRiskRatio', () => {
  it('returns a ratio close to 1 when all coins move in lockstep (strongly correlated)', () => {
    const n = 50;
    const anchorCloses = Array.from({ length: n }, (_, i) => 100 + i); // steady uptrend
    const candlesBySymbol: Record<string, CandleData[]> = {
      BTCUSDT: candlesFromCloses(anchorCloses),
      ETHUSDT: candlesFromCloses(anchorCloses.map((c) => c * 2)), // same shape, different scale -> same returns
      SOLUSDT: candlesFromCloses(anchorCloses.map((c) => c * 0.5)),
      XRPUSDT: candlesFromCloses(anchorCloses.map((c) => c * 3)),
    };

    const ratios = computeCorrelatedRiskRatio(candlesBySymbol, 30, 'BTCUSDT');
    expect(ratios[n - 1]).toBeCloseTo(1.0, 5);
  });

  it('returns a low ratio when coins move independently (uncorrelated)', () => {
    const n = 50;
    // Deterministic pseudo-random-looking sequences, no shared trend/shape between them.
    const anchorCloses = Array.from({ length: n }, (_, i) => 100 + Math.sin(i * 1.3) * 5);
    const ethCloses = Array.from({ length: n }, (_, i) => 100 + Math.cos(i * 0.7) * 5);
    const solCloses = Array.from({ length: n }, (_, i) => 100 + Math.sin(i * 2.9 + 1) * 5);
    const xrpCloses = Array.from({ length: n }, (_, i) => 100 + Math.cos(i * 4.1 + 2) * 5);
    const candlesBySymbol: Record<string, CandleData[]> = {
      BTCUSDT: candlesFromCloses(anchorCloses),
      ETHUSDT: candlesFromCloses(ethCloses),
      SOLUSDT: candlesFromCloses(solCloses),
      XRPUSDT: candlesFromCloses(xrpCloses),
    };

    const ratios = computeCorrelatedRiskRatio(candlesBySymbol, 30, 'BTCUSDT');
    expect(Math.abs(ratios[n - 1])).toBeLessThan(0.5);
  });

  it('returns NaN wherever fewer than windowCandles returns exist yet for the anchor', () => {
    const n = 20; // windowCandles=30 needs 31 candles, only have 20
    const closes = Array.from({ length: n }, (_, i) => 100 + i);
    const candlesBySymbol: Record<string, CandleData[]> = {
      BTCUSDT: candlesFromCloses(closes),
      ETHUSDT: candlesFromCloses(closes),
      SOLUSDT: candlesFromCloses(closes),
      XRPUSDT: candlesFromCloses(closes),
    };

    const ratios = computeCorrelatedRiskRatio(candlesBySymbol, 30, 'BTCUSDT');
    expect(ratios.every((r) => Number.isNaN(r))).toBe(true);
  });

  it('does not throw on insufficient data (returns NaN, not an error)', () => {
    const candlesBySymbol: Record<string, CandleData[]> = {
      BTCUSDT: candlesFromCloses([100]),
      ETHUSDT: candlesFromCloses([100]),
      SOLUSDT: candlesFromCloses([100]),
      XRPUSDT: candlesFromCloses([100]),
    };
    expect(() => computeCorrelatedRiskRatio(candlesBySymbol, 30, 'BTCUSDT')).not.toThrow();
  });

  it('a pair correlation is identical whether other coins are present in the record or not (no cross-contamination between pairs)', () => {
    const n = 50;
    const anchorCloses = Array.from({ length: n }, (_, i) => 100 + Math.sin(i * 1.3) * 5);
    const ethCloses = Array.from({ length: n }, (_, i) => 100 + i * 2); // strongly trending, unrelated shape to anchor

    const twoCoin = computeCorrelatedRiskRatio({ BTCUSDT: candlesFromCloses(anchorCloses), ETHUSDT: candlesFromCloses(ethCloses) }, 30, 'BTCUSDT');
    const fourCoin = computeCorrelatedRiskRatio(
      {
        BTCUSDT: candlesFromCloses(anchorCloses),
        ETHUSDT: candlesFromCloses(ethCloses),
        SOLUSDT: candlesFromCloses(anchorCloses), // identical to anchor -> r=1 with anchor
        XRPUSDT: candlesFromCloses(anchorCloses), // identical to anchor -> r=1 with anchor
      },
      30,
      'BTCUSDT',
    );

    const rEthBtc = twoCoin[n - 1]; // only 1 other symbol here -> the ratio IS exactly r(ETH,BTC)
    expect(fourCoin[n - 1]).toBeCloseTo((rEthBtc + 1 + 1) / 3, 10);
  });
});
