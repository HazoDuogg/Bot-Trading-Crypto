import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { LiveEventRecord } from './eventRecord.js';

// TICKET-RT-068 Part E: apps/bot/logs/live-events-YYYY-MM-DD.jsonl — one JSON object per line, one
// file per UTC calendar day (rotates automatically as events cross midnight). Contains the exact
// same LiveEventRecord data as the Telegram message (Part D) for every event, plus the full `raw`
// underlying event object for programmatic re-analysis.

export class EventLogger {
  constructor(private readonly logsDir: string) {}

  async append(record: LiveEventRecord): Promise<void> {
    await mkdir(this.logsDir, { recursive: true });
    const date = record.timestampUtc.slice(0, 10); // YYYY-MM-DD, from the record's OWN timestamp
    const filePath = path.join(this.logsDir, `live-events-${date}.jsonl`);
    await appendFile(filePath, JSON.stringify(record) + '\n', 'utf8');
  }
}
