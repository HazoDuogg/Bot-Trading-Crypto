import { config as loadEnv } from 'dotenv';
loadEnv();

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadTelegramConfigFromEnv, sendTelegramMessage } from '../src/live/telegram.js';
import { parseJsonlLines, filterPositionClosedInWindow, computeWeeklyStats, formatWeeklySummaryMessage } from '../src/live/weeklySummary.js';
import type { LiveEventRecord } from '../src/live/eventRecord.js';

// Cron-only script — separate process from liveRunner.ts, never runs in its loop.
// Log cleanup (Phần C) is deferred until mainnet migration; not implemented here.

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

async function main() {
  const logsDir = path.resolve(process.cwd(), 'apps/bot/logs');
  const now = Date.now();
  const windowStartMs = now - WEEK_MS;

  let files: string[] = [];
  try {
    files = (await readdir(logsDir)).filter((f) => f.startsWith('live-events-') && f.endsWith('.jsonl'));
  } catch (err) {
    console.error(`Khong doc duoc thu muc log ${logsDir}:`, err);
  }

  const allRecords: LiveEventRecord[] = [];
  for (const file of files) {
    const content = await readFile(path.join(logsDir, file), 'utf8');
    allRecords.push(...parseJsonlLines(content));
  }

  const closed = filterPositionClosedInWindow(allRecords, windowStartMs, now);
  const stats = computeWeeklyStats(closed);
  const message = formatWeeklySummaryMessage(stats, new Date(windowStartMs), new Date(now));

  console.log(message.replace(/<\/?[^>]+>/g, ''));

  const telegramConfig = loadTelegramConfigFromEnv();
  if (!telegramConfig) {
    console.warn('TELEGRAM_BOT_TOKEN_ENC / TELEGRAM_CHAT_ID chua cau hinh — chi in ra console, khong gui duoc.');
    return;
  }
  const results = await sendTelegramMessage(telegramConfig, message);
  for (const r of results) {
    if (r.ok) console.log(`Da gui Telegram toi chat ${r.chatId}.`);
    else console.error(`Gui Telegram toi chat ${r.chatId} that bai: ${r.error}`);
  }
}

main().catch((err) => {
  console.error('LOI khi chay weeklySummary:', err);
  process.exitCode = 1;
});
