/**
 * TICKET-057 — finds the biggest real price waves in the 180-day OHLCV data (Phần A), cross-checks
 * them against the confirmed baseline's actually-opened trades (Phần B), and for every MISSED wave,
 * traces back through the exact same Regime/Entry Funnel infrastructure already built in
 * TICKET-042 → 056 to report precisely which gate stopped it (Phần C).
 *
 * TICKET-058 — for EVERY one of the 60 waves (not just missed ones), measures how long TREND_RIDER
 * took to get CONFIRMED (post-hysteresis, same `regimeState.previousRegime` field Phần C already
 * reads) relative to each wave's start, reusing the exact same traced regime data — no new
 * regime/entry computation, only a new aggregation over data this file already produces.
 *
 * Pure observability: does NOT change any threshold/decision logic anywhere (in particular, does NOT
 * touch TICKET-014's ADX_PERSISTENCE_CANDLES=3 or any ADX threshold). Phần C re-runs the
 * confirmed-baseline simulation (same technique as simulateMssTimeoutOutcomes.ts, TICKET-045) purely
 * to CAPTURE the existing FunnelEvent/regime stream in more granular (per-candle, per-symbol) form
 * than backtest.ts's own aggregated stats — no new classification logic is introduced.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CandleData } from '../dist/regime/types.js';
import { MarketRegime } from '../dist/regime/types.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { processCandle, type ProcessCandleInput } from '../dist/orchestrator/orchestrator.js';
import { INITIAL_SYMBOL_STATE, type OrchestratorConfig, type OrchestratorEvent, type SymbolState } from '../dist/orchestrator/types.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG } from '../dist/entry/entryRouter.js';
import type { FunnelEvent } from '../dist/entry/types.js';
import { DEFAULT_MOMENTUM_FILTER_CONFIG, DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG, DEFAULT_PLAN_AUTO_SELECTION_CONFIG } from '../dist/xgbFilter/config.js';
import type { OpenPositionRisk } from '../dist/risk/riskPool.js';
import { percentile, STATE_FAIL_REGIMES } from './entryFunnelReport.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');

// TICKET-057 Phần A — TODO_CONFIRM (PM confirmed these defaults, 2026-07-22).
const WAVE_WINDOW_CANDLES = 48; // 4 tiếng / 5 phút
const WAVES_PER_SYMBOL = 15;
const MIN_GAP_MS = 24 * 60 * 60_000; // 24 tiếng — không đếm 2 lần cùng 1 đợt sóng kéo dài
const MATCH_WINDOW_MS = 2 * 60 * 60_000; // ±2 tiếng — Phần B đối chiếu lệnh thật

// TICKET-057 Phần B — same confirmed baseline trades file used throughout TICKET-052/054/055/056
// (--entry-style=SIDEWAY_STYLE --tp-plan=PLAN_A --macro-trend-filter=true --ob-disabled-symbols=XRPUSDT
// --macro-trend-box-breakout=false --momentum-filter=true --neutral-transition-enabled=true
// --risk-pool-max-pct=15 --neutral-gate-threshold=0.5 --plan-auto-selection-enabled=true).
const CONFIRMED_TRADES_CSV = path.resolve(process.cwd(), 'data/backtest-trades-both-momentum-neutral-planauto-correlated.csv');

// Same bounded sliding windows as backtest.ts — needed only for Phần C's traced re-run to reproduce
// byte-identical regime/funnel outcomes to the confirmed baseline.
const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;
const WINDOW_1H_MOMENTUM = 250;
const WINDOW_5M_SESSION_VOLUME = 14 * 288 + 1;

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

// ---- Phần A: find the biggest waves ----

interface Wave {
  symbol: string;
  startTimestamp: number;
  pctChange: number; // signed
  direction: 'LONG' | 'SHORT'; // giá tăng mạnh -> kỳ vọng LONG bắt được; giảm mạnh -> kỳ vọng SHORT
}

/**
 * Sliding 4h window % change, both directions, per symbol independently. Greedily takes the
 * strongest |%| candidates first, skipping any whose start is within MIN_GAP_MS of an
 * already-selected wave for this SAME symbol — so one long continuous move isn't counted twice.
 */
