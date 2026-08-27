import { config as loadEnv } from 'dotenv';
loadEnv();

import path from 'node:path';
import { BinanceRestPollingFeed, msUntilNextPoll } from '../src/live/binanceRestPollingFeed.js';
import { BinanceOrderClient } from '../src/live/binanceOrderClient.js';
import { SymbolSignalEngine } from '../src/live/signalEngine.js';
import { SymbolOrderLifecycle, type LifecycleEvent } from '../src/live/orderLifecycle.js';
import { fromEngineStartup, fromPollError, fromLifecycleEvent, type LiveEventRecord } from '../src/live/eventRecord.js';
import { EventLogger } from '../src/live/eventLogger.js';
import { loadTelegramConfigFromEnv, sendTelegramMessage, formatEventMessage, type TelegramConfig } from '../src/live/telegram.js';

// TICKET-RT-068: real order-placement live loop (testnet only, per LIVE_EXCHANGE_BASE_URL /
// BinanceOrderClient's own testnet safety guard). For each symbol: SymbolSignalEngine does PURE
// detection, SymbolOrderLifecycle does REAL execution (place/track/cancel/close) — kept as two
// separate objects per the ticket's explicit "tach bach" instruction.
//
// STARTUP RECONCILIATION (a gap not explicitly detailed in the ticket, but load-bearing for
// restart-safety with REAL orders — flagged here rather than silently handled): a crash/restart
// resets this process's in-memory lifecycle state to IDLE for every symbol, but real orders/
// positions on the exchange from before the crash do NOT reset. Blindly starting IDLE risks
// placing a DUPLICATE/conflicting order for a symbol that already has one outstanding. Before
// entering the live loop, this script queries REAL open orders + REAL open position for every
// managed symbol; if either is non-empty, that symbol is marked BLOCKED (detection permanently
// skipped) for the rest of this process's lifetime, and a loud Telegram+log alert is sent — NOT
// auto-reconciled (deliberately: reconstructing a full state machine from partial exchange state
// is a genuinely hard problem deserving its own explicit design, out of this ticket's scope).
// Confirmed during RT-068's own testing: the shared testnet account already had a pre-existing
// open BTCUSDT position (not created by this code) — this mechanism correctly blocks BTCUSDT.

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
const CATCH_UP_LOOKBACK_CANDLES = 300;

interface SymbolRuntimeState {
  symbol: string;
  engine: SymbolSignalEngine;
  lifecycle: SymbolOrderLifecycle;
  lastH1OpenTime: number | null;
  lastM15OpenTime: number | null;
  blocked: boolean;
}

