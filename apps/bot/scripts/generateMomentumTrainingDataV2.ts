/**
 * TICKET-096 (theo dõi từ TICKET-095) — vòng train thử nghiệm MỚI, tách hoàn toàn khỏi
 * generateMomentumTrainingData.ts gốc (không sửa/không ghi đè file đó hay
 * data/training/momentum-labeled.csv — output riêng: data/training/momentum-labeled-v2.csv).
 *
 * 2 thay đổi PM đã duyệt (không tự chọn thêm gì khác):
 *
 * 1) NHÃN theo R-multiple thay vì % cố định (đề xuất #3, TICKET-095) — khớp đúng công thức SL/TP
 *    THẬT của MOMENTUM_DIRECT trong orchestrator.ts (TICKET-059/064): SL = low/high nến hiện tại ±
 *    EntryConfig.SL_BUFFER_ATR_MULTIPLIER(0.1)×ATR, nới ra tối thiểu MOMENTUM_MIN_SL_PERCENT nếu hẹp
 *    hơn; TP = entry ± TP_R_MULTIPLE×R. Label=1 nếu giá chạm TP TRƯỚC khi chạm SL trong
 *    R_LABEL_HORIZON_CANDLES nến tới (SL chạm trước nếu cùng nến, đúng quy ước "SL chạm trước" đã
 *    dùng trong toàn bộ backtest.ts). TODO_CONFIRM: dùng MOMENTUM_MIN_SL_PERCENT=1.0% (mặc định
 *    PRODUCTION hiện tại trong EntryConfig/DEFAULT_ORCHESTRATOR_CONFIG — mức 1.27% của TICKET-093
 *    mới chỉ là thử nghiệm CLI, CHƯA cập nhật vào default) và TP_R_MULTIPLE=3.0 (khớp
 *    --momentum-direct-tp-r-multiple=3.0 dùng trong baseline chính thức). R_LABEL_HORIZON_CANDLES=100
 *    (500 phút) là TODO_CONFIRM riêng của bước này — PM chưa cho số, chọn đủ rộng để đa số lệnh
 *    MOMENTUM_DIRECT thật (theo dữ liệu backtest) đã đóng trong khung này.
 *
 * 2) 3 FEATURE MỚI (đề xuất #1/#5/#6, TICKET-095), 2 đề xuất còn lại (#2 độ trễ TREND_RIDER, #4
 *    regime one-hot) CHƯA thêm theo đúng phạm vi PM chọn:
 *    - correlatedRiskRatio: TÁI SỬ DỤNG y nguyên regime/correlatedRisk.ts computeCorrelatedRiskRatio()
 *      (không viết lại công thức) — gọi 1 LẦN trên toàn bộ lịch sử 1h đã căn chỉnh cùng độ dài giữa
 *      4 coin (xác nhận: cả 4 file 1h đều 4556 dòng, cùng timestamp bắt đầu), đúng cách backtest.ts
 *      gọi mỗi step (hàm tự dùng cửa sổ trailing riêng từng index, gọi 1 lần trên toàn mảng cho kết
 *      quả giống hệt gọi lặp lại mỗi step).
 *    - distanceToNearestSwingAtr: TÁI SỬ DỤNG detectSwingPoints()/latestSwingPointBefore() từ
 *      entry/detectors/swingPoints.ts (không viết lại) — khoảng cách (đơn vị ATR) từ giá đóng cửa nến
 *      hiện tại tới swing point gần nhất (HIGH hoặc LOW, lấy min).
 *    - lossStreakBullish/lossStreakBearish: proxy nhân quả (causal) cho "số lần thua liên tiếp cùng
 *      symbol+side" — vì mô phỏng lệnh thật cho MỌI nến (không chỉ nến có Draft Setup) quá tốn kém,
 *      dùng chuỗi thua liên tiếp của CHÍNH nhãn R-multiple (chỉ dùng dữ liệu QUÁ KHỨ, không leak
 *      tương lai) làm proxy — số nến liên tiếp gần nhất có label=0 trước nến hiện tại, reset về 0 khi
 *      gặp label=1. Đây là giới hạn đã biết (không phải chuỗi lệnh thật đã thực thi), ghi rõ trong báo cáo.
 *
 * Run: npm run build:scripts && node apps/bot/scripts-dist/generateMomentumTrainingDataV2.js
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

const EMA_FAST_PERIOD = 9;
const EMA_SLOW_PERIOD = 21;
const EMA_1H_FAST_PERIOD = 50;
const EMA_1H_SLOW_PERIOD = 200;

// TODO_CONFIRM (see module doc): mirrors MOMENTUM_DIRECT's real SL/TP formula (orchestrator.ts).
const MOMENTUM_MIN_SL_PERCENT = 1.0;
const TP_R_MULTIPLE = 3.0;
const R_LABEL_HORIZON_CANDLES = 100;

function parseArgs(): { ohlcvDir: string; outPath: string } {
  const args = process.argv.slice(2);
  const ohlcvDirArg = args.find((a) => a.startsWith('--ohlcv-dir='));
  const outArg = args.find((a) => a.startsWith('--out='));
  return {
    ohlcvDir: path.resolve(process.cwd(), ohlcvDirArg ? ohlcvDirArg.split('=')[1] : 'data/ohlcv'),
    outPath: path.resolve(process.cwd(), outArg ? outArg.split('=')[1] : 'data/training/momentum-labeled-v2.csv'),
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
  lossStreakBullish: number;
  lossStreakBearish: number;
  label_bullish_momentum_r: 0 | 1;
  label_bearish_momentum_r: 0 | 1;
}

function main(): void {
  const { ohlcvDir, outPath } = parseArgs();

  for (const symbol of SYMBOLS) {
    const missing = ['5m', '15m', '1h', '1d'].filter((tf) => !existsSync(path.join(ohlcvDir, `${symbol}_${tf}.csv`)));
    if (missing.length > 0) {
      throw new Error(`generateMomentumTrainingDataV2: thiếu file CSV cho ${symbol} (${missing.join(', ')}) trong ${ohlcvDir}.`);
    }
  }

  // --- correlatedRiskRatio: computed ONCE across all 4 symbols' full 1h history (index-aligned). ---
  const candles1hBySymbol: Record<string, CandleData[]> = {};
  for (const symbol of SYMBOLS) candles1hBySymbol[symbol] = readCsv(path.join(ohlcvDir, `${symbol}_1h.csv`));
  const lens = Object.values(candles1hBySymbol).map((c) => c.length);
  if (new Set(lens).size !== 1) {
    throw new Error(`generateMomentumTrainingDataV2: file 1h không cùng độ dài giữa 4 coin (${lens.join(',')}) — computeCorrelatedRiskRatio yêu cầu index-aligned.`);
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
    let bullishStreak = 0;
    let bearishStreak = 0;

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

      // TICKET-096 bugfix: swingPoints was precomputed ONCE over the FULL history (for performance,
      // same as every other series in this script), unlike production callers (orderBlock.ts) which
      // always pass a candles window truncated to "now" — detectSwingPoints's own loop bound
      // (`i < candles.length - fractalN`) is what makes a point near the array's end unconfirmable
      // there. Precomputing over the whole array defeats that safety: a point near index i can have
      // been confirmed using candles AFTER i (real timestamps in the future relative to decision time
      // i), which is lookahead leakage. Fix: only accept a point confirmable BY time i, i.e.
      // point.index + fractalN < i — achieved by querying with `i - fractalN` instead of `i`.
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
        Number.isNaN(distanceToNearestSwingAtr) ||
        atr5mRaw === undefined ||
        Number.isNaN(atr5mRaw) ||
        atr5mRaw <= 0
      ) {
        continue;
      }

      // R-multiple label — mirrors orchestrator.ts's MOMENTUM_DIRECT SL/TP formula exactly.
      const entryPrice = candle.close;
      const bufferBullish = EntryConfig.SL_BUFFER_ATR_MULTIPLIER * atr5mRaw;
      let slBullish = candle.low - bufferBullish;
      let slBearish = candle.high + bufferBullish;
      const rawSlDistBullishPct = ((entryPrice - slBullish) / entryPrice) * 100;
      if (rawSlDistBullishPct < MOMENTUM_MIN_SL_PERCENT) slBullish = entryPrice - (MOMENTUM_MIN_SL_PERCENT / 100) * entryPrice;
      const rawSlDistBearishPct = ((slBearish - entryPrice) / entryPrice) * 100;
      if (rawSlDistBearishPct < MOMENTUM_MIN_SL_PERCENT) slBearish = entryPrice + (MOMENTUM_MIN_SL_PERCENT / 100) * entryPrice;

      const rBullish = entryPrice - slBullish;
      const rBearish = slBearish - entryPrice;
      const tpBullish = entryPrice + TP_R_MULTIPLE * rBullish;
      const tpBearish = entryPrice - TP_R_MULTIPLE * rBearish;

      let bullishLabel: 0 | 1 = 0;
      let bearishLabel: 0 | 1 = 0;
      if (i + R_LABEL_HORIZON_CANDLES < candles5m.length) {
        // "SL chạm trước" nếu SL và TP cùng chạm 1 nến — đúng quy ước dùng xuyên suốt backtest.ts.
        for (let j = i + 1; j <= i + R_LABEL_HORIZON_CANDLES; j++) {
          const c = candles5m[j];
          if (c.low <= slBullish) break; // SL hit (checked first — same convention as backtest.ts)
          if (c.high >= tpBullish) {
            bullishLabel = 1;
            break;
          }
        }
        bearishLabel = 0;
        for (let j = i + 1; j <= i + R_LABEL_HORIZON_CANDLES; j++) {
          const c = candles5m[j];
          if (c.high >= slBearish) break;
          if (c.low <= tpBearish) {
            bearishLabel = 1;
            break;
          }
        }
      } else {
        continue; // not enough future candles to label — skip
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
        lossStreakBullish: bullishStreak,
        lossStreakBearish: bearishStreak,
        label_bullish_momentum_r: bullishLabel,
        label_bearish_momentum_r: bearishLabel,
      });

      bullishStreak = bullishLabel === 1 ? 0 : bullishStreak + 1;
      bearishStreak = bearishLabel === 1 ? 0 : bearishStreak + 1;
    }

    allRows.push(...rows);
    console.log(`  → ${rows.length} nến có nhãn.`);
  }

  const header =
    'symbol,timestampUtc,adx1h,atrPercentile5m,bbWidthPercentile15m,volumeZScore5m,atrTrend5m,adxDirection1h,macroDirection,volAdjReturn5m,emaRatioFast,emaRatioSlow,correlatedRiskRatio,distanceToNearestSwingAtr,lossStreakBullish,lossStreakBearish,label_bullish_momentum_r,label_bearish_momentum_r';
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
      r.lossStreakBullish,
      r.lossStreakBearish,
      r.label_bullish_momentum_r,
      r.label_bearish_momentum_r,
    ].join(','),
  );
  const csv = [header, ...lines].join('\n') + '\n';

  const outDir = path.dirname(outPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, csv);

  const totalRows = allRows.length;
  const bullishCount = allRows.filter((r) => r.label_bullish_momentum_r === 1).length;
  const bearishCount = allRows.filter((r) => r.label_bearish_momentum_r === 1).length;

  console.log('');
  console.log(`Tổng số dòng: ${totalRows}`);
  console.log(`label_bullish_momentum_r=1: ${bullishCount} (${((bullishCount / totalRows) * 100).toFixed(1)}%)`);
  console.log(`label_bearish_momentum_r=1: ${bearishCount} (${((bearishCount / totalRows) * 100).toFixed(1)}%)`);
  console.log(`→ ${outPath}`);
}

main();
