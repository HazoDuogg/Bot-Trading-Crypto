/**
 * TICKET-086 — the live-bot loop: wires liveCandleFeed.ts + orchestrator.ts + binanceOrderExecutor.ts
 * + stateReconciler.ts + the telegram/ module (TICKET-078) into ONE continuous process. Does NOT
 * touch any core Regime/Entry/XGBoost/Risk logic — processCandle() is called exactly the same way
 * backtest.ts already calls it, just fed live-polled candles instead of CSV rows.
 *
 * DESIGN: a REAL ManagedPositionState is tracked per open position (via SymbolState.openPositions,
 * same shape backtest.ts uses) and advanced by processCandle() itself on every live-closed 5m candle
 * — the SAME simulation backtest.ts trusts for 6 months of history. Whenever that simulation reports
 * a state change (new position, partial fill, full close, SL moved by trailing), this file issues the
 * matching REAL Binance order action (dryRun-gated) so the exchange's actual SL/TP orders track the
 * simulated position exactly. StateReconciler runs alongside as a SAFETY NET (log-only, never
 * auto-corrects, per its own TICKET-076 Phần D design) — not the primary signal source.
 *
 * KNOWN LIMITATIONS (honest, not hidden — see README before flipping dryRun=false):
 *   - Order quantity/price are rounded to a fixed decimal count, NOT validated against each symbol's
 *     real LOT_SIZE/PRICE_FILTER from GET /fapi/v1/exchangeInfo — a real (if usually small) rejection
 *     risk at true scale. Follow-up ticket needed before dryRun=false at full size.
 *   - No slippage simulated between a candle's close (what sizing/SL/TP prices are computed from) and
 *     the real MARKET fill price — same simplification backtest.ts's own report already documents.
 *   - LOW_LIQUIDITY regime is permanently unreachable here (candles5mSessionVolume omitted) — same
 *     "optional, omit = unreachable, no error" contract regime/types.ts already documents.
 *
 * Run: npm run build:scripts && node apps/bot/scripts-dist/liveRunner.js
 * ENV=testnet|mainnet in .env selects the Binance environment (default testnet, per envConfig.ts).
 */
import 'dotenv/config';
import { LiveCandleFeed, type CandleData } from '../dist/live/liveCandleFeed.js';
import { BinanceOrderExecutor, type PositionSide } from '../dist/live/binanceOrderExecutor.js';
import { StateReconciler, type InternalStateSnapshot } from '../dist/live/stateReconciler.js';
import { loadBinanceEnvConfig } from '../dist/live/envConfig.js';
import { processCandle, type ProcessCandleInput } from '../dist/orchestrator/orchestrator.js';
import {
  INITIAL_SYMBOL_STATE,
  type CloseTradeEvent,
  type OpenPositionEntry,
  type OpenTradeEvent,
  type OrchestratorConfig,
  type PartialCloseEvent,
  type SymbolState,
} from '../dist/orchestrator/types.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG } from '../dist/entry/entryRouter.js';
import { DEFAULT_MOMENTUM_FILTER_CONFIG, DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG, DEFAULT_PLAN_AUTO_SELECTION_CONFIG } from '../dist/xgbFilter/config.js';
import { loadTelegramConfig } from '../dist/telegram/telegramClient.js';
import { TelegramMessageQueue } from '../dist/telegram/messageQueue.js';
import { formatBotStartMessage, formatFullCloseMessage, formatPartialCloseMessage, formatPositionOpenedMessage, formatRegimeChangeMessage } from '../dist/telegram/messageFormatters.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const TICK_INTERVAL_MS = 5_000; // how often we check "has a new 5m candle closed" — cheap, reads already-polled in-memory buffers only

