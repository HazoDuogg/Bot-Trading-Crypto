import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateTelemetryDataset, findJsonlFiles, formatTelemetryValidationReport } from './liveTelemetryValidator.js';

function writeJsonlFile(dir: string, fileName: string, lines: string[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), lines.join('\n') + '\n', 'utf8');
}

function baseFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    eventId: `e-${Math.random().toString(36).slice(2)}`,
    traceId: 'trace-1',
    sessionId: 'session-1',
    strategyVersion: 'v1',
    configHash: 'hash1',
    modelVersion: 'm1',
    symbol: 'BTCUSDT',
    side: 'LONG',
    setupType: 'OB',
    eventType: 'CANDIDATE_CREATED',
    eventTimestampUtc: '2026-06-01T00:00:00.000Z',
    recordedTimestampUtc: '2026-06-01T00:00:00.000Z',
    source: 'LIVE_RUNNER',
    quality: {},
    data: {},
    ...overrides,
  };
}

function fullTradeLines(traceId: string, opts: { withFill?: boolean; withSl?: boolean; withClose?: boolean; withReconciliation?: boolean } = {}): string[] {
  const { withFill = true, withSl = true, withClose = true, withReconciliation = true } = opts;
  const t = (offsetMs: number) => new Date(Date.parse('2026-06-01T00:00:00.000Z') + offsetMs).toISOString();
  const lines: Array<Record<string, unknown>> = [
    baseFields({ eventId: `${traceId}-1`, traceId, eventType: 'CANDIDATE_CREATED', recordedTimestampUtc: t(0), eventTimestampUtc: t(0), quality: { entryProposal: 'DERIVED' }, data: { regime: 'TREND_RIDER' } }),
    baseFields({ eventId: `${traceId}-2`, traceId, eventType: 'DECISION_MADE', recordedTimestampUtc: t(10), eventTimestampUtc: t(10), quality: { decision: 'DERIVED' }, data: { decision: 'ALLOW' } }),
    baseFields({ eventId: `${traceId}-3`, traceId, eventType: 'RISK_ADMISSION', recordedTimestampUtc: t(20), eventTimestampUtc: t(20), quality: { balance: 'OBSERVED' }, data: { admission: 'ALLOW' } }),
    baseFields({ eventId: `${traceId}-4`, traceId, eventType: 'ORDER_SUBMIT_INTENT', recordedTimestampUtc: t(30), eventTimestampUtc: t(30), quality: { requestedQuantity: 'DERIVED' }, data: {} }),
    baseFields({ eventId: `${traceId}-5`, traceId, eventType: 'ORDER_SENT', recordedTimestampUtc: t(40), eventTimestampUtc: t(40), quality: { localSendTimestamp: 'OBSERVED' }, data: {} }),
    baseFields({ eventId: `${traceId}-6`, traceId, eventType: 'EXCHANGE_ACK', recordedTimestampUtc: t(50), eventTimestampUtc: t(50), quality: { exchangeOrderId: 'OBSERVED' }, data: {} }),
  ];
  if (withFill) lines.push(baseFields({ eventId: `${traceId}-7`, traceId, eventType: 'FILL_COMPLETE', recordedTimestampUtc: t(60), eventTimestampUtc: t(60), quality: { fillQuantity: 'OBSERVED' }, data: {} }));
  if (withSl) lines.push(baseFields({ eventId: `${traceId}-8`, traceId, eventType: 'ORDER_SENT', recordedTimestampUtc: t(70), eventTimestampUtc: t(70), quality: { role: 'OBSERVED' }, data: { role: 'PROTECTIVE_SL', algoId: 501 } }));
  if (withClose) lines.push(baseFields({ eventId: `${traceId}-9`, traceId, eventType: 'TRADE_CLOSED', recordedTimestampUtc: t(80), eventTimestampUtc: t(80), quality: { pnl: 'MODELED' }, data: { modeledNetPnl: 6, exitReason: 'TP2' } }));
  if (withReconciliation) lines.push(baseFields({ eventId: `${traceId}-10`, traceId, eventType: 'POSITION_RECONCILED', recordedTimestampUtc: t(90), eventTimestampUtc: t(90), quality: { realizedPnl: 'OBSERVED', commission: 'OBSERVED', funding: 'OBSERVED' }, data: { realizedPnl: 6.1, commission: -0.5, funding: -0.05 } }));
  return lines.map((l) => JSON.stringify(l));
}

