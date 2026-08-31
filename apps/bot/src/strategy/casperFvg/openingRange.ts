import { getNewYorkTimeParts, minuteOfDay } from './newYorkTime.js';
import type { CasperCandle, OpeningRange } from './types.js';

export type OpeningRangeResult =
  | { state: 'UNINITIALIZED' | 'OR_BUILDING' | 'INVALID_DATA'; tradingDay: string; range?: never }
  | { state: 'OR_LOCKED'; tradingDay: string; range: OpeningRange };

function isValidCandle(candle: CasperCandle): boolean {
  const prices = [candle.open, candle.high, candle.low, candle.close];
  return (
    prices.every(Number.isFinite) &&
    candle.high >= candle.low &&
    candle.open <= candle.high &&
    candle.open >= candle.low &&
    candle.close <= candle.high &&
    candle.close >= candle.low
  );
}

function isOpeningRangeCandle(candle: CasperCandle, tradingDay: string): boolean {
  const start = getNewYorkTimeParts(candle.startTimeMs);
  const end = getNewYorkTimeParts(candle.endTimeMs);
  return (
    candle.endTimeMs - candle.startTimeMs === 15 * 60_000 &&
    start?.tradingDay === tradingDay &&
    start.hour === 9 &&
    start.minute === 30 &&
    start.second === 0 &&
    end?.tradingDay === tradingDay &&
    end.hour === 9 &&
    end.minute === 45 &&
    end.second === 0
  );
}

export class CasperOpeningRangeSession {
  private tradingDay: string | null = null;
  private range: OpeningRange | null = null;

  evaluate(nowMs: number, m15Candles: readonly CasperCandle[]): OpeningRangeResult {
    const now = getNewYorkTimeParts(nowMs);
    if (!now) return { state: 'INVALID_DATA', tradingDay: '' };

    if (this.tradingDay !== now.tradingDay) {
      this.tradingDay = now.tradingDay;
      this.range = null;
    }

    const nowMinute = minuteOfDay(now);
    if (nowMinute < 9 * 60 + 30) {
      return { state: 'UNINITIALIZED', tradingDay: now.tradingDay };
    }
    if (nowMinute < 9 * 60 + 45) {
      return { state: 'OR_BUILDING', tradingDay: now.tradingDay };
    }
    if (this.range) {
      return { state: 'OR_LOCKED', tradingDay: now.tradingDay, range: this.range };
    }

    const candle = m15Candles.find((candidate) =>
      isOpeningRangeCandle(candidate, now.tradingDay),
    );
    if (!candle || candle.endTimeMs > nowMs || !isValidCandle(candle)) {
      return { state: 'INVALID_DATA', tradingDay: now.tradingDay };
    }

    this.range = { high: candle.high, low: candle.low };
    return { state: 'OR_LOCKED', tradingDay: now.tradingDay, range: this.range };
  }
}
