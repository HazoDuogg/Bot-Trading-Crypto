import 'dotenv/config';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { loadBinanceEnvConfig } from '../dist/live/envConfig.js';
import { BinanceOrderExecutor } from '../dist/live/binanceOrderExecutor.js';
import { handleOpenEvent, type LiveOrderIds, type RunnerStateAccess } from '../dist/live/liveLifecycle.js';
import { readLiveStateFileSafe, writeLiveStateFileAtomic, performStartupRestartRecovery, LIVE_STATE_SCHEMA_VERSION } from '../dist/live/liveStateSync.js';
import { DynamicRMarginSizer } from '../dist/risk/dynamicRMarginSizer.js';
import { computeTpLevels, openPosition } from '../dist/risk/slTpManager.js';
import { MarketRegime } from '../dist/regime/types.js';
import { INITIAL_SYMBOL_STATE, type OpenTradeEvent } from '../dist/orchestrator/types.js';

const SYMBOL = 'BTCUSDT';
const LEVERAGE = 30;
const FIXED_RISK_USD = 20;
const MAX_MARGIN_CAP = 37.5;
const SL_DISTANCE_PCT = 0.0127;
const TAKER_FEE_RATE = 0.0004;
const STATE_PATH = path.resolve(process.cwd(), 'data/live-state/r4-canary-state.json');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tickerPrice(baseUrl: string): Promise<number> {
  const response = await fetch(`${baseUrl}/fapi/v1/ticker/price?symbol=${SYMBOL}`);
  if (!response.ok) throw new Error(`TICKER_HTTP_${response.status}`);
  const price = Number(((await response.json()) as { price?: unknown }).price);
  if (!Number.isFinite(price) || price <= 0) throw new Error('TICKER_PRICE_INVALID');
  return price;
}

async function readExposure(executor: BinanceOrderExecutor): Promise<{ qty: number; entryPrice: number }> {
  const raw = await executor.getPositionRisk(SYMBOL);
  if (!Array.isArray(raw)) throw new Error('POSITION_RISK_INVALID');
  const row = raw.find((entry) => typeof entry === 'object' && entry !== null && (entry as { symbol?: unknown }).symbol === SYMBOL) as { positionAmt?: unknown; entryPrice?: unknown } | undefined;
  if (!row) throw new Error('BTC_POSITION_ROW_MISSING');
  const qty = Number(row.positionAmt);
  const entryPrice = Number(row.entryPrice);
  if (!Number.isFinite(qty) || !Number.isFinite(entryPrice)) throw new Error('BTC_POSITION_VALUES_INVALID');
  return { qty, entryPrice };
}

