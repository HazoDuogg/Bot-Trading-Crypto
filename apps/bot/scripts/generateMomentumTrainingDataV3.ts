/**
 * TICKET-097 — so sánh công bằng: giữ NGUYÊN nhãn % cũ (0.5%/50 phút, generateMomentumTrainingData.ts
 * gốc, KHÔNG đổi sang R-multiple của V2/TICKET-096), CHỈ thêm 2 feature đã xác nhận SẠCH (không rò
 * rỉ) từ TICKET-096: correlatedRiskRatio + distanceToNearestSwingAtr (dùng đúng bản đã sửa lỗi
 * look-ahead — Bug 1 của TICKET-096). KHÔNG đưa lossStreak* trở lại (đã xác nhận rò rỉ, Bug 2).
 *
 * Tách riêng khỏi generateMomentumTrainingData.ts gốc VÀ generateMomentumTrainingDataV2.ts — không
 * sửa/ghi đè file nào trong 2 file đó. Output riêng: data/training/momentum-labeled-v3.csv.
 *
 * Run: npm run build:scripts && node apps/bot/scripts-dist/generateMomentumTrainingDataV3.js
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
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { detectSwingPoints, latestSwingPointBefore } from '../dist/entry/detectors/swingPoints.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];

// Giữ NGUYÊN như bản gốc (generateMomentumTrainingData.ts) — không đổi.
const HORIZON_CANDLES = 10;
const THRESHOLD_PCT = 0.005;

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
    outPath: path.resolve(process.cwd(), outArg ? outArg.split('=')[1] : 'data/training/momentum-labeled-v3.csv'),
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
  correlatedRiskRatio: number;
  distanceToNearestSwingAtr: number;
  label_bullish_momentum: 0 | 1;
  label_bearish_momentum: 0 | 1;
}

function main(): void {
  const { ohlcvDir, outPath } = parseArgs();

  for (const symbol of SYMBOLS) {
    const missing = ['5m', '15m', '1h', '1d'].filter((tf) => !existsSync(path.join(ohlcvDir, `${symbol}_${tf}.csv`)));
    if (missing.length > 0) {
      throw new Error(`generateMomentumTrainingDataV3: thiếu file CSV cho ${symbol} (${missing.join(', ')}) trong ${ohlcvDir}.`);
    }
  }

  const candles1hBySymbol: Record<string, CandleData[]> = {};
  for (const symbol of SYMBOLS) candles1hBySymbol[symbol] = readCsv(path.join(ohlcvDir, `${symbol}_1h.csv`));
  const lens = Object.values(candles1hBySymbol).map((c) => c.length);
  if (new Set(lens).size !== 1) {
    throw new Error(`generateMomentumTrainingDataV3: file 1h không cùng độ dài giữa 4 coin (${lens.join(',')}).`);
  }
  const correlatedRiskRatioSeries1h = computeCorrelatedRiskRatio(candles1hBySymbol, RegimeConfig.CORRELATED_RISK_WINDOW_CANDLES, 'BTCUSDT');

  const allRows: Row[] = [];

  for (const symbol of SYMBOLS) {
    console.log(`Quét ${symbol}...`);
    const candles5m = readCsv(path.join(ohlcvDir, `${symbol}_5m.csv`));
    const candles15m = readCsv(path.join(ohlcvDir, `${symbol}_15m.csv`));
    const candles1h = candles1hBySymbol[symbol];
    const candles1d = readCsv(path.join(ohlcvDir, `${symbol}_1d.csv`));

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

    const rows: Row[] = [];
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
      const correlatedRiskRatio = idx1h >= 0 ? correlatedRiskRatioSeries1h[idx1h] : NaN;

      const atr5mRaw = atrSeries5m[i];
      const candleReturnPct = ((candle.close - candle.open) / candle.open) * 100;
      const volAdjReturn5m = atr5mRaw !== undefined && !Number.isNaN(atr5mRaw) && atr5mRaw !== 0 ? candleReturnPct / atr5mRaw : NaN;

      const emaRatioFast = emaFast5m[i] / emaSlow5m[i];
      const emaRatioSlow = idx1h >= 0 ? ema1hFast[idx1h] / ema1hSlow[idx1h] : NaN;

      // Bug 1 fix từ TICKET-096: chỉ chấp nhận swing point đã xác nhận được TRƯỚC thời điểm quyết
      // định i (query với `i - fractalN`, không phải `i`), tránh rò rỉ nhìn-trước.
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
        continue;
      }

      // Nhãn Fixed-Time-Horizon % CŨ — giữ nguyên y hệt bản gốc, không đổi công thức.
      if (i + HORIZON_CANDLES >= candles5m.length) continue;
      const bullishTarget = candle.close * (1 + THRESHOLD_PCT);
      const bearishTarget = candle.close * (1 - THRESHOLD_PCT);
      let bullishLabel: 0 | 1 = 0;
      let bearishLabel: 0 | 1 = 0;
      for (let j = i + 1; j <= i + HORIZON_CANDLES; j++) {
        if (candles5m[j].close >= bullishTarget) bullishLabel = 1;
        if (candles5m[j].close <= bearishTarget) bearishLabel = 1;
        if (bullishLabel === 1 && bearishLabel === 1) break;
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
        correlatedRiskRatio,
        distanceToNearestSwingAtr,
        label_bullish_momentum: bullishLabel,
        label_bearish_momentum: bearishLabel,
      });
    }

    allRows.push(...rows);
    console.log(`  → ${rows.length} nến có nhãn.`);
  }

  const header =
    'symbol,timestampUtc,adx1h,atrPercentile5m,bbWidthPercentile15m,volumeZScore5m,atrTrend5m,adxDirection1h,macroDirection,volAdjReturn5m,emaRatioFast,emaRatioSlow,correlatedRiskRatio,distanceToNearestSwingAtr,label_bullish_momentum,label_bearish_momentum';
  const lines = allRows.map((r) =>
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
      r.correlatedRiskRatio,
      r.distanceToNearestSwingAtr,
      r.label_bullish_momentum,
      r.label_bearish_momentum,
    ].join(','),
  );
  const csv = [header, ...lines].join('\n') + '\n';

  const outDir = path.dirname(outPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, csv);

  const totalRows = allRows.length;
  const bullishCount = allRows.filter((r) => r.label_bullish_momentum === 1).length;
  const bearishCount = allRows.filter((r) => r.label_bearish_momentum === 1).length;

  console.log('');
  console.log(`Tổng số dòng: ${totalRows}`);
  console.log(`label_bullish_momentum=1: ${bullishCount} (${((bullishCount / totalRows) * 100).toFixed(1)}%)`);
  console.log(`label_bearish_momentum=1: ${bearishCount} (${((bearishCount / totalRows) * 100).toFixed(1)}%)`);
  console.log(`→ ${outPath}`);
}

main();
