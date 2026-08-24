import { describe, it, expect } from 'vitest';
import { admitPosition, closePosition, usedMargin, EMPTY_EXPOSURE_STATE } from './exposureTracker.js';
import type { AdmitCandidateInput, ExposureTrackerConfig, ExposureTrackerState } from './exposureTracker.js';

const BALANCE = 500;
const CONFIG: ExposureTrackerConfig = { maxTotalUsedMargin: 0.7, minRiskFraction: 0.3 };

function candidate(overrides: Partial<AdmitCandidateInput> = {}): AdmitCandidateInput {
  return {
    id: 'pos-1',
    symbol: 'BTCUSDT',
    qty: 1,
    notional: 100,
    requiredMargin: 100,
    actualRiskUsd: 5,
    ...overrides,
  };
}

describe('admitPosition — fits within headroom (no scale-down)', () => {
  it('admits unchanged when candidate margin is well under the cap', () => {
    const { result, nextState } = admitPosition(EMPTY_EXPOSURE_STATE, CONFIG, BALANCE, candidate());
    expect(result.admitted).toBe(true);
    expect(result.scaledDown).toBe(false);
    expect(result.qty).toBe(1);
    expect(result.notional).toBe(100);
    expect(result.requiredMargin).toBe(100);
    expect(result.actualRiskUsd).toBe(5);
    expect(usedMargin(nextState)).toBe(100);
  });

  it('never scales UP to consume the rest of the headroom — candidate values pass through exactly', () => {
    // cap = 500*0.7 = 350, plenty of headroom for a 100-margin candidate.
    const { result } = admitPosition(EMPTY_EXPOSURE_STATE, CONFIG, BALANCE, candidate({ requiredMargin: 100, qty: 2, notional: 200, actualRiskUsd: 5 }));
    expect(result.requiredMargin).toBe(100); // NOT inflated to 350 (the full headroom)
    expect(result.qty).toBe(2);
    expect(result.notional).toBe(200);
  });
});

describe('admitPosition — scale-down when candidate exceeds headroom', () => {
  it('scales qty/notional/margin/risk proportionally to fit exactly within headroom', () => {
    // cap = 350. Fill 300 first, leaving 50 headroom.
    const first = admitPosition(EMPTY_EXPOSURE_STATE, CONFIG, BALANCE, candidate({ id: 'a', requiredMargin: 300, qty: 3, notional: 300, actualRiskUsd: 15 }));
    expect(first.result.admitted).toBe(true);

    // Candidate wants 100 margin, only 50 headroom left -> scaleFactor 0.5.
    const second = admitPosition(first.nextState, CONFIG, BALANCE, candidate({ id: 'b', requiredMargin: 100, qty: 4, notional: 100, actualRiskUsd: 10 }));
    expect(second.result.admitted).toBe(true);
    expect(second.result.scaledDown).toBe(true);
    expect(second.result.requiredMargin).toBeCloseTo(50, 9);
    expect(second.result.qty).toBeCloseTo(2, 9); // 4 * 0.5
    expect(second.result.notional).toBeCloseTo(50, 9); // 100 * 0.5
    expect(second.result.actualRiskUsd).toBeCloseTo(5, 9); // 10 * 0.5 -> exactly at the 50% floor, still >= minRiskFraction(0.3)*10=3
  });

  it('skips outright when the scaled-down risk would fall below minRiskFraction * original risk', () => {
    // cap = 350. Fill 340 first, leaving only 10 headroom.
    const first = admitPosition(EMPTY_EXPOSURE_STATE, CONFIG, BALANCE, candidate({ id: 'a', requiredMargin: 340, qty: 3.4, notional: 340, actualRiskUsd: 17 }));
    expect(first.result.admitted).toBe(true);

    // Candidate wants 100 margin, only 10 headroom -> scaleFactor 0.1 -> scaledRisk = 10*0.1 = 1, but
    // minAllowedRisk = 0.3*10 = 3. 1 < 3 -> must skip, not open an undersized position.
    const second = admitPosition(first.nextState, CONFIG, BALANCE, candidate({ id: 'b', requiredMargin: 100, qty: 1, notional: 100, actualRiskUsd: 10 }));
    expect(second.result.admitted).toBe(false);
    expect(second.result.qty).toBe(0);
    expect(second.result.requiredMargin).toBe(0);
    // Rejected candidate must not be added to state.
    expect(usedMargin(second.nextState)).toBeCloseTo(340, 9);
  });

  it('skips when already at/over the cap (zero or negative headroom)', () => {
    const first = admitPosition(EMPTY_EXPOSURE_STATE, CONFIG, BALANCE, candidate({ id: 'a', requiredMargin: 350, qty: 3.5, notional: 350, actualRiskUsd: 17.5 }));
    expect(usedMargin(first.nextState)).toBeCloseTo(350, 9);

    const second = admitPosition(first.nextState, CONFIG, BALANCE, candidate({ id: 'b' }));
    expect(second.result.admitted).toBe(false);
    expect(usedMargin(second.nextState)).toBeCloseTo(350, 9);
  });
});

describe('admitPosition — invariant: used margin never exceeds balance*maxTotalUsedMargin', () => {
  it('holds across a long sequence of admits with random-ish sizes', () => {
    let state: ExposureTrackerState = EMPTY_EXPOSURE_STATE;
    const cap = BALANCE * CONFIG.maxTotalUsedMargin;
    const sizes = [40, 55, 30, 70, 90, 20, 60, 45, 33, 77, 15, 88, 22, 66, 99];

    sizes.forEach((margin, i) => {
      const { result, nextState } = admitPosition(state, CONFIG, BALANCE, candidate({ id: `p${i}`, requiredMargin: margin, qty: margin / 100, notional: margin, actualRiskUsd: margin / 20 }));
      state = nextState;
      expect(usedMargin(state)).toBeLessThanOrEqual(cap + 1e-9);
      if (result.admitted) {
        expect(result.requiredMargin).toBeLessThanOrEqual(margin + 1e-9); // never scaled up beyond what was requested
      }
    });

    expect(usedMargin(state)).toBeLessThanOrEqual(cap + 1e-9);
  });
});

describe('closePosition', () => {
  it('frees the margin held by a closed position', () => {
    const { nextState } = admitPosition(EMPTY_EXPOSURE_STATE, CONFIG, BALANCE, candidate({ id: 'a', requiredMargin: 100 }));
    expect(usedMargin(nextState)).toBe(100);

    const afterClose = closePosition(nextState, 'a');
    expect(usedMargin(afterClose)).toBe(0);
    expect(afterClose.openPositions).toHaveLength(0);
  });

  it('is a no-op for an unknown id', () => {
    const { nextState } = admitPosition(EMPTY_EXPOSURE_STATE, CONFIG, BALANCE, candidate({ id: 'a', requiredMargin: 100 }));
    const afterClose = closePosition(nextState, 'does-not-exist');
    expect(usedMargin(afterClose)).toBe(100);
  });
});

describe('admitPosition — invalid inputs', () => {
  it('rejects non-positive balance, margin, or risk', () => {
    expect(admitPosition(EMPTY_EXPOSURE_STATE, CONFIG, 0, candidate()).result.admitted).toBe(false);
    expect(admitPosition(EMPTY_EXPOSURE_STATE, CONFIG, BALANCE, candidate({ requiredMargin: 0 })).result.admitted).toBe(false);
    expect(admitPosition(EMPTY_EXPOSURE_STATE, CONFIG, BALANCE, candidate({ actualRiskUsd: 0 })).result.admitted).toBe(false);
  });
});
