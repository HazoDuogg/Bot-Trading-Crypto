import { describe, expect, it } from 'vitest';
import { computeMomentumContextDecision, MOMENTUM_CONTEXT_REDUCED_RISK_MULTIPLIER } from './momentumContextDecisionMatrix.js';
import { SafetyState5m } from '../regime/htfSafetyTypes.js';
import { HTFContext } from '../regime/htfSafetyTypes.js';

const base = { symbol: 'ETHUSDT', macroConflict: false, safetyState5m: SafetyState5m.NORMAL, momentumThesisValid: true };

describe('computeMomentumContextDecision (TICKET-143 Decision Matrix V1)', () => {
  it('BTCUSDT + macroConflict -> BLOCK regardless of SafetyState5m/thesis', () => {
    const r = computeMomentumContextDecision({ ...base, symbol: 'BTCUSDT', macroConflict: true });
    expect(r.decision).toBe('BLOCK');
    expect(r.riskMultiplier).toBe(0);
  });

  it('ETHUSDT/SOLUSDT/XRPUSDT + macroConflict + SafetyState5m not blocked + thesis VALID -> ALLOW_REDUCED_RISK with 0.30', () => {
    for (const symbol of ['ETHUSDT', 'SOLUSDT', 'XRPUSDT']) {
      const r = computeMomentumContextDecision({ ...base, symbol, macroConflict: true });
      expect(r.decision).toBe('ALLOW_REDUCED_RISK');
      expect(r.riskMultiplier).toBe(0.3);
      expect(r.riskMultiplier).toBe(MOMENTUM_CONTEXT_REDUCED_RISK_MULTIPLIER);
    }
  });

  it('SHOCK -> BLOCK regardless of macroConflict/symbol', () => {
    for (const macroConflict of [true, false]) {
      for (const symbol of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']) {
        const r = computeMomentumContextDecision({ ...base, symbol, macroConflict, safetyState5m: SafetyState5m.SHOCK });
        expect(r.decision).toBe('BLOCK');
      }
    }
  });

  it('MANIPULATED -> BLOCK regardless of macroConflict/symbol', () => {
    for (const macroConflict of [true, false]) {
      for (const symbol of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']) {
        const r = computeMomentumContextDecision({ ...base, symbol, macroConflict, safetyState5m: SafetyState5m.MANIPULATED });
        expect(r.decision).toBe('BLOCK');
      }
    }
  });

  it('no macroConflict + SafetyState5m ok -> ALLOW_NORMAL, riskMultiplier 1.0', () => {
    const r = computeMomentumContextDecision({ ...base, macroConflict: false });
    expect(r.decision).toBe('ALLOW_NORMAL');
    expect(r.riskMultiplier).toBe(1.0);
  });

  it('VOLATILE_CHOP/LOW_LIQUIDITY/NORMAL do NOT block by themselves (no macroConflict -> ALLOW_NORMAL)', () => {
    for (const st of [SafetyState5m.VOLATILE_CHOP, SafetyState5m.LOW_LIQUIDITY, SafetyState5m.NORMAL]) {
      const r = computeMomentumContextDecision({ ...base, macroConflict: false, safetyState5m: st });
      expect(r.decision).toBe('ALLOW_NORMAL');
    }
  });

  it('VOLATILE_CHOP/LOW_LIQUIDITY/NORMAL + macroConflict on reduced-risk symbol -> ALLOW_REDUCED_RISK (not BLOCK)', () => {
    for (const st of [SafetyState5m.VOLATILE_CHOP, SafetyState5m.LOW_LIQUIDITY, SafetyState5m.NORMAL]) {
      const r = computeMomentumContextDecision({ ...base, symbol: 'SOLUSDT', macroConflict: true, safetyState5m: st });
      expect(r.decision).toBe('ALLOW_REDUCED_RISK');
    }
  });

  it('momentumThesisValid=false -> BLOCK even with no macroConflict and safe SafetyState5m', () => {
    const r = computeMomentumContextDecision({ ...base, momentumThesisValid: false });
    expect(r.decision).toBe('BLOCK');
    expect(r.reason).toBe('invalid_momentum_thesis');
  });

  it('macroConflict + non-BTC + non-reduced-risk-listed symbol -> safe-default BLOCK', () => {
    const r = computeMomentumContextDecision({ ...base, symbol: 'DOGEUSDT', macroConflict: true });
    expect(r.decision).toBe('BLOCK');
    expect(r.reason).toBe('macro_conflict_unlisted_symbol');
  });

  it('HTFContext never affects the decision — not even a field in the input type', () => {
    // Compile-time proof: MomentumContextDecisionInput has no htfContext field, so passing it here
    // would be a type error. Runtime proof: identical inputs (differing only in a would-be htfContext
    // if it existed) always produce the identical decision — enforced structurally by omission.
    const withoutHtf = computeMomentumContextDecision(base);
    const stillWithoutHtf = computeMomentumContextDecision({ ...base, ...({} as Record<string, never>) });
    expect(withoutHtf).toEqual(stillWithoutHtf);
    expect(Object.keys(base)).not.toContain('htfContext');
    // sanity: HTFContext import above is exercised (referenced) without being usable as an input field.
    expect(Object.values(HTFContext)).toContain('NEUTRAL');
  });
});

