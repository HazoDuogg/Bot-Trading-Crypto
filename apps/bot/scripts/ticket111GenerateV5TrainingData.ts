/**
 * TICKET-111 — Model V5. Starts from TICKET-110's data/training/momentum-v4-labeled.csv (322,646 rows,
 * 10 original V1 features + real-outcome `label_win`) and appends 2 EXTRA features already proven useful
 * for the OLD label in TICKET-096/097: `correlatedRiskRatio` and `distanceToNearestSwingAtr`. Both are
 * computed with the EXACT SAME code path as apps/bot/scripts/generateMomentumTrainingDataV3.ts (copied,
 * not re-derived) — computeCorrelatedRiskRatio() from apps/bot/src/regime/correlatedRisk.ts with
 * RegimeConfig.CORRELATED_RISK_WINDOW_CANDLES/anchor 'BTCUSDT', and detectSwingPoints/
 * latestSwingPointBefore() from apps/bot/src/entry/detectors/swingPoints.ts with the TICKET-096
 * look-ahead fix (query swing points strictly before `i - FRACTAL_N`).
 *
 * The 10 original feature VALUES are carried over unchanged from momentum-v4-labeled.csv (not
 * recomputed) — only the 2 new columns are computed fresh here, keyed by the same (symbol, timestampUtc)
 * pairs. Rows where either new feature is NaN (insufficient history — same guard V3 uses) are dropped.
 *
 * EXPERIMENTAL TRAINING ONLY (TICKET-111) — does not touch backtest.ts/orchestrator.ts/liveRunner.ts/
 * xgbFilter/config.ts or any production file, does not modify the 2 features' formulas, not wired into
 * anything. Output: data/training/momentum-v5-labeled.csv only.
 *
 * Run: npx tsx apps/bot/scripts/ticket111GenerateV5TrainingData.ts (from repo root, after `npm run build`
 * so apps/bot/dist/ exists).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CandleData } from '../dist/regime/types.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { EntryConfig } from '../dist/entry/config.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { detectSwingPoints, latestSwingPointBefore } from '../dist/entry/detectors/swingPoints.js';
import { wilderATRSeries } from '../dist/regime/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];

const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const V4_CSV = path.resolve(process.cwd(), 'data/training/momentum-v4-labeled.csv');
const OUT_PATH = path.resolve(process.cwd(), 'data/training/momentum-v5-labeled.csv');

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

interface V4Row {
  symbol: string;
  timestampUtc: number;
  restOfLine: string; // adx1h..emaRatioSlow,label_win, joined verbatim from the V4 CSV
}

function readV4(): V4Row[] {
  const lines = readFileSync(V4_CSV, 'utf-8').trim().split('\n');
  const rows: V4Row[] = [];
  for (const line of lines.slice(1)) {
    const firstComma = line.indexOf(',');
    const secondComma = line.indexOf(',', firstComma + 1);
    const symbol = line.slice(0, firstComma);
    const timestampUtc = Number(line.slice(firstComma + 1, secondComma));
    const restOfLine = line.slice(secondComma + 1);
    rows.push({ symbol, timestampUtc, restOfLine });
  }
  return rows;
}

interface NewFeatures {
  correlatedRiskRatio: number;
  distanceToNearestSwingAtr: number;
}

/**
 * Same precompute-once-over-full-history two-pointer alignment as generateMomentumTrainingDataV3.ts's
 * main loop, but only materializing a result when we hit one of the requested timestamps (mirrors
 * ticket110GenerateV4TrainingData.ts's computeFeaturesForSymbol lookup pattern).
 */
function computeNewFeaturesForSymbol(
  symbol: string,
  timestamps: number[],
  correlatedRiskRatioSeries1h: number[],
  candles1h: CandleData[],
): Map<number, NewFeatures> {
  const candles5m = readCsv(path.join(OHLCV_DIR, `${symbol}_5m.csv`));
  const atrSeries5m = wilderATRSeries(candles5m, RegimeConfig.ATR_PERIOD_5M);
  const swingPoints = detectSwingPoints(candles5m, EntryConfig.FRACTAL_N);

  const result = new Map<number, NewFeatures>();
  let idx1h = -1;
  let nextTargetIdx = 0;
  const sortedUniqueTimestamps = [...new Set(timestamps)].sort((a, b) => a - b);

  for (let i = 0; i < candles5m.length && nextTargetIdx < sortedUniqueTimestamps.length; i++) {
    const candle = candles5m[i];
    const decisionTime = candle.timestamp + 5 * 60_000;
    while (idx1h + 1 < candles1h.length && candles1h[idx1h + 1].timestamp + 60 * 60_000 <= decisionTime) idx1h++;

    if (candle.timestamp !== sortedUniqueTimestamps[nextTargetIdx]) continue;
    nextTargetIdx++;

    const correlatedRiskRatio = idx1h >= 0 ? correlatedRiskRatioSeries1h[idx1h] : NaN;

    const atr5mRaw = atrSeries5m[i];
    // TICKET-096 look-ahead fix: only swing points confirmed strictly before i - FRACTAL_N.
    const nearestHigh = latestSwingPointBefore(swingPoints, 'HIGH', i - EntryConfig.FRACTAL_N);
    const nearestLow = latestSwingPointBefore(swingPoints, 'LOW', i - EntryConfig.FRACTAL_N);
    let distanceToNearestSwingAtr = NaN;
    if (atr5mRaw !== undefined && !Number.isNaN(atr5mRaw) && atr5mRaw > 0 && (nearestHigh !== null || nearestLow !== null)) {
      const distHigh = nearestHigh !== null ? Math.abs(candle.close - nearestHigh.price) : Infinity;
      const distLow = nearestLow !== null ? Math.abs(candle.close - nearestLow.price) : Infinity;
      distanceToNearestSwingAtr = Math.min(distHigh, distLow) / atr5mRaw;
    }

    if (Number.isNaN(correlatedRiskRatio) || Number.isNaN(distanceToNearestSwingAtr)) continue;

    result.set(candle.timestamp, { correlatedRiskRatio, distanceToNearestSwingAtr });
  }

  return result;
}

