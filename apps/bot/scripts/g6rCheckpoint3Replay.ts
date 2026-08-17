/**
 * G6R Checkpoint 3 — freeze the G6-C1 shadow candidate population (CORRECTED runner — supersedes
 * the first attempt archived at data/g6r-runs/g6r-cp3-attempt1-invalid-summary.json).
 *
 * Defects fixed vs attempt 1 (see TICKET-G6R-Correct-Shadow-Screening-and-Funnel-Protocol.md):
 *  1. This runner now PROGRAMMATICALLY verifies every locked input (branch, HEAD, merge-base, git
 *     status allowlist, all 6 CP2/registration file hashes, pre-edit manifest hash) before spawning
 *     the replay — attempt 1's runner claimed "ALL MATCH" while only actually checking one file.
 *  2. Macro-trend filter is now applied in the correct order (select primary -> macro filter ->
 *     stop if blocked -> only then attempt primary MSS -> only then fallback).
 *  3. decisionTimestamp is now mssWindow[mssConfirmedIndex].timestamp, not evaluationTimestamp.
 *  4. Two separate leakage audits: (A) evaluation-input closure (candle arrays closed at the
 *     evaluation's own boundary) and (B) per-candidate decision-feature audit (no decision feature
 *     — MSS confirmation candle — read past the candidate's own decisionTimestamp).
 *  5. registrationDocumentSha256 (whole-file gate) is separate from registeredRuleSliceSha256
 *     (heading-located identification hash, not hardcoded line numbers).
 *  7. CP2 evaluations CSV is parsed with a real RFC4180-ish parser (g6rCsvParser.ts), not naive split.
 *  8. Final candidate rows pass the full schema validator (validateShadowCandidateRows).
 *
 * TICKET-G6R-CP3F (reporting-defect closure, no replay run by this change):
 *  - Fix 1: error categorization is now a pure, independently-unit-tested function
 *    (g6rErrorTaxonomy.ts) that routes geometry messages to their own category instead of
 *    the default requiredField bucket, so the same 31 geometry-invalid rows are never
 *    double-counted under both requiredFieldErrors and geometryErrors.
 *  - Fix 2: the execution-outcome artifact is now built by a pure, independently-unit-tested
 *    function (g6rExecutionOutcome.ts) that never emits a field named `exitCode` and derives
 *    `expectedProcessExitCode` FROM `validationStatus`, so the two fields can never contradict
 *    each other. The execution artifact is now written once the final validationStatus is
 *    known (not unconditionally right after runReplay() returns), for every exit path.
 *
 * Runs the SAME baseline replay as Checkpoint 2 (byte-identical config/hooks wiring pattern —
 * buildBaselineConfig()/makeFillModel()/runReplay() from ticket150BacktestExecutionRealismAudit.ts)
 * with a G6ShadowOpportunityAnalyzer attached via the observe-only `onBeforeProcessCandle` hook.
 * Production route/admission behavior is completely untouched: the analyzer only READS
 * `ctx.input`/`ctx.config` and returns a pure observation; it never calls back into anything that
 * can alter a decision. onAfterProcessCandle/onFunnelEvent/blockEntry are NOT used at all here.
 *
 * Output: data/g6r-runs/g6r-cp3-shadow-candidates.csv (ONLY if PASS), data/g6r-runs/g6r-cp3-shadow-summary.json.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildBaselineConfig, makeFillModel, runReplay, type ReplayVariantHooks } from './ticket150BacktestExecutionRealismAudit.js';
import { MarketRegime, type CandleData } from '../dist/regime/types.js';
import { evaluationId } from './g6rFullPathFunnel.js';
import { wilderDIDirectionSeries } from '../dist/regime/indicators.js';
import { EntryConfig as EntryConfigForMacro } from '../dist/entry/config.js';
import { parseLedgerCsvRequiringEvaluationId, parseCsv } from './g6rCsvParser.js';
import {
  createG6ShadowOpportunityAnalyzer,
  validateShadowLedger,
  validateShadowCandidateRows,
  auditDecisionFeatureProvenance,
  FutureCandleViolationError,
  FIVE_MINUTES_MS,
  type FrozenShadowEvent,
  type G6ShadowObservation,
  type ShadowCandidateRow,
} from './g6rShadowAnalyzer.js';
import { categorizeSchemaErrors } from './g6rErrorTaxonomy.js';
import { buildExecutionOutcomeArtifact, type ValidationStatus } from './g6rExecutionOutcome.js';

const STOP_STEP = 57833;
const OUT_DIR = path.resolve(process.cwd(), 'data/g6r-runs');
const REPO_ROOT = process.cwd();

const EXPECTED_HEAD = '8f9a4853686ab82684a493607648b2606708983d';
const EXPECTED_BRANCH = 'cai-tien';
const EXPECTED_MERGE_BASE = '2cd3fafea373f790013ffdeb280251f87c210d53';
const ALLOWED_UNTRACKED = new Set([
  'apps/bot/scripts/g6rShadowAnalyzer.ts',
  'apps/bot/scripts/g6rShadowAnalyzer.test.ts',
  'apps/bot/scripts/g6rCheckpoint3Replay.ts',
  'apps/bot/scripts/g6rCsvParser.ts',
  'apps/bot/scripts/g6rCsvParser.test.ts',
  'apps/bot/scripts/g6rErrorTaxonomy.ts',
  'apps/bot/scripts/g6rErrorTaxonomy.test.ts',
  'apps/bot/scripts/g6rExecutionOutcome.ts',
  'apps/bot/scripts/g6rExecutionOutcome.test.ts',
]);

const LOCKED_INPUT_HASHES: Record<string, string> = {
  'data/g6r-runs/g6r-cp2-evaluations.csv': '1bafe30a64e881afa97ebcf59aa150c1f39b5a1aecf57a1a3cccd114d862069e',
  'data/g6r-runs/g6r-cp2-candidates.csv': '849ec8961b251bbee7a3190014cf4b5ebc9bce663c8c33b589e517585a2f9298',
  'data/g6r-runs/g6r-cp2-events.csv': '7f81d065a6ae9d0be384fb56c676cbd1382c2d533131bf97fea19ad4eaab94d7',
  'data/g6r-runs/g6r-cp2-summary.json': '655817b1d1e09ae0fc24c9d6fb22fde79da2290bca8aeedcaec81de3555d743c',
  'data/g6-root-cause-and-candidate-registration.md': '9ca5941d8f57d8c7a403cecbcda7e19328cf4547b6d0beac87b838bfeb056114',
};
// This is the sha256 of data/g6r-run-manifest.json as it exists on disk RIGHT NOW, before this
// (attempt-3) correction pass edits the manifest further — recomputed for this pass since the file
// legitimately changed when attempt 2 appended its own sections (the old attempt-2-era constant
// would no longer match and must not be reused as a stand-in for "unchanged since attempt 2").
const PRE_EDIT_MANIFEST_HASH = '2905917e5c598813454bbdf9c126d24a30de6034fbb128fabea500d4b5ff4731';

// Defect 5: the four archived attempt1/attempt2 canonical artifacts must be programmatically
// hash-verified (not narrated) before the final replay is allowed to spawn.
const ARCHIVE_HASHES: Record<string, string> = {
  'data/g6r-runs/g6r-cp3-attempt1-invalid-summary.json': 'a12dd6441e494bbfd26d38c1e00df1d118193c25de1877cf9669d8df4233e2ad',
  'data/g6r-runs/g6r-cp3-attempt2-invalid-summary.json': '46fb46ed3e1336ac693490d7d045050b78827825d35e21d57dadb409f8dbf1a1',
  'data/g6r-runs/g6r-cp3-attempt2-preflight.json': 'e8fd6865349fb2992174053aa14a14cbb6f911a1b4c518f3da17d8a51c1e08ec',
  'data/g6r-runs/g6r-cp3-attempt2-execution.json': '8ca2c2bbc3bc1b073574c60f795b4be6b83d67cfb42808e52010c0dd5222559e',
};

const REGISTRATION_DOC_PATH = path.resolve(REPO_ROOT, 'data/g6-root-cause-and-candidate-registration.md');
const RULE_SECTION_HEADING = '### G6-C1 — CASCADE_FALLTHROUGH_ON_MSS_FAIL';
const NEXT_SECTION_MARKER = '\n## '; // next top-level heading terminates the slice

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}
function sha256Text(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

/** Locates the rule section by its stable heading text (not hardcoded line numbers) and hashes exactly that slice. */
function computeRegisteredRuleSliceHash(docText: string): { hash: string; startOffset: number; endOffset: number; byteLength: number; extractionMethod: string } {
  const startOffset = docText.indexOf(RULE_SECTION_HEADING);
  if (startOffset === -1) throw new Error(`CHECKPOINT_3_INVALID: could not locate heading "${RULE_SECTION_HEADING}" in registration doc`);
  const afterHeading = docText.slice(startOffset + RULE_SECTION_HEADING.length);
  const nextIdx = afterHeading.indexOf(NEXT_SECTION_MARKER);
  const slice = nextIdx === -1 ? docText.slice(startOffset) : docText.slice(startOffset, startOffset + RULE_SECTION_HEADING.length + nextIdx);
  const buf = Buffer.from(slice, 'utf8');
  return {
    hash: createHash('sha256').update(buf).digest('hex'),
    startOffset,
    endOffset: startOffset + buf.length,
    byteLength: buf.length,
    extractionMethod: `bytes from indexOf("${RULE_SECTION_HEADING}") up to (exclusive) the next "\\n## " heading marker, UTF-8`,
  };
}

