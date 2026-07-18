/**
 * TICKET-023 Phần B — labels EVERY 5m candle (not just candles with a Draft Setup) with a
 * Fixed-Time-Horizon momentum label, to get far more training rows than
 * generateTrainingData.ts's per-setup approach (159-205 rows) produced.
 *
 * Reuses the exact indicator functions already in regime/indicators.ts (wilderADXSeries,
 * wilderDIDirectionSeries, wilderATRSeries, percentileRankSeries, bollingerBandwidthSeries,
 * trendDirectionSeries, zScoreSeries, emaSeries) — no formula is re-derived here, only feature
 * assembly + labeling. Same two-pointer closed-candle alignment technique as
 * calibrateThresholds.ts/backtest.ts (no look-ahead into a still-open higher-timeframe candle when
 * computing FEATURES — the label is a separate, deliberately-forward-looking concern, see B.3).
 *
 * Read-only against data/ohlcv/ (or --ohlcv-dir=). Does NOT fetch new data, does NOT touch
 * regime/entryRouter/risk/orchestrator, does NOT touch data/ohlcv/ (only reads it).
 *
 * Output: data/training/momentum-labeled.csv (or --out=) — separate from
 * data/training/draft-setups-labeled*.csv (TICKET-019/020/022), not overwritten.
 *
 * Run from repo root: `npm run build:scripts && node apps/bot/scripts-dist/generateMomentumTrainingData.js`
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CandleData } from '../dist/regime/types.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { EntryConfig } from '../dist/entry/config.js';
import {
  bollingerBandwidthSeries,
  emaSeries,
  percentileRankSeries,
  trendDirectionSeries,
  wilderATRSeries,
  wilderADXSeries,
  wilderDIDirectionSeries,
  zScoreSeries,
} from '../dist/regime/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];

// B.3 — TODO_CONFIRM, Trader's suggested starting point. PM may adjust after seeing results.
const HORIZON_CANDLES = 10;
const THRESHOLD_PCT = 0.005; // 0.5%

const EMA_FAST_PERIOD = 9;
const EMA_SLOW_PERIOD = 21;
const EMA_1H_FAST_PERIOD = 50;
const EMA_1H_SLOW_PERIOD = 200;

function parseArgs(): { ohlcvDir: string; outPath: string } {
  const args = process.argv.slice(2);
  const ohlcvDirArg = args.find((a) => a.startsWith('--ohlcv-dir='));
  const outArg = args.find((a) => a.startsWith('--out='));
  return {
    ohlcvDir: path.resolve(process.cwd(), ohlcvDirArg ? ohlcvDirArg.split('=')[1] : 'data/ohlcv'),
    outPath: path.resolve(process.cwd(), outArg ? outArg.split('=')[1] : 'data/training/momentum-labeled.csv'),
  };
}

function readCsv(filePath: string): CandleData[] {
  const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
  return lines.slice(1).map((line) => {
    const [timestampUtc, , open, high, low, close, volume] = line.split(',');
    return {
      timestamp: Number(timestampUtc),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    };
  });
}

interface Row {
  symbol: string;
  timestampUtc: number;
  adx1h: number;
  atrPercentile5m: number;
  bbWidthPercentile15m: number;
  volumeZScore5m: number;
  atrTrend5m: string;
  adxDirection1h: string;
  macroDirection: string;
  volAdjReturn5m: number;
  emaRatioFast: number;
  emaRatioSlow: number;
  label_bullish_momentum: 0 | 1;
}

function rowsForSymbol(symbol: string, ohlcvDir: string): Row[] {
  const candles5m = readCsv(path.join(ohlcvDir, `${symbol}_5m.csv`));
  const candles15m = readCsv(path.join(ohlcvDir, `${symbol}_15m.csv`));
  const candles1h = readCsv(path.join(ohlcvDir, `${symbol}_1h.csv`));
  const candles1d = readCsv(path.join(ohlcvDir, `${symbol}_1d.csv`));

  // Precompute every series ONCE over the full history (not per-candle) — same approach as
  // calibrateThresholds.ts, avoids O(n^2) recomputation across tens of thousands of 5m candles.
  const adxSeries1h = wilderADXSeries(candles1h, RegimeConfig.ADX_PERIOD_1H);
  const adxDirectionSeries1h = wilderDIDirectionSeries(candles1h, RegimeConfig.ADX_PERIOD_1H);
  const atrSeries5m = wilderATRSeries(candles5m, RegimeConfig.ATR_PERIOD_5M);
  const atrPercentileSeries5m = percentileRankSeries(atrSeries5m, RegimeConfig.ATR_PCT_LOOKBACK_5M);
  const bbwSeries15m = bollingerBandwidthSeries(candles15m, RegimeConfig.BB_PERIOD_15M);
  const bbwPercentileSeries15m = percentileRankSeries(bbwSeries15m, RegimeConfig.BBW_PCT_LOOKBACK_15M);
  const atrTrendSeries5m = trendDirectionSeries(atrSeries5m, RegimeConfig.ATR_TREND_LOOKBACK_N);
  const volumeZScoreSeries5m = zScoreSeries(
    candles5m.map((c) => c.volume),
    RegimeConfig.VOLUME_ZSCORE_LOOKBACK_5M,
  );
  const macroDirectionSeries1d = wilderDIDirectionSeries(candles1d, EntryConfig.MACRO_TREND_ADX_PERIOD_1D);

  const emaFast5m = emaSeries(candles5m, EMA_FAST_PERIOD);
  const emaSlow5m = emaSeries(candles5m, EMA_SLOW_PERIOD);
  const ema1hFast = emaSeries(candles1h, EMA_1H_FAST_PERIOD);
  const ema1hSlow = emaSeries(candles1h, EMA_1H_SLOW_PERIOD);

  const rows: Row[] = [];

  // Two-pointer alignment: for each 5m candle's close time, find the latest already-CLOSED 1h/15m/1d candle.
  let idx1h = -1;
  let idx15m = -1;
  let idx1d = -1;

  for (let i = 0; i < candles5m.length; i++) {
    const candle = candles5m[i];
    const decisionTime = candle.timestamp + 5 * 60_000;
    while (idx1h + 1 < candles1h.length && candles1h[idx1h + 1].timestamp + 60 * 60_000 <= decisionTime) idx1h++;
    while (idx15m + 1 < candles15m.length && candles15m[idx15m + 1].timestamp + 15 * 60_000 <= decisionTime) idx15m++;
    while (idx1d + 1 < candles1d.length && candles1d[idx1d + 1].timestamp + 24 * 60 * 60_000 <= decisionTime) idx1d++;

    const adx1h = idx1h >= 0 ? adxSeries1h[idx1h] : NaN;
    const adxDirection1h = idx1h >= 0 ? adxDirectionSeries1h[idx1h] : undefined;
    const atrPercentile5m = atrPercentileSeries5m[i];
    const bbWidthPercentile15m = idx15m >= 0 ? bbwPercentileSeries15m[idx15m] : NaN;
    const volumeZScore5m = volumeZScoreSeries5m[i];
    const atrTrend5m = atrTrendSeries5m[i];
    const macroDirection = idx1d >= 0 ? macroDirectionSeries1d[idx1d] : undefined;

    const atr5mRaw = atrSeries5m[i]; // raw ATR value (NOT percentile) — B.2's volAdjReturn5m denominator
    // TICKET-023 Phần B assumption (documented, not silently guessed): "% thay đổi giá nến 5m hiện
    // tại" = this candle's own open->close move, (close-open)/open — the most literal single-candle
    // reading of the ticket's wording (not the close-to-close return vs the prior candle).
    const candleReturnPct = ((candle.close - candle.open) / candle.open) * 100;
    const volAdjReturn5m = atr5mRaw !== undefined && !Number.isNaN(atr5mRaw) && atr5mRaw !== 0 ? candleReturnPct / atr5mRaw : NaN;

    const emaRatioFast = emaFast5m[i] / emaSlow5m[i];
    const emaRatioSlow = idx1h >= 0 ? ema1hFast[idx1h] / ema1hSlow[idx1h] : NaN;

    if (
      Number.isNaN(adx1h) ||
      adxDirection1h === undefined ||
      Number.isNaN(atrPercentile5m) ||
      Number.isNaN(bbWidthPercentile15m) ||
      Number.isNaN(volumeZScore5m) ||
      atrTrend5m === undefined ||
      macroDirection === undefined ||
      Number.isNaN(volAdjReturn5m) ||
      Number.isNaN(emaRatioFast) ||
      Number.isNaN(emaRatioSlow)
    ) {
      continue; // insufficient indicator history yet — skip, don't guess a value
    }

    // B.3 — Fixed-Time-Horizon label: does price reach +THRESHOLD_PCT at ANY point in the next
    // HORIZON_CANDLES closes? Not "ends up higher" — "touches the target at least once".
    if (i + HORIZON_CANDLES >= candles5m.length) continue; // not enough future candles to label — skip
    const target = candle.close * (1 + THRESHOLD_PCT);
    let label: 0 | 1 = 0;
    for (let j = i + 1; j <= i + HORIZON_CANDLES; j++) {
      if (candles5m[j].close >= target) {
        label = 1;
        break;
      }
    }

    rows.push({
      symbol,
      timestampUtc: candle.timestamp,
      adx1h,
      atrPercentile5m,
      bbWidthPercentile15m,
      volumeZScore5m,
      atrTrend5m,
      adxDirection1h,
      macroDirection,
      volAdjReturn5m,
      emaRatioFast,
      emaRatioSlow,
      label_bullish_momentum: label,
    });
  }

  return rows;
}

function rowsCsv(rows: Row[]): string {
  const header =
    'symbol,timestampUtc,adx1h,atrPercentile5m,bbWidthPercentile15m,volumeZScore5m,atrTrend5m,adxDirection1h,macroDirection,volAdjReturn5m,emaRatioFast,emaRatioSlow,label_bullish_momentum';
  const lines = rows.map((r) =>
    [
      r.symbol,
      r.timestampUtc,
      r.adx1h,
      r.atrPercentile5m,
      r.bbWidthPercentile15m,
      r.volumeZScore5m,
      r.atrTrend5m,
      r.adxDirection1h,
      r.macroDirection,
      r.volAdjReturn5m,
      r.emaRatioFast,
      r.emaRatioSlow,
      r.label_bullish_momentum,
    ].join(','),
  );
  return [header, ...lines].join('\n') + '\n';
}

function main(): void {
  const { ohlcvDir, outPath } = parseArgs();

  for (const symbol of SYMBOLS) {
    const missing = ['5m', '15m', '1h', '1d'].filter((tf) => !existsSync(path.join(ohlcvDir, `${symbol}_${tf}.csv`)));
    if (missing.length > 0) {
      throw new Error(`generateMomentumTrainingData: thiếu file CSV cho ${symbol} (${missing.join(', ')}) trong ${ohlcvDir}.`);
    }
  }

  const allRows: Row[] = [];
  for (const symbol of SYMBOLS) {
    console.log(`Quét ${symbol}...`);
    const rows = rowsForSymbol(symbol, ohlcvDir);
    allRows.push(...rows);
    console.log(`  → ${rows.length} nến có nhãn.`);
  }

  const outDir = path.dirname(outPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, rowsCsv(allRows));

  const totalRows = allRows.length;
  const bullishCount = allRows.filter((r) => r.label_bullish_momentum === 1).length;

  console.log('');
  console.log(`Tổng số dòng: ${totalRows}`);
  console.log(`label_bullish_momentum=1: ${bullishCount} (${totalRows > 0 ? ((bullishCount / totalRows) * 100).toFixed(1) : '0.0'}%) — =0: ${totalRows - bullishCount} (${totalRows > 0 ? (((totalRows - bullishCount) / totalRows) * 100).toFixed(1) : '0.0'}%)`);
  console.log(`→ ${outPath}`);
}

main();
