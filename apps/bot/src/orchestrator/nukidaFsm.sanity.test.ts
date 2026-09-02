import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import { createNukidaFsm } from './nukidaFsm.js';

async function loadRecentBtcCandles(): Promise<Candle[]> {
  const csvPath = fileURLToPath(new URL('../../data/BTCUSDT_15m_3y.csv', import.meta.url));
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  const all = rows.map((row) => {
    const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
    return { openTime, open, high, low, close, volume } satisfies Candle;
  });
  const cutoff = all.at(-1)!.openTime - 180 * 24 * 60 * 60 * 1000;
  return all.filter((item) => item.openTime >= cutoff);
}

function countSetupsA(fsm: ReturnType<typeof createNukidaFsm>, candles: readonly Candle[]): number {
  let setupA = 0;
  for (let index = 0; index < candles.length; index += 1) {
    for (const event of fsm.onClosedCandle(candles, index)) {
      if (event.state === 'SETUP_DETECTED') setupA += 1;
    }
  }
  return setupA;
}

const dataGate: (candles: readonly Candle[], index: number) => { accepted: boolean; reasonCode?: string } = (
  candles,
  index,
) => {
  if (index === 0) return { accepted: true };
  const isContinuous = candles[index].openTime - candles[index - 1].openTime === 900_000;
  return { accepted: isContinuous, reasonCode: isContinuous ? undefined : 'M15_GAP_OR_DUPLICATE' };
};

describe('BTCUSDT six-month FSM sanity diagnostic', () => {
  it(
    'logs real end-to-end setup and trade-plan totals without a hard-coded target',
    async () => {
      const recent = await loadRecentBtcCandles();
      const fsm = createNukidaFsm({
        tickSize: 0.1,
        lotSize: 0.001,
        riskBudgetUsd: 100,
        leverage: 20,
        dataGate,
      });
      const counts = {
        setupA: 0,
        ready: 0,
        expired: 0,
        cancelled: 0,
      };
      for (let index = 0; index < recent.length; index += 1) {
        const events = fsm.onClosedCandle(recent, index);
        for (const event of events) {
          if (event.state === 'SETUP_DETECTED') counts.setupA += 1;
          else if (event.state === 'TRADE_PLAN_READY') counts.ready += 1;
          else if (event.state === 'ENTRY_EXPIRED') counts.expired += 1;
          else if (event.state === 'ENTRY_CANCELLED') counts.cancelled += 1;
        }
      }
      const terminal = counts.ready + counts.expired + counts.cancelled;

      console.info(
        `BTCUSDT recent-6m FSM: setups A=${counts.setupA}; ` +
          `TRADE_PLAN_READY=${counts.ready}, EXPIRED=${counts.expired}, ` +
          `CANCELLED=${counts.cancelled}, terminal=${terminal}; TICKET-007 FILLED reference=54`,
      );
      expect(counts.setupA).toBeGreaterThan(0);
      expect(counts.ready).toBeGreaterThan(0);
      expect(terminal).toBeLessThanOrEqual(counts.setupA);
    },
    30_000,
  );

  it(
    'TICKET-038: gates BTC setups against BTC\'s own EMA200/H1 trend and never emits more than ungated',
    async () => {
      const recent = await loadRecentBtcCandles();
      const ungatedCount = countSetupsA(
        createNukidaFsm({ tickSize: 0.1, lotSize: 0.001, riskBudgetUsd: 100, leverage: 20, dataGate }),
        recent,
      );
      const gatedCount = countSetupsA(
        createNukidaFsm({
          tickSize: 0.1,
          lotSize: 0.001,
          riskBudgetUsd: 100,
          leverage: 20,
          btcM15Candles: recent,
          dataGate,
        }),
        recent,
      );

      console.info(`BTCUSDT recent-6m FSM with BTC trend gate: setups A=${gatedCount} (ungated=${ungatedCount})`);
      expect(ungatedCount).toBeGreaterThan(0);
      expect(gatedCount).toBeLessThanOrEqual(ungatedCount);
    },
    30_000,
  );
});
