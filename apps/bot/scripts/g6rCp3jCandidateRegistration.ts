/**
 * TICKET-G6R-CP3J — single candidate registration + offline causal-effect recomputation.
 *
 * Registers exactly one timestamp-correction candidate (`T3-DECISION-AVAILABLE-AT-CONFIRMING-CANDLE`,
 * see `data/g6r-cp3j-candidate-registration.md`): `decisionAvailableAt := decisionTimestamp +
 * ONE_MINUTE_MS`, replacing the CP3H-era `ev.provenance.mssMaxAvailableAt` wiring.
 *
 * ABSOLUTE CONSTRAINT: this module NEVER edits, imports-and-mutates, or spawns any replay runner. It
 * only reads the already-frozen `data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv` and re-runs the
 * REAL, unmodified `classifyTimestamp()`/`buildEventLikeFromRow()`/`filterFallbackRows()` (from
 * `g6rCp3hForensicSchema.ts`) and the REAL `confirmingCandleAvailableAt()` (from CP3I's
 * `g6rCp3iTimestampSemantics.ts`) — this module reimplements none of that logic itself. It never
 * writes back into the frozen ledger CSV, and never touches `g6rShadowAnalyzer.ts` or
 * `g6rCp3hForensicSchema.ts`.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseForensicLedgerCsv, filterFallbackRows, classifyTimestamp, buildEventLikeFromRow, type ForensicTelemetryRow, type TimestampClass } from './g6rCp3hForensicSchema.js';
import { confirmingCandleAvailableAt, ONE_MINUTE_MS } from './g6rCp3iTimestampSemantics.js';

export { ONE_MINUTE_MS };

export const CP3J_CANDIDATE_ID = 'T3-DECISION-AVAILABLE-AT-CONFIRMING-CANDLE' as const;

// ============================== Per-row recomputation ==============================

export interface PerRowCausalEffect {
  readonly candidateKey: string;
  readonly evaluationId: string;
  readonly originalDecisionAvailableAt: number;
  /** The candidate's formula: decisionTimestamp + ONE_MINUTE_MS, via CP3I's confirmingCandleAvailableAt(). */
  readonly correctedDecisionAvailableAt: number;
  readonly decisionAvailableAtChanged: boolean;
  readonly originalTimestampClass: TimestampClass;
  /**
   * Recomputed via the REAL classifyTimestamp()/buildEventLikeFromRow() — structurally cannot consume
   * the corrected decisionAvailableAt (neither function's Pick<> field list names that column), so this
   * recomputation exercises exactly the same inputs classifyTimestamp() always used. Any difference
   * here would mean the ledger's own persisted timestampClass disagreed with the real function to begin
   * with (a separate defect, unrelated to this candidate) — not an effect of the candidate itself.
   */
  readonly recomputedTimestampClass: TimestampClass;
  readonly timestampClassChanged: boolean;
  readonly flippedToClean: boolean;
}

/**
 * Applies the T3 candidate's formula to one fallback row and re-runs the real classification. Pure —
 * no I/O, never mutates the input row.
 */
export function recomputeRowUnderCandidate(row: ForensicTelemetryRow): PerRowCausalEffect {
  const correctedDecisionAvailableAt = confirmingCandleAvailableAt(row.decisionTimestamp);
  // buildEventLikeFromRow() never reads row.decisionAvailableAt (not in its Pick<> field list) — the
  // corrected value above is computed for reporting only; it cannot be fed into classifyTimestamp()
  // via this real adapter, which is itself the central finding this module exists to demonstrate.
  const event = buildEventLikeFromRow(row);
  const recomputedTimestampClass = classifyTimestamp(event);
  return {
    candidateKey: row.candidateKey,
    evaluationId: row.evaluationId,
    originalDecisionAvailableAt: row.decisionAvailableAt,
    correctedDecisionAvailableAt,
    decisionAvailableAtChanged: correctedDecisionAvailableAt !== row.decisionAvailableAt,
    originalTimestampClass: row.timestampClass,
    recomputedTimestampClass,
    timestampClassChanged: recomputedTimestampClass !== row.timestampClass,
    flippedToClean: row.timestampClass !== 'CLEAN' && recomputedTimestampClass === 'CLEAN',
  };
}

