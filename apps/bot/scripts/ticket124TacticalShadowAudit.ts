/**
 * TICKET-124 Phần C — Shadow Tactical Regime 5m audit script. STANDALONE, READ-ONLY: replays the
 * exact same no-look-ahead OHLCV windowing convention as backtest.ts, calling ONLY already-existing,
 * read-only production functions (detectRegime(), routeEntry(), the entry/ detectors,
 * computeMomentumCrossFeatures()) plus the NEW tactical/tacticalRegimeClassifier.ts (Phần B) —
 * never calls processCandle()/the real orchestrator, never opens a real position, never mutates any
 * production config or default. Writes one row per (symbol, 5m candle) to
 * data/ticket124-tactical-shadow-audit.csv.
 *
 * Feature flags (read-only, this script's own gate — production code never reads these):
 *   TACTICAL_REGIME_5M_ENABLED — must be false/unset for this script to run its shadow classification
 *     at all (mirrors the ticket's "feature flag mặc định OFF" requirement; this script IS the shadow
 *     path, so it force-fails if someone flips this on, as a guard against accidental misuse).
 *   TACTICAL_REGIME_5M_SHADOW — must be 'true' to actually run the tactical classifier (default
 *     posture for THIS script, since its whole purpose is the shadow audit).
 *
 * Uses the OFFICIAL, independently-verified production backtest baseline period/config (per
 * TICKET-124 spec): same 8-flag combination that produces 258 trades / $842.14 / PF 1.353 on
 * data/ticket123-variantA-trades.csv — reused here for actualTradeOpened cross-referencing (join by
 * symbol+entryTimestamp) rather than re-deriving the flag combination a 3rd time.
 *
 * Run (from repo root, after `npm run build`): `npm run build:scripts && node apps/bot/scripts-dist/ticket124TacticalShadowAudit.js`
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CandleData } from '../dist/regime/types.js';
import { MarketRegime } from '../dist/regime/types.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { detectRegime } from '../dist/regime/regimeDetector.js';
import { lastDefined, wilderATRSeries } from '../dist/regime/indicators.js';
import { EntryConfig } from '../dist/entry/config.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG, routeEntry } from '../dist/entry/entryRouter.js';
import { detectOrderBlock } from '../dist/entry/detectors/orderBlock.js';
import { detectFairValueGap } from '../dist/entry/detectors/fairValueGap.js';
import { detectLiquiditySweep } from '../dist/entry/detectors/liquiditySweep.js';
import { detectMarketStructureShift } from '../dist/entry/detectors/marketStructureShift.js';
import { detectBoxBreakout } from '../dist/entry/detectors/boxBreakout.js';
import { computeMomentumCrossFeatures } from '../dist/xgbFilter/featureBuilder.js';
import { priceAtR } from '../dist/risk/slTpManager.js';
import {
  classifyTactical,
  TacticalState,
  type TacticalHysteresisState,
} from '../dist/tactical/tacticalRegimeClassifier.js';

if (process.env.TACTICAL_REGIME_5M_ENABLED === 'true') {
  throw new Error('ticket124TacticalShadowAudit: TACTICAL_REGIME_5M_ENABLED must stay false — this script is the shadow-only audit path, never a production gate.');
}
const SHADOW_ON = process.env.TACTICAL_REGIME_5M_SHADOW !== 'false'; // default true for this script's own purpose

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const OUT_CSV_PATH = path.resolve(process.cwd(), 'data/ticket124-tactical-shadow-audit.csv');
const REAL_TRADES_CSV_PATH = path.resolve(process.cwd(), 'data/ticket123-variantA-trades.csv');
const ENRICHED_CANDIDATES_CSV_PATH = path.resolve(process.cwd(), 'data/all-candidates-fully-enriched.csv');

// ---- Official 8-flag baseline (see TICKET-124 spec) — dataset/period/warmup match exactly. ----
const SKIP_DAYS = 20;
const MOMENTUM_DIRECT_MIN_SL_PERCENT = 1.27;
const MOMENTUM_DIRECT_TP_R_MULTIPLE = 3.0;
// Shadow-simulator-only assumption (documented, NOT a production value): fixed risk$/hypothetical
// trade for candles with no real join in all-candidates-fully-enriched.csv. Matches the official
// baseline's riskDollarOrPercent=15 on start-balance=100 — a flat $15, since this is a one-off
// what-if simulation, not a compounding equity curve (that would require replaying the WHOLE
// portfolio's path, out of scope for a per-candle shadow label).
const SHADOW_FIXED_RISK_DOLLAR = 15;
const SHADOW_SIM_MAX_HORIZON_CANDLES = 288; // 1 day — bounds cost; beyond this, outcome marked NA (timeout), never guessed.

// Same bounded sliding windows as backtest.ts (see its own comment for rationale).
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

/**
 * TICKET-124 Phần C: "condition15m" label — no existing labeled concept for "what is 15m doing right
 * now" in the codebase (checked entryRouter.ts/boxBreakout.ts: both only READ bbWidthPercentile15m as
 * a numeric gate, never bucket it into a named condition). Defined here from the SAME two existing
 * bot thresholds already used elsewhere for 15m bandwidth, not new numbers:
 *   <= RegimeConfig.COMPRESSION_BBW_PCT_THRESHOLD.enter (10)  -> COMPRESSED_15M (same bar COMPRESSION regime uses)
 *   >  EntryConfig.BOX_MAX_BBW_PERCENTILE (60, mirrored here as 60 without importing entry/config.ts
 *      from this analysis script's own definition — see BOX_MAX_BBW_PCT_MIRROR below) -> EXPANDED_15M
 *   otherwise -> NEUTRAL_15M
 */
