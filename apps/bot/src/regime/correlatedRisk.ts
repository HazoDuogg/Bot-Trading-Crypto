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
 * TICKET-G2R F-02 — `candlesBySymbol` is NO LONGER assumed index-aligned. Every other symbol's
 * returns are looked up BY CLOSE TIMESTAMP against the anchor's window, and a return only counts
 * when BOTH of its endpoints (the candle and its own immediate predecessor) carry exactly the
 * anchor's timestamps — so a series that starts one candle later, or has a hole, can never be
 * silently compared against a different instant. The old index-based version was measurably wrong
 * on the registered dataset (XRPUSDT's 5m series starts +1 candle, shifting the per-symbol
 * decisionTime and therefore the 1H window boundaries at ~8.3% of steps).
 *
 * MISSING-TIMESTAMP POLICY (chosen and documented, not silent): a symbol that cannot supply a
 * COMPLETE, exactly-matching return window is EXCLUDED from that window's average — never
 * back/forward-filled from a neighbouring candle. If no other symbol qualifies, the result is NaN
 * (CORRELATED_RISK simply does not fire), never a partially-shifted number.
 *
 * For each index i: Pearson correlation of `anchorSymbol`'s trailing `windowCandles` 1H returns
 * against each OTHER symbol's returns at the SAME timestamps, averaged across the qualifying
 * symbols. NaN wherever fewer than `windowCandles` returns exist yet for the anchor.
 */
export function computeCorrelatedRiskRatio(candlesBySymbol: Record<string, CandleData[]>, windowCandles: number, anchorSymbol: string): number[] {
  const anchorCandles = candlesBySymbol[anchorSymbol];
  const n = anchorCandles.length;
  const otherSymbols = Object.keys(candlesBySymbol).filter((s) => s !== anchorSymbol);

  const anchorReturns = returnSeries(anchorCandles);
  // closeTimestamp -> { ret, prevTimestamp }. prevTimestamp is what makes the join exact: matching
  // only the closing instant would still admit a return measured over a different span (after a gap).
  const byTimestamp: Record<string, Map<number, { ret: number; prevTimestamp: number }>> = {};
  for (const symbol of otherSymbols) {
    const candles = candlesBySymbol[symbol];
    const rets = returnSeries(candles);
    const map = new Map<number, { ret: number; prevTimestamp: number }>();
    for (let i = 1; i < candles.length; i++) map.set(candles[i].timestamp, { ret: rets[i], prevTimestamp: candles[i - 1].timestamp });
    byTimestamp[symbol] = map;
  }

  const out = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const windowStart = i - windowCandles + 1;
    if (windowStart < 1) continue; // returns[0] is always NaN (no prior candle) -> need windowStart >= 1

    const anchorWindow = anchorReturns.slice(windowStart, i + 1);
    if (anchorWindow.some((v) => Number.isNaN(v))) continue;

    let sum = 0;
    let count = 0;
    for (const symbol of otherSymbols) {
      const map = byTimestamp[symbol];
      const otherWindow: number[] = [];
      for (let k = windowStart; k <= i; k++) {
        const entry = map.get(anchorCandles[k].timestamp);
        if (entry === undefined || entry.prevTimestamp !== anchorCandles[k - 1].timestamp || Number.isNaN(entry.ret)) break;
        otherWindow.push(entry.ret);
      }
      if (otherWindow.length !== anchorWindow.length) continue; // incomplete -> excluded, never filled
      sum += pearsonCorrelation(anchorWindow, otherWindow);
      count++;
    }
    out[i] = count > 0 ? sum / count : NaN;
  }
  return out;
}
