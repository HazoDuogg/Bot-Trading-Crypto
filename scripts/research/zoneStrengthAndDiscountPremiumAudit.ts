/**
 * TICKET-27X-H — diagnostic only, no production code touched, no PnL computed.
 * Two candidate filters, checked against the ADVERSE_FIRST@1.0R split from TICKET-27X-G:
 *   1. Zone Strength — did the displacement that created the entry zone actually CLOSE past
 *      the prior swing (BROKE_STRUCTURE), or just wick into it (WEAK_PULLBACK)?
 *   2. Discount/Premium — was entry taken below (DISCOUNT) or above (PREMIUM) the 50% mark
 *      of the nearest H1 swing leg, on the correct side for its direction?
 * Must run against the pre-27X-F baseline (same 449 trades TICKET-27X-G measured), not the
 * current confluenceScore-fixed code, per the ticket's own note — see README note below.
 * Run: tsx scripts/research/zoneStrengthAndDiscountPremiumAudit.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Candle } from "../../src/core/types.js";
import { detectEntry } from "../../src/entry/entryRouter.js";
import { checkExit } from "../../src/exit/exitManager.js";
import { computeStopLoss, computeOrderSizes, type OrderSize } from "../../src/risk/positionSizer.js";
import { computeTargets, decideTradeSplit } from "../../src/entry/targets.js";
import { advanceRegistry, type Zone } from "../../src/entry/zoneRegistry.js";
import { calculateTR } from "../../src/regime/adxDiCompare.js";
import { startOfUtcDay, type ClosedTrade } from "../../src/risk/dailyThrottle.js";
import { computeConfluenceScore } from "../../src/entry/confluenceScore.js";
import { MIN_CANDLES as MIN_DAILY_CANDLES } from "../../src/regime/regimeDetector.js";
import { M5_WINDOW_SIZE, TAKER_FEE_PCT, MAKER_FEE_PCT } from "../../src/core/orchestrator.js";
import { detectSwingPoints } from "../../src/entry/liquidity.js";
import { computeH1TradingRange } from "../../src/entry/tradingRange.js";

const DAILY_PATH = resolve("data/ohlcv-BTCUSDT-1d.json");
const H1_PATH = resolve("data/ohlcv-BTCUSDT-1h.json");
const M15_PATH = resolve("data/ohlcv-BTCUSDT-15m.json");
const M5_PATH = resolve("data/ohlcv-BTCUSDT-5m.json");

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

type ZoneStrength = "BROKE_STRUCTURE" | "WEAK_PULLBACK" | "INSUFFICIENT_DATA";
type PricePosition = "DISCOUNT" | "PREMIUM";

interface AuditTradeRecord {
  direction: "UP" | "DOWN";
  entryPrice: number;
  stopLoss: number;
  entryTick: number;
  exitReason: "SL_HIT" | "TP_HIT" | null;
  closeTime: number | null;
  zone: Zone;
  h1Range: { low: number; high: number } | null;
}

// --- Metric 1: Zone Strength (TICKET-27X-H, locked per the ticket) ---
// Uses the zone's own createdAtIndex (the M15 candle whose close resolved the displacement) and
// detectSwingPoints unchanged — no new zone-detection or swing logic written.
function computeZoneStrength(m15All: Candle[], zone: Zone): ZoneStrength {
  const displacementIndex = zone.createdAtIndex;
  const displacementCandle = m15All[displacementIndex];
  const wantKind = zone.type === "demand" ? "high" : "low";
  // Causal: swings confirmed using only candles strictly before the displacement candle.
  const swingsBefore = detectSwingPoints(m15All.slice(0, displacementIndex)).filter((s) => s.type === wantKind);
  if (swingsBefore.length === 0) return "INSUFFICIENT_DATA";
  const nearestSwing = swingsBefore[swingsBefore.length - 1];
  const broke = zone.type === "demand" ? displacementCandle.close > nearestSwing.price : displacementCandle.close < nearestSwing.price;
  return broke ? "BROKE_STRUCTURE" : "WEAK_PULLBACK";
}

// --- Metric 2: Discount/Premium (TICKET-27X-H, locked per the ticket) ---
// Reuses computeH1TradingRange unchanged (same H1 leg tradingRange.ts already uses). Exactly at
// the 50% mark counts as PREMIUM (closed boundary toward Premium, per the ticket's own convention).
function computePricePosition(h1Range: { low: number; high: number }, entryPrice: number): PricePosition {
  const mid = (h1Range.low + h1Range.high) / 2;
  return entryPrice < mid ? "DISCOUNT" : "PREMIUM";
}
function isSideCorrect(direction: "UP" | "DOWN", position: PricePosition): boolean {
  return (direction === "UP" && position === "DISCOUNT") || (direction === "DOWN" && position === "PREMIUM");
}

// --- Synthetic verification (must pass before touching real data, per project convention) ---
let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

const M15_MS = 15 * 60 * 1000;
function m15(i: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime: i * M15_MS, closeTime: i * M15_MS + M15_MS - 1, open, high, low, close, volume: 1 };
}
function zoneAt(type: "demand" | "supply", createdAtIndex: number): Zone {
  return {
    id: "z",
    type,
    high: 0,
    low: 0,
    createdAtIndex,
    state: "VALID",
    touchCount: 0,
    imbalance: null,
    imbalanceMitigated: false,
    hasNearbyLiquidity: false,
    nearbyLiquidityLevel: null,
    liquiditySwept: false,
  };
}

function runSyntheticVerification(): void {
  // --- Zone Strength ---
  // 1. Clean 5-candle fractal swing high at index 2 (price 110), then later displacement closes above it -> BROKE_STRUCTURE.
  {
    const candles = [
      m15(0, 100, 101, 99, 100),
      m15(1, 100, 105, 99, 100),
      m15(2, 100, 110, 99, 100), // swing high, price 110
      m15(3, 100, 104, 99, 100),
      m15(4, 100, 103, 99, 100),
      m15(5, 100, 102, 99, 100),
      m15(6, 100, 115, 99, 112), // displacement candle, closes at 112 > 110
    ];
    const zone = zoneAt("demand", 6);
    check("zoneStrength: close clearly breaks prior swing high -> BROKE_STRUCTURE", computeZoneStrength(candles, zone), "BROKE_STRUCTURE");
  }

  // 2. Same swing high (110), displacement wicks above it but closes back under -> WEAK_PULLBACK.
  {
    const candles = [
      m15(0, 100, 101, 99, 100),
      m15(1, 100, 105, 99, 100),
      m15(2, 100, 110, 99, 100), // swing high, price 110
      m15(3, 100, 104, 99, 100),
      m15(4, 100, 103, 99, 100),
      m15(5, 100, 102, 99, 100),
      m15(6, 100, 115, 99, 108), // wicks to 115 (past 110) but closes at 108 (< 110)
    ];
    const zone = zoneAt("demand", 6);
    check("zoneStrength: wick past swing, close under it -> WEAK_PULLBACK", computeZoneStrength(candles, zone), "WEAK_PULLBACK");
  }

  // 3. No swing exists before the displacement (start of series) -> INSUFFICIENT_DATA, not forced to a label.
  {
    const candles = [m15(0, 100, 101, 99, 100), m15(1, 100, 115, 99, 112)];
    const zone = zoneAt("demand", 1);
    check("zoneStrength: no prior swing -> INSUFFICIENT_DATA", computeZoneStrength(candles, zone), "INSUFFICIENT_DATA");
  }

  // --- Discount/Premium ---
  const upLeg = { low: 100, high: 200 }; // 100-point leg, 50% = 150
  // 1. Long entry at 30% from the bottom (130) -> DISCOUNT, sideCorrect=true.
  {
    const pos = computePricePosition(upLeg, 130);
    check("discountPremium: Long at 30% -> DISCOUNT", pos, "DISCOUNT");
    check("discountPremium: Long at 30% -> sideCorrect true", isSideCorrect("UP", pos), true);
  }
  // 2. Long entry at 70% from the bottom (170) -> PREMIUM, sideCorrect=false.
  {
    const pos = computePricePosition(upLeg, 170);
    check("discountPremium: Long at 70% -> PREMIUM", pos, "PREMIUM");
    check("discountPremium: Long at 70% -> sideCorrect false", isSideCorrect("UP", pos), false);
  }
  // 3. Entry exactly at the 50% mark (150) -> PREMIUM by convention (closed boundary toward Premium).
  {
    const pos = computePricePosition(upLeg, 150);
    check("discountPremium: exactly at 50% -> PREMIUM (convention)", pos, "PREMIUM");
  }
}

// --- Real backtest replay: a faithful parallel of orchestrator.ts's onCandle, extended to also
// capture the EntrySetup's zone and the H1 trading range at entry (neither survives into the real
// TradeRecord, so they can't be recovered from backtest-report.json or a plain orchestrator run). ---
const ATR_PERIOD = 14;
function extendAtr(atr15: number[], trSum: { sum: number; count: number }, prevCandle: Candle | null, newCandle: Candle): void {
  if (!prevCandle) {
    atr15.push(0);
    return;
  }
  const tr = calculateTR(newCandle.high, newCandle.low, prevCandle.close);
  if (trSum.count < ATR_PERIOD) {
    trSum.sum += tr;
    trSum.count += 1;
    atr15.push(trSum.sum / trSum.count);
  } else {
    atr15.push((atr15[atr15.length - 1] * (ATR_PERIOD - 1) + tr) / ATR_PERIOD);
  }
}

interface OpenOrderLocal extends OrderSize {
  closed: boolean;
  record: AuditTradeRecord;
}

function runBacktest(dailyAll: Candle[], h1All: Candle[], m15All: Candle[], m5All: Candle[]): AuditTradeRecord[] {
  const initialEquity = 10_000;
  let openPosition: { direction: "UP" | "DOWN"; orders: OpenOrderLocal[] } | null = null;
  const closedTrades: ClosedTrade[] = [];
  const tradeLog: AuditTradeRecord[] = [];

  const m15History: Candle[] = [];
  const atr15: number[] = [];
  const trSum = { sum: 0, count: 0 };
  let registry: Zone[] = [];
  const h1History: Candle[] = [];
  const m5History: Candle[] = [];

  function currentEquity(): number {
    return closedTrades.reduce((sum, t) => sum + t.realizedPnl, initialEquity);
  }

  let d1Index = 0;
  let h1Index = 0;
  let m15Index = 0;
  let cachedDaily: Candle[] = [];
  let lastD1Index = -1;

  for (let i = 0; i < m5All.length; i++) {
    const m5Candle = m5All[i];
    const now = m5Candle.closeTime;

    while (d1Index < dailyAll.length && dailyAll[d1Index].closeTime <= now) d1Index++;
    if (d1Index !== lastD1Index) {
      cachedDaily = dailyAll.slice(0, d1Index);
      lastD1Index = d1Index;
    }

    const newH1: Candle[] = [];
    while (h1Index < h1All.length && h1All[h1Index].closeTime <= now) {
      newH1.push(h1All[h1Index]);
      h1Index++;
    }
    for (const c of newH1) h1History.push(c);

    const newM15: Candle[] = [];
    while (m15Index < m15All.length && m15All[m15Index].closeTime <= now) {
      newM15.push(m15All[m15Index]);
      m15Index++;
    }
    for (const candle of newM15) {
      const prevCandle = m15History.length > 0 ? m15History[m15History.length - 1] : null;
      m15History.push(candle);
      extendAtr(atr15, trSum, prevCandle, candle);
      registry = advanceRegistry(registry, m15History, atr15, m15History.length - 1);
    }

    m5History.push(m5Candle);
    if (m5History.length > M5_WINDOW_SIZE) m5History.splice(0, m5History.length - M5_WINDOW_SIZE);
    const m5TickCount = i + 1;

    const latestM5 = m5History[m5History.length - 1];

    if (openPosition) {
      for (const order of openPosition.orders) {
        if (order.closed) continue;
        const result = checkExit(order, openPosition.direction, latestM5);
        if (result.reason === "NONE") continue;
        order.closed = true;
        const sign = openPosition.direction === "UP" ? 1 : -1;
        const grossPnl = sign * order.quantity * ((result.exitPrice as number) - order.entryPrice);
        const entryFee = order.quantity * order.entryPrice * TAKER_FEE_PCT;
        const exitFeeRate = result.reason === "TP_HIT" ? MAKER_FEE_PCT : TAKER_FEE_PCT;
        const exitFee = order.quantity * (result.exitPrice as number) * exitFeeRate;
        const pnl = grossPnl - entryFee - exitFee;
        closedTrades.push({ closeTime: latestM5.closeTime, realizedPnl: pnl });
        order.record.exitReason = result.reason;
        order.record.closeTime = latestM5.closeTime;
      }
      if (openPosition.orders.every((o) => o.closed)) openPosition = null;
      continue;
    }

    if (currentEquity() <= 0) continue;
    if (m15History.length === 0 || cachedDaily.length < MIN_DAILY_CANDLES) continue;

    const startOfDayEquity = closedTrades.filter((t) => t.closeTime < startOfUtcDay(latestM5.closeTime)).reduce((sum, t) => sum + t.realizedPnl, initialEquity);
    const setup = detectEntry(cachedDaily, registry, h1History, m5History, closedTrades, startOfDayEquity);
    if (!setup) continue;

    const atrAtEntry = atr15[atr15.length - 1];
    const entryPrice = latestM5.close;
    const slPrice = computeStopLoss(setup.direction, setup.zone, atrAtEntry);

    const targets = computeTargets(setup.direction, entryPrice, registry, cachedDaily);
    const splitDecision = decideTradeSplit(setup.direction, entryPrice, slPrice, targets);

    const orders = computeOrderSizes(splitDecision, setup.direction, entryPrice, slPrice, currentEquity());
    if (!orders) continue;

    void computeConfluenceScore; // not needed for this audit's grouping — kept imported for parity with orchestrator.ts
    const h1Range = computeH1TradingRange(h1History);

    const openOrders: OpenOrderLocal[] = orders.map((o) => {
      const record: AuditTradeRecord = {
        direction: setup.direction,
        entryPrice: o.entryPrice,
        stopLoss: o.stopLoss,
        entryTick: m5TickCount,
        exitReason: null,
        closeTime: null,
        zone: setup.zone,
        h1Range,
      };
      tradeLog.push(record);
      return { ...o, closed: false, record };
    });

    openPosition = { direction: setup.direction, orders: openOrders };
  }

  return tradeLog;
}

// Same TIE_BREAK='SL_FIRST' classification as TICKET-27X-C/G, reused unchanged.
function classifyFirstTouch(candles: Candle[], entryPrice: number, slPrice: number, direction: "UP" | "DOWN", rMultiple: number): "FAVORABLE_FIRST" | "ADVERSE_FIRST" {
  const slDistance = Math.abs(entryPrice - slPrice);
  const favorableLevel = direction === "UP" ? entryPrice + rMultiple * slDistance : entryPrice - rMultiple * slDistance;
  for (const c of candles) {
    const slHit = direction === "UP" ? c.low <= slPrice : c.high >= slPrice;
    const favHit = direction === "UP" ? c.high >= favorableLevel : c.low <= favorableLevel;
    if (slHit) return "ADVERSE_FIRST";
    if (favHit) return "FAVORABLE_FIRST";
  }
  return "ADVERSE_FIRST";
}

function main() {
  console.log("--- Synthetic verification ---");
  runSyntheticVerification();
  if (failures > 0) {
    console.log(`\n${failures} synthetic check(s) FAILED — not running against real data.`);
    process.exitCode = 1;
    return;
  }
  console.log("\nAll synthetic checks passed.\n");

  console.log("--- Running real backtest (causal replay, diagnostic only) ---");
  const dailyAll = loadJson<Candle[]>(DAILY_PATH);
  const h1All = loadJson<Candle[]>(H1_PATH);
  const m15All = loadJson<Candle[]>(M15_PATH);
  const m5All = loadJson<Candle[]>(M5_PATH);
  const tradeLog = runBacktest(dailyAll, h1All, m15All, m5All);
  console.log(`Total trades: ${tradeLog.length}`);

  const closeTimeToM5Index = new Map<number, number>();
  m5All.forEach((c, i) => closeTimeToM5Index.set(c.closeTime, i));

  interface Classified {
    group: "A_ADVERSE_FIRST_1R" | "B_OTHER";
    zoneStrength: ZoneStrength;
    sideCorrect: boolean | null; // null when h1Range unavailable
  }
  const classified: Classified[] = [];
  let skippedNoH1Range = 0;

  for (const t of tradeLog) {
    let group: Classified["group"] = "B_OTHER";
    if (t.exitReason === "SL_HIT") {
      const entryM5Index = t.entryTick - 1;
      const slHitIndex = closeTimeToM5Index.get(t.closeTime as number);
      if (slHitIndex !== undefined && slHitIndex > entryM5Index) {
        const window = m5All.slice(entryM5Index + 1, slHitIndex + 1);
        const result = classifyFirstTouch(window, t.entryPrice, t.stopLoss, t.direction, 1.0);
        if (result === "ADVERSE_FIRST") group = "A_ADVERSE_FIRST_1R";
      }
    }

    const zoneStrength = computeZoneStrength(m15All, t.zone);
    const sideCorrect = t.h1Range ? isSideCorrect(t.direction, computePricePosition(t.h1Range, t.entryPrice)) : null;
    if (!t.h1Range) skippedNoH1Range++;

    classified.push({ group, zoneStrength, sideCorrect });
  }

  console.log(`(no H1 trading range available at entry for ${skippedNoH1Range} trades — sideCorrect left null for those)\n`);

  function summarize(label: string, group: Classified["group"]) {
    const subset = classified.filter((c) => c.group === group);
    const n = subset.length;
    const broke = subset.filter((c) => c.zoneStrength === "BROKE_STRUCTURE").length;
    const weak = subset.filter((c) => c.zoneStrength === "WEAK_PULLBACK").length;
    const insufficient = subset.filter((c) => c.zoneStrength === "INSUFFICIENT_DATA").length;
    const sideKnown = subset.filter((c) => c.sideCorrect !== null);
    const sideCorrectCount = sideKnown.filter((c) => c.sideCorrect === true).length;
    const both = subset.filter((c) => c.zoneStrength === "WEAK_PULLBACK" && c.sideCorrect === false).length;

    console.log(`${label} (n=${n}):`);
    console.log(`  BROKE_STRUCTURE: ${broke} (${n > 0 ? ((broke / n) * 100).toFixed(1) : "0.0"}%)`);
    console.log(`  WEAK_PULLBACK: ${weak} (${n > 0 ? ((weak / n) * 100).toFixed(1) : "0.0"}%)`);
    console.log(`  INSUFFICIENT_DATA: ${insufficient} (${n > 0 ? ((insufficient / n) * 100).toFixed(1) : "0.0"}%)`);
    console.log(
      `  sideCorrect=true: ${sideCorrectCount}/${sideKnown.length} (${sideKnown.length > 0 ? ((sideCorrectCount / sideKnown.length) * 100).toFixed(1) : "n/a"}%)`,
    );
    console.log(`  WEAK_PULLBACK + sideCorrect=false (cross-tab): ${both} (${n > 0 ? ((both / n) * 100).toFixed(1) : "0.0"}%)`);
  }

  summarize("Group A: ADVERSE_FIRST@1.0R (straight to SL)", "A_ADVERSE_FIRST_1R");
  summarize("Group B: everyone else", "B_OTHER");
}

main();
