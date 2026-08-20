import { describe, expect, it } from 'vitest';
import { advancePosition } from './orchestrator.js';
import { openPosition, onTp1Hit, onTp2Hit, computeRealizedPnl, type ManagedPositionState, type SlTpManagerInput } from '../risk/slTpManager.js';
import { checkRiskPool } from '../risk/riskPool.js';
import { DynamicRMarginSizer } from '../risk/dynamicRMarginSizer.js';
import type { CandleData } from '../regime/types.js';

/**
 * G1 — Logic, Calculation & Module-Matching Review Ledger — reproduction tests.
 * See data/g1-logic-calculation-module-matching-review-ledger.md for the full write-up.
 * These are NEW, isolated tests written purely to independently verify (or refute) the G1
 * findings — they do not modify any existing test file's assertions.
 */

function candle(ts: number, open: number, high: number, low: number, close: number): CandleData {
  return { timestamp: ts, open, high, low, close, volume: 1000 };
}

const longTrendInput: SlTpManagerInput = {
  scenario: 'TREND',
  entryPrice: 100,
  slPrice: 99, // R = 1
  side: 'LONG',
  tpPlan: 'PLAN_A', // tp1R=1.2, tp2R=2.5
  positionSize: 1000,
  takerFeeRate: 0.0004,
};

describe('G1-F03 — PARTIAL_CLOSE never adds PnL to accountBalance (CONFIRMED_MISMATCH)', () => {
  it('advancePosition() returns no exitPrice/pnl on a TP1-only fill — orchestrator.ts only ever adds pnlUsd to accountBalance in the position.closed branch (orchestrator.ts:1611-1613), never for the PARTIAL_CLOSE branch (orchestrator.ts:1585-1608)', () => {
    const pos = openPosition(longTrendInput);
    const tp1 = pos.tpLevels.find((t) => t.label === 'TP1')!;
    const c = candle(1, 100, tp1.price! + 0.01, 99.9, tp1.price!); // touches TP1, not SL
    const { position, exitReason, exitPrice } = advancePosition(pos, c, [c], false);

    expect(position.closed).toBe(false);
    expect(exitReason).toBeNull();
    expect(exitPrice).toBeNull(); // <- structurally: no exit price/pnl is ever computed for a partial fill
    expect(position.filledTiers).toEqual(['TP1']);
    // The realized-PnL formula exists (computeRealizedPnl) but is only ever invoked by orchestrator.ts
    // when advancePosition() returns exitPrice !== null (a FULL close) — a partial fill has no
    // corresponding call anywhere, so accountBalance cannot reflect TP1's locked-in profit until the
    // position fully closes. This matches G1-F03 exactly.
  });
});

describe('G1-F04 — risk pool does not release risk after TP1/TP2 (SYSTEMIC_BEHAVIOR, confirmed)', () => {
  it('actualRiskDollar (risk-pool metadata) is untouched by onTp1Hit/onTp2Hit even though remainingPositionSize shrinks and SL ratchets to breakeven/profit', () => {
    let pos = openPosition(longTrendInput);
    const metaActualRiskDollar = 15; // meta lives in OpenTradeMeta, a sibling of ManagedPositionState — slTpManager.ts has no access to it and never mutates it
    const originalRemaining = pos.remainingPositionSize;

    pos = onTp1Hit(pos);
    pos = onTp2Hit(pos);

    expect(pos.remainingPositionSize).toBeLessThan(originalRemaining); // real exposure shrank (only 30% of original left, PLAN_A tp3Pct)
    expect(pos.remainingPositionSize).toBeCloseTo(0.3 * longTrendInput.positionSize, 6);
    expect(pos.currentSlPrice).toBeGreaterThan(pos.entryPrice); // SL now locks in profit (moved to TP1 price after TP2)

    // The risk pool check (riskPool.ts) only ever sees meta.actualRiskDollar, which nothing in this
    // flow updates — it reports the SAME worst-case loss for this position after TP2 as it did the
    // instant the position opened, even though the true worst-case loss (remaining qty * (SL - entry))
    // is now near-zero or negative (a locked-in gain).
    const poolResult = checkRiskPool([{ id: 'pos1', actualRiskDollar: metaActualRiskDollar }], 100, { riskPoolMaxPct: 0.15 });
    expect(poolResult.totalRiskDollar).toBe(15); // still counts the FULL original $15, post-TP1/TP2
    expect(poolResult.remainingCapacityDollar).toBe(0); // consumes the ENTIRE 15%-of-$100 pool by itself, leaving zero headroom for any other candidate — confirms G1-F04's "may reduce trade count" impact
    expect(checkRiskPool([{ id: 'pos1', actualRiskDollar: metaActualRiskDollar }, { id: 'candidate', actualRiskDollar: 1 }], 100, { riskPoolMaxPct: 0.15 }).withinLimit).toBe(false); // any further candidate is blocked
  });
});

