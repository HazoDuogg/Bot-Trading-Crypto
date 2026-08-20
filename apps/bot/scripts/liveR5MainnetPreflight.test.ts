import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateLiveR5Gates, evaluateLocalStateGateStatus, isHumanApiPermissionConfirmationValid, type GateResult } from './liveR5MainnetPreflight.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptSource = fs.readFileSync(path.resolve(__dirname, './liveR5MainnetPreflight.ts'), 'utf8');

const MUTATING_METHOD_NAMES_UNDER_TEST = [
  'setLeverage',
  'openMarketPosition',
  'placeLimitOrder',
  'closePositionMarket',
  'placeStopMarket',
  'placeTakeProfitMarket',
  'cancelOrder',
  'cancelAlgoOrder',
  'updateStopOrder',
  'initializeLeverageForSymbols',
] as const;

function makeGate(id: number, status: GateResult['status']): GateResult {
  return { id, name: `Gate ${id}`, status, evidence: 'test evidence' };
}

describe('liveR5MainnetPreflight structural safety proof', () => {
  it('the preflight script source contains zero references to any BinanceOrderExecutor mutating method name', () => {
    for (const methodName of MUTATING_METHOD_NAMES_UNDER_TEST) {
      const matches = scriptSource.match(new RegExp(methodName, 'g')) ?? [];
      expect(matches.length, `expected zero occurrences of "${methodName}" in liveR5MainnetPreflight.ts, found ${matches.length}`).toBe(0);
    }
  });

  it('the preflight script constructs BinanceOrderExecutor with dryRun: true', () => {
    expect(scriptSource).toMatch(/dryRun:\s*true/);
  });

  it('the preflight script never imports/invokes liveRunner.ts as a module (which would trigger its unconditional main())', () => {
    expect(scriptSource).not.toMatch(/from ['"].*liveRunner\.js['"]/);
    expect(scriptSource).not.toMatch(/import\(['"].*liveRunner/);
  });

  it('the preflight script never references replay/backtest/G6/G6R tooling', () => {
    for (const forbidden of ['backtest', 'G6R', 'replayEngine', 'runReplay']) {
      expect(scriptSource.includes(forbidden), `unexpected reference to "${forbidden}"`).toBe(false);
    }
  });
});

describe('aggregateLiveR5Gates', () => {
  it('returns LIVE_R5_PASS when every gate is PASS', () => {
    const gates = Array.from({ length: 15 }, (_, i) => makeGate(i + 1, 'PASS'));
    const result = aggregateLiveR5Gates(gates);
    expect(result.overall).toBe('LIVE_R5_PASS');
    expect(result.blockingGates).toEqual([]);
  });

  it('returns LIVE_R5_BLOCKED when a single gate is FAIL', () => {
    const gates = Array.from({ length: 15 }, (_, i) => makeGate(i + 1, 'PASS'));
    gates[6] = makeGate(7, 'FAIL');
    const result = aggregateLiveR5Gates(gates);
    expect(result.overall).toBe('LIVE_R5_BLOCKED');
    expect(result.blockingGates.map((g) => g.id)).toEqual([7]);
  });

  it('returns LIVE_R5_BLOCKED when a single gate is UNVERIFIABLE (e.g. gate 4 or gate 6)', () => {
    const gates = Array.from({ length: 15 }, (_, i) => makeGate(i + 1, 'PASS'));
    gates[3] = makeGate(4, 'UNVERIFIABLE');
    const result = aggregateLiveR5Gates(gates);
    expect(result.overall).toBe('LIVE_R5_BLOCKED');
    expect(result.blockingGates.map((g) => g.id)).toEqual([4]);
  });

  it('returns LIVE_R5_BLOCKED with ALL failing gates listed when multiple gates fail simultaneously (no override to PASS)', () => {
    const gates = Array.from({ length: 15 }, (_, i) => makeGate(i + 1, 'PASS'));
    gates[0] = makeGate(1, 'FAIL');
    gates[5] = makeGate(6, 'UNVERIFIABLE');
    gates[11] = makeGate(12, 'FAIL');
    const result = aggregateLiveR5Gates(gates);
    expect(result.overall).toBe('LIVE_R5_BLOCKED');
    expect(
      result.blockingGates.map((g) => g.id).sort((a, b) => a - b),
    ).toEqual([1, 6, 12]);
  });

  it('blocks an empty gate list', () => {
    const result = aggregateLiveR5Gates([]);
    expect(result.overall).toBe('LIVE_R5_BLOCKED');
  });

  it('blocks incomplete or duplicate gate IDs', () => {
    const incomplete = Array.from({ length: 14 }, (_, i) => makeGate(i + 1, 'PASS'));
    expect(aggregateLiveR5Gates(incomplete).overall).toBe('LIVE_R5_BLOCKED');
    const duplicate = Array.from({ length: 15 }, (_, i) => makeGate(i === 14 ? 14 : i + 1, 'PASS'));
    expect(aggregateLiveR5Gates(duplicate).overall).toBe('LIVE_R5_BLOCKED');
  });

  it('never treats NaN-bearing evidence as a reason to silently upgrade a FAIL/UNVERIFIABLE status to PASS', () => {
    const gates = [makeGate(1, 'PASS'), { id: 2, name: 'Balance', status: 'FAIL' as const, evidence: 'walletBalance=NaN' }];
    const result = aggregateLiveR5Gates(gates);
    expect(result.overall).toBe('LIVE_R5_BLOCKED');
  });
});

describe('LIVE-R5 operator and state prerequisites', () => {
  it('accepts only the exact human API-permission acknowledgement', () => {
    expect(isHumanApiPermissionConfirmationValid('true')).toBe(true);
    expect(isHumanApiPermissionConfirmationValid(undefined)).toBe(false);
    expect(isHumanApiPermissionConfirmationValid('TRUE')).toBe(false);
  });

  it('never passes local state when exchange reads failed', () => {
    expect(evaluateLocalStateGateStatus('NOT_FOUND', false)).toBe('UNVERIFIABLE');
    expect(evaluateLocalStateGateStatus('OK', false)).toBe('UNVERIFIABLE');
    expect(evaluateLocalStateGateStatus('CORRUPT', false)).toBe('FAIL');
  });

  it('allows NOT_FOUND only after successful exchange reads', () => {
    expect(evaluateLocalStateGateStatus('NOT_FOUND', true)).toBe('PASS');
  });
});

describe('secret hygiene', () => {
  it('the preflight script never logs process.env.BINANCE_LIVE_KEY/SECRET or Telegram token/chat-id values directly', () => {
    expect(scriptSource).not.toMatch(/console\.(log|error)\([^)]*process\.env\.BINANCE_LIVE_(KEY|SECRET)[^)]*\)/);
    expect(scriptSource).not.toMatch(/console\.(log|error)\([^)]*TELEGRAM_BOT_TOKEN[^)]*\)/);
    expect(scriptSource).not.toMatch(/console\.(log|error)\([^)]*botToken\}/);
    expect(scriptSource).not.toMatch(/console\.(log|error)\([^)]*chatIds\}/);
  });
});
