/**
 * TICKET-010 Phần C+D — runs the Orchestrator sequentially over real OHLCV (all 4 symbols, one
 * shared accountBalance), producing data/backtest-report-{suffix}.md + data/backtest-trades-{suffix}.csv
 * (TICKET-017 Phần C: suffix auto-derived from --macro-trend-filter/--ob-disabled-symbols so the
 * 4 A/B combinations never overwrite each other — baseline/macrofilter/obfilter/both).
 * Run from repo root: `npm run backtest -- --entry-style=SIDEWAY_STYLE --tp-plan=PLAN_A --macro-trend-filter=true --ob-disabled-symbols=XRPUSDT`
 * (requires `npm run build` + `npm run fetch-ohlcv -- --days=180` first, including 1m/1d).
 *
 * No look-ahead: at each 5m step, every timeframe is sliced to only candles already CLOSED as of
 * that step's decision time (two-pointer, same alignment technique as calibrateThresholds.ts).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CandleData } from '../dist/regime/types.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { processCandle, type DangerZoneDiagnostic, type ManipulatedDiagnostic, type ProcessCandleInput } from '../dist/orchestrator/orchestrator.js';
import { INITIAL_SYMBOL_STATE, type CloseTradeEvent, type OrchestratorConfig, type SymbolState } from '../dist/orchestrator/types.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG } from '../dist/entry/entryRouter.js';
import type { EntryStyleForNeutral } from '../dist/entry/types.js';
import { DEFAULT_MOMENTUM_FILTER_CONFIG, DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG } from '../dist/xgbFilter/config.js';
import type { OpenPositionRisk } from '../dist/risk/riskPool.js';
import type { TpPlan } from '../dist/risk/slTpManager.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const START_BALANCE = 400; // docs/vicion-bot-quan-ly-vi-the-v1.md Mục 1

// Bounded sliding windows — enough for every metric's own lookback (ATR_PCT_LOOKBACK_5M=300 etc.),
// but NOT the full growing history. detectRegime()/routeEntry() always recompute their indicator
// series from whatever candles they're given; feeding the full 17k+-candle history at every one
// of ~17k steps would be O(n^2) and impractically slow. A live bot would only keep a bounded
// recent window in memory anyway, so this also matches how the Orchestrator would run live.
const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40; // >> EntryConfig.MACRO_TREND_ADX_PERIOD_1D(14), matches WINDOW_1H's margin
// TICKET-024: separate, much larger 1h window for the momentum model's emaRatioSlow (EMA 50/200) —
// intentionally NOT used for regime/entry (see ProcessCandleInput.candles1hMomentum doc comment for why).
const WINDOW_1H_MOMENTUM = 250;
// TICKET-028: separate, much larger 5m window for LOW_LIQUIDITY's session-relative volume ratio —
// RegimeConfig.LOW_LIQUIDITY_SESSION_LOOKBACK_DAYS(14) * 288 candles/day + 1 for the current candle
// itself. Intentionally NOT used for regime/entry's own ATR/ADX (see ProcessCandleInput.candles5mSessionVolume doc comment for why).
const WINDOW_5M_SESSION_VOLUME = 14 * 288 + 1;

function parseArgs(): {
  entryStyleForNeutral: EntryStyleForNeutral;
  tpPlan: TpPlan;
  macroTrendFilterEnabled: boolean;
  obDisabledSymbols: string[];
  macroTrendFilterAppliesToBoxBreakout: boolean;
  momentumFilterEnabled: boolean;
  neutralTransitionEnabled: boolean;
  riskPoolMaxPct: number;
  neutralGateThreshold: number;
  mssStalenessTolerance: number;
  obBosLookback: number;
} {
  const args = process.argv.slice(2);
  const styleArg = args.find((a) => a.startsWith('--entry-style='));
  const planArg = args.find((a) => a.startsWith('--tp-plan='));
  const macroArg = args.find((a) => a.startsWith('--macro-trend-filter='));
  const obArg = args.find((a) => a.startsWith('--ob-disabled-symbols='));
  const macroBoxArg = args.find((a) => a.startsWith('--macro-trend-box-breakout='));
  const momentumArg = args.find((a) => a.startsWith('--momentum-filter='));
  const neutralArg = args.find((a) => a.startsWith('--neutral-transition-enabled='));
  const riskPoolArg = args.find((a) => a.startsWith('--risk-pool-max-pct='));
  const neutralGateArg = args.find((a) => a.startsWith('--neutral-gate-threshold='));
  const mssStalenessArg = args.find((a) => a.startsWith('--mss-staleness-tolerance='));
  const obBosLookbackArg = args.find((a) => a.startsWith('--ob-bos-lookback='));
  const obValue = obArg ? obArg.split('=')[1] : '';
  return {
    entryStyleForNeutral: (styleArg ? styleArg.split('=')[1] : 'SIDEWAY_STYLE') as EntryStyleForNeutral,
    tpPlan: (planArg ? planArg.split('=')[1] : 'PLAN_A') as TpPlan,
    macroTrendFilterEnabled: macroArg ? macroArg.split('=')[1] === 'true' : false,
    obDisabledSymbols: obValue.trim() === '' ? [] : obValue.split(','),
    macroTrendFilterAppliesToBoxBreakout: macroBoxArg ? macroBoxArg.split('=')[1] === 'true' : false,
    momentumFilterEnabled: momentumArg ? momentumArg.split('=')[1] === 'true' : false,
    // TICKET-036: off by default — matches DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG.
    neutralTransitionEnabled: neutralArg ? neutralArg.split('=')[1] === 'true' : false,
    // TICKET-037: takes a plain percentage number (e.g. 10, 15), not a fraction — divided by 100
    // below. Defaults to 10 unchanged (matches risk/riskPool.ts's DEFAULT_RISK_POOL_CONFIG) when omitted.
    riskPoolMaxPct: (riskPoolArg ? Number(riskPoolArg.split('=')[1]) : 10) / 100,
    // TICKET-039: defaults to 0.55 unchanged (matches DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG) when omitted.
    neutralGateThreshold: neutralGateArg ? Number(neutralGateArg.split('=')[1]) : 0.55,
    // TICKET-040: defaults to 5 unchanged (matches EntryConfig.MSS_STALENESS_TOLERANCE_CANDLES) when omitted.
    mssStalenessTolerance: mssStalenessArg ? Number(mssStalenessArg.split('=')[1]) : 5,
    // TICKET-041: defaults to 10 unchanged (matches EntryConfig.OB_BOS_LOOKFORWARD_K) when omitted.
    obBosLookback: obBosLookbackArg ? Number(obBosLookbackArg.split('=')[1]) : 10,
  };
}

/** TICKET-017/018/024/036 Phần C: output filenames auto-derived from which filters are active, so the A/B combinations never overwrite each other. */
function outputSuffix(
  macroTrendFilterEnabled: boolean,
  obDisabledSymbols: string[],
  macroTrendFilterAppliesToBoxBreakout: boolean,
  momentumFilterEnabled: boolean,
  neutralTransitionEnabled: boolean,
): string {
  const macro = macroTrendFilterEnabled;
  const ob = obDisabledSymbols.length > 0;
  let base: string;
  if (macro && ob) base = 'both';
  else if (macro) base = 'macrofilter';
  else if (ob) base = 'obfilter';
  else base = 'baseline';
  if (macroTrendFilterAppliesToBoxBreakout) base += '-with-boxfilter';
  if (momentumFilterEnabled) base += '-momentum';
  if (neutralTransitionEnabled) base += '-neutral';
  return base;
}

