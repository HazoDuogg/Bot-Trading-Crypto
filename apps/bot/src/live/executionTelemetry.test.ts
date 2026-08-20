import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionTelemetry, redactTelemetryValue, sideAwareSlippageBps, spreadMetrics, stableTelemetryId, validateTelemetryEvent, EXECUTION_TELEMETRY_SCHEMA_VERSION, type ExecutionTelemetryEvent } from './executionTelemetry.js';

function draft(eventType='ORDER_SUBMIT_INTENT' as const){return{traceId:'trace-1',symbol:'BTCUSDT',side:'LONG' as const,setupType:'MOMENTUM_DIRECT',eventType,source:'LIVE_RUNNER',quality:{requestedQuantity:'DERIVED' as const},data:{requestedQuantity:1}};}
describe('execution telemetry',()=>{
 it('uses stable correlation IDs',()=>expect(stableTelemetryId('trace','BTCUSDT',123)).toBe(stableTelemetryId('trace','BTCUSDT',123)));
 it('redacts secret-like allowlist mistakes recursively',()=>expect(redactTelemetryValue({apiKey:'x',nested:{signature:'y'},safe:1})).toEqual({apiKey:'[REDACTED]',nested:{signature:'[REDACTED]'},safe:1}));
 it.each([['BUY',101,100,100],['SELL',99,100,100]] as const)('positive slippage is adverse for %s',(side,fill,ref,expected)=>expect(sideAwareSlippageBps(side,fill,ref)).toBeCloseTo(expected));
 it('computes observed spread around mid',()=>expect(spreadMetrics(99,101)).toEqual({mid:100,spreadPrice:2,spreadBps:200}));
 it('disabled mode has no side effect',async()=>{const root=mkdtempSync(path.join(tmpdir(),'telemetry-off-'));const t=new ExecutionTelemetry({enabled:false,rootDir:root,strategyVersion:'s',configHash:'c',modelVersion:'m'});expect(t.emit(draft())).toBe(true);await t.flush();expect(readdirSync(root)).toHaveLength(0);});
  it('writes append-only JSONL and rejects secret-bearing drafts',async()=>{const root=mkdtempSync(path.join(tmpdir(),'telemetry-on-'));const t=new ExecutionTelemetry({enabled:true,rootDir:root,sessionId:'session',strategyVersion:'s',configHash:'c',modelVersion:'m'});expect(t.emit({...draft(),data:{apiSecret:'nope',requestedQuantity:1}})).toBe(false);expect(t.emit({...draft('EXCHANGE_ACK'),eventId:'ack'})).toBe(true);await t.flush();const day=readdirSync(root)[0],file=readdirSync(path.join(root,day))[0],lines=readFileSync(path.join(root,day,file),'utf8').trim().split('\n');expect(lines).toHaveLength(1);expect(readFileSync(path.join(root,day,file),'utf8')).not.toContain('nope');expect(JSON.parse(lines[0]).schemaVersion).toBe(EXECUTION_TELEMETRY_SCHEMA_VERSION);});
 it('creates telemetry files with owner-only permissions where POSIX modes are available',async()=>{const root=mkdtempSync(path.join(tmpdir(),'telemetry-mode-'));const t=new ExecutionTelemetry({enabled:true,rootDir:root,sessionId:'session',strategyVersion:'s',configHash:'c',modelVersion:'m'});t.emit(draft());await t.flush();const day=readdirSync(root)[0],file=readdirSync(path.join(root,day))[0],mode=statSync(path.join(root,day,file)).mode&0o777;if(process.platform!=='win32')expect(mode).toBe(0o600);await t.close();});
 it('drops on bounded queue saturation and exposes health',()=>{const t=new ExecutionTelemetry({enabled:true,rootDir:mkdtempSync(path.join(tmpdir(),'telemetry-q-')),strategyVersion:'s',configHash:'c',modelVersion:'m',maxQueueSize:1});expect(t.emit(draft())).toBe(true);expect(t.emit(draft())).toBe(false);expect(t.health.dropped).toBe(1);});
 it('reports invalid timestamps',()=>{const event={...draft(),schemaVersion:'1',eventId:'e',sessionId:'s',strategyVersion:'v',configHash:'c',modelVersion:'m',eventTimestampUtc:'bad',recordedTimestampUtc:'bad'} as ExecutionTelemetryEvent;expect(validateTelemetryEvent(event)).toContain('invalid_timestamp:eventTimestampUtc');});
 it('alerts on validation failure without throwing into trading path',()=>{const alert=vi.fn();const t=new ExecutionTelemetry({enabled:true,rootDir:mkdtempSync(path.join(tmpdir(),'telemetry-invalid-')),strategyVersion:'s',configHash:'c',modelVersion:'m',onHealthAlert:alert});expect(t.emit({...draft(),traceId:''})).toBe(false);expect(alert).toHaveBeenCalled();});
});

function baseDraft(overrides: Partial<Parameters<ExecutionTelemetry['emit']>[0]> = {}) {
  return { traceId: 'trace-r5t', symbol: 'BTCUSDT', side: 'LONG' as const, setupType: 'OB', eventType: 'CANDIDATE_CREATED' as const, source: 'TEST', quality: { entryProposal: 'DERIVED' as const }, data: { foo: 'bar' }, ...overrides };
}

