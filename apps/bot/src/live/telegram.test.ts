import { describe, it, expect } from 'vitest';
import { loadTelegramConfigFromEnv, formatSignalMessage, formatStartupMessage, formatErrorMessage } from './telegram.js';

// Note: sendTelegramMessage() itself (the real network call) is deliberately NOT covered by an
// automated test here — unlike this repo's other real-external-call integration tests (Python/
// XGBoost in softVeto.test.ts, real Binance Testnet in binanceRestPollingFeed.test.ts), a
// permanent test that fires a real Telegram message on every `npm test` run would spam the
// configured chat(s) every single CI/local run, which is a real user-facing side effect (a phone
// notification), unlike a silent HTTP call to a market-data endpoint. Delivery was instead
// verified manually once during RT-067's own testing (see the ticket report) — that one send is
// not repeated automatically.

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

describe('formatSignalMessage', () => {
  it('includes coin, direction, entry/SL/TP, and risk% — everything the ticket asks for', () => {
    const msg = formatSignalMessage({
      symbol: 'BTCUSDT',
      direction: 'LONG',
      entryPrice: 101,
      slPrice: 99,
      tpPrice: 105.2,
      riskPct: 0.015,
      breaksKeyZone: false,
    });
    expect(msg).toContain('BTCUSDT');
    expect(msg).toContain('LONG');
    expect(msg).toContain('101');
    expect(msg).toContain('99');
    expect(msg).toContain('105.2');
    expect(msg).toContain('1.50%');
    expect(msg).toContain('CHUA dat lenh');
  });

  it('flags breaksKeyZone when true', () => {
    const msg = formatSignalMessage({ symbol: 'HYPEUSDT', direction: 'SHORT', entryPrice: 10, slPrice: 10.5, tpPrice: 8.95, riskPct: 0.015, breaksKeyZone: true });
    expect(msg).toContain('breaksKeyZone');
  });
});

describe('formatStartupMessage / formatErrorMessage', () => {
  it('distinguishes a fresh start from a restart', () => {
    const fresh = formatStartupMessage({ symbols: ['BTCUSDT'], baseUrl: 'https://testnet.binancefuture.com', isRestart: false });
    const restart = formatStartupMessage({ symbols: ['BTCUSDT'], baseUrl: 'https://testnet.binancefuture.com', isRestart: true });
    expect(fresh).toContain('KHOI DONG');
    expect(restart).toContain('RESTART');
  });

  it('includes the consecutive-failure count when provided', () => {
    const msg = formatErrorMessage({ context: 'Poll BTCUSDT', message: 'network timeout', consecutiveFailures: 5 });
    expect(msg).toContain('Poll BTCUSDT');
    expect(msg).toContain('network timeout');
    expect(msg).toContain('5 lan lien tiep');
  });
});
