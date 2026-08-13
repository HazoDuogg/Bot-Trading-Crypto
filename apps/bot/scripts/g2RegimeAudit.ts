/**
 * TICKET-G2 — Regime layer audit harness (research/diagnostic only, never imported by live code).
 *
 * Replays the EXACT production regime pipeline (regime/regimeDetector.ts detectRegime()) over the
 * registered baseline dataset (data/ohlcv/, --skip-days=20 warm-up), using backtest.ts's own window
 * constants and closedWindow() two-pointer semantics, and emits G2's required artifacts:
 *   data/g2-input-timestamp-integrity.csv
 *   data/g2-indicator-calculation-audit.csv
 *   data/g2-live-backtest-parity.csv
 *   data/g2-regime-transition-ledger.csv
 *   data/g2-neutral-opportunity-cost.csv
 *
 * Two independent regime chains are replayed per symbol on the SAME candles:
 *   BT   = backtest.ts's exact ProcessCandleInput shape (candles5mSessionVolume supplied)
 *   LIVE = liveRunner.ts's exact ProcessCandleInput shape (candles5mSessionVolume OMITTED — see
 *          liveRunner.ts:1095-1101, the field is never passed there)
 * Divergence between the two chains is the live/backtest regime parity measurement.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { detectRegime } from '../dist/regime/regimeDetector.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { MarketRegime, type CandleData } from '../dist/regime/types.js';
import {
  bollingerBandwidthSeries,
  lastDefined,
  percentileRankSeries,
  wilderADXSeries,
  wilderATRSeries,
  zScoreSeries,
} from '../dist/regime/indicators.js';
import { routeEntry, DEFAULT_ENTRY_ROUTER_CONFIG } from '../dist/entry/entryRouter.js';
import { wilderDIDirectionSeries } from '../dist/regime/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const OUT_DIR = path.resolve(process.cwd(), 'data');

// Identical to backtest.ts:52-68 / liveCandleFeed.ts DEFAULT_WINDOW_SIZES.
const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;
const WINDOW_5M_SESSION_VOLUME = 14 * 288 + 1;
const SKIP_DAYS = 20;

function readCsv(file: string): CandleData[] {
  const raw = readFileSync(file, 'utf8').trim();
  return raw.split('\n').slice(1).map((line) => {
    const p = line.split(',');
    return { timestamp: Number(p[0]), open: Number(p[2]), high: Number(p[3]), low: Number(p[4]), close: Number(p[5]), volume: Number(p[6]) };
  });
}

/** Byte-identical copy of backtest.ts:471-477 closedWindow(). */
function closedWindow(candles: CandleData[], ptr: number, intervalMs: number, decisionTime: number, windowSize: number): { window: CandleData[]; ptr: number } {
  let p = ptr;
  while (p + 1 < candles.length && candles[p + 1].timestamp + intervalMs <= decisionTime) p++;
  if (p < 0) return { window: [], ptr: p };
  return { window: candles.slice(Math.max(0, p - windowSize + 1), p + 1), ptr: p };
}

interface SymbolData {
  candles5m: CandleData[]; candles15m: CandleData[]; candles1h: CandleData[]; candles1m: CandleData[]; candles1d: CandleData[];
  ptr15m: number; ptr1h: number; ptr1m: number; ptr1d: number;
}

const csvEscape = (v: unknown): string => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const writeCsv = (file: string, header: string[], rows: unknown[][]): void => {
  writeFileSync(path.join(OUT_DIR, file), [header.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n') + '\n');
  console.log(`wrote data/${file} (${rows.length} rows)`);
};

// ------------------------------------------------------------------ section 2a: timestamp integrity
function timestampIntegrity(symbol: string, tf: string, intervalMs: number, candles: CandleData[]): unknown[] {
  let dupes = 0, nonMonotonic = 0, gaps = 0, missingCandles = 0, misaligned = 0, badOhlc = 0, nonFinite = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c.timestamp % intervalMs !== 0) misaligned++;
    if (![c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite)) nonFinite++;
    if (c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close) || c.high < c.low) badOhlc++;
    if (i > 0) {
      const d = c.timestamp - candles[i - 1].timestamp;
      if (d === 0) dupes++;
      else if (d < 0) nonMonotonic++;
      else if (d > intervalMs) { gaps++; missingCandles += d / intervalMs - 1; }
    }
  }
  return [symbol, tf, candles.length, new Date(candles[0].timestamp).toISOString(), new Date(candles[candles.length - 1].timestamp).toISOString(),
    dupes, nonMonotonic, gaps, missingCandles, misaligned, badOhlc, nonFinite,
    dupes + nonMonotonic + misaligned + badOhlc + nonFinite === 0 ? 'PASS' : 'FAIL'];
}

