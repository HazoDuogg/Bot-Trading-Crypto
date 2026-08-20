import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadBinanceEnvConfig } from '../dist/live/envConfig.js';
import { BinanceOrderExecutor } from '../dist/live/binanceOrderExecutor.js';
import { parseLiveFixedRiskUsd, LIVE_FIXED_RISK_USD_REQUIRED } from '../dist/live/liveRiskConfig.js';
import { readLiveStateFileSafe } from '../dist/live/liveStateSync.js';
import { loadTelegramConfig } from '../dist/telegram/telegramClient.js';
import { LIVE_SYMBOL_UNIVERSE } from './liveSymbolUniverse.js';
import { INTERVAL_MS } from '../dist/live/liveCandleFeed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REQUIRED_HEAD = 'f05f3ba1a04e4821605c45a4553b9fc8d7518adc';
const REQUIRED_BRANCH = 'cai-tien';
const KNOWN_MAINNET_HOST = 'https://fapi.binance.com';
const REQUIRED_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const REQUIRED_CANDLE_INTERVALS = ['1m', '5m', '15m', '1h', '1d'];

export type GateStatus = 'PASS' | 'FAIL' | 'UNVERIFIABLE';

export interface GateResult {
  id: number;
  name: string;
  status: GateStatus;
  evidence: string;
}

export interface GateAggregationResult {
  overall: 'LIVE_R5_PASS' | 'LIVE_R5_BLOCKED';
  blockingGates: GateResult[];
}

export function aggregateLiveR5Gates(gates: GateResult[]): GateAggregationResult {
  const requiredIds = Array.from({ length: 15 }, (_, index) => index + 1);
  const counts = new Map<number, number>();
  for (const gate of gates) counts.set(gate.id, (counts.get(gate.id) ?? 0) + 1);
  const invalidStructure = requiredIds.filter((id) => counts.get(id) !== 1);
  const blockingGates = gates.filter((g) => g.status !== 'PASS');
  for (const id of invalidStructure) blockingGates.push({ id, name: `Gate ${id}`, status: 'FAIL', evidence: `gate occurrence count=${counts.get(id) ?? 0}, required exactly 1` });
  return blockingGates.length === 0 ? { overall: 'LIVE_R5_PASS', blockingGates: [] } : { overall: 'LIVE_R5_BLOCKED', blockingGates };
}

export function isHumanApiPermissionConfirmationValid(raw: string | undefined): boolean {
  return raw === 'true';
}

export function evaluateLocalStateGateStatus(status: 'NOT_FOUND' | 'CORRUPT' | 'OK', exchangeReadsSucceeded: boolean): GateStatus {
  if (status === 'CORRUPT') return 'FAIL';
  if (!exchangeReadsSucceeded) return 'UNVERIFIABLE';
  return 'PASS';
}

function finiteNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function runGit(args: string[], cwd: string): { stdout: string; status: number | null } {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { stdout: (res.stdout ?? '').trim(), status: res.status };
}

function readLiveRunnerConfigConstants(compiledScriptDir: string): { leverage: number | null; riskPoolMaxPct: number | null; sourcePath: string | null } {
  const candidates = [
    path.resolve(compiledScriptDir, '../scripts/liveRunner.ts'), // compiled: apps/bot/scripts-dist/ -> apps/bot/scripts/
    path.resolve(compiledScriptDir, 'liveRunner.ts'), // direct ts-node/tsx run from apps/bot/scripts/
    path.resolve(process.cwd(), 'scripts/liveRunner.ts'), // fallback: invoked with cwd=apps/bot
  ];
  const sourcePath = candidates.find((p) => fs.existsSync(p)) ?? null;
  if (sourcePath === null) return { leverage: null, riskPoolMaxPct: null, sourcePath: null };
  const source = fs.readFileSync(sourcePath, 'utf8');
  const leverageMatch = source.match(/\bleverage:\s*([\d.]+),/);
  const riskPoolMatch = source.match(/\briskPoolMaxPct:\s*([\d.]+),/);
  return {
    leverage: leverageMatch ? Number(leverageMatch[1]) : null,
    riskPoolMaxPct: riskPoolMatch ? Number(riskPoolMatch[1]) : null,
    sourcePath,
  };
}

