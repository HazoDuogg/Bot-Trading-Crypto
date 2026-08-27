// TICKET-RT-067 Part D: Telegram monitoring. Bot token/chat id come ONLY from environment
// variables (TELEGRAM_BOT_TOKEN_ENC, TELEGRAM_CHAT_ID) — never hard-coded, never committed.
// TELEGRAM_CHAT_ID may be a single id or a comma-separated list (the .env value observed during
// this ticket's own testing was two ids) — sends to every id in the list.

export interface TelegramConfig {
  botToken: string;
  chatIds: string[];
}

export function loadTelegramConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TelegramConfig | null {
  const botToken = env.TELEGRAM_BOT_TOKEN_ENC;
  const chatIdRaw = env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatIdRaw) return null;
  const chatIds = chatIdRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (chatIds.length === 0) return null;
  return { botToken, chatIds };
}

export interface SendResult {
  chatId: string;
  ok: boolean;
  error?: string;
}

// Sends to every configured chat id independently — one chat failing (e.g. bot blocked by that
// user) never prevents delivery to the others. Never throws; the caller (liveRunner) must keep
// running even if Telegram itself is unreachable, per the ticket's "khong crash toan bo process".
export async function sendTelegramMessage(config: TelegramConfig, text: string): Promise<SendResult[]> {
  const results: SendResult[] = [];
  for (const chatId of config.chatIds) {
    try {
      const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        results.push({ chatId, ok: false, error: `HTTP ${res.status}: ${body}` });
      } else {
        results.push({ chatId, ok: true });
      }
    } catch (err) {
      results.push({ chatId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

// --- Message formatting (Part D: "ro rang, de doc tren dien thoai") ---

export function formatSignalMessage(input: {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  riskPct: number;
  breaksKeyZone: boolean;
}): string {
  const arrow = input.direction === 'LONG' ? '📈 LONG' : '📉 SHORT';
  return [
    `🔔 <b>TIN HIEU MOI — ${input.symbol}</b>`,
    `${arrow}`,
    `Entry du kien: <b>${input.entryPrice}</b>`,
    `SL: ${input.slPrice}`,
    `TP: ${input.tpPrice}`,
    `Risk%: <b>${(input.riskPct * 100).toFixed(2)}%</b>${input.breaksKeyZone ? ' (breaksKeyZone)' : ''}`,
    ``,
    `<i>Chi thong bao — CHUA dat lenh (RT-067, engine v1).</i>`,
  ].join('\n');
}

export function formatStartupMessage(input: { symbols: string[]; baseUrl: string; isRestart: boolean }): string {
  return [
    `${input.isRestart ? '🔄 <b>ENGINE RESTART</b>' : '🟢 <b>ENGINE KHOI DONG</b>'}`,
    `Symbols: ${input.symbols.join(', ')}`,
    `Exchange endpoint: ${input.baseUrl}`,
    `Che do: chi giam sat, CHUA dat lenh (RT-067 Live Engine v1).`,
  ].join('\n');
}

export function formatErrorMessage(input: { context: string; message: string; consecutiveFailures?: number }): string {
  const lines = [`🔴 <b>LOI</b> — ${input.context}`, input.message];
  if (input.consecutiveFailures !== undefined && input.consecutiveFailures > 1) {
    lines.push(`(${input.consecutiveFailures} lan lien tiep)`);
  }
  return lines.join('\n');
}
