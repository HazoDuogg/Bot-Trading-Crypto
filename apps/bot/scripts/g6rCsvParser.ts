/**
 * G6R Checkpoint 3 — small RFC4180-ish CSV parser.
 *
 * The repo's existing scripts (ticket088AnalyzeSlLosses.ts, ticket124GenerateReport.ts, etc.) all
 * parse CSV with naive `split(',')` / `JSON.parse`-per-cell, which breaks on quoted commas and is
 * silently lenient about malformed rows. No shared, quote-safe CSV utility exists anywhere in
 * apps/bot/scripts or apps/bot/src (checked: `grep -rn "parseCsv\|RFC4180"` — every hit is a local,
 * naive, per-script helper). This is a small, purpose-built replacement, not a general library.
 *
 * Behavior (required by TICKET-G6R-Correct-Shadow-Screening-and-Funnel-Protocol.md Step 7):
 *  - Header row required (empty input is an error).
 *  - Duplicate header names fail.
 *  - Quoted fields support embedded commas, embedded CRLF/LF, and doubled-quote ("") escaping.
 *  - CRLF and LF line endings both supported; a trailing newline at EOF is tolerated.
 *  - Malformed rows (wrong column count, unterminated quote) fail — never silently skipped.
 *  - Empty rows (a fully blank line) fail — never silently skipped, EXCEPT a single trailing blank
 *    line immediately before EOF, which is treated as "no trailing row" (standard CSV convention).
 */

export interface ParsedCsv {
  readonly header: readonly string[];
  /** Each row as a plain object keyed by header name, values as raw strings (no type coercion). */
  readonly rows: ReadonlyArray<Record<string, string>>;
}

export class CsvParseError extends Error {}

/** Splits raw CSV text into rows of raw string fields, honoring RFC4180 quoting. */
function tokenize(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  let sawAnyCharInRow = false;
  const n = text.length;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    sawAnyCharInRow = false;
  };

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (field.length !== 0) throw new CsvParseError(`Unexpected quote mid-field at offset ${i}`);
      inQuotes = true;
      sawAnyCharInRow = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      sawAnyCharInRow = true;
      i += 1;
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') {
        endRow();
        i += 2;
        continue;
      }
      endRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    sawAnyCharInRow = true;
    i += 1;
  }
  if (inQuotes) throw new CsvParseError('Unterminated quoted field at end of input');
  if (sawAnyCharInRow || field.length > 0) endRow();
  return rows;
}

export function parseCsv(text: string): ParsedCsv {
  if (text.trim().length === 0) throw new CsvParseError('CSV input is empty — header row required');
  const tokenized = tokenize(text);
  if (tokenized.length === 0) throw new CsvParseError('CSV input produced no rows — header row required');

  const header = tokenized[0];
  const seen = new Set<string>();
  for (const h of header) {
    if (seen.has(h)) throw new CsvParseError(`Duplicate header column name: ${h}`);
    seen.add(h);
  }

  const rows: Record<string, string>[] = [];
  for (let r = 1; r < tokenized.length; r++) {
    const raw = tokenized[r];
    // A single fully-blank trailing line right before EOF (one empty field, i.e. the row produced
    // by a trailing newline) is tolerated; any other blank/malformed row is a hard failure.
    if (raw.length === 1 && raw[0] === '' && r === tokenized.length - 1) continue;
    if (raw.length !== header.length) {
      throw new CsvParseError(`Row ${r + 1}: expected ${header.length} columns, got ${raw.length}`);
    }
    if (raw.every((v) => v === '')) throw new CsvParseError(`Row ${r + 1}: fully empty row is malformed, not silently skipped`);
    const obj: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) obj[header[c]] = raw[c];
    rows.push(obj);
  }
  return { header, rows };
}

/**
 * TICKET-G6R-CP3H (Step 2 / ticket Section G): RFC4180-ish writer, the round-trip counterpart of
 * `parseCsv()` above. A field is quoted whenever it contains a comma, quote, or CR/LF; embedded
 * quotes are doubled. Never quotes unnecessarily so plain numeric/enum cells stay human-readable.
 * `writeCsv(parseCsv(writeCsv(rows)).rows) === rows` is the round-trip invariant asserted in tests.
 */
export function csvEscapeField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Writes rows (each a plain string-valued object) to RFC4180-ish CSV text using `header` as the
 * column order. Every row MUST have exactly the same keys as `header` (fails closed — no silent
 * column drop/reorder). Values are already-stringified by the caller (this writer does no type
 * coercion, mirroring parseCsv's "no type coercion" contract) so the caller controls exactly how
 * null/enum/number values are rendered (e.g. explicit "null" strings, never `undefined`).
 */
export function writeCsv(header: readonly string[], rows: ReadonlyArray<Record<string, string>>): string {
  const seen = new Set<string>();
  for (const h of header) {
    if (seen.has(h)) throw new CsvParseError(`Duplicate header column name: ${h}`);
    seen.add(h);
  }
  const lines: string[] = [header.map(csvEscapeField).join(',')];
  rows.forEach((row, i) => {
    const rowKeys = Object.keys(row);
    if (rowKeys.length !== header.length || !header.every((h) => h in row)) {
      throw new CsvParseError(`Row ${i}: keys ${JSON.stringify(rowKeys)} do not match header ${JSON.stringify(header)}`);
    }
    lines.push(header.map((h) => csvEscapeField(row[h])).join(','));
  });
  return lines.join('\r\n') + '\r\n';
}

const EVALUATION_ID_PATTERN = /^[^|]+\|-?\d+\|[^|]+\|\d+$/;

/** Validates evaluationId column values against the documented schema symbol|evaluationTimestamp|regime|routeInvocationOrdinal. */
export function validateEvaluationIdSchema(value: string): boolean {
  return EVALUATION_ID_PATTERN.test(value);
}

/**
 * Parses a CP2-style ledger CSV and validates the evaluationId column against schema + requires
 * the column to exist. Fails closed (throws) rather than silently producing a partial result.
 */
export function parseLedgerCsvRequiringEvaluationId(text: string): ParsedCsv {
  const parsed = parseCsv(text);
  if (!parsed.header.includes('evaluationId')) throw new CsvParseError('Missing required column: evaluationId');
  for (let i = 0; i < parsed.rows.length; i++) {
    const value = parsed.rows[i].evaluationId;
    if (!validateEvaluationIdSchema(value)) {
      throw new CsvParseError(`Row ${i + 2}: evaluationId "${value}" does not match schema symbol|evaluationTimestamp|regime|routeInvocationOrdinal`);
    }
  }
  return parsed;
}
