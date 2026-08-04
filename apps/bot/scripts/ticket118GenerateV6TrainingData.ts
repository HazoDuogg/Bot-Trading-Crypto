/**
 * TICKET-118 — Model V6 (bug fix for TICKET-117's finding). IDENTICAL to
 * ticket110GenerateV4TrainingData.ts (TICKET-110, 10 original V1 features) + ticket111GenerateV5TrainingData.ts's
 * (TICKET-111) 2 extra features (correlatedRiskRatio, distanceToNearestSwingAtr) in every formula/convention —
 * merged into one script here only so the ONE fix below can be applied at the single point where rows are
 * written, without touching ticket110/ticket111 themselves.
 *
 * THE FIX (TICKET-117): data/all-candidates-with-outcomes.csv (TICKET-109) already carries a `side`
 * (LONG/SHORT) column per row — 2 rows per (symbol,timestamp), one per side. ticket110's output NEVER
 * carried that column through, so momentum-v4/v5-labeled.csv have 2 rows per (symbol,timestamp) with
 * IDENTICAL feature values but potentially CONFLICTING label_win, and no feature to distinguish them.
 * This script adds a `side` column — a straight passthrough of each outcome row's own `side` field, no
 * new formula — so every row is uniquely identifiable again.
 *
 * Same 12 original features computed with the EXACT SAME indicator functions/formulas as ticket110+111
 * (nothing re-derived), same drop rules (blank win dropped, NaN feature rows dropped).
 *
 * EXPERIMENTAL TRAINING ONLY (TICKET-118) — does not touch backtest.ts/orchestrator.ts/liveRunner.ts/
 * xgbFilter/config.ts or any production file, does not modify ticket110/ticket111's scripts or outputs,
 * not wired into anything. Output: data/training/momentum-v6-labeled.csv only (momentum-v5-labeled.csv
 * is left untouched for reference).
 *
 * Run: npx tsx apps/bot/scripts/ticket118GenerateV6TrainingData.ts (from repo root, after `npm run build`
 * so apps/bot/dist/ exists — same convention as ticket110/ticket111).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CandleData } from '../dist/regime/types.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { EntryConfig } from '../dist/entry/config.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { detectSwingPoints, latestSwingPointBefore } from '../dist/entry/detectors/swingPoints.js';
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

// Same EMA periods as generateMomentumTrainingData.ts / ticket110 (copied, not re-derived).
const EMA_FAST_PERIOD = 9;
const EMA_SLOW_PERIOD = 21;
const EMA_1H_FAST_PERIOD = 50;
const EMA_1H_SLOW_PERIOD = 200;

const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const OUTCOMES_CSV = path.resolve(process.cwd(), 'data/all-candidates-with-outcomes.csv');
const OUT_PATH = path.resolve(process.cwd(), 'data/training/momentum-v6-labeled.csv');

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
  correlatedRiskRatio: number;
  distanceToNearestSwingAtr: number;
}

/**
 * Same precompute-once-over-full-history + two-pointer closed-candle alignment as ticket110's
 * computeFeaturesForSymbol() / ticket111's computeNewFeaturesForSymbol(), merged into one pass over
 * candles5m so both the 10 original + 2 new features are computed together. No formula differs from
 * either source script.
 */
function computeFeaturesForSymbol(
  symbol: string,
  timestamps: number[],
  correlatedRiskRatioSeries1h: number[],
  candles1h: CandleData[],
): Map<number, FeatureRow> {
  const candles5m = readCsv(path.join(OHLCV_DIR, `${symbol}_5m.csv`));
  const candles15m = readCsv(path.join(OHLCV_DIR, `${symbol}_15m.csv`));
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

  const swingPoints = detectSwingPoints(candles5m, EntryConfig.FRACTAL_N);

  const result = new Map<number, FeatureRow>();
  let idx1h = -1;
  let idx15m = -1;
  let idx1d = -1;
  let nextTargetIdx = 0;
  const sortedUniqueTimestamps = [...new Set(timestamps)].sort((a, b) => a - b);

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

    const correlatedRiskRatio = idx1h >= 0 ? correlatedRiskRatioSeries1h[idx1h] : NaN;

    // TICKET-096 look-ahead fix: only swing points confirmed strictly before i - FRACTAL_N.
    const nearestHigh = latestSwingPointBefore(swingPoints, 'HIGH', i - EntryConfig.FRACTAL_N);
    const nearestLow = latestSwingPointBefore(swingPoints, 'LOW', i - EntryConfig.FRACTAL_N);
    let distanceToNearestSwingAtr = NaN;
    if (atr5mRaw !== undefined && !Number.isNaN(atr5mRaw) && atr5mRaw > 0 && (nearestHigh !== null || nearestLow !== null)) {
      const distHigh = nearestHigh !== null ? Math.abs(candle.close - nearestHigh.price) : Infinity;
      const distLow = nearestLow !== null ? Math.abs(candle.close - nearestLow.price) : Infinity;
      distanceToNearestSwingAtr = Math.min(distHigh, distLow) / atr5mRaw;
    }

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
      Number.isNaN(emaRatioSlow) ||
      Number.isNaN(correlatedRiskRatio) ||
      Number.isNaN(distanceToNearestSwingAtr)
    ) {
      continue; // insufficient indicator history — skip, don't guess (same rule as ticket110/ticket111)
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
      correlatedRiskRatio,
      distanceToNearestSwingAtr,
    });
  }

  return result;
}

function main(): void {
  for (const symbol of SYMBOLS) {
    const missing = ['5m', '15m', '1h', '1d'].filter((tf) => !existsSync(path.join(OHLCV_DIR, `${symbol}_${tf}.csv`)));
    if (missing.length > 0) {
      throw new Error(`ticket118GenerateV6TrainingData: thiếu file CSV cho ${symbol} (${missing.join(', ')}) trong ${OHLCV_DIR}.`);
    }
  }
  if (!existsSync(OUTCOMES_CSV)) {
    throw new Error(`ticket118GenerateV6TrainingData: không tìm thấy ${OUTCOMES_CSV} (chạy TICKET-109's script trước).`);
  }

  const outcomes = readOutcomes();

  const candles1hBySymbol: Record<string, CandleData[]> = {};
  for (const symbol of SYMBOLS) candles1hBySymbol[symbol] = readCsv(path.join(OHLCV_DIR, `${symbol}_1h.csv`));
  const lens = Object.values(candles1hBySymbol).map((c) => c.length);
  if (new Set(lens).size !== 1) {
    throw new Error(`ticket118GenerateV6TrainingData: file 1h không cùng độ dài giữa 4 coin (${lens.join(',')}).`);
  }
  const correlatedRiskRatioSeries1h = computeCorrelatedRiskRatio(candles1hBySymbol, RegimeConfig.CORRELATED_RISK_WINDOW_CANDLES, 'BTCUSDT');

  const outputLines: string[] = [
    'symbol,timestampUtc,adx1h,atrPercentile5m,bbWidthPercentile15m,volumeZScore5m,atrTrend5m,adxDirection1h,macroDirection,volAdjReturn5m,emaRatioFast,emaRatioSlow,correlatedRiskRatio,distanceToNearestSwingAtr,side,label_win',
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
      correlatedRiskRatioSeries1h,
      candles1hBySymbol[symbol],
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
          f.correlatedRiskRatio,
          f.distanceToNearestSwingAtr,
          row.side,
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
