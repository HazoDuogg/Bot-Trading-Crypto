import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import type { Candle } from '../src/noTradeZone/types.js';
import { createAtrTracker } from '../src/noTradeZone/atr.js';
import { M15_CANDLE_DURATION_MS } from '../src/backtest/intrabarExecution.js';
import { calculateExecutionCosts } from '../src/backtest/costModel.js';
import {
  simulatePositionManagementV2,
  predictedCostR,
  BREAKEVEN_SAFETY_FACTOR,
  BREAKEVEN_BUFFER_FLOOR_R,
  BREAKEVEN_BUFFER_CAP_R,
  BREAKEVEN_TRIGGER_R,
  TP1_R,
  TP1_FRACTION,
  TP2_R,
  TRAILING_ATR_MULTIPLE,
  POSITION_MANAGEMENT_V2_ATR_PERIOD,
  POSITION_MANAGEMENT_V2_MAX_M1_CANDLES,
  type PositionExitLeg,
  type PositionManagementV2Result,
} from '../src/risk/positionManagementV2.js';
import type { TradePlan } from '../src/risk/tradePlan.js';

// TICKET-04X item 4/5: before/after comparison of the adaptive breakeven buffer, held out to the
// OOS half of TICKET-043's reverse-entry mining population (entryTimestamp >= splitTimestamp, the
// same split breakevenBufferCostFit.ts fit on). "Before" is read directly off the existing mining
// files (fixed 0.05R buffer); "after" re-simulates the same (coin, entryTimestamp, direction)
// population with the now-adaptive simulatePositionManagementV2 and reclassifies WIN_NET_PROFIT /
// WIN_FEE_EATEN / LOSS exactly as reverseEntryMining.ts does.
//
// TICKET-04X-B: --safetyFactors=0.8,1.0,1.1,1.2,1.5 (CLI arg) sweeps safetyFactor instead of using
// the module's fixed BREAKEVEN_SAFETY_FACTOR. positionManagementV2.ts is NOT touched (still hardcodes
// 1.2), so a swept value other than the module's own BREAKEVEN_SAFETY_FACTOR runs through a local
// line-for-line copy of the state machine (simulateWithSafetyFactor below) that takes safetyFactor
// as a parameter; the fit's alpha/C (via the imported predictedCostR), the 0.05 floor, the 0.75
// cap, the trigger, and the TP1/TP2/trailing logic are all imported unchanged from production, not
// re-derived. When the swept value equals BREAKEVEN_SAFETY_FACTOR, production's own
// simulatePositionManagementV2 is called directly instead, so the default single-value run (no CLI
// arg) is byte-for-byte the same code path as TICKET-04X's original run.
const RISK_BUDGET_USD = 6;
const SPLIT_TIMESTAMP = 1_740_536_100_000;
const safetyFactorsArg = process.argv.find((a) => a.startsWith('--safetyFactors='));
const SAFETY_FACTORS: readonly number[] = safetyFactorsArg
  ? safetyFactorsArg.slice('--safetyFactors='.length).split(',').map(Number)
  : [BREAKEVEN_SAFETY_FACTOR];

type Group = 'WIN_NET_PROFIT' | 'WIN_FEE_EATEN' | 'LOSS';
const GROUPS: readonly Group[] = ['WIN_NET_PROFIT', 'WIN_FEE_EATEN', 'LOSS'];
const REPORTS_FILES: Array<{ file: string; sheet: Group }> = [
  { file: 'nukida-ticket043-reverse-entry-mining.xlsx', sheet: 'WIN_NET_PROFIT' },
  { file: 'nukida-ticket043-reverse-entry-mining -win-fee-eaten .xlsx', sheet: 'WIN_FEE_EATEN' },
  { file: 'nukida-ticket043-reverse-entry-mining -loss.xlsx', sheet: 'LOSS' },
];

interface SourceRow {
  originalGroup: Group;
  coin: string;
  entryTimestamp: number;
  direction: 'BULL' | 'BEAR';
  totalGrossR: number;
  totalNetR: number;
  atr15: number;
}

async function loadCsv(csvPath: string): Promise<Candle[]> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  return rows.map((row) => {
    const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
    return { openTime, open, high, low, close, volume } satisfies Candle;
  });
}

function firstM1After(candles: readonly Candle[], timestamp: number): number {
  let left = 0;
  let right = candles.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (candles[middle].openTime <= timestamp) left = middle + 1;
    else right = middle;
  }
  return left;
}

