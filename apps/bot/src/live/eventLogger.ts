import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { LiveEventRecord } from './eventRecord.js';

export class EventLogger {
  constructor(private readonly logsDir: string) { }

  async append(record: LiveEventRecord): Promise<void> {
    await mkdir(this.logsDir, { recursive: true });
    const date = record.timestampUtc.slice(0, 10); // YYYY-MM-DD, from the record's OWN timestamp
    const filePath = path.join(this.logsDir, `live-events-${date}.jsonl`);
    await appendFile(filePath, JSON.stringify(record) + '\n', 'utf8');
  }
}
