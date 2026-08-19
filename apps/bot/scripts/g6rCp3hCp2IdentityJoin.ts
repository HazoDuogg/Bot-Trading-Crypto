/**
 * TICKET-G6R-CP3HR3 — Task 1: CP2 evaluation-level identity join validation for the CP3H forensic
 * ledger (105-row FVG/Sweep fallback population + 104-row OB diagnostic population, 209 total).
 *
 * ABSOLUTE CONSTRAINT: this module NEVER imports, calls, or spawns any replay runner
 * (g6rCp3hForensicReplay.ts, g6rCheckpoint2Replay.ts, g6rCheckpoint3Replay.ts,
 * ticket150BacktestExecutionRealismAudit.ts's runReplay(), or any Central/CP4/CP5/CP6 tooling). It only
 * reads already-existing, already-frozen CSV artifacts:
 *   - data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv (read-only input, via the caller)
 *   - data/g6r-runs/g6r-cp2-evaluations.csv (read-only input; 204,376 rows)
 *
 * ---- Critical scoping fact (verified directly from the data, not assumed) ----
 * `data/g6r-run-manifest.json`'s `checkpoint2` block is the CURRENT PRODUCTION BASELINE funnel, not the
 * G6-C1 shadow candidate rule. `data/g6r-runs/g6r-cp2-candidates.csv` (4472 rows) contains only
 * `setupType` values OB|BOX_BREAKOUT|MOMENTUM_DIRECT — ZERO FVG/SWEEP rows — because those setup types
 * only exist under the G6-C1 shadow candidate logic, never in the baseline funnel at all. This means the
 * 105 FVG/Sweep fallback `candidateKey` values on the CP3H ledger will LEGITIMATELY never be found in
 * `g6r-cp2-candidates.csv`'s candidateKey set — that is expected and correct, NOT a defect. This module
 * therefore deliberately does NOT check a fallback row's candidateKey against
 * `g6r-cp2-candidates.csv` (see `CANDIDATE_KEY_VS_CP2_CANDIDATES_CSV_SCOPE_NOTE` below) — doing so would
 * flag all 105 rows unconditionally and produce a meaningless always-fail gate.
 *
 * What IS checked here is meaningful: `g6r-cp2-evaluations.csv` is EVALUATION-level and is shared across
 * every candidate rule layered on top of the funnel, including the G6-C1 shadow evaluation stream — every
 * evaluationId on the CP3H ledger (OB + fallback alike) is expected to be found there.
 */
import { parseCsv } from './g6rCsvParser.js';
import { isValidEvaluationIdFormat, expectedCandidateKey, type ForensicTelemetryRow } from './g6rCp3hForensicSchema.js';
import { evaluationId as canonicalEvaluationId } from './g6rFullPathFunnel.js';

// ============================== CP2 evaluations CSV parsing ==============================

export interface Cp2EvaluationRow {
  readonly evaluationId: string;
  readonly symbol: string;
  readonly regime: string;
  readonly evaluationTimestamp: number;
  readonly routeInvocationOrdinal: number;
  readonly terminalOutcome: string;
  readonly terminalReason: string;
  readonly dataQuality: string;
}

const CP2_EVALUATIONS_REQUIRED_HEADER: readonly string[] = [
  'evaluationId',
  'symbol',
  'regime',
  'evaluationTimestamp',
  'routeInvocationOrdinal',
  'terminalOutcome',
  'terminalReason',
  'dataQuality',
];

