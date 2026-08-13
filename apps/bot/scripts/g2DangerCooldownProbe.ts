/**
 * TICKET-G2 §2/§4 probe — measures how much of the timeline sits inside regimeDetector.ts's
 * POST_DANGER_COOLDOWN_HOURS window and how many TREND_RIDER/SIDEWAY_SCALPER/COMPRESSION candidates
 * it forces down to NEUTRAL_TRANSITION. Read-only replay; changes nothing.
 * Appends its result rows to data/g2-indicator-calculation-audit.csv is NOT done here — output is
 * printed and consumed by data/g2-findings-and-remediation.md.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { classifyCandidate } from '../dist/regime/regimeDetector.js';
import { detectRegime } from '../dist/regime/regimeDetector.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { MarketRegime, type CandleData } from '../dist/regime/types.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const DIR = path.resolve(process.cwd(), 'data/ohlcv');
const WINDOW_5M = 320, WINDOW_15M = 325, WINDOW_1H = 40, WINDOW_SESS = 14 * 288 + 1, SKIP_DAYS = 20;

function readCsv(f: string): CandleData[] {
  return readFileSync(f, 'utf8').trim().split('\n').slice(1).map((l) => { const p = l.split(','); return { timestamp: +p[0], open: +p[2], high: +p[3], low: +p[4], close: +p[5], volume: +p[6] }; });
}
function cw(c: CandleData[], ptr: number, ms: number, dt: number, size: number): { window: CandleData[]; ptr: number } {
  let p = ptr; while (p + 1 < c.length && c[p + 1].timestamp + ms <= dt) p++;
  return { window: p < 0 ? [] : c.slice(Math.max(0, p - size + 1), p + 1), ptr: p };
}

const SUPPRESSED = new Set<MarketRegime>([MarketRegime.TREND_RIDER, MarketRegime.SIDEWAY_SCALPER, MarketRegime.COMPRESSION]);

function main(): void {
  const sd: Record<string, { c5: CandleData[]; c15: CandleData[]; c1h: CandleData[]; p15: number; p1h: number }> = {};
  for (const s of SYMBOLS) sd[s] = { c5: readCsv(path.join(DIR, `${s}_5m.csv`)), c15: readCsv(path.join(DIR, `${s}_15m.csv`)), c1h: readCsv(path.join(DIR, `${s}_1h.csv`)), p15: -1, p1h: -1 };
  const total = Math.min(...SYMBOLS.map((s) => sd[s].c5.length));
  const start = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5 + SKIP_DAYS * 288;

  type Chain = { previousRegime: MarketRegime | null; previousCandidateRegime: MarketRegime | null; streakCount: number; previousDangerZoneTimestamp: number | null };
  const chain: Record<string, Chain> = {};
  const stat: Record<string, { n: number; inCooldown: number; suppressed: number; sup: Record<string, number>; rawCand: Record<string, number> }> = {};
  for (const s of SYMBOLS) { chain[s] = { previousRegime: null, previousCandidateRegime: null, streakCount: 0, previousDangerZoneTimestamp: null }; stat[s] = { n: 0, inCooldown: 0, suppressed: 0, sup: {}, rawCand: {} }; }

  for (let step = start; step < total; step++) {
    const w1h: Record<string, CandleData[]> = {};
    for (const s of SYMBOLS) { const dt = sd[s].c5[step].timestamp + 300_000; const w = cw(sd[s].c1h, sd[s].p1h, 3_600_000, dt, WINDOW_1H); sd[s].p1h = w.ptr; w1h[s] = w.window; }
    const corr = computeCorrelatedRiskRatio(w1h, RegimeConfig.CORRELATED_RISK_WINDOW_CANDLES, 'BTCUSDT');
    const correlatedRiskRatio = corr[corr.length - 1];
    for (const s of SYMBOLS) {
      const cur = sd[s].c5[step], dt = cur.timestamp + 300_000;
      const w5 = sd[s].c5.slice(Math.max(0, step - WINDOW_5M + 1), step + 1);
      const wS = sd[s].c5.slice(Math.max(0, step - WINDOW_SESS + 1), step + 1);
      const w15 = cw(sd[s].c15, sd[s].p15, 900_000, dt, WINDOW_15M); sd[s].p15 = w15.ptr;
      const prevDanger = chain[s].previousDangerZoneTimestamp;
      const r = detectRegime({ candles5m: w5, candles15m: w15.window, candles1h: w1h[s], candles5mSessionVolume: wS, correlatedRiskRatio, ...chain[s] });
      // raw (pre-cooldown) candidate, recomputed with the exact same metrics detectRegime just used
      const raw = classifyCandidate(r.computedMetrics, chain[s].previousRegime);
      const inCooldown = prevDanger !== null && cur.timestamp - prevDanger < RegimeConfig.POST_DANGER_COOLDOWN_HOURS * 3_600_000;
      const st = stat[s];
      st.n++;
      if (inCooldown) st.inCooldown++;
      st.rawCand[raw] = (st.rawCand[raw] ?? 0) + 1;
      if (inCooldown && SUPPRESSED.has(raw)) { st.suppressed++; st.sup[raw] = (st.sup[raw] ?? 0) + 1; }
      chain[s] = { previousRegime: r.regime, previousCandidateRegime: r.candidateRegime, streakCount: r.streakCount, previousDangerZoneTimestamp: r.lastDangerZoneTimestamp };
    }
  }
  for (const s of SYMBOLS) {
    const st = stat[s];
    console.log(`${s}: steps=${st.n} inPostDangerCooldown=${st.inCooldown} (${((st.inCooldown / st.n) * 100).toFixed(2)}%) suppressedCandidates=${st.suppressed} (${((st.suppressed / st.n) * 100).toFixed(2)}%) breakdown=${JSON.stringify(st.sup)}`);
    console.log(`  rawCandidateDist=${JSON.stringify(st.rawCand)}`);
  }
}
main();