const BOX_MAX_BBW_PCT_MIRROR = 60; // = EntryConfig.BOX_MAX_BBW_PERCENTILE, cited above
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

/**
 * Shadow-outcome simulator for candidates with NO real join in all-candidates-fully-enriched.csv
 * (i.e. not a MOMENTUM_DIRECT candidate the training-data generator already simulated). Reuses the
 * EXACT same SL/TP formula as orchestrator.ts's tryMomentumDirect() (TICKET-064): sweep-style SL
 * (current candle's own low/high +/- SL_BUFFER_ATR_MULTIPLIER*ATR, floored at
 * momentumDirectMinSlPercent) and priceAtR() for the R-multiple TP — NOT re-derived, same constants.
 * Simplification vs the real slTpManager.ts (documented explicitly, a judgment call, see report):
 * no partial TP tiers/trailing/giveback/fees — single all-or-nothing SL-or-TP-first walk, fixed
 * SHADOW_FIXED_RISK_DOLLAR risk. Returns undefined (-> CSV 'NA') if neither SL nor TP is hit within
 * SHADOW_SIM_MAX_HORIZON_CANDLES candles (never guesses an outcome for an unresolved trade).
 */
function simulateShadowOutcome(
  symbolCandles5m: CandleData[],
  entryIndex: number,
  side: 'LONG' | 'SHORT',
  atr: number,
): { win: boolean; pnlUsd: number } | undefined {
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
    // Conservative convention (documented): if both would trigger on the same candle, SL is assumed
    // first (worst case) — matches the general "don't fabricate an optimistic outcome" principle.
    if (slHit) return { win: false, pnlUsd: -SHADOW_FIXED_RISK_DOLLAR };
    if (tpHit) return { win: true, pnlUsd: SHADOW_FIXED_RISK_DOLLAR * MOMENTUM_DIRECT_TP_R_MULTIPLE };
  }
  return undefined; // timeout — neither hit within the bounded horizon
}