function findWavesForSymbol(symbol: string, candles5m: CandleData[]): Wave[] {
  const candidates: Wave[] = [];
  for (let i = 0; i + WAVE_WINDOW_CANDLES < candles5m.length; i++) {
    const startClose = candles5m[i].close;
    const endClose = candles5m[i + WAVE_WINDOW_CANDLES].close;
    const pctChange = ((endClose - startClose) / startClose) * 100;
    candidates.push({ symbol, startTimestamp: candles5m[i].timestamp, pctChange, direction: pctChange > 0 ? 'LONG' : 'SHORT' });
  }
  candidates.sort((a, b) => Math.abs(b.pctChange) - Math.abs(a.pctChange));

  const selected: Wave[] = [];
  for (const candidate of candidates) {
    if (selected.length >= WAVES_PER_SYMBOL) break;
    const tooClose = selected.some((w) => Math.abs(w.startTimestamp - candidate.startTimestamp) < MIN_GAP_MS);
    if (!tooClose) selected.push(candidate);
  }
  selected.sort((a, b) => a.startTimestamp - b.startTimestamp); // chronological, for readability in the report
  return selected;
}

// ---- Phần B: cross-check against actually-opened trades ----

interface Trade {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryTimestamp: number;
}

function readTradesCsv(filePath: string): Trade[] {
  const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
  return lines.slice(1).map((line) => {
    const cols = line.split(',');
    return { symbol: cols[0], side: cols[1] as 'LONG' | 'SHORT', entryTimestamp: Number(cols[5]) };
  });
}

function findMatchingTrade(wave: Wave, trades: Trade[]): Trade | undefined {
  return trades.find(
    (t) => t.symbol === wave.symbol && t.side === wave.direction && Math.abs(t.entryTimestamp - wave.startTimestamp) <= MATCH_WINDOW_MS,
  );
}

// ---- Phần C: trace back through Regime/Entry Funnel infrastructure for MISSED waves ----

interface TraceEntry {
  timestamp: number;
  confirmedRegime: MarketRegime | null;
  positionsOpenBeforeStep: number;
  funnelEvents: FunnelEvent[];
  orchestratorEvents: OrchestratorEvent[];
}

interface NeededWindow {
  symbol: string;
  startMs: number;
  endMs: number;
}

/**
 * PM-confirmed design (2026-07-22): across every candle in the ±2h matching window, report whichever
 * one progressed FURTHEST through the funnel (the "closest miss") — most informative for identifying
 * the real bottleneck, same "how far did it get" philosophy already used for MSS/SETUP breakdowns
 * (TICKET-043/054).
 */
