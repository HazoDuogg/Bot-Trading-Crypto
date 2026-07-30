/**
 * TICKET-110 — Model V4. Isolates ONE variable vs. production V1 (xgb_momentum_v1.onnx,
 * apps/bot/scripts/generateMomentumTrainingData.ts): SAME 10 features, computed with the EXACT SAME
 * indicator functions/two-pointer closed-candle alignment/feature formulas (nothing re-derived here,
 * only copied), but keyed to the SPECIFIC (symbol, timestamp) evaluation rows in
 * data/all-candidates-with-outcomes.csv (TICKET-109) instead of every 5m candle, and labeled with the
 * REAL trade-outcome `win` column instead of the Fixed-Time-Horizon label.
 *
 * Each (symbol, timestamp) appears twice in the source CSV (one row per side, LONG+SHORT) — features
 * depend only on (symbol, timestamp), not side, so both output rows for a given (symbol, timestamp)
 * share identical feature values but can carry different label_win (the two sides can have different
 * real outcomes at the same instant). Rows with a blank `win` (~1,530 — ran out of future candles to
 * resolve, per TICKET-109's own doc comment) are DROPPED, not imputed.
 *
 * EXPERIMENTAL TRAINING ONLY (TICKET-110) — does not touch backtest.ts/orchestrator.ts/liveRunner.ts/
 * xgbFilter/config.ts or any production file, does not add new features or monotonic constraints, not
 * wired into anything. Output: data/training/momentum-v4-labeled.csv only.
 *
 * Run: npx tsx apps/bot/scripts/ticket110GenerateV4TrainingData.ts (from repo root, after `npm run build`
 * so apps/bot/dist/ exists — same convention as ticket108/109's own scripts).
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

// Same EMA periods as generateMomentumTrainingData.ts (copied, not re-derived).
const EMA_FAST_PERIOD = 9;
const EMA_SLOW_PERIOD = 21;
const EMA_1H_FAST_PERIOD = 50;
const EMA_1H_SLOW_PERIOD = 200;

const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const OUTCOMES_CSV = path.resolve(process.cwd(), 'data/all-candidates-with-outcomes.csv');
const OUT_PATH = path.resolve(process.cwd(), 'data/training/momentum-v4-labeled.csv');

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

interface OutcomeRow {
  symbol: string;
  timestamp: number;
  side: 'LONG' | 'SHORT';
  win: 0 | 1;
}

function readOutcomes(): OutcomeRow[] {
  const lines = readFileSync(OUTCOMES_CSV, 'utf-8').trim().split('\n');
  const rows: OutcomeRow[] = [];
  let droppedBlankWin = 0;
  for (const line of lines.slice(1)) {
    const [symbol, timestamp, side, , , , win] = line.split(',');
    if (win === '' || win === undefined) {
      droppedBlankWin++;
      continue; // TICKET-109: unresolved (ran out of future candles) — drop, don't impute.
    }
    rows.push({ symbol, timestamp: Number(timestamp), side: side as 'LONG' | 'SHORT', win: win === 'true' ? 1 : 0 });
  }
  console.log(`Đọc ${OUTCOMES_CSV}: ${lines.length - 1} dòng, bỏ ${droppedBlankWin} dòng win rỗng (chưa resolve được).`);
  return rows;
}

interface FeatureRow {
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
}

/**
 * Same precompute-once-over-full-history + two-pointer closed-candle alignment as
 * generateMomentumTrainingData.ts's rowsForSymbol(), but looked up by explicit candle INDEX (found via
 * a timestamp→index map) instead of iterating i=0..length. No formula differs.
 */
