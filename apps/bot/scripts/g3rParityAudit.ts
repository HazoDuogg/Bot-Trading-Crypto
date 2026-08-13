/**
 * TICKET-G3R — continuous-versus-restart parity harness + live-trade reproduction.
 *
 * Reuses the PRODUCTION reconstruction function (`reconstructRegimeStatesAcrossSymbols`, imported
 * from dist) for BOTH sides of every comparison, so the "continuous" reference chain and the
 * "cold-start reconstruction" go through literally the same code and the same detectRegime().
 *
 *   continuous chain = one full pass over all available steps, states recorded per step via onStep;
 *   restart chain    = candle arrays TRUNCATED at the checkpoint, default RECON_REPLAY_STEPS_5M span,
 *                      starting from a completely null regime state (a genuine cold process).
 *
 * Emits data/g3r-continuous-restart-parity.csv, data/g3r-reconstruction-input-integrity.csv and
 * data/g3r-live-trade-reproduction.md. Read-only against data/ohlcv/ — never fetches, never writes there.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  reconstructRegimeStatesAcrossSymbols,
  RECON_REPLAY_STEPS_5M,
  RECON_REQUIRED_5M,
  RECON_REQUIRED_15M,
  RECON_REQUIRED_1H,
  MS_5M,
  type SymbolCandleHistory,
  type SymbolReconstructionResult,
} from '../dist/live/regimeStateReconstruction.js';
import { RegimeConfig } from '../dist/regime/config.js';
import type { CandleData } from '../dist/regime/types.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const DATA_DIR = path.resolve(process.cwd(), 'data');

interface ChainState {
  previousRegime: string | null;
  previousCandidateRegime: string | null;
  streakCount: number;
  previousDangerZoneTimestamp: number | null;
}

function readCsv(file: string): CandleData[] {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => {
      const p = l.split(',');
      return { timestamp: Number(p[0]), open: Number(p[2]), high: Number(p[3]), low: Number(p[4]), close: Number(p[5]), volume: Number(p[6]) };
    });
}

function loadHistory(): Record<string, SymbolCandleHistory> {
  const out: Record<string, SymbolCandleHistory> = {};
  for (const s of SYMBOLS) {
    out[s] = {
      candles5m: readCsv(path.join(OHLCV_DIR, `${s}_5m.csv`)),
      candles15m: readCsv(path.join(OHLCV_DIR, `${s}_15m.csv`)),
      candles1h: readCsv(path.join(OHLCV_DIR, `${s}_1h.csv`)),
    };
  }
  return out;
}

/** Truncate every timeframe at (inclusive) the given decision instant — nothing closing after it survives, so a truncated run sees exactly what a process starting then would see. */
function truncateAt(history: Record<string, SymbolCandleHistory>, candle5mTimestamp: number): Record<string, SymbolCandleHistory> {
  const decisionTime = candle5mTimestamp + MS_5M;
  const out: Record<string, SymbolCandleHistory> = {};
  for (const s of SYMBOLS) {
    const h = history[s];
    out[s] = {
      candles5m: h.candles5m.filter((c) => c.timestamp + MS_5M <= decisionTime),
      candles15m: h.candles15m.filter((c) => c.timestamp + 15 * 60_000 <= decisionTime),
      candles1h: h.candles1h.filter((c) => c.timestamp + 60 * 60_000 <= decisionTime),
    };
  }
  return out;
}

function sameState(a: ChainState, b: ChainState): boolean {
  return (
    a.previousRegime === b.previousRegime &&
    a.previousCandidateRegime === b.previousCandidateRegime &&
    a.streakCount === b.streakCount &&
    a.previousDangerZoneTimestamp === b.previousDangerZoneTimestamp
  );
}

function cooldownRemainingMin(dangerTs: number | null, nowTs: number): number {
  if (dangerTs === null) return 0;
  const w = RegimeConfig.POST_DANGER_COOLDOWN_HOURS * 3600_000;
  const e = nowTs - dangerTs;
  return e >= w ? 0 : Math.round((w - e) / 60_000);
}