interface PreflightCheck {
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
  readonly pass: boolean;
}

function runProgrammaticPreflight(): { checks: PreflightCheck[]; allPass: boolean; registrationDocSha256: string } {
  const checks: PreflightCheck[] = [];

  const actualBranch = git(['branch', '--show-current']);
  checks.push({ name: 'branch', expected: EXPECTED_BRANCH, actual: actualBranch, pass: actualBranch === EXPECTED_BRANCH });

  const actualHead = git(['rev-parse', 'HEAD']);
  checks.push({ name: 'HEAD', expected: EXPECTED_HEAD, actual: actualHead, pass: actualHead === EXPECTED_HEAD });

  const actualMergeBase = git(['merge-base', EXPECTED_MERGE_BASE, 'HEAD']);
  checks.push({ name: 'merge-base(2cd3faf...,HEAD)', expected: EXPECTED_MERGE_BASE, actual: actualMergeBase, pass: actualMergeBase === EXPECTED_MERGE_BASE });

  const statusRaw = git(['status', '--short']);
  const statusLines = statusRaw.length === 0 ? [] : statusRaw.split('\n');
  const offenders: string[] = [];
  for (const line of statusLines) {
    const code = line.slice(0, 2);
    const file = line.slice(3).trim();
    const isUntracked = code === '??';
    const isAllowedUntracked = isUntracked && ALLOWED_UNTRACKED.has(file.replace(/\\/g, '/'));
    const isDataArtifact = file.replace(/\\/g, '/').startsWith('data/g6r-runs/');
    if (!isAllowedUntracked && !isDataArtifact) offenders.push(line);
  }
  checks.push({
    name: 'git status allowlist',
    expected: `only ${[...ALLOWED_UNTRACKED].join(', ')} untracked (plus data/g6r-runs/* artifacts)`,
    actual: offenders.length === 0 ? '(clean per allowlist)' : offenders.join(' | '),
    pass: offenders.length === 0,
  });

  for (const [file, expectedHash] of Object.entries(LOCKED_INPUT_HASHES)) {
    const actualHash = sha256File(path.resolve(REPO_ROOT, file));
    checks.push({ name: `sha256(${file})`, expected: expectedHash, actual: actualHash, pass: actualHash === expectedHash });
  }

  const manifestPath = path.resolve(REPO_ROOT, 'data/g6r-run-manifest.json');
  const preEditManifestHashActual = sha256File(manifestPath);
  checks.push({
    name: 'sha256(data/g6r-run-manifest.json) [pre-correction-edit snapshot]',
    expected: PRE_EDIT_MANIFEST_HASH,
    actual: preEditManifestHashActual,
    pass: preEditManifestHashActual === PRE_EDIT_MANIFEST_HASH,
  });

  for (const [file, expectedHash] of Object.entries(ARCHIVE_HASHES)) {
    const fullPath = path.resolve(REPO_ROOT, file);
    let actualHash: string;
    try {
      actualHash = sha256File(fullPath);
    } catch {
      actualHash = 'MISSING_FILE';
    }
    checks.push({ name: `archive sha256(${file})`, expected: expectedHash, actual: actualHash, pass: actualHash === expectedHash });
  }

  const registrationDocSha256 = sha256File(REGISTRATION_DOC_PATH);

  const allPass = checks.every((c) => c.pass);
  return { checks, allPass, registrationDocSha256 };
}

