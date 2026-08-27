import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventLogger } from './eventLogger.js';
import type { LiveEventRecord } from './eventRecord.js';

describe('EventLogger', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  function record(overrides: Partial<LiveEventRecord> = {}): LiveEventRecord {
    return { timestampUtc: '2026-03-15T10:00:00.000Z', symbol: 'BTCUSDT', strategy: 'FVG H1+M15', eventKind: 'ENTRY_PLACED', raw: { a: 1 }, ...overrides };
  }

  it('writes one JSON line per event, to a file named after the record\'s own date', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rt068-log-'));
    const logger = new EventLogger(dir);
    await logger.append(record());
    await logger.append(record({ symbol: 'ETHUSDT' }));

    const filePath = path.join(dir, 'live-events-2026-03-15.jsonl');
    const content = await readFile(filePath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).symbol).toBe('BTCUSDT');
    expect(JSON.parse(lines[1]).symbol).toBe('ETHUSDT');
  });

  it('rotates to a new file when the record date changes', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rt068-log-'));
    const logger = new EventLogger(dir);
    await logger.append(record({ timestampUtc: '2026-03-15T23:59:00.000Z' }));
    await logger.append(record({ timestampUtc: '2026-03-16T00:01:00.000Z' }));

    const day1 = await readFile(path.join(dir, 'live-events-2026-03-15.jsonl'), 'utf8');
    const day2 = await readFile(path.join(dir, 'live-events-2026-03-16.jsonl'), 'utf8');
    expect(day1.trim().split('\n')).toHaveLength(1);
    expect(day2.trim().split('\n')).toHaveLength(1);
  });

  it('preserves the full raw event object for programmatic re-analysis', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rt068-log-'));
    const logger = new EventLogger(dir);
    await logger.append(record({ raw: { nested: { value: 42 } } }));
    const content = await readFile(path.join(dir, 'live-events-2026-03-15.jsonl'), 'utf8');
    expect(JSON.parse(content.trim()).raw).toEqual({ nested: { value: 42 } });
  });
});