function computeFeaturesForSymbol(symbol: string, timestamps: number[]): Map<number, FeatureRow> {
  const candles5m = readCsv(path.join(OHLCV_DIR, `${symbol}_5m.csv`));
  const candles15m = readCsv(path.join(OHLCV_DIR, `${symbol}_15m.csv`));
  const candles1h = readCsv(path.join(OHLCV_DIR, `${symbol}_1h.csv`));
  const candles1d = readCsv(path.join(OHLCV_DIR, `${symbol}_1d.csv`));

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

  // timestamp (candle open time, == currentCandle.timestamp at evaluation time — see
  // orchestrator.ts's MomentumGateEvaluation.timestamp, always currentCandle.timestamp) → index i.
  const indexByTimestamp = new Map<number, number>();
  for (let i = 0; i < candles5m.length; i++) indexByTimestamp.set(candles5m[i].timestamp, i);

  const result = new Map<number, FeatureRow>();
  let idx1h = -1;
  let idx15m = -1;
  let idx1d = -1;
  let nextTargetIdx = 0;
  const sortedUniqueTimestamps = [...new Set(timestamps)].sort((a, b) => a - b);

  // Walk candles5m forward ONCE (two-pointer alignment requires ascending order), only materializing a
  // feature row when we hit one of the requested timestamps — avoids recomputing per-lookup.
  for (let i = 0; i < candles5m.length && nextTargetIdx < sortedUniqueTimestamps.length; i++) {
    const candle = candles5m[i];
    const decisionTime = candle.timestamp + 5 * 60_000;
    while (idx1h + 1 < candles1h.length && candles1h[idx1h + 1].timestamp + 60 * 60_000 <= decisionTime) idx1h++;
    while (idx15m + 1 < candles15m.length && candles15m[idx15m + 1].timestamp + 15 * 60_000 <= decisionTime) idx15m++;
    while (idx1d + 1 < candles1d.length && candles1d[idx1d + 1].timestamp + 24 * 60 * 60_000 <= decisionTime) idx1d++;

    if (candle.timestamp !== sortedUniqueTimestamps[nextTargetIdx]) continue;
    nextTargetIdx++;

    const adx1h = idx1h >= 0 ? adxSeries1h[idx1h] : NaN;
    const adxDirection1h = idx1h >= 0 ? adxDirectionSeries1h[idx1h] : undefined;
    const atrPercentile5m = atrPercentileSeries5m[i];
    const bbWidthPercentile15m = idx15m >= 0 ? bbwPercentileSeries15m[idx15m] : NaN;
    const volumeZScore5m = volumeZScoreSeries5m[i];
    const atrTrend5m = atrTrendSeries5m[i];
    const macroDirection = idx1d >= 0 ? macroDirectionSeries1d[idx1d] : undefined;

    const atr5mRaw = atrSeries5m[i];
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
      continue; // insufficient indicator history — skip, don't guess (same rule as generateMomentumTrainingData.ts)
    }

    result.set(candle.timestamp, {
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
    });
  }

  return result;
}

function main(): void {
  for (const symbol of SYMBOLS) {
    const missing = ['5m', '15m', '1h', '1d'].filter((tf) => !existsSync(path.join(OHLCV_DIR, `${symbol}_${tf}.csv`)));
    if (missing.length > 0) {
      throw new Error(`ticket110GenerateV4TrainingData: thiếu file CSV cho ${symbol} (${missing.join(', ')}) trong ${OHLCV_DIR}.`);
    }
  }
  if (!existsSync(OUTCOMES_CSV)) {
    throw new Error(`ticket110GenerateV4TrainingData: không tìm thấy ${OUTCOMES_CSV} (chạy TICKET-109's script trước).`);
  }

  const outcomes = readOutcomes();

  const outputLines: string[] = [
    'symbol,timestampUtc,adx1h,atrPercentile5m,bbWidthPercentile15m,volumeZScore5m,atrTrend5m,adxDirection1h,macroDirection,volAdjReturn5m,emaRatioFast,emaRatioSlow,label_win',
  ];

  let totalOutputRows = 0;
  let missingFeatureRows = 0;

  for (const symbol of SYMBOLS) {
    const symbolOutcomes = outcomes.filter((r) => r.symbol === symbol);
    if (symbolOutcomes.length === 0) continue;
    console.log(`Quét ${symbol}: ${symbolOutcomes.length} dòng outcome (${new Set(symbolOutcomes.map((r) => r.timestamp)).size} timestamp duy nhất)...`);

    const featuresByTimestamp = computeFeaturesForSymbol(
      symbol,
      symbolOutcomes.map((r) => r.timestamp),
    );

    for (const row of symbolOutcomes) {
      const f = featuresByTimestamp.get(row.timestamp);
      if (!f) {
        missingFeatureRows++; // insufficient indicator history at this timestamp — skip, don't guess
        continue;
      }
      outputLines.push(
        [
          symbol,
          row.timestamp,
          f.adx1h,
          f.atrPercentile5m,
          f.bbWidthPercentile15m,
          f.volumeZScore5m,
          f.atrTrend5m,
          f.adxDirection1h,
          f.macroDirection,
          f.volAdjReturn5m,
          f.emaRatioFast,
          f.emaRatioSlow,
          row.win,
        ].join(','),
      );
      totalOutputRows++;
    }
  }

  const outDir = path.dirname(OUT_PATH);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(OUT_PATH, outputLines.join('\n') + '\n');

  console.log('');
  console.log(`Bỏ ${missingFeatureRows} dòng do thiếu lịch sử indicator tại timestamp đó (không đoán giá trị).`);
  console.log(`Tổng số dòng ghi: ${totalOutputRows}`);
  const winCount = outcomes.filter((r) => r.win === 1).length;
  console.log(`(tham khảo) win=1 trong toàn bộ outcomes đã đọc: ${winCount}/${outcomes.length} (${((winCount / outcomes.length) * 100).toFixed(1)}%)`);
  console.log(`→ ${OUT_PATH}`);
}

main();
