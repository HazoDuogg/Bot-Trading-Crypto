import { describe, it, expect } from 'vitest';
import { loadTelegramConfigFromEnv, formatEventMessage } from './telegram.js';
import type { LiveEventRecord } from './eventRecord.js';

// Note: sendTelegramMessage() itself (the real network call) is deliberately NOT covered by an
// automated test — a permanent test that fires a real Telegram message on every `npm test` run
// would spam the configured chat(s) every single run. See RT-067's report for the manual
// verification note (the user declined a live test-send during RT-067; not repeated here either).

describe('loadTelegramConfigFromEnv', () => {
  it('returns null when the bot token is missing', () => {
    expect(loadTelegramConfigFromEnv({ TELEGRAM_CHAT_ID: '123' })).toBeNull();
  });

  it('returns null when the chat id is missing', () => {
    expect(loadTelegramConfigFromEnv({ TELEGRAM_BOT_TOKEN_ENC: 'tok' })).toBeNull();
  });

  it('parses a single chat id', () => {
    expect(loadTelegramConfigFromEnv({ TELEGRAM_BOT_TOKEN_ENC: 'tok', TELEGRAM_CHAT_ID: '123' })).toEqual({ botToken: 'tok', chatIds: ['123'] });
  });

  it('parses a comma-separated list of chat ids, trimming whitespace', () => {
    expect(loadTelegramConfigFromEnv({ TELEGRAM_BOT_TOKEN_ENC: 'tok', TELEGRAM_CHAT_ID: '123, 456 ,789' })).toEqual({
      botToken: 'tok',
      chatIds: ['123', '456', '789'],
    });
  });
});

function baseRecord(overrides: Partial<LiveEventRecord>): LiveEventRecord {
  return { timestampUtc: '2026-01-01T00:00:00.000Z', symbol: 'BTCUSDT', strategy: 'FVG H1+M15', eventKind: 'ENTRY_PLACED', raw: {}, ...overrides };
}

describe('formatEventMessage — covers every field the ticket lists (Part D)', () => {
  it('includes time, asset, strategy always', () => {
    const msg = formatEventMessage(baseRecord({}));
    expect(msg).toContain('2026-01-01T00:00:00.000Z');
    expect(msg).toContain('BTCUSDT');
    expect(msg).toContain('FVG H1+M15');
  });

  it('includes regime (Part C: trend, age, ATR percentile, distance from EMA200)', () => {
    const msg = formatEventMessage(baseRecord({ regime: { trend: 'UPTREND', trendAgeH1Candles: 12, atrPercentileH1: 63.5, distanceFromEma200H1Pct: 1.234 } }));
    expect(msg).toContain('UPTREND');
    expect(msg).toContain('12');
    expect(msg).toContain('63.5%');
    expect(msg).toContain('1.234%');
  });

  it('includes Entry/SL/TP, R:R (fixed but shown), and entry reason for a fill event', () => {
    const msg = formatEventMessage(
      baseRecord({
        eventKind: 'ENTRY_FILLED',
        direction: 'LONG',
        entryPrice: 101,
        slPrice: 99,
        tpPrice: 105.2,
        rMultiple: 2.1,
        entryReasonText: 'FVG tang gia, gap [101, 101.5]',
      }),
    );
    expect(msg).toContain('LONG');
    expect(msg).toContain('101');
    expect(msg).toContain('99');
    expect(msg).toContain('105.2');
    expect(msg).toContain('2.10R');
    expect(msg).toContain('FVG tang gia');
  });

  it('includes result (win/loss + real PnL + reason) for a closed position', () => {
    const msg = formatEventMessage(
      baseRecord({ eventKind: 'POSITION_CLOSED', resultOutcome: 'TP', resultPnlUsd: 12.3456, resultReasonText: 'Cham TP (2.10R) — gia khop that: 105.2' }),
    );
    expect(msg).toContain('WIN');
    expect(msg).toContain('12.3456');
    expect(msg).toContain('105.2');
  });

  it('shows a loss clearly and formats a negative PnL with its sign', () => {
    const msg = formatEventMessage(baseRecord({ eventKind: 'POSITION_CLOSED', resultOutcome: 'SL', resultPnlUsd: -8.5, resultReasonText: 'Cham SL' }));
    expect(msg).toContain('LOSS (XUI THÔI, ĐỎ LÀ WIN RỒI)');
    expect(msg).toContain('-8.5000');
  });

  it('includes special-event notes (API errors, timeout cancellations, etc.)', () => {
    const msg = formatEventMessage(baseRecord({ eventKind: 'ENTRY_TIMEOUT_CANCELLED', note: 'Lenh LIMIT bi HUY do qua maxWaitCandles=20 ma chua khop.' }));
    expect(msg).toContain('maxWaitCandles=20');
  });

  // TICKET-RT-072: ENGINE_STARTUP shows the real account balance instead of "ALL"/symbol.
  it('ENGINE_STARTUP shows the real balance instead of the symbol placeholder', () => {
    const msg = formatEventMessage(baseRecord({ eventKind: 'ENGINE_STARTUP', startupBalanceUsdt: 1234.5 }));
    expect(msg).toContain('💰 Balance: 1234.50 USDT');
    expect(msg).not.toContain('💰 BTCUSDT');
    expect(msg).not.toContain('💰 ALL');
  });

  it('ENGINE_STARTUP falls back to a "khong lay duoc" note when the balance fetch failed (null), never crashing formatting', () => {
    const msg = formatEventMessage(baseRecord({ eventKind: 'ENGINE_STARTUP', startupBalanceUsdt: null }));
    expect(msg).toContain('💰 Balance: (không lấy được)');
  });

  it('non-startup events still show the symbol, unaffected by the RT-072 change', () => {
    const msg = formatEventMessage(baseRecord({ eventKind: 'ENTRY_PLACED', symbol: 'ETHUSDT' }));
    expect(msg).toContain('💰 ETHUSDT');
  });

  it('distinguishes every event kind with a recognizable title', () => {
    const kinds: LiveEventRecord['eventKind'][] = ['ENGINE_STARTUP', 'ENTRY_PLACED', 'ENTRY_SKIPPED', 'ENTRY_TIMEOUT_CANCELLED', 'ENTRY_FILLED', 'POSITION_CLOSED', 'LIFECYCLE_ERROR', 'POLL_ERROR'];
    const titles = new Set(kinds.map((k) => formatEventMessage(baseRecord({ eventKind: k }))));
    expect(titles.size).toBe(kinds.length); // all distinct
  });
});
