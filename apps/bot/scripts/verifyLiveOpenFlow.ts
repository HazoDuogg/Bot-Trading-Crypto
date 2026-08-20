/**
 * TICKET-099 Phần B — kiểm chứng luồng "vào lệnh" thật sự chạy được, không chờ may rủi thị trường.
 *
 * KHÔNG đụng liveRunner.ts chính, KHÔNG sửa logic Regime/Entry/XGBoost/Risk. `handleOpenEvent()` là
 * hàm nội bộ (đóng trong `main()` của liveRunner.ts, không export được) nên script này TÁI TẠO ĐÚNG
 * chuỗi bước handleOpenEvent() thực hiện (xem liveRunner.ts dòng ~196-208), gọi thẳng các module thật
 * (BinanceOrderExecutor, TelegramMessageQueue, formatPositionOpenedMessage) — không viết lại/simulate
 * bằng code giả.
 *
 * DraftSetup giả lập lấy TỪ 1 DÒNG THẬT trong data/backtest-trades-livecapital-risk5-bal100-margincap12.5.csv
 * (baseline đã chốt, xác nhận từng tạo tín hiệu thật trong backtest 6 tháng) — symbol/side/entryPrice/
 * setupType/regime/tpPlan lấy nguyên văn từ dòng đó. slPrice/marginRequired/tpLevels tính bằng ĐÚNG
 * các hàm production thật (DynamicRMarginSizer, computeTpLevels/priceAtR) — không tự chế công thức.
 *
 * LUÔN dryRun=true — đây là bài rehearsal, không có cờ nào lật sang dryRun=false trong script này.
 *
 * Run: npm run build:scripts && node apps/bot/scripts-dist/verifyLiveOpenFlow.js
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BinanceOrderExecutor } from '../dist/live/binanceOrderExecutor.js';
import { loadBinanceEnvConfig } from '../dist/live/envConfig.js';
import { loadTelegramConfig } from '../dist/telegram/telegramClient.js';
import { TelegramMessageQueue } from '../dist/telegram/messageQueue.js';
import { formatPositionOpenedMessage } from '../dist/telegram/messageFormatters.js';
import { DynamicRMarginSizer } from '../dist/risk/dynamicRMarginSizer.js';
import { computeTpLevels } from '../dist/risk/slTpManager.js';
import { MarketRegime } from '../dist/regime/types.js';
import type { OpenTradeEvent } from '../dist/orchestrator/types.js';

const TRADES_CSV = path.resolve(process.cwd(), 'data/backtest-trades-livecapital-risk5-bal100-margincap12.5.csv');
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];

// Đúng config chính thức đã chốt — không đụng vào (memory/project_official_backtest_config.md).
const RISK_DOLLAR_OR_PERCENT = 5;
const MAX_MARGIN_CAP = 12.5;
const LEVERAGE = 30;
const TAKER_FEE_RATE = 0.0004;

function roundQty(qty: number): number {
  return Math.round(qty * 1000) / 1000;
}

/** Reads the first TREND_RIDER/OB row from the confirmed baseline CSV — a real signal that actually fired during the 6-month backtest, not an invented one. */
function readRealTrendRiderObRow(): { symbol: string; side: 'LONG' | 'SHORT'; entryPrice: number; tpPlan: 'PLAN_A' | 'PLAN_B' } {
  const lines = readFileSync(TRADES_CSV, 'utf-8').trim().split('\n');
  for (const line of lines.slice(1)) {
    const cols = line.split(',');
    const [symbol, side, regime, setupType, tpPlan, , entryPriceStr] = cols;
    if (regime === 'TREND_RIDER' && setupType === 'OB') {
      return { symbol, side: side as 'LONG' | 'SHORT', entryPrice: Number(entryPriceStr), tpPlan: tpPlan as 'PLAN_A' | 'PLAN_B' };
    }
  }
  throw new Error(`verifyLiveOpenFlow: không tìm thấy dòng TREND_RIDER/OB nào trong ${TRADES_CSV}`);
}