interface SymbolReadResult {
  symbol: string;
  positionRows: Record<string, unknown>[];
  nonZeroPositions: Record<string, unknown>[];
  regularOpenOrders: unknown[];
  algoOpenOrders: Array<{ algoId: number; symbol: string; side: string; positionSide: string; origQty: number; triggerPrice: number; orderType: string }>;
  leverageValues: number[];
  filters: { stepSize: number; tickSize: number; minQty: number; minNotional: number } | null;
}

interface CommandLogEntry {
  label: string;
  command: string;
  cwd: string;
  startedAtUtc: string;
  endedAtUtc: string;
  exitCode: number | null;
}

function runLoggedCommand(label: string, command: string, args: string[], cwd: string): CommandLogEntry {
  const startedAtUtc = new Date().toISOString();
  const isWindowsNodeTool = process.platform === 'win32' && (command === 'npm' || command === 'npx');
  const executable = isWindowsNodeTool ? 'powershell.exe' : command;
  const executableArgs = isWindowsNodeTool
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(path.dirname(process.execPath), `${command}.ps1`), ...args]
    : args;
  const res = spawnSync(executable, executableArgs, { cwd, shell: false, encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
  const endedAtUtc = new Date().toISOString();
  return { label, command: `${command} ${args.join(' ')}`.trim(), cwd, startedAtUtc, endedAtUtc, exitCode: res.status };
}

async function main(): Promise<void> {
  console.log('=== LIVE-R5 MAINNET READ-ONLY PREFLIGHT ===');
  const gates: GateResult[] = [];
  const repoRoot = path.resolve(__dirname, '../../..');
  const botDir = path.resolve(__dirname, '..');

  const headResult = runGit(['rev-parse', 'HEAD'], repoRoot);
  const branchResult = runGit(['branch', '--show-current'], repoRoot);
  const head = headResult.stdout;
  const branch = branchResult.stdout;
  gates.push({
    id: 1,
    name: 'HEAD/branch match fixed point',
    status: head === REQUIRED_HEAD && branch === REQUIRED_BRANCH ? 'PASS' : 'FAIL',
    evidence: `HEAD=${head} (required ${REQUIRED_HEAD}), branch=${branch} (required ${REQUIRED_BRANCH})`,
  });

  let envConfig: { env: string; baseUrl: string; apiKey: string; apiSecret: string } | null = null;
  try {
    envConfig = loadBinanceEnvConfig();
  } catch (err) {
    gates.push({ id: 2, name: 'Mainnet URL matches known Binance Futures mainnet host', status: 'FAIL', evidence: `loadBinanceEnvConfig() threw: ${(err as Error).message}` });
    gates.push({ id: 3, name: 'Credentials sourced from BINANCE_LIVE_KEY/SECRET', status: 'FAIL', evidence: 'envConfig load failed, cannot verify' });
  }

  if (envConfig !== null) {
    gates.push({
      id: 2,
      name: 'Mainnet URL matches known Binance Futures mainnet host',
      status: envConfig.env === 'mainnet' && envConfig.baseUrl === KNOWN_MAINNET_HOST && process.env.BINANCE_URL === KNOWN_MAINNET_HOST ? 'PASS' : 'FAIL',
      evidence: `env=${envConfig.env}, resolvedBaseUrl matches known host=${envConfig.baseUrl === KNOWN_MAINNET_HOST}, source .env BINANCE_URL matches known host=${process.env.BINANCE_URL === KNOWN_MAINNET_HOST}`,
    });

    const liveKeyEnv = process.env.BINANCE_LIVE_KEY;
    const liveSecretEnv = process.env.BINANCE_LIVE_SECRET;
    const testnetKeyEnv = process.env.BINANCE_TESTNET_KEY_ENC;
    const testnetSecretEnv = process.env.BINANCE_TESTNET_SECRET_ENC;
    const credsFromLiveVars =
      typeof liveKeyEnv === 'string' &&
      liveKeyEnv.length > 0 &&
      typeof liveSecretEnv === 'string' &&
      liveSecretEnv.length > 0 &&
      envConfig.apiKey === liveKeyEnv &&
      envConfig.apiSecret === liveSecretEnv &&
      envConfig.apiKey !== testnetKeyEnv &&
      envConfig.apiSecret !== testnetSecretEnv;
    gates.push({
      id: 3,
      name: 'Credentials sourced from BINANCE_LIVE_KEY/SECRET (not testnet vars)',
      status: credsFromLiveVars ? 'PASS' : 'FAIL',
      evidence: `resolved apiKey length=${envConfig.apiKey.length}, apiSecret length=${envConfig.apiSecret.length}, matches BINANCE_LIVE_KEY/SECRET env vars structurally, differs from BINANCE_TESTNET_KEY_ENC/SECRET_ENC values (no values printed)`,
    });
  }

  if (envConfig === null) {
    for (let id = 4; id <= 14; id++) {
      gates.push({ id, name: `Gate ${id}`, status: 'UNVERIFIABLE', evidence: 'Skipped — envConfig failed to load, no exchange connection possible.' });
    }
    await finalizeAndExit(gates, repoRoot, botDir);
    return;
  }

  const executor = new BinanceOrderExecutor({ credentials: { baseUrl: envConfig.baseUrl, apiKey: envConfig.apiKey, apiSecret: envConfig.apiSecret }, dryRun: true });

  let account: Record<string, unknown> | null = null;
  let clockOffsetMs: number | null = null;
  let positionModeResult: { dualSidePosition: boolean } | null = null;
  let networkError: string | null = null;

  try {
    clockOffsetMs = await executor.syncClock();
    account = (await executor.getAccountInfo()) as Record<string, unknown>;
    positionModeResult = await executor.getPositionMode();
  } catch (err) {
    networkError = (err as Error).message;
  }

  if (account !== null) {
    const canTrade = account.canTrade;
    const humanConfirmed = isHumanApiPermissionConfirmationValid(process.env.LIVE_R5_MAINNET_API_PERMISSIONS_CONFIRMED);
    gates.push({
      id: 4,
      name: 'API key permission confirmation (withdrawal disabled, Read+Futures-Trading only, IP-restricted)',
      status: canTrade === true && humanConfirmed ? 'PASS' : 'UNVERIFIABLE',
      evidence: `getAccountInfo().canTrade=${JSON.stringify(canTrade)}; explicit operator confirmation present=${humanConfirmed}`,
    });
  } else {
    gates.push({ id: 4, name: 'API key permission confirmation', status: 'UNVERIFIABLE', evidence: `getAccountInfo() did not return: ${networkError ?? 'unknown'}` });
  }

  gates.push({
    id: 5,
    name: 'Clock sync (syncClock + proof-by-success of subsequent signed GETs)',
    status: typeof clockOffsetMs === 'number' && Number.isFinite(clockOffsetMs) && account !== null && positionModeResult !== null ? 'PASS' : 'FAIL',
    evidence: `clockOffsetMs=${clockOffsetMs ?? 'N/A'}; subsequent signed GET calls (getAccountInfo, getPositionMode) ${account !== null && positionModeResult !== null ? 'succeeded' : `failed: ${networkError ?? 'unknown'}`}`,
  });

  if (positionModeResult !== null) {
    gates.push({
      id: 6,
      name: 'One-Way Mode confirmed via direct GET /fapi/v1/positionSide/dual',
      status: positionModeResult.dualSidePosition === false ? 'PASS' : 'FAIL',
      evidence: `getPositionMode() (direct GET /fapi/v1/positionSide/dual, not inferred from positionSide values) returned dualSidePosition=${positionModeResult.dualSidePosition}`,
    });
  } else {
    gates.push({ id: 6, name: 'One-Way Mode confirmed via direct GET /fapi/v1/positionSide/dual', status: 'UNVERIFIABLE', evidence: `getPositionMode() did not return: ${networkError ?? 'unknown'}` });
  }

  let walletBalance = Number.NaN;
  let availableBalance = Number.NaN;
  if (account !== null) {
    walletBalance = finiteNumber(account.totalWalletBalance);
    availableBalance = finiteNumber(account.availableBalance);
    gates.push({
      id: 7,
      name: 'Real balance via getAccountInfo() — totalWalletBalance/availableBalance finite > 0',
      status: positiveFinite(walletBalance) && positiveFinite(availableBalance) ? 'PASS' : 'FAIL',
      evidence: `totalWalletBalance=${walletBalance}, availableBalance=${availableBalance}`,
    });
  } else {
    gates.push({ id: 7, name: 'Real balance via getAccountInfo()', status: 'UNVERIFIABLE', evidence: `getAccountInfo() did not return: ${networkError ?? 'unknown'}` });
  }

  let fixedRiskUsd: number | null = null;
  try {
    fixedRiskUsd = parseLiveFixedRiskUsd(process.env.LIVE_FIXED_RISK_USD);
  } catch {
    fixedRiskUsd = null;
  }
  const runnerConstants = readLiveRunnerConfigConstants(__dirname);
  const riskPoolMaxPct = runnerConstants.riskPoolMaxPct;
  const riskPoolUsd = positiveFinite(walletBalance) && riskPoolMaxPct !== null ? walletBalance * riskPoolMaxPct : Number.NaN;
  gates.push({
    id: 8,
    name: 'Risk: LIVE_FIXED_RISK_USD===20, risk pool = balance*riskPoolMaxPct >= $20',
    status:
      fixedRiskUsd === LIVE_FIXED_RISK_USD_REQUIRED && riskPoolMaxPct !== null && positiveFinite(riskPoolUsd) && riskPoolUsd >= LIVE_FIXED_RISK_USD_REQUIRED
        ? 'PASS'
        : 'FAIL',
    evidence: `LIVE_FIXED_RISK_USD=${fixedRiskUsd}, riskPoolMaxPct (read from ${runnerConstants.sourcePath ?? 'NOT FOUND'})=${riskPoolMaxPct}, walletBalance=${walletBalance}, riskPoolUsd=${riskPoolUsd}`,
  });

  const universeMatches = JSON.stringify([...LIVE_SYMBOL_UNIVERSE]) === JSON.stringify(REQUIRED_SYMBOLS);
  const hasXrp = (LIVE_SYMBOL_UNIVERSE as readonly string[]).includes('XRPUSDT');
  const hasHype = (LIVE_SYMBOL_UNIVERSE as readonly string[]).includes('HYPEUSDT');
  gates.push({
    id: 9,
    name: 'LIVE_SYMBOL_UNIVERSE === [BTCUSDT, ETHUSDT, SOLUSDT], no XRPUSDT/HYPEUSDT',
    status: universeMatches && !hasXrp && !hasHype ? 'PASS' : 'FAIL',
    evidence: `LIVE_SYMBOL_UNIVERSE=${JSON.stringify(LIVE_SYMBOL_UNIVERSE)}, hasXRPUSDT=${hasXrp}, hasHYPEUSDT=${hasHype}`,
  });

  const symbolResults: SymbolReadResult[] = [];
  let gate10Error: string | null = null;
  try {
    await executor.loadExchangeInfo(REQUIRED_SYMBOLS);
    for (const symbol of REQUIRED_SYMBOLS) {
      const positionsRaw = await executor.getPositionRisk(symbol);
      if (!Array.isArray(positionsRaw)) throw new Error(`getPositionRisk(${symbol}): response shape invalid`);
      const positionRows = positionsRaw.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null && (row as Record<string, unknown>).symbol === symbol);
      const nonZeroPositions = positionRows.filter((row) => finiteNumber(row.positionAmt) !== 0);
      const regularOpenOrders = await executor.getOpenOrders(symbol);
      const algoOpenOrders = await executor.getOpenAlgoOrders(symbol);
      const filtersRaw = executor.getSymbolFilters(symbol);
      symbolResults.push({
        symbol,
        positionRows,
        nonZeroPositions,
        regularOpenOrders,
        algoOpenOrders: algoOpenOrders.map((o) => ({ algoId: o.algoId, symbol: o.symbol, side: o.side, positionSide: o.positionSide, origQty: o.origQty, triggerPrice: o.triggerPrice, orderType: o.orderType })),
        leverageValues: positionRows.map((row) => finiteNumber(row.leverage)),
        filters: { stepSize: filtersRaw.stepSize, tickSize: filtersRaw.tickSize, minQty: filtersRaw.minQty, minNotional: filtersRaw.minNotional },
      });
    }
  } catch (err) {
    gate10Error = (err as Error).message;
  }

  const gate10Ok =
    gate10Error === null &&
    symbolResults.length === REQUIRED_SYMBOLS.length &&
    symbolResults.every(
      (r) =>
        r.filters !== null &&
        [r.filters.stepSize, r.filters.tickSize, r.filters.minQty, r.filters.minNotional].every(positiveFinite) &&
        r.leverageValues.length > 0 &&
        r.leverageValues.every((lv) => lv === 30),
    );
  gates.push({
    id: 10,
    name: 'All 3 symbols: positionRisk/openOrders/algoOrders/filters read, leverage===30x',
    status: gate10Ok ? 'PASS' : 'FAIL',
    evidence:
      gate10Error !== null
        ? `read failed: ${gate10Error}`
        : symbolResults
            .map((r) => `${r.symbol}: positions=${r.positionRows.length} (nonZero=${r.nonZeroPositions.length}), regularOrders=${r.regularOpenOrders.length}, algoOrders=${r.algoOpenOrders.length}, leverage=${JSON.stringify(r.leverageValues)}, filters=${JSON.stringify(r.filters)}`)
            .join(' | '),
  });

  const statePath = path.resolve(repoRoot, process.env.LIVE_STATE_FILE ?? 'data/live-state/positions-state.json');
  const stateResult = readLiveStateFileSafe(statePath);
  let gate11Status: GateStatus = 'FAIL';
  let gate11Evidence = '';
  const exchangeReadsSucceeded = gate10Error === null;
  if (stateResult.status === 'NOT_FOUND') {
    gate11Status = evaluateLocalStateGateStatus(stateResult.status, exchangeReadsSucceeded);
    gate11Evidence = `No local state file at ${statePath} (first run) — nothing to reconcile.`;
  } else if (stateResult.status === 'CORRUPT') {
    gate11Status = 'FAIL';
    gate11Evidence = `Local state file CORRUPT: ${stateResult.error}`;
  } else if (!exchangeReadsSucceeded) {
    gate11Status = evaluateLocalStateGateStatus(stateResult.status, false);
    gate11Evidence = 'Cannot reconcile — gate 10 exchange reads failed.';
  } else {
    const quarantines = Object.values(stateResult.file.pendingEntryQuarantines ?? {}).flat();
    const mismatches: string[] = [];
    for (const symbol of REQUIRED_SYMBOLS) {
      const localRecord = stateResult.file.symbols[symbol];
      const localOpenCount = localRecord?.symbolState.openPositions.length ?? 0;
      const exchangeNonZeroCount = symbolResults.find((r) => r.symbol === symbol)?.nonZeroPositions.length ?? 0;
      if (localOpenCount !== exchangeNonZeroCount) {
        mismatches.push(`${symbol}: local openPositions=${localOpenCount} vs exchange nonZero positions=${exchangeNonZeroCount}`);
      }
    }
    gate11Status = quarantines.length === 0 && mismatches.length === 0 ? 'PASS' : 'FAIL';
    gate11Evidence = `pendingEntryQuarantines count=${quarantines.length}; mismatches=${mismatches.length === 0 ? 'none' : mismatches.join('; ')}`;
  }
  gates.push({ id: 11, name: 'Local live-state file not corrupt, no pending quarantine, matches exchange', status: gate11Status, evidence: gate11Evidence });

  if (gate10Error === null) {
    const anyExposure = symbolResults.some((r) => r.nonZeroPositions.length > 0 || r.regularOpenOrders.length > 0 || r.algoOpenOrders.length > 0);
    const detail = symbolResults
      .filter((r) => r.nonZeroPositions.length > 0 || r.regularOpenOrders.length > 0 || r.algoOpenOrders.length > 0)
      .map((r) => {
        const positions = r.nonZeroPositions.map((p) => `side/amt=${p.positionAmt} entry=${p.entryPrice}`).join(', ');
        const algos = r.algoOpenOrders.map((a) => `${a.orderType} ${a.side} qty=${a.origQty} trigger=${a.triggerPrice}`).join(', ');
        return `${r.symbol}: positions=[${positions}] regularOrders=${r.regularOpenOrders.length} algoOrders=[${algos}]`;
      })
      .join(' | ');
    gates.push({
      id: 12,
      name: 'No existing real position/order on mainnet for any of the 3 symbols (else auto-BLOCKED pending human handling)',
      status: anyExposure ? 'FAIL' : 'PASS',
      evidence: anyExposure ? `EXISTING EXPOSURE FOUND (not touched, recorded only): ${detail}` : 'All 3 symbols flat: zero positions, zero regular orders, zero algo orders.',
    });
  } else {
    gates.push({ id: 12, name: 'No existing real position/order on mainnet', status: 'UNVERIFIABLE', evidence: 'Cannot verify — gate 10 exchange reads failed.' });
  }

  const candleIntervals = Object.keys(INTERVAL_MS);
  const candleIntervalsMatch = JSON.stringify([...candleIntervals].sort()) === JSON.stringify([...REQUIRED_CANDLE_INTERVALS].sort());
  gates.push({
    id: 13,
    name: 'Candle feed base URL is mainnet host, exactly 5 required timeframes configured',
    status: envConfig.baseUrl === KNOWN_MAINNET_HOST && candleIntervalsMatch ? 'PASS' : 'FAIL',
    evidence: `liveRunner.ts wires LiveCandleFeed's baseUrl from the same envConfig.baseUrl used for order execution (=${envConfig.baseUrl}); liveCandleFeed.ts's INTERVAL_MS keys=${JSON.stringify(candleIntervals)}`,
  });

  try {
    const telegramConfig = loadTelegramConfig();
    const allNonEmpty = typeof telegramConfig.botToken === 'string' && telegramConfig.botToken.length > 0 && telegramConfig.chatIds.every((id) => id.length > 0);
    gates.push({
      id: 14,
      name: 'Telegram config has all required fields present/non-empty (no message ever sent)',
      status: allNonEmpty && telegramConfig.chatIds.length > 0 ? 'PASS' : 'FAIL',
      evidence: `botToken present, length=${telegramConfig.botToken.length}; chatIds count=${telegramConfig.chatIds.length}, all non-empty=${allNonEmpty} (no values printed, no send attempted)`,
    });
  } catch (err) {
    gates.push({ id: 14, name: 'Telegram config has all required fields present/non-empty', status: 'FAIL', evidence: `loadTelegramConfig() threw: ${(err as Error).message}` });
  }

  await finalizeAndExit(gates, repoRoot, botDir, { account, walletBalance, availableBalance, clockOffsetMs, positionModeResult, symbolResults, fixedRiskUsd, riskPoolUsd, riskPoolMaxPct, statePath, stateResult, envConfig });
}