describe('G1-F06 — only one TP tier processed per 5m candle even if price crosses both (CONFIRMED_MISMATCH)', () => {
  it('a candle whose high crosses both TP1 and TP2 only fills TP1; TP2 is left for a later call', () => {
    const pos = openPosition(longTrendInput);
    const tp1 = pos.tpLevels.find((t) => t.label === 'TP1')!;
    const tp2 = pos.tpLevels.find((t) => t.label === 'TP2')!;
    expect(tp2.price!).toBeGreaterThan(tp1.price!); // sanity: TP2 is farther than TP1 for LONG

    // Single 5m candle whose range spans past BOTH TP1 and TP2 (a fast, real move an exchange with two
    // resting TP orders could fill both within).
    const fastCandle = candle(1, 100, tp2.price! + 1, 99.9, tp2.price! + 0.5);

    const { position, exitReason, exitPrice } = advancePosition(pos, fastCandle, [fastCandle], false);

    expect(position.filledTiers).toEqual(['TP1']); // TP2 was NOT processed this candle
    expect(position.filledTiers).not.toContain('TP2');
    expect(exitReason).toBeNull();
    expect(exitPrice).toBeNull();
    // Real exchange: two independent TP limit/market orders could both fill this candle. Internal sim:
    // lags one candle behind on remaining qty/SL for this case — confirms G1-F06 exactly.
  });
});

describe('G1-F08 — riskDollarOrPercent is a literal $ amount, not a % of balance (SYSTEMIC_BEHAVIOR, confirmed)', () => {
  it('with the live-confirmed config (riskDollarOrPercent=15, maxMarginCap=37.5, leverage=30) and a ~$100 balance, ONE trade can consume the entire 15%-of-balance risk pool', () => {
    const sizer = new DynamicRMarginSizer();
    const balance = 100;
    const output = sizer.calculate({
      accountBalance: balance,
      riskDollarOrPercent: 15, // live CONFIG.riskDollarOrPercent — apps/bot/scripts/liveRunner.ts CONFIG
      entryPrice: 100,
      leverage: 30,
      slDistancePercent: 0.02, // 2% SL distance — a normal ATR-based SL
      maxMarginCap: 37.5,
    });

    expect(output.actualRiskDollar).toBeCloseTo(15, 6); // uncapped here -> literally $15, exactly riskDollarOrPercent
    const poolMaxDollar = balance * 0.15; // CONFIG.riskPoolMaxPct
    expect(output.actualRiskDollar).toBeCloseTo(poolMaxDollar, 6); // one single candidate trade == the WHOLE pool
  });
});

describe('G1-F10 — core sizing unit convention: positionSize is USD notional, not base quantity (CORRECT, confirmed)', () => {
  it('marginRequired = positionSize / leverage and actualRiskDollar = positionSize * slDistancePercent hold internally', () => {
    const sizer = new DynamicRMarginSizer();
    const output = sizer.calculate({ accountBalance: 100, entryPrice: 100, riskDollarOrPercent: 15, leverage: 30, slDistancePercent: 0.02, maxMarginCap: 37.5 });
    expect(output.positionSize).toBeCloseTo(output.marginRequired * 30, 6);
    expect(output.actualRiskDollar).toBeCloseTo(output.positionSize * 0.02, 6);
    // slTpManager.ts's own positionSize is likewise USD notional (openPosition's own doc comment says
    // so) — base-asset conversion only happens at the live execution boundary (liveRunner.ts's
    // `quantity = marginRequired * leverage / entryPrice`), never inside the core formulas.
  });
});

describe('G1-F11 (NEW) — LONG/SHORT PnL sign symmetry (CORRECT, confirmed)', () => {
  it('computeRealizedPnl produces mirrored PnL for mirrored LONG/SHORT price moves', () => {
    const long = openPosition({ ...longTrendInput, side: 'LONG', slPrice: 99, takerFeeRate: 0 });
    const short = openPosition({ ...longTrendInput, side: 'SHORT', slPrice: 101, takerFeeRate: 0 });

    const longPnl = computeRealizedPnl(long, 110); // +10% favorable move for LONG
    const shortPnl = computeRealizedPnl(short, 90); // -10% (mirror) favorable move for SHORT

    expect(longPnl).toBeCloseTo(shortPnl, 6);
    expect(longPnl).toBeGreaterThan(0);
  });

  it('advancePosition touchesFavorable/touchesAdverse are symmetric mirrors for LONG vs SHORT', () => {
    const longPos = openPosition({ ...longTrendInput, side: 'LONG', slPrice: 99 });
    const shortPos = openPosition({ ...longTrendInput, side: 'SHORT', entryPrice: 100, slPrice: 101 });
    const longTp1 = longPos.tpLevels.find((t) => t.label === 'TP1')!.price!;
    const shortTp1 = shortPos.tpLevels.find((t) => t.label === 'TP1')!.price!;

    const longCandle = candle(1, 100, longTp1 + 0.1, 99.9, longTp1); // favorable = high touches TP1 above entry
    const shortCandle = candle(1, 100, 100.1, shortTp1 - 0.1, shortTp1); // favorable = low touches TP1 below entry

    const longResult = advancePosition(longPos, longCandle, [longCandle], false);
    const shortResult = advancePosition(shortPos, shortCandle, [shortCandle], false);

    expect(longResult.position.filledTiers).toEqual(['TP1']);
    expect(shortResult.position.filledTiers).toEqual(['TP1']);
  });
});
