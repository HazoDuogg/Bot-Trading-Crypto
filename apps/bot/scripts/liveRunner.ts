import { config as loadEnv } from 'dotenv';
loadEnv();

import { BinanceRestPollingFeed, msUntilNextPoll } from '../src/live/binanceRestPollingFeed.js';
import { SymbolSignalEngine, type SignalEngineEvent } from '../src/live/signalEngine.js';
import { loadTelegramConfigFromEnv, sendTelegramMessage, formatSignalMessage, formatStartupMessage, formatErrorMessage, type TelegramConfig } from '../src/live/telegram.js';

// TICKET-RT-067 Part C: main live loop — monitoring only, places NO orders (Ticket 2's job).
// For each new closed candle from BinanceRestPollingFeed, runs it through SymbolSignalEngine
// (which calls the exact same production pure functions every backtest in this repo has used) and
// sends a Telegram notification when a real-time signal is detected.
//
// Scheduling design: ONE recurring tick per M15 close boundary (+3s), not two independent timers
// for H1 and M15. At each tick this polls H1 first, then M15. On 3 of every 4 ticks the H1 poll is
// a cheap no-op (no new H1 candle yet); on the 4th tick (which coincides EXACTLY with an H1
// boundary — H1 closes are always also M15 closes), the fresh H1 candle is picked up within the
// same +3s window as its own close AND is guaranteed visible to that tick's M15 processing. Two
// independent timers could race — an M15 tick evaluating trend direction against a stale H1
// buffer if the H1 timer's network round-trip happened to land after the M15 one — this design
// structurally rules that out with a single, simpler schedule.

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
const CATCH_UP_LOOKBACK_CANDLES = 300; // see binanceRestPollingFeed.ts's DEFAULT_LOOKBACK_CANDLES for why 300

interface SymbolRuntimeState {
  symbol: string;
  engine: SymbolSignalEngine;
  lastH1OpenTime: number | null;
  lastM15OpenTime: number | null;
}

