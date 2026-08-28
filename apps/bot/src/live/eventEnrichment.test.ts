import { describe, it, expect } from 'vitest';
import { enrichWithBalanceAndLeverage } from './eventEnrichment.js';
import type { LiveEventRecord } from './eventRecord.js';

function record(overrides: Partial<LiveEventRecord>): LiveEventRecord {
  return { timestampUtc: '2026-01-01T00:00:00.000Z', symbol: 'BTCUSDT', strategy: 'FVG H1+M15', eventKind: 'ENTRY_PLACED', raw: {}, ...overrides };
}

function clientReturning(balance: number) {
  return { getAvailableBalanceUsdt: async () => balance };
}

function clientThrowing() {
  return {
    getAvailableBalanceUsdt: async () => {
      throw new Error('network blip');
    },
  };
}

describe('enrichWithBalanceAndLeverage', () => {
  it('adds fresh balance + leverage for ENTRY_PLACED', async () => {
    const rec = await enrichWithBalanceAndLeverage(record({ eventKind: 'ENTRY_PLACED', symbol: 'BTCUSDT' }), clientReturning(1234.5));
    expect(rec.currentBalanceUsdt).toBe(1234.5);
    expect(rec.leverage).toBe(20);
  });

  it('adds fresh balance + leverage for ENTRY_FILLED', async () => {
    const rec = await enrichWithBalanceAndLeverage(record({ eventKind: 'ENTRY_FILLED', symbol: 'SOLUSDT' }), clientReturning(500));
    expect(rec.currentBalanceUsdt).toBe(500);
    expect(rec.leverage).toBe(10);
  });

  it('adds balance but NOT leverage for POSITION_CLOSED', async () => {
    const rec = await enrichWithBalanceAndLeverage(record({ eventKind: 'POSITION_CLOSED' }), clientReturning(777));
    expect(rec.currentBalanceUsdt).toBe(777);
    expect(rec.leverage).toBeUndefined();
  });

  it('leaves other event kinds (LIFECYCLE_ERROR, POLL_ERROR, CIRCUIT_BREAKER_TRIPPED, ENGINE_STARTUP) untouched', async () => {
    for (const eventKind of ['LIFECYCLE_ERROR', 'POLL_ERROR', 'CIRCUIT_BREAKER_TRIPPED', 'ENGINE_STARTUP', 'ENTRY_SKIPPED', 'ENTRY_TIMEOUT_CANCELLED'] as const) {
      const original = record({ eventKind });
      const rec = await enrichWithBalanceAndLeverage(original, clientReturning(999));
      expect(rec).toEqual(original);
    }
  });

  it('falls back to currentBalanceUsdt=null when the fetch fails, without throwing (does not block the message)', async () => {
    const rec = await enrichWithBalanceAndLeverage(record({ eventKind: 'ENTRY_PLACED' }), clientThrowing());
    expect(rec.currentBalanceUsdt).toBeNull();
    expect(rec.leverage).toBe(20);
  });
});