// ============================== Observer-run parity (Defect 3 fix) ==============================
// Uses the ACTUAL trades produced by THIS run's runReplay() call (with the shadow analyzer's
// observe-only hooks attached), not pre-existing CSV files, per Defect 3.

interface ObserverParityResult {
  readonly observerRows: number;
  readonly observerUnique: number;
  readonly observerDuplicates: number;
  readonly freshC0Rows: number;
  readonly freshC0Unique: number;
  readonly freshC0Duplicates: number;
  readonly canonicalRows: number;
  readonly canonicalUnique: number;
  readonly canonicalDuplicates: number;
  readonly observerOnlyVsFresh: number;
  readonly freshOnlyVsObserver: number;
  readonly observerOnlyVsCanonical: number;
  readonly canonicalOnlyVsObserver: number;
  readonly observerTradeKeyDigestSha256: string;
  readonly pass: boolean;
}

const tradeKey = (entryTimestamp: number | string, symbol: string, side: string): string => `${entryTimestamp}|${symbol}|${side}`;

function checkObserverRunParity(observerTrades: readonly { entryTimestamp: number; symbol: string; side: string }[]): ObserverParityResult {
  const freshC0Path = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-c0-rerun-N0_CURRENT-CENTRAL-trades.csv');
  const canonicalPath = path.resolve(REPO_ROOT, 'data/archive/ticket153b/ticket153b-central-ledger.csv');
  const freshC0Csv = parseCsv(readFileSync(freshC0Path, 'utf8'));
  const canonicalCsv = parseCsv(readFileSync(canonicalPath, 'utf8'));
  const csvKeyOf = (r: Record<string, string>) => tradeKey(r.entryTimestamp, r.symbol, r.side);

  const observerKeys = observerTrades.map((t) => tradeKey(t.entryTimestamp, t.symbol, t.side));
  const freshC0Keys = freshC0Csv.rows.map(csvKeyOf);
  const canonicalKeys = canonicalCsv.rows.map(csvKeyOf);

  const observerSet = new Set(observerKeys);
  const freshC0Set = new Set(freshC0Keys);
  const canonicalSet = new Set(canonicalKeys);

  const observerOnlyVsFresh = [...observerSet].filter((k) => !freshC0Set.has(k)).length;
  const freshOnlyVsObserver = [...freshC0Set].filter((k) => !observerSet.has(k)).length;
  const observerOnlyVsCanonical = [...observerSet].filter((k) => !canonicalSet.has(k)).length;
  const canonicalOnlyVsObserver = [...canonicalSet].filter((k) => !observerSet.has(k)).length;

  const observerTradeKeyDigestSha256 = sha256Text([...observerSet].sort().join('\n'));

  const observerDuplicates = observerKeys.length - observerSet.size;
  const freshC0Duplicates = freshC0Keys.length - freshC0Set.size;
  const canonicalDuplicates = canonicalKeys.length - canonicalSet.size;

  const pass =
    observerTrades.length === 211 &&
    observerSet.size === 211 &&
    freshC0Csv.rows.length === 211 &&
    freshC0Set.size === 211 &&
    canonicalCsv.rows.length === 211 &&
    canonicalSet.size === 211 &&
    observerDuplicates === 0 &&
    freshC0Duplicates === 0 &&
    canonicalDuplicates === 0 &&
    observerOnlyVsFresh === 0 &&
    freshOnlyVsObserver === 0 &&
    observerOnlyVsCanonical === 0 &&
    canonicalOnlyVsObserver === 0;

  return {
    observerRows: observerTrades.length,
    observerUnique: observerSet.size,
    observerDuplicates,
    freshC0Rows: freshC0Csv.rows.length,
    freshC0Unique: freshC0Set.size,
    freshC0Duplicates,
    canonicalRows: canonicalCsv.rows.length,
    canonicalUnique: canonicalSet.size,
    canonicalDuplicates,
    observerOnlyVsFresh,
    freshOnlyVsObserver,
    observerOnlyVsCanonical,
    canonicalOnlyVsObserver,
    observerTradeKeyDigestSha256,
    pass,
  };
}

