/**
 * TICKET-077 1.1 — đo độ trễ THẬT của polling giá (public, không cần API key).
 * Run from repo root: `npm run measure-candle-poll-latency` (requires .env: BINANCE_URL).
 *
 * Đo ĐÚNG endpoint mà `liveCandleFeed.ts` thực sự dùng trong production: `GET /fapi/v1/klines`
 * (interval=5m). Phương pháp: round-trip wall-clock (decisionAt ngay trước khi gửi request →
 * respondedAt ngay khi nhận xong response), CÙNG kỹ thuật đã dùng ở TICKET-076 Phần C
 * (`measureBinanceLatency.ts`) — không so với field timestamp trả về trong response.
 *
 * LƯU Ý QUAN TRỌNG (bài học từ lần đo đầu tiên, đã sửa): ban đầu định so `Date.now()` với field
 * `time`/`closeTime` trả về từ `/fapi/v1/ticker/price` hoặc klines để đo "độ cũ" của dữ liệu — nhưng
 * xác nhận field đó là THỜI ĐIỂM GIAO DỊCH CUỐI/thời điểm đóng nến DỰ KIẾN, không phải "giờ hiện tại
 * của server", nên phép so sánh đó cho ra số vô nghĩa (hàng nghìn-hàng chục nghìn ms, không phải độ
 * trễ mạng thật). Đã loại bỏ phương pháp đó, quay lại round-trip thuần túy — đáng tin cậy hơn.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const SAMPLES_PER_SYMBOL = 150;
const DELAY_BETWEEN_MS = 300;
const KLINE_LIMIT = 3; // khớp đúng klineLimit mặc định của liveCandleFeed.ts

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`measureCandlePollLatency: thiếu biến môi trường ${name} trong .env`);
  return v;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Sample {
  decisionAt: number;
  respondedAt: number;
  latencyMs: number;
}

function stats(values: number[]): { min: number; max: number; mean: number; p95: number; p99: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return { min: sorted[0], max: sorted[sorted.length - 1], mean: values.reduce((a, b) => a + b, 0) / values.length, p95: pct(95), p99: pct(99) };
}

async function measureSymbol(baseUrl: string, symbol: string): Promise<Sample[]> {
  const samples: Sample[] = [];
  console.log(`\n=== ${symbol}: ${SAMPLES_PER_SYMBOL} mẫu (GET /fapi/v1/klines?interval=5m) ===`);
  const url = `${baseUrl}/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=${KLINE_LIMIT}`;
  for (let i = 0; i < SAMPLES_PER_SYMBOL; i++) {
    const decisionAt = Date.now();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} khi đo ${symbol}`);
    await res.json(); // tính cả thời gian parse JSON vào round-trip, giống hệt thực tế pollOnce() sẽ chịu
    const respondedAt = Date.now();
    samples.push({ decisionAt, respondedAt, latencyMs: respondedAt - decisionAt });
    if ((i + 1) % 30 === 0) console.log(`  ${i + 1}/${SAMPLES_PER_SYMBOL}...`);
    await sleep(DELAY_BETWEEN_MS);
  }
  return samples;
}

async function main(): Promise<void> {
  const baseUrl = requireEnv('BINANCE_URL');
  console.log(`Đo round-trip latency GET /fapi/v1/klines (endpoint liveCandleFeed.ts thực sự dùng) — Base URL: ${baseUrl}`);

  const resultsBySymbol: Record<string, Sample[]> = {};
  for (const symbol of SYMBOLS) {
    resultsBySymbol[symbol] = await measureSymbol(baseUrl, symbol);
  }

  const reportSections = SYMBOLS.map((symbol) => {
    const s = stats(resultsBySymbol[symbol].map((x) => x.latencyMs));
    return [`## ${symbol}`, '', `| Chỉ số | Giá trị (ms) |`, `|---|---|`, `| Min | ${s.min} |`, `| Mean | ${s.mean.toFixed(1)} |`, `| P95 | ${s.p95} |`, `| P99 | ${s.p99} |`, `| Max | ${s.max} |`, ''].join(
      '\n',
    );
  });

  const all = SYMBOLS.flatMap((s) => resultsBySymbol[s].map((x) => x.latencyMs));
  const overall = stats(all);

  const report = [
    '# Đo độ trễ polling giá (TICKET-077 1.1)',
    '',
    `Sinh tự động ${new Date().toISOString()}. ${SAMPLES_PER_SYMBOL} mẫu/coin × ${SYMBOLS.length} coin = ${all.length} mẫu.`,
    '',
    '**Phương pháp**: round-trip wall-clock của đúng endpoint `GET /fapi/v1/klines?interval=5m` mà',
    '`liveCandleFeed.ts` dùng trong production (không phải `ticker/price` — xem ghi chú phương pháp đã',
    'loại bỏ ở cuối báo cáo). `latency = respondedAt (sau khi parse JSON xong) − decisionAt (ngay trước',
    'khi gửi request)`, ≥150 mẫu/coin theo đúng yêu cầu ticket.',
    '',
    '## Tổng hợp (toàn bộ mẫu, mọi coin)',
    '',
    `| Chỉ số | Giá trị (ms) |`,
    `|---|---|`,
    `| Mean | ${overall.mean.toFixed(1)} |`,
    `| P95 | ${overall.p95} |`,
    `| P99 | ${overall.p99} |`,
    `| Min | ${overall.min} |`,
    `| Max | ${overall.max} |`,
    '',
    ...reportSections,
    '---',
    '',
    '## Phương pháp ĐÃ LOẠI BỎ (ghi lại để không lặp lại sai lầm)',
    '',
    'Lần đo đầu tiên thử so `Date.now()` với field `time` trả về từ `/fapi/v1/ticker/price` để tính',
    '"độ cũ" (staleness) của giá — cho ra số vô lý (mean vài nghìn tới hàng chục nghìn ms, outlier',
    'P99 tới 100-150 giây). Xác nhận bằng `curl` trực tiếp: field `time` là **thời điểm giao dịch',
    'CUỐI CÙNG** được dùng để tính giá đó (last trade time), KHÔNG PHẢI "giờ hiện tại của server" —',
    'nên phép so sánh sai bản chất, không phản ánh độ trễ mạng/polling thật. Đã loại bỏ hoàn toàn',
    'phương pháp này, thay bằng round-trip thuần túy ở trên. Đã kiểm tra riêng: lệch đồng hồ máy so',
    'với server Binance ổn định (~22.6s, trôi chỉ -90ms trong 260s đo liên tục) — KHÔNG phải nguyên',
    'nhân của số liệu vô lý ban đầu.',
    '',
    '**Không tự kết luận thay PM** ngưỡng độ trễ này có chấp nhận được không cho quyết định vào lệnh —',
    'số liệu để PM đối chiếu với dung sai SL/TP và biên độ ATR thực tế.',
  ].join('\n');

  const reportPath = path.resolve(process.cwd(), 'data/candle-poll-latency-report.md');
  writeFileSync(reportPath, report);
  console.log(`\n→ ${reportPath}`);
}

main().catch((err) => {
  console.error('measureCandlePollLatency failed:', err);
  process.exit(1);
});
