/**
 * TICKET-G6R-CP3F Fix 1 — pure, replay-independent error-message categorization.
 *
 * Extracted from g6rCheckpoint3Replay.ts so it can be unit-tested without ever
 * spawning a replay. Each schema-validator error message is routed to EXACTLY
 * ONE category. Geometry messages ('LONG requires slPrice < entryPrice',
 * 'SHORT requires slPrice > entryPrice', 'entryPrice/slPrice/slDistance must
 * all be finite', 'slDistance !== abs(entryPrice - slPrice)') previously fell
 * through to the default 'requiredField' bucket and were ALSO counted
 * separately via ledgerValidation.invalidGeometryCount, double-counting the
 * same 31 rows under two different field names. This module routes geometry
 * messages to their own category (a no-op here — geometryErrors' single
 * source of truth remains ledgerValidation.invalidGeometryCount in the
 * runner) so they are never miscounted as requiredFieldErrors.
 */

export type SchemaErrorCategory =
  | 'setupType'
  | 'hash'
  | 'timestamp'
  | 'coverage'
  | 'duplicate'
  | 'join'
  | 'geometry'
  | 'requiredField';

/** Categorize a single schema-validator error message. Pure, no I/O, no replay dependency. */
export function categorizeSchemaErrorMessage(msg: string): SchemaErrorCategory {
  if (msg.includes('setupType')) return 'setupType';
  // Case-insensitive: real messages include both 'registrationDocumentSha256 mismatch' and
  // 'analyzerSourceHash mismatch' (capital H, no literal 'Sha256' substring in the latter).
  if (/sha256|hash/i.test(msg)) return 'hash';
  if (msg.includes('imestamp') || msg.includes('5min')) return 'timestamp';
  if (msg.includes('requiredDataCoverage')) return 'coverage';
  if (msg.includes('duplicate candidateKey') || msg.includes('more than one candidate')) return 'duplicate';
  if (msg.includes('CP2 join')) return 'join';
  if (msg.includes('slPrice') || msg.includes('slDistance')) return 'geometry';
  return 'requiredField';
}

export interface SchemaErrorTaxonomyCounts {
  requiredFieldErrors: number;
  hashErrors: number;
  timestampOrderingErrors: number;
  setupTypeErrors: number;
  coverageErrors: number;
  duplicateMessagesFoundInSchemaErrors: number;
  joinMessagesFoundInSchemaErrors: number;
  /**
   * Geometry messages found in schema-validator row errors. This is diagnostic
   * only — the runner's authoritative geometryErrors count comes from
   * ledgerValidation.invalidGeometryCount (a single, separate source of
   * truth) to avoid double-counting the same rows from two code paths.
   */
  geometryMessagesFoundInSchemaErrors: number;
}

/**
 * Categorize every message across every row's error list. Mutually exclusive
 * buckets: the sum of all returned counts equals the total number of input
 * messages exactly once each (no message is counted in more than one
 * category, and none is silently dropped).
 */
export function categorizeSchemaErrors(rowErrorLists: readonly (readonly string[])[]): SchemaErrorTaxonomyCounts {
  const counts: SchemaErrorTaxonomyCounts = {
    requiredFieldErrors: 0,
    hashErrors: 0,
    timestampOrderingErrors: 0,
    setupTypeErrors: 0,
    coverageErrors: 0,
    duplicateMessagesFoundInSchemaErrors: 0,
    joinMessagesFoundInSchemaErrors: 0,
    geometryMessagesFoundInSchemaErrors: 0,
  };
  for (const errs of rowErrorLists) {
    for (const msg of errs) {
      const category = categorizeSchemaErrorMessage(msg);
      switch (category) {
        case 'setupType':
          counts.setupTypeErrors++;
          break;
        case 'hash':
          counts.hashErrors++;
          break;
        case 'timestamp':
          counts.timestampOrderingErrors++;
          break;
        case 'coverage':
          counts.coverageErrors++;
          break;
        case 'duplicate':
          counts.duplicateMessagesFoundInSchemaErrors++;
          break;
        case 'join':
          // Retained as diagnostic message counts. The runner still uses its
          // authoritative aggregate sources and does not sum these again.
          counts.joinMessagesFoundInSchemaErrors++;
          break;
        case 'geometry':
          // Counted separately via ledgerValidation.invalidGeometryCount — intentionally
          // not added to requiredFieldErrors (the historical bug) nor summed again here.
          counts.geometryMessagesFoundInSchemaErrors++;
          break;
        case 'requiredField':
          counts.requiredFieldErrors++;
          break;
      }
    }
  }
  return counts;
}