async function readOosRows(path: string, sheetName: Group): Promise<SourceRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = workbook.getWorksheet(sheetName);
  if (sheet === undefined) throw new Error(`Missing sheet ${sheetName} in ${path}`);
  const out: SourceRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= 2) return;
    const v = row.values as unknown[];
    const entryTimestamp = Number(v[2]);
    if (entryTimestamp < SPLIT_TIMESTAMP) return;
    out.push({
      originalGroup: sheetName,
      coin: String(v[1]),
      entryTimestamp,
      direction: v[3] as 'BULL' | 'BEAR',
      totalGrossR: Number(v[4]),
      totalNetR: Number(v[5]),
      atr15: Number(v[6]),
    });
  });
  return out;
}

interface Accumulator {
  count: number;
  sumGrossR: number;
  sumNetR: number;
}

function emptyAcc(): Accumulator {
  return { count: 0, sumGrossR: 0, sumNetR: 0 };
}

function addTo(acc: Accumulator, grossR: number, netR: number): void {
  acc.count += 1;
  acc.sumGrossR += grossR;
  acc.sumNetR += netR;
}

function directionSign(plan: TradePlan): 1 | -1 {
  return plan.direction === 'BULL' ? 1 : -1;
}

function touches(candle: Candle, price: number): boolean {
  return candle.low <= price && candle.high >= price;
}

function grossR(plan: TradePlan, legs: readonly PositionExitLeg[]): number {
  const sign = directionSign(plan);
  return legs.reduce(
    (sum, leg) => sum + (leg.fraction * sign * (leg.exitPrice - plan.entryPrice)) / plan.riskPerUnit,
    0,
  );
}