async function main(): Promise<void> {
  console.log(`TICKET-124 Phần C — Shadow Tactical Regime 5m audit. TACTICAL_REGIME_5M_SHADOW active=${SHADOW_ON}`);
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
    'hasOB', 'hasFVG', 'hasSweep', 'hasBoxBreakout', 'hasMSS', 'wouldPassOldLogic', 'wouldPassTacticalLogic',
    'actualTradeOpened', 'simulatedWin', 'simulatedPnlUsd',
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

      // ---- Cross-features (reused verbatim from xgbFilter/featureBuilder.ts) ----
      const crossFeatures = computeMomentumCrossFeatures(window5m, w1hMomentum.window);

      // ---- entry/ detectors reused directly (TICKET-124 building blocks) — direction from adxDirection1h ----
      const direction: 'BULLISH' | 'BEARISH' | undefined = m.adxDirection1h === 'UP' ? 'BULLISH' : m.adxDirection1h === 'DOWN' ? 'BEARISH' : undefined;
      let hasOB = false, hasFVG = false, hasSweep = false, hasBoxBreakout = false, hasMSS = false;
      if (direction !== undefined) {
        hasOB = detectOrderBlock(window5m, direction, { fractalN: EntryConfig.FRACTAL_N, lookforwardK: EntryConfig.OB_BOS_LOOKFORWARD_K }) !== null;
        hasFVG = detectFairValueGap(window5m, direction) !== null;
        hasSweep = detectLiquiditySweep(window5m, direction, { fractalN: EntryConfig.FRACTAL_N, wickRatioThreshold: EntryConfig.LIQUIDITY_SWEEP_WICK_RATIO_THRESHOLD }) !== null;
        hasMSS = detectMarketStructureShift(w1m.window, direction, { fractalN: EntryConfig.FRACTAL_N }) !== null;
      }
      if (m.bbWidthPercentile15m !== undefined && m.volumeZScore5m !== undefined) {
        hasBoxBreakout = detectBoxBreakout(w15.window, window5m, m.bbWidthPercentile15m, m.volumeZScore5m, {
          boxLookbackM: EntryConfig.BOX_LOOKBACK_M, maxBbwPercentile: EntryConfig.BOX_MAX_BBW_PERCENTILE,
          minBodyRatio: EntryConfig.BOX_BREAKOUT_MIN_BODY_RATIO, minVolumeZScore: EntryConfig.BOX_BREAKOUT_MIN_VOLUME_ZSCORE,
        }) !== null;
      }
      const hasStructuralBreak = hasMSS || hasBoxBreakout;

      // ---- Tactical Shadow classifier (Phần B, NEW — never called by production) ----
      const tacticalOutput = SHADOW_ON
        ? classifyTactical({ computedMetrics: m, crossFeatures, candles5m: window5m, hasStructuralBreak }, sd.tacticalState)
        : null;
      if (tacticalOutput) sd.tacticalState = tacticalOutput.hysteresisState;

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

      // wouldPassTacticalLogic: TICKET-124 definition — confirmed tactical state is one of the two
      // "opportunity" states (Expansion/Micro Trend), per ticket Phần E's own framing of what a
      // future entry gate would trade on. Never used to decide anything real.
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
        } else {
          // No real join (candle wasn't a MOMENTUM_DIRECT candidate row) — fall back to this script's
          // own simplified simulator. ATR(14) 5m computed off the SAME bounded window5m (320 candles)
          // already built above for detectRegime()/routeEntry(), not the full per-symbol history —
          // keeps this O(window) per call instead of O(full dataset).
          const atr = lastDefined(wilderATRSeries(window5m, RegimeConfig.ATR_PERIOD_5M));
          if (atr !== undefined) {
            const sim = simulateShadowOutcome(sd.candles5m, step, side as 'LONG' | 'SHORT', atr);
            if (sim !== undefined) {
              simulatedWin = String(sim.win);
              simulatedPnlUsd = String(sim.pnlUsd);
            }
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
        hasOB, hasFVG, hasSweep, hasBoxBreakout, hasMSS,
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
  console.error('ticket124TacticalShadowAudit failed:', err);
  process.exit(1);
});
