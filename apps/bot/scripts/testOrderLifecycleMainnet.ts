/**
 * TICKET-077 1.3 Bước D — test chu trình đặt/hủy/dời lệnh trên Binance Futures MAINNET (TIỀN THẬT,
 * size TỐI THIỂU). LƯU Ý QUAN TRỌNG: Claude Code không tự chạy script này — theo quy tắc an toàn,
 * việc thực hiện giao dịch tài chính thật (dù size tối thiểu) phải do PM tự tay chạy.
 *
 * Chốt an toàn KÉP (cả 2 đều bắt buộc, thiếu 1 sẽ dừng ngay không gọi API nào):
 *   1. `ENV=mainnet` trong .env hoặc biến môi trường (mặc định là testnet, không phải mainnet).
 *   2. Cờ CLI `--confirm-real-money=YES` — phải gõ đúng chữ hoa "YES", không có giá trị mặc định.
 *
 * Run: `ENV=mainnet npm run test-order-lifecycle-mainnet -- --confirm-real-money=YES`
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadBinanceEnvConfig } from '../dist/live/envConfig.js';
import { BinanceOrderExecutor, type OrderResult, type AlgoOrderResult, type DryRunResult } from '../dist/live/binanceOrderExecutor.js';

const SYMBOL = 'ETHUSDT';
const QUANTITY = 0.012; // ~$23-24 notional tại giá hiện tại — TỐI THIỂU vượt MIN_NOTIONAL=20 thật của mainnet
const PARTIAL_QUANTITY = 0.006;

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

function requireExplicitMainnetConfirmation(): void {
  const flag = process.argv.find((a) => a.startsWith('--confirm-real-money='));
  const value = flag?.split('=')[1];
  if (value !== 'YES') {
    throw new Error(
      'testOrderLifecycleMainnet: THIẾU XÁC NHẬN — script này đặt lệnh THẬT bằng TIỀN THẬT. ' +
        'Phải chạy với đúng cờ --confirm-real-money=YES (chữ hoa). Dừng lại, KHÔNG gọi API nào.',
    );
  }
}

async function main(): Promise<void> {
  requireExplicitMainnetConfirmation();

  const { env, baseUrl, apiKey, apiSecret } = loadBinanceEnvConfig();
  if (env !== 'mainnet') {
    throw new Error(`testOrderLifecycleMainnet: script này CHỈ chạy khi ENV=mainnet — hiện tại ENV=${env}. Dừng lại.`);
  }

  console.log('\n!!! XÁC NHẬN LẦN CUỐI: SẮP ĐẶT LỆNH THẬT BẰNG TIỀN THẬT TRÊN MAINNET !!!');
  console.log(`Symbol: ${SYMBOL}, quantity: ${QUANTITY} (~$${(QUANTITY * (await getPrice(baseUrl, SYMBOL))).toFixed(2)} notional)\n`);

  const log: StepLog[] = [];
  const executor = new BinanceOrderExecutor({
    credentials: { baseUrl, apiKey, apiSecret },
    dryRun: false,
    onOrderFailure: (context, err) => console.error(`  [onOrderFailure] ${context}: ${err.message}`),
  });
  await executor.syncClock();

  // Double-check log môi trường TRƯỚC MỖI thao tác — in lại banner mainnet trước từng bước, đúng yêu
  // cầu ticket ("mọi thao tác double-check log xác nhận đang ở mainnet trước khi chạy").
  function logEnvBeforeStep(stepName: string): void {
    console.log(`\n[ENV CHECK] MAINNET — TIỀN THẬT — chuẩn bị chạy: ${stepName}`);
  }

  async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    logEnvBeforeStep(name);
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
  console.log(`Giá tham chiếu ${SYMBOL} lúc bắt đầu: ${price}`);

  // 1. Đặt lệnh MARKET mở vị thế (size tối thiểu)
  await step('1_openMarketPosition', () => executor.openMarketPosition(SYMBOL, 'LONG', QUANTITY, price));

  // 2. Poll getPositionRisk() để xác nhận khớp
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

  // 5. Dời SL
  if (currentSlAlgoId !== undefined) {
    const moved = await step('5_updateStopOrder(doiSL)', () => executor.updateStopOrder(SYMBOL, currentSlAlgoId as number, 'LONG', Number((price * 0.96).toFixed(2)), QUANTITY));
    if (isAlgoOrderResult(moved)) currentSlAlgoId = moved.algoId;
  }

  // 6. Dời TP
  if (currentTpAlgoId !== undefined) {
    const moved = await step('6_moveTP(cancel+placeLai)', async () => {
      await executor.cancelAlgoOrder(SYMBOL, currentTpAlgoId as number);
      return executor.placeTakeProfitMarket(SYMBOL, 'LONG', Number((price * 1.04).toFixed(2)), QUANTITY);
    });
    if (isAlgoOrderResult(moved)) currentTpAlgoId = moved.algoId;
  }

  // 7. Đóng 1 phần
  await step('7_closePositionMarket(partial)', () => executor.closePositionMarket(SYMBOL, 'LONG', PARTIAL_QUANTITY));

  // 8. Đóng nốt phần còn lại
  const remainingQuantity = Number((QUANTITY - PARTIAL_QUANTITY).toFixed(3));
  await step('8_closePositionMarket(remaining)', () => executor.closePositionMarket(SYMBOL, 'LONG', remainingQuantity));

  // 9. Xác nhận vị thế về 0
  await step('9_verifyFlatAfterClose', async () => {
    const positions = (await executor.getPositionRisk(SYMBOL)) as Array<{ symbol: string; positionAmt: string }>;
    const pos = positions.find((p) => p.symbol === SYMBOL);
    const amt = pos ? Number(pos.positionAmt) : 0;
    if (Math.abs(amt) > 1e-6) throw new Error(`vị thế CHƯA về 0 sau khi đóng hết: positionAmt=${amt}`);
    return { positionAmt: amt };
  });

  // 10. PHÁT HIỆN THẬT trên mainnet (lần chạy trước): Binance KHÔNG tự hủy Algo Order (SL/TP) còn
  // treo sau khi vị thế đã đóng hết — BẮT BUỘC hủy ĐÚNG 2 algoId (SL+TP) của vị thế NÀY, KHÔNG hủy
  // hàng loạt theo symbol (sẽ xóa nhầm SL/TP của vị thế khác đang mở cùng coin).
  if (currentSlAlgoId !== undefined) {
    await step('10a_cancelAlgoOrder(SL của vị thế này)', () => executor.cancelAlgoOrder(SYMBOL, currentSlAlgoId as number));
  }
  if (currentTpAlgoId !== undefined) {
    await step('10b_cancelAlgoOrder(TP của vị thế này)', () => executor.cancelAlgoOrder(SYMBOL, currentTpAlgoId as number));
  }

  writeReport(log, price);
  console.log('\n=== HOÀN TẤT BƯỚC D (xem báo cáo để biết bước nào FAIL — kiểm tra thủ công trên UI Binance nếu có FAIL) ===');
}

function writeReport(log: StepLog[], price: number): void {
  const lines = [
    '# Test chu trình đặt/hủy/dời lệnh — Binance Futures MAINNET, TIỀN THẬT (TICKET-077 1.3 Bước D)',
    '',
    `Sinh tự động ${new Date().toISOString()}. Symbol: ${SYMBOL}, quantity=${QUANTITY}, giá tham chiếu=${price}.`,
    '',
    '| # | Bước | Kết quả | Độ trễ (ms) | Chi tiết |',
    '|---|---|---|---|---|',
    ...log.map((l, i) => `| ${i + 1} | ${l.step} | ${l.ok ? 'OK' : 'FAIL'} | ${l.latencyMs ?? '-'} | ${JSON.stringify(l.detail).slice(0, 300)} |`),
  ];
  const reportPath = path.resolve(process.cwd(), 'data/mainnet-order-lifecycle-report.md');
  writeFileSync(reportPath, lines.join('\n'));
  console.log(`\n→ ${reportPath}`);
}

main().catch((err) => {
  console.error('testOrderLifecycleMainnet failed:', err);
  process.exit(1);
});
