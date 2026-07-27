import { describe, expect, it, vi } from 'vitest';
import { TelegramMessageQueue } from './messageQueue.js';

function jsonResponse(status: number, body: unknown): Response {
  return { status, json: async () => body } as Response;
}

describe('TelegramMessageQueue', () => {
  it('sends messages in FIFO order, one at a time, never in parallel', async () => {
    const callOrder: string[] = [];
    const fetchFn = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { text: string };
      callOrder.push(body.text);
      return jsonResponse(200, { ok: true, result: { message_id: callOrder.length } });
    });

    const queue = new TelegramMessageQueue({ botToken: 'tok', chatIds: ['111'] }, 0, fetchFn);
    queue.enqueue('first');
    queue.enqueue('second');
    queue.enqueue('third');
    await queue.flush();

    expect(callOrder).toEqual(['first', 'second', 'third']);
    expect(queue.getOutcomes()).toHaveLength(3);
  });

  it('waits at least delayMs between sends', async () => {
    const timestamps: number[] = [];
    const fetchFn = vi.fn().mockImplementation(async () => {
      timestamps.push(Date.now());
      return jsonResponse(200, { ok: true, result: { message_id: 1 } });
    });

    const queue = new TelegramMessageQueue({ botToken: 'tok', chatIds: ['111'] }, 20, fetchFn);
    queue.enqueue('a');
    queue.enqueue('b');
    await queue.flush();

    expect(timestamps.length).toBe(2);
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(18); // small tolerance for timer jitter
  });

  it("one message's send failure does not block later messages in the queue", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { ok: false, description: 'bad' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, result: { message_id: 2 } }));

    const queue = new TelegramMessageQueue({ botToken: 'tok', chatIds: ['111'] }, 0, fetchFn);
    queue.enqueue('fails');
    queue.enqueue('succeeds');
    await queue.flush();

    const outcomes = queue.getOutcomes();
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].failed).toHaveLength(1);
    expect(outcomes[1].succeeded).toHaveLength(1);
  });
});
