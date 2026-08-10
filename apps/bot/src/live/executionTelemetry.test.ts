import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
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
 it('drops on bounded queue saturation and exposes health',()=>{const t=new ExecutionTelemetry({enabled:true,rootDir:mkdtempSync(path.join(tmpdir(),'telemetry-q-')),strategyVersion:'s',configHash:'c',modelVersion:'m',maxQueueSize:1});expect(t.emit(draft())).toBe(true);expect(t.emit(draft())).toBe(false);expect(t.health.dropped).toBe(1);});
 it('reports invalid timestamps',()=>{const event={...draft(),schemaVersion:'1',eventId:'e',sessionId:'s',strategyVersion:'v',configHash:'c',modelVersion:'m',eventTimestampUtc:'bad',recordedTimestampUtc:'bad'} as ExecutionTelemetryEvent;expect(validateTelemetryEvent(event)).toContain('invalid_timestamp:eventTimestampUtc');});
 it('alerts on validation failure without throwing into trading path',()=>{const alert=vi.fn();const t=new ExecutionTelemetry({enabled:true,rootDir:mkdtempSync(path.join(tmpdir(),'telemetry-invalid-')),strategyVersion:'s',configHash:'c',modelVersion:'m',onHealthAlert:alert});expect(t.emit({...draft(),traceId:''})).toBe(false);expect(alert).toHaveBeenCalled();});
});