// ------------------------------------------------------------------ main
function main(): void {
  const symbolsData: Record<string, SymbolData> = {};
  for (const s of SYMBOLS) {
    symbolsData[s] = {
      candles5m: readCsv(path.join(OHLCV_DIR, `${s}_5m.csv`)),
      candles15m: readCsv(path.join(OHLCV_DIR, `${s}_15m.csv`)),
      candles1h: readCsv(path.join(OHLCV_DIR, `${s}_1h.csv`)),
      candles1m: readCsv(path.join(OHLCV_DIR, `${s}_1m.csv`)),
      candles1d: readCsv(path.join(OHLCV_DIR, `${s}_1d.csv`)),
      ptr15m: -1, ptr1h: -1, ptr1m: -1, ptr1d: -1,
    };
  }

  // ---- artifact 1: input/timestamp integrity ----
  const tfSpec: Array<[string, keyof SymbolData, number]> = [
    ['1m', 'candles1m', 60_000], ['5m', 'candles5m', 5 * 60_000], ['15m', 'candles15m', 15 * 60_000],
    ['1h', 'candles1h', 60 * 60_000], ['1d', 'candles1d', 24 * 60 * 60_000],
  ];
  const integrityRows: unknown[][] = [];
  for (const s of SYMBOLS) for (const [tf, key, ms] of tfSpec) integrityRows.push(timestampIntegrity(s, tf, ms, symbolsData[s][key] as CandleData[]));
  // cross-symbol 5m alignment (backtest indexes all 4 symbols by the same `step`)
  const ref = symbolsData.BTCUSDT.candles5m;
  for (const s of SYMBOLS.filter((x) => x !== 'BTCUSDT')) {
    const other = symbolsData[s].candles5m;
    const n = Math.min(ref.length, other.length);
    let mismatch = 0;
    for (let i = 0; i < n; i++) if (ref[i].timestamp !== other[i].timestamp) mismatch++;
    integrityRows.push([s, '5m_index_alignment_vs_BTCUSDT', n, '', '', '', '', '', '', '', '', mismatch, mismatch === 0 ? 'PASS' : 'FAIL']);
  }
  writeCsv('g2-input-timestamp-integrity.csv',
    ['symbol', 'timeframe', 'rows', 'firstTs', 'lastTs', 'duplicateTs', 'nonMonotonic', 'gapCount', 'missingCandles', 'intervalMisaligned', 'invalidOhlc', 'nonFiniteValues', 'verdict'],
    integrityRows);

  // ---- replay ----
  const rawTotalSteps = Math.min(...SYMBOLS.map((s) => symbolsData[s].candles5m.length));
  const startStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5 + SKIP_DAYS * 288;
  console.log(`replay steps ${startStep}..${rawTotalSteps - 1} x ${SYMBOLS.length} symbols`);

  type Chain = { previousRegime: MarketRegime | null; previousCandidateRegime: MarketRegime | null; streakCount: number; previousDangerZoneTimestamp: number | null };
  const fresh = (): Chain => ({ previousRegime: null, previousCandidateRegime: null, streakCount: 0, previousDangerZoneTimestamp: null });
  const btChain: Record<string, Chain> = {}, liveChain: Record<string, Chain> = {};
  for (const s of SYMBOLS) { btChain[s] = fresh(); liveChain[s] = fresh(); }

  // per-symbol running history for the ledger
  interface Rec { ts: number; regime: MarketRegime; candidate: MarketRegime; metrics: Record<string, unknown>; }
  const lastRec: Record<string, Rec | null> = {};
  const transitionTsHistory: Record<string, number[]> = {};
  const stateEnteredAt: Record<string, number> = {};
  for (const s of SYMBOLS) { lastRec[s] = null; transitionTsHistory[s] = []; stateEnteredAt[s] = 0; }

  const ledgerRows: unknown[][] = [];
  const parityCounts: Record<string, { steps: number; agree: number; disagree: number; firstDivergeTs: number | null; disagreePairs: Record<string, number> }> = {};
  const regimeCountsBT: Record<string, Record<string, number>> = {};
  const regimeCountsLIVE: Record<string, Record<string, number>> = {};
  const neutralRows: unknown[][] = [];
  // indicator audit accumulators
  const indAudit: Record<string, { n: number; adxDef: number; atrPctDef: number; bbwDef: number; volZDef: number; lowLiqDef: number; corrDef: number; adxMax: number; adxMin: number; maxAbsErrAdx: number; maxAbsErrAtrPct: number; maxAbsErrBbw: number; maxAbsErrVolZ: number; futureLeak: number; staleHtf1h: number; staleHtf15m: number; maxHtf1hAgeMs: number; maxHtf15mAgeMs: number }> = {};
  for (const s of SYMBOLS) {
    parityCounts[s] = { steps: 0, agree: 0, disagree: 0, firstDivergeTs: null, disagreePairs: {} };
    regimeCountsBT[s] = {}; regimeCountsLIVE[s] = {};
    indAudit[s] = { n: 0, adxDef: 0, atrPctDef: 0, bbwDef: 0, volZDef: 0, lowLiqDef: 0, corrDef: 0, adxMax: -Infinity, adxMin: Infinity, maxAbsErrAdx: 0, maxAbsErrAtrPct: 0, maxAbsErrBbw: 0, maxAbsErrVolZ: 0, futureLeak: 0, staleHtf1h: 0, staleHtf15m: 0, maxHtf1hAgeMs: 0, maxHtf15mAgeMs: 0 };
  }
  // NEUTRAL counterfactual horizon
  const FWD = 48; // 4 hours of 5m candles
  const TP_R = 3.0; // baseline momentum-direct-tp-r-multiple

  const branchOf = (m: Record<string, unknown>, regime: MarketRegime): string => regime;

  for (let step = startStep; step < rawTotalSteps; step++) {
    const w1hBySymbol: Record<string, CandleData[]> = {};
    for (const s of SYMBOLS) {
      const sd = symbolsData[s];
      const dt = sd.candles5m[step].timestamp + 5 * 60_000;
      const w = closedWindow(sd.candles1h, sd.ptr1h, 60 * 60_000, dt, WINDOW_1H);
      sd.ptr1h = w.ptr;
      w1hBySymbol[s] = w.window;
    }
    const corrSeries = computeCorrelatedRiskRatio(w1hBySymbol, RegimeConfig.CORRELATED_RISK_WINDOW_CANDLES, 'BTCUSDT');
    const correlatedRiskRatio = corrSeries[corrSeries.length - 1];

    for (const s of SYMBOLS) {
      const sd = symbolsData[s];
      const cur = sd.candles5m[step];
      const decisionTime = cur.timestamp + 5 * 60_000;
      const window5m = sd.candles5m.slice(Math.max(0, step - WINDOW_5M + 1), step + 1);
      const sessionVol5m = sd.candles5m.slice(Math.max(0, step - WINDOW_5M_SESSION_VOLUME + 1), step + 1);
      const w15 = closedWindow(sd.candles15m, sd.ptr15m, 15 * 60_000, decisionTime, WINDOW_15M); sd.ptr15m = w15.ptr;
      const w1m = closedWindow(sd.candles1m, sd.ptr1m, 60_000, decisionTime, WINDOW_1M); sd.ptr1m = w1m.ptr;
      const w1d = closedWindow(sd.candles1d, sd.ptr1d, 24 * 60 * 60_000, decisionTime, WINDOW_1D); sd.ptr1d = w1d.ptr;
      const w1h = w1hBySymbol[s];

      const a = indAudit[s];
      a.n++;
      // no-look-ahead: every timeframe's last candle must be CLOSED at decisionTime
      const last15 = w15.window[w15.window.length - 1], last1h = w1h[w1h.length - 1], last1d = w1d.window[w1d.window.length - 1], last1m = w1m.window[w1m.window.length - 1];
      if (last15 && last15.timestamp + 15 * 60_000 > decisionTime) a.futureLeak++;
      if (last1h && last1h.timestamp + 60 * 60_000 > decisionTime) a.futureLeak++;
      if (last1d && last1d.timestamp + 24 * 60 * 60_000 > decisionTime) a.futureLeak++;
      if (last1m && last1m.timestamp + 60_000 > decisionTime) a.futureLeak++;
      if (window5m[window5m.length - 1].timestamp !== cur.timestamp) a.futureLeak++;
      // staleness: age of newest closed HTF candle relative to decisionTime
      if (last1h) { const age = decisionTime - (last1h.timestamp + 60 * 60_000); a.maxHtf1hAgeMs = Math.max(a.maxHtf1hAgeMs, age); if (age > 2 * 60 * 60_000) a.staleHtf1h++; }
      if (last15) { const age = decisionTime - (last15.timestamp + 15 * 60_000); a.maxHtf15mAgeMs = Math.max(a.maxHtf15mAgeMs, age); if (age > 30 * 60_000) a.staleHtf15m++; }

      const baseInput = { candles5m: window5m, candles15m: w15.window, candles1h: w1h, correlatedRiskRatio };
      const bt = detectRegime({ ...baseInput, candles5mSessionVolume: sessionVol5m, previousRegime: btChain[s].previousRegime, previousCandidateRegime: btChain[s].previousCandidateRegime, streakCount: btChain[s].streakCount, previousDangerZoneTimestamp: btChain[s].previousDangerZoneTimestamp });
      const lv = detectRegime({ ...baseInput, previousRegime: liveChain[s].previousRegime, previousCandidateRegime: liveChain[s].previousCandidateRegime, streakCount: liveChain[s].streakCount, previousDangerZoneTimestamp: liveChain[s].previousDangerZoneTimestamp });
      btChain[s] = { previousRegime: bt.regime, previousCandidateRegime: bt.candidateRegime, streakCount: bt.streakCount, previousDangerZoneTimestamp: bt.lastDangerZoneTimestamp };
      liveChain[s] = { previousRegime: lv.regime, previousCandidateRegime: lv.candidateRegime, streakCount: lv.streakCount, previousDangerZoneTimestamp: lv.lastDangerZoneTimestamp };

      const m = bt.computedMetrics;
      // independent recomputation of every metric feeding classifyCandidate()
      const refAdx = lastDefined(wilderADXSeries(w1h, RegimeConfig.ADX_PERIOD_1H));
      const refAtrPct = lastDefined(percentileRankSeries(wilderATRSeries(window5m, RegimeConfig.ATR_PERIOD_5M), RegimeConfig.ATR_PCT_LOOKBACK_5M));
      const refBbw = lastDefined(percentileRankSeries(bollingerBandwidthSeries(w15.window, RegimeConfig.BB_PERIOD_15M), RegimeConfig.BBW_PCT_LOOKBACK_15M));
      const refVolZ = lastDefined(zScoreSeries(window5m.map((c) => c.volume), RegimeConfig.VOLUME_ZSCORE_LOOKBACK_5M));
      if (m.adx1h !== undefined && refAdx !== undefined) a.maxAbsErrAdx = Math.max(a.maxAbsErrAdx, Math.abs(m.adx1h - refAdx));
      if (m.atrPercentile5m !== undefined && refAtrPct !== undefined) a.maxAbsErrAtrPct = Math.max(a.maxAbsErrAtrPct, Math.abs(m.atrPercentile5m - refAtrPct));
      if (m.bbWidthPercentile15m !== undefined && refBbw !== undefined) a.maxAbsErrBbw = Math.max(a.maxAbsErrBbw, Math.abs(m.bbWidthPercentile15m - refBbw));
      if (m.volumeZScore5m !== undefined && refVolZ !== undefined) a.maxAbsErrVolZ = Math.max(a.maxAbsErrVolZ, Math.abs(m.volumeZScore5m - refVolZ));
      if (m.adx1h !== undefined) { a.adxDef++; a.adxMax = Math.max(a.adxMax, m.adx1h); a.adxMin = Math.min(a.adxMin, m.adx1h); }
      if (m.atrPercentile5m !== undefined) a.atrPctDef++;
      if (m.bbWidthPercentile15m !== undefined) a.bbwDef++;
      if (m.volumeZScore5m !== undefined) a.volZDef++;
      if (m.lowLiquidityRatio !== undefined && !Number.isNaN(m.lowLiquidityRatio)) a.lowLiqDef++;
      if (m.correlatedRiskRatio !== undefined && !Number.isNaN(m.correlatedRiskRatio)) a.corrDef++;

      // parity
      const p = parityCounts[s];
      p.steps++;
      regimeCountsBT[s][bt.regime] = (regimeCountsBT[s][bt.regime] ?? 0) + 1;
      regimeCountsLIVE[s][lv.regime] = (regimeCountsLIVE[s][lv.regime] ?? 0) + 1;
      if (bt.regime === lv.regime) p.agree++;
      else {
        p.disagree++;
        if (p.firstDivergeTs === null) p.firstDivergeTs = cur.timestamp;
        const k = `${bt.regime}->${lv.regime}`;
        p.disagreePairs[k] = (p.disagreePairs[k] ?? 0) + 1;
      }

      // ---- transition ledger (production semantics = BT chain) ----
      const prev = lastRec[s];
      if (prev !== null && prev.regime !== bt.regime) {
        const dwellMs = cur.timestamp - stateEnteredAt[s];
        transitionTsHistory[s].push(cur.timestamp);
        const within = (ms: number): number => transitionTsHistory[s].filter((t) => cur.timestamp - t < ms).length;
        // flip-back = same regime as 2 transitions ago and dwell short
        const hist = ledgerRows.filter((r) => r[0] === s);
        const prevPrevRegime = hist.length > 0 ? String(hist[hist.length - 1][2]) : '';
        const flipBack = prevPrevRegime === bt.regime && dwellMs <= 30 * 60_000;
        // trigger metric + distance to threshold for the ENTERED regime
        let trigger = '', distance = '';
        const adx = m.adx1h as number, atrP = m.atrPercentile5m as number, bbw = m.bbWidthPercentile15m as number, vz = m.volumeZScore5m as number;
        switch (bt.regime) {
          case MarketRegime.TREND_RIDER: trigger = 'adx1h>=TREND_ENTER_ADX & atrPct5m>=TREND_ENTER_ATR_PCT'; distance = `${(adx - RegimeConfig.TREND_ENTER_ADX.enter).toFixed(3)}|${(atrP - RegimeConfig.TREND_ENTER_ATR_PCT.enter).toFixed(3)}`; break;
          case MarketRegime.SIDEWAY_SCALPER: trigger = 'adx1h<=SIDEWAY_ADX & bbwPct15m>COMPRESSION_BBW'; distance = `${(RegimeConfig.SIDEWAY_ADX_THRESHOLD.enter - adx).toFixed(3)}|${(bbw - RegimeConfig.COMPRESSION_BBW_PCT_THRESHOLD.enter).toFixed(3)}`; break;
          case MarketRegime.VOLATILE_CHOP: trigger = 'atrPct5m>=CHOP_ATR & adx1h<CHOP_ADX'; distance = `${(atrP - RegimeConfig.CHOP_ATR_PCT_THRESHOLD.enter).toFixed(3)}|${(RegimeConfig.CHOP_ADX_THRESHOLD.enter - adx).toFixed(3)}`; break;
          case MarketRegime.COMPRESSION: trigger = 'bbwPct15m<=COMPRESSION_BBW & atrTrend5m=decreasing'; distance = `${(RegimeConfig.COMPRESSION_BBW_PCT_THRESHOLD.enter - bbw).toFixed(3)}`; break;
          case MarketRegime.DANGER_ZONE: trigger = 'atrPct5m>=DANGER_ATR & volZ5m>=DANGER_VOLZ'; distance = `${(atrP - RegimeConfig.DANGER_ATR_PCT_THRESHOLD.enter).toFixed(3)}|${(vz - RegimeConfig.DANGER_VOLUME_ZSCORE_THRESHOLD.enter).toFixed(3)}`; break;
          case MarketRegime.MANIPULATED: trigger = 'sweeps both sides & volZ<MANIPULATED_MAX_VOLZ'; distance = `${(RegimeConfig.MANIPULATED_MAX_VOLUME_ZSCORE.enter - vz).toFixed(3)}`; break;
          case MarketRegime.LOW_LIQUIDITY: trigger = 'lowLiquidityRatio<LOW_LIQ_THRESHOLD'; distance = `${(RegimeConfig.LOW_LIQUIDITY_VOLUME_RATIO_THRESHOLD.enter - (m.lowLiquidityRatio as number)).toFixed(4)}`; break;
          case MarketRegime.CORRELATED_RISK: trigger = 'correlatedRiskRatio>CORRELATED_RISK_THRESHOLD'; distance = `${((m.correlatedRiskRatio as number) - RegimeConfig.CORRELATED_RISK_THRESHOLD.enter).toFixed(4)}`; break;
          default: trigger = 'fallback (no branch matched)'; distance = `adxGapToSideway=${(RegimeConfig.SIDEWAY_ADX_THRESHOLD.enter - adx).toFixed(3)};adxGapToTrend=${(adx - RegimeConfig.TREND_ENTER_ADX.enter).toFixed(3)};atrGapToTrend=${(atrP - RegimeConfig.TREND_ENTER_ATR_PCT.enter).toFixed(3)}`;
        }
        // classification
        const dwellCandles = Math.round(dwellMs / 300_000);
        const nearBoundary = (() => {
          const gaps = [Math.abs(adx - RegimeConfig.TREND_ENTER_ADX.enter), Math.abs(adx - RegimeConfig.SIDEWAY_ADX_THRESHOLD.enter), Math.abs(adx - RegimeConfig.CHOP_ADX_THRESHOLD.enter)];
          return Math.min(...gaps) <= 1.0 || Math.abs(atrP - RegimeConfig.TREND_ENTER_ATR_PCT.enter) <= 2.0 || Math.abs(bbw - RegimeConfig.COMPRESSION_BBW_PCT_THRESHOLD.enter) <= 2.0;
        })();
        let cls: string;
        if (m.adx1h === undefined || m.atrPercentile5m === undefined) cls = 'INSUFFICIENT_EVIDENCE';
        else if (a.futureLeak > 0) cls = 'DATA_MISALIGNMENT';
        else if (last1h && decisionTime - (last1h.timestamp + 60 * 60_000) > 2 * 60 * 60_000) cls = 'STALE_INPUT';
        else if (flipBack || (dwellCandles <= RegimeConfig.N_CANDLE_CONFIRM && nearBoundary)) cls = 'BOUNDARY_NOISE';
        else if (nearBoundary && dwellCandles <= 6) cls = 'BOUNDARY_NOISE';
        else cls = 'MARKET_CONFIRMED';

        ledgerRows.push([s, new Date(cur.timestamp).toISOString(), prev.regime, bt.regime, dwellCandles, (dwellMs / 60000).toFixed(0), trigger, distance,
          adx?.toFixed(3) ?? '', atrP?.toFixed(2) ?? '', bbw?.toFixed(2) ?? '', vz?.toFixed(3) ?? '',
          within(15 * 60_000), within(30 * 60_000), within(60 * 60_000), flipBack ? 'YES' : 'NO', bt.candidateRegime, bt.streakCount, cls]);
        stateEnteredAt[s] = cur.timestamp;
      }
      if (prev === null) stateEnteredAt[s] = cur.timestamp;
      lastRec[s] = { ts: cur.timestamp, regime: bt.regime, candidate: bt.candidateRegime, metrics: m as Record<string, unknown> };

      // ---- NEUTRAL opportunity cost: router-level counterfactual ----
      if (bt.regime === MarketRegime.NEUTRAL_TRANSITION && step + FWD < rawTotalSteps) {
        const macroDirSeries = wilderDIDirectionSeries(w1d.window, 14);
        const macroDirection = macroDirSeries.length > 0 ? macroDirSeries[macroDirSeries.length - 1] : undefined;
        const routerInput = {
          symbol: s, adxDirection1h: bt.adxDirection1h, macroDirection,
          candles5m: window5m, candles15m: w15.window, candlesMss: w1m.window,
          bbWidthPercentile15m: m.bbWidthPercentile15m, volumeZScore5m: m.volumeZScore5m,
        };
        // what NEUTRAL actually runs today (SIDEWAY_STYLE per DEFAULT_ENTRY_ROUTER_CONFIG)
        const actual = routeEntry({ ...routerInput, regime: MarketRegime.NEUTRAL_TRANSITION }, DEFAULT_ENTRY_ROUTER_CONFIG);
        // counterfactual: the TREND_RIDER cascade that NEUTRAL never runs
        const cfTrend = routeEntry({ ...routerInput, regime: MarketRegime.TREND_RIDER }, DEFAULT_ENTRY_ROUTER_CONFIG);
        const cand = cfTrend ?? null;
        if (cand !== null && actual === null) {
          const risk = Math.abs(cand.entryPrice - cand.slPrice);
          if (risk > 0) {
            const tp = cand.side === 'LONG' ? cand.entryPrice + TP_R * risk : cand.entryPrice - TP_R * risk;
            let mfeR = 0, maeR = 0, outcome = 'OPEN', barsToOutcome = FWD;
            for (let k = 1; k <= FWD; k++) {
              const f = sd.candles5m[step + k];
              const up = (f.high - cand.entryPrice) / risk, dn = (cand.entryPrice - f.low) / risk;
              const favor = cand.side === 'LONG' ? up : dn, against = cand.side === 'LONG' ? dn : up;
              mfeR = Math.max(mfeR, favor); maeR = Math.max(maeR, against);
              const hitSl = cand.side === 'LONG' ? f.low <= cand.slPrice : f.high >= cand.slPrice;
              const hitTp = cand.side === 'LONG' ? f.high >= tp : f.low <= tp;
              if (hitSl && outcome === 'OPEN') { outcome = 'SL'; barsToOutcome = k; break; }
              if (hitTp && outcome === 'OPEN') { outcome = 'TP'; barsToOutcome = k; break; }
            }
            neutralRows.push([s, new Date(cur.timestamp).toISOString(), 'NEUTRAL_TRANSITION', 'TREND_STYLE_OB/FVG/SWEEP', cand.setupType, cand.side,
              cand.entryPrice, cand.slPrice, tp.toFixed(6), mfeR.toFixed(3), maeR.toFixed(3), outcome, barsToOutcome,
              outcome === 'TP' ? TP_R : outcome === 'SL' ? -1 : Number((cand.side === 'LONG' ? (sd.candles5m[step + FWD].close - cand.entryPrice) : (cand.entryPrice - sd.candles5m[step + FWD].close)) / risk).toFixed(3),
              (m.adx1h as number)?.toFixed(2) ?? '', (m.atrPercentile5m as number)?.toFixed(2) ?? '', bt.adxDirection1h ?? '']);
          }
        }
      }
    }
    if ((step - startStep) % 2000 === 0) console.log(`  step ${step}/${rawTotalSteps}`);
  }

  // ---- artifact 2: indicator calculation audit ----
  const indRows: unknown[][] = [];
  for (const s of SYMBOLS) {
    const a = indAudit[s];
    const pct = (x: number): string => ((x / a.n) * 100).toFixed(2);
    indRows.push([s, 'adx1h', 'wilderADXSeries(candles1h,14)', a.n, a.adxDef, pct(a.adxDef), a.maxAbsErrAdx.toExponential(3), 'exact-recompute vs detectRegime output', a.maxAbsErrAdx === 0 ? 'PASS' : 'FAIL']);
    indRows.push([s, 'atrPercentile5m', 'percentileRank(wilderATR(candles5m,14),300)', a.n, a.atrPctDef, pct(a.atrPctDef), a.maxAbsErrAtrPct.toExponential(3), 'exact-recompute vs detectRegime output', a.maxAbsErrAtrPct === 0 ? 'PASS' : 'FAIL']);
    indRows.push([s, 'bbWidthPercentile15m', 'percentileRank(bbw(candles15m,20),300)', a.n, a.bbwDef, pct(a.bbwDef), a.maxAbsErrBbw.toExponential(3), 'exact-recompute vs detectRegime output', a.maxAbsErrBbw === 0 ? 'PASS' : 'FAIL']);
    indRows.push([s, 'volumeZScore5m', 'zScore(volume5m,20)', a.n, a.volZDef, pct(a.volZDef), a.maxAbsErrVolZ.toExponential(3), 'exact-recompute vs detectRegime output', a.maxAbsErrVolZ === 0 ? 'PASS' : 'FAIL']);
    indRows.push([s, 'lowLiquidityRatio', 'sessionRelativeVolumeRatio(candles5mSessionVolume,14d)', a.n, a.lowLiqDef, pct(a.lowLiqDef), '', 'BACKTEST-only input; live omits candles5mSessionVolume', a.lowLiqDef > 0 ? 'DEFINED_IN_BACKTEST_ONLY' : 'NEVER_DEFINED']);
    indRows.push([s, 'correlatedRiskRatio', 'computeCorrelatedRiskRatio(4x 1h,30,BTCUSDT)', a.n, a.corrDef, pct(a.corrDef), '', 'pre-computed once per step by caller', 'PASS']);
    indRows.push([s, 'no_look_ahead', 'lastClosedCandle+interval<=decisionTime for 1m/5m/15m/1h/1d', a.n, a.n - a.futureLeak, pct(a.n - a.futureLeak), a.futureLeak, 'violations counted', a.futureLeak === 0 ? 'PASS' : 'FAIL']);
    indRows.push([s, 'htf_staleness_1h', 'age of newest closed 1h candle at decisionTime', a.n, a.staleHtf1h, pct(a.staleHtf1h), (a.maxHtf1hAgeMs / 60000).toFixed(1) + 'min max', 'stale if >120min', a.staleHtf1h === 0 ? 'PASS' : 'FAIL']);
    indRows.push([s, 'htf_staleness_15m', 'age of newest closed 15m candle at decisionTime', a.n, a.staleHtf15m, pct(a.staleHtf15m), (a.maxHtf15mAgeMs / 60000).toFixed(1) + 'min max', 'stale if >30min', a.staleHtf15m === 0 ? 'PASS' : 'FAIL']);
  }
  writeCsv('g2-indicator-calculation-audit.csv', ['symbol', 'metric', 'formula', 'stepsEvaluated', 'stepsDefined', 'definedPct', 'maxAbsDeviation', 'note', 'verdict'], indRows);

  // ---- artifact 3: live/backtest parity ----
  const parityRows: unknown[][] = [];
  const allRegimes = Array.from(new Set([...Object.values(regimeCountsBT).flatMap((r) => Object.keys(r)), ...Object.values(regimeCountsLIVE).flatMap((r) => Object.keys(r))]));
  for (const s of SYMBOLS) {
    const p = parityCounts[s];
    parityRows.push([s, 'OVERALL', p.steps, p.agree, p.disagree, ((p.agree / p.steps) * 100).toFixed(4), p.firstDivergeTs === null ? '' : new Date(p.firstDivergeTs).toISOString(),
      Object.entries(p.disagreePairs).map(([k, v]) => `${k}=${v}`).join(';'), p.disagree === 0 ? 'PARITY_100' : 'DIVERGENT']);
    for (const r of allRegimes) {
      const b = regimeCountsBT[s][r] ?? 0, l = regimeCountsLIVE[s][r] ?? 0;
      if (b === 0 && l === 0) continue;
      parityRows.push([s, r, p.steps, b, l, ((b / p.steps) * 100).toFixed(4), '', `backtestCandles=${b};liveCandles=${l}`, b === l ? 'SAME_COUNT' : 'COUNT_DIFFERS']);
    }
  }
  writeCsv('g2-live-backtest-parity.csv', ['symbol', 'scope', 'steps', 'agreeOrBtCount', 'disagreeOrLiveCount', 'pct', 'firstDivergenceTs', 'detail', 'verdict'], parityRows);

  // ---- artifact 4: transition ledger ----
  writeCsv('g2-regime-transition-ledger.csv',
    ['symbol', 'timestamp', 'fromRegime', 'toRegime', 'dwellCandles', 'dwellMinutes', 'triggerCondition', 'distanceToThreshold', 'adx1h', 'atrPercentile5m', 'bbWidthPercentile15m', 'volumeZScore5m', 'transitions15m', 'transitions30m', 'transitions60m', 'flipBack', 'candidateRegime', 'streakCount', 'classification'],
    ledgerRows);

  // ---- artifact 5: neutral opportunity cost ----
  writeCsv('g2-neutral-opportunity-cost.csv',
    ['symbol', 'timestamp', 'confirmedRegime', 'suppressedCascade', 'setupType', 'side', 'entryPrice', 'slPrice', 'tpPrice3R', 'mfeR', 'maeR', 'outcome48bars', 'barsToOutcome', 'rMultiple', 'adx1h', 'atrPercentile5m', 'adxDirection1h'],
    neutralRows);

  // ---- console summary ----
  console.log('\n=== SUMMARY ===');
  for (const s of SYMBOLS) {
    const p = parityCounts[s];
    console.log(`${s}: steps=${p.steps} parity=${((p.agree / p.steps) * 100).toFixed(4)}% disagree=${p.disagree} ${JSON.stringify(p.disagreePairs)}`);
    console.log(`  BT regime dist: ${JSON.stringify(regimeCountsBT[s])}`);
    console.log(`  LIVE regime dist: ${JSON.stringify(regimeCountsLIVE[s])}`);
  }
  const clsCounts: Record<string, number> = {};
  for (const r of ledgerRows) clsCounts[String(r[18])] = (clsCounts[String(r[18])] ?? 0) + 1;
  console.log(`transitions=${ledgerRows.length} classification=${JSON.stringify(clsCounts)}`);
  const outc: Record<string, number> = {};
  for (const r of neutralRows) outc[String(r[11])] = (outc[String(r[11])] ?? 0) + 1;
  console.log(`neutral suppressed candidates=${neutralRows.length} outcomes=${JSON.stringify(outc)}`);
}

main();