async function main(): Promise<void> {
  const envConfig = loadBinanceEnvConfig();
  console.log(`Môi trường: ${envConfig.env}. dryRun=true CỐ ĐỊNH (script rehearsal, không có cờ lật sang false).`);

  const executor = new BinanceOrderExecutor({
    credentials: { apiKey: envConfig.apiKey, apiSecret: envConfig.apiSecret, baseUrl: envConfig.baseUrl },
    dryRun: true,
  });
  await executor.syncClock();
  await executor.loadExchangeInfo(SYMBOLS); // TICKET-099 Phần A — cùng bước liveRunner.ts thật làm trước khi vào lệnh

  const telegramConfig = loadTelegramConfig();
  const telegramQueue = new TelegramMessageQueue(telegramConfig);

  const real = readRealTrendRiderObRow();
  console.log(`Dùng dòng thật từ CSV: ${real.symbol} ${real.side} entry=${real.entryPrice} (TREND_RIDER/OB, đã từng thắng/thua thật trong backtest 6 tháng).`);

  // slPrice: đơn giản hóa có chủ đích — không tái tạo lại state indicator gốc từ CSV (CSV không lưu
  // ATR tại thời điểm đó). Dùng 1% khoảng cách, chỉ để có 1 slPrice hợp lệ cho phép tính size/TP —
  // KHÔNG phải công thức SL thật của OB (đó vẫn là ATR-buffer trong entryRouter.ts, không đổi).
  const slDistancePercent = 0.01;
  const slPrice = real.side === 'LONG' ? real.entryPrice * (1 - slDistancePercent) : real.entryPrice * (1 + slDistancePercent);

  const sizer = new DynamicRMarginSizer();
  const sizing = sizer.calculate({
    accountBalance: 100,
    entryPrice: real.entryPrice,
    riskDollarOrPercent: RISK_DOLLAR_OR_PERCENT,
    leverage: LEVERAGE,
    slDistancePercent,
    maxMarginCap: MAX_MARGIN_CAP,
  });

  const tpLevels = computeTpLevels({ scenario: 'TREND', entryPrice: real.entryPrice, slPrice, side: real.side, tpPlan: real.tpPlan });

  const event: OpenTradeEvent = {
    type: 'OPEN',
    symbol: real.symbol,
    side: real.side,
    regime: MarketRegime.TREND_RIDER,
    setupType: 'OB',
    tpPlan: real.tpPlan,
    entryTimestamp: Date.now(),
    entryPrice: real.entryPrice,
    riskMultiplier: 1,
    actualRiskDollar: sizing.actualRiskDollar,
    marginRequired: sizing.marginRequired,
    slPrice,
    tpLevels,
    riskPoolPctBefore: 0,
    riskPoolPctAfter: (sizing.actualRiskDollar / 100) * 100, // % của $100 vốn thật, chỉ để hiển thị — không phải risk pool logic thật
  };

  // ĐÚNG chuỗi bước handleOpenEvent() thật thực hiện (liveRunner.ts ~196-208), dryRun=true nhánh:
  const quantity = roundQty((event.marginRequired * LEVERAGE) / event.entryPrice);
  console.log(`[SẼ MỞ LỆNH] ${event.symbol} ${event.side} entry=${event.entryPrice} sl=${event.slPrice} qty=${quantity} setupType=${event.setupType}`);

  const dryRunResult = await executor.openMarketPosition(event.symbol, event.side, quantity, event.entryPrice);
  if (!('dryRun' in dryRunResult)) {
    throw new Error('verifyLiveOpenFlow: executor.openMarketPosition KHÔNG trả về DryRunResult dù dryRun=true — dừng ngay, không được để lọt lệnh thật.');
  }
  console.log(`Xác nhận: openMarketPosition() bị chặn đúng bởi dryRun (không gọi API thật). Request sẽ gửi: ${JSON.stringify(dryRunResult.params)}`);

  telegramQueue.enqueue(formatPositionOpenedMessage(event, { env: envConfig.env, accountBalanceAtOpen: 100 }) + '\n\n[DRY-RUN]\n[TICKET-099 Phần B — tin nhắn kiểm chứng, không phải lệnh thật]');

  const outcomes = await telegramQueue.flush();
  const last = outcomes[outcomes.length - 1];
  if (last.failed.length > 0) {
    throw new Error(`verifyLiveOpenFlow: gửi Telegram THẤT BẠI: ${last.failed.map((f) => `${f.chatId}: ${f.error.message}`).join('; ')}`);
  }
  console.log(`Xác nhận: Telegram gửi THÀNH CÔNG tới ${last.succeeded.length} chat(s).`);
  console.log('');
  console.log('KẾT LUẬN: toàn bộ chuỗi tính size -> gọi BinanceOrderExecutor (dryRun=true) -> gửi Telegram đã chạy đúng, không lỗi.');
}

main().catch((err) => {
  console.error(`verifyLiveOpenFlow: LỖI — ${(err as Error).message}`);
  process.exit(1);
});