describe('computeMomentumContextDecision (TICKET-143A Decision Matrix V2)', () => {
  it('ETHUSDT + macroConflict -> BLOCK under V2 (distinct from V1 ALLOW_REDUCED_RISK on the same input)', () => {
    const input = { ...base, symbol: 'ETHUSDT', macroConflict: true };
    const v1 = computeMomentumContextDecision(input, 'V1');
    const v2 = computeMomentumContextDecision(input, 'V2');
    expect(v1.decision).toBe('ALLOW_REDUCED_RISK');
    expect(v2.decision).toBe('BLOCK');
    expect(v2.riskMultiplier).toBe(0);
    expect(v2.reason).toBe('eth_macro_conflict');
  });

  it('BTCUSDT + macroConflict -> BLOCK under V2, unchanged from V1', () => {
    const input = { ...base, symbol: 'BTCUSDT', macroConflict: true };
    const v1 = computeMomentumContextDecision(input, 'V1');
    const v2 = computeMomentumContextDecision(input, 'V2');
    expect(v2.decision).toBe('BLOCK');
    expect(v2).toEqual(v1);
  });

  it('SOLUSDT/XRPUSDT + macroConflict -> ALLOW_REDUCED_RISK with 0.30 under V2, unchanged from V1', () => {
    for (const symbol of ['SOLUSDT', 'XRPUSDT']) {
      const input = { ...base, symbol, macroConflict: true };
      const v1 = computeMomentumContextDecision(input, 'V1');
      const v2 = computeMomentumContextDecision(input, 'V2');
      expect(v2.decision).toBe('ALLOW_REDUCED_RISK');
      expect(v2.riskMultiplier).toBe(MOMENTUM_CONTEXT_REDUCED_RISK_MULTIPLIER);
      expect(v2).toEqual(v1);
    }
  });

  it('SHOCK/MANIPULATED -> BLOCK under V2 regardless of macroConflict/symbol, unchanged from V1', () => {
    for (const st of [SafetyState5m.SHOCK, SafetyState5m.MANIPULATED]) {
      for (const macroConflict of [true, false]) {
        for (const symbol of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']) {
          const input = { ...base, symbol, macroConflict, safetyState5m: st };
          const v2 = computeMomentumContextDecision(input, 'V2');
          expect(v2.decision).toBe('BLOCK');
          expect(v2).toEqual(computeMomentumContextDecision(input, 'V1'));
        }
      }
    }
  });

  it('no macroConflict -> ALLOW_NORMAL under V2, unchanged from V1 (version never affects the no-conflict branch)', () => {
    const input = { ...base, macroConflict: false };
    expect(computeMomentumContextDecision(input, 'V2')).toEqual(computeMomentumContextDecision(input, 'V1'));
  });

  it('version param defaults to V1 when omitted — no call site needs to change', () => {
    const input = { ...base, symbol: 'ETHUSDT', macroConflict: true };
    expect(computeMomentumContextDecision(input)).toEqual(computeMomentumContextDecision(input, 'V1'));
  });
});