function logLine(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function emit(telegramConfig: TelegramConfig | null, logger: EventLogger, record: LiveEventRecord, notifyTelegram: boolean): Promise<void> {
  logLine(`${record.eventKind} ${record.symbol}${record.note ? ` — ${record.note}` : ''}`);
  await logger.append(record).catch((err) => console.error('  Ghi JSONL log that bai:', err));
  if (notifyTelegram && telegramConfig) {
    const results = await sendTelegramMessage(telegramConfig, formatEventMessage(record));
    for (const r of results) if (!r.ok) console.error(`  Gui Telegram toi chat ${r.chatId} that bai: ${r.error}`);
  }
}

async function main() {
  const baseUrl = process.env.LIVE_EXCHANGE_BASE_URL || process.env.BINANCE_TESTNET_URL;
  if (!baseUrl) {
    throw new Error('CORRECTION_REQUIRED: can bien moi truong LIVE_EXCHANGE_BASE_URL hoac BINANCE_TESTNET_URL trong .env — khong co gia tri mac dinh de tranh vo tinh tro toi live API.');
  }
  const apiKey = process.env.BINANCE_TESTNET_KEY_ENC;
  const apiSecret = process.env.BINANCE_TESTNET_SECRET_ENC;
  if (!apiKey || !apiSecret) {
    throw new Error('CORRECTION_REQUIRED: can BINANCE_TESTNET_KEY_ENC va BINANCE_TESTNET_SECRET_ENC trong .env de dat lenh (Part A/B).');
  }

  const telegramConfig = loadTelegramConfigFromEnv();
  if (!telegramConfig) {
    console.warn('CANH BAO: TELEGRAM_BOT_TOKEN_ENC / TELEGRAM_CHAT_ID chua duoc cau hinh trong .env — engine van chay nhung se KHONG gui duoc thong bao Telegram.');
  }
  const logger = new EventLogger(path.resolve(process.cwd(), 'apps/bot/logs'));

  logLine(`Live Engine v2 (RT-068) khoi dong. Base URL: ${baseUrl}. Symbols: ${SYMBOLS.join(', ')}. Che do: DAT LENH THAT (testnet).`);

  const feed = new BinanceRestPollingFeed(baseUrl, {
    onRetry: (attempt, err, delayMs) => console.warn(`  Retry #${attempt} sau ${delayMs}ms: ${err instanceof Error ? err.message : String(err)}`),
  });
  const orderClient = new BinanceOrderClient(baseUrl, apiKey, apiSecret);

  const states: SymbolRuntimeState[] = SYMBOLS.map((symbol) => ({
    symbol,
    engine: new SymbolSignalEngine(symbol),
    lifecycle: new SymbolOrderLifecycle(symbol, orderClient),
    lastH1OpenTime: null,
    lastM15OpenTime: null,
    blocked: false,
  }));

  // --- Reconciliation: check REAL exchange state before trusting anything ---
  logLine('Dang doi chieu (reconcile) trang thai that tren san giao dich...');
  for (const state of states) {
    try {
      const [positionQty, openOrders] = await Promise.all([orderClient.getOpenPositionQty(state.symbol), orderClient.getOpenOrders(state.symbol)]);
      if (positionQty !== 0 || openOrders.length > 0) {
        state.blocked = true;
        const msg = `${state.symbol} da co vi the/lenh THAT tren san (positionQty=${positionQty}, openOrders=${openOrders.length}) TRUOC KHI engine nay khoi dong — BLOCK phat hien tin hieu moi cho symbol nay cho toi khi restart voi trang thai sach.`;
        console.warn(`  ${msg}`);
        await emit(telegramConfig, logger, { timestampUtc: new Date().toISOString(), symbol: state.symbol, strategy: 'FVG H1+M15', eventKind: 'LIFECYCLE_ERROR', note: msg, raw: { positionQty, openOrders } }, true);
      }
    } catch (err) {
      console.error(`  ${state.symbol}: LOI khi doi chieu trang thai (coi nhu BLOCKED de an toan):`, err);
      state.blocked = true;
    }
  }
  logLine('Doi chieu xong.\n');

  // --- Catch-up: seed detection state from recent history. Never places real orders for
  // catch-up-derived signals (an entry price from before this process even started is stale/
  // untradeable) — only logs them as informational. ---
  logLine('Dang bat kip (catch-up) tu lich su gan day (chi cap nhat trang thai, KHONG dat lenh)...');
  for (const state of states) {
    try {
      const h1Candles = await feed.getClosedCandlesSince(state.symbol, '1h', null, CATCH_UP_LOOKBACK_CANDLES);
      for (const c of h1Candles) state.engine.onNewH1Candle(c);
      if (h1Candles.length > 0) state.lastH1OpenTime = h1Candles[h1Candles.length - 1].openTime;

      const m15Candles = await feed.getClosedCandlesSince(state.symbol, '15m', null, CATCH_UP_LOOKBACK_CANDLES);
      for (const c of m15Candles) {
        const signal = state.engine.checkForNewSignal(c, true);
        if (signal) logLine(`  [catch-up, KHONG dat lenh] ${state.symbol}: tin hieu ${signal.direction} tai ${signal.detectedAtOpenTime} (da qua, bo qua)`);
      }
      if (m15Candles.length > 0) state.lastM15OpenTime = m15Candles[m15Candles.length - 1].openTime;
      logLine(`  ${state.symbol}: H1=${h1Candles.length} nen, M15=${m15Candles.length} nen. ${JSON.stringify(state.engine.getDebugState())}`);
    } catch (err) {
      console.error(`  ${state.symbol}: LOI khi catch-up (se thu lai o vong poll dau tien):`, err);
    }
  }
  logLine('Catch-up xong.\n');

  // TICKET-RT-072: real balance for the startup message — never blocks startup if this fails
  // (network blip etc.), just logs and falls back to "khong lay duoc" in the Telegram message.
  let startupBalanceUsdt: number | null = null;
  try {
    startupBalanceUsdt = await orderClient.getAvailableBalanceUsdt();
  } catch (err) {
    console.error('  LOI khi lay balance that cho tin nhan khoi dong (bo qua, van khoi dong binh thuong):', err);
  }
  await emit(telegramConfig, logger, fromEngineStartup({ symbols: SYMBOLS, baseUrl, isRestart: process.env.LIVE_ENGINE_RESTART === '1', balanceUsdt: startupBalanceUsdt }), true);

  // --- Live polling loop (single M15-cadence schedule — see RT-067's file comment for why H1 is
  // polled at the same cadence instead of two independent timers) ---
  let consecutiveFailureStreak = 0;

  async function pollCycle(): Promise<void> {
    for (const state of states) {
      try {
        const h1Candles = await feed.getClosedCandlesSince(state.symbol, '1h', state.lastH1OpenTime);
        for (const c of h1Candles) state.engine.onNewH1Candle(c);
        if (h1Candles.length > 0) state.lastH1OpenTime = h1Candles[h1Candles.length - 1].openTime;

        const m15Candles = await feed.getClosedCandlesSince(state.symbol, '15m', state.lastM15OpenTime);
        for (const c of m15Candles) {
          // Capture "free" BEFORE processing this candle's order-lifecycle tick — a position that
          // closes ON this candle does not get evaluated for a fresh signal until the NEXT candle,
          // mirroring every backtest script's `continue`-after-close convention.
          const wasFree = !state.blocked && state.lifecycle.isFree();

          const lifecycleEvent = await state.lifecycle.onNewM15Candle();
          if (lifecycleEvent) await emit(telegramConfig, logger, fromLifecycleEvent(lifecycleEvent), true);

          if (wasFree) {
            const signal = state.engine.checkForNewSignal(c, true);
            if (signal) {
              const placeEvent: LifecycleEvent = await state.lifecycle.onSignalDetected(signal);
              await emit(telegramConfig, logger, fromLifecycleEvent(placeEvent), true);
            }
          } else {
            state.engine.checkForNewSignal(c, false); // still buffers the candle, never detects
          }
        }
        if (m15Candles.length > 0) state.lastM15OpenTime = m15Candles[m15Candles.length - 1].openTime;

        consecutiveFailureStreak = 0;
      } catch (err) {
        consecutiveFailureStreak++;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[${new Date().toISOString()}] LOI khi poll ${state.symbol} (lan lien tiep #${consecutiveFailureStreak}):`, err);
        if (telegramConfig && (consecutiveFailureStreak === 3 || consecutiveFailureStreak % 20 === 0)) {
          await emit(telegramConfig, logger, fromPollError({ symbol: state.symbol, message, consecutiveFailures: consecutiveFailureStreak }), true).catch(() => {});
        }
      }
    }
  }

  function scheduleNextTick(): void {
    feed
      .getServerTimeMs()
      .catch(() => Date.now())
      .then((nowMs) => {
        const delayMs = Math.max(500, msUntilNextPoll('15m', nowMs));
        setTimeout(() => {
          pollCycle()
            .catch((err) => console.error('Loi khong mong doi trong pollCycle (da bat, engine tiep tuc chay):', err))
            .finally(() => scheduleNextTick());
        }, delayMs);
      });
  }
  scheduleNextTick();

  // Genuinely unexpected errors: log + best-effort Telegram alert + exit, so an external process
  // manager restarts cleanly — the reconciliation logic above makes a restart safe (RT-067's
  // original reasoning; RT-068 hardens it for real orders specifically).
  const fatal = async (context: string, err: unknown) => {
    console.error(`${context} — engine se thoat de process manager restart:`, err);
    if (telegramConfig) {
      await emit(telegramConfig, logger, { timestampUtc: new Date().toISOString(), symbol: 'ALL', strategy: 'FVG H1+M15', eventKind: 'LIFECYCLE_ERROR', note: `${context}: ${err instanceof Error ? err.message : String(err)}`, raw: { context, err: String(err) } }, true).catch(() => {});
    }
    process.exit(1);
  };
  process.on('unhandledRejection', (reason) => void fatal('unhandledRejection', reason));
  process.on('uncaughtException', (err) => void fatal('uncaughtException', err));
}

main().catch((err) => {
  console.error('LOI NGHIEM TRONG khi khoi dong Live Engine:', err);
  process.exitCode = 1;
});