function main(): void {
  for (const symbol of SYMBOLS) {
    const missing = ['5m', '1h'].filter((tf) => !existsSync(path.join(OHLCV_DIR, `${symbol}_${tf}.csv`)));
    if (missing.length > 0) {
      throw new Error(`ticket111GenerateV5TrainingData: thiếu file CSV cho ${symbol} (${missing.join(', ')}) trong ${OHLCV_DIR}.`);
    }
  }
  if (!existsSync(V4_CSV)) {
    throw new Error(`ticket111GenerateV5TrainingData: không tìm thấy ${V4_CSV} (chạy TICKET-110's script trước).`);
  }

  const v4Rows = readV4();
  console.log(`Đọc ${V4_CSV}: ${v4Rows.length} dòng.`);

  const candles1hBySymbol: Record<string, CandleData[]> = {};
  for (const symbol of SYMBOLS) candles1hBySymbol[symbol] = readCsv(path.join(OHLCV_DIR, `${symbol}_1h.csv`));
  const lens = Object.values(candles1hBySymbol).map((c) => c.length);
  if (new Set(lens).size !== 1) {
    throw new Error(`ticket111GenerateV5TrainingData: file 1h không cùng độ dài giữa 4 coin (${lens.join(',')}).`);
  }
  const correlatedRiskRatioSeries1h = computeCorrelatedRiskRatio(candles1hBySymbol, RegimeConfig.CORRELATED_RISK_WINDOW_CANDLES, 'BTCUSDT');

  const outputLines: string[] = [
    'symbol,timestampUtc,adx1h,atrPercentile5m,bbWidthPercentile15m,volumeZScore5m,atrTrend5m,adxDirection1h,macroDirection,volAdjReturn5m,emaRatioFast,emaRatioSlow,correlatedRiskRatio,distanceToNearestSwingAtr,label_win',
  ];

  let totalOutputRows = 0;
  let droppedNewFeatureRows = 0;

  for (const symbol of SYMBOLS) {
    const symbolRows = v4Rows.filter((r) => r.symbol === symbol);
    if (symbolRows.length === 0) continue;
    console.log(`Quét ${symbol}: ${symbolRows.length} dòng V4 (${new Set(symbolRows.map((r) => r.timestampUtc)).size} timestamp duy nhất)...`);

    const newFeaturesByTimestamp = computeNewFeaturesForSymbol(
      symbol,
      symbolRows.map((r) => r.timestampUtc),
      correlatedRiskRatioSeries1h,
      candles1hBySymbol[symbol],
    );

    for (const row of symbolRows) {
      const nf = newFeaturesByTimestamp.get(row.timestampUtc);
      if (!nf) {
        droppedNewFeatureRows++; // NaN / insufficient history for correlatedRiskRatio or distanceToNearestSwingAtr — drop, don't impute
        continue;
      }
      // restOfLine = "adx1h,...,emaRatioSlow,label_win" — splice the 2 new features in before label_win.
      const lastComma = row.restOfLine.lastIndexOf(',');
      const originalTenFeatures = row.restOfLine.slice(0, lastComma);
      const labelWin = row.restOfLine.slice(lastComma + 1);
      outputLines.push(
        [symbol, row.timestampUtc, originalTenFeatures, nf.correlatedRiskRatio, nf.distanceToNearestSwingAtr, labelWin].join(','),
      );
      totalOutputRows++;
    }
  }

  const outDir = path.dirname(OUT_PATH);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(OUT_PATH, outputLines.join('\n') + '\n');

  console.log('');
  console.log(`Bỏ ${droppedNewFeatureRows} dòng do correlatedRiskRatio/distanceToNearestSwingAtr = NaN (thiếu lịch sử).`);
  console.log(`Tổng số dòng ghi: ${totalOutputRows}`);
  console.log(`→ ${OUT_PATH}`);
}

main();
