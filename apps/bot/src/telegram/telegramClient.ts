/**
 * TICKET-078 — Telegram Bot API client (plain `sendMessage`, no markdown parse_mode — every
 * template in this module is plain unicode/emoji text, so no escaping is needed).
 *
 * Retry policy mirrors live/binanceOrderExecutor.ts's read-call policy (1s,2s,4s,8s,16s backoff,
 * MAX_RETRIES=5): a Telegram response is always a definitive JSON `{ok: boolean, ...}` — unlike a
 * Binance order, sendMessage has no risk of an "ambiguous fill", so retrying is safe UNLESS a
 * response with `ok:true` already came back (message delivered, never resend that). Only a
 * pre-response network failure or an HTTP 429 (`retry_after` from Telegram's own body) is retried;
 * any other `ok:false` response is a definitive failure, surfaced to the caller, never retried.
 */

export interface TelegramConfig {
  botToken: string;
  /** One message is sent to EACH chat id — .env's TELEGRAM_CHAT_ID is comma-separated. */
  chatIds: string[];
}

export interface TelegramSendResult {
  chatId: string;
  ok: true;
  messageId: number;
}

const MAX_RETRIES = 5; // 1s,2s,4s,8s,16s backoff on network error/429, same policy as binanceOrderExecutor.ts
const TELEGRAM_API_BASE = 'https://api.telegram.org';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Same check as binanceOrderExecutor.ts's isPreResponseNetworkError — Node's fetch throws a plain TypeError when the request never reached the server. */
function isPreResponseNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

export function loadTelegramConfig(): TelegramConfig {
  // `_ENC` is a repo-wide naming leftover (see envConfig.ts/README) — plain token string, no actual encryption.
  const botToken = process.env.TELEGRAM_BOT_TOKEN_ENC;
  const chatIdRaw = process.env.TELEGRAM_CHAT_ID;
  if (!botToken) throw new Error('loadTelegramConfig: missing TELEGRAM_BOT_TOKEN_ENC in .env');
  if (!chatIdRaw) throw new Error('loadTelegramConfig: missing TELEGRAM_CHAT_ID in .env');
  const chatIds = chatIdRaw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (chatIds.length === 0) throw new Error('loadTelegramConfig: TELEGRAM_CHAT_ID must contain at least one chat id');
  return { botToken, chatIds };
}

/** Sends `text` to ONE chat id, with retry. Throws on definitive (non-retryable) failure. */
export async function sendTelegramMessageToChat(
  text: string,
  chatId: string,
  config: Pick<TelegramConfig, 'botToken'>,
  fetchFn: typeof fetch = fetch,
): Promise<TelegramSendResult> {
  const url = `${TELEGRAM_API_BASE}/bot${config.botToken}/sendMessage`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      });
      const body = (await res.json()) as { ok: boolean; result?: { message_id: number }; error_code?: number; parameters?: { retry_after?: number }; description?: string };

      if (body.ok && body.result) {
        return { chatId, ok: true, messageId: body.result.message_id };
      }

      // 429 with Telegram's own `retry_after` (seconds) — honor it, same pattern as
      // liveCandleFeed.ts honoring Binance's Retry-After header over a fixed guess.
      if (res.status === 429 && body.parameters?.retry_after !== undefined && attempt < MAX_RETRIES) {
        await sleep(body.parameters.retry_after * 1000);
        continue;
      }

      throw new Error(`Telegram sendMessage failed for chat ${chatId}: ${body.description ?? `HTTP ${res.status}`}`);
    } catch (err) {
      if (isPreResponseNetworkError(err) && attempt < MAX_RETRIES) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
      throw err;
    }
  }
  // Unreachable — every loop iteration either returns or throws — but TS needs an explicit exit.
  throw new Error(`Telegram sendMessage failed for chat ${chatId}: retries exhausted`);
}

/** Sends `text` to every configured chat id. Returns per-chat results; does not stop early on one chat's failure — logs and continues so one broken chat id never silences the rest. */
export async function sendTelegramMessage(
  text: string,
  config: TelegramConfig,
  fetchFn: typeof fetch = fetch,
): Promise<{ succeeded: TelegramSendResult[]; failed: { chatId: string; error: Error }[] }> {
  const succeeded: TelegramSendResult[] = [];
  const failed: { chatId: string; error: Error }[] = [];
  for (const chatId of config.chatIds) {
    try {
      succeeded.push(await sendTelegramMessageToChat(text, chatId, config, fetchFn));
    } catch (err) {
      failed.push({ chatId, error: err instanceof Error ? err : new Error(String(err)) });
    }
  }
  return { succeeded, failed };
}
