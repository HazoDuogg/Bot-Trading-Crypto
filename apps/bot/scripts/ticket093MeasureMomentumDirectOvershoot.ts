/**
 * TICKET-093 Phần A — đo độ vượt SL trước khi quay đầu cho MOMENTUM_DIRECT "SL OAN" (đúng phương
 * pháp TICKET-090, áp dụng cho setupType='MOMENTUM_DIRECT' thay vì 'OB'). Chỉ đọc dữ liệu.
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
const WINDOW_MS = 2 * 60 * 60_000;
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

  const slTrades = trades.filter((t) => t.setupType === 'MOMENTUM_DIRECT' && t.exitReason === 'SL');
  interface SlOanTrade extends TradeRow {
    extremePrice: number;
    overshootPrice: number;
    atrAtEntry: number;
    overshootAtrMultiple: number;
    overshootPercentOfEntry: number; // for translating into momentumDirectMinSlPercent (the actual binding config lever)
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

    const atrSeries = atrBySymbol.get(t.symbol)!;
    let entryIdx = candles.findIndex((c) => c.timestamp >= t.entryTimestamp);
    if (entryIdx === -1) entryIdx = candles.length - 1;
    if (candles[entryIdx].timestamp > t.entryTimestamp && entryIdx > 0) entryIdx--;
    const atrAtEntry = atrSeries[entryIdx];
    if (!Number.isFinite(atrAtEntry) || atrAtEntry <= 0) continue;

    slOanResults.push({
      ...t,
      extremePrice,
      overshootPrice,
      atrAtEntry,
      overshootAtrMultiple: overshootPrice / atrAtEntry,
      overshootPercentOfEntry: (overshootPrice / t.entryPrice) * 100,
    });
  }

  const atrMultiples = slOanResults.map((r) => r.overshootAtrMultiple).sort((a, b) => a - b);
  const pctMultiples = slOanResults.map((r) => r.overshootPercentOfEntry).sort((a, b) => a - b);

  let out = '# TICKET-093 Phần A — Độ vượt SL trước khi quay đầu (MOMENTUM_DIRECT, các lệnh SL OAN của TICKET-088)\n\n';
  out += `Nguồn: \`data/backtest-trades-livecapital-risk5-bal100-margincap12.5.csv\`. Tái xác định đúng tập "SL OAN" của MOMENTUM_DIRECT (cùng phương pháp TICKET-088, khung 2h): **${slOanResults.length} lệnh**.\n\n`;
  out += 'Phương pháp: giống hệt TICKET-090, áp dụng cho setupType=MOMENTUM_DIRECT.\n\n';

  if (slOanResults.length !== atrMultiples.length) {
    out += `Lưu ý: một số lệnh bị loại vì thiếu ATR hợp lệ tại entry.\n\n`;
  }

  out += '## Phân phối "cần nới thêm bao nhiêu x ATR" để tránh dính SL\n\n';
  out += '| Thống kê | Giá trị (x ATR) |\n|---|---|\n';
  out += `| Min | ${atrMultiples[0].toFixed(3)} |\n`;
  out += `| P25 | ${percentile(atrMultiples, 0.25).toFixed(3)} |\n`;
  out += `| Median | ${percentile(atrMultiples, 0.5).toFixed(3)} |\n`;
  out += `| P75 | ${percentile(atrMultiples, 0.75).toFixed(3)} |\n`;
  out += `| Max | ${atrMultiples[atrMultiples.length - 1].toFixed(3)} |\n\n`;

  out += '## Cơ chế SL thực tế của MOMENTUM_DIRECT (xác nhận trước khi đổi tham số ở Phần B)\n\n';
  out += 'Đọc `orchestrator.ts` (hàm build DraftSetup cho MOMENTUM_DIRECT, TICKET-059/064): SL KHÔNG dùng multiplier ATR riêng cho MOMENTUM_DIRECT — công thức là:\n\n';
  out += '1. `rawSlPrice` = low/high của chính nến hiện tại (kiểu Sweep) ± `EntryConfig.SL_BUFFER_ATR_MULTIPLIER` (0.1, hằng số DÙNG CHUNG với FVG/Sweep — TICKET-089 đã không đụng vào để giữ FVG/Sweep nguyên vẹn).\n';
  out += '2. Nếu khoảng cách SL thô đó hẹp hơn `config.momentumDirectMinSlPercent` (hiện 1.0%, CLI-overridable) thì SL được nới ra đúng bằng mức % này (TICKET-064 Phần A — "floor").\n\n';
  out += '→ Không có field `momentumDirectSlBufferAtrMultiplier` nào tồn tại trong code. Đòn bẩy CLI khả dụng và không đụng FVG/Sweep là **`momentumDirectMinSlPercent`** (floor %), đúng như TICKET-063 (được trích dẫn trong code) đã ghi nhận: SL ATR thô của MOMENTUM_DIRECT thường hẹp hơn floor, nên floor % mới là cái thực sự quyết định SL cuối cùng ở đa số lệnh.\n\n';

  out += '## Phân phối độ vượt quy đổi sang % giá entry (để tính mức momentumDirectMinSlPercent mới ở Phần B)\n\n';
  out += '| Thống kê | Giá trị (% giá entry) |\n|---|---|\n';
  out += `| Min | ${pctMultiples[0].toFixed(4)}% |\n`;
  out += `| P25 | ${percentile(pctMultiples, 0.25).toFixed(4)}% |\n`;
  out += `| Median | ${percentile(pctMultiples, 0.5).toFixed(4)}% |\n`;
  out += `| P75 | ${percentile(pctMultiples, 0.75).toFixed(4)}% |\n`;
  out += `| Max | ${pctMultiples[pctMultiples.length - 1].toFixed(4)}% |\n\n`;

  writeFileSync(join(DATA_DIR, 'ticket093-momentum-direct-sl-oan-overshoot.md'), out, 'utf8');
  console.log(out);
}

main();
