import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  M15_MS,
  assertRollingFingerprint,
  buildCoinWindowAssignments,
  buildRollingWindows,
} from './runNukidaWalkForwardRolling.js';

describe('buildRollingWindows', () => {
  it('covers the complete history with consecutive non-overlapping 180-day windows', () => {
    const historyEnd = 450 * DAY_MS;
    const windows = buildRollingWindows(0, historyEnd - M15_MS);

    expect(windows).toEqual([
      { index: 0, startInclusive: 0, endExclusive: 180 * DAY_MS, partial: false },
      {
        index: 1,
        startInclusive: 180 * DAY_MS,
        endExclusive: 360 * DAY_MS,
        partial: false,
      },
      {
        index: 2,
        startInclusive: 360 * DAY_MS,
        endExclusive: historyEnd,
        partial: true,
      },
    ]);
    expect(windows[0].endExclusive).toBe(windows[1].startInclusive);
    expect(windows[1].endExclusive).toBe(windows[2].startInclusive);
  });

  it('skips coin windows with missing start/end coverage instead of interpolating', () => {
    const windows = buildRollingWindows(0, 450 * DAY_MS - M15_MS);
    const assignments = buildCoinWindowAssignments(windows, {
      firstOpenTime: 190 * DAY_MS,
      lastOpenTime: 400 * DAY_MS - M15_MS,
    });

    expect(assignments.map(({ status, reason }) => ({ status, reason }))).toEqual([
      { status: 'SKIPPED', reason: 'NO_DATA_IN_WINDOW' },
      { status: 'SKIPPED', reason: 'MISSING_WINDOW_START' },
      { status: 'SKIPPED', reason: 'MISSING_WINDOW_END' },
    ]);
  });
});

describe('assertRollingFingerprint', () => {
  it('throws before a mismatched rolling window can run', () => {
    expect(() => assertRollingFingerprint('locked-hash', 'changed-hash', 3)).toThrow(
      'Strategy fingerprint mismatch at window 3',
    );
    expect(() => assertRollingFingerprint('locked-hash', 'locked-hash', 3)).not.toThrow();
  });
});