// ============================== Replay + leakage audits ==============================

const regimeByStep = new Map<string, { regime: MarketRegime; evaluationTimestamp: number; adxDirection1h: 'UP' | 'DOWN' | 'FLAT' | undefined; macroDirection: 'UP' | 'DOWN' | 'FLAT' | undefined }>();
const observations: G6ShadowObservation[] = [];
const shadowEvents: FrozenShadowEvent[] = [];

let obPrimaryBeforeMacro = 0;
let macroBlockedCount = 0;
let obPrimaryAfterMacro = 0;
let obMssFailAfterMacro = 0;
let fvgEvaluatedAfterMacro = 0;
let fvgActionableCount = 0;
let sweepEvaluatedAfterMacro = 0;
let sweepActionableCount = 0;

// Audit A: evaluation-input closure — every candle array fed to the analyzer must be closed at or
// before the evaluation's own decision boundary. Candle timestamps are OPEN times (verified against
// data/ohlcv/*.csv: row[i].close === row[i+1].open, and consecutive timestamps differ by exactly the
// bar interval), so a 5m candle's own CLOSE boundary is `timestamp + 5min`.
// Defect 2 fix: this is now a REDUNDANT outer check — the analyzer itself throws
// FutureCandleViolationError before evaluating anything if any candle (5m/1m/1d macro) is unclosed
// at evaluationCutoffExclusive. Audit A here independently re-derives the same violation count from
// the caller's own view of the raw arrays (belt-and-suspenders, not the sole enforcement point).
let leakageAuditAViolations = 0;
let futureCandleViolationsCaught = 0;
const futureCandleViolationSamples: Array<{ evaluationId: string; array: string; candleIndex: number; candleTimestamp: number }> = [];

const lookup = (symbol: string, timestamp: number): string => `${symbol}|${timestamp}`;
const analyzer = createG6ShadowOpportunityAnalyzer();

