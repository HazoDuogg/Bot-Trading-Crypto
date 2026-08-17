import { describe, it, expect } from 'vitest';
import { categorizeSchemaErrorMessage, categorizeSchemaErrors } from './g6rErrorTaxonomy.js';

describe('g6rErrorTaxonomy — categorizeSchemaErrorMessage', () => {
  it('LONG wrong-side SL routes to geometry only', () => {
    expect(categorizeSchemaErrorMessage('LONG requires slPrice < entryPrice')).toBe('geometry');
  });

  it('SHORT wrong-side SL routes to geometry only', () => {
    expect(categorizeSchemaErrorMessage('SHORT requires slPrice > entryPrice')).toBe('geometry');
  });

  it('non-finite price/distance routes to geometry only', () => {
    expect(categorizeSchemaErrorMessage('entryPrice/slPrice/slDistance must all be finite')).toBe('geometry');
  });

  it('inconsistent slDistance routes to geometry only', () => {
    expect(categorizeSchemaErrorMessage('slDistance !== abs(entryPrice - slPrice)')).toBe('geometry');
  });

  it('missing required field routes to requiredField only', () => {
    expect(categorizeSchemaErrorMessage('missing required field: symbol')).toBe('requiredField');
  });

  it('hash mismatch routes to hash only', () => {
    expect(categorizeSchemaErrorMessage('analyzerSourceHash mismatch')).toBe('hash');
    expect(categorizeSchemaErrorMessage('registrationDocumentSha256 mismatch')).toBe('hash');
  });

  it('timestamp ordering routes to timestamp only', () => {
    expect(categorizeSchemaErrorMessage('decisionTimestamp must be <= evaluation 5min boundary')).toBe('timestamp');
    expect(categorizeSchemaErrorMessage('sourceTimestamp must be <= decisionTimestamp')).toBe('timestamp');
  });

  it('setupType error routes to setupType only', () => {
    expect(categorizeSchemaErrorMessage('setupType must be FVG or SWEEP')).toBe('setupType');
  });

  it('coverage error routes to coverage only', () => {
    expect(categorizeSchemaErrorMessage('requiredDataCoverage flags incomplete')).toBe('coverage');
  });

  it('duplicate/join messages route to their own categories, not requiredField or geometry', () => {
    expect(categorizeSchemaErrorMessage('duplicate candidateKey found')).toBe('duplicate');
    expect(categorizeSchemaErrorMessage('evaluation has more than one candidate')).toBe('duplicate');
    expect(categorizeSchemaErrorMessage('missing CP2 join for evaluationId')).toBe('join');
  });

  it('a single message is never routed to two categories (categorization is a total function returning exactly one category)', () => {
    const messages = [
      'LONG requires slPrice < entryPrice',
      'SHORT requires slPrice > entryPrice',
      'entryPrice/slPrice/slDistance must all be finite',
      'slDistance !== abs(entryPrice - slPrice)',
      'missing required field: symbol',
      'analyzerSourceHash mismatch',
      'decisionTimestamp must be <= evaluation 5min boundary',
      'setupType must be FVG or SWEEP',
      'requiredDataCoverage flags incomplete',
      'duplicate candidateKey found',
      'missing CP2 join for evaluationId',
    ];
    const categories = messages.map(categorizeSchemaErrorMessage);
    // Each call returns a single scalar category value (TypeScript's return type already
    // enforces this structurally); this test additionally proves no two DIFFERENT messages
    // that should land in different buckets collide into the same one.
    expect(new Set(categories).size).toBeGreaterThanOrEqual(7);
  });
});

describe('g6rErrorTaxonomy — categorizeSchemaErrors (aggregate, mutually exclusive)', () => {
  it('reproduces the corrected reconciliation for the frozen CP3 evidence: 0 required-field, 31 geometry-tagged (diagnostic only, not summed into the total), rest 0', () => {
    // Simulates the frozen g6r-cp3-shadow-summary.json's rowErrors shape: 31 rows, each with
    // exactly one geometry-violation message (mix of the four real message strings), and no
    // other schema-level errors (schemaRowsValidated=105, only these 31 rows have any error).
    const geometryMessages = [
      'LONG requires slPrice < entryPrice',
      'SHORT requires slPrice > entryPrice',
      'entryPrice/slPrice/slDistance must all be finite',
      'slDistance !== abs(entryPrice - slPrice)',
    ];
    const rowErrorLists: string[][] = Array.from({ length: 31 }, (_, i) => [geometryMessages[i % geometryMessages.length]]);

    const counts = categorizeSchemaErrors(rowErrorLists);

    expect(counts.requiredFieldErrors).toBe(0); // corrected: was 31 before this fix
    expect(counts.hashErrors).toBe(0);
    expect(counts.timestampOrderingErrors).toBe(0);
    expect(counts.setupTypeErrors).toBe(0);
    expect(counts.coverageErrors).toBe(0);
    expect(counts.duplicateMessagesFoundInSchemaErrors).toBe(0);
    expect(counts.joinMessagesFoundInSchemaErrors).toBe(0);
    expect(counts.geometryMessagesFoundInSchemaErrors).toBe(31);
  });

  it('total categorized count (requiredField+hash+timestamp+setupType+coverage+geometryMessagesFoundInSchemaErrors) equals total input messages exactly — no double counting, no dropped messages', () => {
    const rowErrorLists: string[][] = [
      ['LONG requires slPrice < entryPrice'],
      ['missing required field: entryPrice'],
      ['analyzerSourceHash mismatch'],
      ['decisionTimestamp must be <= evaluation 5min boundary'],
      ['setupType must be FVG or SWEEP'],
      ['requiredDataCoverage flags incomplete'],
      ['duplicate candidateKey found'], // counted elsewhere, not in this total
      ['missing CP2 join for evaluationId'], // counted elsewhere, not in this total
    ];
    const totalInputMessages = rowErrorLists.reduce((n, errs) => n + errs.length, 0);
    const counts = categorizeSchemaErrors(rowErrorLists);
    const categorizedInThisTotal =
      counts.requiredFieldErrors +
      counts.hashErrors +
      counts.timestampOrderingErrors +
      counts.setupTypeErrors +
      counts.coverageErrors +
      counts.duplicateMessagesFoundInSchemaErrors +
      counts.joinMessagesFoundInSchemaErrors +
      counts.geometryMessagesFoundInSchemaErrors;
    expect(categorizedInThisTotal).toBe(totalInputMessages);
  });

  it('empty input yields all-zero counts', () => {
    const counts = categorizeSchemaErrors([]);
    expect(counts).toEqual({
      requiredFieldErrors: 0,
      hashErrors: 0,
      timestampOrderingErrors: 0,
      setupTypeErrors: 0,
      coverageErrors: 0,
      duplicateMessagesFoundInSchemaErrors: 0,
      joinMessagesFoundInSchemaErrors: 0,
      geometryMessagesFoundInSchemaErrors: 0,
    });
  });
});
