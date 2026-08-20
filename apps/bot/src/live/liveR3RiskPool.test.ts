import { describe, it, expect } from 'vitest';
import { checkRiskPool, wouldExceedRiskPool, type OpenPositionRisk } from '../risk/riskPool.js';
import { DynamicRMarginSizer } from '../risk/dynamicRMarginSizer.js';
import { reconcileExecutedOpenState } from './liveStateSync.js';
import { computeCurrentPositionRisk } from '../risk/currentRisk.js';

describe('TICKET-LIVE-R3 item 2 — $20 fixed risk against a $300 balance, riskPoolMaxPct=0.15 ($45 cap)', () => {
  const accountBalance = 300;
  const riskPoolMaxPct = 0.15;
  const leverage = 30;
  const maxMarginCap = 37.5;
  const slDistancePercent = 0.02;

  const sizing = new DynamicRMarginSizer().calculate({
    accountBalance,
    riskDollarOrPercent: 20,
    entryPrice: 1000,
    slDistancePercent,
    leverage,
    maxMarginCap,
  });

  it('sizing sanity: an uncapped $20 fixed-risk request produces actualRiskDollar of exactly $20', () => {
    expect(sizing.actualRiskDollar).toBeCloseTo(20, 9);
    expect(sizing.marginRequired).toBeLessThanOrEqual(maxMarginCap);
  });

  it('pool budget at $300 balance / 0.15 riskPoolMaxPct is $45', () => {
    const check = checkRiskPool([], accountBalance, { riskPoolMaxPct });
    expect(check.riskPoolMaxDollar).toBeCloseTo(45, 9);
  });

  it('a single $20-risk position is admitted (no existing open positions)', () => {
    const openPositions: OpenPositionRisk[] = [];
    const rejected = wouldExceedRiskPool(openPositions, sizing.actualRiskDollar, accountBalance, { riskPoolMaxPct });
    expect(rejected).toBe(false);
    const check = checkRiskPool(openPositions, accountBalance, { riskPoolMaxPct });
    expect(check.totalRiskDollar).toBeCloseTo(0, 9);
  });

  it('a second $20-risk position on top of the first (total $40) is admitted (still under $45)', () => {
    const openPositions: OpenPositionRisk[] = [{ id: 'pos-1', actualRiskDollar: 20 }];
    const rejected = wouldExceedRiskPool(openPositions, sizing.actualRiskDollar, accountBalance, { riskPoolMaxPct });
    expect(rejected).toBe(false);
    const check = checkRiskPool([...openPositions, { id: 'pos-2', actualRiskDollar: sizing.actualRiskDollar }], accountBalance, { riskPoolMaxPct });
    expect(check.totalRiskDollar).toBeCloseTo(40, 9);
    expect(check.withinLimit).toBe(true);
  });

  it('a third $20-risk position (total $60) is REJECTED because $60 > $45', () => {
    const openPositions: OpenPositionRisk[] = [
      { id: 'pos-1', actualRiskDollar: 20 },
      { id: 'pos-2', actualRiskDollar: 20 },
    ];
    const rejected = wouldExceedRiskPool(openPositions, sizing.actualRiskDollar, accountBalance, { riskPoolMaxPct });
    expect(rejected).toBe(true);
    const check = checkRiskPool([...openPositions, { id: 'pos-3', actualRiskDollar: sizing.actualRiskDollar }], accountBalance, { riskPoolMaxPct });
    expect(check.totalRiskDollar).toBeCloseTo(60, 9);
    expect(check.riskPoolMaxDollar).toBeCloseTo(45, 9);
    expect(check.withinLimit).toBe(false);
  });
});

describe('TICKET-LIVE-R3 item 2 — reconciled actualRiskDollar is NOT forced to the requested $20 after a real fill', () => {
  it('step-size rounding on the real fill produces a reconciled actualRiskDollar that differs from the requested $20', () => {
    const requestedRiskUsd = 20;
    const plannedEntryPrice = 1000;
    const plannedSlPrice = 980;
    const canonicalQty = 0.999;

    const reconciled = reconcileExecutedOpenState({
      initialSlPrice: plannedSlPrice,
      canonicalQty,
      canonicalQtySource: 'EXECUTED_QTY',
      rawAvgPrice: String(plannedEntryPrice),
      freshPositionRiskEntryPrice: String(plannedEntryPrice),
      freshPositionRiskQtyAbs: canonicalQty,
      preSubmissionBaselineQtyAbs: 0,
      quantityTolerance: 0.001,
      leverage: 30,
    });

    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) throw new Error('unreachable');
    expect(reconciled.actualRiskDollar).toBeCloseTo(0.999 * 1000 * (20 / 1000), 9);
    expect(reconciled.actualRiskDollar).not.toBeCloseTo(requestedRiskUsd, 6);
    expect(reconciled.actualRiskDollar).toBeCloseTo(19.98, 9);

    const currentRisk = computeCurrentPositionRisk({
      side: 'LONG',
      entryPrice: reconciled.entryPrice,
      currentSlPrice: plannedSlPrice,
      remainingPositionSize: reconciled.positionSize,
    });
    expect(currentRisk.openRiskDollar).toBeCloseTo(reconciled.actualRiskDollar, 9);
    expect(currentRisk.openRiskDollar).not.toBeCloseTo(requestedRiskUsd, 6);

    const rejected = wouldExceedRiskPool([], currentRisk.openRiskDollar, 300, { riskPoolMaxPct: 0.15 });
    expect(rejected).toBe(false);
    const check = checkRiskPool([{ id: 'reconciled-pos', actualRiskDollar: currentRisk.openRiskDollar }], 300, { riskPoolMaxPct: 0.15 });
    expect(check.totalRiskDollar).toBeCloseTo(19.98, 9);
    expect(check.totalRiskDollar).not.toBeCloseTo(20, 6);
  });
});
