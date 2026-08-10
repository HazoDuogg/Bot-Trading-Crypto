import { describe, expect, it } from 'vitest';
import { shouldBlockSameSideDuplicate } from './orchestrator.js';

describe('pre-T152 replay compatibility', () => {
  it('keeps production guard enabled by default', () => expect(shouldBlockSameSideDuplicate({}, ['SHORT'], 'SHORT')).toBe(true));
  it('allows the locked legacy population only when explicitly disabled', () => expect(shouldBlockSameSideDuplicate({ sameSideDuplicateGuardEnabled: false }, ['SHORT'], 'SHORT')).toBe(false));
  it('does not affect opposite-side candidates', () => expect(shouldBlockSameSideDuplicate({}, ['LONG'], 'SHORT')).toBe(false));
});