describe('TICKET-LIVE-R5T requirement 3/5 — required-field validation, redaction-vs-rejection, rotation, retention, write-failure health', () => {
  it('validateTelemetryEvent flags every individually-missing required field', () => {
    const full: ExecutionTelemetryEvent = { schemaVersion: EXECUTION_TELEMETRY_SCHEMA_VERSION, eventId: 'e1', traceId: 't1', sessionId: 's1', strategyVersion: 'v1', configHash: 'h1', modelVersion: 'm1', symbol: 'BTCUSDT', side: 'LONG', setupType: 'OB', eventType: 'CANDIDATE_CREATED', eventTimestampUtc: new Date().toISOString(), recordedTimestampUtc: new Date().toISOString(), source: 'TEST', quality: {}, data: {} };
    expect(validateTelemetryEvent(full)).toEqual([]);
    expect(validateTelemetryEvent({ ...full, symbol: '' })).toContain('missing:symbol');
    expect(validateTelemetryEvent({ ...full, traceId: '' })).toContain('missing:traceId');
    expect(validateTelemetryEvent({ ...full, source: '' })).toContain('missing:source');
  });

  it('a secret-shaped value embedded in an otherwise-innocuous field is redacted before being written to disk', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'telemetry-redact-'));
    const t = new ExecutionTelemetry({ enabled: true, rootDir: root, strategyVersion: 'v1', configHash: 'h', modelVersion: 'm1' });
    const accepted = t.emit(baseDraft({ data: { note: 'api_key=super-secret-value-xyz', normal: 42 } }));
    expect(accepted).toBe(true);
    await t.flush();
    const day = readdirSync(root)[0];
    const file = readdirSync(path.join(root, day))[0];
    const content = readFileSync(path.join(root, day, file), 'utf8');
    expect(content).not.toContain('super-secret-value-xyz');
    expect(content).toContain('[REDACTED]');
    await t.close();
  });

  it('a draft carrying a secret-named field is rejected outright — redaction never rescues it from validation', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'telemetry-reject-'));
    const t = new ExecutionTelemetry({ enabled: true, rootDir: root, strategyVersion: 'v1', configHash: 'h', modelVersion: 'm1' });
    const accepted = t.emit(baseDraft({ data: { apiSecret: 'super-secret-value', normal: 42 } }));
    expect(accepted).toBe(false);
    await t.flush();
    expect(t.health.invalid).toBe(1);
    expect(t.health.written).toBe(0);
    await t.close();
  });

  it('rotates to a new day directory when the clock crosses a UTC day boundary', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'telemetry-dayrot-'));
    let current = Date.parse('2026-01-01T23:59:59.500Z');
    const t = new ExecutionTelemetry({ enabled: true, rootDir: root, strategyVersion: 'v1', configHash: 'h', modelVersion: 'm1', now: () => current });
    t.emit(baseDraft());
    await t.flush();
    current = Date.parse('2026-01-02T00:00:01.000Z');
    t.emit(baseDraft());
    await t.flush();
    const dayDirs = readdirSync(root).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
    expect(dayDirs).toEqual(['2026-01-01', '2026-01-02']);
    await t.close();
  });

  it('rotates to a new numbered file once the active file exceeds maxFileBytes', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'telemetry-sizerot-'));
    const t = new ExecutionTelemetry({ enabled: true, rootDir: root, strategyVersion: 'v1', configHash: 'h', modelVersion: 'm1', maxFileBytes: 10 });
    t.emit(baseDraft());
    await t.flush();
    t.emit(baseDraft());
    await t.flush();
    const dayDir = readdirSync(root).find((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))!;
    const files = readdirSync(path.join(root, dayDir));
    expect(files.length).toBeGreaterThanOrEqual(2);
    await t.close();
  });

  it('prune() removes only day-directories strictly older than retentionDays, never the current UTC day', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'telemetry-prune-'));
    const now = Date.parse('2026-06-01T12:00:00Z');
    const oldDir = path.join(root, '2020-01-01');
    const todayDir = path.join(root, '2026-06-01');
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(path.join(oldDir, 'stale.jsonl'), '{}\n');
    mkdirSync(todayDir, { recursive: true });
    writeFileSync(path.join(todayDir, 'active.jsonl'), '{}\n');
    const t = new ExecutionTelemetry({ enabled: true, rootDir: root, strategyVersion: 'v1', configHash: 'h', modelVersion: 'm1', retentionDays: 90, now: () => now });
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(todayDir)).toBe(true);
    expect(existsSync(path.join(todayDir, 'active.jsonl'))).toBe(true);
    void t;
  });

  it('isEnabled()/getSessionId() reflect construction config, and close() flips isEnabled() false', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'telemetry-lifecycle-'));
    const t = new ExecutionTelemetry({ enabled: true, rootDir: root, strategyVersion: 'v1', configHash: 'h', modelVersion: 'm1', sessionId: 'fixed-session' });
    expect(t.isEnabled()).toBe(true);
    expect(t.getSessionId()).toBe('fixed-session');
    await t.close();
    expect(t.isEnabled()).toBe(false);
  });

  it('a write failure (rootDir replaced by a non-directory after construction) increments writeFailures, fires onHealthAlert, and never throws out of emit()', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'telemetry-writefail-'));
    const alerts: string[] = [];
    const t = new ExecutionTelemetry({ enabled: true, rootDir: root, strategyVersion: 'v1', configHash: 'h', modelVersion: 'm1', onHealthAlert: (m) => alerts.push(m) });
    t.emit(baseDraft());
    await t.flush();
    rmSync(root, { recursive: true, force: true });
    writeFileSync(root, 'not-a-directory');
    expect(() => t.emit(baseDraft())).not.toThrow();
    await t.flush();
    expect(t.health.writeFailures).toBeGreaterThan(0);
    expect(alerts.some((m) => m.includes('write failure'))).toBe(true);
    rmSync(root, { force: true });
  });
});