function rejectedTraceLines(traceId: string): string[] {
  const t = (offsetMs: number) => new Date(Date.parse('2026-06-01T00:00:00.000Z') + offsetMs).toISOString();
  const lines: Array<Record<string, unknown>> = [
    baseFields({ eventId: `${traceId}-1`, traceId, eventType: 'CANDIDATE_CREATED', recordedTimestampUtc: t(0), eventTimestampUtc: t(0), quality: { entryProposal: 'DERIVED' }, data: { regime: 'TREND_RIDER' } }),
    baseFields({ eventId: `${traceId}-2`, traceId, eventType: 'DECISION_MADE', recordedTimestampUtc: t(10), eventTimestampUtc: t(10), quality: {}, data: {} }),
    baseFields({ eventId: `${traceId}-3`, traceId, eventType: 'RISK_ADMISSION', recordedTimestampUtc: t(20), eventTimestampUtc: t(20), quality: {}, data: {} }),
    baseFields({ eventId: `${traceId}-4`, traceId, eventType: 'ORDER_SUBMIT_INTENT', recordedTimestampUtc: t(30), eventTimestampUtc: t(30), quality: {}, data: {} }),
    baseFields({ eventId: `${traceId}-5`, traceId, eventType: 'ORDER_SENT', recordedTimestampUtc: t(40), eventTimestampUtc: t(40), quality: {}, data: {} }),
    baseFields({ eventId: `${traceId}-6`, traceId, eventType: 'EXCHANGE_REJECT', recordedTimestampUtc: t(50), eventTimestampUtc: t(50), quality: { error: 'OBSERVED' }, data: { sanitizedErrorCode: 'CONFIRMED_NOT_FILLED' } }),
  ];
  return lines.map((l) => JSON.stringify(l));
}

function healthLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(baseFields({ eventId: 'health-1', traceId: 'health', eventType: 'TELEMETRY_HEALTH', quality: { counters: 'OBSERVED' }, data: { enqueued: 10, written: 10, dropped: 0, invalid: 0, writeFailures: 0, ...overrides } }));
}

