import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTelemetryEvent, type ExecutionTelemetryEvent } from '../dist/live/executionTelemetry.js';

export interface LineParseError {
  file: string;
  lineNumber: number;
  raw: string;
  error: string;
}

export interface SchemaError {
  file: string;
  lineNumber: number;
  eventId: string | null;
  errors: string[];
}

export interface DuplicateEventId {
  eventId: string;
  count: number;
  files: string[];
}

export interface BrokenTraceLifecycle {
  traceId: string;
  reason: string;
}

export interface MissingTerminalTrace {
  traceId: string;
  lastEventType: string;
}

export interface TradeGapReport {
  traceId: string;
  missingFill: boolean;
  missingSl: boolean;
  missingClose: boolean;
}

export interface TelemetryHealthFailure {
  traceId: string;
  eventId: string;
  detail: string;
}

export interface MissingOrAmbiguousField {
  traceId: string;
  eventType: string;
  eventId: string;
  field: string;
  quality: string;
}

export interface AggregateCounts {
  bySymbol: Record<string, number>;
  bySetupType: Record<string, number>;
  byRegime: Record<string, number>;
}

export interface PnlComparison {
  traceId: string;
  modeledPnl: number;
  observedPnl: number;
  diff: number;
}

export interface CommissionFundingTotals {
  totalCommission: number;
  totalFunding: number;
  observedTradeCount: number;
}

export interface TelemetryValidationReport {
  filesScanned: number;
  eventsParsed: number;
  parseErrors: LineParseError[];
  schemaErrors: SchemaError[];
  duplicateEventIds: DuplicateEventId[];
  brokenTraces: BrokenTraceLifecycle[];
  missingTerminalTraces: MissingTerminalTrace[];
  tradeGaps: TradeGapReport[];
  healthFailures: TelemetryHealthFailure[];
  missingOrAmbiguousFields: MissingOrAmbiguousField[];
  aggregateCounts: AggregateCounts;
  pnlComparisons: PnlComparison[];
  commissionFundingTotals: CommissionFundingTotals;
  ok: boolean;
}

const PRE_FILL_REQUIRED_STAGES = ['CANDIDATE_CREATED', 'DECISION_MADE', 'RISK_ADMISSION', 'ORDER_SUBMIT_INTENT', 'ORDER_SENT', 'EXCHANGE_ACK'];
const TERMINAL_EVENT_TYPES = new Set(['TRADE_CLOSED', 'EXCHANGE_REJECT', 'ORDER_CANCELLED', 'ORDER_EXPIRED']);
const FILL_EVENT_TYPES = new Set(['FILL_PARTIAL', 'FILL_COMPLETE']);

export function findJsonlFiles(rootDir: string): string[] {
  const results: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (name.endsWith('.jsonl')) results.push(full);
    }
  };
  walk(rootDir);
  return results.sort();
}

