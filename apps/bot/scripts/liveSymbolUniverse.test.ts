import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LIVE_SYMBOL_UNIVERSE } from './liveSymbolUniverse.js';

describe('LIVE_SYMBOL_UNIVERSE (TICKET-LIVE-R0 / LIVE-R0R)', () => {
  it('is exactly BTCUSDT, ETHUSDT, SOLUSDT in that order', () => {
    expect(LIVE_SYMBOL_UNIVERSE).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  });

  it('does not contain XRPUSDT', () => {
    expect(LIVE_SYMBOL_UNIVERSE).not.toContain('XRPUSDT');
  });

  it('does not contain HYPEUSDT', () => {
    expect(LIVE_SYMBOL_UNIVERSE).not.toContain('HYPEUSDT');
  });

  it('has no duplicate symbols', () => {
    expect(new Set(LIVE_SYMBOL_UNIVERSE).size).toBe(LIVE_SYMBOL_UNIVERSE.length);
  });

  it('is frozen at runtime — mutation throws rather than silently succeeding', () => {
    expect(Object.isFrozen(LIVE_SYMBOL_UNIVERSE)).toBe(true);
    expect(() => (LIVE_SYMBOL_UNIVERSE as string[]).push('SHOULD_NOT_WORK')).toThrow(TypeError);
    expect(() => (LIVE_SYMBOL_UNIVERSE as string[]).splice(0, 1)).toThrow(TypeError);
    expect(() => ((LIVE_SYMBOL_UNIVERSE as string[])[0] = 'SHOULD_NOT_WORK')).toThrow(TypeError);
    // Confirm the attempted mutations above truly had zero effect (belt-and-suspenders on top of the
    // thrown-error assertions, in case some engine/mode silently no-ops instead of throwing).
    expect(LIVE_SYMBOL_UNIVERSE).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  });
});

describe('liveRunner.ts uses the authoritative list, not a second hard-coded one (source-scan)', () => {
  const liveRunnerSrc = readFileSync(path.join(__dirname, 'liveRunner.ts'), 'utf8');

  it('imports LIVE_SYMBOL_UNIVERSE from ./liveSymbolUniverse.js', () => {
    expect(liveRunnerSrc).toContain("import { LIVE_SYMBOL_UNIVERSE } from './liveSymbolUniverse.js';");
  });

  it('assigns SYMBOLS from a mutable spread copy of LIVE_SYMBOL_UNIVERSE, not a literal array', () => {
    expect(liveRunnerSrc).toContain('const SYMBOLS: string[] = [...LIVE_SYMBOL_UNIVERSE];');
  });

  it('contains no second hard-coded live symbol universe array literal', () => {
    // liveRunner.ts is allowed to reference an individual symbol as a fixed anchor elsewhere (e.g.
    // 'BTCUSDT' passed to computeCorrelatedRiskRatio as its frozen correlated-risk reference symbol
    // — unrelated risk logic, out of LIVE-R0 scope, untouched). What must never reappear is a SECOND
    // array literal enumerating the live universe itself, which would let the two lists drift.
    expect(liveRunnerSrc).not.toMatch(/\[\s*['"]BTCUSDT['"]\s*,\s*['"]ETHUSDT['"]\s*,\s*['"]SOLUSDT['"]/);
    const symbolsAssignments = liveRunnerSrc.match(/const SYMBOLS(?:\s*:\s*string\[\])?\s*=/g) ?? [];
    expect(symbolsAssignments.length).toBe(1);
  });

  it('contains no XRPUSDT or HYPEUSDT reference at all', () => {
    expect(liveRunnerSrc).not.toContain('XRPUSDT');
    expect(liveRunnerSrc).not.toContain('HYPEUSDT');
  });
});