/** Parses `data/g6r-runs/g6r-cp2-evaluations.csv` (or an equivalently-shaped fixture). Fails closed on a missing required column. Does not enforce "no extra column" — this file is a shared upstream artifact this ticket does not own the schema of. */
export function parseCp2EvaluationsCsv(text: string): Cp2EvaluationRow[] {
  const parsed = parseCsv(text);
  for (const h of CP2_EVALUATIONS_REQUIRED_HEADER) {
    if (!parsed.header.includes(h)) throw new Error(`parseCp2EvaluationsCsv: missing required column ${h}`);
  }
  return parsed.rows.map((r, index) => {
    const evaluationTimestamp = Number(r.evaluationTimestamp);
    const routeInvocationOrdinal = Number(r.routeInvocationOrdinal);
    if (!Number.isSafeInteger(evaluationTimestamp)) throw new Error(`parseCp2EvaluationsCsv: row ${index + 2} evaluationTimestamp must be a safe integer`);
    if (!Number.isSafeInteger(routeInvocationOrdinal) || routeInvocationOrdinal < 0) throw new Error(`parseCp2EvaluationsCsv: row ${index + 2} routeInvocationOrdinal must be a non-negative safe integer`);
    return {
      evaluationId: r.evaluationId,
      symbol: r.symbol,
      regime: r.regime,
      evaluationTimestamp,
      routeInvocationOrdinal,
      terminalOutcome: r.terminalOutcome,
      terminalReason: r.terminalReason,
      dataQuality: r.dataQuality,
    };
  });
}

// ============================== Identity validation ==============================

export const CANDIDATE_KEY_VS_CP2_CANDIDATES_CSV_SCOPE_NOTE =
  'g6r-cp2-candidates.csv contains only setupType OB|BOX_BREAKOUT|MOMENTUM_DIRECT (verified directly: 4472 rows, zero FVG/SWEEP) because it is the CURRENT PRODUCTION BASELINE funnel, not the G6-C1 shadow candidate rule — FVG/SWEEP setup types only exist under the shadow logic. Checking a fallback (FVG/SWEEP) candidateKey against g6r-cp2-candidates.csv would therefore flag all 105 fallback rows unconditionally, which is not a real defect signal — a meaningless always-fail gate. This check is deliberately NOT performed by this module. The CP2 identity check performed instead is the evaluationId-level join against g6r-cp2-evaluations.csv (evaluation-level, shared across every candidate rule including the shadow stream) plus the evaluationId/candidateKey formula-shape checks, neither of which depends on g6r-cp2-candidates.csv.';

export interface Cp2IdentityViolation {
  readonly category:
    | 'MISSING_CP2_EVALUATION_JOIN'
    | 'MALFORMED_EVALUATION_ID_FORMAT'
    | 'CP2_EVALUATION_ID_FORMULA_MISMATCH'
    | 'MALFORMED_CANDIDATE_KEY_FORMAT'
    | 'IDENTITY_COMPONENT_MISMATCH'
    | 'AMBIGUOUS_CP2_JOIN_TARGET';
  readonly candidateKey: string | null;
  readonly evaluationId: string | null;
  readonly detail: string;
}

export interface Cp2IdentityValidationResult {
  readonly totalLedgerRows: number;

  /** Check (a) + (f): every CP3H ledger row's evaluationId must be found (uniquely) in g6r-cp2-evaluations.csv. */
  readonly missingCp2EvaluationJoins: number;
  readonly missingCp2EvaluationJoinDetails: readonly string[];

  /** Check (b): evaluationId itself must match symbol|evaluationTimestamp|regime|routeInvocationOrdinal (reuses isValidEvaluationIdFormat — never reimplemented). */
  readonly malformedEvaluationIdCount: number;
  readonly malformedEvaluationIdDetails: readonly string[];

  /** Check (d): candidateKey itself must match symbol|side|setupType|decisionTimestamp|sourceTimestamp (reuses expectedCandidateKey — never reimplemented). */
  readonly malformedCandidateKeyCount: number;
  readonly malformedCandidateKeyDetails: readonly string[];

  /** Check (c): for each successfully-joined row, symbol/regime must match the matched CP2 evaluation row exactly (string equality). */
  readonly symbolMismatchCount: number;
  readonly regimeMismatchCount: number;
  readonly identityComponentMismatchDetails: ReadonlyArray<{ candidateKey: string; evaluationId: string; field: 'symbol' | 'regime' | 'evaluationTimestamp'; ledgerValue: string | number; cp2Value: string | number }>;

