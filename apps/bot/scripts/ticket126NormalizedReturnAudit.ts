/**
 * TICKET-126 — Việc 1/2/3 shadow-audit script. Same STANDALONE, READ-ONLY walk/windowing convention
 * as TICKET-124/125's own scripts (never touches src/ production defaults, never opens a real
 * position) — this is a SEPARATE script/output; TICKET-124's and TICKET-125's own scripts/CSVs are
 * left completely untouched (immutable baselines for comparison).
 *
 * Direct follow-up to TICKET-125: reuses TICKET-125's Structural Break fix
 * (`detectRecentStructuralBreak()`) AS-IS (Việc 2 — no change), and swaps the classifier's return
 * feature from the unit-mismatched `volAdjReturn5m` to the new unit-normalized `returnInAtr5m`
 * (`tactical/tacticalRegimeClassifier.ts`'s `computeReturnInAtr5m()`, TICKET-126 Việc 1/3).
 *
 * Row shape: same as TICKET-125's CSV, with `volAdjReturn5m` (old, kept for direct before/after
 * comparison) PLUS a new `returnInAtr5m` column (what the classifier now actually uses).
 *
 * Run (from repo root, after `npm run build`): `npm run build:scripts && node apps/bot/scripts-dist/ticket126NormalizedReturnAudit.js`
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CandleData } from '../dist/regime/types.js';
import { MarketRegime } from '../dist/regime/types.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { detectRegime } from '../dist/regime/regimeDetector.js';
import { lastDefined, wilderATRSeries, wickRatios } from '../dist/regime/indicators.js';
import { EntryConfig } from '../dist/entry/config.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG, routeEntry } from '../dist/entry/entryRouter.js';
import { detectOrderBlock } from '../dist/entry/detectors/orderBlock.js';
import { detectFairValueGap } from '../dist/entry/detectors/fairValueGap.js';
import { detectLiquiditySweep } from '../dist/entry/detectors/liquiditySweep.js';
import { detectMarketStructureShift } from '../dist/entry/detectors/marketStructureShift.js';
import { detectRecentStructuralBreak, type RecentStructuralBreak } from '../dist/entry/detectors/structuralBreakRecent.js';
import { detectBoxBreakout } from '../dist/entry/detectors/boxBreakout.js';
import { computeMomentumCrossFeatures } from '../dist/xgbFilter/featureBuilder.js';
import { priceAtR } from '../dist/risk/slTpManager.js';
import {
  classifyTactical,
  TacticalConfig,
  TacticalState,
  candleDirection,
  bodyRatioOf,
  countDirectionFlips,
  computeReturnInAtr5m,
  type TacticalHysteresisState,
} from '../dist/tactical/tacticalRegimeClassifier.js';

if (process.env.TACTICAL_REGIME_5M_ENABLED === 'true') {
  throw new Error('ticket126NormalizedReturnAudit: TACTICAL_REGIME_5M_ENABLED must stay false — this script is the shadow-only audit path, never a production gate.');
}
const SHADOW_ON = process.env.TACTICAL_REGIME_5M_SHADOW !== 'false';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const OUT_CSV_PATH = path.resolve(process.cwd(), 'data/ticket126-normalized-return-shadow-audit.csv');
const REAL_TRADES_CSV_PATH = path.resolve(process.cwd(), 'data/ticket123-variantA-trades.csv');
const ENRICHED_CANDIDATES_CSV_PATH = path.resolve(process.cwd(), 'data/all-candidates-fully-enriched.csv');

// ---- Official 8-flag baseline (same as TICKET-124/125 spec) — dataset/period/warmup match exactly. ----
const SKIP_DAYS = 20;
const MOMENTUM_DIRECT_MIN_SL_PERCENT = 1.27;
const MOMENTUM_DIRECT_TP_R_MULTIPLE = 3.0;
const SHADOW_FIXED_RISK_DOLLAR = 15;
const SHADOW_SIM_MAX_HORIZON_CANDLES = 288;

const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;
const WINDOW_1H_MOMENTUM = 500;
const WINDOW_5M_SESSION_VOLUME = 14 * 288 + 1;

function readCsv(filePath: string): CandleData[] {
  const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
  return lines.slice(1).map((line) => {
    const [timestampUtc, , open, high, low, close, volume] = line.split(',');
    return { timestamp: Number(timestampUtc), open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) };
  });
}

interface SymbolData {
  candles5m: CandleData[];
  candles15m: CandleData[];
  candles1h: CandleData[];
  candles1m: CandleData[];
  candles1d: CandleData[];
  ptr15m: number;
  ptr1h: number;
  ptr1m: number;
  ptr1d: number;
  regimeState: { previousRegime: MarketRegime | null; previousCandidateRegime: MarketRegime | null; streakCount: number; previousDangerZoneTimestamp: number | null };
  tacticalState: TacticalHysteresisState | null;
}

function closedWindow(candles: CandleData[], ptr: number, intervalMs: number, decisionTime: number, windowSize: number): { window: CandleData[]; ptr: number } {
  let p = ptr;
  while (p + 1 < candles.length && candles[p + 1].timestamp + intervalMs <= decisionTime) p++;
  if (p < 0) return { window: [], ptr: p };
  const start = Math.max(0, p - windowSize + 1);
  return { window: candles.slice(start, p + 1), ptr: p };
}

function loadSymbolData(symbol: string): SymbolData {
  return {
    candles5m: readCsv(path.join(OHLCV_DIR, `${symbol}_5m.csv`)),
    candles15m: readCsv(path.join(OHLCV_DIR, `${symbol}_15m.csv`)),
    candles1h: readCsv(path.join(OHLCV_DIR, `${symbol}_1h.csv`)),
    candles1m: readCsv(path.join(OHLCV_DIR, `${symbol}_1m.csv`)),
    candles1d: readCsv(path.join(OHLCV_DIR, `${symbol}_1d.csv`)),
    ptr15m: -1,
    ptr1h: -1,
    ptr1m: -1,
    ptr1d: -1,
    regimeState: { previousRegime: null, previousCandidateRegime: null, streakCount: 0, previousDangerZoneTimestamp: null },
    tacticalState: null,
  };
}

const BOX_MAX_BBW_PCT_MIRROR = 60; // = EntryConfig.BOX_MAX_BBW_PERCENTILE (TICKET-124's own condition15m definition, reused verbatim)
function condition15mOf(bbWidthPercentile15m: number | undefined): string {
  if (bbWidthPercentile15m === undefined) return 'NA';
  if (bbWidthPercentile15m <= RegimeConfig.COMPRESSION_BBW_PCT_THRESHOLD.enter) return 'COMPRESSED_15M';
  if (bbWidthPercentile15m > BOX_MAX_BBW_PCT_MIRROR) return 'EXPANDED_15M';
  return 'NEUTRAL_15M';
}

interface EnrichedRow {
  win: boolean;
  pnlUsd: number;
}

function loadEnrichedIndex(): Map<string, EnrichedRow> {
  const map = new Map<string, EnrichedRow>();
  const lines = readFileSync(ENRICHED_CANDIDATES_CSV_PATH, 'utf-8').trim().split('\n');
  const header = lines[0].split(',');
  const idx = (name: string) => header.indexOf(name);
  const iSymbol = idx('symbol');
  const iTimestamp = idx('timestamp');
  const iSide = idx('side');
  const iWin = idx('win');
  const iPnl = idx('pnlUsd');
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const key = `${cols[iSymbol]}|${cols[iTimestamp]}|${cols[iSide]}`;
    map.set(key, { win: cols[iWin] === 'true', pnlUsd: Number(cols[iPnl]) });
  }
  return map;
}

function loadRealTradesIndex(): Set<string> {
  const set = new Set<string>();
  const lines = readFileSync(REAL_TRADES_CSV_PATH, 'utf-8').trim().split('\n');
  const header = lines[0].split(',');
  const iSymbol = header.indexOf('symbol');
  const iEntryTs = header.indexOf('entryTimestamp');
  const iSide = header.indexOf('side');
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    set.add(`${cols[iSymbol]}|${cols[iEntryTs]}|${cols[iSide]}`);
  }
  return set;
}

/** Identical simplified simulator to TICKET-124/125's — same formula/limitations, documented there and in the TICKET-126 report. */
function simulateShadowOutcome(symbolCandles5m: CandleData[], entryIndex: number, side: 'LONG' | 'SHORT', atr: number): { win: boolean; pnlUsd: number } | undefined {
  const entryCandle = symbolCandles5m[entryIndex];
  const entryPrice = entryCandle.close;
  const rawSlPrice = side === 'LONG' ? entryCandle.low : entryCandle.high;
  const buffer = EntryConfig.SL_BUFFER_ATR_MULTIPLIER * atr;
  let slPrice = side === 'LONG' ? rawSlPrice - buffer : rawSlPrice + buffer;
  const rawSlDistancePercent = (Math.abs(entryPrice - slPrice) / entryPrice) * 100;
  if (rawSlDistancePercent < MOMENTUM_DIRECT_MIN_SL_PERCENT) {
    const flooredDistance = (MOMENTUM_DIRECT_MIN_SL_PERCENT / 100) * entryPrice;
    slPrice = side === 'LONG' ? entryPrice - flooredDistance : entryPrice + flooredDistance;
  }
  const r = Math.abs(entryPrice - slPrice);
  const tpPrice = priceAtR(entryPrice, r, MOMENTUM_DIRECT_TP_R_MULTIPLE, side);

  const horizon = Math.min(entryIndex + SHADOW_SIM_MAX_HORIZON_CANDLES, symbolCandles5m.length - 1);
  for (let j = entryIndex + 1; j <= horizon; j++) {
    const c = symbolCandles5m[j];
    const slHit = side === 'LONG' ? c.low <= slPrice : c.high >= slPrice;
    const tpHit = side === 'LONG' ? c.high >= tpPrice : c.low <= tpPrice;
    if (slHit) return { win: false, pnlUsd: -SHADOW_FIXED_RISK_DOLLAR };
    if (tpHit) return { win: true, pnlUsd: SHADOW_FIXED_RISK_DOLLAR * MOMENTUM_DIRECT_TP_R_MULTIPLE };
  }
  return undefined;
}