export function validateTelemetryDataset(rootDir: string): TelemetryValidationReport {
  const files = findJsonlFiles(rootDir);
  const parseErrors: LineParseError[] = [];
  const schemaErrors: SchemaError[] = [];
  const eventIdOccurrences = new Map<string, string[]>();
  const eventsByTraceId = new Map<string, ExecutionTelemetryEvent[]>();
  const healthFailures: TelemetryHealthFailure[] = [];
  const missingOrAmbiguousFields: MissingOrAmbiguousField[] = [];
  let eventsParsed = 0;

  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (raw.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        parseErrors.push({ file, lineNumber: i + 1, raw, error: (err as Error).message });
        continue;
      }
      const event = parsed as ExecutionTelemetryEvent;
      const errors = validateTelemetryEvent(event);
      if (errors.length > 0) {
        schemaErrors.push({ file, lineNumber: i + 1, eventId: typeof event.eventId === 'string' ? event.eventId : null, errors });
        continue;
      }
      eventsParsed += 1;
      const existing = eventIdOccurrences.get(event.eventId) ?? [];
      existing.push(file);
      eventIdOccurrences.set(event.eventId, existing);
      const traceEvents = eventsByTraceId.get(event.traceId) ?? [];
      traceEvents.push(event);
      eventsByTraceId.set(event.traceId, traceEvents);

      if (event.eventType === 'TELEMETRY_HEALTH') {
        const data = event.data as Record<string, unknown>;
        const dropped = Number(data.dropped ?? 0);
        const invalid = Number(data.invalid ?? 0);
        const writeFailures = Number(data.writeFailures ?? 0);
        if (dropped > 0 || invalid > 0 || writeFailures > 0) {
          healthFailures.push({ traceId: event.traceId, eventId: event.eventId, detail: `dropped=${dropped} invalid=${invalid} writeFailures=${writeFailures}` });
        }
      }

      for (const [field, quality] of Object.entries(event.quality)) {
        if (quality === 'MISSING' || quality === 'INVALID' || quality === 'ASSUMED') {
          missingOrAmbiguousFields.push({ traceId: event.traceId, eventType: event.eventType, eventId: event.eventId, field, quality });
        }
      }
    }
  }

  const duplicateEventIds: DuplicateEventId[] = [];
  for (const [eventId, files2] of eventIdOccurrences.entries()) {
    if (files2.length > 1) duplicateEventIds.push({ eventId, count: files2.length, files: files2 });
  }

  const brokenTraces: BrokenTraceLifecycle[] = [];
  const missingTerminalTraces: MissingTerminalTrace[] = [];
  const tradeGaps: TradeGapReport[] = [];
  const aggregateCounts: AggregateCounts = { bySymbol: {}, bySetupType: {}, byRegime: {} };
  const pnlComparisons: PnlComparison[] = [];
  let totalCommission = 0;
  let totalFunding = 0;
  let observedTradeCount = 0;

  for (const [traceId, events] of eventsByTraceId.entries()) {
    const recordedInFileOrder = events.map((event) => Date.parse(event.recordedTimestampUtc));
    if (recordedInFileOrder.some((timestamp, index) => index > 0 && timestamp < recordedInFileOrder[index - 1])) {
      brokenTraces.push({ traceId, reason: 'recordedTimestampUtc is not monotonically non-decreasing across the trace' });
    }
    const sorted = [...events].sort((a, b) => Date.parse(a.recordedTimestampUtc) - Date.parse(b.recordedTimestampUtc));

    const eventTypes = new Set(sorted.map((e) => e.eventType));
    const hasFill = [...eventTypes].some((t) => FILL_EVENT_TYPES.has(t));
    if (hasFill) {
      const missingStages = PRE_FILL_REQUIRED_STAGES.filter((stage) => !eventTypes.has(stage as ExecutionTelemetryEvent['eventType']));
      if (missingStages.length > 0) brokenTraces.push({ traceId, reason: `fill occurred but missing pre-fill stage(s): ${missingStages.join(',')}` });
    }

    const isTradeLifecycleTrace = eventTypes.has('CANDIDATE_CREATED');
    const hasTerminal = [...eventTypes].some((t) => TERMINAL_EVENT_TYPES.has(t));
    if (isTradeLifecycleTrace && !hasTerminal) missingTerminalTraces.push({ traceId, lastEventType: sorted[sorted.length - 1]?.eventType ?? 'NONE' });

    const hasClosed = eventTypes.has('TRADE_CLOSED');
    if (hasClosed) {
      const hasSl = sorted.some((e) => e.eventType === 'ORDER_SENT' && (e.data as Record<string, unknown>).role === 'PROTECTIVE_SL');
      const missingFill = !hasFill;
      const missingSl = !hasSl;
      if (missingFill || missingSl) tradeGaps.push({ traceId, missingFill, missingSl, missingClose: false });

      const candidateEvent = sorted.find((e) => e.eventType === 'CANDIDATE_CREATED');
      const closedEvent = sorted.find((e) => e.eventType === 'TRADE_CLOSED')!;
      const symbol = closedEvent.symbol;
      const setupType = closedEvent.setupType;
      const regime = candidateEvent ? String((candidateEvent.data as Record<string, unknown>).regime ?? 'UNKNOWN') : 'UNKNOWN';
      aggregateCounts.bySymbol[symbol] = (aggregateCounts.bySymbol[symbol] ?? 0) + 1;
      aggregateCounts.bySetupType[setupType] = (aggregateCounts.bySetupType[setupType] ?? 0) + 1;
      aggregateCounts.byRegime[regime] = (aggregateCounts.byRegime[regime] ?? 0) + 1;

      const reconciled = sorted.find((e) => e.eventType === 'POSITION_RECONCILED');
      if (reconciled) {
        const rData = reconciled.data as Record<string, unknown>;
        const modeledPnl = Number((closedEvent.data as Record<string, unknown>).modeledNetPnl);
        if (reconciled.quality.realizedPnl === 'OBSERVED' && typeof rData.realizedPnl === 'number') {
          const observedPnl = rData.realizedPnl;
          pnlComparisons.push({ traceId, modeledPnl, observedPnl, diff: observedPnl - modeledPnl });
          observedTradeCount += 1;
        }
        if (typeof rData.commission === 'number') totalCommission += rData.commission;
        if (typeof rData.funding === 'number') totalFunding += rData.funding;
      }
    } else if (!eventTypes.has('EXCHANGE_REJECT') && !eventTypes.has('ORDER_CANCELLED') && !eventTypes.has('ORDER_EXPIRED') && hasFill) {
      tradeGaps.push({ traceId, missingFill: false, missingSl: false, missingClose: true });
    }
  }

  const ok =
    files.length > 0 &&
    eventsParsed > 0 &&
    parseErrors.length === 0 &&
    schemaErrors.length === 0 &&
    duplicateEventIds.length === 0 &&
    brokenTraces.length === 0 &&
    missingTerminalTraces.length === 0 &&
    tradeGaps.length === 0 &&
    healthFailures.length === 0;

  return {
    filesScanned: files.length,
    eventsParsed,
    parseErrors,
    schemaErrors,
    duplicateEventIds,
    brokenTraces,
    missingTerminalTraces,
    tradeGaps,
    healthFailures,
    missingOrAmbiguousFields,
    aggregateCounts,
    pnlComparisons,
    commissionFundingTotals: { totalCommission, totalFunding, observedTradeCount },
    ok,
  };
}