  /** Check (e): duplicate evaluationId within g6r-cp2-evaluations.csv itself (ambiguous join target) — verified from the actual CSV, not trusted from the manifest's claim. */
  readonly ambiguousCp2EvaluationIds: number;
  readonly ambiguousCp2EvaluationIdValues: readonly string[];
  readonly cp2EvaluationIdFormulaMismatches: number;
  readonly cp2EvaluationIdFormulaMismatchValues: readonly string[];

  readonly violations: readonly Cp2IdentityViolation[];
  readonly pass: boolean;
  readonly candidateKeyVsCp2CandidatesCsvScopeNote: string;
}

/**
 * Fails closed on every CP2 identity defect category the ticket lists (a-f), scoped exactly as
 * documented above: NEVER checks a fallback row's candidateKey against g6r-cp2-candidates.csv (that
 * check is not meaningful — see `CANDIDATE_KEY_VS_CP2_CANDIDATES_CSV_SCOPE_NOTE`).
 */
export function computeCp2IdentityValidation(ledgerRows: readonly ForensicTelemetryRow[], cp2EvaluationRows: readonly Cp2EvaluationRow[]): Cp2IdentityValidationResult {
  const violations: Cp2IdentityViolation[] = [];
  const push = (category: Cp2IdentityViolation['category'], candidateKey: string | null, evaluationId: string | null, detail: string) => {
    violations.push({ category, candidateKey, evaluationId, detail });
  };

  // ---- (e) ambiguous join target: duplicate evaluationId within g6r-cp2-evaluations.csv itself ----
  const cp2Counts = new Map<string, number>();
  for (const c of cp2EvaluationRows) cp2Counts.set(c.evaluationId, (cp2Counts.get(c.evaluationId) ?? 0) + 1);
  const ambiguousCp2EvaluationIdValues = [...cp2Counts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  for (const k of ambiguousCp2EvaluationIdValues) {
    push('AMBIGUOUS_CP2_JOIN_TARGET', null, k, `evaluationId ${k} appears ${cp2Counts.get(k)} times in g6r-cp2-evaluations.csv — ambiguous join target`);
  }

  const cp2EvaluationIdFormulaMismatchValues: string[] = [];
  for (const c of cp2EvaluationRows) {
    const expected = canonicalEvaluationId(c.symbol, c.evaluationTimestamp, c.regime, c.routeInvocationOrdinal);
    if (c.evaluationId !== expected) {
      cp2EvaluationIdFormulaMismatchValues.push(c.evaluationId);
      push('CP2_EVALUATION_ID_FORMULA_MISMATCH', null, c.evaluationId, `expected canonical CP2 evaluationId ${expected}, got ${c.evaluationId}`);
    }
  }

  // A lookup built ONLY from non-ambiguous evaluationIds: an ambiguous evaluationId can never be
  // treated as a successful join even if a ledger row references it (there is no way to know which of
  // the duplicate CP2 rows is authoritative) — such ledger rows are counted as missing joins below,
  // fail-closed, never silently matched to whichever CP2 row happened to be seen last.
  const cp2ByEvaluationId = new Map<string, Cp2EvaluationRow>();
  for (const c of cp2EvaluationRows) {
    if ((cp2Counts.get(c.evaluationId) ?? 0) > 1) continue;
    cp2ByEvaluationId.set(c.evaluationId, c);
  }

  const missingCp2EvaluationJoinDetails: string[] = [];
  const malformedEvaluationIdDetails: string[] = [];
  const malformedCandidateKeyDetails: string[] = [];
  const identityComponentMismatchDetails: Array<{ candidateKey: string; evaluationId: string; field: 'symbol' | 'regime' | 'evaluationTimestamp'; ledgerValue: string | number; cp2Value: string | number }> = [];

  for (const r of ledgerRows) {
    // (b) evaluationId format
    if (!isValidEvaluationIdFormat(r.evaluationId)) {
      malformedEvaluationIdDetails.push(r.evaluationId);
      push('MALFORMED_EVALUATION_ID_FORMAT', r.candidateKey, r.evaluationId, `evaluationId ${r.evaluationId} does not match symbol|evaluationTimestamp|regime|routeInvocationOrdinal`);
    }
    // (d) candidateKey format
    const expected = expectedCandidateKey(r);
    if (expected !== r.candidateKey) {
      malformedCandidateKeyDetails.push(r.candidateKey);
      push('MALFORMED_CANDIDATE_KEY_FORMAT', r.candidateKey, r.evaluationId, `expected ${expected}, got ${r.candidateKey}`);
    }

    // (a)/(f) missing join + (c) identity component equality
    const cp2Row = cp2ByEvaluationId.get(r.evaluationId);
    if (!cp2Row) {
      missingCp2EvaluationJoinDetails.push(r.evaluationId);
      push('MISSING_CP2_EVALUATION_JOIN', r.candidateKey, r.evaluationId, `evaluationId ${r.evaluationId} not found (uniquely) in g6r-cp2-evaluations.csv`);
      continue;
    }
    if (r.symbol !== cp2Row.symbol) {
      identityComponentMismatchDetails.push({ candidateKey: r.candidateKey, evaluationId: r.evaluationId, field: 'symbol', ledgerValue: r.symbol, cp2Value: cp2Row.symbol });
      push('IDENTITY_COMPONENT_MISMATCH', r.candidateKey, r.evaluationId, `symbol mismatch: ledger=${r.symbol} cp2=${cp2Row.symbol}`);
    }
    if (r.regime !== cp2Row.regime) {
      identityComponentMismatchDetails.push({ candidateKey: r.candidateKey, evaluationId: r.evaluationId, field: 'regime', ledgerValue: r.regime, cp2Value: cp2Row.regime });
      push('IDENTITY_COMPONENT_MISMATCH', r.candidateKey, r.evaluationId, `regime mismatch: ledger=${r.regime} cp2=${cp2Row.regime}`);
    }
    if (r.evaluationTimestamp !== cp2Row.evaluationTimestamp) {
      identityComponentMismatchDetails.push({ candidateKey: r.candidateKey, evaluationId: r.evaluationId, field: 'evaluationTimestamp', ledgerValue: r.evaluationTimestamp, cp2Value: cp2Row.evaluationTimestamp });
      push('IDENTITY_COMPONENT_MISMATCH', r.candidateKey, r.evaluationId, `evaluationTimestamp mismatch: ledger=${r.evaluationTimestamp} cp2=${cp2Row.evaluationTimestamp}`);
    }
  }

  return {
    totalLedgerRows: ledgerRows.length,
    missingCp2EvaluationJoins: missingCp2EvaluationJoinDetails.length,
    missingCp2EvaluationJoinDetails,
    malformedEvaluationIdCount: malformedEvaluationIdDetails.length,
    malformedEvaluationIdDetails,
    malformedCandidateKeyCount: malformedCandidateKeyDetails.length,
    malformedCandidateKeyDetails,
    symbolMismatchCount: identityComponentMismatchDetails.filter((d) => d.field === 'symbol').length,
    regimeMismatchCount: identityComponentMismatchDetails.filter((d) => d.field === 'regime').length,
    identityComponentMismatchDetails,
    ambiguousCp2EvaluationIds: ambiguousCp2EvaluationIdValues.length,
    ambiguousCp2EvaluationIdValues,
    cp2EvaluationIdFormulaMismatches: cp2EvaluationIdFormulaMismatchValues.length,
    cp2EvaluationIdFormulaMismatchValues,
    violations,
    pass: violations.length === 0,
    candidateKeyVsCp2CandidatesCsvScopeNote: CANDIDATE_KEY_VS_CP2_CANDIDATES_CSV_SCOPE_NOTE,
  };
}

// ============================== CLI entry point (I/O; not exercised by tests importing the pure functions above) ==============================
//
// Reads the real, frozen CP3H ledger + CP2 evaluations CSVs, plus every other frozen artifact this
// ticket's evidence-hash section covers, computes the FULL TICKET-G6R-CP3HR3 validation artifact
// (CP2 identity + classification reconciliation, delegating to the already-existing
// `computeFallbackReconciliation()`), and writes it to `data/g6r-runs/g6r-cp3hr3-validation.json`. This
// is pure offline computation over already-frozen CSV/JSON files — no replay runner is imported, called,
// or spawned, directly or transitively.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseForensicLedgerCsv } from './g6rCp3hForensicSchema.js';
import { parseClassificationCsv, computeFallbackReconciliation } from './g6rCp3hrFallbackReconciliation.js';

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

async function main(): Promise<void> {
  const REPO_ROOT = process.cwd();
  const ledgerCsvPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv');
  const classificationCsvPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3h-classification.csv');
  const cp2EvaluationsCsvPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp2-evaluations.csv');
  const outPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3hr4-validation.json');

  const ledgerCsvText = readFileSync(ledgerCsvPath, 'utf8');
  const classificationCsvText = readFileSync(classificationCsvPath, 'utf8');
  const cp2EvaluationsCsvText = readFileSync(cp2EvaluationsCsvPath, 'utf8');

  const ledgerRows = parseForensicLedgerCsv(ledgerCsvText);
  const classificationRows = parseClassificationCsv(classificationCsvText);
  const cp2EvaluationRows = parseCp2EvaluationsCsv(cp2EvaluationsCsvText);

  const reconciliation = computeFallbackReconciliation(ledgerRows, classificationRows);
  const cp2Identity = computeCp2IdentityValidation(ledgerRows, cp2EvaluationRows);

  const nowUtcIso = new Date().toISOString();

  const artifact = {
    ticket: 'TICKET-G6R-CP3HR4',
    createdAtUtc: nowUtcIso,
    evidenceStatus: 'FORENSIC_PARTIAL — EVIDENCE_GAPS_REMAIN',
    finalDecision: reconciliation.reconciliationPass && cp2Identity.pass ? 'VALIDATOR_IMPLEMENTATION_CLOSED_WITH_UPSTREAM_CANDIDATE_IDENTITY_GAP' : 'CORRECTION_REQUIRED',
    sourceCsvPaths: {
      ledger: 'data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv',
      classification: 'data/g6r-runs/g6r-cp3h-classification.csv',
      cp2Evaluations: 'data/g6r-runs/g6r-cp2-evaluations.csv',
    },
    sourceCsvSha256: {
      ledger: sha256File(ledgerCsvPath),
      classification: sha256File(classificationCsvPath),
      cp2Evaluations: sha256File(cp2EvaluationsCsvPath),
    },
    cp2IdentityValidation: cp2Identity,
    fallbackReconciliation: reconciliation,
    zeroReplayNote:
      'This artifact was produced by running g6rCp3hCp2IdentityJoin.js (built via `npm run build:scripts`) directly with node, which reads already-frozen CSV/JSON evidence files and performs pure in-memory computation only. No replay runner (g6rCp3hForensicReplay.ts / g6rCheckpoint2Replay.ts / g6rCheckpoint3Replay.ts / ticket150BacktestExecutionRealismAudit.ts runReplay()) was imported, called, or spawned by this process, directly or transitively.',
    toolSourceSha256: {
      'g6rCp3hCp2IdentityJoin.ts': sha256File(path.resolve(REPO_ROOT, 'apps/bot/scripts/g6rCp3hCp2IdentityJoin.ts')),
      'g6rCp3hrFallbackReconciliation.ts': sha256File(path.resolve(REPO_ROOT, 'apps/bot/scripts/g6rCp3hrFallbackReconciliation.ts')),
      'g6rCp3hForensicSchema.ts': sha256File(path.resolve(REPO_ROOT, 'apps/bot/scripts/g6rCp3hForensicSchema.ts')),
    },
  };

  writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');
  console.log(JSON.stringify({ finalDecision: artifact.finalDecision, cp2IdentityPass: cp2Identity.pass, reconciliationPass: reconciliation.reconciliationPass }, null, 2));
}

// Guarded so importing this module (e.g. from a test) NEVER triggers file I/O or process.exit — only
// running it directly (`node g6rCp3hCp2IdentityJoin.js`) does.
const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
  } catch {
    return false;
  }
})();
if (isDirectRun) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