// Line-for-line copy of simulatePositionManagementV2's state machine, with the one deliberate
// change: bufferR takes safetyFactor as a parameter instead of the module's fixed constant. See the
// TICKET-04X-B header comment above for why this duplication exists instead of calling production.
function simulateWithSafetyFactor(
  plan: TradePlan,
  entryFillTimestamp: number,
  m1Candles: readonly Candle[],
  safetyFactor: number,
): PositionManagementV2Result {
  const sign = directionSign(plan);
  const breakevenTriggerPrice = plan.entryPrice + sign * BREAKEVEN_TRIGGER_R * plan.riskPerUnit;
  const rawBuffer = safetyFactor * predictedCostR(plan.entryPrice, plan.riskPerUnit);
  const bufferR = Math.min(BREAKEVEN_BUFFER_CAP_R, Math.max(BREAKEVEN_BUFFER_FLOOR_R, rawBuffer));
  const breakevenStopPrice = plan.entryPrice + sign * bufferR * plan.riskPerUnit;
  const tp1Price = plan.entryPrice + sign * TP1_R * plan.riskPerUnit;
  const tp2Price = plan.entryPrice + sign * TP2_R * plan.riskPerUnit;

  const legs: PositionExitLeg[] = [];
  let phase: 'A' | 'B' | 'C' = 'A';
  let runnerStop = breakevenStopPrice;
  let trailingActive = false;
  let consumed = 0;
  const atrTracker = createAtrTracker(POSITION_MANAGEMENT_V2_ATR_PERIOD);

  for (const current of m1Candles) {
    if (current.openTime <= entryFillTimestamp) continue;
    consumed += 1;

    const activeStop = phase === 'A' ? plan.stopLoss : phase === 'B' ? breakevenStopPrice : runnerStop;
    const activeTP = phase === 'C' ? tp2Price : tp1Price;
    const hitStop = touches(current, activeStop);
    const hitTP = touches(current, activeTP);

    if (hitStop && hitTP) {
      const reason = phase === 'A' ? 'INITIAL_STOP' : trailingActive ? 'TRAILING_STOP' : 'BREAKEVEN_STOP';
      const fraction = phase === 'C' ? 1 - TP1_FRACTION : 1;
      legs.push({
        reason,
        fraction,
        exitPrice: activeStop,
        exitTimestamp: current.openTime,
        reasonCode: 'AMBIGUOUS_FORCED_LOSS',
      });
      return {
        outcome: reason,
        exitLegs: legs,
        grossR: grossR(plan, legs),
        partialExitTriggered: phase === 'C',
        m1CandlesConsumed: consumed,
      };
    }

    if (hitStop) {
      const reason = phase === 'A' ? 'INITIAL_STOP' : trailingActive ? 'TRAILING_STOP' : 'BREAKEVEN_STOP';
      const fraction = phase === 'C' ? 1 - TP1_FRACTION : 1;
      legs.push({ reason, fraction, exitPrice: activeStop, exitTimestamp: current.openTime });
      return {
        outcome: reason,
        exitLegs: legs,
        grossR: grossR(plan, legs),
        partialExitTriggered: phase === 'C',
        m1CandlesConsumed: consumed,
      };
    }

    if (hitTP) {
      if (phase !== 'C') {
        legs.push({
          reason: 'PARTIAL_EXIT',
          fraction: TP1_FRACTION,
          exitPrice: tp1Price,
          exitTimestamp: current.openTime,
        });
        phase = 'C';
        runnerStop = breakevenStopPrice;
        trailingActive = false;
      } else {
        legs.push({
          reason: 'TAKE_PROFIT_2',
          fraction: 1 - TP1_FRACTION,
          exitPrice: tp2Price,
          exitTimestamp: current.openTime,
        });
        return {
          outcome: 'TAKE_PROFIT_2',
          exitLegs: legs,
          grossR: grossR(plan, legs),
          partialExitTriggered: true,
          m1CandlesConsumed: consumed,
        };
      }
    }

    if (phase === 'A' && touches(current, breakevenTriggerPrice)) phase = 'B';

    const atr = atrTracker.next(current);
    if (phase === 'C' && atr !== null) {
      const candidate = current.close - sign * TRAILING_ATR_MULTIPLE * atr;
      const improves = sign === 1 ? candidate > runnerStop : candidate < runnerStop;
      if (improves) {
        runnerStop = candidate;
        trailingActive = true;
      }
    }

    if (consumed === POSITION_MANAGEMENT_V2_MAX_M1_CANDLES) {
      const fraction = phase === 'C' ? 1 - TP1_FRACTION : 1;
      legs.push({
        reason: 'FORCED_CLOSE_TIMEOUT',
        fraction,
        exitPrice: current.close,
        exitTimestamp: current.openTime,
      });
      return {
        outcome: 'FORCED_CLOSE_TIMEOUT',
        exitLegs: legs,
        grossR: grossR(plan, legs),
        partialExitTriggered: phase === 'C',
        m1CandlesConsumed: consumed,
      };
    }
  }

  return {
    outcome: 'OPEN_DATA_END',
    exitLegs: legs,
    grossR: grossR(plan, legs),
    partialExitTriggered: phase === 'C',
    m1CandlesConsumed: consumed,
  };
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../data/', import.meta.url));
  const reportsDirectory = fileURLToPath(new URL('../reports/', import.meta.url));
  const startedAt = Date.now();

  const allRows: SourceRow[] = [];
  for (const { file, sheet } of REPORTS_FILES) {
    const rows = await readOosRows(resolve(reportsDirectory, file), sheet);
    console.info(`${sheet}: ${rows.length} OOS rows (entryTimestamp >= ${SPLIT_TIMESTAMP})`);
    for (const row of rows) allRows.push(row);
  }
  console.info(`Total OOS rows: ${allRows.length}`);

  const beforeByGroup: Record<Group, Accumulator> = {
    WIN_NET_PROFIT: emptyAcc(),
    WIN_FEE_EATEN: emptyAcc(),
    LOSS: emptyAcc(),
  };
  const afterByFactorByGroup = new Map<number, Record<Group, Accumulator>>(
    SAFETY_FACTORS.map((f) => [f, { WIN_NET_PROFIT: emptyAcc(), WIN_FEE_EATEN: emptyAcc(), LOSS: emptyAcc() }]),
  );
  // transition[factor][before][after] = count
  const transitionByFactor = new Map<number, Record<Group, Record<Group, number>>>(
    SAFETY_FACTORS.map((f) => [
      f,
      {
        WIN_NET_PROFIT: { WIN_NET_PROFIT: 0, WIN_FEE_EATEN: 0, LOSS: 0 },
        WIN_FEE_EATEN: { WIN_NET_PROFIT: 0, WIN_FEE_EATEN: 0, LOSS: 0 },
        LOSS: { WIN_NET_PROFIT: 0, WIN_FEE_EATEN: 0, LOSS: 0 },
      },
    ]),
  );

  // Group by coin so each coin's CSVs load exactly once for the whole sweep, not once per factor.
  allRows.sort((a, b) => (a.coin < b.coin ? -1 : a.coin > b.coin ? 1 : 0));

  let currentCoin: string | null = null;
  let m1Candles: Candle[] = [];
  let m15CloseByOpenTime = new Map<number, number>();
  let unresolved = 0;

  for (let idx = 0; idx < allRows.length; idx += 1) {
    const row = allRows[idx];
    addTo(beforeByGroup[row.originalGroup], row.totalGrossR, row.totalNetR);

    if (row.coin !== currentCoin) {
      currentCoin = row.coin;
      const m15Candles = await loadCsv(resolve(dataDirectory, `${row.coin}_15m_3y.csv`));
      m1Candles = await loadCsv(resolve(dataDirectory, `${row.coin}_rt094_1m.csv`));
      m15CloseByOpenTime = new Map(m15Candles.map((c) => [c.openTime, c.close]));
    }
    const entryPrice = m15CloseByOpenTime.get(row.entryTimestamp);
    if (entryPrice === undefined) {
      unresolved += 1;
      continue;
    }

    const sign = row.direction === 'BULL' ? 1 : -1;
    const tradePlan: TradePlan = {
      direction: row.direction,
      entryPrice,
      stopLoss: entryPrice - sign * row.atr15,
      takeProfit: entryPrice + sign * row.atr15,
      riskPerUnit: row.atr15,
      positionSize: RISK_BUDGET_USD / row.atr15,
      requiredMargin: 0,
    };
    const entryFillTimestamp = row.entryTimestamp + M15_CANDLE_DURATION_MS - 1;
    const postFillM1 = m1Candles.slice(firstM1After(m1Candles, entryFillTimestamp));
    const entryM1Candle = postFillM1[0];
    if (entryM1Candle === undefined) {
      unresolved += 1;
      continue;
    }

    for (const safetyFactor of SAFETY_FACTORS) {
      const execution =
        safetyFactor === BREAKEVEN_SAFETY_FACTOR
          ? simulatePositionManagementV2({ tradePlan, entryFillTimestamp, m1Candles: postFillM1 })
          : simulateWithSafetyFactor(tradePlan, entryFillTimestamp, postFillM1, safetyFactor);
      if (execution.outcome === 'OPEN_DATA_END') continue;

      let totalGrossR = 0;
      let totalNetR = 0;
      for (const leg of execution.exitLegs) {
        const exitM1Candle = m1Candles[firstM1After(m1Candles, leg.exitTimestamp - 1)];
        const costs = calculateExecutionCosts({
          tradePlan,
          exitPrice: leg.exitPrice,
          exitReason: leg.reason === 'PARTIAL_EXIT' || leg.reason === 'TAKE_PROFIT_2' ? 'TAKE_PROFIT' : 'STOP_LOSS',
          entryM1Candle,
          exitM1Candle,
        });
        totalGrossR += leg.fraction * costs.grossR;
        totalNetR += leg.fraction * costs.netR;
      }
      const afterGroup: Group = totalGrossR <= 0 ? 'LOSS' : totalNetR > 0 ? 'WIN_NET_PROFIT' : 'WIN_FEE_EATEN';
      addTo(afterByFactorByGroup.get(safetyFactor)![afterGroup], totalGrossR, totalNetR);
      transitionByFactor.get(safetyFactor)![row.originalGroup][afterGroup] += 1;
    }

    if (idx % 40_000 === 0) {
      console.info(`${idx}/${allRows.length} elapsed=${((Date.now() - startedAt) / 60_000).toFixed(1)}min`);
    }
  }

  if (unresolved > 0) console.info(`unresolved=${unresolved} (entry candle/data-end not found)`);

  function summarize(acc: Accumulator) {
    return {
      count: acc.count,
      avgGrossR: acc.count === 0 ? null : acc.sumGrossR / acc.count,
      avgNetR: acc.count === 0 ? null : acc.sumNetR / acc.count,
      sumNetR: acc.sumNetR,
    };
  }

  const overallSumNetRBefore = GROUPS.reduce((s, g) => s + beforeByGroup[g].sumNetR, 0);
  const report = {
    splitTimestamp: SPLIT_TIMESTAMP,
    totalOosRows: allRows.length,
    unresolved,
    safetyFactorsSwept: SAFETY_FACTORS,
    before: Object.fromEntries(GROUPS.map((g) => [g, summarize(beforeByGroup[g])])),
    overallSumNetRBefore,
    bySafetyFactor: Object.fromEntries(
      SAFETY_FACTORS.map((f) => [
        f,
        {
          after: Object.fromEntries(GROUPS.map((g) => [g, summarize(afterByFactorByGroup.get(f)![g])])),
          transitionCountsBeforeGroupToAfterGroup: transitionByFactor.get(f),
          overallSumNetRAfter: GROUPS.reduce((s, g) => s + afterByFactorByGroup.get(f)![g].sumNetR, 0),
        },
      ]),
    ),
  };

  console.info(JSON.stringify(report, null, 2));
  const outputPath = resolve(
    dataDirectory,
    SAFETY_FACTORS.length > 1 ? 'nukida-ticket04x-b-safety-factor-sweep.json' : 'nukida-ticket04x-oos-before-after.json',
  );
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.info(`Output: ${outputPath}`);
  console.info(`Elapsed: ${((Date.now() - startedAt) / 60_000).toFixed(1)} min`);
}

await main();