export function formatTelemetryValidationReport(report: TelemetryValidationReport): string {
  const lines: string[] = [];
  lines.push(`filesScanned=${report.filesScanned} eventsParsed=${report.eventsParsed}`);
  lines.push(`parseErrors=${report.parseErrors.length} schemaErrors=${report.schemaErrors.length} duplicateEventIds=${report.duplicateEventIds.length}`);
  lines.push(`brokenTraces=${report.brokenTraces.length} missingTerminalTraces=${report.missingTerminalTraces.length} tradeGaps=${report.tradeGaps.length} healthFailures=${report.healthFailures.length}`);
  for (const e of report.parseErrors) lines.push(`PARSE_ERROR ${e.file}:${e.lineNumber} ${e.error}`);
  for (const e of report.schemaErrors) lines.push(`SCHEMA_ERROR ${e.file}:${e.lineNumber} eventId=${e.eventId ?? 'null'} ${e.errors.join(',')}`);
  for (const d of report.duplicateEventIds) lines.push(`DUPLICATE_EVENT_ID ${d.eventId} count=${d.count}`);
  for (const b of report.brokenTraces) lines.push(`BROKEN_TRACE ${b.traceId} ${b.reason}`);
  for (const m of report.missingTerminalTraces) lines.push(`MISSING_TERMINAL ${m.traceId} lastEventType=${m.lastEventType}`);
  for (const g of report.tradeGaps) lines.push(`TRADE_GAP ${g.traceId} missingFill=${g.missingFill} missingSl=${g.missingSl} missingClose=${g.missingClose}`);
  for (const h of report.healthFailures) lines.push(`HEALTH_FAILURE ${h.traceId} ${h.eventId} ${h.detail}`);
  lines.push(`aggregateCounts.bySymbol=${JSON.stringify(report.aggregateCounts.bySymbol)}`);
  lines.push(`aggregateCounts.bySetupType=${JSON.stringify(report.aggregateCounts.bySetupType)}`);
  lines.push(`aggregateCounts.byRegime=${JSON.stringify(report.aggregateCounts.byRegime)}`);
  for (const p of report.pnlComparisons) lines.push(`PNL_COMPARISON ${p.traceId} modeled=${p.modeledPnl} observed=${p.observedPnl} diff=${p.diff}`);
  lines.push(`commissionFundingTotals=${JSON.stringify(report.commissionFundingTotals)}`);
  lines.push(`missingOrAmbiguousFields.count=${report.missingOrAmbiguousFields.length}`);
  for (const f of report.missingOrAmbiguousFields) lines.push(`MISSING_OR_AMBIGUOUS ${f.traceId} ${f.eventType} field=${f.field} quality=${f.quality}`);
  lines.push(report.ok ? 'LIVE_TELEMETRY_VALIDATOR_OK' : 'LIVE_TELEMETRY_VALIDATOR_FAILED');
  return lines.join('\n');
}

export function main(): void {
  const rootDir = process.argv[2] ?? process.env.EXECUTION_TELEMETRY_DIR ?? 'data/live-telemetry';
  const report = validateTelemetryDataset(rootDir);
  console.log(formatTelemetryValidationReport(report));
  process.exitCode = report.ok ? 0 : 1;
}

const isDirectRun = (() => {
  try {
    return process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectRun) main();