function describeOutcome(entry: TraceEntry, maxConcurrentPositionsPerSymbol: number): { rank: number; description: string } {
  if (entry.confirmedRegime === null) {
    return { rank: -1, description: 'Regime chưa xác nhận (giai đoạn khởi động, chưa đủ lịch sử)' };
  }
  if ((STATE_FAIL_REGIMES as readonly MarketRegime[]).includes(entry.confirmedRegime)) {
    return { rank: 0, description: `Bị chặn bởi Regime: ${entry.confirmedRegime}` };
  }

  // STATE PASS từ đây trở xuống.
  if (entry.positionsOpenBeforeStep >= maxConcurrentPositionsPerSymbol) {
    return {
      rank: 1,
      description: `Regime cho phép (${entry.confirmedRegime}) nhưng đã đủ ${maxConcurrentPositionsPerSymbol} lệnh mở trên coin này — routeEntry() không được gọi (TICKET-056)`,
    };
  }

  if (entry.funnelEvents.length === 0) {
    return {
      rank: 2,
      description: `Regime cho phép (${entry.confirmedRegime}) nhưng routeEntry() không thử vào lệnh nào (thiếu dữ liệu đầu vào cho cascade — vd adxDirection1h chưa rõ hướng/FLAT (TICKET-055), hoặc thiếu bbWidthPercentile15m/volumeZScore5m)`,
    };
  }

  const lastFunnel = entry.funnelEvents[entry.funnelEvents.length - 1];
  const orchestratorOutcome = entry.orchestratorEvents.find((e) => e.type === 'OPEN' || e.type === 'SKIPPED');

  if (!orchestratorOutcome) {
    if (lastFunnel.stage === 'SETUP' && !lastFunnel.passed) {
      return { rank: 3, description: `Dừng ở SETUP FAIL (lý do: ${lastFunnel.reason ?? 'không xác định'})` };
    }
    if ((lastFunnel.stage === 'MACRO' || lastFunnel.stage === 'BREAKOUT') && !lastFunnel.passed) {
      return { rank: 5, description: `Qua SETUP, dừng ở ${lastFunnel.stage} FAIL (lý do: ${lastFunnel.reason ?? 'không xác định'})` };
    }
    if (lastFunnel.stage === 'MSS' && !lastFunnel.passed) {
      return { rank: 7, description: `Qua SETUP + MACRO, dừng ở MSS FAIL (lý do: ${lastFunnel.reason ?? 'không xác định'})` };
    }
    // Funnel's last event PASSED but no OPEN/SKIPPED followed — only possible if NEUTRAL_TRANSITION
    // gate is disabled (not the case in the confirmed baseline) or accountBalance <= 0.
    return {
      rank: 8,
      description: `Qua toàn bộ funnel (${lastFunnel.stage} PASS) nhưng không có event OPEN/SKIPPED nào tiếp theo (tài khoản cạn vốn, hoặc NEUTRAL_TRANSITION gate đang tắt)`,
    };
  }

  if (orchestratorOutcome.type === 'SKIPPED' && orchestratorOutcome.reason === 'NEUTRAL_GATE_REJECTED') {
    return { rank: 9, description: 'Qua SETUP + MACRO/BREAKOUT + MSS, bị AI Gate (Momentum Gate NEUTRAL_TRANSITION) từ chối' };
  }
  if (orchestratorOutcome.type === 'SKIPPED' && orchestratorOutcome.reason === 'RISK_POOL_EXCEEDED') {
    return { rank: 10, description: 'Qua mọi cửa tín hiệu, bị Risk Pool chặn (đã đủ risk trên tổng vốn)' };
  }
  if (orchestratorOutcome.type === 'OPEN') {
    return {
      rank: 11,
      description: `Có mở lệnh ${orchestratorOutcome.side} lúc ${new Date(entry.timestamp).toISOString()} — LƯU Ý: có thể khác chiều mong đợi của sóng này (xem lại Phần B)`,
    };
  }
  return { rank: 6, description: 'Không xác định' };
}

interface TrendRiderDelayResult {
  hasConfirmation: boolean;
  /** Minutes, signed — negative means TREND_RIDER was already confirmed BEFORE the wave's price-based start. Only set when hasConfirmation is true. */
  delayMinutes?: number;
}

/**
 * TICKET-058 — reuses the SAME trace entries Phần C already collected (confirmedRegime is
 * `regimeState.previousRegime`, i.e. already past hysteresis, not just candidateRegime) — no new
 * regime computation. Takes the EARLIEST TREND_RIDER-confirmed entry within the ±2h window as "the"
 * confirmation moment; if TREND_RIDER never appears in the window at all, this is reported as a
 * distinct "never recognized as trend" case, NOT folded into the delay distribution (PM's explicit instruction).
 */
function computeTrendRiderDelay(wave: Wave, trace: TraceEntry[]): TrendRiderDelayResult {
  const windowTrace = trace.filter((e) => Math.abs(e.timestamp - wave.startTimestamp) <= MATCH_WINDOW_MS);
  const trendRiderEntries = windowTrace.filter((e) => e.confirmedRegime === MarketRegime.TREND_RIDER);
  if (trendRiderEntries.length === 0) return { hasConfirmation: false };

  const earliest = trendRiderEntries.reduce((a, b) => (b.timestamp < a.timestamp ? b : a));
  return { hasConfirmation: true, delayMinutes: (earliest.timestamp - wave.startTimestamp) / 60_000 };
}