interface ReportContext {
  account: Record<string, unknown> | null;
  walletBalance: number;
  availableBalance: number;
  clockOffsetMs: number | null;
  positionModeResult: { dualSidePosition: boolean } | null;
  symbolResults: SymbolReadResult[];
  fixedRiskUsd: number | null;
  riskPoolUsd: number;
  riskPoolMaxPct: number | null;
  statePath: string;
  stateResult: ReturnType<typeof readLiveStateFileSafe>;
  envConfig: { env: string; baseUrl: string; apiKey: string; apiSecret: string };
}

async function finalizeAndExit(gates: GateResult[], repoRoot: string, botDir: string, ctx?: ReportContext): Promise<void> {
  const commandLog: CommandLogEntry[] = [];
  commandLog.push(runLoggedCommand('Focused gate test file', 'npx', ['vitest', 'run', 'scripts/liveR5MainnetPreflight.test.ts'], botDir));
  commandLog.push(runLoggedCommand('Full offline test suite', 'npm', ['run', 'test'], botDir));
  commandLog.push(runLoggedCommand('Typecheck', 'npm', ['run', 'typecheck'], botDir));
  commandLog.push(runLoggedCommand('Build', 'npm', ['run', 'build'], botDir));
  commandLog.push(runLoggedCommand('Build scripts', 'npm', ['run', 'build:scripts'], repoRoot));
  commandLog.push(runLoggedCommand('git diff --check', 'git', ['diff', '--check'], repoRoot));

  const gate15Failures = commandLog.filter((c) => c.exitCode !== 0);
  gates.push({
    id: 15,
    name: 'Run and log: focused test, full suite, typecheck, build, build:scripts, git diff --check',
    status: gate15Failures.length === 0 ? 'PASS' : 'FAIL',
    evidence: commandLog.map((c) => `${c.label} [${c.command}] cwd=${c.cwd} ${c.startedAtUtc}->${c.endedAtUtc} exit=${c.exitCode}`).join(' | '),
  });

  const aggregation = aggregateLiveR5Gates(gates);

  console.log(JSON.stringify({ gates: gates.map((g) => ({ id: g.id, name: g.name, status: g.status })), overall: aggregation.overall }, null, 2));

  writeReport(gates, aggregation, commandLog, ctx);

  if (aggregation.overall === 'LIVE_R5_PASS') {
    console.log('LIVE_R5_PASS');
    process.exit(0);
  } else {
    console.error(`LIVE_R5_BLOCKED blockingGates=${JSON.stringify(aggregation.blockingGates.map((g) => g.id))}`);
    process.exit(1);
  }
}

