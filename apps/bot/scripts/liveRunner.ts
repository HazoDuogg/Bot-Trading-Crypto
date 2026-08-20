import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { LiveCandleFeed, type CandleData } from '../dist/live/liveCandleFeed.js';
import { assessCandleFreshnessForSymbol, hasAnyStaleRequiredTimeframe } from '../dist/live/candleFreshnessGate.js';
import { BinanceOrderExecutor, initializeLeverageForSymbols, type PositionSide } from '../dist/live/binanceOrderExecutor.js';
import { StateReconciler, resolveAccountBalanceAfterReconcile, type InternalStateSnapshot } from '../dist/live/stateReconciler.js';
import {
  computeQuantityTolerance,
  cancelAlgoOrderIdempotent,
  reconcileExternalPositionClose,
  ReconcileGuard,
  performStartupRestartRecovery,
  readLiveStateFileSafe,
  verifyProtectiveSlOrder,
  verifyProtectiveTpOrder,
  DEFAULT_POSITION_MODE,
  PROTECTIVE_SL_ORDER_TYPES,
  recoverMissingProtectiveSl,
  DEFAULT_MISSING_PROTECTIVE_SL_FAILSAFE_POLICY,
  checkMergedPositionAllocation,
  createSingleFlightRunner,
  isFreshnessEvidenceStale,
  captureCoherentReconciliationSnapshotWithRetry,
  runProtectiveOrderMonitorSweep,
  decideSideRecovery,
  buildDeterministicEntryClientOrderId,
  type AccountSyncState,
  type MissingProtectiveSlFailsafePolicy,
  type ProtectiveMonitorPositionInput,
  type FreshnessEvidence,
  type CoherentReconciliationSnapshotResult,
  type PendingEntryQuarantineRecord,
  type QuarantineExposureBasis,
} from '../dist/live/liveStateSync.js';
import { parseLiveFixedRiskUsd } from '../dist/live/liveRiskConfig.js';
import {
  handleOpenEvent as lifecycleHandleOpenEvent,
  handlePartialCloseEvent as lifecycleHandlePartialCloseEvent,
  handleCloseEvent as lifecycleHandleCloseEvent,
  createPersistLiveState,
  createRecordPendingEntryQuarantine,
  foldPendingEntryQuarantinesOnRestart,
  applyAmbiguousOpenOutcome,
  handleOpenEventIfFresh,
  roundQty,
  roundPrice,
  type LiveOrderIds,
  type OpenEventOutcome,
  type LifecycleContext,
  type RunnerStateAccess,
} from '../dist/live/liveLifecycle.js';
import {
  syncBalanceForTelegramEvent,
  parseExchangeBalanceSnapshot,
  formatBalanceDivergenceIncidentLog,
  formatBalanceDivergenceTelegramWarning,
  type ExchangeBalanceSnapshot,
} from '../dist/live/liveBalanceSync.js';
import { loadBinanceEnvConfig } from '../dist/live/envConfig.js';
import { ExecutionTelemetry, stableTelemetryId, type TelemetryEventDraft } from '../dist/live/executionTelemetry.js';
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
import {
  reconstructRegimeStatesAcrossSymbols,
  decideRegimeStateSource,
  formatRegimeReconstructionLog,
  RECON_REQUIRED_5M,
  RECON_REQUIRED_15M,
  RECON_REQUIRED_1H,
  type SymbolCandleHistory,
} from '../dist/live/regimeStateReconstruction.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG } from '../dist/entry/entryRouter.js';
import { DEFAULT_MOMENTUM_FILTER_CONFIG, DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG, DEFAULT_PLAN_AUTO_SELECTION_CONFIG } from '../dist/xgbFilter/config.js';
import { loadTelegramConfig } from '../dist/telegram/telegramClient.js';
import { TelegramMessageQueue } from '../dist/telegram/messageQueue.js';
import { SentEventTracker } from '../dist/telegram/dedupe.js';
import {
  formatBotStartMessage,
  formatRegimeChangeMessage,
  formatHtfContextChangeMessage,
  formatSafetyState5mChangeMessage,
  formatSafetyState5mStabilizedChangeMessage,
  formatMomentumContextDecisionMessage,
} from '../dist/telegram/messageFormatters.js';
import { computeCurrentPositionRisk, rebuildPortfolioRisk, type KnownPositionForRisk, type UnknownExposureForRisk } from '../dist/risk/currentRisk.js';
import { LIVE_SYMBOL_UNIVERSE } from './liveSymbolUniverse.js';

// Mutable copy of the frozen authoritative list — several pre-existing APIs below (loadExchangeInfo,
// initializeLeverageForSymbols, LiveCandleFeed's `symbols` option, etc.) require a plain `string[]`
// parameter; LIVE_SYMBOL_UNIVERSE itself stays readonly/frozen so it can never be mutated in place.
const SYMBOLS: string[] = [...LIVE_SYMBOL_UNIVERSE];
const EXECUTION_TELEMETRY_ENABLED = process.env.EXECUTION_TELEMETRY_ENABLED === 'true';
const TICK_INTERVAL_MS = 5_000; // how often we check "has a new 5m candle closed" — cheap, reads already-polled in-memory buffers only
// TICKET-G1R-B (Runtime Wiring Pass) item 1 — in-run protective-order (SL/TP) monitor interval. NOT
// the 5s tick loop (polling protective orders that often would burn rate-limit budget for no benefit)
// — same order of magnitude as stateReconciler.ts's own DEFAULT_INTERVAL_MS (7 min), chosen at the
// tighter end of the ticket's suggested 2-5 minute band since a naked position is the highest-severity
// failure mode this ticket addresses.
const ACCOUNT_SYNC_CYCLE_INTERVAL_MS = 5 * 60_000;

// TICKET-124 — feature flag for TICKET-123's chosen production improvement
const OOD_GUARD_ENABLED = process.env.OOD_GUARD_ENABLED === 'true';
// TICKET-G1R-A item 1 — default OPERATOR_REQUIRED per the ticket's own explicit guidance (safer:
// never auto-closes a real position without a human). Set MISSING_PROTECTIVE_SL_FAILSAFE_POLICY=
// EMERGENCY_CLOSE in the environment to opt into automatic market-close on exhausted SL recovery.
const MISSING_PROTECTIVE_SL_FAILSAFE_POLICY: MissingProtectiveSlFailsafePolicy =
  process.env.MISSING_PROTECTIVE_SL_FAILSAFE_POLICY === 'EMERGENCY_CLOSE' ? 'EMERGENCY_CLOSE' : DEFAULT_MISSING_PROTECTIVE_SL_FAILSAFE_POLICY;
const HTF_SAFETY_SPLIT_DIAGNOSTIC_ENABLED = process.env.HTF_SAFETY_SPLIT_DIAGNOSTIC_ENABLED === 'true';
const SAFETY_STATE_5M_STABILIZATION_ENABLED = process.env.SAFETY_STATE_5M_STABILIZATION_ENABLED === 'true';
const OOD_GUARD_EMA_RATIO_SLOW_THRESHOLD = 1.037776; // Bearish TRAIN-split P97.5, TICKET-122/123
const OOD_GUARD_RISK_REDUCTION_MULTIPLIER = 0.3; // TICKET-122/123 Risk Reduction P97.5 variant
const LIVE_FIXED_RISK_USD = parseLiveFixedRiskUsd(process.env.LIVE_FIXED_RISK_USD);

// Official confirmed live config — TICKET-084/085's 8-flag baseline + risk-dollar-or-percent=15/
const CONFIG: OrchestratorConfig = {
  entryRouterConfig: { ...DEFAULT_ENTRY_ROUTER_CONFIG, obSlBufferAtrMultiplier: 0.87, macroTrendFilterEnabled: true },
  tpPlan: 'PLAN_A',
  takerFeeRate: 0.0004,
  riskDollarOrPercent: LIVE_FIXED_RISK_USD,
  maxMarginCap: 37.5,
  leverage: 30,
  riskPoolMaxPct: 0.15,
  isLowConfidenceOrLowLiquidity: false,
  momentumFilterConfig: DEFAULT_MOMENTUM_FILTER_CONFIG,
  neutralTransitionGateConfig: DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG,
  planAutoSelectionConfig: { ...DEFAULT_PLAN_AUTO_SELECTION_CONFIG, planAutoSelectionEnabled: true },
  maxConcurrentPositionsPerSymbol: 1,
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
  momentumContextDecisionMatrixV2Enabled: true,
};

const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;
const WINDOW_1H_MOMENTUM = 500;

interface RunnerSymbolState {
  symbolState: SymbolState;
  lastProcessedCandleTimestamp: number | null;
  // keyed by entryTimestamp (unique per position within a symbol, same key style as PartialCloseEvent dedupe) — see dedupe note in the tick loop.
  orderIds: Map<number, LiveOrderIds>;
}