function logLine(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function handleEvent(telegramConfig: TelegramConfig | null, symbol: string, event: SignalEngineEvent, notify: boolean): Promise<void> {
  if (event.type === 'SIGNAL') {
    logLine(
      `TIN HIEU ${notify ? '' : '[catch-up, khong gui Telegram] '}: ${symbol} ${event.direction} entry=${event.entryPrice} sl=${event.slPrice} tp=${event.tpPrice} risk=${(event.riskPct * 100).toFixed(2)}% breaksKeyZone=${event.breaksKeyZone}`,
    );
    if (notify && telegramConfig) {
      const results = await sendTelegramMessage(telegramConfig, formatSignalMessage(event));
      for (const r of results) if (!r.ok) console.error(`  Gui Telegram toi chat ${r.chatId} that bai: ${r.error}`);
    }
  } else {
    logLine(`Virtual close ${notify ? '' : '[catch-up] '}: ${symbol} ${event.outcome} entry=${event.entryPrice} exit=${event.exitPrice}`);
  }
}

async function main() {
  const baseUrl = process.env.LIVE_EXCHANGE_BASE_URL || process.env.BINANCE_TESTNET_URL;
  if (!baseUrl) {
    throw new Error('CORRECTION_REQUIRED: can bien moi truong LIVE_EXCHANGE_BASE_URL hoac BINANCE_TESTNET_URL trong .env — khong co gia tri mac dinh de tranh vo tinh tro toi live API.');
  }

  const telegramConfig = loadTelegramConfigFromEnv();
  if (!telegramConfig) {
    console.warn('CANH BAO: TELEGRAM_BOT_TOKEN_ENC / TELEGRAM_CHAT_ID chua duoc cau hinh trong .env — engine van chay nhung se KHONG gui duoc thong bao Telegram.');
  }

  logLine(`Live Engine v1 (RT-067) khoi dong. Base URL: ${baseUrl}. Symbols: ${SYMBOLS.join(', ')}. Che do: CHI GIAM SAT, chua dat lenh.`);

  const feed = new BinanceRestPollingFeed(baseUrl, {
    onRetry: (attempt, err, delayMs) => console.warn(`  Retry #${attempt} sau ${delayMs}ms: ${err instanceof Error ? err.message : String(err)}`),
  });

  const states: SymbolRuntimeState[] = SYMBOLS.map((symbol) => ({ symbol, engine: new SymbolSignalEngine(symbol), lastH1OpenTime: null, lastM15OpenTime: null }));

  // --- Part B point 6: catch-up (also covers first-ever startup, where "catch-up" = full seed) ---
  logLine('Dang bat kip (catch-up) tu lich su gan day...');
  for (const state of states) {
    try {
      const h1Candles = await feed.getClosedCandlesSince(state.symbol, '1h', null, CATCH_UP_LOOKBACK_CANDLES);
      for (const c of h1Candles) state.engine.onNewH1Candle(c);
      if (h1Candles.length > 0) state.lastH1OpenTime = h1Candles[h1Candles.length - 1].openTime;

      const m15Candles = await feed.getClosedCandlesSince(state.symbol, '15m', null, CATCH_UP_LOOKBACK_CANDLES);
      const nowMs = await feed.getServerTimeMs();
      for (const c of m15Candles) {
        const event = state.engine.onNewM15Candle(c, nowMs);
        if (event) await handleEvent(telegramConfig, state.symbol, event, false);
      }
      if (m15Candles.length > 0) state.lastM15OpenTime = m15Candles[m15Candles.length - 1].openTime;

      logLine(`  ${state.symbol}: H1=${h1Candles.length} nen, M15=${m15Candles.length} nen. Trang thai sau catch-up: ${JSON.stringify(state.engine.getDebugState())}`);
    } catch (err) {
      console.error(`  ${state.symbol}: LOI khi catch-up (se thu lai o vong poll dau tien):`, err);
    }
  }
  logLine('Catch-up xong.\n');

  if (telegramConfig) {
    await sendTelegramMessage(telegramConfig, formatStartupMessage({ symbols: SYMBOLS, baseUrl, isRestart: process.env.LIVE_ENGINE_RESTART === '1' }));
  }

  // --- Live polling loop ---
  let consecutiveFailureStreak = 0;

  async function pollCycle(): Promise<void> {
    for (const state of states) {
      try {
        const h1Candles = await feed.getClosedCandlesSince(state.symbol, '1h', state.lastH1OpenTime);
        for (const c of h1Candles) state.engine.onNewH1Candle(c);
        if (h1Candles.length > 0) state.lastH1OpenTime = h1Candles[h1Candles.length - 1].openTime;

        const m15Candles = await feed.getClosedCandlesSince(state.symbol, '15m', state.lastM15OpenTime);
        if (m15Candles.length > 0) {
          const nowMs = await feed.getServerTimeMs();
          for (const c of m15Candles) {
            const event = state.engine.onNewM15Candle(c, nowMs);
            if (event) await handleEvent(telegramConfig, state.symbol, event, true);
          }
          state.lastM15OpenTime = m15Candles[m15Candles.length - 1].openTime;
        }

        consecutiveFailureStreak = 0;
      } catch (err) {
        consecutiveFailureStreak++;
        console.error(`[${new Date().toISOString()}] LOI khi poll ${state.symbol} (lan lien tiep #${consecutiveFailureStreak}):`, err);
        // Part D: notify on "mat ket noi API keo dai" — alert on the 3rd consecutive failure across
        // any symbol, then again every 20 to avoid spamming during an extended outage.
        if (telegramConfig && (consecutiveFailureStreak === 3 || consecutiveFailureStreak % 20 === 0)) {
          await sendTelegramMessage(telegramConfig, formatErrorMessage({ context: `Poll ${state.symbol}`, message: err instanceof Error ? err.message : String(err), consecutiveFailures: consecutiveFailureStreak })).catch(() => {});
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
  // manager (pm2/systemd/docker restart policy — Vinh Tam's VPS setup) restarts cleanly. The
  // catch-up logic above makes a restart safe: ongoing pending/open state reconstructs correctly.
  // This is DELIBERATELY different from the per-poll try/catch above, which handles EXPECTED
  // transient failures (network blips, rate limits) without ever needing a restart at all — per
  // the ticket's "khong thoat han process vi 1 loi" (that loi = one transient poll error).
  const fatal = async (context: string, err: unknown) => {
    console.error(`${context} — engine se thoat de process manager restart:`, err);
    if (telegramConfig) {
      await sendTelegramMessage(telegramConfig, formatErrorMessage({ context, message: err instanceof Error ? err.message : String(err) })).catch(() => {});
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