const hooks: ReplayVariantHooks = {
  onStepContext: (ctx) =>
    regimeByStep.set(lookup(ctx.symbol, ctx.timestamp), {
      regime: ctx.regime,
      evaluationTimestamp: ctx.timestamp,
      adxDirection1h: ctx.adxDirection1h,
      macroDirection: undefined, // overwritten from ctx.input below (onStepContext does not carry macroDirection)
    }),
  onBeforeProcessCandle: (ctx) => {
    const shadow = regimeByStep.get(lookup(ctx.symbol, ctx.timestamp));
    if (!shadow) throw new Error(`G6R_CP3_MISSING_REGIME_CONTEXT ${ctx.symbol}|${ctx.timestamp}`);
    const cfg = ctx.config.entryRouterConfig;
    const trendStyle = shadow.regime === MarketRegime.TREND_RIDER || (shadow.regime === MarketRegime.NEUTRAL_TRANSITION && cfg.entryStyleForNeutral === 'TREND_STYLE');
    if (!trendStyle) return; // OB is only ever evaluated in trend style — not an OB-primary evaluation.

    const candles5m = ctx.input.candles5m;
    const candlesMss = ctx.input.candles1m;
    const macroInputCandles1d = ctx.input.candles1d;

    // ---- Audit A: evaluation-input closure (independent re-derivation, belt-and-suspenders) ----
    const now = candles5m[candles5m.length - 1]?.timestamp;
    const evaluationCutoffExclusive = now !== undefined ? now + FIVE_MINUTES_MS : ctx.timestamp + FIVE_MINUTES_MS;
    if (now !== undefined) {
      if (candles5m.some((c) => c.timestamp > now)) leakageAuditAViolations++;
      if (candlesMss.some((c) => c.timestamp >= evaluationCutoffExclusive)) leakageAuditAViolations++;
    }

    const id = evaluationId(ctx.symbol, ctx.timestamp, shadow.regime, 0);
    // ProcessCandleInput does NOT carry a precomputed macroDirection field — production computes it
    // internally inside processCandle() via wilderDIDirectionSeries(input.candles1d,
    // EntryConfig.MACRO_TREND_ADX_PERIOD_1D) (see orchestrator.ts line ~895-896). Replicated verbatim
    // here (same function, same period, same series-tail selection) since this hook fires BEFORE
    // processCandle's own internal computation.
    const macroSeries = wilderDIDirectionSeries(macroInputCandles1d, EntryConfigForMacro.MACRO_TREND_ADX_PERIOD_1D);
    const macroDirection = macroSeries.length > 0 ? macroSeries[macroSeries.length - 1] : undefined;

    let observation: G6ShadowObservation;
    try {
      observation = analyzer.observeDecision(
        {
          symbol: ctx.symbol,
          candles5m,
          candlesMss,
          macroInputCandles1d,
          adxDirection1h: shadow.adxDirection1h,
          obEnabled: cfg.obEnabled !== false,
          obDisabledSymbols: cfg.obDisabledSymbols,
          obBosLookforwardK: cfg.obBosLookforwardK,
          obSlBufferAtrMultiplier: cfg.obSlBufferAtrMultiplier,
          macroTrendFilterEnabled: cfg.macroTrendFilterEnabled,
          macroDirection,
          evaluationCutoffExclusive,
        },
        { evaluationId: id, regime: shadow.regime, evaluationTimestamp: ctx.timestamp },
      );
    } catch (e) {
      if (e instanceof FutureCandleViolationError) {
        futureCandleViolationsCaught++;
        futureCandleViolationSamples.push({ evaluationId: id, array: e.array, candleIndex: e.candleIndex, candleTimestamp: e.candleTimestamp });
        return; // candidate rejected before ever being evaluated — cannot influence the population
      }
      throw e;
    }
    observations.push(observation);

    if (observation.primaryObFound) {
      obPrimaryBeforeMacro++;
      if (observation.blockedByMacroFilter) {
        macroBlockedCount++;
      } else {
        obPrimaryAfterMacro++;
        if (observation.primary && !observation.primary.mssConfirmed) {
          obMssFailAfterMacro++;
          if (observation.fvgFallback) fvgEvaluatedAfterMacro++;
          if (observation.fvgFallback?.mssConfirmed) fvgActionableCount++;
          else {
            if (observation.sweepFallback) sweepEvaluatedAfterMacro++;
            if (observation.sweepFallback?.mssConfirmed) sweepActionableCount++;
          }
        }
      }
    }

    if (observation.actionableShadowEvent) {
      shadowEvents.push(observation.actionableShadowEvent);
    }
  },
};

const csv = (rows: Record<string, unknown>[]): string =>
  rows.length === 0 ? '' : `${Object.keys(rows[0]).join(',')}\n${rows.map((r) => Object.keys(rows[0]).map((k) => JSON.stringify(r[k] ?? '')).join(',')).join('\n')}\n`;

