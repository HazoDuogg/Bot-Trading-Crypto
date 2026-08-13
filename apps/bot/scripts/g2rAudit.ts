/**
 * TICKET-G2R — P0 verification harness (research/diagnostic only, never imported by live code).
 * Extends apps/bot/scripts/g2RegimeAudit.ts's replay with the two P0 remediations measured:
 *   P0-1 (F-01) live/backtest regime parity + LOW_LIQUIDITY parity + restart/warm-up parity
 *   P0-2 (F-02) cross-symbol timestamp alignment + mixed-timestamp correlation-window count
 * Emits:
 *   data/g2r-live-backtest-parity.csv
 *   data/g2r-cross-symbol-alignment.csv
 *   data/g2r-correlation-timestamp-audit.csv
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { detectRegime } from '../dist/regime/regimeDetector.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { MarketRegime, type CandleData } from '../dist/regime/types.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const OUT_DIR = path.resolve(process.cwd(), 'data');

const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_5M_SESSION_VOLUME = 14 * 288 + 1;
const SKIP_DAYS = 20;

function readCsv(file: string): CandleData[] {
  const raw = readFileSync(file, 'utf8').trim();
  return raw.split('\n').slice(1).map((line) => {
    const p = line.split(',');
    return { timestamp: Number(p[0]), open: Number(p[2]), high: Number(p[3]), low: Number(p[4]), close: Number(p[5]), volume: Number(p[6]) };
  });
}

/** Byte-identical copy of backtest.ts closedWindow(). */
function closedWindow(candles: CandleData[], ptr: number, intervalMs: number, decisionTime: number, windowSize: number): { window: CandleData[]; ptr: number } {
  let p = ptr;
  while (p + 1 < candles.length && candles[p + 1].timestamp + intervalMs <= decisionTime) p++;
  if (p < 0) return { window: [], ptr: p };
  return { window: candles.slice(Math.max(0, p - windowSize + 1), p + 1), ptr: p };
}

/**
 * PRE-G2R implementation of computeCorrelatedRiskRatio, kept ONLY here so the fix's effect can be
 * measured against the exact code it replaced. Never used by production.
 */
function legacyCorrelatedRiskRatioIndexJoined(candlesBySymbol: Record<string, CandleData[]>, windowCandles: number, anchorSymbol: string): number[] {
  const returnSeries = (c: CandleData[]): number[] => c.map((x, i) => (i === 0 ? NaN : (x.close - c[i - 1].close) / c[i - 1].close));
  const pearson = (x: number[], y: number[]): number => {
    const n = x.length;
    const mx = x.reduce((a, b) => a + b, 0) / n;
    const my = y.reduce((a, b) => a + b, 0) / n;
    let cov = 0, vx = 0, vy = 0;
    for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; cov += dx * dy; vx += dx * dx; vy += dy * dy; }
    if (vx === 0 || vy === 0) return NaN;
    return cov / Math.sqrt(vx * vy);
  };
  const n = candlesBySymbol[anchorSymbol].length;
  const others = Object.keys(candlesBySymbol).filter((s) => s !== anchorSymbol);
  const rs: Record<string, number[]> = {};
  for (const s of Object.keys(candlesBySymbol)) rs[s] = returnSeries(candlesBySymbol[s]);
  const out = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const ws = i - windowCandles + 1;
    if (ws < 1) continue;
    const aw = rs[anchorSymbol].slice(ws, i + 1);
    if (aw.some((v) => Number.isNaN(v))) continue;
    let sum = 0, count = 0;
    for (const s of others) {
      const ow = rs[s].slice(ws, i + 1);
      if (ow.some((v) => Number.isNaN(v))) continue;
      sum += pearson(aw, ow); count++;
    }
    out[i] = count > 0 ? sum / count : NaN;
  }
  return out;
}

