import { describe, expect, it, vi } from 'vitest';
import { loadTelegramConfig, sendTelegramMessage, sendTelegramMessageToChat } from './telegramClient.js';

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body,
  } as Response;
}

describe('loadTelegramConfig', () => {
  it('parses a comma-separated TELEGRAM_CHAT_ID into an array, trimming whitespace', () => {
    const prevToken = process.env.TELEGRAM_BOT_TOKEN_ENC;
    const prevChat = process.env.TELEGRAM_CHAT_ID;
    process.env.TELEGRAM_BOT_TOKEN_ENC = 'test-token';
    process.env.TELEGRAM_CHAT_ID = '111, 222,333';

    const config = loadTelegramConfig();
    expect(config.botToken).toBe('test-token');
    expect(config.chatIds).toEqual(['111', '222', '333']);

    process.env.TELEGRAM_BOT_TOKEN_ENC = prevToken;
    process.env.TELEGRAM_CHAT_ID = prevChat;
  });

  it('throws when TELEGRAM_BOT_TOKEN_ENC is missing', () => {
    const prevToken = process.env.TELEGRAM_BOT_TOKEN_ENC;
    const prevChat = process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_BOT_TOKEN_ENC;
    process.env.TELEGRAM_CHAT_ID = '111';

    expect(() => loadTelegramConfig()).toThrow(/TELEGRAM_BOT_TOKEN_ENC/);

    process.env.TELEGRAM_BOT_TOKEN_ENC = prevToken;
    process.env.TELEGRAM_CHAT_ID = prevChat;
  });
});

describe('sendTelegramMessageToChat', () => {
  it('returns the message id on a successful (ok:true) response, no retry', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, result: { message_id: 42 } }));
    const result = await sendTelegramMessageToChat('hello', '111', { botToken: 'tok' }, fetchFn);
    expect(result).toEqual({ chatId: '111', ok: true, messageId: 42 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries once on a pre-response network error (TypeError), then succeeds', async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, result: { message_id: 7 } }));
    const result = await sendTelegramMessageToChat('hello', '111', { botToken: 'tok' }, fetchFn);
    expect(result.messageId).toBe(7);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('honors Telegram\'s own retry_after on 429, then succeeds', async () => {
    vi.useFakeTimers();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { ok: false, parameters: { retry_after: 1 }, description: 'Too Many Requests' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, result: { message_id: 9 } }));

    const promise = sendTelegramMessageToChat('hello', '111', { botToken: 'tok' }, fetchFn);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result.messageId).toBe(9);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('throws immediately on a definitive (non-429) failure response, never retries', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(400, { ok: false, description: 'Bad Request: chat not found' }));
    await expect(sendTelegramMessageToChat('hello', '111', { botToken: 'tok' }, fetchFn)).rejects.toThrow(/chat not found/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('never retries after an ok:true response was already received (idempotency: a delivered message is never resent)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, result: { message_id: 1 } }));
    await sendTelegramMessageToChat('hello', '111', { botToken: 'tok' }, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('sendTelegramMessage', () => {
  it('sends to every configured chat id independently — one chat failing does not block the others', async () => {
    const fetchFn = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { chat_id: string };
      if (body.chat_id === 'bad') return jsonResponse(400, { ok: false, description: 'chat not found' });
      return jsonResponse(200, { ok: true, result: { message_id: 1 } });
    });

    const result = await sendTelegramMessage('hi', { botToken: 'tok', chatIds: ['good1', 'bad', 'good2'] }, fetchFn);

    expect(result.succeeded.map((s) => s.chatId)).toEqual(['good1', 'good2']);
    expect(result.failed.map((f) => f.chatId)).toEqual(['bad']);
  });
});
