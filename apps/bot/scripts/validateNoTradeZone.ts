import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkNoTradeZone } from '../src/noTradeZone/noTradeZone.js';
import type { Candle, NoTradeReason } from '../src/noTradeZone/types.js';

async function readCsv(filePath: string): Promise<Candle[]> {
  const raw = await readFile(filePath, 'utf8');
  const lines = raw.trim().split('\n').slice(1);
  return lines.map((line) => {
    const [openTime, open, high, low, close, volume] = line.split(',');
    return {
      openTime: Number(openTime),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    };
  });
}

const H1_MS = 60 * 60 * 1000;

interface BlockedRun {
  startOpenTime: number;
  endOpenTime: number;
  candleCount: number;
}

async function main() {
  const [symbol = 'BTCUSDT', h1Interval = '1h', m15Interval = '15m'] = process.argv.slice(2);
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');
  const h1All = await readCsv(path.join(dataDir, `${symbol}_${h1Interval}.csv`));
  const m15All = await readCsv(path.join(dataDir, `${symbol}_${m15Interval}.csv`));

  console.log(`Loaded ${h1All.length} H1 candles, ${m15All.length} M15 candles for ${symbol}`);
  console.log('spread_too_high va news_risk bi bo qua: khong co du lieu bid/ask lich su, va isNewsRisk dang la stub luon tra ve false.');

  const reasonCounts: Record<Exclude<NoTradeReason, 'spread_too_high' | 'news_risk'>, number> = {
    volatility_extreme: 0,
    shock_event: 0,
    pump_dump_flag: 0,
  };

  let blockedCount = 0;
  const runs: BlockedRun[] = [];
  let currentRun: BlockedRun | null = null;
  let m15Cursor = 0;

  for (let i = 0; i < h1All.length; i++) {
    const h1Window = h1All.slice(0, i + 1);
    const h1CloseTime = h1All[i].openTime + H1_MS;

    while (m15Cursor < m15All.length && m15All[m15Cursor].openTime + 15 * 60 * 1000 <= h1CloseTime) {
      m15Cursor++;
    }
    const m15Window = m15All.slice(0, m15Cursor);

    const closePrice = h1All[i].close;
    const result = checkNoTradeZone({
      nowMs: h1CloseTime,
      bid: closePrice,
      ask: closePrice,
      h1Candles: h1Window,
      m15Candles: m15Window,
    });

    const relevantReasons = result.reasons.filter(
      (r): r is Exclude<NoTradeReason, 'spread_too_high' | 'news_risk'> =>
        r !== 'spread_too_high' && r !== 'news_risk',
    );
    for (const reason of relevantReasons) reasonCounts[reason]++;

    const blocked = relevantReasons.length > 0;
    if (blocked) {
      blockedCount++;
      if (currentRun) {
        currentRun.endOpenTime = h1All[i].openTime;
        currentRun.candleCount++;
      } else {
        currentRun = { startOpenTime: h1All[i].openTime, endOpenTime: h1All[i].openTime, candleCount: 1 };
      }
    } else if (currentRun) {
      runs.push(currentRun);
      currentRun = null;
    }
  }
  if (currentRun) runs.push(currentRun);

  const total = h1All.length;
  const blockedPct = total > 0 ? (blockedCount / total) * 100 : 0;

  console.log(`\nTong so nen H1 xet: ${total}`);
  console.log(`So nen bi chan: ${blockedCount} (${blockedPct.toFixed(2)}%)`);
  console.log('\nBreakdown theo reason (mot nen co the co nhieu reason):');
  for (const [reason, count] of Object.entries(reasonCounts)) {
    console.log(`  ${reason}: ${count} (${total > 0 ? ((count / total) * 100).toFixed(2) : '0.00'}%)`);
  }

  const top10 = [...runs].sort((a, b) => b.candleCount - a.candleCount).slice(0, 10);
  console.log('\nTop 10 giai doan bi chan dai nhat:');
  top10.forEach((run, idx) => {
    const start = new Date(run.startOpenTime).toISOString();
    const end = new Date(run.endOpenTime + H1_MS).toISOString();
    console.log(`  ${idx + 1}. ${start} -> ${end} (${run.candleCount} nen H1, ~${run.candleCount}h)`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
