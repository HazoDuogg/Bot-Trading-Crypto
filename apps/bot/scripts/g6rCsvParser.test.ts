import { describe, expect, it } from 'vitest';
import { parseCsv, parseLedgerCsvRequiringEvaluationId, validateEvaluationIdSchema, CsvParseError } from './g6rCsvParser.js';

describe('parseCsv (Step 7, RFC4180-ish)', () => {
  it('parses a simple header + rows', () => {
    const { header, rows } = parseCsv('a,b,c\n1,2,3\n4,5,6\n');
    expect(header).toEqual(['a', 'b', 'c']);
    expect(rows).toEqual([
      { a: '1', b: '2', c: '3' },
      { a: '4', b: '5', c: '6' },
    ]);
  });

  it('handles a quoted comma before evaluationId (quoted-comma case)', () => {
    const text = 'note,evaluationId,x\n"hello, world","BTCUSDT|100|TREND_RIDER|0",5\n';
    const { rows } = parseCsv(text);
    expect(rows[0].note).toBe('hello, world');
    expect(rows[0].evaluationId).toBe('BTCUSDT|100|TREND_RIDER|0');
  });

  it('handles CRLF line endings', () => {
    const { rows } = parseCsv('a,b\r\n1,2\r\n3,4\r\n');
    expect(rows).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }]);
  });

  it('handles doubled-quote escaping inside a quoted field', () => {
    const { rows } = parseCsv('a\n"she said ""hi"""\n');
    expect(rows[0].a).toBe('she said "hi"');
  });

  it('handles a quoted field containing an embedded newline', () => {
    const { rows } = parseCsv('a,b\n"line1\nline2",x\n');
    expect(rows[0].a).toBe('line1\nline2');
    expect(rows[0].b).toBe('x');
  });

  it('fails on empty input', () => {
    expect(() => parseCsv('')).toThrow(CsvParseError);
  });

  it('fails on duplicate header names', () => {
    expect(() => parseCsv('a,a,b\n1,2,3\n')).toThrow(CsvParseError);
  });

  it('fails on a malformed row (wrong column count)', () => {
    expect(() => parseCsv('a,b,c\n1,2\n')).toThrow(CsvParseError);
  });

  it('fails on a fully empty row (not silently skipped)', () => {
    expect(() => parseCsv('a,b\n1,2\n,\n3,4\n')).toThrow(CsvParseError);
  });

  it('tolerates a single trailing blank line at EOF', () => {
    const { rows } = parseCsv('a,b\n1,2\n');
    expect(rows.length).toBe(1);
  });
});

describe('validateEvaluationIdSchema', () => {
  it('accepts symbol|evaluationTimestamp|regime|routeInvocationOrdinal', () => {
    expect(validateEvaluationIdSchema('BTCUSDT|1770772200000|NEUTRAL_TRANSITION|0')).toBe(true);
  });
  it('rejects malformed values', () => {
    expect(validateEvaluationIdSchema('not-an-eval-id')).toBe(false);
    expect(validateEvaluationIdSchema('BTCUSDT|abc|REGIME|0')).toBe(false);
    expect(validateEvaluationIdSchema('BTCUSDT|100|REGIME')).toBe(false);
  });
});

describe('parseLedgerCsvRequiringEvaluationId', () => {
  it('fails when evaluationId column is missing', () => {
    expect(() => parseLedgerCsvRequiringEvaluationId('a,b\n1,2\n')).toThrow(CsvParseError);
  });

  it('fails when an evaluationId value does not match schema', () => {
    expect(() => parseLedgerCsvRequiringEvaluationId('evaluationId,x\nnot-valid,5\n')).toThrow(CsvParseError);
  });

  it('parses valid CP2-style rows', () => {
    const text = 'evaluationId,symbol\n"BTCUSDT|100|TREND_RIDER|0","BTCUSDT"\n';
    const parsed = parseLedgerCsvRequiringEvaluationId(text);
    expect(parsed.rows.length).toBe(1);
  });
});