async function main(): Promise<void> {
  const nowIso = new Date().toISOString();

  // ---- Step 1 (Defect 5): final preflight — programmatic hash checks for every locked input,
  // INCLUDING all 4 archive files. Fail closed before spawning the replay. ----
  const preflight = runProgrammaticPreflight();
  const registrationText = readFileSync(REGISTRATION_DOC_PATH, 'utf8');
  const ruleSlice = computeRegisteredRuleSliceHash(registrationText);
  const preflightArtifact = {
    utcTimestamp: nowIso,
    checks: preflight.checks,
    archiveChecks: preflight.checks.filter((c) => c.name.startsWith('archive sha256(')),
    overallPass: preflight.allPass,
    registrationDocumentSha256: preflight.registrationDocSha256,
    registeredRuleSliceSha256: ruleSlice.hash,
    registeredRuleSliceSource: { file: 'data/g6-root-cause-and-candidate-registration.md', heading: RULE_SECTION_HEADING, ...ruleSlice },
    status: preflight.allPass ? 'PREFLIGHT_PASS' : 'PREFLIGHT_FAIL',
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, 'g6r-cp3-final-preflight.json'), JSON.stringify(preflightArtifact, null, 2) + '\n');

  if (!preflight.allPass) {
    console.error('PREFLIGHT_FAIL', JSON.stringify(preflight.checks.filter((c) => !c.pass), null, 2));
    throw new Error('CHECKPOINT_3_PREFLIGHT_FAIL: one or more locked-input/archive checks failed; replay NOT spawned. See data/g6r-runs/g6r-cp3-final-preflight.json.');
  }
  if (preflight.registrationDocSha256 !== '9ca5941d8f57d8c7a403cecbcda7e19328cf4547b6d0beac87b838bfeb056114') {
    throw new Error('CHECKPOINT_3_INVALID: registrationDocumentSha256 whole-file gate failed; replay NOT spawned.');
  }

  const analyzerSourceHash = sha256File(path.resolve(REPO_ROOT, 'apps/bot/scripts/g6rShadowAnalyzer.ts'));

  // ---- Step 2: the ONE authorized replay, with the shadow analyzer's observe-only hooks attached.
  // Defect 3 fix: parity is computed from THIS run's own replayResult.trades, not old CSV files. ----
  const replayStartIso = new Date().toISOString();
  const config = { ...buildBaselineConfig(), sameSideDuplicateGuardEnabled: true };
  let replayResult: Awaited<ReturnType<typeof runReplay>>;
  let replayEndIso: string;
  try {
    replayResult = await runReplay(config, makeFillModel('CENTRAL', 2 / 10000, 2 / 10000), STOP_STEP, hooks);
    replayEndIso = new Date().toISOString();
  } catch (error) {
    replayEndIso = new Date().toISOString();
    const replayCallError = error instanceof Error ? error.message : String(error);
    const artifact = buildExecutionOutcomeArtifact({
      runCountThisAuthorization: 1,
      utcBeforeSpawn: replayStartIso,
      utcAfterExit: replayEndIso,
      replayCallError,
      validationStatus: 'CHECKPOINT_3_INVALID',
      command: '$env:T153_LIBRARY_MODE=\'true\'; node apps/bot/scripts-dist/g6rCheckpoint3Replay.js',
      env: { T153_LIBRARY_MODE: 'true' },
      stopStep: STOP_STEP,
      sourceHashes: { analyzerSourceHash, registrationDocumentSha256: preflight.registrationDocSha256, registeredRuleSliceSha256: ruleSlice.hash },
      observerReplayTradeIdentityDigestSha256: null,
      observerRunParity: null,
      futureCandleViolationsCaught,
      futureCandleViolationSamples: futureCandleViolationSamples.slice(0, 10),
    });
    writeFileSync(path.join(OUT_DIR, 'g6r-cp3-final-execution.json'), JSON.stringify(artifact, null, 2) + '\n');
    throw error;
  }

  const observerParity = checkObserverRunParity(replayResult.trades);

  // Fix 2: the execution-outcome artifact is built via a pure function that derives
  // expectedProcessExitCode FROM validationStatus (never sets it independently), and never
  // emits a field named `exitCode`. Written once per exit path, with the validationStatus that
  // is actually true at that point — never speculatively before it's known.
  const writeExecutionArtifact = (validationStatus: ValidationStatus, replayCallError: string | null) => {
    const artifact = buildExecutionOutcomeArtifact({
      runCountThisAuthorization: 1,
      utcBeforeSpawn: replayStartIso,
      utcAfterExit: replayEndIso,
      replayCallError,
      validationStatus,
      command: '$env:T153_LIBRARY_MODE=\'true\'; node apps/bot/scripts-dist/g6rCheckpoint3Replay.js',
      env: { T153_LIBRARY_MODE: 'true' },
      stopStep: STOP_STEP,
      sourceHashes: { analyzerSourceHash, registrationDocumentSha256: preflight.registrationDocSha256, registeredRuleSliceSha256: ruleSlice.hash },
      observerReplayTradeIdentityDigestSha256: observerParity.observerTradeKeyDigestSha256,
      observerRunParity: observerParity,
      futureCandleViolationsCaught,
      futureCandleViolationSamples: futureCandleViolationSamples.slice(0, 10),
    });
    writeFileSync(path.join(OUT_DIR, 'g6r-cp3-final-execution.json'), JSON.stringify(artifact, null, 2) + '\n');
  };

  if (!observerParity.pass) {
    writeExecutionArtifact('CHECKPOINT_3_INVALID', null);
    writeFileSync(
      path.join(OUT_DIR, 'g6r-cp3-shadow-summary.json'),
      JSON.stringify({ status: 'CHECKPOINT_3_INVALID', reason: 'OBSERVER_PARITY_BREAK', observerRunParity: observerParity }, null, 2) + '\n',
    );
    throw new Error(`CHECKPOINT_3_INVALID: OBSERVER_PARITY_BREAK, ${JSON.stringify(observerParity)}`);
  }

  // ---- Step 3 (Defect 1): real, non-tautological Audit B over ALL emitted candidates. ----
  const auditB = auditDecisionFeatureProvenance(shadowEvents);

  // ---- Step 4: join against CP2 evaluation ledger via the real CSV parser. ----
  const cp2EvaluationsRaw = readFileSync(path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp2-evaluations.csv'), 'utf8');
  const cp2Parsed = parseLedgerCsvRequiringEvaluationId(cp2EvaluationsRaw);
  const cp2EvaluationIds = new Set(cp2Parsed.rows.map((r) => r.evaluationId));

  // ---- Step 5 (Defect 4): build a COMPLETE ShadowCandidateRow for EVERY emitted candidate,
  // including geometry-invalid ones, BEFORE any validation decision. No early return. ----
  const rows: ShadowCandidateRow[] = shadowEvents.map((ev) => {
    const obsForEval = observations.find((o) => o.evaluationId === ev.evaluationId);
    return {
      candidateKey: ev.candidateKey,
      evaluationId: ev.evaluationId,
      symbol: ev.symbol,
      side: ev.side,
      regime: ev.regime,
      setupType: ev.setupType,
      evaluationTimestamp: ev.evaluationTimestamp,
      sourceTimestamp: ev.sourceTimestamp,
      decisionTimestamp: ev.decisionTimestamp,
      entryPrice: ev.entryPrice,
      slPrice: ev.slPrice,
      slDistance: ev.slDistance,
      requiredDataCoverage: 'FULL',
      primaryObFound: obsForEval?.primaryObFound ?? true,
      primaryObMssPassed: false,
      primaryObMssFailReason: obsForEval?.primary?.mssFailReason ?? null,
      fallbackDetectorResult: ev.setupType === 'FVG' ? (obsForEval?.fvgFallback?.found ? 'FOUND' : 'NOT_FOUND') : obsForEval?.sweepFallback?.found ? 'FOUND' : 'NOT_FOUND',
      fallbackMssResult: 'CONFIRMED',
      registrationDocumentSha256: preflight.registrationDocSha256,
      analyzerSourceHash,
      dataQuality: 'DQ-B — HISTORICAL_PROXY',
      decisionFeatureProvenance: ev.provenance,
    };
  });

  // ---- Step 6 (Defect 4): full schema validator over the ENTIRE population (never narrowed by a
  // geometry short-circuit), plus separate duplicate/join/multi-candidate/leakage/geometry checks. ----
  const schemaResult = validateShadowCandidateRows(rows, {
    expectedRegistrationDocumentSha256: preflight.registrationDocSha256,
    expectedAnalyzerSourceHash: analyzerSourceHash,
    knownEvaluationIds: cp2EvaluationIds,
    evaluationIdFormula: (r) => evaluationId(r.symbol, r.evaluationTimestamp, r.regime, 0),
    candidateKeyFormula: (r) => `${r.symbol}|${r.side}|${r.setupType}|${r.decisionTimestamp}|${r.sourceTimestamp}`,
  });
  const ledgerValidation = validateShadowLedger(shadowEvents, cp2EvaluationIds);

  // Category buckets, derived from the actual per-row error strings via a PURE,
  // independently-unit-tested function (g6rErrorTaxonomy.ts). Geometry messages ('LONG/SHORT
  // requires slPrice ...', 'must all be finite', 'slDistance !== abs(...)') are routed to their
  // own category there and NEVER fall into requiredFieldErrors (the historical double-count bug
  // — geometryErrors below has always been sourced solely from ledgerValidation.invalidGeometryCount,
  // a single authoritative source; this fix only stops the schema-error loop from ALSO counting
  // the same 31 rows into requiredFieldErrors).
  const taxonomy = categorizeSchemaErrors([...schemaResult.rowErrors.values()]);
  const { requiredFieldErrors, hashErrors, timestampOrderingErrors, setupTypeErrors, coverageErrors } = taxonomy;
  const duplicateErrors = schemaResult.duplicateCandidateKeys;
  const multiCandidateErrors = schemaResult.evaluationsWithMultipleCandidates;
  const joinErrors = ledgerValidation.missingCp2Joins;
  const leakageErrors = leakageAuditAViolations + futureCandleViolationsCaught + auditB.violationCount;
  const geometryErrors = ledgerValidation.invalidGeometryCount;

  const totalErrorCount = requiredFieldErrors + hashErrors + timestampOrderingErrors + setupTypeErrors + coverageErrors + duplicateErrors + joinErrors + multiCandidateErrors + leakageErrors + geometryErrors;
  const anyValidationError = totalErrorCount > 0 || !schemaResult.valid || !ledgerValidation.valid || leakageErrors > 0;

  const countBy = <K extends keyof ShadowCandidateRow>(field: K): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const r of rows) {
      const v = String(r[field]);
      out[v] = (out[v] ?? 0) + 1;
    }
    return out;
  };
  const byMonth: Record<string, number> = {};
  for (const r of rows) {
    const month = new Date(r.decisionTimestamp).toISOString().slice(0, 7);
    byMonth[month] = (byMonth[month] ?? 0) + 1;
  }

  const commonSummaryFields = {
    executionHead: EXPECTED_HEAD,
    exactCommand: '$env:T153_LIBRARY_MODE=\'true\'; node apps/bot/scripts-dist/g6rCheckpoint3Replay.js',
    correctedRun: true,
    supersedesArchives: ['data/g6r-runs/g6r-cp3-attempt1-invalid-summary.json', 'data/g6r-runs/g6r-cp3-attempt2-invalid-summary.json'],
    inputHashes: { ...LOCKED_INPUT_HASHES, 'data/g6r-run-manifest.json (pre-correction-edit snapshot)': PRE_EDIT_MANIFEST_HASH },
    analyzerSourceHash,
    registrationDocumentSha256: preflight.registrationDocSha256,
    registeredRuleSliceSha256: ruleSlice.hash,
    registeredRuleSliceSource: preflightArtifact.registeredRuleSliceSource,
    observerRunParity: observerParity,
    leakageAuditA: { violations: leakageAuditAViolations, result: leakageAuditAViolations === 0 ? 'PASS' : 'FAIL' },
    leakageAuditB: {
      candidatesAudited: auditB.candidatesAudited,
      auditBViolationCount: auditB.violationCount,
      byProvenanceField: auditB.byProvenanceField,
      representativeSamples: auditB.violations.slice(0, 10),
      result: auditB.pass ? 'PASS' : 'FAIL',
    },
    futureCandleViolationsCaught,
    futureCandleViolationSamples: futureCandleViolationSamples.slice(0, 10),
    schemaRowsValidated: rows.length,
    validationTotals: { requiredFieldErrors, hashErrors, timestampOrderingErrors, setupTypeErrors, coverageErrors, duplicateErrors, joinErrors, multiCandidateErrors, leakageErrors, geometryErrors },
    reconciliation: {
      obPrimaryBeforeMacro,
      macroBlockedCount,
      obPrimaryAfterMacro,
      obMssFailAfterMacro,
      fvgEvaluatedAfterMacro,
      fvgActionableCount,
      sweepEvaluatedAfterMacro,
      sweepActionableCount,
      totalShadowCandidates: rows.length,
      geometryInvalidCount: geometryErrors,
      maxOneActionableCandidatePerEvaluationProof: `evaluationsWithMultipleActionable=${multiCandidateErrors} (checked over ${new Set(shadowEvents.map((e) => e.evaluationId)).size} evaluations that produced >=1 candidate)`,
    },
    breakdown: {
      bySetupType: countBy('setupType'),
      bySymbol: countBy('symbol'),
      byMonth,
      byRegime: countBy('regime'),
      bySide: countBy('side'),
    },
  };

  if (anyValidationError) {
    const sampleRowErrors = [...schemaResult.rowErrors.entries()].slice(0, 15);
    const invalidGeometrySample = shadowEvents
      .filter((ev) => {
        const finiteOk = Number.isFinite(ev.entryPrice) && Number.isFinite(ev.slPrice) && Number.isFinite(ev.slDistance) && ev.slDistance > 0;
        const directionOk = ev.side === 'LONG' ? ev.slPrice < ev.entryPrice : ev.slPrice > ev.entryPrice;
        return !finiteOk || !directionOk;
      })
      .slice(0, 10);
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      path.join(OUT_DIR, 'g6r-cp3-shadow-summary.json'),
      JSON.stringify(
        {
          status: 'CHECKPOINT_3_INVALID',
          ...commonSummaryFields,
          diagnosis:
            'Full-population schema validation (never narrowed by a geometry short-circuit) found validation errors. Geometry-invalid rows are RETAINED in this summary (not dropped) per ticket requirement. No canonical candidate CSV was written.',
          sampleRowErrors,
          invalidGeometrySample,
        },
        null,
        2,
      ) + '\n',
    );
    console.error('CHECKPOINT_3_INVALID', JSON.stringify({ requiredFieldErrors, hashErrors, timestampOrderingErrors, setupTypeErrors, coverageErrors, duplicateErrors, joinErrors, multiCandidateErrors, leakageErrors, geometryErrors }), 'totalCandidates=', shadowEvents.length);
    writeExecutionArtifact('CHECKPOINT_3_INVALID', null);
    throw new Error(`CHECKPOINT_3_INVALID: validation errors found across the full ${rows.length}-row population (geometryErrors=${geometryErrors}, leakageErrors=${leakageErrors}, others summed=${totalErrorCount - geometryErrors - leakageErrors}).`);
  }

  // ---- PASS: freeze the canonical candidate CSV, hash it immediately, never edit after hashing. ----
  mkdirSync(OUT_DIR, { recursive: true });
  const ledgerCsv = csv(rows as unknown as Record<string, unknown>[]);
  const ledgerPath = path.join(OUT_DIR, 'g6r-cp3-shadow-candidates.csv');
  writeFileSync(ledgerPath, ledgerCsv);
  const shadowLedgerHash = sha256File(ledgerPath);

  const summary = { status: 'CHECKPOINT_3_PASS', ...commonSummaryFields, shadowLedgerHash };

  writeFileSync(path.join(OUT_DIR, 'g6r-cp3-shadow-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  writeExecutionArtifact('CHECKPOINT_3_PASS', null);
  console.log(JSON.stringify({ status: 'CHECKPOINT_3_PASS', totalShadowCandidates: rows.length, obPrimaryBeforeMacro, macroBlockedCount, obMssFailAfterMacro, fvgActionableCount, sweepActionableCount, shadowLedgerHash }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
