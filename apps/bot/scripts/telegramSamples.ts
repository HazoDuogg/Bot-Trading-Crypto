/**
 * TICKET-078 — generates REAL sample messages for all 5 Telegram notification types + the weekly
 * summary, by running the exact official 8-flag backtest config (see memory/project docs — the
 * $2107.83/494-trade baseline) and picking real OPEN/PARTIAL_CLOSE/CLOSE/regime-change events out
 * of the actual run, instead of hand-typed fixtures. Dry-run only by default (prints + writes a
 * markdown file) — pass --send=true to actually push them to Telegram via TELEGRAM_BOT_TOKEN_ENC/
 * TELEGRAM_CHAT_ID in .env (only do this with explicit user go-ahead, sending real messages is a
 * separate, permissioned action from generating the samples).
 *
 * Run: npm run build:scripts && node apps/bot/scripts-dist/telegramSamples.js [--send=true]
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CandleData } from '../dist/regime/types.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { processCandle, type ProcessCandleInput } from '../dist/orchestrator/orchestrator.js';
import {
  INITIAL_SYMBOL_STATE,
  type CloseTradeEvent,
  type OpenTradeEvent,
  type OrchestratorConfig,
  type PartialCloseEvent,
  type SymbolState,
} from '../dist/orchestrator/types.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG } from '../dist/entry/entryRouter.js';
import { DEFAULT_MOMENTUM_FILTER_CONFIG, DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG, DEFAULT_PLAN_AUTO_SELECTION_CONFIG } from '../dist/xgbFilter/config.js';
import type { OpenPositionRisk } from '../dist/risk/riskPool.js';
import {
  computeWeeklySummaryStats,
  formatBotStartMessage,
  formatFullCloseMessage,
  formatPartialCloseMessage,
  formatPositionOpenedMessage,
  formatRegimeChangeMessage,
  formatWeeklySummaryMessage,
  type RegimeChangeInfo,
} from '../dist/telegram/messageFormatters.js';
import { loadTelegramConfig } from '../dist/telegram/telegramClient.js';
import { TelegramMessageQueue } from '../dist/telegram/messageQueue.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const START_BALANCE = 400;
const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;
const WINDOW_1H_MOMENTUM = 250;

function readCsv(filePath: string): CandleData[] {
  const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
  return lines.slice(1).map((line) => {
    const [timestampUtc, , open, high, low, close, volume] = line.split(',');
    return { timestamp: Number(timestampUtc), open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) };
  });
}

interface SymbolData {
  candles5m: CandleData[];
  candles15m: CandleData[];
  candles1h: CandleData[];
  candles1m: CandleData[];
  candles1d: CandleData[];
  ptr15m: number;
  ptr1h: number;
  ptr1m: number;
  ptr1d: number;
  state: SymbolState;
}

function loadSymbolData(symbol: string): SymbolData {
  return {
    candles5m: readCsv(path.join(OHLCV_DIR, `${symbol}_5m.csv`)),
    candles15m: readCsv(path.join(OHLCV_DIR, `${symbol}_15m.csv`)),
    candles1h: readCsv(path.join(OHLCV_DIR, `${symbol}_1h.csv`)),
    candles1m: readCsv(path.join(OHLCV_DIR, `${symbol}_1m.csv`)),
    candles1d: readCsv(path.join(OHLCV_DIR, `${symbol}_1d.csv`)),
    ptr15m: -1,
    ptr1h: -1,
    ptr1m: -1,
    ptr1d: -1,
    state: INITIAL_SYMBOL_STATE,
  };
}

function closedWindow(candles: CandleData[], ptr: number, intervalMs: number, decisionTime: number, windowSize: number): { window: CandleData[]; ptr: number } {
  let p = ptr;
  while (p + 1 < candles.length && candles[p + 1].timestamp + intervalMs <= decisionTime) p++;
  if (p < 0) return { window: [], ptr: p };
  const start = Math.max(0, p - windowSize + 1);
  return { window: candles.slice(start, p + 1), ptr: p };
}

// The official 8-flag config confirmed for the $2107.83/494-trade baseline.
const CONFIG: OrchestratorConfig = {
  entryRouterConfig: { ...DEFAULT_ENTRY_ROUTER_CONFIG },
  tpPlan: 'PLAN_A',
  takerFeeRate: 0.0004,
  riskDollarOrPercent: 20,
  maxMarginCap: 50,
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
const SKIP_DAYS = 20;

interface CapturedOpen {
  event: OpenTradeEvent;
  accountBalanceAtOpen: number;
}

async function main(): Promise<void> {
  const sendArg = process.argv.slice(2).find((a) => a.startsWith('--send='));
  const shouldSend = sendArg?.split('=')[1] === 'true';

  const symbolsData: Record<string, SymbolData> = {};
  for (const symbol of SYMBOLS) symbolsData[symbol] = loadSymbolData(symbol);

  let accountBalance = START_BALANCE;
  const opens: CapturedOpen[] = [];
  const partials: PartialCloseEvent[] = [];
  const closes: CloseTradeEvent[] = [];
  const regimeChanges: RegimeChangeInfo[] = [];

  const totalSteps = Math.min(...SYMBOLS.map((s) => symbolsData[s].candles5m.length));
  const startStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5 + SKIP_DAYS * 288;
  console.log(`Chạy ${totalSteps - startStep} bước x ${SYMBOLS.length} coin để thu thập mẫu thật...`);

  for (let step = startStep; step < totalSteps; step++) {
    const openRiskBySymbol: Record<string, number> = {};
    for (const symbol of SYMBOLS) {
      const totalRisk = symbolsData[symbol].state.openPositions.reduce((sum, entry) => sum + entry.meta.actualRiskDollar, 0);
      if (totalRisk > 0) openRiskBySymbol[symbol] = totalRisk;
    }
    const momentumDirectOpenPositionsTotal = SYMBOLS.reduce(
      (sum, symbol) => sum + symbolsData[symbol].state.openPositions.filter((entry) => entry.meta.setupType === 'MOMENTUM_DIRECT').length,
      0,
    );
    const momentumDirectOpenPositions: Array<{ symbol: string; side: 'LONG' | 'SHORT' }> = SYMBOLS.flatMap((symbol) =>
      symbolsData[symbol].state.openPositions.filter((entry) => entry.meta.setupType === 'MOMENTUM_DIRECT').map((entry) => ({ symbol, side: entry.position.side })),
    );

    const w1hBySymbol: Record<string, CandleData[]> = {};
    for (const symbol of SYMBOLS) {
      const sd = symbolsData[symbol];
      const decisionTime = sd.candles5m[step].timestamp + 5 * 60_000;
      const w1h = closedWindow(sd.candles1h, sd.ptr1h, 60 * 60_000, decisionTime, WINDOW_1H);
      sd.ptr1h = w1h.ptr;
      w1hBySymbol[symbol] = w1h.window;
    }
    const correlatedRiskRatioSeries = computeCorrelatedRiskRatio(w1hBySymbol, RegimeConfig.CORRELATED_RISK_WINDOW_CANDLES, 'BTCUSDT');
    const correlatedRiskRatio = correlatedRiskRatioSeries[correlatedRiskRatioSeries.length - 1];

    for (const symbol of SYMBOLS) {
      const sd = symbolsData[symbol];
      const currentCandle = sd.candles5m[step];
      const decisionTime = currentCandle.timestamp + 5 * 60_000;

      const window5m = sd.candles5m.slice(Math.max(0, step - WINDOW_5M + 1), step + 1);
      const w15 = closedWindow(sd.candles15m, sd.ptr15m, 15 * 60_000, decisionTime, WINDOW_15M);
      sd.ptr15m = w15.ptr;
      const w1hMomentum = closedWindow(sd.candles1h, sd.ptr1h, 60 * 60_000, decisionTime, WINDOW_1H_MOMENTUM);
      const w1m = closedWindow(sd.candles1m, sd.ptr1m, 60_000, decisionTime, WINDOW_1M);
      sd.ptr1m = w1m.ptr;
      const w1d = closedWindow(sd.candles1d, sd.ptr1d, 24 * 60 * 60_000, decisionTime, WINDOW_1D);
      sd.ptr1d = w1d.ptr;

      const allOpenPositionsRisk: OpenPositionRisk[] = SYMBOLS.filter((s) => openRiskBySymbol[s] !== undefined).map((s) => ({ id: s, actualRiskDollar: openRiskBySymbol[s] }));

      const input: ProcessCandleInput = {
        symbol,
        candles5m: window5m,
        candles15m: w15.window,
        candles1h: w1hBySymbol[symbol],
        candles1m: w1m.window,
        candles1d: w1d.window,
        candles1hMomentum: w1hMomentum.window,
        correlatedRiskRatio,
        accountBalance,
        allOpenPositionsRisk,
        momentumDirectOpenPositionsTotal,
        momentumDirectOpenPositions,
      };

      const balanceBeforeThisSymbol = accountBalance;
      const previousRegime = sd.state.regimeState.previousRegime;
      // TICKET-078 — captures regimeOutput.computedMetrics for THIS call via the new onRegimeMetrics
      // diagnostic callback (orchestrator.ts), so a regime-change sample can show real adx1h/
      // atrPercentile5m instead of the placeholder undefined the first draft of this script used.
      let lastComputedMetrics: { adx1h?: number; atrPercentile5m?: number } = {};
      const result = await processCandle(input, sd.state, CONFIG, undefined, undefined, undefined, undefined, (m) => {
        lastComputedMetrics = m;
      });
      sd.state = result.symbolState;
      accountBalance = result.accountBalance;

      const newRegime = sd.state.regimeState.previousRegime;
      if (previousRegime !== null && newRegime !== null && previousRegime !== newRegime && regimeChanges.length < 3) {
        regimeChanges.push({
          symbol,
          fromRegime: previousRegime,
          toRegime: newRegime,
          adx1h: lastComputedMetrics.adx1h,
          atrPercentile5m: lastComputedMetrics.atrPercentile5m,
          timestamp: currentCandle.timestamp,
        });
      }

      for (const event of result.events) {
        if (event.type === 'OPEN' && opens.length < 4) opens.push({ event, accountBalanceAtOpen: balanceBeforeThisSymbol });
        else if (event.type === 'PARTIAL_CLOSE' && partials.length < 4) partials.push(event);
        else if (event.type === 'CLOSE') closes.push(event);
      }
    }

    if (opens.length >= 4 && partials.length >= 4 && closes.length >= 30 && regimeChanges.length >= 3) break;
  }

  console.log(`Thu thập được: ${opens.length} OPEN, ${partials.length} PARTIAL_CLOSE, ${closes.length} CLOSE, ${regimeChanges.length} regime-change.`);

  // ---- Pick representative samples ----
  const trendOpen = opens.find((o) => o.event.setupType !== 'MOMENTUM_DIRECT');
  const counterTrendOpen = opens.find((o) => o.event.setupType === 'MOMENTUM_DIRECT');
  const tp1Partial = partials.find((p) => p.tier === 'TP1');
  const tp2Partial = partials.find((p) => p.tier === 'TP2');
  const winClose = closes.find((c) => c.pnlUsd >= 0);
  const lossClose = closes.find((c) => c.pnlUsd < 0);
  const regimeChange = regimeChanges[0];

  const botStartMsg = formatBotStartMessage({
    env: 'testnet',
    symbols: SYMBOLS,
    balance: START_BALANCE,
    momentumDirectEnabled: CONFIG.momentumDirectEnabled,
    riskPoolMaxPct: CONFIG.riskPoolMaxPct,
    maxConcurrentPositionsPerSymbol: CONFIG.maxConcurrentPositionsPerSymbol,
    timestamp: symbolsData.BTCUSDT.candles5m[startStep].timestamp,
  });

  const messages: { label: string; text: string }[] = [{ label: '1. BOT START', text: botStartMsg }];
  if (trendOpen) messages.push({ label: '2a. VÀO LỆNH (TREND, OB/FVG/SWEEP/BOX_BREAKOUT)', text: formatPositionOpenedMessage(trendOpen.event, { env: 'testnet', accountBalanceAtOpen: trendOpen.accountBalanceAtOpen }) });
  if (counterTrendOpen) messages.push({ label: '2b. VÀO LỆNH (COUNTER_TREND, MOMENTUM_DIRECT)', text: formatPositionOpenedMessage(counterTrendOpen.event, { env: 'testnet', accountBalanceAtOpen: counterTrendOpen.accountBalanceAtOpen }) });
  if (tp1Partial) messages.push({ label: '3a. CHỐT MỘT PHẦN (TP1)', text: formatPartialCloseMessage(tp1Partial, { env: 'testnet' }) });
  if (tp2Partial) messages.push({ label: '3b. CHỐT MỘT PHẦN (TP2)', text: formatPartialCloseMessage(tp2Partial, { env: 'testnet' }) });
  if (winClose) messages.push({ label: '4a. ĐÓNG LỆNH (WIN)', text: formatFullCloseMessage(winClose, { env: 'testnet' }) });
  if (lossClose) messages.push({ label: '4b. ĐÓNG LỆNH (LOSS)', text: formatFullCloseMessage(lossClose, { env: 'testnet' }) });
  if (regimeChange) messages.push({ label: '5. ĐỔI TRẠNG THÁI THỊ TRƯỜNG', text: formatRegimeChangeMessage(regimeChange) });

  // ---- Weekly summary — first calendar week (7 days) inside the collected CLOSE events ----
  if (closes.length > 0) {
    const periodStart = closes[0].exitTimestamp;
    const periodEnd = periodStart + 7 * 24 * 60 * 60_000;
    const weekTrades = closes.filter((c) => c.exitTimestamp >= periodStart && c.exitTimestamp < periodEnd);
    const stats = computeWeeklySummaryStats(weekTrades, 'testnet', periodStart, periodEnd, START_BALANCE);
    messages.push({ label: '6. TỔNG KẾT TUẦN (bonus)', text: formatWeeklySummaryMessage(stats) });
  }

  // ---- Print + write to file ----
  const outLines: string[] = ['# TICKET-078 — Mẫu thông báo Telegram (dữ liệu thật từ backtest)', ''];
  for (const m of messages) {
    console.log(`\n===== ${m.label} =====\n${m.text}\n`);
    outLines.push(`## ${m.label}`, '', '```', m.text, '```', '');
  }
  const outPath = path.resolve(process.cwd(), 'data/telegram-samples.md');
  writeFileSync(outPath, outLines.join('\n'));
  console.log(`\n→ ${outPath}`);

  // ---- Optionally actually send to Telegram (explicit opt-in only) ----
  if (shouldSend) {
    console.log('\n--send=true: đang gửi thật qua Telegram...');
    const config = loadTelegramConfig();
    const queue = new TelegramMessageQueue(config);
    for (const m of messages) queue.enqueue(m.text);
    const outcomes = await queue.flush();
    for (const o of outcomes) {
      console.log(`  gửi tới ${o.succeeded.length} chat thành công, ${o.failed.length} chat lỗi`);
      for (const f of o.failed) console.log(`    lỗi chat ${f.chatId}: ${f.error.message}`);
    }
  } else {
    console.log('\n(Chưa gửi thật — chạy lại với --send=true để gửi qua Telegram sau khi đã xem lại format.)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