// Official confirmed live config — TICKET-084/085's 8-flag baseline + risk-dollar-or-percent=5/
// max-margin-cap=12.5 (real $100 capital scale). Do NOT change any value here without a PM-confirmed
// backtest re-verification (see memory/project_official_backtest_config.md) — this file only WIRES
// the already-decided config into a live loop, it doesn't decide the config.
const CONFIG: OrchestratorConfig = {
  entryRouterConfig: { ...DEFAULT_ENTRY_ROUTER_CONFIG },
  tpPlan: 'PLAN_A',
  takerFeeRate: 0.0004,
  riskDollarOrPercent: 5,
  maxMarginCap: 12.5,
  leverage: 30,
  riskPoolMaxPct: 0.15,
  isLowConfidenceOrLowLiquidity: false,
  momentumFilterConfig: DEFAULT_MOMENTUM_FILTER_CONFIG,
  neutralTransitionGateConfig: DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG,
  planAutoSelectionConfig: { ...DEFAULT_PLAN_AUTO_SELECTION_CONFIG, planAutoSelectionEnabled: true },
  maxConcurrentPositionsPerSymbol: 2,
  momentumDirectEnabled: true,
  momentumDirectThreshold: 0.5,
  momentumDirectMaxAtrPercentile: 100,
  momentumDirectMinSlPercent: 1.0,
  momentumDirectTpRMultiple: 3.0,
  momentumDirectMaxTotalConcurrent: 999,
  momentumDirectCorrelationRiskThreshold: 999,
  momentumDirectCorrelationRiskMultiplier: 1.0,
  momentumDirectCircuitBreakerLossThreshold: 999999,
  momentumDirectCircuitBreakerCooldownMs: 0,
};

const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;
const WINDOW_1H_MOMENTUM = 250; // LiveCandleFeed's own 1h buffer is configured to this size below; we slice the last 40 of it for candles1h.

/** Per-open-position bookkeeping needed to keep the exchange's real algo orders in sync with the simulated ManagedPositionState. */
interface LiveOrderIds {
  slAlgoId: number | null; // null only in dryRun (no real algoId to track)
  tpAlgoIds: number[]; // one per fixed-price TP tier (TP1/TP2/COUNTER_TREND_TP) still pending on the exchange
}

interface RunnerSymbolState {
  symbolState: SymbolState;
  lastProcessedCandleTimestamp: number | null;
  // keyed by entryTimestamp (unique per position within a symbol, same key style as PartialCloseEvent dedupe) — see dedupe note in the tick loop.
  orderIds: Map<number, LiveOrderIds>;
}

function roundQty(qty: number): number {
  // KNOWN LIMITATION — see module doc comment: not validated against real LOT_SIZE per symbol.
  return Math.round(qty * 1000) / 1000;
}
function roundPrice(price: number): number {
  // KNOWN LIMITATION — see module doc comment: not validated against real PRICE_FILTER per symbol.
  return Math.round(price * 100) / 100;
}

