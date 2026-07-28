/**
 * TICKET-090 — đo chính xác độ vượt SL trước khi quay đầu, cho đúng 33 lệnh OB "SL OAN" của TICKET-088.
 * Chỉ đọc dữ liệu, không sửa logic core, không chạy backtest mới.
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { wilderATRSeries } from '../dist/regime/indicators.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TradeRow {
  symbol: string;
  side: string;
  setupType: string;
  entryTimestamp: number;
  entryPrice: number;
  exitTimestamp: number;
  exitPrice: number; // == slPrice used to exit (no slippage simulated)
  exitReason: string;
}

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const DATA_DIR = join(__dirname, '../../../data');
const TRADES_FILE = join(DATA_DIR, 'backtest-trades-livecapital-risk5-bal100-margincap12.5.csv');
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const WINDOW_MS = 2 * 60 * 60_000; // 2 giờ, đúng khung TICKET-088 dùng để phân loại SL OAN
const ATR_PERIOD_5M = 14;

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
  }));
}

function loadCandles(symbol: string): Candle[] {
  const rows = parseCsv(readFileSync(join(DATA_DIR, 'ohlcv', `${symbol}_5m.csv`), 'utf8'));
  return rows.map((r) => ({
    timestamp: Number(r.timestampUtc),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function main(): void {
  const trades = loadTrades();
  const candlesBySymbol = new Map<string, Candle[]>();
  const atrBySymbol = new Map<string, number[]>();
  for (const s of SYMBOLS) {
    const candles = loadCandles(s);
    candlesBySymbol.set(s, candles);
    atrBySymbol.set(s, wilderATRSeries(candles as never, ATR_PERIOD_5M));
  }

  // TICKET-088's exact classification, reproduced here to isolate the same 33 OB "SL OAN" trades.
  const slTrades = trades.filter((t) => t.setupType === 'OB' && t.exitReason === 'SL');
  interface SlOanTrade extends TradeRow {
    returnTimestamp: number;
    extremePrice: number;
    overshootPrice: number; // distance from slPrice(=exitPrice) to the extreme, in price units
    atrAtEntry: number;
    overshootAtrMultiple: number;
  }
  const slOanResults: SlOanTrade[] = [];

  for (const t of slTrades) {
    const candles = candlesBySymbol.get(t.symbol)!;
    const windowEnd = t.exitTimestamp + WINDOW_MS;
    const windowCandles = candles.filter((c) => c.timestamp > t.exitTimestamp && c.timestamp <= windowEnd);
    if (windowCandles.length === 0) continue;

    let isOan: boolean;
    if (t.side === 'LONG') isOan = Math.max(...windowCandles.map((c) => c.high)) >= t.entryPrice;
    else isOan = Math.min(...windowCandles.map((c) => c.low)) <= t.entryPrice;
    if (!isOan) continue;

    // Find the first candle where price returns to entryPrice (end of the "overshoot then reverse" window).
    let returnIdx = -1;
    for (let i = 0; i < windowCandles.length; i++) {
      const c = windowCandles[i];
      if (t.side === 'LONG' ? c.high >= t.entryPrice : c.low <= t.entryPrice) {
        returnIdx = i;
        break;
      }
    }
    const overshootWindow = windowCandles.slice(0, returnIdx + 1);

    let extremePrice: number;
    if (t.side === 'LONG') extremePrice = Math.min(...overshootWindow.map((c) => c.low));
    else extremePrice = Math.max(...overshootWindow.map((c) => c.high));

    const overshootPrice = t.side === 'LONG' ? t.exitPrice - extremePrice : extremePrice - t.exitPrice;

    // ATR at entry — same candle the real entryRouter.ts used to size the SL buffer (last closed 5m candle at/just before entryTimestamp).
    const atrSeries = atrBySymbol.get(t.symbol)!;
    let entryIdx = candles.findIndex((c) => c.timestamp >= t.entryTimestamp);
    if (entryIdx === -1) entryIdx = candles.length - 1;
    if (candles[entryIdx].timestamp > t.entryTimestamp && entryIdx > 0) entryIdx--;
    const atrAtEntry = atrSeries[entryIdx];
    if (!Number.isFinite(atrAtEntry) || atrAtEntry <= 0) continue;

    slOanResults.push({
      ...t,
      returnTimestamp: windowCandles[returnIdx].timestamp,
      extremePrice,
      overshootPrice,
      atrAtEntry,
      overshootAtrMultiple: overshootPrice / atrAtEntry,
    });
  }

  const multiples = slOanResults.map((r) => r.overshootAtrMultiple).sort((a, b) => a - b);

  let out = '# TICKET-090 — Độ vượt SL trước khi quay đầu (OB, các lệnh SL OAN của TICKET-088)\n\n';
  out += `Nguồn: \`data/backtest-trades-livecapital-risk5-bal100-margincap12.5.csv\` (494 lệnh baseline). Tái xác định đúng tập "SL OAN" của OB (cùng phương pháp TICKET-088, khung 2h): **${slOanResults.length} lệnh**.\n\n`;
  out += 'Phương pháp: với mỗi lệnh, từ lúc dính SL tới lúc giá quay lại entryPrice (trong 2h), tìm mức giá cực đoan nhất (đi xa nhất khỏi entryPrice, ngược hướng dự đoán) đạt tới trong khoảng đó.\n';
  out += '- LONG: cực đoan = low thấp nhất trong khoảng; độ vượt = slPrice (=exitPrice) − low thấp nhất.\n';
  out += '- SHORT: cực đoan = high cao nhất trong khoảng; độ vượt = high cao nhất − slPrice (=exitPrice).\n';
  out += '- Quy đổi ra bội số ATR(14) 5m tại đúng nến entry (nến dùng để tính buffer SL gốc trong entryRouter.ts).\n\n';

  if (slOanResults.length !== multiples.length) {
    out += `Lưu ý: ${slOanResults.length - multiples.length} lệnh bị loại vì thiếu ATR hợp lệ tại thời điểm entry.\n\n`;
  }

  out += '## Phân phối "cần nới thêm bao nhiêu x ATR" để tránh dính SL\n\n';
  out += '| Thống kê | Giá trị (x ATR) |\n|---|---|\n';
  out += `| Min | ${multiples[0].toFixed(3)} |\n`;
  out += `| P25 | ${percentile(multiples, 0.25).toFixed(3)} |\n`;
  out += `| Median | ${percentile(multiples, 0.5).toFixed(3)} |\n`;
  out += `| P75 | ${percentile(multiples, 0.75).toFixed(3)} |\n`;
  out += `| Max | ${multiples[multiples.length - 1].toFixed(3)} |\n\n`;

  out += '## Chi tiết từng lệnh\n\n';
  out += '| Symbol | Side | entryTimestamp | entryPrice | slPrice(=exitPrice) | Cực đoan | Độ vượt (giá) | ATR@entry | Độ vượt (x ATR) |\n|---|---|---|---|---|---|---|---|---|\n';
  for (const r of slOanResults) {
    const d = new Date(r.entryTimestamp).toISOString().replace('T', ' ').slice(0, 16);
    out += `| ${r.symbol} | ${r.side} | ${d} | ${r.entryPrice} | ${r.exitPrice} | ${r.extremePrice.toFixed(4)} | ${r.overshootPrice.toFixed(4)} | ${r.atrAtEntry.toFixed(4)} | ${r.overshootAtrMultiple.toFixed(3)} |\n`;
  }

  writeFileSync(join(DATA_DIR, 'ticket090-ob-sl-oan-overshoot.md'), out, 'utf8');
  console.log(out);
}

main();