async function main(): Promise<void> {
  const envConfig = loadBinanceEnvConfig(); // prints the required MAINNET/TESTNET banner
  const envLabel = envConfig.env; // 'testnet' | 'mainnet'
  const dryRun = process.argv.includes('--dry-run=false') ? false : true; // default true, NEVER default false — TICKET-086's hard rule
  console.log(`dryRun=${dryRun}${dryRun ? ' (KHÔNG gọi API đặt lệnh thật — chỉ log)' : ' !!! SẼ ĐẶT LỆNH THẬT !!!'}`);

  const EXECUTION_TELEMETRY_ROOT_DIR = path.resolve(process.cwd(), process.env.EXECUTION_TELEMETRY_DIR ?? 'data/live-telemetry');
  if (envConfig.env === 'mainnet' && dryRun === false) {
    if (!EXECUTION_TELEMETRY_ENABLED) {
      throw new Error('liveRunner: EXECUTION_TELEMETRY_ENABLED phải =true khi ENV=mainnet và dryRun=false — dừng khởi động, KHÔNG giao dịch mainnet thật mà không có telemetry.');
    }
    try {
      mkdirSync(EXECUTION_TELEMETRY_ROOT_DIR, { recursive: true });
      const probePath = path.join(EXECUTION_TELEMETRY_ROOT_DIR, `.telemetry-write-probe-${process.pid}-${Date.now()}`);
      const probeFd = openSync(probePath, 'w');
      writeSync(probeFd, Buffer.from('probe', 'utf8'));
      closeSync(probeFd);
      unlinkSync(probePath);
    } catch (err) {
      throw new Error(`liveRunner: thư mục telemetry root (${EXECUTION_TELEMETRY_ROOT_DIR}) không tạo/ghi được (${(err as Error).message}) — dừng khởi động, KHÔNG giao dịch mainnet thật mà không có telemetry khả dụng.`);
    }
  }

  let telemetryFailureBlockingAdmission = false;
  const pendingTelemetryAlerts: string[] = [];
  let dispatchTelemetryAlert: (message: string) => void = (message) => { pendingTelemetryAlerts.push(message); };
  const telemetry = new ExecutionTelemetry({
    enabled: EXECUTION_TELEMETRY_ENABLED,
    rootDir: EXECUTION_TELEMETRY_ROOT_DIR,
    strategyVersion: 'current-production-t152-semantics',
    configHash: createHash('sha256').update(JSON.stringify(CONFIG)).digest('hex'),
    modelVersion: 'xgb-momentum-v1',
    maxQueueSize: Number(process.env.EXECUTION_TELEMETRY_MAX_QUEUE ?? 5000),
    maxFileBytes: Number(process.env.EXECUTION_TELEMETRY_MAX_FILE_BYTES ?? 25 * 1024 * 1024),
    retentionDays: Number(process.env.EXECUTION_TELEMETRY_RETENTION_DAYS ?? 90),
    onHealthAlert: (message) => {
      telemetryFailureBlockingAdmission = true;
      console.error(`[TELEMETRY_HEALTH] ${message}`);
      dispatchTelemetryAlert(`🚨🚨 [CRITICAL — TELEMETRY LỖI] ${message}\nĐÃ CHẶN mở lệnh mới TOÀN BỘ portfolio cho tới khi khắc phục — các vị thế đang mở vẫn được quản lý bình thường.`);
    },
  });
  const emitTelemetry = (event: TelemetryEventDraft): void => { telemetry.emit(event); };
  console.log(`executionTelemetry=${EXECUTION_TELEMETRY_ENABLED ? `ENABLED session=${telemetry.getSessionId()}` : 'DISABLED'}`);

  const executor = new BinanceOrderExecutor({
    credentials: { apiKey: envConfig.apiKey, apiSecret: envConfig.apiSecret, baseUrl: envConfig.baseUrl },
    dryRun,
    onOrderFailure: (context, err) => console.error(`[ORDER_FAILURE] ${context}: ${err.message}`),
    onOrderCountUpdate: (c10s, l10s, c1m, l1m) => {
      if (c10s / l10s > 0.8 || c1m / l1m > 0.8) console.warn(`[ORDERS rate cảnh báo] 10s=${c10s}/${l10s}, 1m=${c1m}/${l1m}`);
    },
  });
  await executor.syncClock();
  await executor.loadExchangeInfo(SYMBOLS);
  console.log(`exchangeInfo (LOT_SIZE/PRICE_FILTER/MIN_NOTIONAL) đã tải cho ${SYMBOLS.length} coin.`);
  const reconcilerQuantityTolerance = computeQuantityTolerance(Math.max(...SYMBOLS.map((s) => executor.getSymbolFilters(s).stepSize)));
  // TICKET-G1R Checkpoint C — real per-symbol tolerance for the ownership-proof check in
  // performStartupRestartRecovery() below (unlike reconcilerQuantityTolerance above, which is
  // deliberately the coarsest bound across all 4 symbols for stateReconciler.ts's single-scalar API).
  const quantityToleranceBySymbol: Record<string, number> = Object.fromEntries(SYMBOLS.map((s) => [s, computeQuantityTolerance(executor.getSymbolFilters(s).stepSize)]));

  // TICKET-100: CHỦ ĐỘNG đặt đúng CONFIG.leverage cho cả 4 symbol — không tin tưởng cấu hình có sẵn
  // trên sàn (có thể lệch, gây sai risk$ thật ở mọi phép tính size sau này). "Đang có vị thế mở" ->
  // cảnh báo + tiếp tục (không crash); lỗi khác -> dừng khởi động (initializeLeverageForSymbols ném lại).
  await initializeLeverageForSymbols(executor, SYMBOLS, CONFIG.leverage);

  // TICKET-G1R-A "Final Internal Closure" item 1 — exchange-authoritative balance lifecycle.
  //
  // INVARIANT: `accountBalance` is a CACHE of the latest exchange-authoritative wallet balance, and
  // `accountBalanceKnown` is false until a real exchange read has been PARSED and APPLIED. No
  // admission may run while it is false. There is no simulated/default/$100 starting value anywhere
  // in this path — the startup read below throws rather than inventing one.
  //
  // ANTI-TIME-TRAVEL: every observation carries capturedAt/source/requestId (same shape as
  // liveStateSync.ts's DataSourceRead). An observation OLDER than the one currently held is
  // rejected — otherwise a slow event-time read could clobber a newer periodic-snapshot value.
  interface BalanceObservation {
    walletBalance: number;
    capturedAt: number;
    source: string;
    requestId: string;
  }
  let accountBalance = 0;
  let accountBalanceKnown = false;
  let lastSuccessfulBalanceReadMs: number | null = null;
  let currentBalanceObservation: BalanceObservation | null = null;
  let balanceObservationCounter = 0;

  /**
   * The ONLY place `accountBalance` is set from an exchange read. Applies value + provenance +
   * freshness timestamp ATOMICALLY (the pre-fix bug set the freshness timestamp on a validated
   * snapshot while never applying the snapshot's balance VALUE, so "fresh" could describe a stale
   * number). Returns false when the observation was rejected as out-of-order — in which case
   * NOTHING is mutated, including `lastSuccessfulBalanceReadMs`.
   */
  function applyBalanceObservation(obs: BalanceObservation): boolean {
    if (currentBalanceObservation !== null && obs.capturedAt < currentBalanceObservation.capturedAt) {
      console.warn(
        `[BALANCE_OBSERVATION_STALE_IGNORED] bỏ qua quan sát balance CŨ HƠN giá trị đang giữ: ` +
        `source=${obs.source} capturedAt=${obs.capturedAt} < đang giữ source=${currentBalanceObservation.source} capturedAt=${currentBalanceObservation.capturedAt}`,
      );
      return false;
    }
    currentBalanceObservation = obs;
    accountBalance = obs.walletBalance;
    accountBalanceKnown = true;
    lastSuccessfulBalanceReadMs = obs.capturedAt;
    return true;
  }

  /** Parses a raw getAccountInfo() payload with the single canonical parser and applies it. Returns null (and touches nothing) on a parse failure — a failed parse must NEVER be marked fresh. */
  function parseAndApplyBalance(raw: unknown, source: string, capturedAt: number): BalanceObservation | null {
    try {
      const snapshot = parseExchangeBalanceSnapshot(raw, capturedAt);
      balanceObservationCounter += 1;
      const obs: BalanceObservation = { walletBalance: snapshot.walletBalance, capturedAt, source, requestId: `bal-${capturedAt}-${balanceObservationCounter}` };
      return applyBalanceObservation(obs) ? obs : null;
    } catch (err) {
      console.error(`[BALANCE_PARSE_FAILED] source=${source}: ${(err as Error).message} — KHÔNG cập nhật accountBalance, KHÔNG đánh dấu fresh.`);
      return null;
    }
  }

  const startupBalanceRaw = await executor.getAccountInfo();
  const startupBalanceObs = parseAndApplyBalance(startupBalanceRaw, 'startup:getAccountInfo', Date.now());
  if (startupBalanceObs === null) {
    throw new Error('liveRunner: không parse được balance hợp lệ từ getAccountInfo() lúc khởi động — dừng, KHÔNG dùng giá trị mặc định nào.');
  }
  if (startupBalanceObs.walletBalance <= 0) {
    throw new Error(`liveRunner: totalWalletBalance từ sàn = ${startupBalanceObs.walletBalance} (<= 0) — dừng khởi động.`);
  }
  console.log(`Vốn hiện tại (từ sàn): $${startupBalanceObs.walletBalance.toFixed(2)} (source=${startupBalanceObs.source})`);

  const telegramConfig = loadTelegramConfig();
  const telegramQueue = new TelegramMessageQueue(telegramConfig);
  dispatchTelemetryAlert = (message) => telegramQueue.enqueue(message);
  for (const message of pendingTelemetryAlerts.splice(0)) telegramQueue.enqueue(message);

  // TICKET-G1R Checkpoint C (G1-F14) — restart persistence + startup reconciliation. Runs BEFORE
  // the candle feed / tick loop start below so no candle is ever processed against an unreconciled
  // guess of what's open. Never assumes "clean start": always reads real exchange positions and
  // combines them with whatever was persisted from the LAST run (schemaVersioned JSON file, written
  // atomically — see liveStateSync.ts's writeLiveStateFileAtomic/readLiveStateFileSafe). A persisted
  // position is only recovered when the exchange's own qty for that symbol+side proves ownership
  // (matches within a stepSize-based tolerance); anything else is quarantined, never auto-adopted.
  const LIVE_STATE_FILE_PATH = path.resolve(process.cwd(), process.env.LIVE_STATE_FILE ?? 'data/live-state/positions-state.json');
  const persistedLiveState = readLiveStateFileSafe(LIVE_STATE_FILE_PATH);
  if (persistedLiveState.status === 'CORRUPT') {
    console.error(
      `[LIVE_STATE_CORRUPT] file trạng thái persisted lỗi/hỏng (${LIVE_STATE_FILE_PATH}): ${persistedLiveState.error} — coi như KHÔNG có persisted state; mọi vị thế trên sàn không chứng minh được ownership sẽ bị quarantine.`,
    );
  }
  console.log(`[LIVE_STATE] persisted=${persistedLiveState.status}${persistedLiveState.status === 'OK' ? ` (savedAtMs=${new Date(persistedLiveState.file.savedAtMs).toISOString()})` : ''}`);

  const restartRecovery = await performStartupRestartRecovery({
    executor,
    symbols: SYMBOLS,
    persisted: persistedLiveState,
    quantityToleranceBySymbol,
    initialSymbolState: INITIAL_SYMBOL_STATE,
  });
  if (!restartRecovery.ok) {
    // Fail-safe per the ticket's explicit rule: never proceed to trade with an unknown state. This
    // aborts startup entirely (main().catch() below logs + process.exit(1)) rather than starting a
    // "silently inert" process that looks alive but can never trade — simpler to operate/monitor and
    // impossible to mistake for a working bot.
    throw new Error(`liveRunner: đối soát khởi động (restart recovery) thất bại — dừng khởi động, KHÔNG giao dịch với trạng thái chưa xác định. ${restartRecovery.reason}`);
  }

  const runnerState: Record<string, RunnerSymbolState> = {};
  const entriesBlockedDueToRestartQuarantineBySymbol = new Set<string>();
  const symbolsBlockedDueToIncomeReconciliation = new Set<string>();
  let pendingEntryQuarantinesBySymbol: Record<string, PendingEntryQuarantineRecord[]> =
    persistedLiveState.status === 'OK' ? { ...(persistedLiveState.file.pendingEntryQuarantines ?? {}) } : {};
  const restartFold = foldPendingEntryQuarantinesOnRestart(pendingEntryQuarantinesBySymbol);
  const quarantinedUnknownExposures: UnknownExposureForRisk[] = [...restartFold.quarantinedUnknownExposures];
  for (const { symbol, recordCount } of restartFold.blockedSymbols) {
    entriesBlockedDueToRestartQuarantineBySymbol.add(symbol);
    console.error(`[PENDING_ENTRY_QUARANTINE_RESTART] ${symbol}: ${recordCount} AMBIGUOUS entry record(s) từ phiên trước chưa được giải quyết — chặn mở lệnh mới trên ${symbol} cho tới khi kiểm tra thủ công.`);
    telegramQueue.enqueue(`⚠️ [PENDING_RECONCILIATION] ${symbol}: có ${recordCount} lệnh MARKET AMBIGUOUS từ phiên trước chưa giải quyết — ĐÃ CHẶN mở lệnh mới trên ${symbol}.`);
  }
  const restartRecoverySummaryLines: string[] = [];
  for (const outcome of restartRecovery.symbols) {
    runnerState[outcome.symbol] = { symbolState: outcome.symbolState, lastProcessedCandleTimestamp: null, orderIds: new Map(outcome.orderIds) };
    for (const side of outcome.sideOutcomes) {
      if (side.status === 'CLEAN') continue; // not worth a startup log line per symbol×side×4
      console.log(`[RESTART_RECOVERY] ${outcome.symbol} ${side.side}: ${side.status} — ${side.detail}`);
      restartRecoverySummaryLines.push(`${outcome.symbol} ${side.side}: ${side.status}`);
    }
    if (outcome.blockEntries) {
      entriesBlockedDueToRestartQuarantineBySymbol.add(outcome.symbol);
      const quarantinedSides = outcome.sideOutcomes.filter((s) => s.status === 'QUARANTINED');
      const quarantineDetail = quarantinedSides.map((s) => `${s.side}: ${s.detail}`).join(' | ');
      console.error(`[RESTART_RECOVERY_QUARANTINE] ${outcome.symbol}: PENDING_RECONCILIATION — chặn mở lệnh mới trên ${outcome.symbol} cho tới khi kiểm tra thủ công. ${quarantineDetail}`);
      telegramQueue.enqueue(`⚠️ [PENDING_RECONCILIATION] ${outcome.symbol} lúc khởi động: ${quarantineDetail}\nĐÃ CHẶN mở lệnh mới trên ${outcome.symbol} — cần kiểm tra thủ công.`);

      const persistedFileForExposure = persistedLiveState.status === 'OK' ? persistedLiveState.file : null;
      for (const s of quarantinedSides) {
        const lastKnown = (persistedFileForExposure?.symbols[outcome.symbol]?.symbolState.openPositions ?? []).filter((e) => e.position.side === s.side);
        if (lastKnown.length === 0) {
          quarantinedUnknownExposures.push({ id: `${outcome.symbol}:${s.side}:QUARANTINED`, basis: null });
        } else {
          for (const [idx, e] of lastKnown.entries()) {
            quarantinedUnknownExposures.push({
              id: `${outcome.symbol}:${s.side}:QUARANTINED:${idx}`,
              basis: { side: e.position.side, entryPrice: e.position.entryPrice, currentSlPrice: e.position.currentSlPrice, remainingPositionSize: e.position.remainingPositionSize },
            });
          }
        }
      }
    }
  }
  if (quarantinedUnknownExposures.length > 0) {
    // TICKET-G1R Checkpoint D (G1-F04) — visibility only: the REAL current risk ledger (known
    // positions across all 4 symbols, rebuilt fresh, plus every quarantined UNKNOWN_EXPOSURE found
    // above) so an operator can see the honest total the admission block below is protecting against,
    // not just "some symbol is quarantined".
    const knownAtStartup: KnownPositionForRisk[] = SYMBOLS.flatMap((s) => runnerState[s].symbolState.openPositions.map((e) => ({ id: s, basis: e.position })));
    const startupLedger = rebuildPortfolioRisk({ knownPositions: knownAtStartup, unknownExposures: quarantinedUnknownExposures });
    console.error(
      `[RISK_LEDGER_UNKNOWN_EXPOSURE] totalRiskDollar(known+quarantined)=${startupLedger.totalRiskDollar.toFixed(4)} hasUnquantifiableExposure=${startupLedger.hasUnquantifiableExposure} entries=${JSON.stringify(startupLedger.entries)}`,
    );
  }

  let livePersistFailureBlockingAdmission = false;

  const persistLiveState = createPersistLiveState({
    filePath: LIVE_STATE_FILE_PATH,
    symbols: SYMBOLS,
    getSymbolStateForPersist: (s) => ({
      symbolState: runnerState[s].symbolState,
      orderIds: Array.from(runnerState[s].orderIds.entries()),
      regimeStateCandleTimestamp: runnerState[s].lastProcessedCandleTimestamp,
    }),
    getPendingEntryQuarantinesBySymbol: () => pendingEntryQuarantinesBySymbol,
    enqueueTelegram: (msg) => telegramQueue.enqueue(msg),
    onPersistFailure: (failed) => { livePersistFailureBlockingAdmission = failed; },
  });
  persistLiveState(); // immediately overwrite a missing/corrupt file with the just-recovered, trusted state

  function buildPendingEntryQuarantineRecord(input: {
    symbol: string;
    side: PositionSide;
    phase: PendingEntryQuarantineRecord['phase'];
    clientOrderId: string;
    orderId: number | null;
    executedQty: number | null;
    averageFillPrice: unknown;
    plannedEntryPrice: number;
    plannedSlPrice: number;
    entryTimestamp: number;
    reason: string;
    reconciledEntryPrice: number | null;
    reconciledPositionSize: number | null;
    protectionOutcome: string | null;
    actualRiskDollar: number | null;
    marginRequired: number | null;
    protectionStatus: string | null;
    recoveryStatus: string | null;
    recoveryDetail: string | null;
    exposureBasis: QuarantineExposureBasis | null;
  }): PendingEntryQuarantineRecord {
    return { ...input, detectedAtMs: Date.now() };
  }

  const recordPendingEntryQuarantine = createRecordPendingEntryQuarantine({
    blockSymbolAdmission: (s) => { entriesBlockedDueToRestartQuarantineBySymbol.add(s); },
    getPendingEntryQuarantinesBySymbol: () => pendingEntryQuarantinesBySymbol,
    setPendingEntryQuarantinesBySymbol: (next) => { pendingEntryQuarantinesBySymbol = next; },
    persistLiveState,
  });

  // TICKET-G1R Final Closure item 3 — explicit exchange-sync admission state. Starts SYNCED: startup
  // only reaches this point after performStartupRestartRecovery()'s getPositionRisk() read already
  // succeeded above, which IS a successful full read. Flipped to ACCOUNT_STATE_UNKNOWN by any
  // balance-read failure (refreshBalanceForTelegram) or protective-order-read failure (immediately
  // below, and see the tick-loop wiring further down) — never by a timer. Flipped back to SYNCED only
  // after ONE subsequent evidence-based full resync succeeds (see refreshBalanceForTelegram below).
  let accountSyncState: AccountSyncState = 'SYNCED';

  // TICKET-G1R-A "Final Safety Hotfix" item 5 — hybrid multi-frequency freshness policy. Balance stays
  // on its existing FAST per-event cadence (refreshBalanceForTelegram(), unchanged) — this only tracks
  // WHEN each source last succeeded so admission can fail closed if either goes stale, without slowing
  // down the fast path itself. Both start null (never captured yet) -> isFreshnessEvidenceStale()
  // treats null as stale, so admission is blocked until the first successful read/cycle of EACH,
  // exactly like accountSyncState's own "SYNCED only after real evidence" convention.
  const BALANCE_FRESHNESS_MAX_AGE_MS = 5 * 60_000; // generous vs. the sub-second per-event cadence — only trips if reads stop happening entirely
  const PROTECTIVE_CYCLE_FRESHNESS_MAX_AGE_MS = ACCOUNT_SYNC_CYCLE_INTERVAL_MS * 2; // tolerate exactly one missed/slow cycle before failing closed
  // NOTE: `lastSuccessfulBalanceReadMs` is declared ABOVE (with the item-1 balance lifecycle block)
  // because applyBalanceObservation() writes it — it must not be in the TDZ when the startup read runs.
  let lastSuccessfulAccountSyncCycleMs: number | null = null;
  function balanceFreshnessEvidence(): FreshnessEvidence | null {
    return lastSuccessfulBalanceReadMs === null ? null : { capturedAtMs: lastSuccessfulBalanceReadMs, maxAgeMs: BALANCE_FRESHNESS_MAX_AGE_MS, source: currentBalanceObservation?.source ?? 'unknown' };
  }
  function protectiveCycleFreshnessEvidence(): FreshnessEvidence | null {
    return lastSuccessfulAccountSyncCycleMs === null ? null : { capturedAtMs: lastSuccessfulAccountSyncCycleMs, maxAgeMs: PROTECTIVE_CYCLE_FRESHNESS_MAX_AGE_MS, source: 'runAccountSyncCycleTick' };
  }

  // TICKET-G1R-A "Final Safety Hotfix" item 1 — positions whose protective SL fail-safe exhausted its
  // retry budget WITHOUT a confirmed-safe outcome (OPERATOR_REQUIRED, or a market close that could not
  // be verified). Still fully managed (still in openPositions/orderIds/the risk ledger, see
  // runAccountSyncCycleTick below) — this Set exists ONLY to (a) block admission portfolio-wide while
  // any entry is degraded and (b) throttle the repeated CRITICAL Telegram alert per position (keyed by
  // `${symbol}:${entryTimestamp}`) so every 5-minute retry cycle doesn't spam a fresh message.
  const protectionDegradedAlertLastSentMsByKey = new Map<string, number>();
  const PROTECTION_DEGRADED_ALERT_RESEND_MS = 30 * 60_000; // re-nag every 30 min while still degraded, not every 5-min cycle
  function hasAnyProtectionDegradedPosition(): boolean {
    return SYMBOLS.some((s) => runnerState[s].symbolState.openPositions.some((e) => e.meta.protectionStatus === 'PROTECTION_DEGRADED'));
  }

  // TICKET-G1R Final Closure item 2 — protective-order (SL) ownership verification for every
  // RECOVERED position from restart recovery above. Checkpoint C's known limitation #2 (persisted
  // algoIds trusted, never re-verified against a live open-orders query) is closed here: for each
  // symbol with at least one RECOVERED side carrying a persisted slAlgoId, read the REAL open algo
  // orders for that symbol and verify the SL algoId is still open, correct side, correct qty. A
  // non-VERIFIED result NEVER auto-replaces/cancels anything — it quarantines the position (reuses
  // Checkpoint C's exact PENDING_RECONCILIATION mechanism: entriesBlockedDueToRestartQuarantineBySymbol
  // + removal from openPositions + a conservative UNKNOWN_EXPOSURE risk-ledger entry), same as a
  // failed qty ownership-proof. A read failure (network/endpoint error — see getOpenAlgoOrders()'s own
  // HONEST VERIFICATION GAP doc comment: the exact endpoint path is unconfirmed against real Binance
  // docs this session) flips accountSyncState to ACCOUNT_STATE_UNKNOWN (item 3) rather than silently
  // treating the position as protected.
  // TICKET-G1R-B (Runtime Wiring Pass) item 3 — TP verification wired at startup (same call site as
  // SL, per the ticket's explicit requirement). WARNING-only (log + Telegram), NEVER escalates through
  // recoverMissingProtectiveSl()/quarantine — a missing/wrong TP still leaves the position SL-protected.
  // expectedQty per tier uses the RECONCILED (post-G1-F05) `positionSize` basis, not the position's
  // current (possibly TP1-shrunk) remainingPositionSize — each TP tier's own order was sized as a fixed
  // fraction of the ORIGINAL reconciled notional at open time and never re-placed afterward.
  function verifyTpTiersAndWarn(symbol: string, entry: OpenPositionEntry, ids: LiveOrderIds, openAlgoOrders: Awaited<ReturnType<typeof executor.getOpenAlgoOrders>>): void {
    const nonRunnerTiers = entry.position.tpLevels.filter((t) => t.price !== null);
    const originalBaseQty = entry.position.positionSize / entry.position.entryPrice;
    for (let i = 0; i < ids.tpAlgoIds.length; i++) {
      const tpAlgoId = ids.tpAlgoIds[i];
      const tier = nonRunnerTiers[i];
      if (!tier) continue;
      const alreadyFilled = entry.position.filledTiers.includes(tier.label);
      const found = openAlgoOrders.find((o) => o.algoId === tpAlgoId);
      if (alreadyFilled) {
        if (found) {
          console.warn(`[PROTECTIVE_TP_STALE] ${symbol} ${entry.position.side} tier=${tier.label}: algoId=${tpAlgoId} đã fill nhưng vẫn còn resting trên sàn — cần dọn, KHÔNG nghiêm trọng bằng SL.`);
          telegramQueue.enqueue(`⚠️ [TP DƯ THỪA] ${symbol} ${entry.position.side} ${tier.label}: lệnh TP đã fill vẫn còn resting trên sàn — cần kiểm tra/dọn.`);
        }
        continue;
      }
      const expectedTierQty = tier.closePercent * originalBaseQty;
      // item 4 — full semantic verification (symbol/positionSide/orderType/triggerPrice/reduceOnly),
      // same depth as the periodic sweep in liveStateSync.ts.
      const verification = verifyProtectiveTpOrder({
        tpAlgoId,
        expectedSide: entry.position.side,
        expectedQty: expectedTierQty,
        quantityTolerance: quantityToleranceBySymbol[symbol],
        openAlgoOrders,
        expectedSymbol: symbol,
        expectedTriggerPrice: tier.price ?? undefined,
        positionMode: DEFAULT_POSITION_MODE,
      });
      if (verification.status !== 'VERIFIED') {
        console.warn(`[PROTECTIVE_TP_VERIFY_WARNING] ${symbol} ${entry.position.side} tier=${tier.label}: status=${verification.status} — ${verification.detail}`);
        telegramQueue.enqueue(`⚠️ [TP CẢNH BÁO] ${symbol} ${entry.position.side} ${tier.label}: ${verification.status} — ${verification.detail}`);
      }
    }
  }

  for (const outcome of restartRecovery.symbols) {
    const rsForVerify = runnerState[outcome.symbol];
    const positionsToVerify = rsForVerify.symbolState.openPositions.filter((e) => rsForVerify.orderIds.get(e.meta.entryTimestamp)?.slAlgoId != null);
    if (positionsToVerify.length === 0) continue;
    let openAlgoOrders: Awaited<ReturnType<typeof executor.getOpenAlgoOrders>>;
    try {
      openAlgoOrders = await executor.getOpenAlgoOrders(outcome.symbol);
    } catch (err) {
      accountSyncState = 'ACCOUNT_STATE_UNKNOWN';
      console.error(
        `[PROTECTIVE_ORDER_VERIFY_READ_ERROR] ${outcome.symbol}: getOpenAlgoOrders() lỗi khi xác minh SL/TP thật sau restart — accountSyncState=ACCOUNT_STATE_UNKNOWN, chặn admission TOÀN PORTFOLIO cho tới khi đồng bộ lại thành công. Chi tiết: ${(err as Error).message}`,
      );
      telegramQueue.enqueue(`⚠️ [ACCOUNT_STATE_UNKNOWN] Không đọc được open algo orders thật cho ${outcome.symbol} lúc khởi động — ĐÃ CHẶN mở lệnh mới TOÀN BỘ 4 coin cho tới khi đồng bộ lại thành công.`);
      continue;
    }
    for (const entry of positionsToVerify) {
      const ids = rsForVerify.orderIds.get(entry.meta.entryTimestamp)!;
      const expectedQty = entry.position.remainingPositionSize / entry.position.entryPrice;
      const verification = verifyProtectiveSlOrder({
        persistedSlAlgoId: ids.slAlgoId,
        expectedSide: entry.position.side,
        expectedQty,
        quantityTolerance: quantityToleranceBySymbol[outcome.symbol],
        openAlgoOrders,
        // item 4 — full semantic verification on the restart-recovery path too.
        expectedSymbol: outcome.symbol,
        expectedTriggerPrice: entry.position.currentSlPrice,
        positionMode: DEFAULT_POSITION_MODE,
        expectedOrderTypes: PROTECTIVE_SL_ORDER_TYPES,
      });
      if (verification.status === 'VERIFIED') {
        verifyTpTiersAndWarn(outcome.symbol, entry, ids, openAlgoOrders);
        continue;
      }
      // TICKET-G1R-A item 1 — this position already proved ownership (RECOVERED, Checkpoint C) BEFORE
      // reaching this loop (only recovered sides ever land in symbolState.openPositions — see
      // recoverSymbolState()), so it qualifies for the fail-safe RECOVERY attempt instead of an
      // immediate quarantine-and-give-up. Never called for a QUARANTINED/unverified position (those
      // never reach this loop at all — filtered out of openPositions before this file even starts).
      // The whole portfolio is trivially blocked for the duration of this attempt: this runs at
      // startup, synchronously awaited, BEFORE the tick loop (and therefore before any admission
      // check) ever runs.
      console.error(`[PROTECTIVE_ORDER_VERIFY_FAILED] ${outcome.symbol} ${entry.position.side} entryTimestamp=${entry.meta.entryTimestamp}: status=${verification.status} — ${verification.detail}. Thử phục hồi SL trước khi quarantine.`);
      const recovery = await recoverMissingProtectiveSl({
        executor,
        symbol: outcome.symbol,
        expectedSide: entry.position.side,
        expectedQty,
        quantityTolerance: quantityToleranceBySymbol[outcome.symbol],
        slTriggerPrice: entry.position.currentSlPrice,
        policy: MISSING_PROTECTIVE_SL_FAILSAFE_POLICY,
      });
      if (recovery.status === 'RECOVERED' || recovery.status === 'ALREADY_RECOVERED_ON_RESTART') {
        console.log(`[PROTECTIVE_SL_RECOVERED] ${outcome.symbol} ${entry.position.side}: ${recovery.detail}`);
        telegramQueue.enqueue(`✅ [SL PHỤC HỒI] ${outcome.symbol} ${entry.position.side}: ${recovery.detail}`);
        ids.slAlgoId = recovery.slAlgoId;
        verifyTpTiersAndWarn(outcome.symbol, entry, ids, openAlgoOrders);
        continue; // still managed — no quarantine, no removal from openPositions
      }
      if (recovery.status === 'EXHAUSTED_EMERGENCY_CLOSED') {
        console.error(`[PROTECTIVE_SL_EMERGENCY_CLOSE] ${outcome.symbol} ${entry.position.side}: ${recovery.detail}`);
        telegramQueue.enqueue(`🚨 [EMERGENCY_CLOSE] ${outcome.symbol} ${entry.position.side}: ${recovery.detail}`);
      } else {
        console.error(`[PROTECTIVE_SL_OPERATOR_REQUIRED] ${outcome.symbol} ${entry.position.side}: ${recovery.detail}`);
        telegramQueue.enqueue(`🚨🚨 [CRITICAL — CẦN CAN THIỆP THỦ CÔNG] ${outcome.symbol} ${entry.position.side}: ${recovery.detail}`);
      }
      // Either way (emergency-closed for real, or left naked pending an operator): the position is no
      // longer safely bot-managed — quarantine using the EXACT same mechanism as before this ticket.
      entriesBlockedDueToRestartQuarantineBySymbol.add(outcome.symbol);
      rsForVerify.symbolState.openPositions = rsForVerify.symbolState.openPositions.filter((e) => e.meta.entryTimestamp !== entry.meta.entryTimestamp);
      quarantinedUnknownExposures.push({
        id: `${outcome.symbol}:${entry.position.side}:PROTECTIVE_ORDER_${verification.status}_${recovery.status}`,
        basis: { side: entry.position.side, entryPrice: entry.position.entryPrice, currentSlPrice: entry.position.currentSlPrice, remainingPositionSize: entry.position.remainingPositionSize },
      });
    }
  }
  if (accountSyncState === 'ACCOUNT_STATE_UNKNOWN') {
    console.error('[ACCOUNT_STATE_UNKNOWN] khởi động tiếp tục nhưng CHẶN mở lệnh mới TOÀN PORTFOLIO cho tới khi một lần đồng bộ đầy đủ (balance+position+order) thành công.');
  }
  persistLiveState(); // re-persist: protective-order verification above may have removed quarantined positions from openPositions

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
    // TICKET-G3R — the buffers must ALSO carry the warm-up the startup regime reconstruction needs on
    // EVERY timeframe it replays, not just 5m: 5m/15m/1h are all deepened together (the ticket's
    // explicit "không được backfill 5m dài mà để 15m/1h ngắn hơn" rule). Decision-neutral: every
    // decision-time window below is still sliced to WINDOW_5M/WINDOW_15M/WINDOW_1H/WINDOW_1H_MOMENTUM
    // from the tail of these buffers, so a deeper buffer changes no input the orchestrator sees.
    windowSizes: {
      '5m': RECON_REQUIRED_5M + 1, // +1 keeps Binance's forming candle without evicting a required closed one
      '15m': RECON_REQUIRED_15M + 1,
      '1h': Math.max(WINDOW_1H_MOMENTUM, RECON_REQUIRED_1H) + 1, // covers candles1h (last 40), candles1hMomentum (500) and reconstruction from the SAME buffer
    },
    onError: (err, symbol, interval) => console.error(`[FEED_ERROR] ${symbol} ${interval}: ${err.message}`),
    onGapFilled: (symbol, interval, gaps) => console.log(`[FEED] ${symbol} ${interval}: đã vá ${gaps.length} khoảng trống`),
    onThrottled: (symbol, interval) => console.warn(`[FEED_THROTTLE] ${symbol} ${interval}: bỏ qua poll (gần chạm ngưỡng weight)`),
  });
  console.log('Đang tải lịch sử nến ban đầu cho 4 coin...');
  await feed.start();
  console.log('LiveCandleFeed đã sẵn sàng.');

  // ---- TICKET-G3R: cold-start regime-state reconstruction ---------------------------------------
  //
  // Startup sequencing. The ticket asks for
  //   candle backfill -> input integrity -> regime reconstruction -> exchange/restart reconciliation
  //   -> entry admission enabled -> live tick
  // but G1R Checkpoint C deliberately runs exchange/restart reconciliation BEFORE the candle feed, so
  // no candle can ever be processed against an unreconciled guess of what is open. Rather than invert
  // that safety-critical ordering, reconstruction is placed here — it reads ONLY candle-feed data and
  // makes no exchange call, so its position relative to the exchange reconciliation is immaterial. The
  // ticket's actual invariant ("no entry may be admitted while reconstruction is running or has
  // failed") is preserved exactly: this runs BEFORE the first tick is scheduled, and any symbol left
  // without a trustworthy regime state blocks new-entry admission for the WHOLE portfolio through the
  // same sentinel-over-cap mechanism Checkpoint D / G2R F-01 already use. Effective order:
  //   exchange reconciliation -> candle backfill -> input integrity -> regime reconstruction
  //   -> entry admission enabled -> live tick.
  //
  // Symbols whose regime state could not be established from EITHER a fresh persisted state or a full
  // candle replay. Permanent for the life of the process (same convention as
  // entriesBlockedDueToRestartQuarantineBySymbol) — new entries blocked portfolio-wide, open-position
  // management continues untouched.
  const symbolsWithUnavailableRegimeState = new Set<string>();
  {
    const reconstructionNow = Date.now();
    const historyBySymbol: Record<string, SymbolCandleHistory> = {};
    for (const symbol of SYMBOLS) {
      historyBySymbol[symbol] = {
        candles5m: feed.getClosedCandles(symbol, '5m', reconstructionNow),
        candles15m: feed.getClosedCandles(symbol, '15m', reconstructionNow),
        candles1h: feed.getClosedCandles(symbol, '1h', reconstructionNow),
      };
      const h = historyBySymbol[symbol];
      console.log(
        `[REGIME_RECONSTRUCTION_INPUT] symbol=${symbol} closed5m=${h.candles5m.length}/${RECON_REQUIRED_5M} closed15m=${h.candles15m.length}/${RECON_REQUIRED_15M} closed1h=${h.candles1h.length}/${RECON_REQUIRED_1H}`,
      );
    }
    let reconstruction: ReturnType<typeof reconstructRegimeStatesAcrossSymbols>;
    try {
      reconstruction = reconstructRegimeStatesAcrossSymbols({ symbols: SYMBOLS, historyBySymbol });
    } catch (err) {
      // The function itself already fails closed per symbol; this only covers a truly unexpected
      // throw. Never falls back to a default regime state and then trades.
      console.error(`[REGIME_RECONSTRUCTION_ERROR] dựng lại regime state thất bại toàn cục (đã bắt): ${(err as Error).message}`);
      reconstruction = Object.fromEntries(
        SYMBOLS.map((s) => [
          s,
          {
            status: 'INVALID' as const,
            symbol: s,
            reason: 'RECONSTRUCTION_EXCEPTION' as const,
            telemetry: {
              symbol: s, replayStart: null, replayEnd: null, replayedCandles: 0, previousRegime: null, candidateRegime: null,
              streakCount: 0, lastDangerZoneTimestamp: null, cooldownRemainingMinutes: 0, inputQuality: 'RECONSTRUCTION_EXCEPTION' as const,
              available5m: historyBySymbol[s].candles5m.length, available15m: historyBySymbol[s].candles15m.length, available1h: historyBySymbol[s].candles1h.length,
              detail: (err as Error).message,
            },
          },
        ]),
      );
    }

    const persistedFile = persistedLiveState.status === 'OK' ? persistedLiveState.file : null;
    for (const symbol of SYMBOLS) {
      const closed5m = historyBySymbol[symbol].candles5m;
      const latestClosedCandleTimestamp = closed5m.length > 0 ? closed5m[closed5m.length - 1].timestamp : null;
      const persistedRecord = persistedFile?.symbols[symbol];
      const decision = decideRegimeStateSource({
        persistedFileStatus: persistedLiveState.status,
        persisted: persistedRecord !== undefined ? { regimeState: persistedRecord.symbolState.regimeState, regimeStateCandleTimestamp: persistedRecord.regimeStateCandleTimestamp } : null,
        reconstruction: reconstruction[symbol],
        latestClosedCandleTimestamp,
      });
      const rs = runnerState[symbol];
      if (decision.source === 'UNAVAILABLE') {
        symbolsWithUnavailableRegimeState.add(symbol);
      } else {
        rs.symbolState = { ...rs.symbolState, regimeState: decision.regimeState };
        // The reconstruction/persisted state ALREADY accounts for this candle — letting the tick loop
        // process it again would advance the hysteresis chain one extra step off the same candle and
        // diverge from a continuously-running process.
        rs.lastProcessedCandleTimestamp = decision.anchorTimestamp;
      }
      console.log(formatRegimeReconstructionLog(symbol, decision.source, reconstruction[symbol].telemetry, decision.reason));
    }
    if (symbolsWithUnavailableRegimeState.size > 0) {
      const list = [...symbolsWithUnavailableRegimeState].join(',');
      console.error(`[REGIME_STATE_UNAVAILABLE] ${list}: không dựng lại được regime state — CHẶN mở lệnh mới TOÀN PORTFOLIO (vẫn quản lý vị thế đang mở). Cần người kiểm tra dữ liệu nến trước khi giao dịch lại.`);
      telegramQueue.enqueue(`⚠️ [REGIME_STATE_UNAVAILABLE] Không dựng lại được trạng thái Regime cho: ${list}. ĐÃ CHẶN mở lệnh mới toàn bộ 4 coin (vị thế đang mở vẫn được quản lý).`);
    }
    persistLiveState(); // persist the just-established regime state + its candle anchor
  }

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
    (restartRecoverySummaryLines.length > 0 ? `\n[RESTART RECOVERY]\n${restartRecoverySummaryLines.join('\n')}` : '\n[RESTART RECOVERY] không có vị thế/persisted state nào — khởi động sạch.') +
    (dryRun ? '\n\n[DRY-RUN MODE — chưa đặt lệnh thật]' : ''),
  );

  // TICKET-151 §11 — per-symbol in-flight reconcile marker. Checked before starting a new
  // external-close reconcile for a symbol (no double-close/double-release) AND at the top of this
  // symbol's per-tick processing (frozen — no new candle processed, no new entry opened, no close
  // handled — while its reconcile is in flight, per the ticket's 11-step workflow's step 1).
  const reconcileGuard = new ReconcileGuard();

  // TICKET — Exchange-Authoritative Live Balance §7: set true when a per-event fresh balance read
  // diverges from accountBalance beyond tolerance; checked at the top of the tick loop below to
  // BLOCK all candle processing (including new entries) until a subsequent sync comes back clean.
  // Global (not per-symbol) — balance is account-wide, not a single symbol's concern.
  let entriesBlockedDueToBalanceDivergence = false;
  let balanceDivergenceWarningSent = false;
  // G1-F01: set by refreshBalanceForTelegram() whenever a fresh exchange read lands THIS symbol's
  // tick; reset per-symbol below. Guards the end-of-symbol accountBalance assignment so a stale
  // simulated result.accountBalance never clobbers an authoritative read obtained moments earlier
  // in the same tick (was: unconditional `accountBalance = result.accountBalance`).
  let exchangeBalanceRefreshedThisTick = false;

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

  /**
   * TICKET — Exchange-Authoritative Live Balance §1/§2/§4/§6/§7: called before EVERY open/partial/
   * close Telegram message, in dryRun and live alike (getAccountInfo() is a read, never gated by
   * dryRun — same convention as stateReconciler.ts). Returns the fresh snapshot to display, or null
   * (caller must show "pending exchange sync", never a self-calculated fallback). Also updates the
   * enclosing `accountBalance`/`entriesBlockedDueToBalanceDivergence` — exchange always wins over
   * the internal simulated number (extends TICKET-102's resolveAccountBalanceAfterReconcile to
   * every event, not just the 7-minute sweep).
   */
  async function refreshBalanceForTelegram(): Promise<ExchangeBalanceSnapshot | null> {
    const internalBalanceBeforeSync = accountBalance; // G1-F02: snapshot BEFORE any correction below
    const outcome = await syncBalanceForTelegramEvent(executor, accountBalance);
    if (outcome.snapshot === null) {
      // TICKET-G1R Final Closure item 3 — a failed balance read is one of the 3 required admission
      // gates (balance/position/order): flip the explicit state, never silently keep trading on the
      // stale internal number as if nothing happened.
      if (accountSyncState === 'SYNCED') {
        accountSyncState = 'ACCOUNT_STATE_UNKNOWN';
        console.error('[ACCOUNT_STATE_UNKNOWN] refreshBalanceForTelegram(): đọc balance thật thất bại/timeout — CHẶN mở lệnh mới TOÀN PORTFOLIO cho tới khi đồng bộ lại thành công.');
        telegramQueue.enqueue('⚠️ [ACCOUNT_STATE_UNKNOWN] Không đọc được số dư thật từ sàn — ĐÃ CHẶN mở lệnh mới TOÀN BỘ 4 coin cho tới khi đồng bộ lại thành công.');
      }
      return null;
    }
    // item 1 — SAME apply path/anti-time-travel rule as bootstrap/periodic. `outcome.snapshot` was
    // produced by the same canonical parseExchangeBalanceSnapshot(), so no second parse is needed;
    // value + provenance + freshness are still adopted atomically, and an out-of-order read is
    // rejected without touching the freshness timestamp.
    balanceObservationCounter += 1;
    applyBalanceObservation({
      walletBalance: outcome.snapshot.walletBalance,
      capturedAt: outcome.snapshot.fetchedAt,
      source: 'event:refreshBalanceForTelegram',
      requestId: `bal-${outcome.snapshot.fetchedAt}-${balanceObservationCounter}`,
    });
    exchangeBalanceRefreshedThisTick = true; // G1-F01: authoritative read this tick — must survive to line ~780
    if (accountSyncState === 'ACCOUNT_STATE_UNKNOWN') {
      // TICKET-G1R Final Closure item 3 — "chỉ mở lại sau MỘT LẦN đồng bộ thành công có chứng cứ":
      // a successful balance read alone is one of the 3 gates; also require a fresh getPositionRisk()
      // confirmation before declaring the account state known again (never on the balance read alone,
      // never on a timer).
      try {
        const posRisk = await executor.getPositionRisk();
        if (Array.isArray(posRisk)) {
          accountSyncState = 'SYNCED';
          console.log('[ACCOUNT_STATE_SYNCED] balance + getPositionRisk() đều đọc thành công — bỏ chặn admission toàn portfolio.');
          telegramQueue.enqueue('✅ [ĐÃ ĐỒNG BỘ LẠI] Balance + vị thế đã đọc thành công từ sàn — đã bỏ chặn mở lệnh mới toàn portfolio.');
        }
      } catch {
        // stays ACCOUNT_STATE_UNKNOWN — no partial credit, per the ticket's "cùng lúc" requirement.
      }
    }

    if (outcome.diverged && outcome.divergence) {
      if (!entriesBlockedDueToBalanceDivergence) {
        entriesBlockedDueToBalanceDivergence = true;
        const incident = {
          timestampMs: Date.now(),
          exchangeWalletBalance: outcome.snapshot.walletBalance,
          internalBalanceBefore: internalBalanceBeforeSync,
          diffUsd: outcome.divergence.diffUsd,
          diffPct: outcome.divergence.diffPct,
          tolerancePct: 0.01,
        };
        console.error(formatBalanceDivergenceIncidentLog(incident));
        if (!balanceDivergenceWarningSent) {
          balanceDivergenceWarningSent = true;
          telegramQueue.enqueue(formatBalanceDivergenceTelegramWarning(incident));
        }
      }
    } else if (entriesBlockedDueToBalanceDivergence) {
      entriesBlockedDueToBalanceDivergence = false;
      balanceDivergenceWarningSent = false;
      console.log('[BALANCE_DIVERGENCE_RESOLVED] số dư nội bộ đã khớp lại với sàn — bỏ chặn lệnh mới.');
      telegramQueue.enqueue('✅ [ĐỐI SOÁT SỐ DƯ OK] Số dư nội bộ đã khớp lại với sàn — đã bỏ chặn lệnh mới.');
    }
    return outcome.snapshot;
  }

  const runnerStateAccess: RunnerStateAccess = {
    getOpenPositionCount: (symbol) => runnerState[symbol].symbolState.openPositions.length,
    setOrderIds: (symbol, entryTimestamp, ids) => { runnerState[symbol].orderIds.set(entryTimestamp, ids); },
    getOrderIds: (symbol, entryTimestamp) => runnerState[symbol].orderIds.get(entryTimestamp),
    deleteOrderIds: (symbol, entryTimestamp) => { runnerState[symbol].orderIds.delete(entryTimestamp); },
    blockSymbolAdmission: (symbol) => { entriesBlockedDueToRestartQuarantineBySymbol.add(symbol); },
    blockIncomeReconciliation: (symbol) => { symbolsBlockedDueToIncomeReconciliation.add(symbol); },
    clearIncomeReconciliation: (symbol) => { symbolsBlockedDueToIncomeReconciliation.delete(symbol); },
  };
  const lifecycleCtx: LifecycleContext = {
    executor,
    dryRun,
    envLabel,
    leverage: CONFIG.leverage,
    quantityToleranceBySymbol,
    missingProtectiveSlFailsafePolicy: MISSING_PROTECTIVE_SL_FAILSAFE_POLICY,
    oodGuardEnabled: OOD_GUARD_ENABLED,
    runnerState: runnerStateAccess,
    emitTelemetry,
    enqueueTelegram: (msg) => telegramQueue.enqueue(msg),
    refreshBalanceForTelegram,
    onAccountSyncUnknown: () => { accountSyncState = 'ACCOUNT_STATE_UNKNOWN'; },
    onWillOpen: () => { willOpenCount++; },
    persistLiveState,
  };
  function handleOpenEvent(symbol: string, event: OpenTradeEvent, balanceAtOpen: number): Promise<OpenEventOutcome> {
    return lifecycleHandleOpenEvent(lifecycleCtx, symbol, event, balanceAtOpen);
  }
  function handlePartialCloseEvent(symbol: string, event: PartialCloseEvent, entryTimestampOfPosition: number, remainingQuantity: number, owner: OpenPositionEntry | undefined): Promise<void> {
    return lifecycleHandlePartialCloseEvent(lifecycleCtx, symbol, event, entryTimestampOfPosition, remainingQuantity, owner);
  }
  function handleCloseEvent(symbol: string, event: CloseTradeEvent): Promise<void> {
    return lifecycleHandleCloseEvent(lifecycleCtx, symbol, event);
  }

  async function tick(): Promise<void> {
    try {
      const now = Date.now();

      if (envLabel === 'mainnet' && dryRun === false && !telemetry.isEnabled() && !telemetryFailureBlockingAdmission) {
        telemetryFailureBlockingAdmission = true;
        console.error('[TELEMETRY_UNAVAILABLE_MANDATORY] telemetry không còn enabled trong khi ENV=mainnet/dryRun=false bắt buộc — chặn mở lệnh mới TOÀN BỘ portfolio.');
        dispatchTelemetryAlert('🚨🚨 [CRITICAL — TELEMETRY KHÔNG KHẢ DỤNG] telemetry đã tắt/đóng trong khi mainnet live yêu cầu bắt buộc — ĐÃ CHẶN mở lệnh mới TOÀN BỘ portfolio, các vị thế đang mở vẫn được quản lý bình thường.');
      }

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
        // TICKET-G1R Checkpoint D (G1-F04): rebuilt from CURRENT remainingPositionSize/currentSlPrice
        // every tick (rebuild-from-scratch), not the stale meta.actualRiskDollar frozen at open — see
        // currentRisk.ts's doc comment. Covers partial fill, TP1/TP2, SL ratchet/breakeven/trailing,
        // Checkpoint B's quantity reconciliation, and Checkpoint C's restart recovery for free, since
        // all of those mutate `position` in place and this always reads it fresh.
        const total = runnerState[s].symbolState.openPositions.reduce((sum, e) => sum + computeCurrentPositionRisk(e.position).openRiskDollar, 0);
        if (total > 0) openRiskBySymbol[s] = total;
        const totalMargin = runnerState[s].symbolState.openPositions.reduce((sum, e) => sum + e.meta.marginRequired, 0);
        if (totalMargin > 0) openMarginBySymbol[s] = totalMargin;
      }
      // TICKET-G1R Checkpoint D (G1-F04) — Quarantine: an exchange-only/unreconciled position is
      // UNKNOWN_EXPOSURE, never risk=0, and while ANY such exposure exists the whole portfolio's risk
      // total (one shared pool, 15% cap on the WHOLE balance) is untrustworthy — not just the affected
      // symbol. Recomputed fresh every tick (rebuild-from-scratch, no incremental flag toggling) from
      // the two Sets Checkpoint B/C already maintain (never mutated here). Only reopens automatically
      // once those Sets are empty again — i.e. reconciled with evidence, never a timer.
      // TICKET-G1R Final Closure item 3 — 3rd trigger condition added: accountSyncState ===
      // 'ACCOUNT_STATE_UNKNOWN' (a failed balance/position/protective-order read since the last
      // successful full resync) blocks the WHOLE portfolio via the SAME sentinel-over-cap mechanism,
      // never a separate parallel gate.
      // TICKET-G1R-A "Final Safety Hotfix" item 1 — a PROTECTION_DEGRADED position (naked exposure
      // still open on the exchange, SL fail-safe exhausted) is at least as serious as the existing
      // triggers — blocks the WHOLE portfolio via the SAME sentinel, never a per-symbol-only block.
      // Item 5 — stale balance OR stale protective-cycle evidence is a further, INDEPENDENT trigger:
      // either one alone is sufficient to fail closed (both isFreshnessEvidenceStale calls are
      // evaluated, not short-circuited away — see the dedicated freshness tests).
      // TICKET-G3R — `symbolsWithUnavailableRegimeState` joins the same sentinel-over-cap mechanism
      // below: a symbol whose regime state could not be reconstructed OR restored from a fresh
      // persisted state has an UNKNOWN post-DANGER cooldown anchor, so its regime label cannot be
      // trusted for admission. No new parallel gate, no change to the 15% cap or to orchestrator's
      // decision logic. Portfolio-wide, per the ticket's "block TOÀN BỘ new-entry admission" rule.
      // (Kept OUT of the expression body: g1rFinalClosureFix/g1rFinalSafetyHotfixFix/
      // g1rFinalInternalClosureFix scan a fixed 600-char window from the `const` below to prove no
      // condition was silently dropped, and an inline comment would push conditions out of it.)
      const hasUnquantifiableExposureBlockingAdmission =
        entriesBlockedDueToRestartQuarantineBySymbol.size > 0 ||
        symbolsWithUnavailableRegimeState.size > 0 ||
        accountSyncState === 'ACCOUNT_STATE_UNKNOWN' ||
        hasAnyProtectionDegradedPosition() ||
        livePersistFailureBlockingAdmission ||
        telemetryFailureBlockingAdmission ||
        // item 1 — the THREE balance conditions, not just freshness: parsed+applied
        // (`accountBalanceKnown`), and still fresh. `accountBalanceKnown` is the explicit
        // "UNKNOWN until a real exchange read" sentinel; it can never be satisfied by a default.
        !accountBalanceKnown ||
        isFreshnessEvidenceStale(balanceFreshnessEvidence(), now) ||
        isFreshnessEvidenceStale(protectiveCycleFreshnessEvidence(), now);

      for (const symbol of SYMBOLS) {
        const rs = runnerState[symbol];
        exchangeBalanceRefreshedThisTick = false; // G1-F01: fresh per symbol, see declaration above
        // TICKET — Exchange-Authoritative Live Balance §7: freeze the WHOLE tick for EVERY symbol
        // (not per-symbol — balance divergence is account-wide) while accountBalance is confirmed
        // diverged from Binance beyond tolerance. Blunt but safe: orchestrator.ts/processCandle()
        // has no "exchange staleness" concept and must not gain one (sim core stays pure) — already-
        // open positions stay protected by their resting real SL/TP orders, so losing ticks here is
        // the same accepted trade-off as reconcileGuard's per-symbol freeze below.
        if (entriesBlockedDueToBalanceDivergence) {
          console.warn(`[ENTRY_BLOCKED_BALANCE_DIVERGENCE] ${symbol}: bỏ qua tick — số dư nội bộ đang lệch với sàn, chờ đối soát lại trước khi mở lệnh mới.`);
          continue;
        }
        // TICKET-151 §5 P0-C step 1 / §11 — freeze ALL mutation for this symbol while its external-
        // close reconcile is in flight: no new candle processed, no new entry opened, no close/partial
        // handled. The reconcile itself is a bounded handful of read-only calls (+ idempotent cancels
        // of already-stale SL/TP orders), so losing one 5s tick for this symbol is a safe trade-off
        // against acting on a symbol whose internal/exchange state is actively being resolved.
        if (reconcileGuard.isReconciling(symbol)) {
          console.warn(`[RECONCILE_FREEZE] ${symbol}: đang đối soát vị thế đóng ngoài — bỏ qua tick này cho symbol này.`);
          continue;
        }
        // TICKET-G1R Checkpoint C — same permanent per-symbol freeze pattern as the guard above, for
        // a position/qty on the exchange that never proved ownership (at startup or discovered later
        // via POSITION_MISSING_INTERNALLY, see reconciler.onMismatch below) — see the Set's declaration.
        if (entriesBlockedDueToRestartQuarantineBySymbol.has(symbol)) {
          console.warn(`[ENTRY_BLOCKED_RESTART_QUARANTINE] ${symbol}: bỏ qua tick — PENDING_RECONCILIATION, cần kiểm tra thủ công trước khi giao dịch lại trên symbol này.`);
          continue;
        }
        if (symbolsBlockedDueToIncomeReconciliation.has(symbol)) {
          console.warn(`[ENTRY_BLOCKED_INCOME_RECONCILIATION] ${symbol}: bỏ qua tick — PnL/commission sàn chưa đối soát xong.`);
          continue;
        }
        const closed5m = feed.getClosedCandles(symbol, '5m', now);
        if (closed5m.length === 0) continue;
        const latestClosed = closed5m[closed5m.length - 1];
        if (rs.lastProcessedCandleTimestamp !== null && latestClosed.timestamp <= rs.lastProcessedCandleTimestamp) continue; // already processed this candle

        // TICKET-G2R F-01 — the LOW_LIQUIDITY input backtest.ts has always supplied and live never
        // did. INSUFFICIENT_WARMUP is never treated as "volume is normal": the field is withheld AND
        // admission is blocked below, so LOW_LIQUIDITY is never silently evaluated as false.
        const sessionVolume = feed.getSessionVolumeWindow(symbol, now);
        if (sessionVolume.status !== 'READY') {
          console.warn(
            `[SESSION_VOLUME_WARMUP] ${symbol}: chưa đủ nến 5m cho LOW_LIQUIDITY (${sessionVolume.closedCount}/${sessionVolume.required}, lý do=${sessionVolume.reason}) — chặn mở lệnh mới toàn danh mục cho tới khi đủ.`,
          );
        }

        const window5m = slice(closed5m, WINDOW_5M);
        const closed15m = feed.getClosedCandles(symbol, '15m', now);
        const window15m = slice(closed15m, WINDOW_15M);
        const window1hFull = feed.getClosedCandles(symbol, '1h', now);
        const window1h = slice(window1hFull, WINDOW_1H);
        const window1hMomentum = slice(window1hFull, WINDOW_1H_MOMENTUM);
        const closed1m = feed.getClosedCandles(symbol, '1m', now);
        const window1m = slice(closed1m, WINDOW_1M);
        const closed1d = feed.getClosedCandles(symbol, '1d', now);
        const window1d = slice(closed1d, WINDOW_1D);

        const candleFreshnessVerdicts = assessCandleFreshnessForSymbol(
          {
            '5m': window5m,
            '15m': window15m,
            '1h': window1hMomentum,
            '1m': window1m,
            '1d': window1d,
          },
          ['5m', '15m', '1h', '1m', '1d'],
          now,
        );
        const hasStaleRequiredCandleData = hasAnyStaleRequiredTimeframe(candleFreshnessVerdicts);
        if (hasStaleRequiredCandleData) {
          const staleList = candleFreshnessVerdicts
            .filter((v): v is Extract<typeof v, { fresh: false }> => !v.fresh)
            .map((v) => `${v.interval}:${v.reason}`)
            .join(',');
          console.warn(`[CANDLE_FRESHNESS_STALE] ${symbol}: ${staleList} — chặn mở lệnh mới trên symbol này cho tới khi dữ liệu nến tươi trở lại (vẫn quản lý vị thế đang mở).`);
        }

        // TICKET-101 Việc 1: built fresh from the live-updated openRiskBySymbol map, right before
        // THIS symbol's own processCandle() call — includes any new position(s) opened by an earlier
        // symbol in this same tick.
        const allOpenPositionsRisk = SYMBOLS.filter((s) => openRiskBySymbol[s] !== undefined).map((s) => ({ id: s, actualRiskDollar: openRiskBySymbol[s] }));
        // TICKET-G1R Checkpoint D (G1-F04) — Quarantine rule: while unknown exposure exists anywhere,
        // admission is blocked for the WHOLE portfolio (every symbol), not just the affected one. A
        // sentinel entry over the cap achieves this via the EXISTING wouldExceedRiskPool()/checkRiskPool()
        // arithmetic (no change to orchestrator.ts's decision logic or the 15% cap value itself) —
        // tryOpenNewPosition() sees a portfolio risk total that's honestly over-cap, exactly reflecting
        // that the real total can't currently be trusted.
        if (hasUnquantifiableExposureBlockingAdmission) {
          allOpenPositionsRisk.push({ id: 'UNKNOWN_EXPOSURE_BLOCK', actualRiskDollar: accountBalance * CONFIG.riskPoolMaxPct + 1 });
        }
        // TICKET-G2R F-01 — same sentinel-over-cap mechanism as the block above (no change to
        // orchestrator's decision logic or the 15% cap): while the session-volume window is not
        // ready, LOW_LIQUIDITY cannot be evaluated at all, so no NEW entry may be admitted.
        // Already-open positions still process this candle normally (management must not stop).
        if (sessionVolume.status !== 'READY') {
          allOpenPositionsRisk.push({ id: 'SESSION_VOLUME_WARMUP_BLOCK', actualRiskDollar: accountBalance * CONFIG.riskPoolMaxPct + 1 });
        }
        if (hasStaleRequiredCandleData) {
          allOpenPositionsRisk.push({ id: 'CANDLE_FRESHNESS_STALE_BLOCK', actualRiskDollar: accountBalance * CONFIG.riskPoolMaxPct + 1 });
        }
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
          candles5mSessionVolume: sessionVolume.candles,
          correlatedRiskRatio,
          accountBalance,
          allOpenPositionsRisk,
          totalOpenMarginDollar,
          momentumDirectOpenPositionsTotal,
          momentumDirectOpenPositions,
        };

        const previousRegime = rs.symbolState.regimeState.previousRegime;
        let lastComputedMetrics: { adx1h?: number; atrPercentile5m?: number } = {};
        const tickConfig: OrchestratorConfig = { ...CONFIG, riskDollarOrPercent: LIVE_FIXED_RISK_USD };
        const result = await processCandle(
          input,
          rs.symbolState,
          tickConfig,
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
            const traceId = stableTelemetryId('blockedTrace', diagnostic.symbol, diagnostic.timestamp, diagnostic.side, 'SAME_SIDE');
            emitTelemetry({ traceId, symbol: diagnostic.symbol, side: diagnostic.side, setupType: 'UNKNOWN_CANDIDATE_SETUP', eventType: 'DECISION_MADE', eventTimestampUtc: new Date(diagnostic.timestamp).toISOString(), source: 'ORCHESTRATOR_T152_GUARD', candidateId: stableTelemetryId('candidate', traceId), decisionId: stableTelemetryId('decision', traceId), quality: { decision: 'DERIVED', openSameSideCount: 'DERIVED' }, data: { decision: 'BLOCK', reasonCode: 'SAME_SIDE_POSITION_BLOCKED', t152SameSideGuardEnabled: true, openSameSideCount: diagnostic.openSameSideCount } });
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
            const outcome: OpenEventOutcome = await handleOpenEventIfFresh(candleFreshnessVerdicts, () => handleOpenEvent(symbol, event, accountBalance)).catch((e) => {
              console.error(`[OPEN_HANDLER_ERROR] ${symbol}: ${(e as Error).message}`);
              return { kind: 'AMBIGUOUS', detail: `handleOpenEvent ném lỗi không mong đợi (đã bắt): ${(e as Error).message}`, clientOrderId: buildDeterministicEntryClientOrderId(symbol, event.side, event.entryTimestamp), orderId: null, executedQty: null, avgPrice: null } as OpenEventOutcome;
            });

            if (outcome.kind === 'NOT_FILLED') {
              result.symbolState = { ...result.symbolState, openPositions: result.symbolState.openPositions.filter((e) => e.meta.entryTimestamp !== event.entryTimestamp) };
              console.error(`[NO_PHANTOM_POSITION] ${symbol} entryTimestamp=${event.entryTimestamp}: lệnh MARKET xác nhận KHÔNG khớp — không tạo trạng thái vị thế nội bộ.`);
            } else if (outcome.kind === 'AMBIGUOUS') {
              result.symbolState = applyAmbiguousOpenOutcome({ symbol, event, outcome, symbolState: result.symbolState, recordPendingEntryQuarantine, enqueueTelegram: (message) => telegramQueue.enqueue(message) });
            } else if (outcome.kind === 'FILLED') {
              const protectionOutcomeStr = outcome.protection.status === 'PROTECTED' ? `PROTECTED:slAlgoId=${outcome.protection.slAlgoId}` : `PROTECTION_DEGRADED:firstAttempt=${outcome.protection.firstAttemptReason} recovery=${outcome.protection.recovery.status}:${outcome.protection.recovery.detail}`;
              const openedEntry = result.symbolState.openPositions.find((e) => e.meta.entryTimestamp === event.entryTimestamp);
              if (!openedEntry) {
                result.symbolState = { ...result.symbolState, openPositions: result.symbolState.openPositions.filter((e) => e.meta.entryTimestamp !== event.entryTimestamp) };
                const record = buildPendingEntryQuarantineRecord({
                  symbol,
                  side: event.side,
                  phase: 'FILLED_INTERNAL_STATE_MISSING',
                  clientOrderId: outcome.clientOrderId,
                  orderId: outcome.orderId,
                  executedQty: outcome.executedQty,
                  averageFillPrice: outcome.avgPrice,
                  plannedEntryPrice: event.entryPrice,
                  plannedSlPrice: event.slPrice,
                  reconciledEntryPrice: outcome.reconciled.ok ? outcome.reconciled.entryPrice : null,
                  reconciledPositionSize: outcome.reconciled.ok ? outcome.reconciled.positionSize : null,
                  protectionOutcome: protectionOutcomeStr,
                  actualRiskDollar: outcome.reconciled.ok ? outcome.reconciled.actualRiskDollar : null,
                  marginRequired: outcome.reconciled.ok ? outcome.reconciled.marginRequired : null,
                  protectionStatus: outcome.protection.status,
                  recoveryStatus: outcome.protection.status === 'PROTECTION_DEGRADED' ? outcome.protection.recovery.status : null,
                  recoveryDetail: outcome.protection.status === 'PROTECTION_DEGRADED' ? outcome.protection.recovery.detail : null,
                  exposureBasis: outcome.executedQty !== null ? { side: event.side, qty: outcome.executedQty, entryPrice: outcome.reconciled.ok ? outcome.reconciled.entryPrice : null } : null,
                  entryTimestamp: event.entryTimestamp,
                  reason: `lệnh MARKET đã khớp thật trên sàn nhưng KHÔNG tìm thấy openPositions entry nội bộ tương ứng (entryTimestamp=${event.entryTimestamp})`,
                });
                recordPendingEntryQuarantine(record);
                console.error(`[FILLED_INTERNAL_STATE_MISSING] ${symbol} entryTimestamp=${event.entryTimestamp}: vị thế đã khớp thật trên sàn nhưng mất trạng thái nội bộ — ĐÃ quarantine ${symbol}, chặn mở lệnh mới.`);
                telegramQueue.enqueue(`🚨🚨 [CRITICAL — VỊ THẾ KHỚP THẬT NHƯNG MẤT TRẠNG THÁI NỘI BỘ] ${symbol} ${event.side} entryTimestamp=${event.entryTimestamp}\nĐÃ CHẶN mở lệnh mới trên ${symbol} — cần kiểm tra thủ công NGAY.`);
              } else if (!outcome.reconciled.ok || !outcome.geometryValid) {
                const reason = !outcome.reconciled.ok ? `reconcile thất bại: ${outcome.reconciled.reason}` : `SL geometry không hợp lệ với giá khớp thực tế`;
                openedEntry.meta.protectionStatus = 'PROTECTION_DEGRADED';
                result.symbolState = { ...result.symbolState, openPositions: result.symbolState.openPositions.filter((e) => e.meta.entryTimestamp !== event.entryTimestamp) };
                runnerState[symbol].orderIds.delete(event.entryTimestamp);
                const record = buildPendingEntryQuarantineRecord({
                  symbol,
                  side: event.side,
                  phase: 'RECONCILIATION_FAILED',
                  clientOrderId: outcome.clientOrderId,
                  orderId: outcome.orderId,
                  executedQty: outcome.executedQty,
                  averageFillPrice: outcome.avgPrice,
                  plannedEntryPrice: event.entryPrice,
                  plannedSlPrice: event.slPrice,
                  reconciledEntryPrice: outcome.reconciled.ok ? outcome.reconciled.entryPrice : null,
                  reconciledPositionSize: outcome.reconciled.ok ? outcome.reconciled.positionSize : null,
                  protectionOutcome: protectionOutcomeStr,
                  actualRiskDollar: outcome.reconciled.ok ? outcome.reconciled.actualRiskDollar : null,
                  marginRequired: outcome.reconciled.ok ? outcome.reconciled.marginRequired : null,
                  protectionStatus: outcome.protection.status,
                  recoveryStatus: outcome.protection.status === 'PROTECTION_DEGRADED' ? outcome.protection.recovery.status : null,
                  recoveryDetail: outcome.protection.status === 'PROTECTION_DEGRADED' ? outcome.protection.recovery.detail : null,
                  exposureBasis: outcome.executedQty !== null ? { side: event.side, qty: outcome.executedQty, entryPrice: outcome.reconciled.ok ? outcome.reconciled.entryPrice : null } : null,
                  entryTimestamp: event.entryTimestamp,
                  reason,
                });
                recordPendingEntryQuarantine(record);
                console.error(`[RECONCILIATION_FAILED_QUARANTINE] ${symbol} entryTimestamp=${event.entryTimestamp}: ${reason} — ĐÃ quarantine ${symbol}, chặn mở lệnh mới.`);
                telegramQueue.enqueue(`🚨🚨 [CRITICAL — ĐỐI SOÁT/GEOMETRY SL THẤT BẠI] ${symbol} ${event.side} entryTimestamp=${event.entryTimestamp}: ${reason}\nĐÃ CHẶN mở lệnh mới trên ${symbol} — cần kiểm tra thủ công NGAY.`);
              } else {
                const reconciled = outcome.reconciled;
                if (Math.abs(reconciled.positionSize - openedEntry.position.positionSize) > 1e-9) {
                  console.log(
                    `[POSITION_SIZE_CORRECTED] ${symbol} entryTimestamp=${event.entryTimestamp}: positionSize ${openedEntry.position.positionSize.toFixed(6)} → ${reconciled.positionSize.toFixed(6)} (canonicalQty=${outcome.executedQty})`,
                  );
                }
                console.log(
                  `[ENTRY_STATE_RECONCILED] ${symbol} entryTimestamp=${event.entryTimestamp}: entryPriceBasis=${reconciled.entryPriceBasis} entryPrice=${openedEntry.position.entryPrice.toFixed(6)}→${reconciled.entryPrice.toFixed(6)} actualRiskDollar=${openedEntry.meta.actualRiskDollar.toFixed(4)}→${reconciled.actualRiskDollar.toFixed(4)} marginRequired=${openedEntry.meta.marginRequired.toFixed(4)}→${reconciled.marginRequired.toFixed(4)}`,
                );
                openedEntry.position.positionSize = reconciled.positionSize;
                openedEntry.position.remainingPositionSize = reconciled.positionSize;
                openedEntry.position.entryPrice = reconciled.entryPrice;
                openedEntry.position.r = reconciled.r;
                openedEntry.meta.actualRiskDollar = reconciled.actualRiskDollar;
                openedEntry.meta.marginRequired = reconciled.marginRequired;

                if (outcome.protection.status !== 'PROTECTED') {
                  openedEntry.meta.protectionStatus = 'PROTECTION_DEGRADED';
                  result.symbolState = { ...result.symbolState, openPositions: result.symbolState.openPositions.filter((e) => e.meta.entryTimestamp !== event.entryTimestamp) };
                  runnerState[symbol].orderIds.delete(event.entryTimestamp);
                  const recoveryDetail = `firstAttempt=${outcome.protection.firstAttemptReason} recovery=${outcome.protection.recovery.status}:${outcome.protection.recovery.detail}`;
                  console.error(`[PROTECTIVE_SL_ESTABLISH_FAILED] ${symbol} ${event.side} entryTimestamp=${event.entryTimestamp}: ${recoveryDetail} — ĐÃ quarantine ${symbol}, chặn mở lệnh mới.`);
                  telegramQueue.enqueue(`🚨🚨 [CRITICAL — SL KHÔNG THIẾT LẬP ĐƯỢC] ${symbol} ${event.side}: ${recoveryDetail}\nĐÃ CHẶN mở lệnh mới trên ${symbol} — cần kiểm tra thủ công NGAY.`);
                  quarantinedUnknownExposures.push({
                    id: `${symbol}:${event.side}:${event.entryTimestamp}:PROTECTIVE_SL_ESTABLISH_FAILED`,
                    basis: { side: event.side, entryPrice: openedEntry.position.entryPrice, currentSlPrice: openedEntry.position.currentSlPrice, remainingPositionSize: openedEntry.position.remainingPositionSize },
                  });
                  const record = buildPendingEntryQuarantineRecord({
                    symbol,
                    side: event.side,
                    phase: 'FILLED_UNPROTECTED',
                    clientOrderId: outcome.clientOrderId,
                    orderId: outcome.orderId,
                    executedQty: outcome.executedQty,
                    averageFillPrice: outcome.avgPrice,
                    plannedEntryPrice: event.entryPrice,
                    plannedSlPrice: event.slPrice,
                    reconciledEntryPrice: reconciled.entryPrice,
                    reconciledPositionSize: reconciled.positionSize,
                    protectionOutcome: `PROTECTION_DEGRADED:${recoveryDetail}`,
                    actualRiskDollar: reconciled.actualRiskDollar,
                    marginRequired: reconciled.marginRequired,
                    protectionStatus: outcome.protection.status,
                    recoveryStatus: outcome.protection.status === 'PROTECTION_DEGRADED' ? outcome.protection.recovery.status : null,
                    recoveryDetail: outcome.protection.status === 'PROTECTION_DEGRADED' ? outcome.protection.recovery.detail : null,
                    exposureBasis: { side: event.side, qty: outcome.executedQty, entryPrice: reconciled.entryPrice },
                    entryTimestamp: event.entryTimestamp,
                    reason: recoveryDetail,
                  });
                  recordPendingEntryQuarantine(record);
                } else {
                  openedEntry.meta.protectionStatus = 'PROTECTED';
                }
              }
            }
          } else if (event.type === 'PARTIAL_CLOSE') {
            // Find the still-open position this partial fill belongs to (same symbol+side, only one such position expected per TICKET-056's 2-slot design when a partial just fired on it).
            const owner = result.symbolState.openPositions.find((e) => e.position.side === event.side);
            const remainingQuantity = owner ? owner.position.remainingPositionSize / owner.position.entryPrice : 0;
            await handlePartialCloseEvent(symbol, event, owner?.meta.entryTimestamp ?? -1, remainingQuantity, owner).catch((e) => console.error(`[PARTIAL_HANDLER_ERROR] ${symbol}: ${(e as Error).message}`));
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

        // TICKET-101 Việc 1 / TICKET-G1R Checkpoint D (G1-F04) — refresh AFTER the events loop above
        // (not before it, as this used to run) so the NEXT symbol in this tick's loop sees THIS
        // symbol's truly up-to-date total: Checkpoint B's OPEN-event reconciliation mutates
        // `openedEntry.position` in place inside that loop (corrected entryPrice/remainingPositionSize),
        // and recomputing from `position` (not the frozen meta.actualRiskDollar) here picks that
        // correction up immediately, same tick — never stale until the next tick.
        const newTotalRisk = result.symbolState.openPositions.reduce((sum, e) => sum + computeCurrentPositionRisk(e.position).openRiskDollar, 0);
        if (newTotalRisk > 0) openRiskBySymbol[symbol] = newTotalRisk;
        else delete openRiskBySymbol[symbol];
        // TICKET-101 Việc 2: same live refresh for margin (see openMarginBySymbol declaration above).
        const newTotalMargin = result.symbolState.openPositions.reduce((sum, e) => sum + e.meta.marginRequired, 0);
        if (newTotalMargin > 0) openMarginBySymbol[symbol] = newTotalMargin;
        else delete openMarginBySymbol[symbol];

        rs.symbolState = result.symbolState;
        // TICKET-G1R-A "Final Internal Closure" item 1 — `result.accountBalance` is the SIMULATOR's
        // own bookkeeping and is NO LONGER written back into `accountBalance`. `accountBalance` is now
        // strictly a cache of the latest exchange-authoritative wallet balance (applyBalanceObservation
        // is its only writer). Live admission uses this exchange balance directly and does not add
        // simulator-booked tier PnL that may already be settled in the wallet balance.
        // `exchangeBalanceRefreshedThisTick` is still maintained (used by the divergence path below).
        rs.lastProcessedCandleTimestamp = latestClosed.timestamp;
      }
      // TICKET-G1R Checkpoint C — persist after every tick's mutations (orderIds Map updates from
      // handleOpenEvent/handlePartialCloseEvent/handleCloseEvent above have already landed by this
      // point). A crash between two persists loses at most one tick's worth of updates — the NEXT
      // restart's ownership-proof check against a fresh exchange read safely re-reconciles from there
      // (see liveStateSync.ts's performStartupRestartRecovery doc comment).
      persistLiveState();
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
      // item 1 — exchange-derived value, applied through the single path (provenance + freshness +
      // anti-time-travel) instead of a bare assignment.
      balanceObservationCounter += 1;
      applyBalanceObservation({ walletBalance: exchangeBalanceUsd, capturedAt: Date.now(), source: 'reconcile:externalClose', requestId: `bal-${Date.now()}-${balanceObservationCounter}` });

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

  // TICKET-G1R-A "Freshness Bootstrap Hotfix" items 1-4 — CONFIRMED bug fix: the OLD
  // runAccountSyncCycleTickBody() returned immediately (`if (positions.length === 0) return;`) BEFORE
  // either freshness timestamp below was ever touched. On a fresh start (or simply between trades) with
  // zero bot-owned positions, lastSuccessfulAccountSyncCycleMs (and, transitively, lastSuccessfulBalanceReadMs,
  // which used to depend on a trade event that can never fire while admission stays blocked) NEVER got
  // set — admission was blocked PERMANENTLY, not "~5 minutes after restart". This function is the
  // shared step (a)(b)(c) of the ticket's required order: (a) ALWAYS capture ONE coherent snapshot first,
  // (b) ALWAYS refresh BOTH freshness timestamps + recover accountSyncState on VALIDATED (independent of
  // any trade event — this IS how the admission<->event circular dependency is broken), (c) ALWAYS check
  // for unknown/manual exchange exposure even when this bot owns zero positions. Step (d) — the
  // protective-order sweep itself — is each caller's own decision (see runAccountSyncCycleTickBody vs.
  // the read-only startup bootstrap below), never bundled in here.
  async function captureAndApplyFreshnessSnapshot(): Promise<CoherentReconciliationSnapshotResult> {
    const now = Date.now();
    const snapshotResult = await captureCoherentReconciliationSnapshotWithRetry(executor, {
      incomeWindowStartMs: now - ACCOUNT_SYNC_CYCLE_INTERVAL_MS * 2,
      incomeWindowEndMs: now,
    });
    if (snapshotResult.status !== 'VALIDATED') {
      if (accountSyncState === 'SYNCED') {
        accountSyncState = 'ACCOUNT_STATE_UNKNOWN';
        console.error(`[ACCOUNT_STATE_UNKNOWN] chu kỳ đồng bộ tài khoản thất bại (${snapshotResult.status}) — CHẶN mở lệnh mới TOÀN PORTFOLIO. Chi tiết: ${snapshotResult.detail}`);
        telegramQueue.enqueue('⚠️ [ACCOUNT_STATE_UNKNOWN] Chu kỳ đồng bộ tài khoản thất bại — ĐÃ CHẶN mở lệnh mới TOÀN BỘ 4 coin cho tới khi đồng bộ lại thành công.');
      }
      return snapshotResult;
    }

    // TICKET-G1R-A "Final Internal Closure" item 1 — THE CONFIRMED BUG FIX. This used to set
    // `lastSuccessfulBalanceReadMs = Date.now()` while NEVER parsing/applying
    // `snapshotResult.snapshot.balance.data`, so the timestamp advertised "fresh" for a balance VALUE
    // that was never updated. Now the value is parsed with the canonical parser and applied
    // ATOMICALLY with its provenance and freshness timestamp — and if the parse FAILS, the freshness
    // timestamp is deliberately left untouched so the normal staleness check blocks admission.
    const balanceLeg = snapshotResult.snapshot.balance;
    const applied = parseAndApplyBalance(balanceLeg.data, `snapshot:${balanceLeg.source}`, balanceLeg.capturedAt);
    if (applied === null) {
      if (accountSyncState === 'SYNCED') {
        accountSyncState = 'ACCOUNT_STATE_UNKNOWN';
        console.error('[ACCOUNT_STATE_UNKNOWN] snapshot VALIDATED nhưng parse/apply balance THẤT BẠI — CHẶN mở lệnh mới TOÀN PORTFOLIO, KHÔNG đánh dấu balance fresh.');
        telegramQueue.enqueue('⚠️ [ACCOUNT_STATE_UNKNOWN] Snapshot hợp lệ nhưng không đọc được số dư — ĐÃ CHẶN mở lệnh mới toàn portfolio.');
      }
      return snapshotResult;
    }

    lastSuccessfulAccountSyncCycleMs = Date.now();

    // item 4 — accountSyncState self-heals from a VALIDATED snapshot alone, no trade event required
    // (this is the direct fix for the "admission cần event → event cần admission" circular dependency).
    if (accountSyncState === 'ACCOUNT_STATE_UNKNOWN') {
      accountSyncState = 'SYNCED';
      console.log('[ACCOUNT_STATE_SYNCED] snapshot đồng bộ tài khoản VALIDATED (định kỳ/bootstrap) — bỏ chặn admission toàn portfolio.');
      telegramQueue.enqueue('✅ [ĐÃ ĐỒNG BỘ LẠI] Snapshot tài khoản VALIDATED — đã bỏ chặn mở lệnh mới toàn portfolio.');
    }

    // item 2 — unknown/manual exposure check: MUST run even when this bot owns zero positions on a
    // symbol/side (positions.length === 0 must never skip this). Reuses Checkpoint C's exact ownership-
    // proof decision function (decideSideRecovery) — anything the exchange reports with no matching
    // internal record fails the proof and is quarantined, same QUARANTINED/PENDING_RECONCILIATION
    // pattern as startup restart recovery, never silently adopted/ignored.
    const rawPositionsForExposureCheck = snapshotResult.snapshot.positions.data as Array<{ symbol?: string; positionAmt?: string }>;
    for (const symbol of SYMBOLS) {
      if (entriesBlockedDueToRestartQuarantineBySymbol.has(symbol)) continue;
      const rs = runnerState[symbol];
      for (const side of ['LONG', 'SHORT'] as PositionSide[]) {
        const persistedEntries = rs.symbolState.openPositions.filter((e) => e.position.side === side);
        let exchangeBaseQty = 0;
        for (const p of rawPositionsForExposureCheck) {
          if (p.symbol !== symbol) continue;
          const amt = Number(p.positionAmt);
          if (!Number.isFinite(amt)) continue;
          if (side === 'LONG' && amt > 0) exchangeBaseQty += amt;
          if (side === 'SHORT' && amt < 0) exchangeBaseQty += Math.abs(amt);
        }
        const decision = decideSideRecovery({ persistedEntries, exchangeBaseQty, quantityTolerance: quantityToleranceBySymbol[symbol] });
        if (decision.status === 'QUARANTINED') {
          entriesBlockedDueToRestartQuarantineBySymbol.add(symbol);
          console.error(`[UNKNOWN_EXPOSURE_DETECTED] ${symbol} ${side}: ${decision.detail} — CHẶN mở lệnh mới trên ${symbol}.`);
          telegramQueue.enqueue(`⚠️ [PENDING_RECONCILIATION] ${symbol} ${side}: phát hiện vị thế không rõ nguồn gốc khi đồng bộ tài khoản — ĐÃ CHẶN mở lệnh mới trên ${symbol}. ${decision.detail}`);
        }
      }
    }

    return snapshotResult;
  }

  // TICKET-G1R-B (Runtime Wiring Pass) items 1+2+3 — the in-run protective-order (SL/TP) monitor,
  // powered by ONE periodic coherent snapshot (captureAndApplyFreshnessSnapshot above +
  // runProtectiveOrderMonitorSweep/liveStateSync.ts). Runs on its OWN timer
  // (ACCOUNT_SYNC_CYCLE_INTERVAL_MS), never the 5s tick loop — a single whole-account
  // getOpenAlgoOrders() call per cycle covers every symbol, filtered in memory below (never N
  // per-symbol calls). Only ever touches positions already inside symbolState.openPositions (ownership
  // VERIFIED) — entriesBlockedDueToRestartQuarantineBySymbol is excluded up front, exactly like every
  // other quarantine-respecting call site in this file.
  function buildProtectiveMonitorInputs(): ProtectiveMonitorPositionInput[] {
    const inputs: ProtectiveMonitorPositionInput[] = [];
    for (const symbol of SYMBOLS) {
      if (entriesBlockedDueToRestartQuarantineBySymbol.has(symbol)) continue;
      const rs = runnerState[symbol];
      for (const entry of rs.symbolState.openPositions) {
        const ids = rs.orderIds.get(entry.meta.entryTimestamp);
        inputs.push({
          symbol,
          side: entry.position.side,
          entryTimestamp: entry.meta.entryTimestamp,
          remainingPositionSize: entry.position.remainingPositionSize,
          positionSize: entry.position.positionSize,
          entryPrice: entry.position.entryPrice,
          currentSlPrice: entry.position.currentSlPrice,
          tpLevels: entry.position.tpLevels,
          filledTiers: entry.position.filledTiers,
          slAlgoId: ids?.slAlgoId ?? null,
          tpAlgoIds: ids?.tpAlgoIds ?? [],
          quantityTolerance: quantityToleranceBySymbol[symbol],
        });
      }
    }
    return inputs;
  }

  /**
   * THE real periodic call — this is the function under test in g1rRuntimeWiringFix.test.ts's
   * "runtime path uses the real snapshot" behavior tests (mocked executor, same shape as every other
   * exported liveStateSync.ts function this file wires). Missing/wrong SL -> bounded recovery ->
   * EMERGENCY_CLOSE/OPERATOR_REQUIRED quarantine via the SAME Set/removal-from-openPositions mechanism
   * as the startup path and every other quarantine trigger. TP findings are ALWAYS logged as WARNING,
   * never escalate, and are only ever considered after SL's own outcome for that position is decided
   * (see verifyOnePositionProtectiveOrders's own doc comment) — SL's message is therefore always
   * emitted before/instead-of TP's for the same position.
   */
  // TICKET-G1R-A "Freshness Bootstrap Hotfix" item 2 — THE confirmed-bug fix, restructured per the
  // ticket's exact required order: (a) capture snapshot ALWAYS (delegated to
  // captureAndApplyFreshnessSnapshot, which ALSO does (b) freshness timestamps and (c) unknown-exposure
  // check, unconditionally — never gated on positions.length); (d) the protective-order SWEEP itself is
  // the ONLY part that's actually optional when positions.length === 0 (nothing bot-owned to verify
  // SL/TP for) — this is now a step-(d) optimization, never an early-return that skips (a)(b)(c).
  // `inStartupBootstrapPhase` (true only for the ONE synchronous bootstrap call below, via the SAME
  // single-flight guard the periodic timer uses — see item 5's overlap-safety requirement) skips step
  // (d) unconditionally even when positions.length > 0 — bootstrap must never place/repair an order,
  // per the ticket's explicit "đây là bootstrap để lấy freshness ban đầu, không phải một
  // protective-repair cycle". Flipped to false right after the bootstrap call returns, forever after.
  let inStartupBootstrapPhase = true;
  async function runAccountSyncCycleTickBody(): Promise<CoherentReconciliationSnapshotResult['status']> {
    const snapshotResult = await captureAndApplyFreshnessSnapshot();
    if (snapshotResult.status !== 'VALIDATED') return snapshotResult.status;
    if (inStartupBootstrapPhase) return snapshotResult.status; // bootstrap: freshness/exposure only, no repair sweep

    const positions = buildProtectiveMonitorInputs();
    if (positions.length === 0) return snapshotResult.status; // nothing bot-owned to verify SL/TP for — freshness/exposure already handled above
    const now = Date.now();

    const sweepResults = await runProtectiveOrderMonitorSweep({
      executor,
      positions,
      policy: MISSING_PROTECTIVE_SL_FAILSAFE_POLICY,
      openAlgoOrders: snapshotResult.snapshot.protectiveOrders.data,
    });

    // TICKET-G1R-A "Final Safety Hotfix" item 4 — same-side merged-position safety, wired from THIS
    // cycle's own already-fetched snapshot legs (positions + protectiveOrders — zero extra network
    // calls). Only relevant for 2+ same-side logical entries on one symbol (Checkpoint C's own merged-
    // qty limitation). A qty mismatch flips accountSyncState (same sentinel, whole-portfolio block);
    // a match (VERIFIED_SPLIT/UNVERIFIED_SPLIT) is logged only — exposure already never drops from the
    // risk ledger regardless (each entry's own remainingBaseQty keeps flowing into rebuildPortfolioRisk
    // unconditionally), per checkMergedPositionAllocation()'s own contract.
    const rawPositions = snapshotResult.snapshot.positions.data as Array<{ symbol?: string; positionAmt?: string }>;
    const rawProtectiveOrders = snapshotResult.snapshot.protectiveOrders.data;
    for (const symbol of SYMBOLS) {
      const rs = runnerState[symbol];
      for (const side of ['LONG', 'SHORT'] as PositionSide[]) {
        const sideEntries = rs.symbolState.openPositions.filter((e) => e.position.side === side);
        if (sideEntries.length < 2) continue; // nothing to reconcile — merged-qty ambiguity only exists with 2+ entries
        const exchangeBaseQty = Math.abs(Number(rawPositions.find((p) => p.symbol === symbol)?.positionAmt ?? '0'));
        const persistedEntries = sideEntries.map((e) => ({ id: String(e.meta.entryTimestamp), remainingBaseQty: e.position.remainingPositionSize / e.position.entryPrice }));
        const slAlgoIds = sideEntries.map((e) => rs.orderIds.get(e.meta.entryTimestamp)?.slAlgoId ?? null);
        let protectiveTotalBaseQty: number | null = null;
        if (slAlgoIds.every((id): id is number => id !== null)) {
          const uniqueSlOrders = Array.from(new Set(slAlgoIds)).map((id) => rawProtectiveOrders.find((o) => o.algoId === id));
          if (uniqueSlOrders.every((o): o is (typeof rawProtectiveOrders)[number] => o !== undefined)) {
            protectiveTotalBaseQty = uniqueSlOrders.reduce((sum, o) => sum + o.origQty, 0);
          }
        }
        const check = checkMergedPositionAllocation({ persistedEntries, exchangeBaseQty, protectiveTotalBaseQty, quantityTolerance: quantityToleranceBySymbol[symbol] });
        if (check.status === 'ACCOUNT_STATE_UNKNOWN') {
          if (accountSyncState === 'SYNCED') {
            accountSyncState = 'ACCOUNT_STATE_UNKNOWN';
            console.error(`[ACCOUNT_STATE_UNKNOWN] ${symbol} ${side}: merged same-side position qty không khớp — CHẶN mở lệnh mới TOÀN PORTFOLIO. Chi tiết: ${check.reason}`);
            telegramQueue.enqueue(`⚠️ [ACCOUNT_STATE_UNKNOWN] ${symbol} ${side}: merged-position qty mismatch — ĐÃ CHẶN mở lệnh mới TOÀN BỘ 4 coin. ${check.reason}`);
          }
        } else if (check.allocationQuality === 'UNVERIFIED_SPLIT') {
          console.warn(`[MERGED_POSITION_UNVERIFIED_SPLIT] ${symbol} ${side}: ${sideEntries.length} logical entries chia sẻ 1 merged exchange qty=${exchangeBaseQty} — tổng khớp, per-entry split giữ nguyên (không đoán lại), không chặn.`);
        }
      }
    }

    let stateChanged = false;
    for (const posResult of sweepResults) {
      const rs = runnerState[posResult.symbol];
      const ids = rs.orderIds.get(posResult.entryTimestamp);
      const entry = rs.symbolState.openPositions.find((e) => e.meta.entryTimestamp === posResult.entryTimestamp);

      // SL outcome logged/applied FIRST, unconditionally, before this position's TP findings below —
      // satisfies "SL CRITICAL không bị TP WARNING che khuất".
      if (posResult.sl.status === 'RECOVERED') {
        if (ids) ids.slAlgoId = posResult.sl.newSlAlgoId;
        // item 1 — a prior cycle may have marked this PROTECTION_DEGRADED; a real recovery now
        // un-degrades it (never resets silently — this IS the "repair succeeded" transition).
        if (entry) entry.meta.protectionStatus = 'PROTECTED';
        console.log(`[PROTECTIVE_SL_RECOVERED_IN_RUN] ${posResult.symbol} ${posResult.side}: ${posResult.sl.detail}`);
        telegramQueue.enqueue(`✅ [SL PHỤC HỒI (in-run)] ${posResult.symbol} ${posResult.side}: ${posResult.sl.detail}`);
        stateChanged = true;
      } else if (posResult.sl.status === 'QUARANTINE') {
        // Confirmed-closed (verified qty=0 via getPositionRisk() — see recoverMissingProtectiveSl's
        // item 2 fix) — genuinely gone, safe to remove from the ledger/ownership.
        console.error(`[PROTECTIVE_SL_${posResult.sl.reason}_IN_RUN] ${posResult.symbol} ${posResult.side}: ${posResult.sl.detail}`);
        telegramQueue.enqueue(`🚨 [EMERGENCY_CLOSE (in-run)] ${posResult.symbol} ${posResult.side}: ${posResult.sl.detail}`);
        entriesBlockedDueToRestartQuarantineBySymbol.add(posResult.symbol);
        rs.symbolState.openPositions = rs.symbolState.openPositions.filter((e) => e.meta.entryTimestamp !== posResult.entryTimestamp);
        rs.orderIds.delete(posResult.entryTimestamp);
        stateChanged = true;
      } else if (posResult.sl.status === 'PROTECTION_DEGRADED') {
        // TICKET-G1R-A "Final Safety Hotfix" item 1 (THE confirmed bug fix) — OPERATOR_REQUIRED and a
        // failed/unverified emergency close are NOT treated like a confirmed close: the position is
        // STILL open on the exchange with NO verified SL. It stays in openPositions/orderIds (never
        // removed here) so it (a) keeps being retried next cycle — buildProtectiveMonitorInputs only
        // excludes entriesBlockedDueToRestartQuarantineBySymbol, which this status never joins — and
        // (b) keeps contributing its real risk to rebuildPortfolioRisk(). Portfolio-wide admission
        // block comes from hasAnyProtectionDegradedPosition() (see the tick loop), not from this Set.
        if (entry) {
          entry.meta.protectionStatus = 'PROTECTION_DEGRADED';
          // item 2 — partial-fill canonical update: a confirmed nonzero residual after a market-close
          // ATTEMPT is the new true remaining exposure, never the stale pre-close notional.
          if (posResult.sl.reason === 'EMERGENCY_CLOSE_FAILED' && posResult.sl.residualBaseQty !== null && posResult.sl.residualBaseQty > 0) {
            entry.position.remainingPositionSize = posResult.sl.residualBaseQty * entry.position.entryPrice;
          }
        }
        console.error(`[PROTECTIVE_SL_${posResult.sl.reason}_IN_RUN] ${posResult.symbol} ${posResult.side}: ${posResult.sl.detail}`);
        // Throttled CRITICAL resend (item 1's explicit anti-spam requirement) — same
        // Map-keyed-by-position pattern as balanceDivergenceWarningSent's boolean, generalized per key
        // since multiple positions can be independently degraded at once.
        const alertKey = `${posResult.symbol}:${posResult.entryTimestamp}`;
        const lastSentMs = protectionDegradedAlertLastSentMsByKey.get(alertKey) ?? 0;
        if (now - lastSentMs >= PROTECTION_DEGRADED_ALERT_RESEND_MS) {
          protectionDegradedAlertLastSentMsByKey.set(alertKey, now);
          telegramQueue.enqueue(`🚨🚨 [CRITICAL — CẦN CAN THIỆP THỦ CÔNG (in-run)] ${posResult.symbol} ${posResult.side}: ${posResult.sl.detail}`);
        }
        stateChanged = true;
      } else if (entry && entry.meta.protectionStatus === 'PROTECTION_DEGRADED' && (posResult.sl.status === 'VERIFIED' || posResult.sl.status === 'NO_PERSISTED_ORDERS')) {
        // Defensive: a position that WAS degraded but this cycle's fresh verify says VERIFIED (e.g. an
        // operator manually fixed the SL out-of-band) also clears the flag — recovery isn't only
        // reachable via the RECOVERED branch above.
        entry.meta.protectionStatus = 'PROTECTED';
        protectionDegradedAlertLastSentMsByKey.delete(`${posResult.symbol}:${posResult.entryTimestamp}`);
        stateChanged = true;
      }

      for (const finding of posResult.tpFindings) {
        console.warn(`[PROTECTIVE_TP_${finding.kind}_IN_RUN] ${posResult.symbol} ${posResult.side} tier=${finding.tier} algoId=${finding.tpAlgoId}: ${finding.detail}`);
        telegramQueue.enqueue(`⚠️ [TP CẢNH BÁO (in-run)] ${posResult.symbol} ${posResult.side} ${finding.tier}: ${finding.detail}`);
      }
    }
    if (stateChanged) persistLiveState();
    return snapshotResult.status;
  }
  // TICKET-G1R-A "Final Safety Hotfix" item 3 — single-flight guard: if a cycle is still running when
  // the timer fires again (e.g. a prior cycle hung longer than ACCOUNT_SYNC_CYCLE_INTERVAL_MS), the
  // new invocation SKIPS entirely rather than running a second cycle concurrently (which could double
  // place/close orders for the same position). See createSingleFlightRunner's own doc comment for the
  // `finally`-guaranteed lock release.
  // TICKET-G1R-A "Freshness Bootstrap Hotfix" item 1/5 — the SAME single-flight instance is reused for
  // BOTH the one-time startup bootstrap call (below, before the tick loop starts) and every periodic
  // timer firing — this is what guarantees they never run concurrently/double (item 5's required test).
  const accountSyncCycleSingleFlight = createSingleFlightRunner(runAccountSyncCycleTickBody);
  async function runAccountSyncCycleTick(): Promise<void> {
    const outcome = await accountSyncCycleSingleFlight.run();
    if (outcome.skipped) {
      console.warn('[ACCOUNT_SYNC_CYCLE_SKIPPED] chu kỳ giám sát SL/TP trước vẫn đang chạy — bỏ qua lần gọi này (single-flight, không chạy chồng).');
    }
  }

  // TICKET-G1R-A "Freshness Bootstrap Hotfix" item 1 — startup shutdown safety net: SIGINT/SIGTERM
  // received while the synchronous bootstrap call below is still awaiting must NOT hang the process.
  // This early handler is intentionally minimal (nothing else has started yet — no feed/tickTimer/
  // reconciler) and is REPLACED by the full shutdown handler once main() finishes startup (see below).
  // Reuses the exact bounded-wait-then-exit pattern "Final Safety Hotfix" item 3 already established.
  let earlyShutdownInProgress = false;
  async function earlyBootstrapShutdown(): Promise<void> {
    if (earlyShutdownInProgress) return;
    earlyShutdownInProgress = true;
    console.log('Đang dừng liveRunner (SIGINT/SIGTERM) trong lúc bootstrap khởi động...');
    const deadlineMs = Date.now() + 30_000;
    while (accountSyncCycleSingleFlight.isInFlight() && Date.now() < deadlineMs) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (accountSyncCycleSingleFlight.isInFlight()) {
      console.warn('[SHUTDOWN] bootstrap vẫn chưa xong sau 30s chờ — thoát tiến trình dù vậy (đã log rõ, không chờ vô hạn).');
    }
    try {
      await telegramQueue.flush();
    } catch {
      // best-effort during an early/aborted startup — never let a flush failure block exit.
    }
    process.exit(0);
  }
  const earlyShutdownSigintHandler = (): void => void earlyBootstrapShutdown();
  const earlyShutdownSigtermHandler = (): void => void earlyBootstrapShutdown();
  process.on('SIGINT', earlyShutdownSigintHandler);
  process.on('SIGTERM', earlyShutdownSigtermHandler);

  // TICKET-G1R-A "Freshness Bootstrap Hotfix" item 1 — THE fix's core requirement: run ONE synchronous
  // account reconciliation cycle NOW, before the candle/admission tick loop (and the periodic timer)
  // ever starts — never waiting for accountSyncCycleTimer's first ACCOUNT_SYNC_CYCLE_INTERVAL_MS firing.
  // Read-only (inStartupBootstrapPhase gates out the repair sweep — see runAccountSyncCycleTickBody's
  // own doc comment); real SL/TP repair, if actually needed at startup, already happened via the
  // separate recoverMissingProtectiveSl() loop above (before accountSyncState was even declared).
  console.log('[STARTUP_BOOTSTRAP] Đang chạy đồng bộ tài khoản lần đầu (đồng bộ, TRƯỚC vòng lặp chính) để thiết lập freshness ban đầu...');
  const bootstrapOutcome = await accountSyncCycleSingleFlight.run();
  inStartupBootstrapPhase = false; // periodic timer firings from here on run the FULL cycle (freshness + repair sweep)
  if (bootstrapOutcome.skipped || bootstrapOutcome.result !== 'VALIDATED') {
    // Fail-safe per the ticket's explicit rule (same convention as restartRecovery.ok above): never
    // start the trading loop on an unknown/unvalidated account state.
    throw new Error(
      `liveRunner: bootstrap đồng bộ tài khoản lúc khởi động thất bại (${bootstrapOutcome.skipped ? 'SKIPPED — không thể xảy ra lúc khởi động (single-flight đang bận)' : bootstrapOutcome.result}) — dừng khởi động, KHÔNG giao dịch với freshness chưa xác định.`,
    );
  }
  console.log(
    `[STARTUP_BOOTSTRAP] VALIDATED — freshness ban đầu đã thiết lập (lastSuccessfulBalanceReadMs=${lastSuccessfulBalanceReadMs}, lastSuccessfulAccountSyncCycleMs=${lastSuccessfulAccountSyncCycleMs}, accountSyncState=${accountSyncState}). Bắt đầu vòng lặp chính.`,
  );
  // Bootstrap handler done its job — hand shutdown duties to the full handler installed further below
  // (which also stops feed/reconciler/timers, none of which exist yet at this point in startup).
  process.removeListener('SIGINT', earlyShutdownSigintHandler);
  process.removeListener('SIGTERM', earlyShutdownSigtermHandler);

  const accountSyncCycleTimer = setInterval(() => void runAccountSyncCycleTick(), ACCOUNT_SYNC_CYCLE_INTERVAL_MS);

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
      emitTelemetry({ traceId: stableTelemetryId('reconcile', result.timestamp), symbol: 'PORTFOLIO', side: 'NONE', setupType: 'NOT_APPLICABLE', eventType: 'POSITION_RECONCILED', eventTimestampUtc: new Date(result.timestamp).toISOString(), source: 'STATE_RECONCILER', quality: { internalState: 'DERIVED', exchangeState: 'OBSERVED' }, data: { status: 'MISMATCH', mismatches: result.mismatches, internalBalanceUsd: result.internalBalanceUsd, exchangeBalanceUsd: result.exchangeBalanceUsd, internalPositions: result.internalPositions, exchangePositions: result.exchangePositions } });
      console.warn(`[RECONCILE_MISMATCH] ${result.mismatches.length} lệch được phát hiện:`);
      for (const m of result.mismatches) console.warn(`  - ${m.type}: ${m.detail}`);

      // TICKET-102 — ưu tiên cao nhất: BALANCE_MISMATCH không chỉ log, ghi đè NGAY accountBalance
      // bằng đúng số Sàn (result.exchangeBalanceUsd) trước khi tick tiếp theo dùng số này để tính
      // size/risk$/gửi Telegram. resolveAccountBalanceAfterReconcile() là hàm thuần (testable riêng),
      // trả về currentBalance không đổi nếu không có BALANCE_MISMATCH.
      const oldBalance = accountBalance;
      const reconciledBalance = resolveAccountBalanceAfterReconcile(accountBalance, result);
      if (reconciledBalance !== oldBalance) {
        // item 1 — exchange-derived, so it goes through the SAME single apply path (provenance +
        // freshness + anti-time-travel), not a bare assignment.
        balanceObservationCounter += 1;
        applyBalanceObservation({ walletBalance: reconciledBalance, capturedAt: result.timestamp, source: 'reconciler:BALANCE_MISMATCH', requestId: `bal-${result.timestamp}-${balanceObservationCounter}` });
        console.warn(`[RECONCILE_BALANCE_OVERRIDE] accountBalance ghi đè theo đúng số Sàn: $${oldBalance.toFixed(2)} → $${accountBalance.toFixed(2)}`);
      }

      // TICKET — Exchange-Authoritative Live Balance §7: this periodic reconciler runs on its OWN
      // timer (not the frozen tick loop below), so it's the only thing that can UN-block entries once
      // a per-event divergence froze the tick loop entirely. Cleared only when THIS cycle shows no
      // BALANCE_MISMATCH — the per-event block is a stricter, event-level check than this sweep's
      // own tolerance, so this is a conservative "confirmed OK now" signal, not a weaker override.
      if (entriesBlockedDueToBalanceDivergence && !result.mismatches.some((m) => m.type === 'BALANCE_MISMATCH')) {
        entriesBlockedDueToBalanceDivergence = false;
        balanceDivergenceWarningSent = false;
        console.log('[BALANCE_DIVERGENCE_RESOLVED] đối soát định kỳ xác nhận số dư đã khớp — bỏ chặn lệnh mới.');
        telegramQueue.enqueue('✅ [ĐỐI SOÁT SỐ DƯ OK] Số dư nội bộ đã khớp lại với sàn — đã bỏ chặn lệnh mới.');
      }

      console.log(`[SUMMARY] regimeChangeCount=${regimeChangeCount}, willOpenCount(dryRun)=${willOpenCount}, tickErrorCount=${tickErrorCount}, oodGuardEnabled=${OOD_GUARD_ENABLED}, oodGuardShortEvalCount=${oodGuardShortEvalCount}, oodGuardFlaggedCount=${oodGuardFlaggedCount}, oodGuardFlaggedPassedCount=${oodGuardFlaggedPassedCount}`);

      // TICKET-151 P0-C — active reconcile ONLY for POSITION_MISSING_ON_EXCHANGE, decided directly
      // from this cycle's exchangePositions/internal openPositions (not by parsing `mismatch.detail`
      // strings). Side mismatch / size mismatch stay exactly log-only, unchanged — same TICKET-102
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
      // TICKET-G1R Checkpoint C (G1-F14) — POSITION_MISSING_INTERNALLY: the exchange has a position
      // this bot's runtime state doesn't know about (a startup-quarantined position resurfacing here
      // too, a manual trade, or a real bot bug). Same "never auto-adopt/close/cancel" rule as the
      // startup restart recovery — quarantine only (permanent per-symbol block, same Set the startup
      // path populates), decided directly from exchangePositions/internal openPositions, never by
      // parsing `mismatch.detail` strings.
      if (result.mismatches.some((m) => m.type === 'POSITION_MISSING_INTERNALLY')) {
        for (const symbol of SYMBOLS) {
          const hasInternal = runnerState[symbol].symbolState.openPositions.length > 0;
          const hasExchange = result.exchangePositions.some((p) => p.symbol === symbol);
          if (hasExchange && !hasInternal && !entriesBlockedDueToRestartQuarantineBySymbol.has(symbol)) {
            entriesBlockedDueToRestartQuarantineBySymbol.add(symbol);
            console.error(`[RUNTIME_QUARANTINE] ${symbol}: sàn có vị thế mà bot không có bản ghi nội bộ (POSITION_MISSING_INTERNALLY) — KHÔNG tự nhận quản lý, chuyển PENDING_RECONCILIATION, chặn mở lệnh mới trên ${symbol}.`);
            telegramQueue.enqueue(`⚠️ [PENDING_RECONCILIATION] ${symbol}: phát hiện vị thế trên sàn không rõ nguồn gốc trong lúc chạy — ĐÃ CHẶN mở lệnh mới trên ${symbol}, cần kiểm tra thủ công.`);
          }
        }
      }
    },
    onClean: () => {
      console.log(`[RECONCILE] OK — nội bộ khớp với sàn.`);
      if (entriesBlockedDueToBalanceDivergence) {
        entriesBlockedDueToBalanceDivergence = false;
        balanceDivergenceWarningSent = false;
        console.log('[BALANCE_DIVERGENCE_RESOLVED] đối soát định kỳ xác nhận số dư đã khớp — bỏ chặn lệnh mới.');
        telegramQueue.enqueue('✅ [ĐỐI SOÁT SỐ DƯ OK] Số dư nội bộ đã khớp lại với sàn — đã bỏ chặn lệnh mới.');
      }
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
    clearInterval(accountSyncCycleTimer);
    // TICKET-G1R-A "Final Safety Hotfix" item 3 — clear the timer FIRST (no new cycle can start), then
    // wait briefly for an in-flight cycle to finish on its own (never force-kill mid-repair — a half-
    // finished SL recovery is worse than a slightly slower shutdown). Bounded wait, not indefinite —
    // logs clearly and exits anyway if the cycle is still running after the deadline.
    if (accountSyncCycleSingleFlight.isInFlight()) {
      console.log('Đang chờ chu kỳ giám sát SL/TP hiện tại hoàn tất trước khi thoát...');
      const deadlineMs = Date.now() + 30_000;
      while (accountSyncCycleSingleFlight.isInFlight() && Date.now() < deadlineMs) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (accountSyncCycleSingleFlight.isInFlight()) {
        console.warn('[SHUTDOWN] chu kỳ giám sát SL/TP vẫn chưa xong sau 30s chờ — thoát tiến trình dù vậy (đã log rõ, không chờ vô hạn).');
      }
    }
    reconciler.stop();
    feed.stop();
    await telegramQueue.flush();
    emitTelemetry({ traceId: stableTelemetryId('health', telemetry.getSessionId(), 'shutdown'), symbol: 'SYSTEM', side: 'NONE', setupType: 'NOT_APPLICABLE', eventType: 'TELEMETRY_HEALTH', source: 'LIVE_RUNNER', quality: { counters: 'OBSERVED' }, data: { ...telemetry.health } });
    await telemetry.close();
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