async function main(): Promise<void> {
  const envConfig = loadBinanceEnvConfig(); // prints the required MAINNET/TESTNET banner
  const envLabel = envConfig.env; // 'testnet' | 'mainnet'
  const dryRun = process.argv.includes('--dry-run=false') ? false : true; // default true, NEVER default false — TICKET-086's hard rule
  console.log(`dryRun=${dryRun}${dryRun ? ' (KHÔNG gọi API đặt lệnh thật — chỉ log)' : ' !!! SẼ ĐẶT LỆNH THẬT !!!'}`);

  const executor = new BinanceOrderExecutor({
    credentials: { apiKey: envConfig.apiKey, apiSecret: envConfig.apiSecret, baseUrl: envConfig.baseUrl },
    dryRun,
    onOrderFailure: (context, err) => console.error(`[ORDER_FAILURE] ${context}: ${err.message}`),
    onOrderCountUpdate: (c10s, l10s, c1m, l1m) => {
      if (c10s / l10s > 0.8 || c1m / l1m > 0.8) console.warn(`[ORDERS rate cảnh báo] 10s=${c10s}/${l10s}, 1m=${c1m}/${l1m}`);
    },
  });
  await executor.syncClock();

  const accountInfo = (await executor.getAccountInfo()) as { totalWalletBalance?: string };
  let accountBalance = Number(accountInfo.totalWalletBalance);
  if (!Number.isFinite(accountBalance) || accountBalance <= 0) {
    throw new Error(`liveRunner: không đọc được totalWalletBalance hợp lệ từ getAccountInfo(): ${JSON.stringify(accountInfo)}`);
  }
  console.log(`Vốn hiện tại (từ sàn): $${accountBalance.toFixed(2)}`);

  const telegramConfig = loadTelegramConfig();
  const telegramQueue = new TelegramMessageQueue(telegramConfig);

  const feed = new LiveCandleFeed({
    symbols: SYMBOLS,
    baseUrl: envConfig.baseUrl,
    windowSizes: { '1h': WINDOW_1H_MOMENTUM }, // covers both candles1h (last 40) and candles1hMomentum (full 250) from the SAME buffer
    onError: (err, symbol, interval) => console.error(`[FEED_ERROR] ${symbol} ${interval}: ${err.message}`),
    onGapFilled: (symbol, interval, gaps) => console.log(`[FEED] ${symbol} ${interval}: đã vá ${gaps.length} khoảng trống`),
    onThrottled: (symbol, interval) => console.warn(`[FEED_THROTTLE] ${symbol} ${interval}: bỏ qua poll (gần chạm ngưỡng weight)`),
  });
  console.log('Đang tải lịch sử nến ban đầu cho 4 coin...');
  await feed.start();
  console.log('LiveCandleFeed đã sẵn sàng.');

  telegramQueue.enqueue(
    formatBotStartMessage({
      env: envLabel,
      symbols: SYMBOLS,
      balance: accountBalance,
      momentumDirectEnabled: CONFIG.momentumDirectEnabled,
      riskPoolMaxPct: CONFIG.riskPoolMaxPct,
      maxConcurrentPositionsPerSymbol: CONFIG.maxConcurrentPositionsPerSymbol,
      timestamp: Date.now(),
    }) + (dryRun ? '\n\n[DRY-RUN MODE — chưa đặt lệnh thật]' : ''),
  );

  const runnerState: Record<string, RunnerSymbolState> = {};
  for (const symbol of SYMBOLS) {
    runnerState[symbol] = { symbolState: INITIAL_SYMBOL_STATE, lastProcessedCandleTimestamp: null, orderIds: new Map() };
  }

  let regimeChangeCount = 0;
  let willOpenCount = 0;
  let tickErrorCount = 0;

  function slice(candles: CandleData[], windowSize: number): CandleData[] {
    return candles.length > windowSize ? candles.slice(candles.length - windowSize) : candles;
  }

  /** Places the SL + fixed-price TP algo orders for a freshly-opened position, mirroring scripts/testOrderLifecycleTestnet.ts's exact pattern. Real calls only when !dryRun. */
  async function placeInitialOrders(symbol: string, side: PositionSide, event: OpenTradeEvent, quantity: number): Promise<LiveOrderIds> {
    const slResult = await executor.placeStopMarket(symbol, side, roundPrice(event.slPrice), quantity);
    const slAlgoId = 'algoId' in slResult ? slResult.algoId : null;

    const tpAlgoIds: number[] = [];
    for (const tp of event.tpLevels) {
      if (tp.price === null) continue; // TP3_RUNNER — trailing-managed via SL moves only, never a fixed order
      const tpQty = roundQty(quantity * tp.closePercent);
      if (tpQty <= 0) continue;
      const tpResult = await executor.placeTakeProfitMarket(symbol, side, roundPrice(tp.price), tpQty);
      if ('algoId' in tpResult) tpAlgoIds.push(tpResult.algoId);
    }
    return { slAlgoId, tpAlgoIds };
  }

  async function handleOpenEvent(symbol: string, event: OpenTradeEvent, balanceAtOpen: number): Promise<void> {
    const quantity = roundQty(event.marginRequired * CONFIG.leverage / event.entryPrice);
    if (dryRun) {
      console.log(`[SẼ MỞ LỆNH] ${symbol} ${event.side} entry=${event.entryPrice} sl=${event.slPrice} qty=${quantity} setupType=${event.setupType}`);
      willOpenCount++;
    } else {
      const openResult = await executor.openMarketPosition(symbol, event.side, quantity);
      if (!('orderId' in openResult)) throw new Error(`liveRunner: openMarketPosition trả về DryRunResult dù dryRun=false — không nên xảy ra`);
      const orderIds = await placeInitialOrders(symbol, event.side, event, quantity);
      runnerState[symbol].orderIds.set(event.entryTimestamp, orderIds);
    }
    telegramQueue.enqueue(formatPositionOpenedMessage(event, { env: envLabel, accountBalanceAtOpen: balanceAtOpen }) + (dryRun ? '\n\n[DRY-RUN]' : ''));
  }

  async function handlePartialCloseEvent(symbol: string, event: PartialCloseEvent, entryTimestampOfPosition: number, remainingQuantity: number): Promise<void> {
    if (dryRun) {
      console.log(`[SẼ CHỐT MỘT PHẦN] ${symbol} ${event.tier} newSl=${event.newSlPrice}`);
    } else {
      const ids = runnerState[symbol].orderIds.get(entryTimestampOfPosition);
      if (ids?.slAlgoId != null && remainingQuantity > 0) {
        const newSl = await executor.updateStopOrder(symbol, ids.slAlgoId, event.side, roundPrice(event.newSlPrice), roundQty(remainingQuantity));
        if ('algoId' in newSl) ids.slAlgoId = newSl.algoId;
      }
    }
    telegramQueue.enqueue(formatPartialCloseMessage(event, { env: envLabel }) + (dryRun ? '\n\n[DRY-RUN]' : ''));
  }

  async function handleCloseEvent(symbol: string, event: CloseTradeEvent): Promise<void> {
    if (dryRun) {
      console.log(`[SẼ ĐÓNG LỆNH] ${symbol} exitReason=${event.exitReason} pnlUsd=${event.pnlUsd.toFixed(2)}`);
    } else {
      const ids = runnerState[symbol].orderIds.get(event.entryTimestamp);
      if (ids) {
        if (ids.slAlgoId != null) await executor.cancelAlgoOrder(symbol, ids.slAlgoId).catch((e) => console.error(`[CLEANUP] hủy SL lỗi: ${(e as Error).message}`));
        for (const tpId of ids.tpAlgoIds) await executor.cancelAlgoOrder(symbol, tpId).catch((e) => console.error(`[CLEANUP] hủy TP lỗi: ${(e as Error).message}`));
        runnerState[symbol].orderIds.delete(event.entryTimestamp);
      }
    }
    telegramQueue.enqueue(formatFullCloseMessage(event, { env: envLabel }) + (dryRun ? '\n\n[DRY-RUN]' : ''));
  }

  async function tick(): Promise<void> {
    try {
      const now = Date.now();

      // Correlated-risk ratio: same once-per-step-across-4-symbols computation backtest.ts uses.
      const w1hBySymbol: Record<string, CandleData[]> = {};
      for (const symbol of SYMBOLS) w1hBySymbol[symbol] = slice(feed.getClosedCandles(symbol, '1h', now), WINDOW_1H);
      const correlatedRiskRatioSeries = computeCorrelatedRiskRatio(w1hBySymbol, RegimeConfig.CORRELATED_RISK_WINDOW_CANDLES, 'BTCUSDT');
      const correlatedRiskRatio = correlatedRiskRatioSeries[correlatedRiskRatioSeries.length - 1];

      const momentumDirectOpenPositionsTotal = SYMBOLS.reduce(
        (sum, s) => sum + runnerState[s].symbolState.openPositions.filter((e) => e.meta.setupType === 'MOMENTUM_DIRECT').length,
        0,
      );
      const momentumDirectOpenPositions: Array<{ symbol: string; side: 'LONG' | 'SHORT' }> = SYMBOLS.flatMap((s) =>
        runnerState[s].symbolState.openPositions.filter((e) => e.meta.setupType === 'MOMENTUM_DIRECT').map((e) => ({ symbol: s, side: e.position.side })),
      );
      const allOpenPositionsRisk = SYMBOLS.map((s) => ({
        id: s,
        actualRiskDollar: runnerState[s].symbolState.openPositions.reduce((sum, e) => sum + e.meta.actualRiskDollar, 0),
      })).filter((r) => r.actualRiskDollar > 0);

      for (const symbol of SYMBOLS) {
        const rs = runnerState[symbol];
        const closed5m = feed.getClosedCandles(symbol, '5m', now);
        if (closed5m.length === 0) continue;
        const latestClosed = closed5m[closed5m.length - 1];
        if (rs.lastProcessedCandleTimestamp !== null && latestClosed.timestamp <= rs.lastProcessedCandleTimestamp) continue; // already processed this candle

        const window5m = slice(closed5m, WINDOW_5M);
        const window15m = slice(feed.getClosedCandles(symbol, '15m', now), WINDOW_15M);
        const window1hFull = feed.getClosedCandles(symbol, '1h', now);
        const window1h = slice(window1hFull, WINDOW_1H);
        const window1hMomentum = slice(window1hFull, WINDOW_1H_MOMENTUM);
        const window1m = slice(feed.getClosedCandles(symbol, '1m', now), WINDOW_1M);
        const window1d = slice(feed.getClosedCandles(symbol, '1d', now), WINDOW_1D);

        const input: ProcessCandleInput = {
          symbol,
          candles5m: window5m,
          candles15m: window15m,
          candles1h: window1h,
          candles1m: window1m,
          candles1d: window1d,
          candles1hMomentum: window1hMomentum,
          correlatedRiskRatio,
          accountBalance,
          allOpenPositionsRisk,
          momentumDirectOpenPositionsTotal,
          momentumDirectOpenPositions,
        };

        const previousRegime = rs.symbolState.regimeState.previousRegime;
        let lastComputedMetrics: { adx1h?: number; atrPercentile5m?: number } = {};
        const result = await processCandle(input, rs.symbolState, CONFIG, undefined, undefined, undefined, undefined, (m) => {
          lastComputedMetrics = m;
        });

        const newRegime = result.symbolState.regimeState.previousRegime;
        if (previousRegime !== null && newRegime !== null && previousRegime !== newRegime) {
          regimeChangeCount++;
          console.log(`[ĐỔI TRẠNG THÁI] ${symbol}: ${previousRegime} → ${newRegime} (adx1h=${lastComputedMetrics.adx1h?.toFixed(1) ?? 'N/A'}, atrPercentile5m=${lastComputedMetrics.atrPercentile5m?.toFixed(0) ?? 'N/A'})`);
          telegramQueue.enqueue(
            formatRegimeChangeMessage({
              symbol,
              fromRegime: previousRegime,
              toRegime: newRegime,
              adx1h: lastComputedMetrics.adx1h,
              atrPercentile5m: lastComputedMetrics.atrPercentile5m,
              timestamp: latestClosed.timestamp,
            }),
          );
        }

        for (const event of result.events) {
          if (event.type === 'OPEN') {
            await handleOpenEvent(symbol, event, accountBalance).catch((e) => console.error(`[OPEN_HANDLER_ERROR] ${symbol}: ${(e as Error).message}`));
          } else if (event.type === 'PARTIAL_CLOSE') {
            // Find the still-open position this partial fill belongs to (same symbol+side, only one such position expected per TICKET-056's 2-slot design when a partial just fired on it).
            const owner = result.symbolState.openPositions.find((e) => e.position.side === event.side);
            const remainingQuantity = owner ? owner.position.remainingPositionSize / owner.position.entryPrice : 0;
            await handlePartialCloseEvent(symbol, event, owner?.meta.entryTimestamp ?? -1, remainingQuantity).catch((e) => console.error(`[PARTIAL_HANDLER_ERROR] ${symbol}: ${(e as Error).message}`));
          } else if (event.type === 'CLOSE') {
            await handleCloseEvent(symbol, event).catch((e) => console.error(`[CLOSE_HANDLER_ERROR] ${symbol}: ${(e as Error).message}`));
          }
          // SKIPPED events are diagnostic-only (risk pool full / neutral gate rejected) — logged, no Telegram spam per candle.
        }

        rs.symbolState = result.symbolState;
        accountBalance = result.accountBalance;
        rs.lastProcessedCandleTimestamp = latestClosed.timestamp;
      }
    } catch (err) {
      tickErrorCount++;
      console.error(`[TICK_ERROR] (đã bắt, KHÔNG crash tiến trình): ${(err as Error).stack ?? (err as Error).message}`);
    }
  }

  const tickTimer = setInterval(() => void tick(), TICK_INTERVAL_MS);

  // TICKET-077 Phần D — safety-net reconciliation, log-only, never auto-corrects (per its own design).
  const reconciler = new StateReconciler({
    executor,
    getInternalState: (): InternalStateSnapshot => ({
      balanceUsd: accountBalance,
      positions: SYMBOLS.flatMap((s) =>
        runnerState[s].symbolState.openPositions.map((e: OpenPositionEntry) => ({ symbol: s, side: e.position.side, quantity: e.position.remainingPositionSize / e.position.entryPrice })),
      ),
    }),
    onMismatch: (result) => {
      console.warn(`[RECONCILE_MISMATCH] ${result.mismatches.length} lệch được phát hiện:`);
      for (const m of result.mismatches) console.warn(`  - ${m.type}: ${m.detail}`);
      console.log(`[SUMMARY] regimeChangeCount=${regimeChangeCount}, willOpenCount(dryRun)=${willOpenCount}, tickErrorCount=${tickErrorCount}`);
    },
    onClean: () => {
      console.log(`[RECONCILE] OK — nội bộ khớp với sàn.`);
      console.log(`[SUMMARY] regimeChangeCount=${regimeChangeCount}, willOpenCount(dryRun)=${willOpenCount}, tickErrorCount=${tickErrorCount}`);
    },
    onError: (err) => console.error(`[RECONCILE_ERROR] (đã bắt, KHÔNG crash): ${err.message}`),
  });
  reconciler.start();

  console.log(`Vòng lặp live-bot đã khởi động. dryRun=${dryRun}, môi trường=${envLabel.toUpperCase()}.`);

  // Never let an unhandled error kill the whole process (ticket's explicit "KHÔNG crash" requirement).
  process.on('uncaughtException', (err) => console.error(`[UNCAUGHT_EXCEPTION] (đã bắt, tiến trình vẫn chạy): ${err.stack ?? err.message}`));
  process.on('unhandledRejection', (reason) => console.error(`[UNHANDLED_REJECTION] (đã bắt, tiến trình vẫn chạy): ${String(reason)}`));

  const shutdown = async (): Promise<void> => {
    console.log('Đang dừng liveRunner (SIGINT/SIGTERM)...');
    clearInterval(tickTimer);
    reconciler.stop();
    feed.stop();
    await telegramQueue.flush();
    console.log(`Tổng kết phiên: regimeChangeCount=${regimeChangeCount}, willOpenCount(dryRun)=${willOpenCount}, tickErrorCount=${tickErrorCount}`);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error('liveRunner: lỗi khởi động không thể phục hồi:', err);
  process.exit(1);
});
