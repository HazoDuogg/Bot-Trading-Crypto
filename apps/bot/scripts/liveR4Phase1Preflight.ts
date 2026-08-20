import 'dotenv/config';
import path from 'node:path';
import { loadBinanceEnvConfig } from '../dist/live/envConfig.js';
import { BinanceOrderExecutor } from '../dist/live/binanceOrderExecutor.js';
import { parseLiveFixedRiskUsd } from '../dist/live/liveRiskConfig.js';
import { readLiveStateFileSafe } from '../dist/live/liveStateSync.js';
import { evaluateLiveR4Phase1 } from './liveR4Phase1Gate.js';

const SYMBOL = 'BTCUSDT';
const RISK_POOL_MAX_PCT = 0.15;

function finiteNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function persistedStateIsClean(filePath: string): boolean {
  const loaded = readLiveStateFileSafe(filePath);
  if (loaded.status === 'NOT_FOUND') return true;
  if (loaded.status !== 'OK') return false;
  const quarantines = Object.values(loaded.file.pendingEntryQuarantines ?? {}).flat();
  const openPositionCount = Object.values(loaded.file.symbols).reduce((count, record) => count + record.symbolState.openPositions.length, 0);
  return quarantines.length === 0 && openPositionCount === 0;
}

async function main(): Promise<void> {
  console.log('=== LIVE-R4 PHASE 1 PREFLIGHT ===');
  const { env, baseUrl, apiKey, apiSecret } = loadBinanceEnvConfig();
  if (env !== 'testnet' || baseUrl !== 'https://testnet.binancefuture.com') throw new Error('ENDPOINT_NOT_PROVEN_TESTNET');

  let fixedRiskUsd: number | null = null;
  try {
    fixedRiskUsd = parseLiveFixedRiskUsd(process.env.LIVE_FIXED_RISK_USD);
  } catch {
    fixedRiskUsd = null;
  }

  const executor = new BinanceOrderExecutor({ credentials: { baseUrl, apiKey, apiSecret }, dryRun: true });
  const offset = await executor.syncClock();
  const account = (await executor.getAccountInfo()) as Record<string, unknown>;
  const positionsRaw = await executor.getPositionRisk(SYMBOL);
  if (!Array.isArray(positionsRaw)) throw new Error('POSITION_RISK_RESPONSE_INVALID');
  const btcPositions = positionsRaw.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null && row.symbol === SYMBOL);
  const regularOrders = await executor.getOpenOrders(SYMBOL);
  const algoOrders = await executor.getOpenAlgoOrders(SYMBOL);
  const positionMode = await executor.getPositionMode();
  await executor.loadExchangeInfo([SYMBOL]);
  const filters = executor.getSymbolFilters(SYMBOL);
  const statePath = path.resolve(process.cwd(), process.env.LIVE_STATE_FILE ?? 'data/live-state/positions-state.json');
  const walletBalance = finiteNumber(account.totalWalletBalance);
  const availableBalance = finiteNumber(account.availableBalance);
  const leverage = btcPositions.length === 1 ? finiteNumber(btcPositions[0].leverage) : Number.NaN;
  const persistedStateClean = persistedStateIsClean(statePath);
  const blockers = evaluateLiveR4Phase1({
    env,
    baseUrl,
    dualSidePosition: positionMode.dualSidePosition,
    walletBalance,
    availableBalance,
    btcPositionAmounts: btcPositions.map((row) => finiteNumber(row.positionAmt)),
    regularOpenOrderCount: regularOrders.length,
    algoOpenOrderCount: algoOrders.length,
    persistedStateClean,
    filters,
    leverage,
    fixedRiskUsd,
    riskPoolMaxPct: RISK_POOL_MAX_PCT,
  });

  console.log(JSON.stringify({
    env,
    baseUrl,
    clockOffsetMs: offset,
    walletBalance,
    availableBalance,
    riskPoolUsd: walletBalance * RISK_POOL_MAX_PCT,
    fixedRiskUsd,
    dualSidePosition: positionMode.dualSidePosition,
    btcPositionCount: btcPositions.length,
    btcNonZeroPositionCount: btcPositions.filter((row) => finiteNumber(row.positionAmt) !== 0).length,
    regularOpenOrderCount: regularOrders.length,
    algoOpenOrderCount: algoOrders.length,
    persistedStateClean,
    filters,
    leverage,
  }));

  if (blockers.length > 0) {
    console.error(`LIVE_R4_BLOCKED blockers=${JSON.stringify(blockers)}`);
    process.exitCode = 1;
    return;
  }
  console.log('LIVE_R4_PHASE1_PASS');
}

main().catch((error) => {
  console.error(`LIVE_R4_BLOCKED error=${(error as Error).message}`);
  process.exitCode = 1;
});
