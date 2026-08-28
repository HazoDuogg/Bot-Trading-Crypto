import type { LiveEventRecord } from './eventRecord.js';

export interface SymbolStats {
  n: number;
  wins: number;
  winRatePct: number;
  pnlUsd: number;
}

export interface WeeklyStats {
  n: number;
  wins: number;
  losses: number;
  winRatePct: number;
  pnlUsd: number;
  profitFactor: number;
  bySymbol: Record<string, SymbolStats>;
}

export function parseJsonlLines(content: string): LiveEventRecord[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LiveEventRecord);
}

export function filterPositionClosedInWindow(records: LiveEventRecord[], windowStartMs: number, windowEndMs: number): LiveEventRecord[] {
  return records.filter((r) => {
    if (r.eventKind !== 'POSITION_CLOSED') return false;
    const t = Date.parse(r.timestampUtc);
    return t >= windowStartMs && t < windowEndMs;
  });
}

export function computeWeeklyStats(records: LiveEventRecord[]): WeeklyStats {
  let wins = 0;
  let pnlUsd = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  const bySymbolRaw = new Map<string, { n: number; wins: number; pnlUsd: number }>();

  for (const r of records) {
    const pnl = r.resultPnlUsd ?? 0;
    pnlUsd += pnl;
    if (pnl > 0) {
      wins++;
      grossProfit += pnl;
    } else if (pnl < 0) {
      grossLoss += Math.abs(pnl);
    }

    const entry = bySymbolRaw.get(r.symbol) ?? { n: 0, wins: 0, pnlUsd: 0 };
    entry.n++;
    if (pnl > 0) entry.wins++;
    entry.pnlUsd += pnl;
    bySymbolRaw.set(r.symbol, entry);
  }

  const bySymbol: Record<string, SymbolStats> = {};
  for (const [symbol, s] of bySymbolRaw) {
    bySymbol[symbol] = { n: s.n, wins: s.wins, winRatePct: s.n > 0 ? (s.wins / s.n) * 100 : 0, pnlUsd: s.pnlUsd };
  }

  return {
    n: records.length,
    wins,
    losses: records.length - wins,
    winRatePct: records.length > 0 ? (wins / records.length) * 100 : 0,
    pnlUsd,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    bySymbol,
  };
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function formatWeeklySummaryMessage(stats: WeeklyStats, windowStart: Date, windowEnd: Date): string {
  const lines: string[] = [];
  lines.push('📊 <b>BẢNG THỐNG KÊ TUẦN</b>');
  lines.push(`🗓 ${fmtDate(windowStart)} → ${fmtDate(windowEnd)} (UTC)`);

  if (stats.n === 0) {
    lines.push('');
    lines.push('Không có lệnh nào đóng trong tuần này.');
    return lines.join('\n');
  }

  const pf = Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞';
  lines.push('');
  lines.push(`Tổng lệnh: ${stats.n} | Thắng: ${stats.wins} | Thua: ${stats.losses}`);
  lines.push(`Winrate: ${stats.winRatePct.toFixed(1)}% | PF: ${pf}`);
  lines.push(`PnL$: ${stats.pnlUsd >= 0 ? '+' : ''}${stats.pnlUsd.toFixed(2)}`);
  lines.push('');
  lines.push('<pre>');
  lines.push('Coin      n  Win%   PnL$');
  for (const symbol of Object.keys(stats.bySymbol).sort()) {
    const s = stats.bySymbol[symbol];
    const pnlText = `${s.pnlUsd >= 0 ? '+' : ''}${s.pnlUsd.toFixed(2)}`;
    lines.push(`${symbol.padEnd(9)} ${String(s.n).padStart(2)} ${s.winRatePct.toFixed(0).padStart(4)}% ${pnlText.padStart(8)}`);
  }
  lines.push('</pre>');
  return lines.join('\n');
}