function main(): void {
  const history = loadHistory();
  mkdirSync(DATA_DIR, { recursive: true });

  // ---- input integrity CSV ---------------------------------------------------------------------
  const integrityRows: string[] = ['symbol,timeframe,availableClosedCandles,requiredCandles,firstTimestampUtc,lastTimestampUtc,contiguousTail,verdict'];
  for (const s of SYMBOLS) {
    const h = history[s];
    const specs: Array<[string, CandleData[], number, number]> = [
      ['5m', h.candles5m, RECON_REQUIRED_5M, MS_5M],
      ['15m', h.candles15m, RECON_REQUIRED_15M, 15 * 60_000],
      ['1h', h.candles1h, RECON_REQUIRED_1H, 60 * 60_000],
    ];
    for (const [tf, arr, required, ms] of specs) {
      let contiguous = arr.length >= required;
      for (let i = Math.max(1, arr.length - required + 1); i < arr.length; i++) {
        if (arr[i].timestamp - arr[i - 1].timestamp !== ms) contiguous = false;
      }
      integrityRows.push(
        [s, tf, arr.length, required, new Date(arr[0].timestamp).toISOString(), new Date(arr[arr.length - 1].timestamp).toISOString(), contiguous, arr.length >= required && contiguous ? 'COMPLETE' : 'INSUFFICIENT'].join(','),
      );
    }
  }
  writeFileSync(path.join(DATA_DIR, 'g3r-reconstruction-input-integrity.csv'), integrityRows.join('\n') + '\n');
  console.log('wrote g3r-reconstruction-input-integrity.csv');

  // ---- continuous reference chain ---------------------------------------------------------------
  // One pass over EVERY step the data supports, recorded per step through the production code path.
  const minLen5m = Math.min(...SYMBOLS.map((s) => history[s].candles5m.length));
  const maxSteps = minLen5m - (RECON_REQUIRED_5M - RECON_REPLAY_STEPS_5M);
  console.log(`continuous chain: ${maxSteps} steps x ${SYMBOLS.length} symbols`);
  const continuous: Record<string, Map<number, ChainState>> = {};
  for (const s of SYMBOLS) continuous[s] = new Map();
  const t0 = Date.now();
  const contResult = reconstructRegimeStatesAcrossSymbols({
    symbols: SYMBOLS,
    historyBySymbol: history,
    replaySteps: maxSteps,
    onStep: (symbol, ts, state) => {
      continuous[symbol].set(ts, { ...state });
    },
  });
  console.log(`continuous chain done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const s of SYMBOLS) {
    if (contResult[s].status !== 'OK') throw new Error(`continuous chain INVALID for ${s}: ${JSON.stringify(contResult[s])}`);
  }

  // ---- checkpoint selection ---------------------------------------------------------------------
  // Derived from the continuous chain itself; no hard-coded DANGER timestamp anywhere.
  const anchorSymbol = 'SOLUSDT';
  const anchorTimestamps = [...continuous[anchorSymbol].keys()].sort((a, b) => a - b);
  // Only checkpoints far enough in that a full RECON_REPLAY_STEPS_5M cold replay is possible.
  const earliestUsable = anchorTimestamps[0] + RECON_REPLAY_STEPS_5M * MS_5M;
  const usable = anchorTimestamps.filter((t) => t >= earliestUsable);

  interface Checkpoint { scenario: string; symbol: string; timestamp: number; note: string }
  const checkpoints: Checkpoint[] = [];

  for (const sym of SYMBOLS) {
    const ts = [...continuous[sym].keys()].sort((a, b) => a - b).filter((t) => t >= earliestUsable);
    const st = (t: number): ChainState => continuous[sym].get(t)!;

    // A. NOT_IN_COOLDOWN — no danger anchor at all, or an expired one.
    const notInCooldown = ts.find((t) => cooldownRemainingMin(st(t).previousDangerZoneTimestamp, t) === 0);
    if (notInCooldown !== undefined) checkpoints.push({ scenario: 'A_NOT_IN_COOLDOWN', symbol: sym, timestamp: notInCooldown, note: 'không nằm trong cooldown' });

    // B. IMMEDIATELY_AFTER_DANGER — first step whose regime just became DANGER_ZONE.
    let prev: ChainState | null = null;
    let justAfterDanger: number | undefined;
    let midCooldown: number | undefined;
    let nearEndCooldown: number | undefined;
    let inTransition: number | undefined;
    for (const t of ts) {
      const s = st(t);
      if (justAfterDanger === undefined && s.previousRegime === 'DANGER_ZONE' && (prev === null || prev.previousRegime !== 'DANGER_ZONE')) justAfterDanger = t;
      const rem = cooldownRemainingMin(s.previousDangerZoneTimestamp, t);
      // mid-cooldown: 30-42h remaining out of 72h
      if (midCooldown === undefined && rem > 30 * 60 && rem < 42 * 60) midCooldown = t;
      // near end: under 3h remaining but still > 0
      if (nearEndCooldown === undefined && rem > 0 && rem < 3 * 60) nearEndCooldown = t;
      // in a regime transition: candidate differs from confirmed regime and a streak is building
      if (inTransition === undefined && s.streakCount > 0 && s.previousCandidateRegime !== s.previousRegime) inTransition = t;
      prev = s;
    }
    if (justAfterDanger !== undefined) checkpoints.push({ scenario: 'B_IMMEDIATELY_AFTER_DANGER', symbol: sym, timestamp: justAfterDanger, note: 'ngay sau DANGER_ZONE' });
    if (midCooldown !== undefined) checkpoints.push({ scenario: 'C_MID_COOLDOWN', symbol: sym, timestamp: midCooldown, note: 'giữa cooldown' });
    if (nearEndCooldown !== undefined) checkpoints.push({ scenario: 'D_NEAR_END_COOLDOWN', symbol: sym, timestamp: nearEndCooldown, note: 'gần hết cooldown' });
    if (inTransition !== undefined) checkpoints.push({ scenario: 'E_REGIME_TRANSITION', symbol: sym, timestamp: inTransition, note: 'đang trong regime transition' });
  }
  void usable;

  // ---- restart runs ------------------------------------------------------------------------------
  // Group by timestamp: one cold reconstruction covers all 4 symbols at that instant, so every
  // symbol's parity is measured at every distinct checkpoint instant, not just the nominating one.
  const uniqueTimestamps = [...new Set(checkpoints.map((c) => c.timestamp))].sort((a, b) => a - b);
  const scenarioByTimestamp = new Map<number, string[]>();
  for (const c of checkpoints) {
    const list = scenarioByTimestamp.get(c.timestamp) ?? [];
    list.push(`${c.scenario}:${c.symbol}`);
    scenarioByTimestamp.set(c.timestamp, list);
  }
  console.log(`checkpoints: ${checkpoints.length} nominations across ${uniqueTimestamps.length} distinct instants`);

  const parityRows: string[] = [
    'scenarioNominations,checkpointUtc,symbol,contPreviousRegime,reconPreviousRegime,regimeMatch,contCandidateRegime,reconCandidateRegime,candidateMatch,contStreak,reconStreak,streakMatch,contLastDangerTs,reconLastDangerTs,lastDangerMatch,contCooldownRemainMin,reconCooldownRemainMin,cooldownMatch,fullStateMatch,replayedCandles,inputQuality',
  ];
  let totalCells = 0;
  let matchedCells = 0;
  /** Same 5 fields, but an EXPIRED danger anchor is canonicalised to null on both sides first — an expired anchor is provably unable to change any future detectRegime() decision. */
  let decisionEquivalentCells = 0;
  const failures: string[] = [];
  const canonicalDanger = (ts: number | null, at: number): number | null => (ts === null || at - ts >= RegimeConfig.POST_DANGER_COOLDOWN_HOURS * 3600_000 ? null : ts);

  for (const ts of uniqueTimestamps) {
    const truncated = truncateAt(history, ts);
    const cold = reconstructRegimeStatesAcrossSymbols({ symbols: SYMBOLS, historyBySymbol: truncated });
    const nominations = (scenarioByTimestamp.get(ts) ?? []).join('|');
    for (const sym of SYMBOLS) {
      const c = continuous[sym].get(ts);
      const r: SymbolReconstructionResult = cold[sym];
      if (c === undefined) continue;
      if (r.status !== 'OK') {
        failures.push(`${new Date(ts).toISOString()} ${sym}: reconstruction INVALID (${r.reason})`);
        parityRows.push([nominations, new Date(ts).toISOString(), sym, c.previousRegime, 'INVALID', 'NO', c.previousCandidateRegime, 'INVALID', 'NO', c.streakCount, 'INVALID', 'NO', c.previousDangerZoneTimestamp ?? 'null', 'INVALID', 'NO', cooldownRemainingMin(c.previousDangerZoneTimestamp, ts), 'INVALID', 'NO', 'NO', 0, r.reason].join(','));
        totalCells += 5;
        continue;
      }
      const rs = r.regimeState as ChainState;
      const regimeMatch = c.previousRegime === rs.previousRegime;
      const candMatch = c.previousCandidateRegime === rs.previousCandidateRegime;
      const streakMatch = c.streakCount === rs.streakCount;
      const dangerMatch = c.previousDangerZoneTimestamp === rs.previousDangerZoneTimestamp;
      const contCd = cooldownRemainingMin(c.previousDangerZoneTimestamp, ts);
      const reconCd = cooldownRemainingMin(rs.previousDangerZoneTimestamp, ts);
      const cdMatch = contCd === reconCd;
      const full = sameState(c, rs);
      totalCells += 5;
      matchedCells += [regimeMatch, candMatch, streakMatch, dangerMatch, cdMatch].filter(Boolean).length;
      decisionEquivalentCells += [regimeMatch, candMatch, streakMatch, canonicalDanger(c.previousDangerZoneTimestamp, ts) === canonicalDanger(rs.previousDangerZoneTimestamp, ts), cdMatch].filter(Boolean).length;
      if (!full) failures.push(`${new Date(ts).toISOString()} ${sym}: cont=${JSON.stringify(c)} recon=${JSON.stringify(rs)}`);
      parityRows.push(
        [
          nominations,
          new Date(ts).toISOString(),
          sym,
          c.previousRegime,
          rs.previousRegime,
          regimeMatch ? 'YES' : 'NO',
          c.previousCandidateRegime,
          rs.previousCandidateRegime,
          candMatch ? 'YES' : 'NO',
          c.streakCount,
          rs.streakCount,
          streakMatch ? 'YES' : 'NO',
          c.previousDangerZoneTimestamp ?? 'null',
          rs.previousDangerZoneTimestamp ?? 'null',
          dangerMatch ? 'YES' : 'NO',
          contCd,
          reconCd,
          cdMatch ? 'YES' : 'NO',
          full ? 'YES' : 'NO',
          r.telemetry.replayedCandles,
          r.telemetry.inputQuality,
        ].join(','),
      );
    }
  }
  // ---- decision sequence AFTER the restart -------------------------------------------------------
  // Each offset is an INDEPENDENT cold reconstruction (a fresh null-state process restarted k candles
  // later), compared against the continuously-running chain at the same candle. Stricter than seeding
  // once and stepping forward, and it uses the same production function throughout.
  const SEQUENCE_OFFSETS = [1, 2, 3, 6, 12];
  const seqRows: string[] = ['checkpointUtc,offsetCandles,candleUtc,symbol,contPreviousRegime,reconPreviousRegime,contCandidate,reconCandidate,contStreak,reconStreak,contLastDangerTs,reconLastDangerTs,fullStateMatch,decisionEquivalentMatch'];
  let seqTotal = 0;
  let seqMatched = 0;
  let seqDecisionEquivalent = 0;
  for (const ts of uniqueTimestamps) {
    for (const k of SEQUENCE_OFFSETS) {
      const at = ts + k * MS_5M;
      if (!continuous[SYMBOLS[0]].has(at)) continue;
      const cold = reconstructRegimeStatesAcrossSymbols({ symbols: SYMBOLS, historyBySymbol: truncateAt(history, at) });
      for (const sym of SYMBOLS) {
        const c = continuous[sym].get(at);
        const r = cold[sym];
        if (c === undefined || r.status !== 'OK') continue;
        const rs = r.regimeState as ChainState;
        const full = sameState(c, rs);
        const decisionEq = c.previousRegime === rs.previousRegime && c.previousCandidateRegime === rs.previousCandidateRegime && c.streakCount === rs.streakCount && canonicalDanger(c.previousDangerZoneTimestamp, at) === canonicalDanger(rs.previousDangerZoneTimestamp, at);
        seqTotal++;
        if (full) seqMatched++;
        if (decisionEq) seqDecisionEquivalent++;
        seqRows.push([new Date(ts).toISOString(), k, new Date(at).toISOString(), sym, c.previousRegime, rs.previousRegime, c.previousCandidateRegime, rs.previousCandidateRegime, c.streakCount, rs.streakCount, c.previousDangerZoneTimestamp ?? 'null', rs.previousDangerZoneTimestamp ?? 'null', full ? 'YES' : 'NO', decisionEq ? 'YES' : 'NO'].join(','));
      }
    }
    console.log(`  sequence done for ${new Date(ts).toISOString()}`);
  }
  writeFileSync(path.join(DATA_DIR, 'g3r-post-restart-decision-sequence.csv'), seqRows.join('\n') + '\n');

  writeFileSync(path.join(DATA_DIR, 'g3r-continuous-restart-parity.csv'), parityRows.join('\n') + '\n');
  console.log(`wrote g3r-continuous-restart-parity.csv — exact ${matchedCells}/${totalCells}, decision-equivalent ${decisionEquivalentCells}/${totalCells}, ${failures.length} row failures`);
  console.log(`post-restart decision sequence: exact ${seqMatched}/${seqTotal}, decision-equivalent ${seqDecisionEquivalent}/${seqTotal}`);
  for (const f of failures.slice(0, 20)) console.log(`  FAIL ${f}`);

  // ---- live-trade reproduction --------------------------------------------------------------------
  const LIVE_TRADES = [
    { utc: '2026-07-28T13:30:00Z', symbol: 'XRPUSDT', side: 'SHORT', reported: 'TREND_RIDER / OB' },
    { utc: '2026-07-28T14:15:00Z', symbol: 'SOLUSDT', side: 'SHORT', reported: 'TREND_RIDER / OB' },
    { utc: '2026-07-28T17:30:00Z', symbol: 'SOLUSDT', side: 'SHORT', reported: 'TREND_RIDER / OB' },
    { utc: '2026-07-29T03:00:00Z', symbol: 'SOLUSDT', side: 'SHORT', reported: 'TREND_RIDER / OB' },
  ];
  const liveRows: string[] = [];
  let liveAgree = 0;
  for (const t of LIVE_TRADES) {
    const ts = Date.parse(t.utc);
    const cont = continuous[t.symbol].get(ts);
    const truncated = truncateAt(history, ts);
    const cold = reconstructRegimeStatesAcrossSymbols({ symbols: SYMBOLS, historyBySymbol: truncated });
    const r = cold[t.symbol];
    const rs = r.status === 'OK' ? (r.regimeState as ChainState) : null;
    // The pre-fix cold start: INITIAL_SYMBOL_STATE — null everything. Its first-candle regime is what
    // detectRegime() produces with previousDangerZoneTimestamp=null, i.e. no cooldown suppression.
    const preFix = reconstructRegimeStatesAcrossSymbols({ symbols: SYMBOLS, historyBySymbol: truncated, replaySteps: 1 });
    const pf = preFix[t.symbol];
    const pfs = pf.status === 'OK' ? (pf.regimeState as ChainState) : null;
    const agree = cont !== undefined && rs !== null && cont.previousRegime === rs.previousRegime && cont.previousDangerZoneTimestamp === rs.previousDangerZoneTimestamp;
    if (agree) liveAgree++;
    liveRows.push(
      `| ${t.utc} | ${t.symbol} | ${t.side} | ${t.reported} | ${cont?.previousRegime ?? 'n/a'} | ${pfs?.previousRegime ?? 'n/a'} | ${rs?.previousRegime ?? 'INVALID'} | ${rs?.previousDangerZoneTimestamp !== null && rs?.previousDangerZoneTimestamp !== undefined ? new Date(rs.previousDangerZoneTimestamp).toISOString() : 'null'} | ${rs !== null ? cooldownRemainingMin(rs.previousDangerZoneTimestamp, ts) : 'n/a'} | ${agree ? '**YES**' : 'NO'} |`,
    );
    console.log(`live trade ${t.utc} ${t.symbol}: continuous=${cont?.previousRegime} preFixColdStart=${pfs?.previousRegime} reconstructed=${rs?.previousRegime} agree=${agree}`);
  }

  const md = [
    '# G3R — live-trade reproduction (4 real trades, 2026-07-28/29)',
    '',
    'Both columns are produced by the SAME production function',
    '(`reconstructRegimeStatesAcrossSymbols` -> `detectRegime`). "Continuous" replays every step the',
    'dataset supports; "Reconstructed cold start" truncates all timeframes at the trade instant and',
    'starts from a completely null regime state, i.e. a genuinely cold process.',
    '"Pre-fix cold start" is the old behaviour: `INITIAL_SYMBOL_STATE` + one candle, no replay at all.',
    '',
    '| decision time (UTC) | symbol | side | reported live | continuous regime | pre-fix cold start | reconstructed cold start | reconstructed lastDangerZoneTimestamp | cooldown remaining (min) | agree? |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...liveRows,
    '',
    `Agreement: **${liveAgree}/4**.`,
    '',
  ].join('\n');
  writeFileSync(path.join(DATA_DIR, 'g3r-live-trade-reproduction-raw.md'), md);
  console.log(`wrote g3r-live-trade-reproduction-raw.md — ${liveAgree}/4 agree`);

  writeFileSync(
    path.join(DATA_DIR, 'g3r-parity-summary.json'),
    JSON.stringify({ maxSteps, checkpointCount: checkpoints.length, distinctInstants: uniqueTimestamps.length, totalCells, matchedCells, decisionEquivalentCells, seqTotal, seqMatched, seqDecisionEquivalent, failureCount: failures.length, failures: failures.slice(0, 50), liveAgree }, null, 2),
  );
}

main();
