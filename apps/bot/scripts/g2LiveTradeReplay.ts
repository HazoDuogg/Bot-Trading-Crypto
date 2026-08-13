/**
 * TICKET-G2 §5 — replays the regime state the bot ACTUALLY saw at each TREND_RIDER/OB and
 * SIDEWAY_SCALPER/BOX_BREAKOUT trade's own decision timestamp, using only data closed at or before
 * that timestamp. Emits data/g2-live-trade-replay-detail.csv consumed by data/g2-live-trade-replay.md.
 *
 * Source population: data/backtest-trades-baseline-planauto-maxpos2-momentumdirect-correlated.csv
 * (the registered PROD_8FLAG_POST_T152 baseline run). These are BACKTEST-attributed trades used as a
 * proxy — this repo contains no real live execution history (see the report).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { detectRegime } from '../dist/regime/regimeDetector.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { MarketRegime, type CandleData } from '../dist/regime/types.js';
import { classifyHtfContextCandidate } from '../dist/regime/htfContext.js';
import { classifySafetyState5mCandidate } from '../dist/regime/safetyState5m.js';
import { emaSeries } from '../dist/regime/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const TRADES_CSV = path.resolve(process.cwd(), 'data/backtest-trades-baseline-planauto-maxpos2-momentumdirect-correlated.csv');
const WINDOW_5M = 320, WINDOW_15M = 325, WINDOW_1H = 40, WINDOW_5M_SESSION_VOLUME = 14 * 288 + 1, SKIP_DAYS = 20;
const TARGETS = new Set(['TREND_RIDER/OB', 'SIDEWAY_SCALPER/BOX_BREAKOUT']);

function readCsv(file: string): CandleData[] {
  return readFileSync(file, 'utf8').trim().split('\n').slice(1).map((l) => {
    const p = l.split(',');
    return { timestamp: Number(p[0]), open: Number(p[2]), high: Number(p[3]), low: Number(p[4]), close: Number(p[5]), volume: Number(p[6]) };
  });
}
function closedWindow(c: CandleData[], ptr: number, ms: number, dt: number, size: number): { window: CandleData[]; ptr: number } {
  let p = ptr;
  while (p + 1 < c.length && c[p + 1].timestamp + ms <= dt) p++;
  if (p < 0) return { window: [], ptr: p };
  return { window: c.slice(Math.max(0, p - size + 1), p + 1), ptr: p };
}

interface Trade { symbol: string; side: 'LONG' | 'SHORT'; regime: string; setupType: string; entryTs: number; entryPrice: number; exitTs: number; exitPrice: number; exitReason: string; pnlUsd: number; }

function main(): void {
  const rows = readFileSync(TRADES_CSV, 'utf8').trim().split('\n').slice(1);
  const trades: Trade[] = rows.map((l) => {
    const p = l.split(',');
    return { symbol: p[0], side: p[1] as 'LONG' | 'SHORT', regime: p[2], setupType: p[3], entryTs: Number(p[5]), entryPrice: Number(p[6]), exitTs: Number(p[7]), exitPrice: Number(p[8]), exitReason: p[9], pnlUsd: Number(p[10]) };
  }).filter((t) => TARGETS.has(`${t.regime}/${t.setupType}`));
  console.log(`target trades: ${trades.length}`);

  const sd: Record<string, { c5: CandleData[]; c15: CandleData[]; c1h: CandleData[]; p15: number; p1h: number }> = {};
  for (const s of SYMBOLS) sd[s] = { c5: readCsv(path.join(OHLCV_DIR, `${s}_5m.csv`)), c15: readCsv(path.join(OHLCV_DIR, `${s}_15m.csv`)), c1h: readCsv(path.join(OHLCV_DIR, `${s}_1h.csv`)), p15: -1, p1h: -1 };

  const byTs: Record<string, Trade[]> = {};
  for (const t of trades) (byTs[`${t.symbol}@${t.entryTs}`] ??= []).push(t);

  type Chain = { previousRegime: MarketRegime | null; previousCandidateRegime: MarketRegime | null; streakCount: number; previousDangerZoneTimestamp: number | null };
  const chain: Record<string, Chain> = {};
  const lastRegime: Record<string, MarketRegime | null> = {};
  const lastChangeTs: Record<string, number> = {};
  const recentChanges: Record<string, number[]> = {};
  for (const s of SYMBOLS) { chain[s] = { previousRegime: null, previousCandidateRegime: null, streakCount: 0, previousDangerZoneTimestamp: null }; lastRegime[s] = null; lastChangeTs[s] = 0; recentChanges[s] = []; }

  const total = Math.min(...SYMBOLS.map((s) => sd[s].c5.length));
  const start = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5 + SKIP_DAYS * 288;
  const out: unknown[][] = [];

  for (let step = start; step < total; step++) {
    const w1hBySymbol: Record<string, CandleData[]> = {};
    for (const s of SYMBOLS) {
      const dt = sd[s].c5[step].timestamp + 5 * 60_000;
      const w = closedWindow(sd[s].c1h, sd[s].p1h, 60 * 60_000, dt, WINDOW_1H);
      sd[s].p1h = w.ptr; w1hBySymbol[s] = w.window;
    }
    const corr = computeCorrelatedRiskRatio(w1hBySymbol, RegimeConfig.CORRELATED_RISK_WINDOW_CANDLES, 'BTCUSDT');
    const correlatedRiskRatio = corr[corr.length - 1];

    for (const s of SYMBOLS) {
      const cur = sd[s].c5[step];
      const dt = cur.timestamp + 5 * 60_000;
      const w5 = sd[s].c5.slice(Math.max(0, step - WINDOW_5M + 1), step + 1);
      const wSess = sd[s].c5.slice(Math.max(0, step - WINDOW_5M_SESSION_VOLUME + 1), step + 1);
      const w15 = closedWindow(sd[s].c15, sd[s].p15, 15 * 60_000, dt, WINDOW_15M); sd[s].p15 = w15.ptr;
      const r = detectRegime({ candles5m: w5, candles15m: w15.window, candles1h: w1hBySymbol[s], candles5mSessionVolume: wSess, correlatedRiskRatio, ...chain[s] });
      chain[s] = { previousRegime: r.regime, previousCandidateRegime: r.candidateRegime, streakCount: r.streakCount, previousDangerZoneTimestamp: r.lastDangerZoneTimestamp };
      if (lastRegime[s] !== null && lastRegime[s] !== r.regime) { lastChangeTs[s] = cur.timestamp; recentChanges[s].push(cur.timestamp); }
      if (lastRegime[s] === null) lastChangeTs[s] = cur.timestamp;
      lastRegime[s] = r.regime;

      const hits = byTs[`${s}@${cur.timestamp}`];
      if (!hits) continue;
      const m = r.computedMetrics;
      const adx = m.adx1h as number, atrP = m.atrPercentile5m as number, bbw = m.bbWidthPercentile15m as number;
      const htf = classifyHtfContextCandidate(m);
      const safety = classifySafetyState5mCandidate(m);
      const ema20 = emaSeries(w5, 20);
      const dir5m = ema20[ema20.length - 1] === undefined || Number.isNaN(ema20[ema20.length - 1]) ? 'UNKNOWN' : cur.close > ema20[ema20.length - 1] ? 'UP' : cur.close < ema20[ema20.length - 1] ? 'DOWN' : 'FLAT';
      const candlesSinceChange = Math.round((cur.timestamp - lastChangeTs[s]) / 300_000);
      const changes60m = recentChanges[s].filter((t) => cur.timestamp - t < 60 * 60_000).length;
      const nearBoundary = Math.min(Math.abs(adx - RegimeConfig.TREND_ENTER_ADX.enter), Math.abs(adx - RegimeConfig.SIDEWAY_ADX_THRESHOLD.enter)) <= 1.0
        || Math.abs(atrP - RegimeConfig.TREND_ENTER_ATR_PCT.enter) <= 2.0 || Math.abs(bbw - RegimeConfig.COMPRESSION_BBW_PCT_THRESHOLD.enter) <= 2.0;

      for (const t of hits) {
        if (t.regime !== r.regime) {
          // decision-time regime replay disagrees with the logged trade regime — report, never silently reconcile
          out.push([t.symbol, new Date(t.entryTs).toISOString(), t.regime, t.setupType, t.side, t.pnlUsd.toFixed(2), t.exitReason,
            r.regime, r.candidateRegime, r.streakCount, candlesSinceChange, changes60m, adx?.toFixed(2), atrP?.toFixed(2), bbw?.toFixed(2),
            r.adxDirection1h ?? '', htf, safety, dir5m, 'MISMATCH', '', '', '', 'REPLAY_REGIME_MISMATCH']);
          continue;
        }
        // forward MFE/MAE in R, from real 5m candles after the entry candle, up to the logged exit
        const risk = Math.abs(t.entryPrice - t.exitPrice) > 0 ? undefined : undefined;
        let mfeR = 0, maeR = 0;
        // R is unknown from the trade CSV (no SL column) — use ATR-normalized excursion instead.
        const atrProxy = (() => { const hi = Math.max(...w5.slice(-14).map((c) => c.high)), lo = Math.min(...w5.slice(-14).map((c) => c.low)); return hi - lo; })() / 14 || 1;
        for (let k = step + 1; k < total && sd[s].c5[k].timestamp <= t.exitTs; k++) {
          const f = sd[s].c5[k];
          const fav = t.side === 'LONG' ? f.high - t.entryPrice : t.entryPrice - f.low;
          const adv = t.side === 'LONG' ? t.entryPrice - f.low : f.high - t.entryPrice;
          mfeR = Math.max(mfeR, fav / atrProxy); maeR = Math.max(maeR, adv / atrProxy);
        }
        const htfAgrees = (t.side === 'LONG' && (htf === 'TREND_UP' || htf === 'RANGE')) || (t.side === 'SHORT' && (htf === 'TREND_DOWN' || htf === 'RANGE'));
        const dir5mAgrees = (t.side === 'LONG' && dir5m === 'UP') || (t.side === 'SHORT' && dir5m === 'DOWN');
        let attribution: string;
        if (t.pnlUsd >= 0) attribution = 'WIN';
        else if (mfeR >= 1.5) attribution = 'MANAGEMENT';
        else if (candlesSinceChange <= RegimeConfig.N_CANDLE_CONFIRM * 2 || nearBoundary || !htfAgrees) attribution = 'REGIME';
        else if (!dir5mAgrees || maeR >= 1.0) attribution = 'SETUP';
        else attribution = 'INSUFFICIENT_EVIDENCE';
        out.push([t.symbol, new Date(t.entryTs).toISOString(), t.regime, t.setupType, t.side, t.pnlUsd.toFixed(2), t.exitReason,
          r.regime, r.candidateRegime, r.streakCount, candlesSinceChange, changes60m, adx?.toFixed(2), atrP?.toFixed(2), bbw?.toFixed(2),
          r.adxDirection1h ?? '', htf, safety, dir5m, nearBoundary ? 'YES' : 'NO', htfAgrees ? 'YES' : 'NO', mfeR.toFixed(2), maeR.toFixed(2), attribution]);
      }
    }
  }

  const header = ['symbol', 'entryTimestamp', 'loggedRegime', 'setupType', 'side', 'pnlUsd', 'exitReason', 'replayRegime', 'replayCandidateRegime', 'streakCount', 'candlesSinceRegimeChange', 'regimeChanges60m', 'adx1h', 'atrPercentile5m', 'bbWidthPercentile15m', 'adxDirection1h', 'htfContext', 'safetyState5mCandidate', 'direction5mVsEma20', 'nearThresholdBoundary', 'htfAgreesWithSide', 'mfeAtr', 'maeAtr', 'attribution'];
  const esc = (v: unknown): string => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  writeFileSync(path.resolve(process.cwd(), 'data/g2-live-trade-replay-detail.csv'), [header.join(','), ...out.map((r) => r.map(esc).join(','))].join('\n') + '\n');
  console.log(`wrote data/g2-live-trade-replay-detail.csv (${out.length} rows)`);
  const counts: Record<string, number> = {};
  for (const r of out) counts[String(r[23])] = (counts[String(r[23])] ?? 0) + 1;
  console.log(JSON.stringify(counts));
  const bySetup: Record<string, Record<string, number>> = {};
  for (const r of out) { const k = `${r[2]}/${r[3]}`; (bySetup[k] ??= {})[String(r[23])] = ((bySetup[k] ??= {})[String(r[23])] ?? 0) + 1; }
  console.log(JSON.stringify(bySetup, null, 1));
}

main();
