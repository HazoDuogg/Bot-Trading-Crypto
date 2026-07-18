/**
 * TICKET-006 — compute real threshold candidates from data/ohlcv/ CSVs, using the exact live
 * indicator/classification code (regime/indicators.ts + regimeDetector.ts), not a reimplementation.
 * Run from repo root: `npm run calibrate` (requires `npm run fetch-ohlcv` + `npm run build` first).
 *
 * Writes data/calibration-report.md. Does NOT modify config.ts — PM picks the final numbers.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CandleData } from '../dist/regime/types.js';
import { MarketRegime } from '../dist/regime/types.js';
import { RegimeConfig } from '../dist/regime/config.js';
import {
  bollingerBandwidthSeries,
  percentileRankSeries,
  trendDirectionSeries,
  wilderADXSeries,
  wilderATRSeries,
  zScoreSeries,
} from '../dist/regime/indicators.js';
import { applyHysteresis, classifyCandidate, type HysteresisState } from '../dist/regime/regimeDetector.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const REPORT_PATH = path.resolve(process.cwd(), 'data/calibration-report.md');

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

interface Stats {
  count: number;
  min: number;
  max: number;
  mean: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
}

function describeSeries(values: number[]): Stats | null {
  const valid = values.filter((v) => Number.isFinite(v));
  if (valid.length === 0) return null;
  const sorted = [...valid].sort((a, b) => a - b);
  const pct = (p: number): number => {
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  return { count: valid.length, min: sorted[0], max: sorted[sorted.length - 1], mean, p25: pct(25), p50: pct(50), p75: pct(75), p90: pct(90), p95: pct(95) };
}

function fmt(n: number): string {
  return n.toFixed(2);
}

function statsRow(label: string, s: Stats | null): string {
  if (!s) return `| ${label} | - | - | - | - | - | - | - | - | - |`;
  return `| ${label} | ${s.count} | ${fmt(s.min)} | ${fmt(s.max)} | ${fmt(s.mean)} | ${fmt(s.p25)} | ${fmt(s.p50)} | ${fmt(s.p75)} | ${fmt(s.p90)} | ${fmt(s.p95)} |`;
}

const ALL_REGIMES = Object.values(MarketRegime);

function stateCountsTable(candidateCounts: Map<string, number>, confirmedCounts: Map<string, number>, total: number): string {
  const lines = ['| State | % candidate (trước hysteresis) | % confirmed (sau hysteresis) |', '|---|---|---|'];
  for (const regime of ALL_REGIMES) {
    const c = candidateCounts.get(regime) ?? 0;
    const k = confirmedCounts.get(regime) ?? 0;
    const cPct = total > 0 ? ((c / total) * 100).toFixed(1) : '0.0';
    const kPct = total > 0 ? ((k / total) * 100).toFixed(1) : '0.0';
    lines.push(`| ${regime} | ${cPct}% (${c}) | ${kPct}% (${k}) |`);
  }
  return lines.join('\n');
}

function calibrateSymbol(symbol: string): string {
  const candles5m = readCsv(path.join(OHLCV_DIR, `${symbol}_5m.csv`));
  const candles15m = readCsv(path.join(OHLCV_DIR, `${symbol}_15m.csv`));
  const candles1h = readCsv(path.join(OHLCV_DIR, `${symbol}_1h.csv`));

  const adxSeries1h = wilderADXSeries(candles1h, RegimeConfig.ADX_PERIOD_1H);
  const atrSeries5m = wilderATRSeries(candles5m, RegimeConfig.ATR_PERIOD_5M);
  const atrPercentileSeries5m = percentileRankSeries(atrSeries5m, RegimeConfig.ATR_PCT_LOOKBACK_5M);
  const bbwSeries15m = bollingerBandwidthSeries(candles15m, RegimeConfig.BB_PERIOD_15M);
  const bbwPercentileSeries15m = percentileRankSeries(bbwSeries15m, RegimeConfig.BBW_PCT_LOOKBACK_15M);
  const atrTrendSeries5m = trendDirectionSeries(atrSeries5m, RegimeConfig.ATR_TREND_LOOKBACK_N);
  const volumeSeries5m = candles5m.map((c) => c.volume);
  const volumeZScoreSeries5m = zScoreSeries(volumeSeries5m, RegimeConfig.VOLUME_ZSCORE_LOOKBACK_5M);

  // Two-pointer alignment: for each 5m candle's close time, find the latest already-closed 1h/15m candle.
  let idx1h = -1;
  let idx15m = -1;
  let hysteresisState: HysteresisState | null = null;
  const candidateCounts = new Map<string, number>();
  const confirmedCounts = new Map<string, number>();
  let classifiedCount = 0;

  for (let i = 0; i < candles5m.length; i++) {
    const decisionTime = candles5m[i].timestamp + 5 * 60_000;
    while (idx1h + 1 < candles1h.length && candles1h[idx1h + 1].timestamp + 60 * 60_000 <= decisionTime) idx1h++;
    while (idx15m + 1 < candles15m.length && candles15m[idx15m + 1].timestamp + 15 * 60_000 <= decisionTime) idx15m++;

    const adx1h = idx1h >= 0 ? adxSeries1h[idx1h] : NaN;
    // TICKET-014 Phần A: classifyCandidate's TREND_RIDER branch now needs the trailing persistence
    // window too, not just the latest adx1h — same slice-and-filter as regimeDetector.ts's own
    // computeMetrics, kept in sync manually since this script precomputes series instead of calling it.
    const adx1hRecent =
      idx1h >= 0
        ? adxSeries1h.slice(Math.max(0, idx1h - RegimeConfig.TREND_ADX_PERSISTENCE_CANDLES + 1), idx1h + 1).filter((v) => !Number.isNaN(v))
        : [];
    const atrPercentile5m = atrPercentileSeries5m[i];
    const bbWidthPercentile15m = idx15m >= 0 ? bbwPercentileSeries15m[idx15m] : NaN;
    const atrTrend5m = atrTrendSeries5m[i];
    const volumeZScore5m = volumeZScoreSeries5m[i];

    if (Number.isNaN(adx1h) || Number.isNaN(atrPercentile5m) || Number.isNaN(bbWidthPercentile15m) || atrTrend5m === undefined || Number.isNaN(volumeZScore5m)) {
      continue;
    }

    const metrics = { adx1h, adx1hRecent, atrPercentile5m, bbWidthPercentile15m, atrTrend5m, volumeZScore5m };
    const candidateRegime = classifyCandidate(metrics, hysteresisState?.regime ?? null);
    hysteresisState = applyHysteresis(candidateRegime, hysteresisState);

    candidateCounts.set(candidateRegime, (candidateCounts.get(candidateRegime) ?? 0) + 1);
    confirmedCounts.set(hysteresisState.regime, (confirmedCounts.get(hysteresisState.regime) ?? 0) + 1);
    classifiedCount++;
  }

  const section = [
    `## ${symbol}`,
    '',
    `Nến: 5m=${candles5m.length}, 15m=${candles15m.length}, 1h=${candles1h.length}. Số điểm đủ dữ liệu để phân loại: ${classifiedCount}.`,
    '',
    '### Phân phối chỉ số',
    '',
    '| Metric | count | min | max | mean | p25 | p50 | p75 | p90 | p95 |',
    '|---|---|---|---|---|---|---|---|---|---|',
    statsRow('adx1h', describeSeries(adxSeries1h)),
    statsRow('atrPercentile5m', describeSeries(atrPercentileSeries5m)),
    statsRow('bbWidthPercentile15m', describeSeries(bbwPercentileSeries15m)),
    statsRow('volumeZScore5m', describeSeries(volumeZScoreSeries5m)),
    '',
    '### Tỷ lệ match theo state (ngưỡng HIỆN TẠI trong config.ts, chưa đổi)',
    '',
    stateCountsTable(candidateCounts, confirmedCounts, classifiedCount),
    '',
  ];
  return section.join('\n');
}

function main(): void {
  for (const symbol of SYMBOLS) {
    const missing = ['5m', '15m', '1h'].filter((tf) => !existsSync(path.join(OHLCV_DIR, `${symbol}_${tf}.csv`)));
    if (missing.length > 0) {
      throw new Error(`calibrateThresholds: thiếu file CSV cho ${symbol} (${missing.join(', ')}) — chạy npm run fetch-ohlcv trước.`);
    }
  }

  const sections = SYMBOLS.map((s) => {
    console.log(`Calibrating ${s}...`);
    return calibrateSymbol(s);
  });

  const report = [
    '# Calibration Report — TICKET-006',
    '',
    `Sinh tự động từ \`npm run calibrate\` — dữ liệu thật ${new Date().toISOString()}. Không tự sửa \`config.ts\`; PM chốt số sau khi đọc report này.`,
    '',
    ...sections,
  ].join('\n');

  writeFileSync(REPORT_PATH, report);
  console.log(`→ ${REPORT_PATH}`);
}

main();
