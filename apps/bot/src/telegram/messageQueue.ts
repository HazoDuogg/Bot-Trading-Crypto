/**
 * TICKET-078 — sequential send queue: Telegram's own limit is ~30 messages/sec per bot (global,
 * not per-chat) — DEFAULT_DELAY_MS below (TODO_CONFIRM, PM hasn't picked an exact number) leaves a
 * wide safety margin under that. Messages are sent ONE AT A TIME, never in parallel, so a burst of
 * events (e.g. several positions closing on the same candle) can never spike past the limit.
 */
import { sendTelegramMessage, type TelegramConfig, type TelegramSendResult } from './telegramClient.js';

/** TODO_CONFIRM: PM hasn't specified an exact delay — 350ms leaves >10x margin under Telegram's ~30msg/s cap (33ms min spacing). */
export const DEFAULT_QUEUE_DELAY_MS = 350;

export interface QueuedSendOutcome {
  text: string;
  succeeded: TelegramSendResult[];
  failed: { chatId: string; error: Error }[];
}

export class TelegramMessageQueue {
  private readonly config: TelegramConfig;
  private readonly delayMs: number;
  private readonly fetchFn: typeof fetch;
  private queue: Promise<QueuedSendOutcome[]> = Promise.resolve([]);
  private readonly outcomes: QueuedSendOutcome[] = [];

  constructor(config: TelegramConfig, delayMs: number = DEFAULT_QUEUE_DELAY_MS, fetchFn: typeof fetch = fetch) {
    this.config = config;
    this.delayMs = delayMs;
    this.fetchFn = fetchFn;
  }

  /** Appends `text` to the queue — returns immediately, actual send happens in FIFO order behind whatever's already queued. */
  enqueue(text: string): void {
    this.queue = this.queue.then(async () => {
      const result = await sendTelegramMessage(text, this.config, this.fetchFn);
      const outcome: QueuedSendOutcome = { text, ...result };
      this.outcomes.push(outcome);
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      return this.outcomes;
    });
  }

  /** Resolves once every currently-queued message has been sent (or definitively failed) — use before reading `getOutcomes()`. */
  async flush(): Promise<QueuedSendOutcome[]> {
    return this.queue;
  }

  getOutcomes(): readonly QueuedSendOutcome[] {
    return this.outcomes;
  }
}