async function waitForFlat(executor: BinanceOrderExecutor): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (Math.abs((await readExposure(executor)).qty) < 1e-10) return true;
    await sleep(250);
  }
  return false;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const { env, baseUrl, apiKey, apiSecret } = loadBinanceEnvConfig();
  if (env !== 'testnet' || baseUrl !== 'https://testnet.binancefuture.com') throw new Error('TESTNET_ISOLATION_FAILED');
  const executor = new BinanceOrderExecutor({ credentials: { baseUrl, apiKey, apiSecret }, dryRun: false });
  await executor.syncClock();
  await executor.loadExchangeInfo([SYMBOL]);
  const filters = executor.getSymbolFilters(SYMBOL);
  const baseline = await readExposure(executor);
  if (baseline.qty !== 0) throw new Error(`BASELINE_NOT_FLAT_${baseline.qty}`);
  if ((await executor.getOpenOrders(SYMBOL)).length !== 0 || (await executor.getOpenAlgoOrders(SYMBOL)).length !== 0) throw new Error('BASELINE_ORDERS_NOT_EMPTY');
  if ((await executor.getPositionMode()).dualSidePosition !== false) throw new Error('NOT_ONE_WAY');

  const account = (await executor.getAccountInfo()) as { totalWalletBalance?: unknown };
  const balance = Number(account.totalWalletBalance);
  if (!Number.isFinite(balance) || balance <= 0 || balance * 0.15 < FIXED_RISK_USD) throw new Error('BALANCE_OR_RISK_POOL_INVALID');
  const price = await tickerPrice(baseUrl);
  const slPrice = price * (1 - SL_DISTANCE_PCT);
  const sizing = new DynamicRMarginSizer().calculate({ accountBalance: balance, entryPrice: price, riskDollarOrPercent: FIXED_RISK_USD, leverage: LEVERAGE, slDistancePercent: SL_DISTANCE_PCT, maxMarginCap: MAX_MARGIN_CAP });
  const entryTimestamp = Date.now();
  const event: OpenTradeEvent = {
    type: 'OPEN', symbol: SYMBOL, side: 'LONG', regime: MarketRegime.TREND_RIDER, setupType: 'OB', tpPlan: 'PLAN_A', entryTimestamp,
    entryPrice: price, riskMultiplier: 1, actualRiskDollar: sizing.actualRiskDollar, marginRequired: sizing.marginRequired, slPrice,
    tpLevels: computeTpLevels({ scenario: 'TREND', entryPrice: price, slPrice, side: 'LONG', tpPlan: 'PLAN_A' }), riskPoolPctBefore: 0,
    riskPoolPctAfter: (sizing.actualRiskDollar / balance) * 100,
  };

  const orderIds = new Map<number, LiveOrderIds>();
  const runnerState: RunnerStateAccess = {
    getOpenPositionCount: () => 0,
    setOrderIds: (_symbol, timestamp, ids) => orderIds.set(timestamp, ids),
    getOrderIds: (_symbol, timestamp) => orderIds.get(timestamp),
    deleteOrderIds: (_symbol, timestamp) => { orderIds.delete(timestamp); },
    blockSymbolAdmission: () => undefined,
  };
  let outcome: Awaited<ReturnType<typeof handleOpenEvent>> | null = null;
  let restartVerified = false;
  let cleanupFlat = false;
  let cleanupOrdersEmpty = false;
  try {
    outcome = await handleOpenEvent({
      executor,
      dryRun: false,
      envLabel: 'testnet',
      leverage: LEVERAGE,
      quantityToleranceBySymbol: { [SYMBOL]: filters.stepSize / 2 },
      missingProtectiveSlFailsafePolicy: 'OPERATOR_REQUIRED',
      oodGuardEnabled: false,
      runnerState,
      emitTelemetry: () => undefined,
      enqueueTelegram: () => undefined,
      refreshBalanceForTelegram: async () => null,
      onAccountSyncUnknown: () => undefined,
      onWillOpen: () => undefined,
      persistLiveState: () => true,
    }, SYMBOL, event, balance);
    if (outcome.kind !== 'FILLED') throw new Error(`ENTRY_OUTCOME_${outcome.kind}`);
    if (!outcome.reconciled.ok || !outcome.geometryValid || outcome.protection.status !== 'PROTECTED') throw new Error('FILLED_NOT_SAFELY_PROTECTED');
    const ids = orderIds.get(entryTimestamp);
    if (!ids || ids.slAlgoId === null || ids.tpAlgoIds.length === 0) throw new Error('PROTECTIVE_IDS_MISSING');
    const exposure = await readExposure(executor);
    if (exposure.qty <= 0) throw new Error('POST_FILL_EXPOSURE_MISSING');
    const managed = openPosition({ scenario: 'TREND', entryPrice: outcome.reconciled.entryPrice, slPrice, side: 'LONG', tpPlan: 'PLAN_A', positionSize: exposure.qty * outcome.reconciled.entryPrice, takerFeeRate: TAKER_FEE_RATE });
    writeLiveStateFileAtomic(STATE_PATH, {
      schemaVersion: LIVE_STATE_SCHEMA_VERSION,
      savedAtMs: Date.now(),
      symbols: { [SYMBOL]: { symbolState: { ...INITIAL_SYMBOL_STATE, openPositions: [{ position: managed, meta: { regime: event.regime, setupType: event.setupType, entryTimestamp, actualRiskDollar: sizing.actualRiskDollar, marginRequired: sizing.marginRequired, riskMultiplier: 1, bookedRealizedPnl: 0, protectionStatus: 'PROTECTED' } }] }, orderIds: [[entryTimestamp, ids]] } },
      pendingEntryQuarantines: {},
    });
    const freshExecutor = new BinanceOrderExecutor({ credentials: { baseUrl, apiKey, apiSecret }, dryRun: false });
    await freshExecutor.syncClock();
    const recovery = await performStartupRestartRecovery({ executor: freshExecutor, symbols: [SYMBOL], persisted: readLiveStateFileSafe(STATE_PATH), quantityToleranceBySymbol: { [SYMBOL]: filters.stepSize / 2 }, initialSymbolState: INITIAL_SYMBOL_STATE });
    if (!recovery.ok || recovery.symbols[0].symbolState.openPositions.length !== 1 || recovery.symbols[0].blockEntries) throw new Error('RESTART_RECOVERY_FAILED');
    const freshAlgoIds = new Set((await freshExecutor.getOpenAlgoOrders(SYMBOL)).map((order) => order.algoId));
    if (!freshAlgoIds.has(ids.slAlgoId) || ids.tpAlgoIds.some((id) => !freshAlgoIds.has(id))) throw new Error('RESTART_PROTECTIVE_ORDER_VERIFY_FAILED');
    restartVerified = true;
  } finally {
    const cleanupExecutor = new BinanceOrderExecutor({ credentials: { baseUrl, apiKey, apiSecret }, dryRun: false });
    await cleanupExecutor.syncClock();
    await cleanupExecutor.loadExchangeInfo([SYMBOL]);
    const exposure = await readExposure(cleanupExecutor);
    if (exposure.qty !== 0) await cleanupExecutor.closePositionMarket(SYMBOL, exposure.qty > 0 ? 'LONG' : 'SHORT', Math.abs(exposure.qty));
    cleanupFlat = await waitForFlat(cleanupExecutor);
    const ids = orderIds.get(entryTimestamp);
    for (const id of [ids?.slAlgoId, ...(ids?.tpAlgoIds ?? [])]) {
      if (id === null || id === undefined) continue;
      try { await cleanupExecutor.cancelAlgoOrder(SYMBOL, id); } catch { }
    }
    cleanupOrdersEmpty = (await cleanupExecutor.getOpenOrders(SYMBOL)).length === 0 && (await cleanupExecutor.getOpenAlgoOrders(SYMBOL)).length === 0;
    if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
  }
  if (!outcome || outcome.kind !== 'FILLED' || !restartVerified || !cleanupFlat || !cleanupOrdersEmpty) throw new Error('LIVE_R4_CANARY_INCOMPLETE');
  console.log(JSON.stringify({ status: 'LIVE_R4_PASS', startedAt, endedAt: new Date().toISOString(), symbol: SYMBOL, fixedRiskUsd: FIXED_RISK_USD, actualRiskDollar: sizing.actualRiskDollar, marginRequired: sizing.marginRequired, entryOutcome: outcome.kind, orderId: outcome.orderId, executedQty: outcome.executedQty, protectionStatus: outcome.protection.status, slAlgoId: orderIds.get(entryTimestamp)?.slAlgoId ?? null, tpAlgoIds: orderIds.get(entryTimestamp)?.tpAlgoIds ?? [], restartVerified, cleanupFlat, cleanupOrdersEmpty }));
}

main().catch((error) => {
  console.error(`LIVE_R4_BLOCKED error=${(error as Error).message}`);
  process.exitCode = 1;
});
