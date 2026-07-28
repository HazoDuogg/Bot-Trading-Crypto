/**
 * TICKET-088 — phân tích: vào lệnh sai hướng hay quản lý vị thế sai (SL quá sát)?
 * Chỉ đọc dữ liệu, không sửa logic core, không chạy backtest mới.
 * Dùng bộ trades baseline $5/494 lệnh: data/backtest-trades-livecapital-risk5-bal100-margincap12.5.csv
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TradeRow {
  symbol: string;
  side: string;
  setupType: string;
  entryTimestamp: number;
  entryPrice: number;
  exitTimestamp: number;
  exitPrice: number;
  exitReason: string;
  pnlUsd: number;
}

interface Candle {
  timestampUtc: number;
  high: number;
  low: number;
}

const DATA_DIR = join(__dirname, '../../../data');
const TRADES_FILE = join(DATA_DIR, 'backtest-trades-livecapital-risk5-bal100-margincap12.5.csv');
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const WINDOW_MS = 2 * 60 * 60_000; // 2 giờ sau SL

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cols = line.split(',');
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cols[i]));
    return row;
  });
}

function loadTrades(): TradeRow[] {
  const rows = parseCsv(readFileSync(TRADES_FILE, 'utf8'));
  return rows.map((r) => ({
    symbol: r.symbol,
    side: r.side,
    setupType: r.setupType,
    entryTimestamp: Number(r.entryTimestamp),
    entryPrice: Number(r.entryPrice),
    exitTimestamp: Number(r.exitTimestamp),
    exitPrice: Number(r.exitPrice),
    exitReason: r.exitReason,
    pnlUsd: Number(r.pnlUsd),
  }));
}

function loadCandles(symbol: string): Candle[] {
  const rows = parseCsv(readFileSync(join(DATA_DIR, 'ohlcv', `${symbol}_5m.csv`), 'utf8'));
  return rows.map((r) => ({
    timestampUtc: Number(r.timestampUtc),
    high: Number(r.high),
    low: Number(r.low),
  }));
}

function main(): void {
  const trades = loadTrades();
  const candlesBySymbol = new Map<string, Candle[]>();
  for (const s of SYMBOLS) candlesBySymbol.set(s, loadCandles(s));

  const slTrades = trades.filter((t) => t.exitReason === 'SL');

  type Verdict = 'SL_DUNG' | 'SL_OAN' | 'KHONG_DU_DU_LIEU';
  interface Result extends TradeRow {
    verdict: Verdict;
  }

  const results: Result[] = slTrades.map((t) => {
    const candles = candlesBySymbol.get(t.symbol)!;
    const windowEnd = t.exitTimestamp + WINDOW_MS;
    const windowCandles = candles.filter((c) => c.timestampUtc > t.exitTimestamp && c.timestampUtc <= windowEnd);

    if (windowCandles.length === 0) {
      return { ...t, verdict: 'KHONG_DU_DU_LIEU' };
    }

    let verdict: Verdict;
    if (t.side === 'LONG') {
      const maxHigh = Math.max(...windowCandles.map((c) => c.high));
      verdict = maxHigh >= t.entryPrice ? 'SL_OAN' : 'SL_DUNG';
    } else {
      const minLow = Math.min(...windowCandles.map((c) => c.low));
      verdict = minLow <= t.entryPrice ? 'SL_OAN' : 'SL_DUNG';
    }
    return { ...t, verdict };
  });

  const total = results.length;
  const counts = { SL_DUNG: 0, SL_OAN: 0, KHONG_DU_DU_LIEU: 0 };
  for (const r of results) counts[r.verdict]++;

  const bySetup = new Map<string, { SL_DUNG: number; SL_OAN: number; KHONG_DU_DU_LIEU: number }>();
  for (const r of results) {
    if (!bySetup.has(r.setupType)) bySetup.set(r.setupType, { SL_DUNG: 0, SL_OAN: 0, KHONG_DU_DU_LIEU: 0 });
    bySetup.get(r.setupType)![r.verdict]++;
  }

  const pct = (n: number, d: number) => (d === 0 ? '0.0%' : `${((n / d) * 100).toFixed(1)}%`);

  let out = '# TICKET-088 — Nguyên nhân thua: vào lệnh sai hướng hay quản lý vị thế sai\n\n';
  out += `Nguồn: \`data/backtest-trades-livecapital-risk5-bal100-margincap12.5.csv\` (494 lệnh, baseline risk $5). Lọc lệnh thua có exitReason=SL: **${total} lệnh**.\n\n`;
  out += 'Phương pháp: với mỗi lệnh SL, xét nến 5m trong 2 giờ SAU thời điểm dính SL.\n';
  out += '- LONG: nếu giá (high) quay lại chạm/vượt entryPrice trong 2h sau → SL OAN. Nếu không → SL ĐÚNG.\n';
  out += '- SHORT: nếu giá (low) quay lại chạm/vượt entryPrice trong 2h sau → SL OAN. Nếu không → SL ĐÚNG.\n\n';

  out += '## Tổng hợp toàn bộ\n\n';
  out += '| Nhóm | Số lệnh | % |\n|---|---|---|\n';
  out += `| SL ĐÚNG (vào sai hướng) | ${counts.SL_DUNG} | ${pct(counts.SL_DUNG, total)} |\n`;
  out += `| SL OAN (quản lý vị thế sai — SL quá sát) | ${counts.SL_OAN} | ${pct(counts.SL_OAN, total)} |\n`;
  if (counts.KHONG_DU_DU_LIEU > 0) {
    out += `| Không đủ dữ liệu (hết nến sau lệnh) | ${counts.KHONG_DU_DU_LIEU} | ${pct(counts.KHONG_DU_DU_LIEU, total)} |\n`;
  }
  out += `| **Tổng** | **${total}** | 100% |\n\n`;

  out += '## Theo setupType\n\n';
  out += '| setupType | Tổng lệnh SL | SL ĐÚNG | SL OAN | % SL OAN |\n|---|---|---|---|---|\n';
  for (const [setup, c] of [...bySetup.entries()].sort((a, b) => b[1].SL_OAN - a[1].SL_OAN)) {
    const setupTotal = c.SL_DUNG + c.SL_OAN + c.KHONG_DU_DU_LIEU;
    out += `| ${setup} | ${setupTotal} | ${c.SL_DUNG} | ${c.SL_OAN} | ${pct(c.SL_OAN, setupTotal)} |\n`;
  }

  writeFileSync(join(DATA_DIR, 'ticket088-sl-cause-analysis.md'), out, 'utf8');
  console.log(out);
}

main();