// ============================== Aggregate causal-effect summary ==============================

export interface CausalEffectSummary {
  readonly fallbackPopulation: number;
  readonly nonCleanBefore: number;
  readonly decisionAvailableAtChangedCount: number;
  readonly timestampClassChangedCount: number;
  readonly flippedToCleanCount: number;
  /** Identity-preservation proof: candidateKey set before vs. after recomputation, byte-identical. */
  readonly candidateKeySetUnchanged: boolean;
  /** Identity-preservation proof: evaluationId set before vs. after recomputation, byte-identical. */
  readonly evaluationIdSetUnchanged: boolean;
  readonly perRow: readonly PerRowCausalEffect[];
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Computes the full offline causal-effect summary over the fallback (FVG/SWEEP) population only —
 * derived exclusively via `filterFallbackRows()`, never the raw OB+fallback row array, so an OB row
 * can never leak into this candidate's own denominator.
 */
export function computeCausalEffect(rows: readonly ForensicTelemetryRow[]): CausalEffectSummary {
  const fallback = filterFallbackRows(rows);
  const perRow = fallback.map((r) => recomputeRowUnderCandidate(r));

  const nonCleanBefore = perRow.filter((r) => r.originalTimestampClass !== 'CLEAN').length;
  const decisionAvailableAtChangedCount = perRow.filter((r) => r.decisionAvailableAtChanged).length;
  const timestampClassChangedCount = perRow.filter((r) => r.timestampClassChanged).length;
  const flippedToCleanCount = perRow.filter((r) => r.flippedToClean).length;

  const originalCandidateKeys = new Set(fallback.map((r) => r.candidateKey));
  const recomputedCandidateKeys = new Set(perRow.map((r) => r.candidateKey));
  const originalEvaluationIds = new Set(fallback.map((r) => r.evaluationId));
  const recomputedEvaluationIds = new Set(perRow.map((r) => r.evaluationId));

  return {
    fallbackPopulation: fallback.length,
    nonCleanBefore,
    decisionAvailableAtChangedCount,
    timestampClassChangedCount,
    flippedToCleanCount,
    candidateKeySetUnchanged: setsEqual(originalCandidateKeys, recomputedCandidateKeys),
    evaluationIdSetUnchanged: setsEqual(originalEvaluationIds, recomputedEvaluationIds),
    perRow,
  };
}

// ============================== Registration artifact (hash freeze) ==============================

export interface Cp3jRegistrationArtifact {
  readonly ticket: 'TICKET-G6R-CP3J';
  readonly candidateId: typeof CP3J_CANDIDATE_ID;
  readonly createdAtUtc: string;
  readonly registrationDocumentPath: string;
  readonly registrationDocumentSha256: string;
  readonly analyzerSourceSha256: string;
  readonly forensicSchemaSourceSha256: string;
  readonly toolSourcePath: string;
  readonly toolSourceSha256: string;
  readonly ledgerCsvPath: string;
  readonly ledgerCsvSha256: string;
  readonly causalEffect: Omit<CausalEffectSummary, 'perRow'>;
  readonly causalEffectComputationCommand: string;
  readonly baselineProtection: {
    readonly appsBotSrcDiffStat: string;
    readonly g6rShadowAnalyzerUnchanged: boolean;
    readonly g6rCp3hForensicSchemaUnchanged: boolean;
  };
  readonly commitPushMergeDeployPerformed: false;
  readonly status: 'REGISTERED';
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function buildRegistrationArtifact(opts: {
  readonly repoRoot: string;
  readonly nowUtcIso: string;
  readonly appsBotSrcDiffStat: string;
}): Cp3jRegistrationArtifact {
  const ledgerCsvPath = 'data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv';
  const registrationDocumentPath = 'data/g6r-cp3j-candidate-registration.md';
  const toolSourcePath = 'apps/bot/scripts/g6rCp3jCandidateRegistration.ts';
  const analyzerSourcePath = 'apps/bot/scripts/g6rShadowAnalyzer.ts';
  const forensicSchemaSourcePath = 'apps/bot/scripts/g6rCp3hForensicSchema.ts';

  const ledgerCsvText = readFileSync(path.resolve(opts.repoRoot, ledgerCsvPath), 'utf8');
  const rows = parseForensicLedgerCsv(ledgerCsvText);
  const { perRow, ...causalEffectRest } = computeCausalEffect(rows);
  void perRow; // full per-row detail is available via computeCausalEffect() directly; the frozen artifact stores only the aggregate summary

  const analyzerSourceSha256 = sha256File(path.resolve(opts.repoRoot, analyzerSourcePath));
  const forensicSchemaSourceSha256 = sha256File(path.resolve(opts.repoRoot, forensicSchemaSourcePath));

  return {
    ticket: 'TICKET-G6R-CP3J',
    candidateId: CP3J_CANDIDATE_ID,
    createdAtUtc: opts.nowUtcIso,
    registrationDocumentPath,
    registrationDocumentSha256: sha256File(path.resolve(opts.repoRoot, registrationDocumentPath)),
    analyzerSourceSha256,
    forensicSchemaSourceSha256,
    toolSourcePath,
    toolSourceSha256: sha256File(path.resolve(opts.repoRoot, toolSourcePath)),
    ledgerCsvPath,
    ledgerCsvSha256: sha256File(path.resolve(opts.repoRoot, ledgerCsvPath)),
    causalEffect: causalEffectRest,
    causalEffectComputationCommand: 'npx tsx apps/bot/scripts/g6rCp3jCandidateRegistration.ts',
    baselineProtection: {
      appsBotSrcDiffStat: opts.appsBotSrcDiffStat,
      g6rShadowAnalyzerUnchanged: analyzerSourceSha256 === '7504cb0cc72340f4911d978cfbbe48c941e5137f0d94db02f02010a04fe980dc',
      g6rCp3hForensicSchemaUnchanged: forensicSchemaSourceSha256 === '3ab368a136a0310bfb2f695d0722feb2aa389dc3946fbfb3f5d790ccd9b9a30a',
    },
    commitPushMergeDeployPerformed: false,
    status: 'REGISTERED',
  };
}

// ============================== CLI entry point (I/O; not exercised by tests importing the pure functions above) ==============================

async function main(): Promise<void> {
  const REPO_ROOT = process.cwd();
  const ledgerCsvPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv');
  const ledgerCsvText = readFileSync(ledgerCsvPath, 'utf8');
  const rows = parseForensicLedgerCsv(ledgerCsvText);
  const summary = computeCausalEffect(rows);
  const { perRow, ...printable } = summary;
  void perRow;
  console.log(JSON.stringify(printable, null, 2));

  // If explicitly asked (WRITE_ARTIFACT=true), also freeze the full registration.json artifact. Kept
  // opt-in so a plain `npx tsx ...` run (used purely to print the causal-effect evidence, as quoted in
  // the registration .md) never has an I/O side effect on the frozen-artifact-in-progress file.
  if (process.env.WRITE_CP3J_ARTIFACT === 'true') {
    const outPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3j-registration.json');
    const artifact = buildRegistrationArtifact({
      repoRoot: REPO_ROOT,
      nowUtcIso: new Date().toISOString(),
      appsBotSrcDiffStat: process.env.CP3J_APPS_BOT_SRC_DIFF_STAT ?? '',
    });
    writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');
    console.log(`Wrote ${outPath}`);
  }
}

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
