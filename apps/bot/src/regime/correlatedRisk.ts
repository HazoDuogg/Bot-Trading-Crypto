import type { CandleData } from './types.js';

/** Close-to-close % return per candle. First element is always NaN (no prior candle). */
function returnSeries(candles: CandleData[]): number[] {
  return candles.map((c, i) => (i === 0 ? NaN : (c.close - candles[i - 1].close) / candles[i - 1].close));
}

/** Population Pearson correlation coefficient — same population convention as indicators.ts's stdDevSeries. NaN when either series has zero variance (correlation undefined). */
function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return NaN;
  return cov / Math.sqrt(varX * varY);
}

/**
 * TICKET-030: cross-symbol correlation — structurally different from every function in
 * indicators.ts (those all take a single CandleData[]; this takes the WHOLE coin universe at
 * once), so it lives in its own file instead. Computed ONCE PER TIME-STEP for all coins together,
 * never per-symbol — the caller (backtest.ts / live wiring) is responsible for calling this exactly
 * once per step and distributing the same result into every symbol's detectRegime() call.
 * regime/regimeDetector.ts never calls this itself and never reads another symbol's candles —
 * detectRegime() stays single-symbol, only receives the pre-computed ratio as a plain number.
 *
 * `candlesBySymbol` must already be index-aligned across symbols (candlesBySymbol[a][i] and
 * candlesBySymbol[b][i] represent the same timestamp) — same assumption backtest.ts's main loop
 * already makes when it indexes every symbol's candles5m by the same shared `step`.
 *
 * For each index i: Pearson correlation of `anchorSymbol`'s trailing `windowCandles` 1H returns
 * against each OTHER symbol's, averaged across all other symbols. NaN wherever fewer than
 * `windowCandles` returns exist yet for the anchor.
 */
export function computeCorrelatedRiskRatio(candlesBySymbol: Record<string, CandleData[]>, windowCandles: number, anchorSymbol: string): number[] {
  const n = candlesBySymbol[anchorSymbol].length;
  const otherSymbols = Object.keys(candlesBySymbol).filter((s) => s !== anchorSymbol);

  const returnsBySymbol: Record<string, number[]> = {};
  for (const symbol of Object.keys(candlesBySymbol)) {
    returnsBySymbol[symbol] = returnSeries(candlesBySymbol[symbol]);
  }

  const out = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const windowStart = i - windowCandles + 1;
    if (windowStart < 1) continue; // returns[0] is always NaN (no prior candle) -> need windowStart >= 1

    const anchorWindow = returnsBySymbol[anchorSymbol].slice(windowStart, i + 1);
    if (anchorWindow.some((v) => Number.isNaN(v))) continue;

    let sum = 0;
    let count = 0;
    for (const symbol of otherSymbols) {
      const otherWindow = returnsBySymbol[symbol].slice(windowStart, i + 1);
      if (otherWindow.some((v) => Number.isNaN(v))) continue;
      sum += pearsonCorrelation(anchorWindow, otherWindow);
      count++;
    }
    out[i] = count > 0 ? sum / count : NaN;
  }
  return out;
}