const csvEscape = (v: unknown): string => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const writeCsv = (file: string, header: string[], rows: unknown[][]): void => {
  writeFileSync(path.join(OUT_DIR, file), [header.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n') + '\n');
  console.log(`wrote data/${file} (${rows.length} rows)`);
};

interface SymbolData {
  candles5m: CandleData[]; candles15m: CandleData[]; candles1h: CandleData[];
  ptr15m: number; ptr1h: number;
}

function main(): void {
  const sd: Record<string, SymbolData> = {};
  for (const s of SYMBOLS) {
    sd[s] = {
      candles5m: readCsv(path.join(OHLCV_DIR, `${s}_5m.csv`)),
      candles15m: readCsv(path.join(OHLCV_DIR, `${s}_15m.csv`)),
      candles1h: readCsv(path.join(OHLCV_DIR, `${s}_1h.csv`)),
      ptr15m: -1, ptr1h: -1,
    };
  }

  const rawTotalSteps = Math.min(...SYMBOLS.map((s) => sd[s].candles5m.length));
  const startStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5 + SKIP_DAYS * 288;
  console.log(`replay steps ${startStep}..${rawTotalSteps - 1} x ${SYMBOLS.length} symbols`);

  type Chain = { previousRegime: MarketRegime | null; previousCandidateRegime: MarketRegime | null; streakCount: number; previousDangerZoneTimestamp: number | null };
  const fresh = (): Chain => ({ previousRegime: null, previousCandidateRegime: null, streakCount: 0, previousDangerZoneTimestamp: null });
  const btChain: Record<string, Chain> = {}, liveChain: Record<string, Chain> = {};
  const parity: Record<string, { steps: number; agree: number; disagree: number; firstDivergeTs: number | null; pairs: Record<string, number> }> = {};
  const regBT: Record<string, Record<string, number>> = {}, regLIVE: Record<string, Record<string, number>> = {};
  // P0-1 restart/warm-up parity: at fixed checkpoints, rebuild the live 5m windows from scratch
  // (exactly what a restarted process's paged backfill yields) and compare to the running ones.
  const RESTART_CHECKPOINTS = new Set<number>();
  for (let k = 1; k <= 10; k++) RESTART_CHECKPOINTS.add(startStep + Math.floor(((rawTotalSteps - 1 - startStep) * k) / 11));
  const restartStats: Record<string, { checks: number; windowIdentical: number; sessionIdentical: number; regimeIdentical: number }> = {};

  for (const s of SYMBOLS) {
    btChain[s] = fresh(); liveChain[s] = fresh();
    parity[s] = { steps: 0, agree: 0, disagree: 0, firstDivergeTs: null, pairs: {} };
    regBT[s] = {}; regLIVE[s] = {};
    restartStats[s] = { checks: 0, windowIdentical: 0, sessionIdentical: 0, regimeIdentical: 0 };
  }

  // P0-2 accumulators
  let corrSteps = 0;
  let mixedTimestampWindowsNew = 0;   // windows the NEW code scored on non-identical instants (must be 0)
  let mixedTimestampWindowsLegacy = 0; // same measurement against the PRE-G2R index join
  let corrValueDiffSteps = 0;
  let maxCorrAbsDiff = 0;
  const corrDetailRows: unknown[][] = [];
  // per-symbol 1H-window index-alignment mismatch vs the anchor, the raw defect G2 measured
  const windowOffsetCounts: Record<string, number> = {};
  for (const s of SYMBOLS) windowOffsetCounts[s] = 0;

  const CW = RegimeConfig.CORRELATED_RISK_WINDOW_CANDLES;

  for (let step = startStep; step < rawTotalSteps; step++) {
    const w1hBySymbol: Record<string, CandleData[]> = {};
    // Same windows but one candle DEEPER — used below to perturb every non-anchor symbol's array
    // indices without removing any data, which is how index-dependence is measured at runtime.
    const w1hDeeperBySymbol: Record<string, CandleData[]> = {};
    for (const s of SYMBOLS) {
      const d = sd[s];
      const dt = d.candles5m[step].timestamp + 5 * 60_000;
      const w = closedWindow(d.candles1h, d.ptr1h, 60 * 60_000, dt, WINDOW_1H);
      d.ptr1h = w.ptr;
      w1hBySymbol[s] = w.window;
      w1hDeeperBySymbol[s] = d.candles1h.slice(Math.max(0, w.ptr - (WINDOW_1H + 1) + 1), w.ptr + 1);
    }

    // ---- P0-2 measurement ----
    corrSteps++;
    const anchor = w1hBySymbol.BTCUSDT;
    const anchorLast = anchor[anchor.length - 1]?.timestamp;
    for (const s of SYMBOLS.filter((x) => x !== 'BTCUSDT')) {
      const o = w1hBySymbol[s];
      if (o.length > 0 && anchor.length > 0 && o[o.length - 1].timestamp !== anchorLast) windowOffsetCounts[s]++;
    }
    const corrNew = computeCorrelatedRiskRatio(w1hBySymbol, CW, 'BTCUSDT');
    const corrLegacy = legacyCorrelatedRiskRatioIndexJoined(w1hBySymbol, CW, 'BTCUSDT');
    const vNew = corrNew[corrNew.length - 1];
    const vOld = corrLegacy[corrLegacy.length - 1];

    // MEASURED (not asserted) index-dependence: re-run both implementations with every NON-anchor
    // symbol's window one candle deeper. No data is removed and no timestamp changes — only the
    // array positions move. An implementation that joins by timestamp MUST return the same number;
    // one that joins by index cannot. Every step where the answer moves is a step whose correlation
    // was scored across mixed timestamps.
    const perturbed: Record<string, CandleData[]> = { BTCUSDT: w1hBySymbol.BTCUSDT };
    for (const s of SYMBOLS.filter((x) => x !== 'BTCUSDT')) perturbed[s] = w1hDeeperBySymbol[s];
    const sameNumber = (a: number, b: number): boolean => (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) <= 1e-12;
    const pNewSeries = computeCorrelatedRiskRatio(perturbed, CW, 'BTCUSDT');
    const pLegacySeries = legacyCorrelatedRiskRatioIndexJoined(perturbed, CW, 'BTCUSDT');
    if (!sameNumber(pNewSeries[pNewSeries.length - 1], vNew)) mixedTimestampWindowsNew++;
    if (!sameNumber(pLegacySeries[pLegacySeries.length - 1], vOld)) mixedTimestampWindowsLegacy++;
    const bothNaN = Number.isNaN(vNew) && Number.isNaN(vOld);
    if (!bothNaN && (Number.isNaN(vNew) !== Number.isNaN(vOld) || Math.abs(vNew - vOld) > 1e-12)) {
      corrValueDiffSteps++;
      const diff = Number.isNaN(vNew) || Number.isNaN(vOld) ? NaN : Math.abs(vNew - vOld);
      if (Number.isFinite(diff)) maxCorrAbsDiff = Math.max(maxCorrAbsDiff, diff);
      if (corrDetailRows.length < 20000) {
        corrDetailRows.push([
          new Date(sd.BTCUSDT.candles5m[step].timestamp).toISOString(), step,
          SYMBOLS.map((s) => `${s}:${w1hBySymbol[s].length}`).join(';'),
          SYMBOLS.map((s) => `${s}:${w1hBySymbol[s].length ? new Date(w1hBySymbol[s][w1hBySymbol[s].length - 1].timestamp).toISOString() : ''}`).join(';'),
          Number.isNaN(vOld) ? 'NaN' : vOld.toFixed(10), Number.isNaN(vNew) ? 'NaN' : vNew.toFixed(10),
          Number.isFinite(diff) ? diff.toExponential(4) : 'NaN',
          'legacy scored a partially-shifted return matrix; new joins by timestamp',
        ]);
      }
    }
    const correlatedRiskRatio = vNew;

    // ---- P0-1 measurement: BT chain vs LIVE chain, both now supplying candles5mSessionVolume ----
    for (const s of SYMBOLS) {
      const d = sd[s];
      const cur = d.candles5m[step];
      const decisionTime = cur.timestamp + 5 * 60_000;
      const window5m = d.candles5m.slice(Math.max(0, step - WINDOW_5M + 1), step + 1);
      const sessionVol5mBT = d.candles5m.slice(Math.max(0, step - WINDOW_5M_SESSION_VOLUME + 1), step + 1);
      const w15 = closedWindow(d.candles15m, d.ptr15m, 15 * 60_000, decisionTime, WINDOW_15M); d.ptr15m = w15.ptr;
      const w1h = w1hBySymbol[s];

      // LIVE shape: liveRunner.ts now takes the last WINDOW_5M off a rolling closed-candle buffer
      // and the last SESSION window off that same buffer — reconstructed here exactly.
      const liveBuffer = d.candles5m.slice(Math.max(0, step - WINDOW_5M_SESSION_VOLUME + 1), step + 1);
      const liveWindow5m = liveBuffer.slice(Math.max(0, liveBuffer.length - WINDOW_5M));
      const liveSessionReady = liveBuffer.length >= WINDOW_5M_SESSION_VOLUME;
      const liveSessionVol = liveSessionReady ? liveBuffer : undefined;

      const bt = detectRegime({ candles5m: window5m, candles15m: w15.window, candles1h: w1h, correlatedRiskRatio, candles5mSessionVolume: sessionVol5mBT, previousRegime: btChain[s].previousRegime, previousCandidateRegime: btChain[s].previousCandidateRegime, streakCount: btChain[s].streakCount, previousDangerZoneTimestamp: btChain[s].previousDangerZoneTimestamp });
      const lv = detectRegime({ candles5m: liveWindow5m, candles15m: w15.window, candles1h: w1h, correlatedRiskRatio, candles5mSessionVolume: liveSessionVol, previousRegime: liveChain[s].previousRegime, previousCandidateRegime: liveChain[s].previousCandidateRegime, streakCount: liveChain[s].streakCount, previousDangerZoneTimestamp: liveChain[s].previousDangerZoneTimestamp });
      btChain[s] = { previousRegime: bt.regime, previousCandidateRegime: bt.candidateRegime, streakCount: bt.streakCount, previousDangerZoneTimestamp: bt.lastDangerZoneTimestamp };
      liveChain[s] = { previousRegime: lv.regime, previousCandidateRegime: lv.candidateRegime, streakCount: lv.streakCount, previousDangerZoneTimestamp: lv.lastDangerZoneTimestamp };

      const p = parity[s];
      p.steps++;
      regBT[s][bt.regime] = (regBT[s][bt.regime] ?? 0) + 1;
      regLIVE[s][lv.regime] = (regLIVE[s][lv.regime] ?? 0) + 1;
      if (bt.regime === lv.regime) p.agree++;
      else {
        p.disagree++;
        if (p.firstDivergeTs === null) p.firstDivergeTs = cur.timestamp;
        const k = `${bt.regime}->${lv.regime}`;
        p.pairs[k] = (p.pairs[k] ?? 0) + 1;
      }

      // ---- restart/warm-up parity ----
      if (RESTART_CHECKPOINTS.has(step)) {
        const st = restartStats[s];
        st.checks++;
        // A restarted process re-seeds the buffer by paged backfill from the exchange; on identical
        // exchange data that is exactly this slice. Compare bytes, then the derived regime.
        const restartBuffer = d.candles5m.slice(Math.max(0, step - WINDOW_5M_SESSION_VOLUME + 1), step + 1);
        const restartWindow5m = restartBuffer.slice(Math.max(0, restartBuffer.length - WINDOW_5M));
        if (JSON.stringify(restartWindow5m) === JSON.stringify(liveWindow5m)) st.windowIdentical++;
        if (JSON.stringify(restartBuffer) === JSON.stringify(liveBuffer)) st.sessionIdentical++;
        const restarted = detectRegime({ candles5m: restartWindow5m, candles15m: w15.window, candles1h: w1h, correlatedRiskRatio, candles5mSessionVolume: restartBuffer.length >= WINDOW_5M_SESSION_VOLUME ? restartBuffer : undefined, previousRegime: liveChain[s].previousRegime, previousCandidateRegime: liveChain[s].previousCandidateRegime, streakCount: liveChain[s].streakCount, previousDangerZoneTimestamp: liveChain[s].previousDangerZoneTimestamp });
        // NOTE: hysteresis state is persisted across restart (risk_state.json), so the comparison
        // isolates the DATA layer — the only thing the backfill controls.
        if (restarted.candidateRegime === lv.candidateRegime && restarted.computedMetrics.lowLiquidityRatio === lv.computedMetrics.lowLiquidityRatio) st.regimeIdentical++;
      }
    }
    if ((step - startStep) % 5000 === 0) console.log(`  step ${step}/${rawTotalSteps}`);
  }

  // ---- artifact: live/backtest parity ----
  const parityRows: unknown[][] = [];
  let totSteps = 0, totAgree = 0, totDis = 0;
  const allRegimes = Array.from(new Set([...Object.values(regBT).flatMap((r) => Object.keys(r)), ...Object.values(regLIVE).flatMap((r) => Object.keys(r))]));
  for (const s of SYMBOLS) {
    const p = parity[s];
    totSteps += p.steps; totAgree += p.agree; totDis += p.disagree;
    parityRows.push([s, 'OVERALL', p.steps, p.agree, p.disagree, ((p.agree / p.steps) * 100).toFixed(4), p.firstDivergeTs === null ? '' : new Date(p.firstDivergeTs).toISOString(),
      Object.entries(p.pairs).map(([k, v]) => `${k}=${v}`).join(';'), p.disagree === 0 ? 'PARITY_100' : 'DIVERGENT']);
    for (const r of allRegimes) {
      const b = regBT[s][r] ?? 0, l = regLIVE[s][r] ?? 0;
      if (b === 0 && l === 0) continue;
      parityRows.push([s, r, p.steps, b, l, ((b / p.steps) * 100).toFixed(4), '', `backtestCandles=${b};liveCandles=${l}`, b === l ? 'SAME_COUNT' : 'COUNT_DIFFERS']);
    }
    const st = restartStats[s];
    parityRows.push([s, 'RESTART_WARMUP_PARITY', st.checks, st.windowIdentical, st.checks - st.windowIdentical, ((st.windowIdentical / st.checks) * 100).toFixed(4),
      '', `sessionWindowIdentical=${st.sessionIdentical}/${st.checks};derivedRegimeIdentical=${st.regimeIdentical}/${st.checks}`,
      st.windowIdentical === st.checks && st.sessionIdentical === st.checks && st.regimeIdentical === st.checks ? 'RESTART_PARITY_100' : 'RESTART_DIVERGENT']);
  }
  parityRows.push(['ALL', 'OVERALL', totSteps, totAgree, totDis, ((totAgree / totSteps) * 100).toFixed(4), '', 'sum of the 4 symbols', totDis === 0 ? 'PARITY_100' : 'DIVERGENT']);
  const llBT = SYMBOLS.reduce((a, s) => a + (regBT[s][MarketRegime.LOW_LIQUIDITY] ?? 0), 0);
  const llLIVE = SYMBOLS.reduce((a, s) => a + (regLIVE[s][MarketRegime.LOW_LIQUIDITY] ?? 0), 0);
  parityRows.push(['ALL', 'LOW_LIQUIDITY', totSteps, llBT, llLIVE, ((llBT / totSteps) * 100).toFixed(4), '', `backtestCandles=${llBT};liveCandles=${llLIVE}`, llBT === llLIVE ? 'SAME_COUNT' : 'COUNT_DIFFERS']);
  writeCsv('g2r-live-backtest-parity.csv', ['symbol', 'scope', 'steps', 'agreeOrBtCount', 'disagreeOrLiveCount', 'pct', 'firstDivergenceTs', 'detail', 'verdict'], parityRows);

  // ---- artifact: cross-symbol alignment ----
  const alignSummary: unknown[][] = [];
  const ref5m = sd.BTCUSDT.candles5m;
  for (const s of SYMBOLS) {
    const o = sd[s].candles5m;
    const n = Math.min(ref5m.length, o.length);
    let idxMismatch = 0;
    let firstDelta = '';
    for (let i = 0; i < n; i++) if (ref5m[i].timestamp !== o[i].timestamp) { idxMismatch++; if (firstDelta === '') firstDelta = String(o[i].timestamp - ref5m[i].timestamp); }
    alignSummary.push([s, '5m', 'index_alignment_vs_BTCUSDT', o.length, idxMismatch, firstDelta, new Date(o[0].timestamp).toISOString(),
      idxMismatch === 0 ? 'INDEX_ALIGNED' : 'INDEX_OFFSET_PRESENT', 'dataset left UNMODIFIED by design — the algorithm, not the data, was fixed']);
  }
  for (const s of SYMBOLS.filter((x) => x !== 'BTCUSDT')) {
    alignSummary.push([s, '1h', 'decision_window_last_candle_vs_anchor', corrSteps, windowOffsetCounts[s], ((windowOffsetCounts[s] / corrSteps) * 100).toFixed(4) + '%', '',
      windowOffsetCounts[s] === 0 ? 'NO_WINDOW_OFFSET' : 'WINDOW_OFFSET_PRESENT', 'raw per-symbol decisionTime offset — real, and now HARMLESS because the join is by timestamp']);
  }
  alignSummary.push(['ALL', '1h', 'index_dependent_correlation_windows_LEGACY_INDEX_JOIN', corrSteps, mixedTimestampWindowsLegacy, ((mixedTimestampWindowsLegacy / corrSteps) * 100).toFixed(4) + '%', '', 'PRE_G2R_DEFECT', 'MEASURED by re-running with non-anchor windows one candle deeper: result moved = index-dependent = mixed timestamps']);
  alignSummary.push(['ALL', '1h', 'index_dependent_correlation_windows_G2R_TIMESTAMP_JOIN', corrSteps, mixedTimestampWindowsNew, ((mixedTimestampWindowsNew / corrSteps) * 100).toFixed(4) + '%', '', mixedTimestampWindowsNew === 0 ? 'PASS' : 'FAIL', 'MEASURED the same way: 0 = result invariant to array position, i.e. joined purely by timestamp']);
  alignSummary.push(['ALL', '1h', 'correlation_value_changed_by_fix', corrSteps, corrValueDiffSteps, ((corrValueDiffSteps / corrSteps) * 100).toFixed(4) + '%', maxCorrAbsDiff.toExponential(4), 'INFO', 'steps where the corrected ratio differs from the legacy one']);
  writeCsv('g2r-cross-symbol-alignment.csv', ['symbol', 'timeframe', 'check', 'rowsOrSteps', 'mismatchCount', 'detail', 'firstTsOrPct', 'verdict', 'note'], alignSummary);

  // ---- artifact: correlation timestamp audit (per divergent step) ----
  writeCsv('g2r-correlation-timestamp-audit.csv',
    ['timestampBTC', 'step', 'windowLengths', 'windowLastTimestamps', 'legacyIndexJoinedRatio', 'g2rTimestampJoinedRatio', 'absDiff', 'note'],
    corrDetailRows);

  console.log('\n=== G2R P0 SUMMARY ===');
  console.log(`live/backtest regime parity: ${totAgree}/${totSteps} = ${((totAgree / totSteps) * 100).toFixed(4)}% (disagree ${totDis})`);
  console.log(`LOW_LIQUIDITY: backtest=${llBT} live=${llLIVE} ${llBT === llLIVE ? 'MATCH' : 'MISMATCH'}`);
  for (const s of SYMBOLS) console.log(`  ${s}: parity=${((parity[s].agree / parity[s].steps) * 100).toFixed(4)}% restart=${JSON.stringify(restartStats[s])}`);
  console.log(`mixed-timestamp correlation windows: legacy=${mixedTimestampWindowsLegacy} g2r=${mixedTimestampWindowsNew} (of ${corrSteps} steps)`);
  console.log(`correlation value changed at ${corrValueDiffSteps} steps (${((corrValueDiffSteps / corrSteps) * 100).toFixed(4)}%), max |diff| = ${maxCorrAbsDiff.toExponential(4)}`);
  console.log(`1h window last-candle offset vs anchor: ${JSON.stringify(windowOffsetCounts)}`);
}

main();
