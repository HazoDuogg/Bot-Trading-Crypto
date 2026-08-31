import { describe, expect, it } from 'vitest';
import { detectBreakoutFvg } from './breakoutFvg.js';
import type { OpeningRangeResult } from './openingRange.js';
import type { CasperCandle } from './types.js';

const minute = 60_000;
const openingRange: OpeningRangeResult = {
  state: 'OR_LOCKED',
  tradingDay: '2026-07-15',
  range: { high: 110, low: 90 },
};

function m5(
  startIso: string,
  open: number,
  high: number,
  low: number,
  close: number,
): CasperCandle {
  const startTimeMs = Date.parse(startIso);
  return { startTimeMs, endTimeMs: startTimeMs + 5 * minute, open, high, low, close };
}

function bullishSequence(): [CasperCandle, CasperCandle, CasperCandle] {
  return [
    m5('2026-07-15T13:45:00Z', 100, 105, 98, 102),
    m5('2026-07-15T13:50:00Z', 102, 114, 101, 109),
    m5('2026-07-15T13:55:00Z', 111, 115, 106, 113),
  ];
}

function bearishSequence(): [CasperCandle, CasperCandle, CasperCandle] {
  return [
    m5('2026-07-15T13:45:00Z', 100, 102, 95, 98),
    m5('2026-07-15T13:50:00Z', 98, 99, 86, 88),
    m5('2026-07-15T13:55:00Z', 89, 94, 85, 87),
  ];
}

function detect(
  candles: [CasperCandle, CasperCandle, CasperCandle],
  nowMs = candles[2].endTimeMs,
  range: OpeningRangeResult = openingRange,
) {
  const [c1, c2, c3] = candles;
  return detectBreakoutFvg({ nowMs, c1, c2, c3, openingRange: range });
}

