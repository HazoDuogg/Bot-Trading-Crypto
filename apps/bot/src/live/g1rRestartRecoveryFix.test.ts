import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIVE_STATE_SCHEMA_VERSION,
  writeLiveStateFileAtomic,
  readLiveStateFileSafe,
  decideSideRecovery,
  recoverSymbolState,
  performStartupRestartRecovery,
  computeQuantityTolerance,
  type LiveStateFile,
  type PersistedSymbolRecord,
} from './liveStateSync.js';
import { INITIAL_SYMBOL_STATE, type OpenPositionEntry, type SymbolState } from '../orchestrator/types.js';
import type { ManagedPositionState } from '../risk/slTpManager.js';

/**
 * TICKET-G1R Checkpoint C — regression tests proving G1-F14 no longer reproduces.
 *
 * Mapping (old repro -> what it proved was broken -> new test -> what now proves it's fixed):
 *  - g1FindingsRepro.test.ts "G1-F14 ... liveRunner.ts never persists runner state to disk ...
 *    runnerState is (re)initialized to INITIAL_SYMBOL_STATE on every process start ...
 *    POSITION_MISSING_INTERNALLY has no active handler" proved: (a) zero disk persistence of
 *    position/order-id state, (b) a restart always starts "as if nothing is open" regardless of
 *    real exchange/persisted state, (c) an exchange position the bot's internal state doesn't know
 *    about is never actively handled.
 *    -> every describe block below proves the fix: atomic+schemaVersioned persistence
 *    (writeLiveStateFileAtomic/readLiveStateFileSafe), an ownership-proof reconciliation
 *    (decideSideRecovery/recoverSymbolState/performStartupRestartRecovery) that combines the
 *    persisted file with a FRESH exchange read instead of assuming empty, and (for the runtime
 *    POSITION_MISSING_INTERNALLY case) a source-check mirroring g1FindingsRepro.test.ts's updated
 *    "confirms the source" convention (liveRunner.ts cannot be imported directly — same documented
 *    constraint every other G1R checkpoint's test file already carries).
 *
 * All persistence/reconciliation functions are pure or take an injected `Pick<BinanceOrderExecutor,
 * 'getPositionRisk'>` mock — real behavior tests against real temp-directory files, not source scans,
 * same testing style as liveStateSync.test.ts / stateReconciler.test.ts.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const liveRunnerSrc = fs.readFileSync(path.resolve(__dirname, '../../scripts/liveRunner.ts'), 'utf8');

// ---- fixture builders -----------------------------------------------------------------------

function makePosition(overrides: Partial<ManagedPositionState> = {}): ManagedPositionState {
  return {
    scenario: 'TREND',
    side: 'LONG',
    entryPrice: 100,
    initialSlPrice: 98,
    r: 2,
    tpPlan: 'PLAN_A',
    positionSize: 1000, // notional at open
    takerFeeRate: 0.0004,
    tpLevels: [
      { label: 'TP1', price: 102.4, rMultiple: 1.2, closePercent: 0.4 },
      { label: 'TP2', price: 105, rMultiple: 2.5, closePercent: 0.3 },
      { label: 'TP3_RUNNER', price: null, rMultiple: null, closePercent: 0.3 },
    ],
    currentSlPrice: 98,
    filledTiers: [],
    remainingPositionSize: 1000,
    runnerPeakPrice: null,
    closed: false,
    ...overrides,
  };
}

function makeEntry(entryTimestamp: number, positionOverrides: Partial<ManagedPositionState> = {}): OpenPositionEntry {
  return {
    position: makePosition(positionOverrides),
    meta: {
      regime: 'TREND_UP',
      setupType: 'OB',
      entryTimestamp,
      actualRiskDollar: 20,
      marginRequired: 33.33,
      riskMultiplier: 1,
    },
  } as OpenPositionEntry;
}

function makeSymbolState(openPositions: OpenPositionEntry[]): SymbolState {
  return { ...INITIAL_SYMBOL_STATE, openPositions };
}

function makePersistedFile(symbols: Record<string, PersistedSymbolRecord>): LiveStateFile {
  return { schemaVersion: LIVE_STATE_SCHEMA_VERSION, savedAtMs: 1_700_000_000_000, symbols };
}

function mockExecutor(positionRisk: Array<{ symbol: string; positionAmt: string }>) {
  return { getPositionRisk: async () => positionRisk };
}

function mockExecutorThatThrows(message: string) {
  return {
    getPositionRisk: async () => {
      throw new Error(message);
    },
  };
}

const TOLERANCE = computeQuantityTolerance(0.001); // stepSize=0.001 -> tolerance 0.0015, small realistic BTC-like step

// ---- persistence: atomic write + schema version + corrupt-file safety ------------------------

describe('G1-F14 fixed — atomic, schema-versioned persistence', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g1r-restart-'));
    filePath = path.join(tmpDir, 'positions-state.json');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writeLiveStateFileAtomic writes a schemaVersioned file readable back byte-for-byte via readLiveStateFileSafe', () => {
    const file = makePersistedFile({ BTCUSDT: { symbolState: makeSymbolState([makeEntry(1000)]), orderIds: [[1000, { slAlgoId: 111, tpAlgoIds: [222, 333] }]] } });
    writeLiveStateFileAtomic(filePath, file);
    expect(fs.existsSync(filePath)).toBe(true);
    const loaded = readLiveStateFileSafe(filePath);
    expect(loaded.status).toBe('OK');
    if (loaded.status !== 'OK') throw new Error('unreachable');
    expect(loaded.file.schemaVersion).toBe(LIVE_STATE_SCHEMA_VERSION);
    expect(loaded.file.symbols.BTCUSDT.orderIds).toEqual([[1000, { slAlgoId: 111, tpAlgoIds: [222, 333] }]]);
    expect(loaded.file.symbols.BTCUSDT.symbolState.openPositions).toHaveLength(1);
  });

  it('writeLiveStateFileAtomic never leaves a temp file behind (rename replaces the target in one operation)', () => {
    writeLiveStateFileAtomic(filePath, makePersistedFile({}));
    const leftoverTmp = fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp-'));
    expect(leftoverTmp).toEqual([]);
  });

  it('missing file -> NOT_FOUND, never throws (first-ever start)', () => {
    const result = readLiveStateFileSafe(path.join(tmpDir, 'does-not-exist.json'));
    expect(result.status).toBe('NOT_FOUND');
  });

  it('corrupt JSON (simulating a crash mid-write, before the atomic-rename fix existed, or manual edit) -> CORRUPT, never throws', () => {
    fs.writeFileSync(filePath, '{"schemaVersion": 1, "symbols": { "BTCUSDT": { incomplete', 'utf8');
    const result = readLiveStateFileSafe(filePath);
    expect(result.status).toBe('CORRUPT');
    if (result.status !== 'CORRUPT') throw new Error('unreachable');
    expect(result.error).toMatch(/JSON không hợp lệ/);
  });

  it('a schemaVersion this build does not recognize -> CORRUPT (never silently trusted/migrated)', () => {
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 999, savedAtMs: 1, symbols: {} }), 'utf8');
    const result = readLiveStateFileSafe(filePath);
    expect(result.status).toBe('CORRUPT');
  });
});

// ---- ownership-proof rule (decideSideRecovery) ------------------------------------------------

describe('G1-F14 fixed — ownership-proof rule (decideSideRecovery)', () => {
  it('no persisted, no exchange -> CLEAN', () => {
    const d = decideSideRecovery({ persistedEntries: [], exchangeBaseQty: 0, quantityTolerance: TOLERANCE });
    expect(d.status).toBe('CLEAN');
  });

  it('persisted matches exchange within tolerance -> RECOVERED', () => {
    const entries = [makeEntry(1000, { remainingPositionSize: 1000, entryPrice: 100 })]; // 10 base qty
    const d = decideSideRecovery({ persistedEntries: entries, exchangeBaseQty: 10, quantityTolerance: TOLERANCE });
    expect(d.status).toBe('RECOVERED');
    expect(d.correctedBaseQty).toBe(10);
  });

  it('persisted says open, exchange shows nothing -> STALE_LOCAL (closed while bot was offline)', () => {
    const entries = [makeEntry(1000)];
    const d = decideSideRecovery({ persistedEntries: entries, exchangeBaseQty: 0, quantityTolerance: TOLERANCE });
    expect(d.status).toBe('STALE_LOCAL');
  });

  it('exchange has a position, no persisted record at all -> QUARANTINED (never auto-adopted)', () => {
    const d = decideSideRecovery({ persistedEntries: [], exchangeBaseQty: 5, quantityTolerance: TOLERANCE });
    expect(d.status).toBe('QUARANTINED');
  });

  it('persisted and exchange both present but sizes wildly diverge -> QUARANTINED (never silently corrected)', () => {
    const entries = [makeEntry(1000, { remainingPositionSize: 1000, entryPrice: 100 })]; // 10 base qty
    const d = decideSideRecovery({ persistedEntries: entries, exchangeBaseQty: 2, quantityTolerance: TOLERANCE }); // exchange only shows 2 — way off
    expect(d.status).toBe('QUARANTINED');
  });
});

// ---- the 9 required restart scenarios, end-to-end through performStartupRestartRecovery -------

describe('G1-F14 fixed — restart recovery drill (9 required scenarios, fixture-driven end-to-end)', () => {
  const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
  const toleranceBySymbol = { BTCUSDT: TOLERANCE, ETHUSDT: TOLERANCE };

  it('1) clean restart — no positions anywhere (exchange empty, no persisted file)', async () => {
    const result = await performStartupRestartRecovery({
      executor: mockExecutor([]),
      symbols: SYMBOLS,
      persisted: { status: 'NOT_FOUND' },
      quantityToleranceBySymbol: toleranceBySymbol,
      initialSymbolState: INITIAL_SYMBOL_STATE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    for (const s of result.symbols) {
      expect(s.symbolState.openPositions).toEqual([]);
      expect(s.blockEntries).toBe(false);
      expect(s.sideOutcomes.every((o) => o.status === 'CLEAN')).toBe(true);
    }
  });

  it('2) restart with a matching bot-owned open position — fully recovered (side, qty, entry, SL/TP, remaining size, risk, margin)', async () => {
    const entry = makeEntry(2000, { side: 'LONG', entryPrice: 50000, remainingPositionSize: 5000, currentSlPrice: 49000 }); // 0.1 base qty
    const persisted: LiveStateFile = makePersistedFile({
      BTCUSDT: { symbolState: makeSymbolState([entry]), orderIds: [[2000, { slAlgoId: 555, tpAlgoIds: [666, 777] }]] },
    });
    const result = await performStartupRestartRecovery({
      executor: mockExecutor([{ symbol: 'BTCUSDT', positionAmt: '0.1' }]),
      symbols: SYMBOLS,
      persisted: { status: 'OK', file: persisted },
      quantityToleranceBySymbol: toleranceBySymbol,
      initialSymbolState: INITIAL_SYMBOL_STATE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const btc = result.symbols.find((s) => s.symbol === 'BTCUSDT')!;
    expect(btc.blockEntries).toBe(false);
    expect(btc.symbolState.openPositions).toHaveLength(1);
    const recovered = btc.symbolState.openPositions[0];
    expect(recovered.position.side).toBe('LONG');
    expect(recovered.position.entryPrice).toBe(50000);
    expect(recovered.position.currentSlPrice).toBe(49000);
    expect(recovered.position.remainingPositionSize).toBeCloseTo(5000, 6); // 0.1 * 50000, unchanged (already matched exactly)
    expect(recovered.meta.actualRiskDollar).toBe(20);
    expect(recovered.meta.marginRequired).toBe(33.33);
    expect(btc.orderIds.get(2000)).toEqual({ slAlgoId: 555, tpAlgoIds: [666, 777] });
    const eth = result.symbols.find((s) => s.symbol === 'ETHUSDT')!;
    expect(eth.symbolState.openPositions).toEqual([]);
  });

  it('3) restart after TP1 but before TP2 — recovered remaining quantity reflects the post-TP1 partial realization, not the original full size', async () => {
    // Original position was 1000 notional (10 base qty @ entry=100); TP1 closed 40% before the
    // restart, so the LAST persisted snapshot already has remainingPositionSize = 600 (6 base qty).
    const entry = makeEntry(3000, { entryPrice: 100, positionSize: 1000, remainingPositionSize: 600, filledTiers: ['TP1'] });
    const persisted = makePersistedFile({ BTCUSDT: { symbolState: makeSymbolState([entry]), orderIds: [[3000, { slAlgoId: 1, tpAlgoIds: [2] }]] } });
    const result = await performStartupRestartRecovery({
      executor: mockExecutor([{ symbol: 'BTCUSDT', positionAmt: '6' }]), // exchange confirms 6 base qty remaining, matching post-TP1
      symbols: SYMBOLS,
      persisted: { status: 'OK', file: persisted },
      quantityToleranceBySymbol: toleranceBySymbol,
      initialSymbolState: INITIAL_SYMBOL_STATE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const btc = result.symbols.find((s) => s.symbol === 'BTCUSDT')!;
    const recovered = btc.symbolState.openPositions[0];
    expect(recovered.position.filledTiers).toEqual(['TP1']);
    expect(recovered.position.remainingPositionSize).toBeCloseTo(600, 6); // NOT the original 1000
    expect(recovered.position.positionSize).toBe(1000); // original notional basis preserved for reference
  });

  it('4) restart when SL has already been ratcheted (trailing/breakeven) before the restart — recovered currentSlPrice is the ratcheted value, not the original', async () => {
    const entry = makeEntry(4000, { entryPrice: 100, initialSlPrice: 98, currentSlPrice: 100.5, remainingPositionSize: 600, filledTiers: ['TP1'] }); // breakeven+ ratchet already applied
    const persisted = makePersistedFile({ BTCUSDT: { symbolState: makeSymbolState([entry]), orderIds: [[4000, { slAlgoId: 9, tpAlgoIds: [] }]] } });
    const result = await performStartupRestartRecovery({
      executor: mockExecutor([{ symbol: 'BTCUSDT', positionAmt: '6' }]),
      symbols: SYMBOLS,
      persisted: { status: 'OK', file: persisted },
      quantityToleranceBySymbol: toleranceBySymbol,
      initialSymbolState: INITIAL_SYMBOL_STATE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const recovered = result.symbols.find((s) => s.symbol === 'BTCUSDT')!.symbolState.openPositions[0];
    expect(recovered.position.currentSlPrice).toBe(100.5); // ratcheted value, NOT the original initialSlPrice=98
    expect(recovered.position.initialSlPrice).toBe(98); // frozen original, unchanged
  });

  it('5) restart with a partial fill/open order still resting — persisted algoIds (SL/TP order bookkeeping) are carried forward for the recovered position', async () => {
    const entry = makeEntry(5000, { entryPrice: 100, remainingPositionSize: 1000 });
    const persisted = makePersistedFile({
      BTCUSDT: { symbolState: makeSymbolState([entry]), orderIds: [[5000, { slAlgoId: 42, tpAlgoIds: [43, 44] }]] },
    });
    const result = await performStartupRestartRecovery({
      executor: mockExecutor([{ symbol: 'BTCUSDT', positionAmt: '10' }]),
      symbols: SYMBOLS,
      persisted: { status: 'OK', file: persisted },
      quantityToleranceBySymbol: toleranceBySymbol,
      initialSymbolState: INITIAL_SYMBOL_STATE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const btc = result.symbols.find((s) => s.symbol === 'BTCUSDT')!;
    expect(btc.orderIds.get(5000)).toEqual({ slAlgoId: 42, tpAlgoIds: [43, 44] });
  });

  it('6) exchange/local mismatch — persisted says open, exchange shows closed -> position dropped (STALE_LOCAL), symbol stays tradeable', async () => {
    const entry = makeEntry(6000, { entryPrice: 100, remainingPositionSize: 1000 });
    const persisted = makePersistedFile({ BTCUSDT: { symbolState: makeSymbolState([entry]), orderIds: [[6000, { slAlgoId: 1, tpAlgoIds: [] }]] } });
    const result = await performStartupRestartRecovery({
      executor: mockExecutor([]), // exchange reports nothing for BTCUSDT at all
      symbols: SYMBOLS,
      persisted: { status: 'OK', file: persisted },
      quantityToleranceBySymbol: toleranceBySymbol,
      initialSymbolState: INITIAL_SYMBOL_STATE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const btc = result.symbols.find((s) => s.symbol === 'BTCUSDT')!;
    expect(btc.symbolState.openPositions).toEqual([]);
    expect(btc.blockEntries).toBe(false); // exchange is authoritative and clean — no uncertainty, safe to trade
    expect(btc.sideOutcomes.find((o) => o.side === 'LONG')?.status).toBe('STALE_LOCAL');
  });

  it('6b) exchange/local mismatch — persisted and exchange sizes differ well beyond tolerance -> QUARANTINED, entries blocked, position NOT auto-corrected or adopted', async () => {
    const entry = makeEntry(6100, { entryPrice: 100, remainingPositionSize: 1000 }); // persisted 10 base qty
    const persisted = makePersistedFile({ BTCUSDT: { symbolState: makeSymbolState([entry]), orderIds: [[6100, { slAlgoId: 1, tpAlgoIds: [] }]] } });
    const result = await performStartupRestartRecovery({
      executor: mockExecutor([{ symbol: 'BTCUSDT', positionAmt: '3' }]), // exchange says only 3 — way off
      symbols: SYMBOLS,
      persisted: { status: 'OK', file: persisted },
      quantityToleranceBySymbol: toleranceBySymbol,
      initialSymbolState: INITIAL_SYMBOL_STATE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const btc = result.symbols.find((s) => s.symbol === 'BTCUSDT')!;
    expect(btc.blockEntries).toBe(true);
    expect(btc.symbolState.openPositions).toEqual([]); // never adopted/managed while quarantined
  });

  it('7) unknown external/manual position — exchange has a position with NO matching persisted record and no provable ownership -> QUARANTINED/PENDING_RECONCILIATION, never adopted/closed/cancelled', async () => {
    const result = await performStartupRestartRecovery({
      executor: mockExecutor([{ symbol: 'ETHUSDT', positionAmt: '-4' }]), // a SHORT position nobody told us about
      symbols: SYMBOLS,
      persisted: { status: 'NOT_FOUND' }, // no persisted file at all — first-ever start, but exchange is NOT empty
      quantityToleranceBySymbol: toleranceBySymbol,
      initialSymbolState: INITIAL_SYMBOL_STATE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const eth = result.symbols.find((s) => s.symbol === 'ETHUSDT')!;
    expect(eth.blockEntries).toBe(true);
    expect(eth.symbolState.openPositions).toEqual([]); // not silently adopted into internal management
    expect(eth.sideOutcomes.find((o) => o.side === 'SHORT')?.status).toBe('QUARANTINED');
    const btc = result.symbols.find((s) => s.symbol === 'BTCUSDT')!;
    expect(btc.blockEntries).toBe(false); // unaffected symbol stays tradeable
  });

  it('8) repeated restart / idempotency — running the recovery logic twice in a row produces byte-identical results, and recovering from a crash-corrupted file is safe (no duplicate positions/orders)', async () => {
    const entry = makeEntry(8000, { entryPrice: 100, remainingPositionSize: 1000 });
    const persisted = makePersistedFile({ BTCUSDT: { symbolState: makeSymbolState([entry]), orderIds: [[8000, { slAlgoId: 1, tpAlgoIds: [2] }]] } });
    const params = {
      executor: mockExecutor([{ symbol: 'BTCUSDT', positionAmt: '10' }]),
      symbols: SYMBOLS,
      persisted: { status: 'OK' as const, file: persisted },
      quantityToleranceBySymbol: toleranceBySymbol,
      initialSymbolState: INITIAL_SYMBOL_STATE,
    };
    const run1 = await performStartupRestartRecovery(params);
    const run2 = await performStartupRestartRecovery(params);
    expect(run1.ok).toBe(true);
    expect(run2.ok).toBe(true);
    if (!run1.ok || !run2.ok) throw new Error('unreachable');
    // Same input -> same output (deterministic, no placement/cancellation side effects performed by
    // the recovery function itself — it only rebuilds in-memory bookkeeping), so calling it twice (or
    // after a crash right after the first call, before anything else ran) can never double-adopt or
    // double-count a position.
    expect(JSON.stringify(run1.symbols)).toBe(JSON.stringify(run2.symbols));
    const btcPositions = run1.symbols.find((s) => s.symbol === 'BTCUSDT')!.symbolState.openPositions;
    expect(btcPositions).toHaveLength(1); // not duplicated

    // Crash-mid-write variant: a corrupt persisted file must degrade to the SAME safe outcome as
    // NOT_FOUND for matching purposes (exchange position becomes QUARANTINED, not duplicated/guessed).
    const corruptResult = await performStartupRestartRecovery({ ...params, persisted: { status: 'CORRUPT', error: 'simulated crash mid-write' } });
    expect(corruptResult.ok).toBe(true);
    if (!corruptResult.ok) throw new Error('unreachable');
    const btcAfterCorrupt = corruptResult.symbols.find((s) => s.symbol === 'BTCUSDT')!;
    expect(btcAfterCorrupt.blockEntries).toBe(true); // exchange position now unproven -> quarantined, never guessed back in
    expect(btcAfterCorrupt.symbolState.openPositions).toEqual([]);
  });

  it('9) exchange API failure during startup reconciliation -> fails safe, ok:false, caller must not proceed to trade', async () => {
    const result = await performStartupRestartRecovery({
      executor: mockExecutorThatThrows('ECONNRESET / timeout simulated'),
      symbols: SYMBOLS,
      persisted: { status: 'NOT_FOUND' },
      quantityToleranceBySymbol: toleranceBySymbol,
      initialSymbolState: INITIAL_SYMBOL_STATE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toMatch(/ECONNRESET/);
  });

  it('9b) exchange returns a non-array (malformed response) -> also fails safe, ok:false', async () => {
    const result = await performStartupRestartRecovery({
      executor: { getPositionRisk: async () => ({ unexpected: 'shape' }) },
      symbols: SYMBOLS,
      persisted: { status: 'NOT_FOUND' },
      quantityToleranceBySymbol: toleranceBySymbol,
      initialSymbolState: INITIAL_SYMBOL_STATE,
    });
    expect(result.ok).toBe(false);
  });
});

// ---- multi-position-per-side known limitation, documented and tested (not silently unhandled) --

describe('G1-F14 fixed — known limitation: 2 concurrent same-side positions cannot be individually re-corrected from one merged exchange qty', () => {
  it('recoverSymbolState keeps both persisted entries as-is (uncorrected) when sidePersisted.length > 1, rather than guessing which one to adjust', () => {
    const e1 = makeEntry(1, { side: 'LONG', entryPrice: 100, remainingPositionSize: 500 });
    const e2 = makeEntry(2, { side: 'LONG', entryPrice: 100, remainingPositionSize: 500 });
    const outcome = recoverSymbolState({
      symbol: 'BTCUSDT',
      persisted: { symbolState: makeSymbolState([e1, e2]), orderIds: [] },
      exchangeBaseQtyBySide: { LONG: 10, SHORT: 0 }, // matches combined 10 base qty within tolerance
      quantityTolerance: TOLERANCE,
      initialSymbolState: INITIAL_SYMBOL_STATE,
    });
    expect(outcome.blockEntries).toBe(false);
    expect(outcome.symbolState.openPositions).toHaveLength(2);
    expect(outcome.symbolState.openPositions[0].position.remainingPositionSize).toBe(500);
    expect(outcome.symbolState.openPositions[1].position.remainingPositionSize).toBe(500);
  });
});

// ---- liveRunner.ts wiring (source-check only — cannot import the script directly, same documented
// constraint as every other G1R checkpoint's test file: main() runs unconditionally on import) -----

describe('G1-F14 fixed — liveRunner.ts wiring', () => {
  it('calls performStartupRestartRecovery before building runnerState, and aborts startup (throws) when it fails', () => {
    const recoveryIdx = liveRunnerSrc.indexOf('await performStartupRestartRecovery({');
    const runnerStateIdx = liveRunnerSrc.indexOf('const runnerState: Record<string, RunnerSymbolState> = {};');
    const abortIdx = liveRunnerSrc.indexOf('if (!restartRecovery.ok) {');
    expect(recoveryIdx).toBeGreaterThan(-1);
    expect(runnerStateIdx).toBeGreaterThan(-1);
    expect(abortIdx).toBeGreaterThan(-1);
    expect(recoveryIdx).toBeLessThan(abortIdx);
    expect(abortIdx).toBeLessThan(runnerStateIdx);
    expect(liveRunnerSrc).toContain("throw new Error(`liveRunner: đối soát khởi động (restart recovery) thất bại");
  });

  it('persists live state after every tick and immediately on startup (crash-resilience: a corrupt/stale file is overwritten by the just-recovered trusted state)', () => {
    expect(liveRunnerSrc).toContain('persistLiveState(); // immediately overwrite a missing/corrupt file');
    expect(liveRunnerSrc).toMatch(/persistLiveState\(\);\s*\n\s*\}\s*catch \(err\) \{\s*\n\s*tickErrorCount\+\+;/);
  });

  it('quarantined symbols (startup or runtime POSITION_MISSING_INTERNALLY) freeze the tick loop for that symbol, same pattern as the other permanent blocks', () => {
    const declIdx = liveRunnerSrc.indexOf('const entriesBlockedDueToRestartQuarantineBySymbol = new Set<string>();');
    const checkIdx = liveRunnerSrc.indexOf('entriesBlockedDueToRestartQuarantineBySymbol.has(symbol)');
    const startupAddIdx = liveRunnerSrc.indexOf('entriesBlockedDueToRestartQuarantineBySymbol.add(outcome.symbol);');
    const runtimeAddIdx = liveRunnerSrc.indexOf('entriesBlockedDueToRestartQuarantineBySymbol.add(symbol);');
    expect(declIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeGreaterThan(declIdx);
    expect(startupAddIdx).toBeGreaterThan(declIdx);
    expect(runtimeAddIdx).toBeGreaterThan(declIdx);
  });
});