async function main(): Promise<void> {
  console.log(`TICKET-126 — normalized-return shadow audit. TACTICAL_REGIME_5M_SHADOW active=${SHADOW_ON}`);
  console.log('Đọc CSV OHLCV (5m/15m/1h/1m/1d x 4 coin)...');

  const symbolsData: Record<string, SymbolData> = {};
  for (const symbol of SYMBOLS) symbolsData[symbol] = loadSymbolData(symbol);

  console.log('Đọc real-trades + enriched-candidates CSV cho join...');
  const enrichedIndex = loadEnrichedIndex();
  const realTradesIndex = loadRealTradesIndex();

  const rawTotalSteps = Math.min(...SYMBOLS.map((s) => symbolsData[s].candles5m.length));
  const warmupStartStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5 + SKIP_DAYS * 288;
  const totalSteps = rawTotalSteps;

  console.log(`Chạy ${totalSteps - warmupStartStep} bước x ${SYMBOLS.length} coin (từ nến 5m #${warmupStartStep})...`);

  const csvRows: string[] = [];
  const header = [
    'timestamp', 'symbol', 'existingRegime', 'macroDirection1h', 'condition15m', 'tacticalState5m', 'tacticalSide', 'tacticalConfidence',
    'reasonCodes', 'atrPercentile5m', 'bbWidthPercentile15m', 'volumeZScore5m', 'adx1h', 'emaRatioFast', 'emaRatioSlow',
    // Việc A raw features — OLD (volAdjReturn5m, unit-mismatched) side-by-side with NEW (returnInAtr5m, unit-normalized)
    'volAdjReturn5m', 'returnInAtr5m', 'bodyRatio', 'upperWickRatio', 'lowerWickRatio', 'directionFlips', 'choppyScore', 'atrTrend5m', 'candleDir',
    // Old (TICKET-124) vs new (TICKET-125, unchanged in this ticket) structural break booleans
    'hasOB', 'hasFVG', 'hasSweep', 'hasBoxBreakout', 'hasMSS_old', 'hasStructuralBreakOld', 'hasStructuralBreakNewLong', 'hasStructuralBreakNewShort',
    // Việc B richer log columns (for the CONFIRMED tactical output's side; NA if side=null)
    'structuralBreakSide', 'structuralBreakTimestamp', 'structuralBreakAgeCandles', 'structuralBreakLevel', 'distanceFromBreakAtr',
    'wouldPassOldLogic', 'wouldPassTacticalLogic', 'actualTradeOpened', 'simulatedWin', 'simulatedPnlUsd',
  ];
  csvRows.push(header.join(','));

  for (let step = warmupStartStep; step < totalSteps; step++) {
    const w1hBySymbol: Record<string, CandleData[]> = {};
    for (const symbol of SYMBOLS) {
      const sd = symbolsData[symbol];
      const decisionTime = sd.candles5m[step].timestamp + 5 * 60_000;
      const w1h = closedWindow(sd.candles1h, sd.ptr1h, 60 * 60_000, decisionTime, WINDOW_1H);
      sd.ptr1h = w1h.ptr;
      w1hBySymbol[symbol] = w1h.window;
    }
    const correlatedRiskRatioSeries = computeCorrelatedRiskRatio(w1hBySymbol, RegimeConfig.CORRELATED_RISK_WINDOW_CANDLES, 'BTCUSDT');
    const correlatedRiskRatio = correlatedRiskRatioSeries[correlatedRiskRatioSeries.length - 1];

    for (const symbol of SYMBOLS) {
      const sd = symbolsData[symbol];
      const currentCandle = sd.candles5m[step];
      const decisionTime = currentCandle.timestamp + 5 * 60_000;

      const window5m = sd.candles5m.slice(Math.max(0, step - WINDOW_5M + 1), step + 1);
      const windowSessionVolume5m = sd.candles5m.slice(Math.max(0, step - WINDOW_5M_SESSION_VOLUME + 1), step + 1);
      const w15 = closedWindow(sd.candles15m, sd.ptr15m, 15 * 60_000, decisionTime, WINDOW_15M);
      sd.ptr15m = w15.ptr;
      const w1hMomentum = closedWindow(sd.candles1h, sd.ptr1h, 60 * 60_000, decisionTime, WINDOW_1H_MOMENTUM);
      const w1m = closedWindow(sd.candles1m, sd.ptr1m, 60_000, decisionTime, WINDOW_1M);
      sd.ptr1m = w1m.ptr;
      const w1d = closedWindow(sd.candles1d, sd.ptr1d, 24 * 60 * 60_000, decisionTime, WINDOW_1D);
      sd.ptr1d = w1d.ptr;

      // ---- Regime Engine (read-only, unmodified) ----
      const regimeOutput = detectRegime({
        candles5m: window5m,
        candles15m: w15.window,
        candles1h: w1hBySymbol[symbol],
        previousRegime: sd.regimeState.previousRegime,
        streakCount: sd.regimeState.streakCount,
        previousCandidateRegime: sd.regimeState.previousCandidateRegime,
        previousDangerZoneTimestamp: sd.regimeState.previousDangerZoneTimestamp,
        candles5mSessionVolume: windowSessionVolume5m,
        correlatedRiskRatio,
      });
      sd.regimeState = {
        previousRegime: regimeOutput.regime,
        previousCandidateRegime: regimeOutput.candidateRegime,
        streakCount: regimeOutput.streakCount,
        previousDangerZoneTimestamp: regimeOutput.lastDangerZoneTimestamp,
      };
      const m = regimeOutput.computedMetrics;

      // ---- Cross-features (reused verbatim from xgbFilter/featureBuilder.ts, UNTOUCHED by TICKET-126) ----
      const crossFeatures = computeMomentumCrossFeatures(window5m, w1hMomentum.window);

      // ---- entry/ detectors reused directly ----
      const direction: 'BULLISH' | 'BEARISH' | undefined = m.adxDirection1h === 'UP' ? 'BULLISH' : m.adxDirection1h === 'DOWN' ? 'BEARISH' : undefined;
      let hasOB = false, hasFVG = false, hasSweep = false, hasBoxBreakout = false, hasMSSOld = false;
      if (direction !== undefined) {
        hasOB = detectOrderBlock(window5m, direction, { fractalN: EntryConfig.FRACTAL_N, lookforwardK: EntryConfig.OB_BOS_LOOKFORWARD_K }) !== null;
        hasFVG = detectFairValueGap(window5m, direction) !== null;
        hasSweep = detectLiquiditySweep(window5m, direction, { fractalN: EntryConfig.FRACTAL_N, wickRatioThreshold: EntryConfig.LIQUIDITY_SWEEP_WICK_RATIO_THRESHOLD }) !== null;
        hasMSSOld = detectMarketStructureShift(w1m.window, direction, { fractalN: EntryConfig.FRACTAL_N }) !== null;
      }
      if (m.bbWidthPercentile15m !== undefined && m.volumeZScore5m !== undefined) {
        hasBoxBreakout = detectBoxBreakout(w15.window, window5m, m.bbWidthPercentile15m, m.volumeZScore5m, {
          boxLookbackM: EntryConfig.BOX_LOOKBACK_M, maxBbwPercentile: EntryConfig.BOX_MAX_BBW_PERCENTILE,
          minBodyRatio: EntryConfig.BOX_BREAKOUT_MIN_BODY_RATIO, minVolumeZScore: EntryConfig.BOX_BREAKOUT_MIN_VOLUME_ZSCORE,
        }) !== null;
      }
      // TICKET-124's exact (non-discriminating, ~99.8% true) proxy — kept for direct old-vs-new comparison.
      const hasStructuralBreakOld = hasMSSOld || hasBoxBreakout;

      // ---- TICKET-125 Việc B (UNCHANGED in TICKET-126, Việc 2 requirement): sided, recent, swing-anchored. ----
      const recentLong: RecentStructuralBreak | null = detectRecentStructuralBreak(w1m.window, 'BULLISH', { fractalN: EntryConfig.FRACTAL_N });
      const recentShort: RecentStructuralBreak | null = detectRecentStructuralBreak(w1m.window, 'BEARISH', { fractalN: EntryConfig.FRACTAL_N });
      const hasStructuralBreakNew = { LONG: recentLong !== null, SHORT: recentShort !== null };

      // ---- Việc A raw features (all via tacticalRegimeClassifier.ts's own exported helpers) ----
      const currentCandle5m = window5m[window5m.length - 1];
      const bodyRatio = bodyRatioOf(currentCandle5m);
      const { upperWickRatio, lowerWickRatio } = wickRatios(currentCandle5m);
      const directionFlips = countDirectionFlips(window5m, TacticalConfig.CHOP_LOOKBACK_CANDLES);
      const returnInAtr5m = computeReturnInAtr5m(window5m);
      const choppyChecksTrue =
        (directionFlips >= TacticalConfig.CHOP_MIN_FLIPS ? 1 : 0) +
        (Math.max(upperWickRatio, lowerWickRatio) >= TacticalConfig.CHOP_WICK_RATIO_MIN ? 1 : 0) +
        (bodyRatio < TacticalConfig.BODY_RATIO_STRONG ? 1 : 0);
      const choppyScore = choppyChecksTrue / 3;

      // ---- Tactical Shadow classifier (now internally uses returnInAtr5m, see tacticalRegimeClassifier.ts) ----
      const tacticalOutput = SHADOW_ON
        ? classifyTactical({ computedMetrics: m, crossFeatures, candles5m: window5m, hasStructuralBreak: hasStructuralBreakNew }, sd.tacticalState)
        : null;
      if (tacticalOutput) sd.tacticalState = tacticalOutput.hysteresisState;

      // ---- ATR(5m) — computed once per row, reused for distanceFromBreakAtr AND the shadow simulator fallback. ----
      const atr5m = lastDefined(wilderATRSeries(window5m, RegimeConfig.ATR_PERIOD_5M));

      // ---- Việc B richer log columns, for the CONFIRMED tactical side only (side=null -> NA) ----
      const confirmedSide = tacticalOutput?.side ?? null;
      const structuralBreakForSide: RecentStructuralBreak | null = confirmedSide === 'LONG' ? recentLong : confirmedSide === 'SHORT' ? recentShort : null;
      const distanceFromBreakAtr =
        structuralBreakForSide !== null && atr5m !== undefined && atr5m > 0
          ? Math.abs(currentCandle5m.close - structuralBreakForSide.levelPrice) / atr5m
          : undefined;

      // ---- wouldPassOldLogic: production routeEntry() cascade, read-only, unmodified default config ----
      let wouldPassOldLogic = false;
      if (m.bbWidthPercentile15m !== undefined && m.volumeZScore5m !== undefined) {
        const draft = routeEntry(
          {
            regime: regimeOutput.regime,
            symbol,
            adxDirection1h: m.adxDirection1h,
            macroDirection: undefined,
            candles5m: window5m,
            candles15m: w15.window,
            candlesMss: w1m.window,
            bbWidthPercentile15m: m.bbWidthPercentile15m,
            volumeZScore5m: m.volumeZScore5m,
          },
          DEFAULT_ENTRY_ROUTER_CONFIG,
        );
        wouldPassOldLogic = draft !== null;
      }

      const wouldPassTacticalLogic = tacticalOutput !== null && (tacticalOutput.state === TacticalState.NEUTRAL_EXPANSION || tacticalOutput.state === TacticalState.MICRO_TREND);

      // ---- actualTradeOpened: join against the official 258-trade baseline CSV by symbol+entryTimestamp+side ----
      const sideForJoin = tacticalOutput?.side ?? undefined;
      const actualTradeOpened = sideForJoin !== undefined && sideForJoin !== null
        ? realTradesIndex.has(`${symbol}|${currentCandle.timestamp}|${sideForJoin}`)
        : realTradesIndex.has(`${symbol}|${currentCandle.timestamp}|LONG`) || realTradesIndex.has(`${symbol}|${currentCandle.timestamp}|SHORT`);

      // ---- simulatedWin/simulatedPnlUsd: real join first, own simplified simulator as fallback ----
      let simulatedWin: string = 'NA';
      let simulatedPnlUsd: string = 'NA';
      const side = tacticalOutput?.side;
      if (side !== null && side !== undefined) {
        const enriched = enrichedIndex.get(`${symbol}|${currentCandle.timestamp}|${side}`);
        if (enriched !== undefined) {
          simulatedWin = String(enriched.win);
          simulatedPnlUsd = String(enriched.pnlUsd);
        } else if (atr5m !== undefined) {
          const sim = simulateShadowOutcome(sd.candles5m, step, side as 'LONG' | 'SHORT', atr5m);
          if (sim !== undefined) {
            simulatedWin = String(sim.win);
            simulatedPnlUsd = String(sim.pnlUsd);
          }
        }
      }

      const row = [
        currentCandle.timestamp,
        symbol,
        regimeOutput.regime,
        m.adxDirection1h ?? 'NA',
        condition15mOf(m.bbWidthPercentile15m),
        tacticalOutput ? tacticalOutput.state : 'NA',
        tacticalOutput?.side ?? 'NA',
        tacticalOutput ? tacticalOutput.confidence.toFixed(4) : 'NA',
        tacticalOutput ? tacticalOutput.reasonCodes.join(';') : 'NA',
        m.atrPercentile5m ?? 'NA',
        m.bbWidthPercentile15m ?? 'NA',
        m.volumeZScore5m ?? 'NA',
        m.adx1h ?? 'NA',
        crossFeatures?.emaRatioFast ?? 'NA',
        crossFeatures?.emaRatioSlow ?? 'NA',
        crossFeatures?.volAdjReturn5m ?? 'NA',
        returnInAtr5m !== undefined ? returnInAtr5m.toFixed(6) : 'NA',
        bodyRatio.toFixed(6),
        upperWickRatio.toFixed(6),
        lowerWickRatio.toFixed(6),
        directionFlips,
        choppyScore.toFixed(4),
        m.atrTrend5m ?? 'NA',
        candleDirection(currentCandle5m),
        hasOB, hasFVG, hasSweep, hasBoxBreakout, hasMSSOld, hasStructuralBreakOld, hasStructuralBreakNew.LONG, hasStructuralBreakNew.SHORT,
        structuralBreakForSide?.side ?? 'NA',
        structuralBreakForSide?.timestamp ?? 'NA',
        structuralBreakForSide?.ageCandles ?? 'NA',
        structuralBreakForSide?.levelPrice ?? 'NA',
        distanceFromBreakAtr !== undefined ? distanceFromBreakAtr.toFixed(6) : 'NA',
        wouldPassOldLogic, wouldPassTacticalLogic,
        actualTradeOpened,
        simulatedWin,
        simulatedPnlUsd,
      ];
      csvRows.push(row.join(','));
    }

    const progressStep = step - warmupStartStep;
    if (progressStep % 5000 === 0) console.log(`  bước ${progressStep}/${totalSteps - warmupStartStep}...`);
  }

  writeFileSync(OUT_CSV_PATH, csvRows.join('\n') + '\n');
  console.log(`Xong. ${csvRows.length - 1} rows -> ${OUT_CSV_PATH}`);
}

main().catch((err) => {
  console.error('ticket126NormalizedReturnAudit failed:', err);
  process.exit(1);
});