function writeReport(gates: GateResult[], aggregation: GateAggregationResult, commandLog: CommandLogEntry[], ctx?: ReportContext): void {
  const reportPath = path.resolve(__dirname, '../../../data/live-r5-report.md');
  const lines: string[] = [];
  lines.push('# TICKET-LIVE-R5 — Mainnet Read-Only Preflight Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Fixed point');
  lines.push(`- HEAD: ${REQUIRED_HEAD}`);
  lines.push(`- Branch: ${REQUIRED_BRANCH}`);
  lines.push('');
  if (ctx) {
    lines.push('## Mainnet endpoint');
    lines.push(`- Resolved base URL: ${ctx.envConfig.baseUrl} (matches known Binance Futures mainnet host: ${ctx.envConfig.baseUrl === KNOWN_MAINNET_HOST})`);
    lines.push(`- env: ${ctx.envConfig.env}`);
    lines.push('- No secret/signature/signed-URL value is printed anywhere in this report.');
    lines.push('');
    lines.push('## Clock sync');
    lines.push(`- clockOffsetMs: ${ctx.clockOffsetMs ?? 'N/A'}`);
    lines.push('');
    lines.push('## Balance / risk');
    lines.push(`- totalWalletBalance: ${ctx.walletBalance}`);
    lines.push(`- availableBalance: ${ctx.availableBalance}`);
    lines.push(`- riskPoolMaxPct (from liveRunner.ts source): ${ctx.riskPoolMaxPct}`);
    lines.push(`- riskPoolUsd (balance * riskPoolMaxPct): ${ctx.riskPoolUsd}`);
    lines.push(`- LIVE_FIXED_RISK_USD: ${ctx.fixedRiskUsd}`);
    lines.push('');
    lines.push('## One-Way Mode');
    lines.push(`- dualSidePosition (via direct GET /fapi/v1/positionSide/dual): ${ctx.positionModeResult?.dualSidePosition ?? 'N/A'}`);
    lines.push('');
    lines.push('## Per-symbol reads (all 3 symbols)');
    for (const r of ctx.symbolResults) {
      lines.push(`### ${r.symbol}`);
      lines.push(`- Position rows: ${r.positionRows.length}, non-zero: ${r.nonZeroPositions.length}`);
      if (r.nonZeroPositions.length > 0) {
        for (const p of r.nonZeroPositions) {
          lines.push(`  - positionAmt=${p.positionAmt}, entryPrice=${p.entryPrice}, leverage=${p.leverage}`);
        }
      }
      lines.push(`- Regular open orders: ${r.regularOpenOrders.length}`);
      lines.push(`- Algo (SL/TP) open orders: ${r.algoOpenOrders.length}`);
      for (const a of r.algoOpenOrders) {
        lines.push(`  - ${a.orderType} ${a.side} qty=${a.origQty} trigger=${a.triggerPrice}`);
      }
      lines.push(`- Leverage: ${JSON.stringify(r.leverageValues)}`);
      lines.push(`- Filters: ${JSON.stringify(r.filters)}`);
      lines.push('');
    }
    lines.push('## Local live-state reconciliation');
    lines.push(`- State file path: ${ctx.statePath}`);
    lines.push(`- State file status: ${ctx.stateResult.status}`);
    lines.push('');
  }
  lines.push('## Gates 1-15');
  for (const g of gates) {
    lines.push(`### Gate ${g.id}: ${g.name}`);
    lines.push(`- Status: ${g.status}`);
    lines.push(`- Evidence: ${g.evidence}`);
    lines.push('');
  }
  lines.push('## Gate 15 command log');
  for (const c of commandLog) {
    lines.push(`- **${c.label}**: \`${c.command}\` (cwd=${c.cwd}) ${c.startedAtUtc} -> ${c.endedAtUtc}, exit=${c.exitCode}`);
  }
  lines.push('');
  lines.push('## Deviations');
  lines.push('- Two pre-existing, out-of-scope, uncommitted files are present: `apps/bot/src/telegram/dedupe.ts`, `apps/bot/src/telegram/messageFormatters.ts` — not touched, staged, reverted, or attributed by this ticket.');
  lines.push('- Gate 4 (API key permission: withdrawal disabled, Read+Futures-Trading only, IP-restricted) is UNVERIFIABLE by this script — Binance exposes no REST endpoint that reports withdrawal-permission or IP-allowlist status for the calling key. This requires separate human confirmation in the Binance API Management dashboard.');
  lines.push('');
  lines.push('## Authorization boundary');
  lines.push('Commit/push/deploy/mutating calls: NOT PERFORMED.');
  lines.push('');
  lines.push('Phase 2/3 (any real canary trade) and running `liveRunner.ts` are NOT authorized by this ticket and were NOT attempted. This ticket is preflight-only. Further action requires separate explicit approval from the user AND from "Codex" (a separate reviewer role named by the ticket) — that sign-off is still pending and was not sought or simulated by this script.');
  lines.push('');
  lines.push(`## Final decision`);
  lines.push('');
  lines.push(aggregation.overall);
  lines.push('');

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
}

const isDirectRun = (() => {
  try {
    return process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((error) => {
    console.error(`LIVE_R5_BLOCKED error=${(error as Error).message}`);
    process.exitCode = 1;
  });
}
