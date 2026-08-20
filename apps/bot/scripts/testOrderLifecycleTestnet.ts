/**
 * TICKET-077 1.3 Bước B — test toàn bộ chu trình đặt/hủy/dời lệnh trên Binance Futures TESTNET
 * (tiền ảo). CHỈ chạy khi ENV=testnet (script tự chặn nếu ENV=mainnet) — không nhảy thẳng mainnet.
 * Run: `npm run test-order-lifecycle-testnet` (ENV mặc định testnet, không cần set gì thêm).
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadBinanceEnvConfig } from '../dist/live/envConfig.js';
import { BinanceOrderExecutor, type OrderResult, type AlgoOrderResult, type DryRunResult } from '../dist/live/binanceOrderExecutor.js';

const SYMBOL = 'ETHUSDT'; // khác BTCUSDT (đang có vị thế cũ mở sẵn trên testnet) để không lẫn lộn
const QUANTITY = 0.02; // ~ $39 notional tại giá hiện tại, vượt MIN_NOTIONAL=20 của ETHUSDT testnet
const PARTIAL_QUANTITY = 0.01;

interface StepLog {
  step: string;
  startedAt: string;
  latencyMs?: number;
  ok: boolean;
  detail: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOrderResult(v: OrderResult | DryRunResult | undefined): v is OrderResult {
  return v !== undefined && 'orderId' in v;
}

function isAlgoOrderResult(v: AlgoOrderResult | DryRunResult | undefined): v is AlgoOrderResult {
  return v !== undefined && 'algoId' in v;
}

async function getPrice(baseUrl: string, symbol: string): Promise<number> {
  const res = await fetch(`${baseUrl}/fapi/v1/ticker/price?symbol=${symbol}`);
  const body = (await res.json()) as { price: string };
  return Number(body.price);
}

async function main(): Promise<void> {
  const { env, baseUrl, apiKey, apiSecret } = loadBinanceEnvConfig();
  if (env !== 'testnet') {
    throw new Error(`testOrderLifecycleTestnet: script này CHỈ được chạy khi ENV=testnet (an toàn) — hiện tại ENV=${env}. Dừng lại, không chạy trên mainnet.`);
  }

  const log: StepLog[] = [];
  const executor = new BinanceOrderExecutor({
    credentials: { baseUrl, apiKey, apiSecret },
    dryRun: false, // testnet — tiền ảo, an toàn để chạy thật theo đúng yêu cầu Bước B
    onOrderFailure: (context, err) => console.error(`  [onOrderFailure] ${context}: ${err.message}`),
  });
  await executor.syncClock();

  async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    try {
      const result = await fn();
      log.push({ step: name, startedAt, latencyMs: Date.now() - t0, ok: true, detail: result });
      console.log(`[OK] ${name} (${Date.now() - t0}ms)`);
      return result;
    } catch (err) {
      log.push({ step: name, startedAt, latencyMs: Date.now() - t0, ok: false, detail: (err as Error).message });
      console.error(`[FAIL] ${name}: ${(err as Error).message}`);
      return undefined;
    }
  }

  const price = await getPrice(baseUrl, SYMBOL);
  console.log(`Giá tham chiếu ${SYMBOL} lúc bắt đầu: ${price}\n`);

  // 1. Đặt lệnh MARKET mở vị thế
  const openResult = await step('1_openMarketPosition', () => executor.openMarketPosition(SYMBOL, 'LONG', QUANTITY, price));

  // 2. Poll getPositionRisk() để phát hiện khớp — đo độ trễ "đặt lệnh → phát hiện khớp qua poll"
  const detectStart = Date.now();
  let filled = false;
  let pollCount = 0;
  while (!filled && pollCount < 25) {
    const positions = (await executor.getPositionRisk(SYMBOL)) as Array<{ symbol: string; positionAmt: string }>;
    const pos = positions.find((p) => p.symbol === SYMBOL);
    if (pos && Math.abs(Number(pos.positionAmt)) >= QUANTITY) filled = true;
    pollCount++;
    if (!filled) await sleep(200);
  }
  log.push({ step: '2_detectFillViaPositionRiskPoll', startedAt: new Date(detectStart).toISOString(), latencyMs: Date.now() - detectStart, ok: filled, detail: { pollCount } });
  console.log(`[${filled ? 'OK' : 'FAIL'}] 2_detectFillViaPositionRiskPoll: ${pollCount} lần poll, ${Date.now() - detectStart}ms`);

  // Theo dõi algoId MỚI NHẤT của SL/TP thuộc về ĐÚNG vị thế này — bắt buộc để đóng vị thế xong chỉ
  // hủy CHÍNH XÁC 2 lệnh này (không hủy hàng loạt theo symbol, tránh xóa nhầm SL/TP của vị thế khác
  // đang mở cùng coin — xem doc comment cancelAlgoOrder() trong binanceOrderExecutor.ts).
  let currentSlAlgoId: number | undefined;
  let currentTpAlgoId: number | undefined;

  // 3. Đặt SL
  const slResult = await step('3_placeStopMarket', () => executor.placeStopMarket(SYMBOL, 'LONG', Number((price * 0.95).toFixed(2)), QUANTITY));
  if (isAlgoOrderResult(slResult)) currentSlAlgoId = slResult.algoId;

  // 4. Đặt TP
  const tpResult = await step('4_placeTakeProfitMarket', () => executor.placeTakeProfitMarket(SYMBOL, 'LONG', Number((price * 1.05).toFixed(2)), QUANTITY));
  if (isAlgoOrderResult(tpResult)) currentTpAlgoId = tpResult.algoId;

  // 5. Dời SL (cancel + đặt lại qua updateStopOrder, dùng algoId — đo độ trễ)
  if (currentSlAlgoId !== undefined) {
    const moved = await step('5_updateStopOrder(doiSL)', () => executor.updateStopOrder(SYMBOL, currentSlAlgoId as number, 'LONG', Number((price * 0.96).toFixed(2)), QUANTITY));
    if (isAlgoOrderResult(moved)) currentSlAlgoId = moved.algoId; // algoId cũ đã bị hủy, cập nhật về algoId MỚI
  }

  // 6. Dời TP (không có helper riêng — cancelAlgoOrder rồi đặt lại thủ công, đo độ trễ tổng)
  if (currentTpAlgoId !== undefined) {
    const moved = await step('6_moveTP(cancel+placeLai)', async () => {
      await executor.cancelAlgoOrder(SYMBOL, currentTpAlgoId as number);
      return executor.placeTakeProfitMarket(SYMBOL, 'LONG', Number((price * 1.04).toFixed(2)), QUANTITY);
    });
    if (isAlgoOrderResult(moved)) currentTpAlgoId = moved.algoId; // algoId cũ đã bị hủy, cập nhật về algoId MỚI
  }

  // 7a. Đặt LIMIT xa giá thị trường (không khớp ngay)
  const farLimitResult = await step('7a_placeLimitFarFromMarket', () => executor.placeLimitOrder(SYMBOL, 'SHORT', Number((price * 1.3).toFixed(2)), 0.01));

  // 7b. Hủy lệnh LIMIT CHƯA khớp đó
  if (isOrderResult(farLimitResult)) {
    await step('7b_cancelUnfilledLimit', () => executor.cancelOrder(SYMBOL, farLimitResult.orderId));
  }

  // 8. Đóng 1 PHẦN vị thế bằng MARKET reduceOnly
  await step('8_closePositionMarket(partial)', () => executor.closePositionMarket(SYMBOL, 'LONG', PARTIAL_QUANTITY));

  // 9. Đóng NỐT phần còn lại
  const remainingQuantity = Number((QUANTITY - PARTIAL_QUANTITY).toFixed(3));
  await step('9_closePositionMarket(remaining)', () => executor.closePositionMarket(SYMBOL, 'LONG', remainingQuantity));

  // 10. Xác nhận vị thế đã về 0 sau khi đóng hết
  await step('10_verifyFlatAfterClose', async () => {
    const positions = (await executor.getPositionRisk(SYMBOL)) as Array<{ symbol: string; positionAmt: string }>;
    const pos = positions.find((p) => p.symbol === SYMBOL);
    const amt = pos ? Number(pos.positionAmt) : 0;
    if (Math.abs(amt) > 1e-6) throw new Error(`vị thế CHƯA về 0 sau khi đóng hết: positionAmt=${amt}`);
    return { positionAmt: amt };
  });

  // 11. PHÁT HIỆN THẬT (Bước D trên mainnet, PM báo lại): Binance KHÔNG tự hủy Algo Order (SL/TP)
  // còn treo sau khi vị thế đã đóng hết — BẮT BUỘC hủy ĐÚNG 2 algoId (SL+TP) thuộc về vị thế NÀY
  // (đã theo dõi ở trên qua currentSlAlgoId/currentTpAlgoId), KHÔNG hủy hàng loạt theo symbol (sẽ
  // xóa nhầm SL/TP của vị thế khác đang mở cùng coin — xem TICKET-056 tối đa 2 vị thế/coin).
  if (currentSlAlgoId !== undefined) {
    await step('11a_cancelAlgoOrder(SL của vị thế này)', () => executor.cancelAlgoOrder(SYMBOL, currentSlAlgoId as number));
  }
  if (currentTpAlgoId !== undefined) {
    await step('11b_cancelAlgoOrder(TP của vị thế này)', () => executor.cancelAlgoOrder(SYMBOL, currentTpAlgoId as number));
  }

  // 12. Mô phỏng "mất kết nối rồi kết nối lại" — tạo executor MỚI hoàn toàn (không share bất kỳ state
  // nội bộ nào với executor cũ) và poll lại TOÀN BỘ trạng thái từ sàn, đúng yêu cầu ticket
  // ("khi kết nối lại phải poll lại TOÀN BỘ trạng thái từ sàn").
  await step('12_reconnectAndRepollFullState', async () => {
    const freshExecutor = new BinanceOrderExecutor({ credentials: { baseUrl, apiKey, apiSecret }, dryRun: false });
    await freshExecutor.syncClock();
    const account = (await freshExecutor.getAccountInfo()) as { totalWalletBalance?: string };
    const positions = (await freshExecutor.getPositionRisk()) as Array<{ symbol: string; positionAmt: string }>;
    const open = positions.filter((p) => Number(p.positionAmt) !== 0);
    return { totalWalletBalance: account.totalWalletBalance, openPositionsCount: open.length, openPositions: open.map((p) => p.symbol) };
  });

  writeReport(log, price);
  console.log('\n=== HOÀN TẤT CHUỖI TEST (xem báo cáo để biết bước nào FAIL) ===');
}

function writeReport(log: StepLog[], price: number): void {
  const lines = [
    '# Test chu trình đặt/hủy/dời lệnh — Binance Futures TESTNET (TICKET-077 1.3 Bước B)',
    '',
    `Sinh tự động ${new Date().toISOString()}. Symbol: ${SYMBOL}, quantity=${QUANTITY}, giá tham chiếu=${price}.`,
    '',
    '| # | Bước | Kết quả | Độ trễ (ms) | Chi tiết |',
    '|---|---|---|---|---|',
    ...log.map((l, i) => `| ${i + 1} | ${l.step} | ${l.ok ? 'OK' : 'FAIL'} | ${l.latencyMs ?? '-'} | ${JSON.stringify(l.detail).slice(0, 300)} |`),
  ];
  const reportPath = path.resolve(process.cwd(), 'data/testnet-order-lifecycle-report.md');
  writeFileSync(reportPath, lines.join('\n'));
  console.log(`→ ${reportPath}`);
}

main().catch((err) => {
  console.error('testOrderLifecycleTestnet failed:', err);
  process.exit(1);
});
