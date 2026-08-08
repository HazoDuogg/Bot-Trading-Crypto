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
 *   - TICKET-099 Phần A FIXED the old "rounded to a fixed decimal count" gap: BinanceOrderExecutor now
 *     loads real LOT_SIZE/PRICE_FILTER/MIN_NOTIONAL per symbol via loadExchangeInfo() at startup and
 *     rounds every real order's quantity/price to the correct stepSize/tickSize before sending — the
 *     roundQty()/roundPrice() helpers below are only a rough PRE-rounding for internal sizing math
 *     (e.g. tpQty = roundQty(quantity * tp.closePercent)); the executor's own rounding is authoritative.
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
import { BinanceOrderExecutor, initializeLeverageForSymbols, type PositionSide } from '../dist/live/binanceOrderExecutor.js';
import { StateReconciler, resolveAccountBalanceAfterReconcile, type InternalStateSnapshot } from '../dist/live/stateReconciler.js';
import {
  resolveCanonicalOpenQty,
  computeQuantityTolerance,
  cancelAlgoOrderIdempotent,
  reconcileExternalPositionClose,
  ReconcileGuard,
} from '../dist/live/liveStateSync.js';
import { loadBinanceEnvConfig } from '../dist/live/envConfig.js';
import {
  processCandle,
  type ProcessCandleInput,
  type MomentumGateEvaluation,
  type MomentumContextDecisionDiagnostic,
  type SameSidePositionBlockedDiagnostic,
} from '../dist/orchestrator/orchestrator.js';
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
import { SentEventTracker } from '../dist/telegram/dedupe.js';
import {
  formatBotStartMessage,
  formatFullCloseMessage,
  formatPartialCloseMessage,
  formatPositionOpenedMessage,
  formatRegimeChangeMessage,
  formatHtfContextChangeMessage,
  formatSafetyState5mChangeMessage,
  formatSafetyState5mStabilizedChangeMessage,
  formatMomentumContextDecisionMessage,
} from '../dist/telegram/messageFormatters.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const TICK_INTERVAL_MS = 5_000; // how often we check "has a new 5m candle closed" — cheap, reads already-polled in-memory buffers only

// TICKET-124 — feature flag for TICKET-123's chosen production improvement (Variant B: V1 model +
// OOD Risk Reduction guard on the SHORT MOMENTUM_DIRECT model, P97.5 emaRatioSlow threshold). Default
// OFF (env var unset or anything other than 'true') so this file's behavior is byte-identical to every
// ticket before this one unless explicitly opted in. PM-confirmed values below are copied verbatim
// from `data/ticket123-final-decision-report.md` §6 (Variant B) — do NOT retune here without a fresh
// backtest re-verification, same rule as the rest of CONFIG.
const OOD_GUARD_ENABLED = process.env.OOD_GUARD_ENABLED === 'true';
// TICKET-139 — opt-in, default-inert HTFContext/SafetyState5m split diagnostic. Default OFF (env
// var unset or anything other than 'true'). Diagnostic Telegram messages only — never gates or
// sizes any trade. See OrchestratorConfig.htfSafetySplitDiagnosticEnabled's doc comment.
const HTF_SAFETY_SPLIT_DIAGNOSTIC_ENABLED = process.env.HTF_SAFETY_SPLIT_DIAGNOSTIC_ENABLED === 'true';
// TICKET-140 — opt-in, default-inert SafetyState5m transition stabilization diagnostic. Default OFF
// (env var unset or anything other than 'true'). Diagnostic Telegram messages only — never gates or
// sizes any trade. See OrchestratorConfig.safetyState5mStabilizationEnabled's doc comment.
const SAFETY_STATE_5M_STABILIZATION_ENABLED = process.env.SAFETY_STATE_5M_STABILIZATION_ENABLED === 'true';
const OOD_GUARD_EMA_RATIO_SLOW_THRESHOLD = 1.037776; // Bearish TRAIN-split P97.5, TICKET-122/123
const OOD_GUARD_RISK_REDUCTION_MULTIPLIER = 0.3; // TICKET-122/123 Risk Reduction P97.5 variant

// Official confirmed live config — TICKET-084/085's 8-flag baseline + risk-dollar-or-percent=15/
// max-margin-cap=37.5 (real $100 capital scale, PM-confirmed risk$15/lệnh) + obSlBufferAtrMultiplier=0.87
// (TICKET-091) + momentumDirectMinSlPercent=1.27 (TICKET-093). Do NOT change any value here without a
// PM-confirmed backtest re-verification (see memory/project_official_backtest_config.md) — this file
// only WIRES the already-decided config into a live loop, it doesn't decide the config.
const CONFIG: OrchestratorConfig = {
  entryRouterConfig: { ...DEFAULT_ENTRY_ROUTER_CONFIG, obSlBufferAtrMultiplier: 0.87, macroTrendFilterEnabled: true },
  tpPlan: 'PLAN_A',
  takerFeeRate: 0.0004,
  riskDollarOrPercent: 15,
  maxMarginCap: 37.5,
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
  momentumDirectMinSlPercent: 1.27,
  momentumDirectTpRMultiple: 3.0,
  momentumDirectMaxTotalConcurrent: 999,
  momentumDirectCorrelationRiskThreshold: 999,
  momentumDirectCorrelationRiskMultiplier: 1.0,
  momentumDirectCircuitBreakerLossThreshold: 999999,
  momentumDirectCircuitBreakerCooldownMs: 0,
  // TICKET-124: undefined (guard fully inert) unless OOD_GUARD_ENABLED=true is set in the environment.
  ...(OOD_GUARD_ENABLED
    ? {
        oodGuardConfig: {
          mode: 'RISK_REDUCTION' as const,
          emaRatioSlowThreshold: OOD_GUARD_EMA_RATIO_SLOW_THRESHOLD,
          scoreCapValue: 0, // unused in RISK_REDUCTION mode
          riskReductionMultiplier: OOD_GUARD_RISK_REDUCTION_MULTIPLIER,
        },
      }
    : {}),
  htfSafetySplitDiagnosticEnabled: HTF_SAFETY_SPLIT_DIAGNOSTIC_ENABLED,
  safetyState5mStabilizationEnabled: SAFETY_STATE_5M_STABILIZATION_ENABLED,
  // TICKET-143A/144: explicitly activated live per user confirmation 2026-08-06. Real-money-affecting
  // switch — BTCUSDT/ETHUSDT+macroConflict now BLOCK, SOLUSDT/XRPUSDT+macroConflict now ALLOW_REDUCED_RISK@0.30.
  momentumContextDecisionMatrixV2Enabled: true,
};