describe('TICKET-LIVE-R5T requirement 6 — liveTelemetryValidator', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-validator-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('findJsonlFiles walks day-directories recursively and returns only .jsonl files', () => {
    writeJsonlFile(path.join(tmpDir, '2026-06-01'), 'a.jsonl', ['{}']);
    writeJsonlFile(path.join(tmpDir, '2026-06-02'), 'b.jsonl', ['{}']);
    fs.writeFileSync(path.join(tmpDir, 'not-jsonl.txt'), 'ignore me');
    const files = findJsonlFiles(tmpDir);
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith('.jsonl'))).toBe(true);
  });

  it('a clean dataset (one closed trade fully reconciled, one cleanly rejected trade, healthy TELEMETRY_HEALTH) passes with ok=true and exit-worthy report', () => {
    const dayDir = path.join(tmpDir, '2026-06-01');
    writeJsonlFile(dayDir, 'session-a.jsonl', [...fullTradeLines('trace-closed-1'), ...rejectedTraceLines('trace-rejected-1'), healthLine()]);
    const report = validateTelemetryDataset(tmpDir);
    expect(report.parseErrors).toEqual([]);
    expect(report.schemaErrors).toEqual([]);
    expect(report.duplicateEventIds).toEqual([]);
    expect(report.brokenTraces).toEqual([]);
    expect(report.missingTerminalTraces).toEqual([]);
    expect(report.tradeGaps).toEqual([]);
    expect(report.healthFailures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.aggregateCounts.bySymbol.BTCUSDT).toBe(1);
    expect(report.aggregateCounts.bySetupType.OB).toBe(1);
    expect(report.aggregateCounts.byRegime.TREND_RIDER).toBe(1);
    expect(report.pnlComparisons).toHaveLength(1);
    expect(report.pnlComparisons[0].diff).toBeCloseTo(0.1, 6);
    expect(report.commissionFundingTotals.totalCommission).toBeCloseTo(-0.5, 6);
    expect(report.commissionFundingTotals.totalFunding).toBeCloseTo(-0.05, 6);
    const formatted = formatTelemetryValidationReport(report);
    expect(formatted).toContain('LIVE_TELEMETRY_VALIDATOR_OK');
  });

  it('a malformed JSON line fails with a parse error and ok=false', () => {
    const dayDir = path.join(tmpDir, '2026-06-01');
    writeJsonlFile(dayDir, 'session-a.jsonl', ['{not valid json', ...fullTradeLines('trace-closed-1')]);
    const report = validateTelemetryDataset(tmpDir);
    expect(report.parseErrors.length).toBe(1);
    expect(report.ok).toBe(false);
  });

  it('a line missing a required field fails schema validation and ok=false', () => {
    const dayDir = path.join(tmpDir, '2026-06-01');
    const bad = JSON.stringify(baseFields({ symbol: '' }));
    writeJsonlFile(dayDir, 'session-a.jsonl', [bad]);
    const report = validateTelemetryDataset(tmpDir);
    expect(report.schemaErrors.length).toBe(1);
    expect(report.schemaErrors[0].errors).toContain('missing:symbol');
    expect(report.ok).toBe(false);
  });

  it('a duplicate eventId across two lines is detected and ok=false', () => {
    const dayDir = path.join(tmpDir, '2026-06-01');
    const shared = JSON.stringify(baseFields({ eventId: 'dupe-1' }));
    writeJsonlFile(dayDir, 'session-a.jsonl', [shared, shared]);
    const report = validateTelemetryDataset(tmpDir);
    expect(report.duplicateEventIds).toHaveLength(1);
    expect(report.duplicateEventIds[0].eventId).toBe('dupe-1');
    expect(report.duplicateEventIds[0].count).toBe(2);
    expect(report.ok).toBe(false);
  });

  it('a fill without the pre-fill stage chain (missing DECISION_MADE) is a broken trace and ok=false', () => {
    const dayDir = path.join(tmpDir, '2026-06-01');
    const lines = fullTradeLines('trace-broken-1').filter((l) => !JSON.parse(l).eventType.includes('DECISION_MADE'));
    writeJsonlFile(dayDir, 'session-a.jsonl', lines);
    const report = validateTelemetryDataset(tmpDir);
    expect(report.brokenTraces.length).toBeGreaterThan(0);
    expect(report.brokenTraces[0].reason).toContain('DECISION_MADE');
    expect(report.ok).toBe(false);
  });

  it('events written out of timestamp order are a broken trace and ok=false', () => {
    const dayDir = path.join(tmpDir, '2026-06-01');
    const lines = fullTradeLines('trace-order-1');
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    first.recordedTimestampUtc = '2026-06-01T00:00:02.000Z';
    second.recordedTimestampUtc = '2026-06-01T00:00:01.000Z';
    lines[0] = JSON.stringify(first);
    lines[1] = JSON.stringify(second);
    writeJsonlFile(dayDir, 'session-a.jsonl', lines);
    const report = validateTelemetryDataset(tmpDir);
    expect(report.brokenTraces.some((entry) => entry.reason.includes('not monotonically'))).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('a trace that never reaches a terminal event (open-ended, no close/reject/cancel/expire) is flagged missing-terminal and ok=false', () => {
    const dayDir = path.join(tmpDir, '2026-06-01');
    const t = (offsetMs: number) => new Date(Date.parse('2026-06-01T00:00:00.000Z') + offsetMs).toISOString();
    const lines = [
      JSON.stringify(baseFields({ eventId: 'no-term-1', traceId: 'trace-no-terminal', eventType: 'CANDIDATE_CREATED', recordedTimestampUtc: t(0) })),
      JSON.stringify(baseFields({ eventId: 'no-term-2', traceId: 'trace-no-terminal', eventType: 'DECISION_MADE', recordedTimestampUtc: t(10) })),
    ];
    writeJsonlFile(dayDir, 'session-a.jsonl', lines);
    const report = validateTelemetryDataset(tmpDir);
    expect(report.missingTerminalTraces).toHaveLength(1);
    expect(report.missingTerminalTraces[0].traceId).toBe('trace-no-terminal');
    expect(report.ok).toBe(false);
  });

  it('a closed trade missing its fill event and its SL event is reported as a trade gap and ok=false', () => {
    const dayDir = path.join(tmpDir, '2026-06-01');
    const lines = fullTradeLines('trace-gap-1', { withFill: false, withSl: false });
    writeJsonlFile(dayDir, 'session-a.jsonl', lines);
    const report = validateTelemetryDataset(tmpDir);
    expect(report.tradeGaps).toHaveLength(1);
    expect(report.tradeGaps[0].missingFill).toBe(true);
    expect(report.tradeGaps[0].missingSl).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('a TELEMETRY_HEALTH event reporting nonzero dropped/invalid/writeFailures is a health failure and ok=false', () => {
    const dayDir = path.join(tmpDir, '2026-06-01');
    writeJsonlFile(dayDir, 'session-a.jsonl', [...fullTradeLines('trace-closed-1'), healthLine({ dropped: 3 })]);
    const report = validateTelemetryDataset(tmpDir);
    expect(report.healthFailures).toHaveLength(1);
    expect(report.ok).toBe(false);
  });

  it('collects every MISSING/AMBIGUOUS/INVALID-quality field across the dataset without fabricating values', () => {
    const dayDir = path.join(tmpDir, '2026-06-01');
    const line = JSON.stringify(baseFields({ eventType: 'MARKET_SNAPSHOT', quality: { bestBid: 'MISSING', bestAsk: 'MISSING' }, data: { bestBid: 'MISSING', bestAsk: 'MISSING' } }));
    writeJsonlFile(dayDir, 'session-a.jsonl', [line]);
    const report = validateTelemetryDataset(tmpDir);
    expect(report.missingOrAmbiguousFields.length).toBe(2);
    expect(report.missingOrAmbiguousFields.every((f) => f.quality === 'MISSING')).toBe(true);
  });

  it('an empty root directory fails closed because no live evidence exists', () => {
    const report = validateTelemetryDataset(tmpDir);
    expect(report.filesScanned).toBe(0);
    expect(report.eventsParsed).toBe(0);
    expect(report.ok).toBe(false);
  });
});