describe('detectBreakoutFvg', () => {
  it('returns the bullish FVG zone for an inside-to-breakout sequence', () => {
    const [c1, c2, c3] = bullishSequence();
    const result = detectBreakoutFvg({
      nowMs: c3.endTimeMs,
      c1,
      c2,
      c3,
      openingRange,
    });

    expect(result).toEqual({
      state: 'VALID_BULLISH_FVG',
      direction: 'BULLISH',
      fvgLow: 105,
      fvgHigh: 106,
      c1,
      c2,
      c3,
      tradingDay: '2026-07-15',
    });
  });

  it('returns the bearish FVG zone for an inside-to-breakout sequence', () => {
    const [c1, c2, c3] = bearishSequence();
    const result = detect([c1, c2, c3]);

    expect(result).toEqual({
      state: 'VALID_BEARISH_FVG',
      direction: 'BEARISH',
      fvgLow: 94,
      fvgHigh: 95,
      c1,
      c2,
      c3,
      tradingDay: '2026-07-15',
    });
  });

  it('accepts bullish C1 inside then C2 outside', () => {
    const sequence = bullishSequence();
    sequence[1] = { ...sequence[1], close: 112 };

    expect(detect(sequence).state).toBe('VALID_BULLISH_FVG');
  });

  it('accepts bearish C1 inside then C3 outside', () => {
    const sequence = bearishSequence();
    sequence[1] = { ...sequence[1], close: 92 };

    expect(detect(sequence).state).toBe('VALID_BEARISH_FVG');
  });

  it('does not accept equality as bullish or bearish FVG geometry', () => {
    const bullish = bullishSequence();
    bullish[2] = { ...bullish[2], low: bullish[0].high };
    const bearish = bearishSequence();
    bearish[2] = { ...bearish[2], high: bearish[0].low };

    expect(detect(bullish).state).toBe('NO_FVG');
    expect(detect(bearish).state).toBe('NO_FVG');
  });

  it('rejects a generic FVG that remains completely inside the Opening Range', () => {
    const sequence: [CasperCandle, CasperCandle, CasperCandle] = [
      m5('2026-07-15T13:45:00Z', 98, 100, 96, 99),
      m5('2026-07-15T13:50:00Z', 99, 105, 98, 103),
      m5('2026-07-15T13:55:00Z', 102, 107, 101, 105),
    ];

    expect(detect(sequence).state).toBe('NO_FVG');
  });

  it('rejects a bullish sequence when all closes are already outside', () => {
    const sequence: [CasperCandle, CasperCandle, CasperCandle] = [
      m5('2026-07-15T13:45:00Z', 105, 112, 100, 111),
      m5('2026-07-15T13:50:00Z', 111, 116, 108, 114),
      m5('2026-07-15T13:55:00Z', 114, 118, 113, 116),
    ];

    expect(detect(sequence).state).toBe('NO_FVG');
  });

  it('accepts bullish C1 outside then C2 inside then C3 outside', () => {
    const sequence: [CasperCandle, CasperCandle, CasperCandle] = [
      m5('2026-07-15T13:45:00Z', 105, 112, 100, 111),
      m5('2026-07-15T13:50:00Z', 103, 114, 102, 105),
      m5('2026-07-15T13:55:00Z', 114, 118, 113, 116),
    ];

    expect(detect(sequence).state).toBe('VALID_BULLISH_FVG');
  });

  it('accepts bearish C1 outside then C2 inside then C3 outside', () => {
    const sequence: [CasperCandle, CasperCandle, CasperCandle] = [
      m5('2026-07-15T13:45:00Z', 95, 100, 88, 89),
      m5('2026-07-15T13:50:00Z', 97, 99, 86, 95),
      m5('2026-07-15T13:55:00Z', 87, 87, 82, 84),
    ];

    expect(detect(sequence).state).toBe('VALID_BEARISH_FVG');
  });

  it('rejects bullish outside then outside then inside because inside is too late', () => {
    const sequence: [CasperCandle, CasperCandle, CasperCandle] = [
      m5('2026-07-15T13:45:00Z', 95, 100, 85, 89),
      m5('2026-07-15T13:50:00Z', 100, 114, 99, 112),
      m5('2026-07-15T13:55:00Z', 104, 108, 101, 105),
    ];

    expect(detect(sequence).state).toBe('NO_FVG');
  });

  it('rejects bearish outside then outside then inside because inside is too late', () => {
    const sequence: [CasperCandle, CasperCandle, CasperCandle] = [
      m5('2026-07-15T13:45:00Z', 105, 115, 100, 111),
      m5('2026-07-15T13:50:00Z', 102, 103, 87, 88),
      m5('2026-07-15T13:55:00Z', 96, 99, 93, 95),
    ];

    expect(detect(sequence).state).toBe('NO_FVG');
  });

  it('rejects a bearish sequence with no inside close', () => {
    const sequence: [CasperCandle, CasperCandle, CasperCandle] = [
      m5('2026-07-15T13:45:00Z', 95, 100, 88, 89),
      m5('2026-07-15T13:50:00Z', 89, 90, 82, 85),
      m5('2026-07-15T13:55:00Z', 84, 87, 78, 80),
    ];

    expect(detect(sequence).state).toBe('NO_FVG');
  });

  it('rejects bullish outside then inside without a later bullish outside close', () => {
    const sequence: [CasperCandle, CasperCandle, CasperCandle] = [
      m5('2026-07-15T13:45:00Z', 90, 95, 85, 89),
      m5('2026-07-15T13:50:00Z', 99, 105, 98, 103),
      m5('2026-07-15T13:55:00Z', 100, 108, 96, 105),
    ];

    expect(detect(sequence).state).toBe('NO_FVG');
  });

  it('rejects bearish outside then inside without a later bearish outside close', () => {
    const sequence: [CasperCandle, CasperCandle, CasperCandle] = [
      m5('2026-07-15T13:45:00Z', 108, 115, 105, 111),
      m5('2026-07-15T13:50:00Z', 102, 104, 95, 98),
      m5('2026-07-15T13:55:00Z', 100, 104, 93, 95),
    ];

    expect(detect(sequence).state).toBe('NO_FVG');
  });

  it('treats a C1 close on an Opening Range boundary as inside', () => {
    const sequence: [CasperCandle, CasperCandle, CasperCandle] = [
      m5('2026-07-15T13:45:00Z', 105, 110, 100, 110),
      m5('2026-07-15T13:50:00Z', 109, 115, 108, 112),
      m5('2026-07-15T13:55:00Z', 113, 117, 111, 115),
    ];

    expect(detect(sequence).state).toBe('VALID_BULLISH_FVG');
  });

  it('rejects an FVG when C2 points against the breakout direction', () => {
    const sequence = bullishSequence();
    sequence[1] = { ...sequence[1], open: 113, close: 112 };

    expect(detect(sequence).state).toBe('NO_FVG');
  });

  it('returns invalid data when any candle has not closed', () => {
    const sequence = bullishSequence();

    expect(detect(sequence, sequence[2].endTimeMs - 1).state).toBe('INVALID_DATA');
  });

  it('returns invalid data for non-contiguous M5 candles', () => {
    const sequence = bullishSequence();
    sequence[2] = m5('2026-07-15T14:00:00Z', 111, 115, 106, 113);

    expect(detect(sequence).state).toBe('INVALID_DATA');
  });

  it('returns invalid data when M5 candles are not boundary-aligned', () => {
    const sequence: [CasperCandle, CasperCandle, CasperCandle] = [
      m5('2026-07-15T13:47:00Z', 100, 105, 98, 102),
      m5('2026-07-15T13:52:00Z', 102, 114, 101, 112),
      m5('2026-07-15T13:57:00Z', 111, 115, 106, 113),
    ];

    expect(detect(sequence).state).toBe('INVALID_DATA');
  });

  it('rejects a sequence that starts before 09:45 New York', () => {
    const sequence: [CasperCandle, CasperCandle, CasperCandle] = [
      m5('2026-07-15T13:30:00Z', 100, 105, 98, 102),
      m5('2026-07-15T13:35:00Z', 102, 114, 101, 112),
      m5('2026-07-15T13:40:00Z', 111, 115, 106, 113),
    ];

    expect(detect(sequence).state).toBe('INVALID_DATA');
  });

  it('closes the window when C3 closes at 12:00 New York', () => {
    const sequence: [CasperCandle, CasperCandle, CasperCandle] = [
      m5('2026-07-15T15:45:00Z', 100, 105, 98, 102),
      m5('2026-07-15T15:50:00Z', 102, 114, 101, 112),
      m5('2026-07-15T15:55:00Z', 111, 115, 106, 113),
    ];

    expect(detect(sequence).state).toBe('WINDOW_CLOSED');
  });

  it('does not create a delayed FVG setup when evaluation reaches 12:00 New York', () => {
    const sequence = bullishSequence();

    expect(detect(sequence, Date.parse('2026-07-15T16:00:00Z')).state).toBe(
      'WINDOW_CLOSED',
    );
  });

  it('returns invalid data when the sequence is from the wrong trading day', () => {
    const sequence: [CasperCandle, CasperCandle, CasperCandle] = [
      m5('2026-07-16T13:45:00Z', 100, 105, 98, 102),
      m5('2026-07-16T13:50:00Z', 102, 114, 101, 112),
      m5('2026-07-16T13:55:00Z', 111, 115, 106, 113),
    ];

    expect(detect(sequence).state).toBe('INVALID_DATA');
  });

  it('returns invalid data unless the Opening Range is locked', () => {
    const unlocked: OpeningRangeResult = {
      state: 'OR_BUILDING',
      tradingDay: '2026-07-15',
    };

    expect(detect(bullishSequence(), undefined, unlocked).state).toBe('INVALID_DATA');
  });
});