const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;
// TICKET-106 (TODO_CONFIRM): was 250 — TICKET-104 proved emaSeries()'s SMA-seeded EMA(200) is still
// ~61% seed-weighted at 250 candles, making emaRatioSlow/momentumScore sensitive to exactly which
// candles land in the window (this is what caused the live-vs-offline momentumScore mismatch).
// Empirically converges by ~400; bumped to 500 for margin. MUST stay identical to backtest.ts's
// WINDOW_1H_MOMENTUM — a mismatch here is exactly the root cause TICKET-104 found.
// LiveCandleFeed's own 1h buffer is configured to this size below; we slice the last 40 of it for candles1h.
const WINDOW_1H_MOMENTUM = 500;

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
  // TICKET-099 Phần A: MUST load before any real order — every mutating BinanceOrderExecutor method
  // now throws if a symbol's filters aren't cached yet, rather than falling back to a guessed rounding.
  await executor.loadExchangeInfo(SYMBOLS);
  console.log('exchangeInfo (LOT_SIZE/PRICE_FILTER/MIN_NOTIONAL) đã tải cho 4 coin.');

  // TICKET-151 P0-B — stateReconciler.ts's own DEFAULT_QUANTITY_TOLERANCE (1e-8) is far tighter
  // than any real lot-size rounding gap. compareStates() only takes a single scalar tolerance
  // (kept unchanged/untouched — see stateReconciler.ts's own doc comments, still pure/log-only by
  // design), so this uses the COARSEST stepSize across all 4 traded symbols as a conservative
  // global bound — real per-symbol precision is applied where it matters (the active
  // reconcile/sync decision below, via liveStateSync.ts's checkQuantityMismatch()/
  // computeQuantityTolerance()), this value only controls whether stateReconciler.ts's periodic
  // LOG-ONLY sweep flags POSITION_SIZE_MISMATCH at all.
  const reconcilerQuantityTolerance = computeQuantityTolerance(Math.max(...SYMBOLS.map((s) => executor.getSymbolFilters(s).stepSize)));

  // TICKET-100: CHỦ ĐỘNG đặt đúng CONFIG.leverage cho cả 4 symbol — không tin tưởng cấu hình có sẵn
  // trên sàn (có thể lệch, gây sai risk$ thật ở mọi phép tính size sau này). "Đang có vị thế mở" ->
  // cảnh báo + tiếp tục (không crash); lỗi khác -> dừng khởi động (initializeLeverageForSymbols ném lại).
  await initializeLeverageForSymbols(executor, SYMBOLS, CONFIG.leverage);

  const accountInfo = (await executor.getAccountInfo()) as { totalWalletBalance?: string };
  let accountBalance = Number(accountInfo.totalWalletBalance);
  if (!Number.isFinite(accountBalance) || accountBalance <= 0) {
    throw new Error(`liveRunner: không đọc được totalWalletBalance hợp lệ từ getAccountInfo(): ${JSON.stringify(accountInfo)}`);
  }
  console.log(`Vốn hiện tại (từ sàn): $${accountBalance.toFixed(2)}`);

  const telegramConfig = loadTelegramConfig();
  const telegramQueue = new TelegramMessageQueue(telegramConfig);

  // TICKET-152 — dedupes the "SAME_SIDE_POSITION_BLOCKED" Telegram alert (log line is NOT deduped,
  // fires every tick the block condition re-fires — only Telegram is throttled). Keyed per
  // `${symbol}:${side}` ("blocking episode"): one small SentEventTracker per key, evicted (deleted
  // from this Map, not just tracker.reset() — reset() would clear ALL keys globally, which would
  // wrongly un-dedupe every OTHER symbol/side too) once the blocking position itself closes, so a
  // FUTURE distinct same-side block on that symbol (a new position opens same side, gets blocked
  // again later) still gets its own fresh Telegram alert instead of being silently suppressed
  // forever by a stale key from a long-closed position.
  const sameSideBlockTrackers = new Map<string, SentEventTracker>();

  const feed = new LiveCandleFeed({
    symbols: SYMBOLS,
    baseUrl: envConfig.baseUrl,
    windowSizes: { '1h': WINDOW_1H_MOMENTUM }, // covers both candles1h (last 40) and candles1hMomentum (full 500) from the SAME buffer
    onError: (err, symbol, interval) => console.error(`[FEED_ERROR] ${symbol} ${interval}: ${err.message}`),
    onGapFilled: (symbol, interval, gaps) => console.log(`[FEED] ${symbol} ${interval}: đã vá ${gaps.length} khoảng trống`),
    onThrottled: (symbol, interval) => console.warn(`[FEED_THROTTLE] ${symbol} ${interval}: bỏ qua poll (gần chạm ngưỡng weight)`),
  });
  console.log('Đang tải lịch sử nến ban đầu cho 4 coin...');
  await feed.start();
  console.log('LiveCandleFeed đã sẵn sàng.');

  console.log(
    `TICKET-124 oodGuardEnabled=${OOD_GUARD_ENABLED}${OOD_GUARD_ENABLED ? ` (RISK_REDUCTION, emaRatioSlowThreshold=${OOD_GUARD_EMA_RATIO_SLOW_THRESHOLD}, riskReductionMultiplier=${OOD_GUARD_RISK_REDUCTION_MULTIPLIER})` : ' (shadow monitoring only — set OOD_GUARD_ENABLED=true to actually apply)'}`,
  );
  telegramQueue.enqueue(
    formatBotStartMessage({
      env: envLabel,
      symbols: SYMBOLS,
      balance: accountBalance,
      momentumDirectEnabled: CONFIG.momentumDirectEnabled,
      riskPoolMaxPct: CONFIG.riskPoolMaxPct,
      maxConcurrentPositionsPerSymbol: CONFIG.maxConcurrentPositionsPerSymbol,
      timestamp: Date.now(),
    }) +
      `\n[OOD Guard (TICKET-124): ${OOD_GUARD_ENABLED ? 'BẬT — RISK_REDUCTION P97.5' : 'TẮT — chỉ theo dõi shadow'}]` +
      (dryRun ? '\n\n[DRY-RUN MODE — chưa đặt lệnh thật]' : ''),
  );

  const runnerState: Record<string, RunnerSymbolState> = {};
  for (const symbol of SYMBOLS) {
    runnerState[symbol] = { symbolState: INITIAL_SYMBOL_STATE, lastProcessedCandleTimestamp: null, orderIds: new Map() };
  }

  // TICKET-151 §11 — per-symbol in-flight reconcile marker. Checked before starting a new
  // external-close reconcile for a symbol (no double-close/double-release) AND at the top of this
  // symbol's per-tick processing (frozen — no new candle processed, no new entry opened, no close
  // handled — while its reconcile is in flight, per the ticket's 11-step workflow's step 1).
  const reconcileGuard = new ReconcileGuard();

  let regimeChangeCount = 0;
  let willOpenCount = 0;
  let tickErrorCount = 0;
  // TICKET-124 — shadow/live-sim monitoring for the OOD guard, collected regardless of
  // OOD_GUARD_ENABLED (so its effect is visible during dry-run BEFORE flipping the flag). Pure
  // counters, never fed back into any decision.
  let oodGuardShortEvalCount = 0;
  let oodGuardFlaggedCount = 0;
  let oodGuardFlaggedPassedCount = 0;

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

  /**
   * TICKET-151 P0-A — returns the CANONICAL executed base-asset quantity when a real order was
   * placed (null in dryRun, where there's nothing to confirm). This used to be silently discarded
   * — `quantity` (the pre-normalization calculated value) was used for SL/TP sizing AND is what
   * ended up in the internal simulated position's size, while the exchange had actually filled the
   * real stepSize-rounded amount. The caller (tick()) uses the returned qty to correct the just-
   * opened ManagedPositionState's positionSize/remainingPositionSize to match reality.
   */
  async function handleOpenEvent(symbol: string, event: OpenTradeEvent, balanceAtOpen: number): Promise<number | null> {
    const quantity = roundQty(event.marginRequired * CONFIG.leverage / event.entryPrice);
    let canonicalQty: number | null = null;
    if (dryRun) {
      console.log(`[SẼ MỞ LỆNH] ${symbol} ${event.side} entry=${event.entryPrice} sl=${event.slPrice} qty=${quantity} setupType=${event.setupType}`);
      willOpenCount++;
    } else {
      const openResult = await executor.openMarketPosition(symbol, event.side, quantity);
      if (!('orderId' in openResult)) throw new Error(`liveRunner: openMarketPosition trả về DryRunResult dù dryRun=false — không nên xảy ra`);

      // TICKET-151 P0-A priority order: executedQty from the fill response first; only fall back
      // to a fresh getPositionRisk() read when executedQty is missing/unusable — never fall back
      // silently to the pre-normalization `quantity` (that IS the incident this fixes).
      let positionRiskAmt: number | null = null;
      const rawExecutedQty = Number((openResult.raw as { executedQty?: string | number } | undefined)?.executedQty);
      if (!Number.isFinite(rawExecutedQty) || rawExecutedQty <= 0) {
        try {
          const posRisk = (await executor.getPositionRisk(symbol)) as Array<{ symbol?: string; positionAmt?: string }>;
          const found = Array.isArray(posRisk) ? posRisk.find((p) => p.symbol === symbol) : undefined;
          positionRiskAmt = found ? Number(found.positionAmt) : null;
        } catch (e) {
          console.error(`[CANONICAL_QTY_FALLBACK_ERROR] ${symbol}: getPositionRisk() fallback lỗi, sẽ dùng submittedQty (đã round stepSize) làm phương án cuối: ${(e as Error).message}`);
        }
      }
      // TICKET-151B — Binance one-way mode merges same-symbol/same-side positions into ONE
      // positionAmt, so with maxConcurrentPositionsPerSymbol>=2 a positionRiskAmt fallback for the
      // 2nd+ position on this side must subtract the OTHER already-open same-side positions' known
      // qty to recover just THIS order's incremental fill — runnerState[symbol].symbolState here is
      // still the pre-this-candle state (reassigned to result.symbolState only after this events loop
      // finishes), so it correctly reflects "already open BEFORE this new position".
      const existingSameSideQtyBaseAsset = runnerState[symbol].symbolState.openPositions
        .filter((e) => e.position.side === event.side)
        .reduce((sum, e) => sum + e.position.remainingPositionSize / e.position.entryPrice, 0);
      const canonical = resolveCanonicalOpenQty({ submittedQty: quantity, orderRaw: openResult.raw, positionRiskAmt, existingSameSideQtyBaseAsset });
      canonicalQty = canonical.qty;
      console.log(`[CANONICAL_QTY] ${symbol} source=${canonical.source} submittedQty=${quantity} canonicalQty=${canonical.qty}`);
      if (canonical.source === 'SUBMITTED_QTY_FALLBACK') {
        console.warn(`[CANONICAL_QTY_WARNING] ${symbol}: không xác nhận được executedQty/positionAmt thật từ sàn — dùng submittedQty làm phương án cuối, CẦN kiểm tra thủ công.`);
      }

      const orderIds = await placeInitialOrders(symbol, event.side, event, canonicalQty);
      runnerState[symbol].orderIds.set(event.entryTimestamp, orderIds);
    }
    // TICKET-124 — real-trade-level guard visibility: with momentumDirectCorrelationRiskThreshold=999
    // (never triggers, see CONFIG above), riskMultiplier<1 on a SHORT MOMENTUM_DIRECT open can only
    // come from the OOD guard when OOD_GUARD_ENABLED — flag here so the Telegram record shows exactly
    // which real trades had their size reduced by it, not just the shadow-eval counters.
    const oodGuardApplied = OOD_GUARD_ENABLED && event.setupType === 'MOMENTUM_DIRECT' && event.side === 'SHORT' && event.riskMultiplier < 1;
    if (oodGuardApplied) console.log(`[OOD_GUARD] ${symbol} SHORT MOMENTUM_DIRECT mở lệnh với size đã giảm (riskMultiplier=${event.riskMultiplier.toFixed(3)})`);
    telegramQueue.enqueue(
      formatPositionOpenedMessage(event, { env: envLabel, accountBalanceAtOpen: balanceAtOpen }) +
        (dryRun ? '\n\n[DRY-RUN]' : '') +
        (oodGuardApplied ? '\n[OOD Guard: size đã giảm theo Risk Reduction P97.5]' : ''),
    );
    return canonicalQty;
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
        // TICKET-151 P0-E — a -2011 ("Unknown order sent") when cancelling the OTHER (non-triggering)
        // SL/TP algo order here is expected (Binance does NOT auto-cancel the sibling order once one
        // side fills). Only treat it as terminal/safe-to-ignore AFTER a FRESH getPositionRisk() query
        // confirms the position is actually flat right now — never inferred from the close event
        // itself, per the ticket's explicit "chỉ xử lý như terminal khi position state đã được xác
        // nhận an toàn" rule. A getPositionRisk() failure here keeps isConfirmedClosed=false (safer
        // default — an unconfirmed -2011 stays a loud error rather than being silently swallowed).
        let isConfirmedClosed = false;
        try {
          const posRisk = (await executor.getPositionRisk(symbol)) as Array<{ symbol?: string; positionAmt?: string }>;
          const amt = Array.isArray(posRisk) ? Number(posRisk.find((p) => p.symbol === symbol)?.positionAmt ?? '0') : NaN;
          isConfirmedClosed = Number.isFinite(amt) && Math.abs(amt) < 1e-9;
        } catch (e) {
          console.error(`[CLOSE_CONFIRM_ERROR] ${symbol}: không xác nhận được vị thế qua getPositionRisk() trước khi hủy SL/TP còn treo — coi mọi -2011 sau đây là lỗi thật (an toàn hơn): ${(e as Error).message}`);
        }

        if (ids.slAlgoId != null) {
          const outcome = await cancelAlgoOrderIdempotent(executor, symbol, ids.slAlgoId, `handleCloseEvent(${symbol}) SL`, isConfirmedClosed);
          if (outcome.status === 'ALREADY_TERMINAL') console.log(outcome.logLine);
          else if (outcome.status === 'ERROR') console.error(`[CLEANUP] hủy SL lỗi: ${outcome.error.message}`);
        }
        for (const tpId of ids.tpAlgoIds) {
          const outcome = await cancelAlgoOrderIdempotent(executor, symbol, tpId, `handleCloseEvent(${symbol}) TP`, isConfirmedClosed);
          if (outcome.status === 'ALREADY_TERMINAL') console.log(outcome.logLine);
          else if (outcome.status === 'ERROR') console.error(`[CLEANUP] hủy TP lỗi: ${outcome.error.message}`);
        }
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
      // TICKET-101 Việc 1 — BUG FIX: was a single snapshot computed ONCE before this loop, so if
      // symbol A opened a NEW position earlier in THIS SAME tick, symbol B's risk-pool check later
      // in the same tick still saw the pre-tick total — under-counting real concentrated risk within
      // a single tick. Now a mutable map, refreshed immediately after each symbol's own
      // processCandle() call (below) so the NEXT symbol in this tick's loop sees the up-to-date total.
      const openRiskBySymbol: Record<string, number> = {};
      // TICKET-101 Việc 2 — same live-updated-within-tick pattern as openRiskBySymbol above, but
      // tracks real margin$ (marginRequired) instead of risk$ — a SEPARATE, independent cap
      // (config.maxTotalMarginPct), bounding total capital committed across all 4 coins, not the
      // loss-if-SL-hits figure the Risk Pool bounds.
      const openMarginBySymbol: Record<string, number> = {};
      for (const s of SYMBOLS) {
        const total = runnerState[s].symbolState.openPositions.reduce((sum, e) => sum + e.meta.actualRiskDollar, 0);
        if (total > 0) openRiskBySymbol[s] = total;
        const totalMargin = runnerState[s].symbolState.openPositions.reduce((sum, e) => sum + e.meta.marginRequired, 0);
        if (totalMargin > 0) openMarginBySymbol[s] = totalMargin;
      }

      for (const symbol of SYMBOLS) {
        const rs = runnerState[symbol];
        // TICKET-151 §5 P0-C step 1 / §11 — freeze ALL mutation for this symbol while its external-
        // close reconcile is in flight: no new candle processed, no new entry opened, no close/partial
        // handled. The reconcile itself is a bounded handful of read-only calls (+ idempotent cancels
        // of already-stale SL/TP orders), so losing one 5s tick for this symbol is a safe trade-off
        // against acting on a symbol whose internal/exchange state is actively being resolved.
        if (reconcileGuard.isReconciling(symbol)) {
          console.warn(`[RECONCILE_FREEZE] ${symbol}: đang đối soát vị thế đóng ngoài — bỏ qua tick này cho symbol này.`);
          continue;
        }
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

        // TICKET-101 Việc 1: built fresh from the live-updated openRiskBySymbol map, right before
        // THIS symbol's own processCandle() call — includes any new position(s) opened by an earlier
        // symbol in this same tick.
        const allOpenPositionsRisk = SYMBOLS.filter((s) => openRiskBySymbol[s] !== undefined).map((s) => ({ id: s, actualRiskDollar: openRiskBySymbol[s] }));
        // TICKET-101 Việc 2: single aggregate across ALL 4 symbols (not a per-symbol breakdown) —
        // wouldExceedMaxTotalMargin() only ever needs the total.
        const totalOpenMarginDollar = Object.values(openMarginBySymbol).reduce((sum, m) => sum + m, 0);

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
          totalOpenMarginDollar,
          momentumDirectOpenPositionsTotal,
          momentumDirectOpenPositions,
        };

        const previousRegime = rs.symbolState.regimeState.previousRegime;
        let lastComputedMetrics: { adx1h?: number; atrPercentile5m?: number } = {};
        const result = await processCandle(
          input,
          rs.symbolState,
          CONFIG,
          undefined,
          undefined,
          undefined,
          undefined,
          (m) => {
            lastComputedMetrics = m;
          },
          // TICKET-124 — shadow/live-sim monitoring only, see oodGuard* counters above.
          (evaluation: MomentumGateEvaluation) => {
            if (evaluation.gateType !== 'MOMENTUM_DIRECT' || evaluation.side !== 'SHORT') return;
            oodGuardShortEvalCount++;
            if (evaluation.oodFlagged) {
              oodGuardFlaggedCount++;
              if (evaluation.passed) oodGuardFlaggedPassedCount++;
              console.log(
                `[OOD_GUARD${OOD_GUARD_ENABLED ? '' : ' shadow'}] ${evaluation.symbol} SHORT MOMENTUM_DIRECT flagged (score=${evaluation.score.toFixed(4)}, passed=${evaluation.passed})`,
              );
            }
          },
          // TICKET-139 — no-op unless HTF_SAFETY_SPLIT_DIAGNOSTIC_ENABLED (processCandle() itself
          // never fires these callbacks when config.htfSafetySplitDiagnosticEnabled is off).
          (change) => {
            console.log(`[TICKET-139 HTF] ${symbol}: ${change.from} → ${change.to}`);
            telegramQueue.enqueue(formatHtfContextChangeMessage({ symbol, fromContext: change.from, toContext: change.to, timestamp: change.timestamp }));
          },
          (change) => {
            console.log(`[TICKET-139 SAFETY5M] ${symbol}: ${change.from} → ${change.to}`);
            telegramQueue.enqueue(formatSafetyState5mChangeMessage({ symbol, fromState: change.from, toState: change.to, timestamp: change.timestamp }));
          },
          // TICKET-140 — no-op unless SAFETY_STATE_5M_STABILIZATION_ENABLED (processCandle() itself
          // never fires this callback when config.safetyState5mStabilizationEnabled is off).
          (change) => {
            console.log(`[TICKET-140 SAFETY5M STABILIZED] ${symbol}: ${change.from} → ${change.to}`);
            telegramQueue.enqueue(formatSafetyState5mStabilizedChangeMessage({ symbol, fromState: change.from, toState: change.to, timestamp: change.timestamp }));
          },
          // onSafetyState5mFinalStabilized/onLocalTradeThesis5m/onSetupSpecificThesis/
          // onMomentumCandidateIntegrity — none wired in live (T140B/T141/T142/T142A never needed a
          // live Telegram message), left undefined same as before this ticket.
          undefined,
          undefined,
          undefined,
          undefined,
          // TICKET-144 — Decision Matrix V2 audit notification. processCandle() itself already only
          // fires this callback when momentumContextDecisionMatrixEnabled or its V2 sibling is true;
          // this extra CONFIG.momentumContextDecisionMatrixV2Enabled guard restricts it further to
          // the V2 flag specifically (never fires for a hypothetical future V1-only live config), and
          // only sends Telegram for an actual entry or a macro-conflict candidate that got BLOCKed —
          // not every BLOCK (most BLOCKs are just "no macro conflict", not audit-worthy).
          (diagnostic: MomentumContextDecisionDiagnostic) => {
            if (!CONFIG.momentumContextDecisionMatrixV2Enabled) return;
            if (!diagnostic.entryAllowed && !diagnostic.macroConflict) return;
            telegramQueue.enqueue(
              formatMomentumContextDecisionMessage({
                symbol: diagnostic.symbol,
                timestamp: diagnostic.timestamp,
                side: diagnostic.side,
                macroDirection: diagnostic.macroDirection,
                macroConflict: diagnostic.macroConflict,
                safetyState5m: diagnostic.safetyState5m,
                decision: diagnostic.decision,
                riskMultiplier: diagnostic.riskMultiplier,
                candidateId: diagnostic.candidateId,
                entryAllowed: diagnostic.entryAllowed,
                blockReason: diagnostic.decisionReason,
              }),
            );
          },
          // TICKET-152 — same-side duplicate-position guard notification. Log line fires every time
          // (unconditional, exact format per ticket §5); Telegram is deduped per symbol+side via
          // sameSideBlockTrackers (see its own doc comment above) so a persistent signal re-forming
          // every candle while blocked doesn't spam Telegram every tick.
          (diagnostic: SameSidePositionBlockedDiagnostic) => {
            console.log(
              `[SAME_SIDE_POSITION_BLOCKED] symbol=${diagnostic.symbol} side=${diagnostic.side} reason=EXISTING_${diagnostic.side}_OPEN openSameSideCount=${diagnostic.openSameSideCount}`,
            );
            const key = `${diagnostic.symbol}:${diagnostic.side}`;
            let tracker = sameSideBlockTrackers.get(key);
            if (!tracker) {
              tracker = new SentEventTracker();
              sameSideBlockTrackers.set(key, tracker);
            }
            if (tracker.markSent(key)) {
              telegramQueue.enqueue(
                `⛔ BỎ QUA LỆNH ${diagnostic.symbol} ${diagnostic.side}\nLý do: Đã có ${diagnostic.side} đang mở trên ${diagnostic.symbol}`,
              );
            }
          },
        );

        // TICKET-101 Việc 1: refresh immediately so the NEXT symbol in this tick's loop sees this
        // symbol's up-to-date total (see openRiskBySymbol declaration above).
        const newTotalRisk = result.symbolState.openPositions.reduce((sum, e) => sum + e.meta.actualRiskDollar, 0);
        if (newTotalRisk > 0) openRiskBySymbol[symbol] = newTotalRisk;
        else delete openRiskBySymbol[symbol];
        // TICKET-101 Việc 2: same live refresh for margin (see openMarginBySymbol declaration above).
        const newTotalMargin = result.symbolState.openPositions.reduce((sum, e) => sum + e.meta.marginRequired, 0);
        if (newTotalMargin > 0) openMarginBySymbol[symbol] = newTotalMargin;
        else delete openMarginBySymbol[symbol];

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
            const canonicalQty = await handleOpenEvent(symbol, event, accountBalance).catch((e) => {
              console.error(`[OPEN_HANDLER_ERROR] ${symbol}: ${(e as Error).message}`);
              return null;
            });
            // TICKET-151 P0-A — inject the exchange-confirmed real quantity into the JUST-created
            // ManagedPositionState for this open (matched by entryTimestamp, unique per position
            // within a symbol — same key convention as runnerState[symbol].orderIds). This is a
            // targeted data correction, NOT a change to slTpManager.ts's sizing FORMULA: only this
            // one freshly-opened position's positionSize/remainingPositionSize (currently equal,
            // always true right at open before any tier has filled) are overwritten to
            // canonicalQty × entryPrice, exactly analogous to how resolveAccountBalanceAfterReconcile()
            // already overrides accountBalance from a confirmed exchange value elsewhere in this file.
            if (canonicalQty !== null) {
              const openedEntry = result.symbolState.openPositions.find((e) => e.meta.entryTimestamp === event.entryTimestamp);
              if (openedEntry) {
                const correctedNotional = canonicalQty * openedEntry.position.entryPrice;
                if (Math.abs(correctedNotional - openedEntry.position.positionSize) > 1e-9) {
                  console.log(
                    `[POSITION_SIZE_CORRECTED] ${symbol} entryTimestamp=${event.entryTimestamp}: positionSize ${openedEntry.position.positionSize.toFixed(6)} → ${correctedNotional.toFixed(6)} (canonicalQty=${canonicalQty})`,
                  );
                }
                openedEntry.position.positionSize = correctedNotional;
                openedEntry.position.remainingPositionSize = correctedNotional;
              } else {
                console.error(`[POSITION_SIZE_CORRECTION_ERROR] ${symbol}: không tìm thấy openPositions entry vừa mở (entryTimestamp=${event.entryTimestamp}) để áp canonicalQty — CẦN kiểm tra thủ công.`);
              }
            }
          } else if (event.type === 'PARTIAL_CLOSE') {
            // Find the still-open position this partial fill belongs to (same symbol+side, only one such position expected per TICKET-056's 2-slot design when a partial just fired on it).
            const owner = result.symbolState.openPositions.find((e) => e.position.side === event.side);
            const remainingQuantity = owner ? owner.position.remainingPositionSize / owner.position.entryPrice : 0;
            await handlePartialCloseEvent(symbol, event, owner?.meta.entryTimestamp ?? -1, remainingQuantity).catch((e) => console.error(`[PARTIAL_HANDLER_ERROR] ${symbol}: ${(e as Error).message}`));
          } else if (event.type === 'CLOSE') {
            await handleCloseEvent(symbol, event).catch((e) => console.error(`[CLOSE_HANDLER_ERROR] ${symbol}: ${(e as Error).message}`));
            // TICKET-152 — this position closing may have just ended a "blocking episode": if no
            // position on this side remains open for this symbol, evict the dedupe key so a FUTURE
            // same-side block on this symbol (a new position opens this side, gets blocked again
            // later) gets its own fresh Telegram alert instead of staying silently suppressed.
            const stillOpenSameSide = result.symbolState.openPositions.some((e) => e.position.side === event.side);
            if (!stillOpenSameSide) sameSideBlockTrackers.delete(`${symbol}:${event.side}`);
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

  // TICKET-077 Phần D — safety-net reconciliation. stateReconciler.ts ITSELF stays pure/log-only (its
  // own design principle, unchanged — it never writes anything, only reports). TICKET-102: the CALLER
  // here now acts on BALANCE_MISMATCH specifically — every other mismatch type (position missing/side/
  // size) stays log-only exactly as before, since those can come from several different real causes
  // (manual trade, bot bug, SL/TP filled but not yet observed) that must NOT be silently auto-resolved.
  // Balance is different: there is only ever ONE correct number (the exchange's), so once a mismatch is
  // confirmed, overwriting accountBalance from the stale internal value is unambiguously correct —
  // every size/risk$/Telegram calculation downstream must use the real number, not a drifted one.
  /**
   * TICKET-151 §5 P0-C — active workflow for POSITION_MISSING_ON_EXCHANGE. Read-only against the
   * exchange except for idempotent cleanup of already-stale SL/TP algo orders (P0-E) — never
   * re-opens, reverses, or hedges anything. Guarded by `reconcileGuard` (§11): only one in-flight
   * reconcile per symbol, and the symbol's own tick() processing is frozen (see the loop above)
   * for the duration, so this can never race a new entry or a second reconcile on the same symbol.
   *
   * KNOWN LIMITATION (honest, not hidden): only handles the common case of EXACTLY ONE internal
   * open position for the symbol. With `maxConcurrentPositionsPerSymbol=2` (CONFIG above), if two
   * positions are open on the same symbol when the exchange shows zero, this function conservatively
   * refuses to auto-resolve (which of the two internal entries closed cannot be disambiguated from
   * stateReconciler.ts's per-symbol-only comparison) and only logs a loud warning for manual review.
   */
  async function handlePositionMissingOnExchange(symbol: string, exchangeBalanceUsd: number): Promise<void> {
    const rs = runnerState[symbol];
    if (rs.symbolState.openPositions.length !== 1) {
      console.warn(
        `[RECONCILE_SKIP_MULTI_POSITION] ${symbol}: có ${rs.symbolState.openPositions.length} vị thế nội bộ (không phải đúng 1) trong khi sàn báo không còn vị thế nào — P0-C hiện chỉ tự động xử lý đúng 1 vị thế/symbol, KHÔNG tự sửa trường hợp này. CẦN KIỂM TRA THỦ CÔNG NGAY.`,
      );
      return;
    }
    if (!reconcileGuard.tryStart(symbol)) return; // already reconciling this symbol this cycle
    try {
      const entry = rs.symbolState.openPositions[0];
      const orderIds = rs.orderIds.get(entry.meta.entryTimestamp);

      const workflowResult = await reconcileExternalPositionClose(executor, {
        symbol,
        side: entry.position.side,
        entryPrice: entry.position.entryPrice,
        slPrice: entry.position.currentSlPrice,
        tpLevels: entry.position.tpLevels,
        internalQtyBeforeBaseAsset: entry.position.remainingPositionSize / entry.position.entryPrice,
        actualRiskDollar: entry.meta.actualRiskDollar,
        marginRequired: entry.meta.marginRequired,
        incomeWindowStartMs: entry.meta.entryTimestamp,
        incomeWindowEndMs: Date.now(),
      });

      if (!workflowResult.confirmedClosed) {
        console.warn(`[RECONCILE_FALSE_ALARM] ${symbol}: fresh getPositionRisk() vẫn thấy vị thế còn mở — có thể là dữ liệu đối soát cũ/race, KHÔNG đóng nội bộ.`);
        return;
      }
      console.warn(workflowResult.logLine);

      // P0-E: SL/TP algo orders are NOT auto-cancelled by Binance when the position closes —
      // clean up whichever ones the bot still thinks are resting, idempotently.
      if (orderIds) {
        if (orderIds.slAlgoId != null) {
          const outcome = await cancelAlgoOrderIdempotent(executor, symbol, orderIds.slAlgoId, `reconcile(${symbol}) SL`, true);
          if (outcome.status === 'ALREADY_TERMINAL') console.log(outcome.logLine);
          else if (outcome.status === 'ERROR') console.error(`[RECONCILE_CLEANUP_ERROR] ${symbol} SL algoId=${orderIds.slAlgoId}: ${outcome.error.message}`);
        }
        for (const tpId of orderIds.tpAlgoIds) {
          const outcome = await cancelAlgoOrderIdempotent(executor, symbol, tpId, `reconcile(${symbol}) TP`, true);
          if (outcome.status === 'ALREADY_TERMINAL') console.log(outcome.logLine);
          else if (outcome.status === 'ERROR') console.error(`[RECONCILE_CLEANUP_ERROR] ${symbol} TP algoId=${tpId}: ${outcome.error.message}`);
        }
        rs.orderIds.delete(entry.meta.entryTimestamp);
      }

      // P0-C/P0-F: removing the ghost position is the ENTIRE fix for risk-pool/margin/concurrency
      // exposure — openRiskBySymbol/openMarginBySymbol/momentumDirectOpenPositions* are all derived
      // fresh from symbolState.openPositions at the top of every tick() (see above), never cached
      // separately, so this alone zeroes them for this symbol starting next tick.
      rs.symbolState = { ...rs.symbolState, openPositions: rs.symbolState.openPositions.filter((e) => e !== entry) };

      // P0-G/P0-D: refresh balance from the SAME exchange read this reconcile cycle already made
      // (no extra network call). Never fabricates a locally-computed PnL — the simulation can no
      // longer emit a CLOSE event for a position no longer in openPositions, so there is no
      // double-apply risk between this override and a later simulated close.
      accountBalance = exchangeBalanceUsd;

      telegramQueue.enqueue(
        `[RECONCILE] ${symbol} ${entry.position.side}: vị thế đã bị đóng BÊN NGOÀI bot (sàn xác nhận không còn vị thế) — closeReason=${workflowResult.closeReason}, ` +
          `realizedPnlUsd=${workflowResult.realizedPnlUsd ?? 'không xác định'} (reconciled_external_close). Risk/margin/slot đã được giải phóng.` +
          (envLabel === 'testnet' ? '\n[TESTNET]' : ''),
      );
    } catch (err) {
      console.error(`[RECONCILE_ERROR] ${symbol}: ${(err as Error).message}`);
    } finally {
      reconcileGuard.finish(symbol);
    }
  }

  const reconciler = new StateReconciler({
    executor,
    quantityTolerance: reconcilerQuantityTolerance,
    getInternalState: (): InternalStateSnapshot => ({
      balanceUsd: accountBalance,
      positions: SYMBOLS.flatMap((s) =>
        runnerState[s].symbolState.openPositions.map((e: OpenPositionEntry) => ({ symbol: s, side: e.position.side, quantity: e.position.remainingPositionSize / e.position.entryPrice })),
      ),
    }),
    onMismatch: (result) => {
      console.warn(`[RECONCILE_MISMATCH] ${result.mismatches.length} lệch được phát hiện:`);
      for (const m of result.mismatches) console.warn(`  - ${m.type}: ${m.detail}`);

      // TICKET-102 — ưu tiên cao nhất: BALANCE_MISMATCH không chỉ log, ghi đè NGAY accountBalance
      // bằng đúng số Sàn (result.exchangeBalanceUsd) trước khi tick tiếp theo dùng số này để tính
      // size/risk$/gửi Telegram. resolveAccountBalanceAfterReconcile() là hàm thuần (testable riêng),
      // trả về currentBalance không đổi nếu không có BALANCE_MISMATCH.
      const oldBalance = accountBalance;
      accountBalance = resolveAccountBalanceAfterReconcile(accountBalance, result);
      if (accountBalance !== oldBalance) {
        console.warn(`[RECONCILE_BALANCE_OVERRIDE] accountBalance ghi đè theo đúng số Sàn: $${oldBalance.toFixed(2)} → $${accountBalance.toFixed(2)}`);
      }

      console.log(`[SUMMARY] regimeChangeCount=${regimeChangeCount}, willOpenCount(dryRun)=${willOpenCount}, tickErrorCount=${tickErrorCount}, oodGuardEnabled=${OOD_GUARD_ENABLED}, oodGuardShortEvalCount=${oodGuardShortEvalCount}, oodGuardFlaggedCount=${oodGuardFlaggedCount}, oodGuardFlaggedPassedCount=${oodGuardFlaggedPassedCount}`);

      // TICKET-151 P0-C — active reconcile ONLY for POSITION_MISSING_ON_EXCHANGE, decided directly
      // from this cycle's exchangePositions/internal openPositions (not by parsing `mismatch.detail`
      // strings). Every OTHER mismatch type (side mismatch, missing internally, size mismatch outside
      // this immediate open-time correction path) stays exactly log-only, unchanged — same TICKET-102
      // rationale as the balance override above: those can come from several different real causes
      // that must not be silently auto-resolved. Fire-and-forget (async) — never blocks the reconcile
      // timer's own tick loop; `reconcileGuard` + the per-symbol tick-freeze above prevent races.
      if (result.mismatches.some((m) => m.type === 'POSITION_MISSING_ON_EXCHANGE')) {
        for (const symbol of SYMBOLS) {
          const hasInternal = runnerState[symbol].symbolState.openPositions.length > 0;
          const hasExchange = result.exchangePositions.some((p) => p.symbol === symbol);
          if (hasInternal && !hasExchange && !reconcileGuard.isReconciling(symbol)) {
            void handlePositionMissingOnExchange(symbol, result.exchangeBalanceUsd);
          }
        }
      }
    },
    onClean: () => {
      console.log(`[RECONCILE] OK — nội bộ khớp với sàn.`);
      console.log(`[SUMMARY] regimeChangeCount=${regimeChangeCount}, willOpenCount(dryRun)=${willOpenCount}, tickErrorCount=${tickErrorCount}, oodGuardEnabled=${OOD_GUARD_ENABLED}, oodGuardShortEvalCount=${oodGuardShortEvalCount}, oodGuardFlaggedCount=${oodGuardFlaggedCount}, oodGuardFlaggedPassedCount=${oodGuardFlaggedPassedCount}`);
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
    console.log(`Tổng kết phiên: regimeChangeCount=${regimeChangeCount}, willOpenCount(dryRun)=${willOpenCount}, tickErrorCount=${tickErrorCount}, oodGuardEnabled=${OOD_GUARD_ENABLED}, oodGuardShortEvalCount=${oodGuardShortEvalCount}, oodGuardFlaggedCount=${oodGuardFlaggedCount}, oodGuardFlaggedPassedCount=${oodGuardFlaggedPassedCount}`);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error('liveRunner: lỗi khởi động không thể phục hồi:', err);
  process.exit(1);
});