function readCsv(filePath: string): CandleData[] {
  const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
  return lines.slice(1).map((line) => {
    const [timestampUtc, , open, high, low, close, volume] = line.split(',');
    return {
      timestamp: Number(timestampUtc),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    };
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

/** Two-pointer: advances `ptr` to the latest candle already CLOSED (open+interval <= decisionTime), never looks ahead. */
function closedWindow(candles: CandleData[], ptr: number, intervalMs: number, decisionTime: number, windowSize: number): { window: CandleData[]; ptr: number } {
  let p = ptr;
  while (p + 1 < candles.length && candles[p + 1].timestamp + intervalMs <= decisionTime) p++;
  if (p < 0) return { window: [], ptr: p };
  const start = Math.max(0, p - windowSize + 1);
  return { window: candles.slice(start, p + 1), ptr: p };
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

interface GroupStats {
  count: number;
  wins: number;
  pnl: number;
}

function groupBy(trades: CloseTradeEvent[], keyFn: (t: CloseTradeEvent) => string): Record<string, GroupStats> {
  const result: Record<string, GroupStats> = {};
  for (const t of trades) {
    const key = keyFn(t);
    if (!result[key]) result[key] = { count: 0, wins: 0, pnl: 0 };
    result[key].count++;
    result[key].pnl += t.pnlUsd;
    if (t.pnlUsd > 0) result[key].wins++;
  }
  return result;
}

function statsTable(title: string, stats: Record<string, GroupStats>, sortChronological = false): string {
  const entries = Object.entries(stats).sort((a, b) => (sortChronological ? a[0].localeCompare(b[0]) : b[1].pnl - a[1].pnl));
  const rows = entries.map(
    ([key, s]) => `| ${key} | ${s.count} | ${((s.wins / s.count) * 100).toFixed(1)}% | ${s.pnl >= 0 ? '+' : ''}${s.pnl.toFixed(2)} |`,
  );
  return [`### ${title}`, '', '| | Số lệnh | Winrate | PNL ($) |', '|---|---|---|---|', ...rows, ''].join('\n');
}

// TICKET-027 — diagnostic log only, separate file from backtest-report/trades. Formats one entry per
// fresh MANIPULATED confirmation (see orchestrator.ts's onManipulatedConfirmed callback).
function formatManipulatedDiagnostic(d: ManipulatedDiagnostic): string {
  const candleLines = d.lookbackWindow.map(
    (c) => `    ${new Date(c.timestamp).toISOString()} open=${c.open} high=${c.high} low=${c.low} close=${c.close} volume=${c.volume}`,
  );
  return [
    `[MANIPULATED] symbol=${d.symbol} timestamp=${new Date(d.timestamp).toISOString()} upperSweepCount=${d.upperSweepCount} lowerSweepCount=${d.lowerSweepCount} volumeZScore5m=${d.volumeZScore5m}`,
    `  lookbackWindow (${d.lookbackWindow.length} nến gần nhất):`,
    ...candleLines,
  ].join('\n');
}

// TICKET-033 — diagnostic log only, separate file from backtest-report/trades. Formats one entry per
// fresh DANGER_ZONE confirmation (see orchestrator.ts's onDangerZoneConfirmed callback). Same pattern as TICKET-027.
function formatDangerZoneDiagnostic(d: DangerZoneDiagnostic): string {
  return `[DANGER_ZONE] symbol=${d.symbol} timestamp=${new Date(d.timestamp).toISOString()} atrPercentile5m=${d.atrPercentile5m}\n  volumeZScore5m=${d.volumeZScore5m}`;
}

function tradesCsv(trades: CloseTradeEvent[]): string {
  const header = 'symbol,side,regime,setupType,tpPlan,entryTimestamp,entryPrice,exitTimestamp,exitPrice,exitReason,pnlUsd,pnlPct,riskMultiplierApplied,accountBalanceAfter';
  const rows = trades.map((t) =>
    [t.symbol, t.side, t.regime, t.setupType, t.tpPlan, t.entryTimestamp, t.entryPrice, t.exitTimestamp, t.exitPrice, t.exitReason, t.pnlUsd, t.pnlPct, t.riskMultiplier, t.accountBalanceAfter].join(','),
  );
  return [header, ...rows].join('\n') + '\n';
}

async function main(): Promise<void> {
  const {
    entryStyleForNeutral,
    tpPlan,
    macroTrendFilterEnabled,
    obDisabledSymbols,
    macroTrendFilterAppliesToBoxBreakout,
    momentumFilterEnabled,
    neutralTransitionEnabled,
    riskPoolMaxPct,
    neutralGateThreshold,
    mssStalenessTolerance,
    obBosLookback,
  } = parseArgs();
  console.log(
    `Backtest — entryStyleForNeutral=${entryStyleForNeutral}, tpPlan=${tpPlan}, macroTrendFilterEnabled=${macroTrendFilterEnabled}, obDisabledSymbols=[${obDisabledSymbols.join(',')}], macroTrendFilterAppliesToBoxBreakout=${macroTrendFilterAppliesToBoxBreakout}, momentumFilterEnabled=${momentumFilterEnabled}, neutralTransitionEnabled=${neutralTransitionEnabled}, riskPoolMaxPct=${riskPoolMaxPct}, neutralGateThreshold=${neutralGateThreshold}, mssStalenessTolerance=${mssStalenessTolerance}, obBosLookback=${obBosLookback}`,
  );
  console.log('Đọc CSV (5m/15m/1h/1m/1d x 4 coin)...');

  const symbolsData: Record<string, SymbolData> = {};
  for (const symbol of SYMBOLS) symbolsData[symbol] = loadSymbolData(symbol);

  const config: OrchestratorConfig = {
    entryRouterConfig: {
      ...DEFAULT_ENTRY_ROUTER_CONFIG,
      entryStyleForNeutral,
      macroTrendFilterEnabled,
      obDisabledSymbols,
      macroTrendFilterAppliesToBoxBreakout,
      mssStalenessToleranceCandles: mssStalenessTolerance, // TICKET-040: CLI-overridable A/B testing — default (5) unchanged from before this ticket.
      obBosLookforwardK: obBosLookback, // TICKET-041: CLI-overridable A/B testing — default (10) unchanged from before this ticket.
    },
    tpPlan,
    takerFeeRate: 0.0004, // TODO_CONFIRM per docs Mục 8 — Trader chưa cung cấp số thật theo VIP tier
    riskDollarOrPercent: 20,
    maxMarginCap: 50,
    leverage: 30,
    riskPoolMaxPct, // TICKET-037: CLI-overridable A/B testing — default (10 -> 0.1) unchanged from before this ticket.
    isLowConfidenceOrLowLiquidity: false,
    momentumFilterConfig: { ...DEFAULT_MOMENTUM_FILTER_CONFIG, momentumFilterEnabled },
    neutralTransitionGateConfig: {
      ...DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG,
      neutralTransitionTradingEnabled: neutralTransitionEnabled,
      neutralTransitionMomentumGateThreshold: neutralGateThreshold, // TICKET-039: CLI-overridable A/B testing — default (0.55) unchanged from before this ticket.
    },
  };

  let accountBalance = START_BALANCE;
  const trades: CloseTradeEvent[] = [];
  // TICKET-036: SKIPPED events now have 2 distinct reasons — kept separate so this summary line
  // never falsely blames "risk pool" for what's actually the Momentum Gate rejecting NEUTRAL_TRANSITION.
  let riskPoolSkippedCount = 0;
  let neutralGateRejectedCount = 0;
  const manipulatedLogLines: string[] = []; // TICKET-027
  const dangerZoneLogLines: string[] = []; // TICKET-033

  const totalSteps = Math.min(...SYMBOLS.map((s) => symbolsData[s].candles5m.length));
  // startStep must guarantee enough REAL TIME has elapsed for every timeframe's window to be full,
  // not just the 5m one — 325 15m candles takes 3.4 real days (975 5m-candle-equivalents), which
  // dominates over the 5m window's own 320-candle (26.7h) requirement.
  const startStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5; // +5 safety margin

  console.log(`Chạy ${totalSteps - startStep} bước x ${SYMBOLS.length} coin (từ nến 5m #${startStep})...`);

  for (let step = startStep; step < totalSteps; step++) {
    const openRiskBySymbol: Record<string, number> = {};
    for (const symbol of SYMBOLS) {
      const meta = symbolsData[symbol].state.openMeta;
      if (meta) openRiskBySymbol[symbol] = meta.actualRiskDollar;
    }

    // TICKET-030: cross-symbol correlation needs all 4 symbols' aligned 1H windows BEFORE any
    // processCandle() call this step — computed ONCE here, then the same value is fed into every
    // symbol's input below. Pearson correlation over a fixed trailing window (unlike Wilder ATR/ADX)
    // has no recursive-seed dependency on how far back the window starts, so reusing WINDOW_1H(40)
    // — already >= CORRELATED_RISK_WINDOW_CANDLES(30)+1 — is safe; no dedicated larger window needed.
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
      const windowSessionVolume5m = sd.candles5m.slice(Math.max(0, step - WINDOW_5M_SESSION_VOLUME + 1), step + 1);
      const w15 = closedWindow(sd.candles15m, sd.ptr15m, 15 * 60_000, decisionTime, WINDOW_15M);
      sd.ptr15m = w15.ptr;
      // TICKET-024: same closed-candle pointer (sd.ptr1h, already advanced in the pre-pass above),
      // just a longer slice — momentum's EMA(200) needs far more 1h history than regime/entry's own
      // WINDOW_1H(40). closedWindow's ptr advancement doesn't depend on windowSize, so recomputing
      // from the already-advanced sd.ptr1h here is safe/idempotent.
      const w1hMomentum = closedWindow(sd.candles1h, sd.ptr1h, 60 * 60_000, decisionTime, WINDOW_1H_MOMENTUM);
      const w1m = closedWindow(sd.candles1m, sd.ptr1m, 60_000, decisionTime, WINDOW_1M);
      sd.ptr1m = w1m.ptr;
      const w1d = closedWindow(sd.candles1d, sd.ptr1d, 24 * 60 * 60_000, decisionTime, WINDOW_1D);
      sd.ptr1d = w1d.ptr;

      const otherOpenPositionsRisk: OpenPositionRisk[] = SYMBOLS.filter((s) => s !== symbol && openRiskBySymbol[s] !== undefined).map((s) => ({
        id: s,
        actualRiskDollar: openRiskBySymbol[s],
      }));

      const input: ProcessCandleInput = {
        symbol,
        candles5m: window5m,
        candles15m: w15.window,
        candles1h: w1hBySymbol[symbol],
        candles1m: w1m.window,
        candles1d: w1d.window,
        candles1hMomentum: w1hMomentum.window,
        candles5mSessionVolume: windowSessionVolume5m,
        correlatedRiskRatio,
        accountBalance,
        otherOpenPositionsRisk,
      };

      const result = await processCandle(
        input,
        sd.state,
        config,
        (d) => manipulatedLogLines.push(formatManipulatedDiagnostic(d)),
        (d) => dangerZoneLogLines.push(formatDangerZoneDiagnostic(d)),
      );
      sd.state = result.symbolState;
      accountBalance = result.accountBalance;

      if (result.event?.type === 'CLOSE') trades.push(result.event);
      else if (result.event?.type === 'SKIPPED') {
        if (result.event.reason === 'RISK_POOL_EXCEEDED') riskPoolSkippedCount++;
        else neutralGateRejectedCount++;
      }
    }

    const progressStep = step - startStep;
    if (progressStep % 2000 === 0) {
      console.log(
        `  bước ${progressStep}/${totalSteps - startStep} — balance=$${accountBalance.toFixed(2)}, trades=${trades.length}, riskPoolSkipped=${riskPoolSkippedCount}, neutralGateRejected=${neutralGateRejectedCount}...`,
      );
    }
  }

  console.log(
    `Xong. ${trades.length} lệnh đóng, ${riskPoolSkippedCount} lệnh bị bỏ qua (risk pool đầy), ${neutralGateRejectedCount} lệnh bị Momentum Gate từ chối (NEUTRAL_TRANSITION), balance cuối=$${accountBalance.toFixed(2)}`,
  );

  // TICKET-027 — điều tra riêng, không trộn vào backtest-report.md/backtest-trades.csv.
  const manipulatedLogPath = path.resolve(process.cwd(), 'data/manipulated-log.txt');
  writeFileSync(manipulatedLogPath, manipulatedLogLines.join('\n\n') + '\n');
  console.log(`→ ${manipulatedLogPath} (${manipulatedLogLines.length} lần MANIPULATED được xác nhận mới)`);

  // TICKET-033 — điều tra riêng, không trộn vào backtest-report.md/backtest-trades.csv.
  const dangerZoneLogPath = path.resolve(process.cwd(), 'data/danger-zone-log.txt');
  writeFileSync(dangerZoneLogPath, dangerZoneLogLines.join('\n\n') + '\n');
  console.log(`→ ${dangerZoneLogPath} (${dangerZoneLogLines.length} lần DANGER_ZONE được xác nhận mới)`);

  // TICKET-030: CORRELATED_RISK has no CLI on/off flag (unconditionally wired in, same pattern as
  // MANIPULATED/LOW_LIQUIDITY) — "-correlated" appended so this run's report/trades never overwrite
  // the pre-TICKET-030 both-momentum files (PM explicitly wants the $468.49 baseline preserved for comparison).
  const suffix = outputSuffix(macroTrendFilterEnabled, obDisabledSymbols, macroTrendFilterAppliesToBoxBreakout, momentumFilterEnabled, neutralTransitionEnabled) + '-correlated';
  const tradesPath = path.resolve(process.cwd(), `data/backtest-trades-${suffix}.csv`);
  writeFileSync(tradesPath, tradesCsv(trades));
  console.log(`→ ${tradesPath}`);

  const totalTrades = trades.length;
  const wins = trades.filter((t) => t.pnlUsd > 0).length;
  const winrate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const totalPnl = trades.reduce((sum, t) => sum + t.pnlUsd, 0);

  const report = [
    '# Backtest Report — TICKET-010',
    '',
    `Sinh tự động từ \`npm run backtest -- --entry-style=${entryStyleForNeutral} --tp-plan=${tpPlan} --macro-trend-filter=${macroTrendFilterEnabled} --ob-disabled-symbols=${obDisabledSymbols.join(',')} --macro-trend-box-breakout=${macroTrendFilterAppliesToBoxBreakout} --momentum-filter=${momentumFilterEnabled}\` — dữ liệu thật ${new Date().toISOString()}.`,
    '',
    `- Vốn ban đầu: $${START_BALANCE}, vốn cuối: $${accountBalance.toFixed(2)}`,
    `- Tổng số lệnh đóng: ${totalTrades}`,
    `- Winrate: ${winrate.toFixed(1)}%`,
    `- Tổng PNL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} USD`,
    `- Số lệnh bị bỏ qua vì risk pool đầy: ${riskPoolSkippedCount}`,
    `- Số lệnh bị Momentum Gate từ chối (NEUTRAL_TRANSITION, TICKET-036): ${neutralGateRejectedCount}`,
    '',
    statsTable('PNL theo symbol', groupBy(trades, (t) => t.symbol)),
    statsTable('PNL theo regime', groupBy(trades, (t) => t.regime)),
    statsTable('PNL theo setupType', groupBy(trades, (t) => t.setupType)),
    statsTable('PNL theo exitReason', groupBy(trades, (t) => t.exitReason)),
    statsTable(
      'PNL theo tháng',
      groupBy(trades, (t) => new Date(t.exitTimestamp).toISOString().slice(0, 7)),
      true,
    ),
    '',
    '## Cấu hình đã dùng',
    '',
    `- Position sizing: DynamicRMarginSizer, riskDollarOrPercent=20, maxMarginCap=50, leverage=30`,
    `- tpPlan: ${tpPlan}`,
    `- entryStyleForNeutral: ${entryStyleForNeutral}`,
    `- macroTrendFilterEnabled: ${macroTrendFilterEnabled} (TICKET-017 Phần A)`,
    `- obDisabledSymbols: [${obDisabledSymbols.join(',')}] (TICKET-017 Phần B)`,
    `- macroTrendFilterAppliesToBoxBreakout: ${macroTrendFilterAppliesToBoxBreakout} (TICKET-018)`,
    `- momentumFilterEnabled: ${momentumFilterEnabled} (TICKET-024, thresholds: low=${config.momentumFilterConfig.momentumLowThreshold} high=${config.momentumFilterConfig.momentumHighThreshold} lowMultiplier=${config.momentumFilterConfig.momentumLowMultiplier})`,
    `- neutralTransitionEnabled: ${neutralTransitionEnabled} (TICKET-036, hard Momentum Gate, threshold=${config.neutralTransitionGateConfig.neutralTransitionMomentumGateThreshold})`,
    `- riskPoolMaxPct: ${(riskPoolMaxPct * 100).toFixed(0)}% (TICKET-037, CLI-overridable, default 10%)`,
    `- mssStalenessToleranceCandles: ${config.entryRouterConfig.mssStalenessToleranceCandles} (TICKET-040, CLI-overridable, default 5)`,
    `- obBosLookforwardK: ${config.entryRouterConfig.obBosLookforwardK} (TICKET-041, CLI-overridable, default 10)`,
    `- Runner trailing: ATR (2.5×ATR), không dùng Structure trailing`,
    `- takerFeeRate: 0.0004 (TODO_CONFIRM — Trader chưa cung cấp số thật)`,
    `- Quy tắc SL/TP cùng nến: SL chạm trước`,
    `- Khớp lệnh tại entryPrice do Tầng 2 tính, không mô phỏng slippage/độ trễ`,
    '',
    `Chi tiết từng lệnh: \`data/backtest-trades-${suffix}.csv\`.`,
  ].join('\n');

  const reportPath = path.resolve(process.cwd(), `data/backtest-report-${suffix}.md`);
  writeFileSync(reportPath, report);
  console.log(`→ ${reportPath}`);
}

main().catch((err) => {
  console.error('backtest failed:', err);
  process.exit(1);
});