async function traceNeededWindows(neededWindows: NeededWindow[]): Promise<Map<string, TraceEntry[]>> {
  const traceBySymbol = new Map<string, TraceEntry[]>();
  for (const symbol of SYMBOLS) traceBySymbol.set(symbol, []);

  const symbolsData: Record<string, SymbolData> = {};
  for (const symbol of SYMBOLS) symbolsData[symbol] = loadSymbolData(symbol);

  // TICKET-057: byte-for-byte the confirmed baseline's OrchestratorConfig (README TICKET-052/056) —
  // needed so the regimeState/openPositions this loop threads evolves IDENTICALLY to the real
  // backtest run whose trades CSV Phần B already compared against.
  const config: OrchestratorConfig = {
    entryRouterConfig: {
      ...DEFAULT_ENTRY_ROUTER_CONFIG,
      entryStyleForNeutral: 'SIDEWAY_STYLE',
      macroTrendFilterEnabled: true,
      obDisabledSymbols: ['XRPUSDT'],
      macroTrendFilterAppliesToBoxBreakout: false,
    },
    tpPlan: 'PLAN_A',
    takerFeeRate: 0.0004,
    riskDollarOrPercent: 20,
    maxMarginCap: 50,
    leverage: 30,
    riskPoolMaxPct: 0.15,
    isLowConfidenceOrLowLiquidity: false,
    momentumFilterConfig: { ...DEFAULT_MOMENTUM_FILTER_CONFIG, momentumFilterEnabled: true },
    neutralTransitionGateConfig: { ...DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG, neutralTransitionTradingEnabled: true, neutralTransitionMomentumGateThreshold: 0.5 },
    planAutoSelectionConfig: { ...DEFAULT_PLAN_AUTO_SELECTION_CONFIG, planAutoSelectionEnabled: true, planAutoSelectionMomentumThreshold: 0.7 },
    maxConcurrentPositionsPerSymbol: 1,
    momentumDirectEnabled: false, // TICKET-059: confirmed baseline default — unchanged behavior.
    momentumDirectThreshold: 0.75,
  };

  let accountBalance = 400;
  const totalSteps = Math.min(...SYMBOLS.map((s) => symbolsData[s].candles5m.length));
  const startStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5;

  console.log(`[Phần C] Chạy lại simulation baseline (${totalSteps - startStep} bước x 4 coin) để trace ${neededWindows.length} cửa sổ cần điều tra...`);

  for (let step = startStep; step < totalSteps; step++) {
    const openRiskBySymbol: Record<string, number> = {};
    for (const symbol of SYMBOLS) {
      const totalRisk = symbolsData[symbol].state.openPositions.reduce((sum, entry) => sum + entry.meta.actualRiskDollar, 0);
      if (totalRisk > 0) openRiskBySymbol[symbol] = totalRisk;
    }

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

      const isNeeded = neededWindows.some((w) => w.symbol === symbol && currentCandle.timestamp >= w.startMs && currentCandle.timestamp <= w.endMs);

      const window5m = sd.candles5m.slice(Math.max(0, step - WINDOW_5M + 1), step + 1);
      const windowSessionVolume5m = sd.candles5m.slice(Math.max(0, step - WINDOW_5M_SESSION_VOLUME + 1), step + 1);
      const w15 = closedWindow(sd.candles15m, sd.ptr15m, 15 * 60_000, decisionTime, WINDOW_15M);
      sd.ptr15m = w15.ptr;
      const w1hMomentum = closedWindow(sd.candles1h, sd.ptr1h, 60 * 60_000, decisionTime, WINDOW_1H_MOMENTUM);
      const w1m = closedWindow(sd.candles1m, sd.ptr1m, 60_000, decisionTime, WINDOW_1M);
      sd.ptr1m = w1m.ptr;
      const w1d = closedWindow(sd.candles1d, sd.ptr1d, 24 * 60 * 60_000, decisionTime, WINDOW_1D);
      sd.ptr1d = w1d.ptr;

      const allOpenPositionsRisk: OpenPositionRisk[] = SYMBOLS.filter((s) => openRiskBySymbol[s] !== undefined).map((s) => ({
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
        allOpenPositionsRisk,
      };

      const positionsOpenBeforeStep = sd.state.openPositions.length;
      const funnelEventsThisStep: FunnelEvent[] = [];
      const result = await processCandle(input, sd.state, config, undefined, undefined, (_s, _t, e) => funnelEventsThisStep.push(e));
      sd.state = result.symbolState;
      accountBalance = result.accountBalance;

      if (isNeeded) {
        traceBySymbol.get(symbol)!.push({
          timestamp: currentCandle.timestamp,
          confirmedRegime: result.symbolState.regimeState.previousRegime,
          positionsOpenBeforeStep,
          funnelEvents: funnelEventsThisStep,
          orchestratorEvents: result.events,
        });
      }
    }
  }

  return traceBySymbol;
}

// ---- main ----

async function main(): Promise<void> {
  console.log('[Phần A] Đọc OHLCV 5m + tìm đợt sóng lớn (cửa sổ 4h, top 15/coin, cách nhau tối thiểu 24h)...');
  const wavesBySymbol: Record<string, Wave[]> = {};
  for (const symbol of SYMBOLS) {
    const candles5m = readCsv(path.join(OHLCV_DIR, `${symbol}_5m.csv`));
    wavesBySymbol[symbol] = findWavesForSymbol(symbol, candles5m);
  }
  const allWaves = SYMBOLS.flatMap((s) => wavesBySymbol[s]);
  console.log(`  -> tổng ${allWaves.length} đợt sóng (${WAVES_PER_SYMBOL}/coin x ${SYMBOLS.length} coin).`);

  console.log('[Phần B] Đối chiếu với lệnh thật đã mở (baseline đã chốt)...');
  const trades = readTradesCsv(CONFIRMED_TRADES_CSV);
  const results = allWaves.map((wave) => {
    const match = findMatchingTrade(wave, trades);
    return { wave, matched: match !== undefined };
  });
  const missed = results.filter((r) => !r.matched);
  console.log(`  -> BẮT ĐƯỢC: ${results.length - missed.length} / ${results.length}, BỎ LỠ: ${missed.length}`);

  // TICKET-058: needs trace data for ALL 60 waves now (not just the 59 missed ones), since the
  // TREND_RIDER-delay analysis below applies to every wave regardless of caught/missed status.
  console.log('[Phần C] Truy nguyên nhân chặn (sóng bỏ lỡ) + trace Regime cho toàn bộ 60 sóng (TICKET-058)...');
  const neededWindows: NeededWindow[] = results.map((r) => ({
    symbol: r.wave.symbol,
    startMs: r.wave.startTimestamp - MATCH_WINDOW_MS,
    endMs: r.wave.startTimestamp + MATCH_WINDOW_MS,
  }));
  const traceBySymbol = neededWindows.length > 0 ? await traceNeededWindows(neededWindows) : new Map<string, TraceEntry[]>();

  const rows = results.map(({ wave, matched }) => {
    const timeStr = new Date(wave.startTimestamp).toISOString();
    const pctStr = `${wave.pctChange >= 0 ? '+' : ''}${wave.pctChange.toFixed(2)}%`;
    const directionStr = wave.pctChange >= 0 ? 'TĂNG' : 'GIẢM';
    const resultStr = matched ? 'BẮT ĐƯỢC' : 'BỎ LỠ';

    let blockedAt = '';
    if (!matched) {
      const trace = (traceBySymbol.get(wave.symbol) ?? []).filter((e) => Math.abs(e.timestamp - wave.startTimestamp) <= MATCH_WINDOW_MS);
      if (trace.length === 0) {
        // Xác nhận qua điều tra: các đợt sóng ở đây đều xảy ra TRƯỚC startStep của backtest (chưa đủ
        // lịch sử để detectRegime() chạy) — không phải bug ở findMissedWaves.ts, mà là hạn chế cấu
        // trúc thật: bot chưa "khởi động" kịp để giao dịch trong giai đoạn này của dữ liệu 180 ngày.
        blockedAt = 'Sóng xảy ra TRƯỚC khi backtest đủ lịch sử để bắt đầu giao dịch (giai đoạn khởi động detectRegime())';
      } else {
        const described = trace.map((e) => describeOutcome(e, 1));
        const best = described.reduce((a, b) => (b.rank > a.rank ? b : a));
        blockedAt = best.description;
      }
    }

    return `| ${wave.symbol} | ${timeStr} | ${pctStr} | ${directionStr} | ${resultStr} | ${blockedAt} |`;
  });

  // TICKET-058 — TREND_RIDER confirmation delay vs. each wave's price-based start.
  console.log('[TICKET-058] Đo độ trễ xác nhận TREND_RIDER so với lúc sóng bắt đầu...');
  const delayResults = results.map(({ wave }) => ({
    wave,
    delay: computeTrendRiderDelay(wave, traceBySymbol.get(wave.symbol) ?? []),
  }));
  const withConfirmation = delayResults.filter((r) => r.delay.hasConfirmation);
  const withoutConfirmation = delayResults.filter((r) => !r.delay.hasConfirmation);
  const sortedDelays = withConfirmation.map((r) => r.delay.delayMinutes as number).sort((a, b) => a - b);

  const delayDistributionRows =
    sortedDelays.length > 0
      ? [
          `| min | ${sortedDelays[0].toFixed(1)} |`,
          `| p25 | ${percentile(sortedDelays, 25).toFixed(1)} |`,
          `| p50 (median) | ${percentile(sortedDelays, 50).toFixed(1)} |`,
          `| p75 | ${percentile(sortedDelays, 75).toFixed(1)} |`,
          `| max | ${sortedDelays[sortedDelays.length - 1].toFixed(1)} |`,
        ]
      : ['| (không có đợt sóng nào có TREND_RIDER xác nhận trong ±2h) | — |'];

  const delayDetailRows = delayResults.map(({ wave, delay }) => {
    const timeStr = new Date(wave.startTimestamp).toISOString();
    const hasStr = delay.hasConfirmation ? 'CÓ' : 'KHÔNG';
    const delayStr = delay.hasConfirmation ? (delay.delayMinutes as number).toFixed(1) : '—';
    return `| ${wave.symbol} | ${timeStr} | ${hasStr} | ${delayStr} |`;
  });

  const report = [
    '# TICKET-057 — Tìm đợt sóng lớn bị bỏ lỡ + truy nguyên nhân chặn',
    '',
    'Công cụ quan sát (observability) — không đổi bất kỳ ngưỡng/logic quyết định nào. Số liệu nguyên văn, không tự kết luận.',
    '',
    `Tham số dùng (PM xác nhận 2026-07-22): cửa sổ tính sóng = 4 tiếng, số lượng = ${WAVES_PER_SYMBOL} đợt/coin (${SYMBOLS.length * WAVES_PER_SYMBOL} tổng), khoảng cách tối thiểu giữa 2 đợt sóng cùng coin = 24 tiếng, cửa sổ đối chiếu lệnh thật = ±2 tiếng. Đối chiếu với \`${path.basename(CONFIRMED_TRADES_CSV)}\` (baseline đã chốt: risk-pool-max-pct=15%, plan-auto-selection-enabled=true, và mọi config khác đã chốt tính đến TICKET-056).`,
    '',
    `- Tổng số đợt sóng: ${results.length}`,
    `- BẮT ĐƯỢC: ${results.length - missed.length}`,
    `- BỎ LỠ: ${missed.length}`,
    '',
    '"Cửa chặn cuối cùng" (Phần C) chọn theo nến tiến XA NHẤT trong funnel trong toàn bộ cửa sổ ±2h quanh',
    'thời điểm bắt đầu sóng (PM xác nhận) — cho biết nút thắt thật sự gần với việc mở lệnh nhất.',
    '',
    '| Symbol | Thời điểm | % sóng | Chiều | Kết quả | Cửa chặn cuối cùng (nếu bỏ lỡ) |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    '## Độ trễ xác nhận TREND_RIDER so với lúc sóng bắt đầu (TICKET-058)',
    '',
    'Công cụ quan sát — không đổi ADX_PERSISTENCE_CANDLES, ngưỡng ADX, hay bất kỳ logic Regime/Entry nào.',
    'Tái sử dụng đúng dữ liệu regime đã trace ở trên (Phần C), không tính toán lại từ đầu.',
    '',
    `- Số đợt sóng có TREND_RIDER xác nhận trong ±2h: ${withConfirmation.length} / ${results.length}`,
    `- Số đợt sóng KHÔNG BAO GIỜ có TREND_RIDER xác nhận trong ±2h: ${withoutConfirmation.length} / ${results.length}`,
    '',
    '### Phân phối độ trễ (chỉ tính các đợt CÓ xác nhận, đơn vị phút)',
    '',
    '| Thống kê | Giá trị |',
    '|---|---|',
    ...delayDistributionRows,
    '',
    '### Chi tiết từng đợt sóng',
    '',
    '| Symbol | Thời điểm sóng | TREND_RIDER trong ±2h? | Độ trễ (phút) |',
    '|---|---|---|---|',
    ...delayDetailRows,
  ].join('\n');

  const reportPath = path.resolve(process.cwd(), 'data/missed-waves-report.md');
  writeFileSync(reportPath, report + '\n');
  console.log(`→ ${reportPath}`);
}

main().catch((err) => {
  console.error('findMissedWaves failed:', err);
  process.exit(1);
});
