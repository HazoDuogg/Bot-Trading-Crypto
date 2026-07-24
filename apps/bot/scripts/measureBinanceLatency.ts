/**
 * TICKET-076 Phần C — đo độ trễ kết nối tới Binance Futures (tài khoản THẬT, chỉ gọi GET, KHÔNG
 * đặt lệnh nào — đúng phạm vi đã thống nhất với PM cho đợt test 27/7).
 * Run from repo root: `npm run measure-binance-latency` (requires .env: BINANCE_URL,
 * BINANCE_LIVE_KEY, BINANCE_LIVE_SECRET).
 *
 * Đo 2 loại round-trip:
 *   - GET /fapi/v1/time (public, không auth) — độ trễ mạng + server thuần túy.
 *   - GET /fapi/v2/account (signed) — cộng thêm chi phí ký HMAC + xác thực phía Binance.
 * Không đo được độ trễ KHỚP LỆNH thật (vì không đặt lệnh) — báo cáo nêu rõ giới hạn này.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { BinanceOrderExecutor } from '../dist/live/binanceOrderExecutor.js';

const ITERATIONS = 20;
const DELAY_BETWEEN_MS = 500; // tránh dồn dập lên rate limit

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`measureBinanceLatency: thiếu biến môi trường ${name} trong .env`);
  return v;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Sample {
  iteration: number;
  decisionAt: number; // "quyết định vào lệnh" mô phỏng — thời điểm ngay trước khi gửi request
  respondedAt: number;
  latencyMs: number;
}

function stats(samples: number[]): { min: number; max: number; mean: number; median: number; p95: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
    median: pct(50),
    p95: pct(95),
  };
}

async function measure(label: string, fn: () => Promise<unknown>): Promise<Sample[]> {
  const samples: Sample[] = [];
  console.log(`\n=== ${label} (${ITERATIONS} lần) ===`);
  for (let i = 0; i < ITERATIONS; i++) {
    const decisionAt = Date.now(); // mô phỏng "pipeline tính xong, quyết định hành động"
    await fn();
    const respondedAt = Date.now();
    const latencyMs = respondedAt - decisionAt;
    samples.push({ iteration: i + 1, decisionAt, respondedAt, latencyMs });
    console.log(`  [${i + 1}/${ITERATIONS}] decisionAt=${new Date(decisionAt).toISOString()} respondedAt=${new Date(respondedAt).toISOString()} latency=${latencyMs}ms`);
    await sleep(DELAY_BETWEEN_MS);
  }
  return samples;
}

async function main(): Promise<void> {
  const baseUrl = requireEnv('BINANCE_URL');
  const apiKey = requireEnv('BINANCE_LIVE_KEY');
  const apiSecret = requireEnv('BINANCE_LIVE_SECRET');

  console.log(`Đo độ trễ Binance Futures — tài khoản THẬT (mainnet), CHỈ GET, KHÔNG đặt lệnh nào.`);
  console.log(`Base URL: ${baseUrl}`);

  const executor = new BinanceOrderExecutor({ credentials: { apiKey, apiSecret, baseUrl }, dryRun: true });

  const clockOffsetMs = await executor.syncClock();
  console.log(`Đồng bộ đồng hồ: lệch ${clockOffsetMs}ms so với server Binance (dương = máy local chậm hơn).`);

  const timeSamples = await measure('GET /fapi/v1/time (public, không auth)', () => executor.getServerTime());
  const accountSamples = await measure('GET /fapi/v2/account (signed, có auth)', () => executor.getAccountInfo());

  const timeStats = stats(timeSamples.map((s) => s.latencyMs));
  const accountStats = stats(accountSamples.map((s) => s.latencyMs));

  const report = [
    '# Đo độ trễ kết nối Binance Futures (TICKET-076 Phần C)',
    '',
    `Sinh tự động ${new Date().toISOString()}. Tài khoản THẬT (mainnet), ${ITERATIONS} lần đo mỗi loại.`,
    '',
    '**Giới hạn của phép đo này**: chỉ đo round-trip GET (server time / account info), KHÔNG đặt lệnh',
    'thật nào (đúng phạm vi đã thống nhất với PM cho đợt test 27/7) — nên đây là độ trễ mạng + xác thực,',
    'KHÔNG PHẢI độ trễ "quyết định vào lệnh → lệnh khớp trên sàn" thực tế (đặt lệnh MARKET + xác nhận khớp',
    'sẽ có thêm chi phí xử lý phía matching engine, không đo được nếu không đặt lệnh thật).',
    '',
    '## GET /fapi/v1/time (public, không auth)',
    '',
    `| Chỉ số | Giá trị (ms) |`,
    `|---|---|`,
    `| Min | ${timeStats.min} |`,
    `| Mean | ${timeStats.mean.toFixed(1)} |`,
    `| Median | ${timeStats.median} |`,
    `| P95 | ${timeStats.p95} |`,
    `| Max | ${timeStats.max} |`,
    '',
    '## GET /fapi/v2/account (signed, có auth HMAC)',
    '',
    `| Chỉ số | Giá trị (ms) |`,
    `|---|---|`,
    `| Min | ${accountStats.min} |`,
    `| Mean | ${accountStats.mean.toFixed(1)} |`,
    `| Median | ${accountStats.median} |`,
    `| P95 | ${accountStats.p95} |`,
    `| Max | ${accountStats.max} |`,
    '',
    `**Chi phí thêm do auth/ký HMAC**: ${(accountStats.mean - timeStats.mean).toFixed(1)}ms (mean, account − time).`,
    '',
    '## Chi tiết từng lần đo — GET /fapi/v1/time',
    '',
    '| # | decisionAt (UTC) | respondedAt (UTC) | latency (ms) |',
    '|---|---|---|---|',
    ...timeSamples.map((s) => `| ${s.iteration} | ${new Date(s.decisionAt).toISOString()} | ${new Date(s.respondedAt).toISOString()} | ${s.latencyMs} |`),
    '',
    '## Chi tiết từng lần đo — GET /fapi/v2/account',
    '',
    '| # | decisionAt (UTC) | respondedAt (UTC) | latency (ms) |',
    '|---|---|---|---|',
    ...accountSamples.map((s) => `| ${s.iteration} | ${new Date(s.decisionAt).toISOString()} | ${new Date(s.respondedAt).toISOString()} | ${s.latencyMs} |`),
    '',
    '---',
    '',
    '**Không tự kết luận thay PM** liệu độ trễ đo được có ảnh hưởng đáng kể tới entryPrice dự kiến hay',
    'không — số liệu trên để PM tự đối chiếu với biên độ dao động giá thực tế (ATR/phút) của 4 coin.',
  ].join('\n');

  const reportPath = path.resolve(process.cwd(), 'data/binance-latency-report.md');
  writeFileSync(reportPath, report);
  console.log(`\n→ ${reportPath}`);
}

main().catch((err) => {
  console.error('measureBinanceLatency failed:', err);
  process.exit(1);
});
