import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BinanceOrderExecutor } from './binanceOrderExecutor.js';
import { verifyProtectiveSlOrder } from './liveStateSync.js';
import { computeCurrentPositionRisk } from '../risk/currentRisk.js';
import { openPosition, onTp1Hit, onTp2Hit, onSlHit, computeTierNetPnl, computeRealizedPnl, type SlTpManagerInput } from '../risk/slTpManager.js';

/**
 * TICKET-G1R Final Closure ("G1R-final") — tests for items 1-5 of the final closure ticket, on top
 * of Checkpoints A-D (balance ownership, executed-state reconciliation, restart recovery, current
 * risk). Same testing style/conventions as g1rBalanceOwnershipFix.test.ts /
 * g1rExecutedStateReconciliationFix.test.ts / g1rRestartRecoveryFix.test.ts /
 * g1rCurrentRiskFix.test.ts: real pure-function behavior tests + liveRunner.ts source-wiring checks
 * (liveRunner.ts/backtest.ts cannot be imported directly — main()/CLI run unconditionally on import).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const liveRunnerSrc = fs.readFileSync(path.resolve(__dirname, '../../scripts/liveRunner.ts'), 'utf8');
const orchestratorSrc = fs.readFileSync(path.resolve(__dirname, '../orchestrator/orchestrator.ts'), 'utf8');

const CREDS = { apiKey: 'k', apiSecret: 's', baseUrl: 'https://testnet.example' };
function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, statusText: 'x', headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

// ==== Item 5 — current-risk doc-comment fix: equivalence re-derivation (not a repeat of currentRisk.test.ts's own suite, just the ticket's explicit formula) ====

describe('Item 5 — currentRisk.ts LONG/SHORT formulas match Math.abs()+favorable implementation', () => {
  it.each([
    // side, entry, sl, expectedOpenRisk (qty=1 for simplicity)
    ['LONG', 100, 98, 2], // entry-SL=2 (unfavorable, SL below entry)
    ['LONG', 100, 102, 0], // entry-SL=-2 -> max(0,-2)=0 (favorable, SL above entry)
    ['SHORT', 100, 102, 2], // SL-entry=2 (unfavorable, SL above entry)
    ['SHORT', 100, 98, 0], // SL-entry=-2 -> max(0,-2)=0 (favorable, SL below entry)
  ] as const)('%s entry=%d sl=%d -> openRisk=%d (qty=1)', (side, entry, sl, expected) => {
    const result = computeCurrentPositionRisk({ side, entryPrice: entry, currentSlPrice: sl, remainingPositionSize: entry /* remainingPositionSize/entryPrice=1 */ });
    expect(result.openRiskDollar).toBeCloseTo(expected, 9);
  });
});

// ==== Item 2 — getOpenAlgoOrders() adapter ====

describe('Item 2 — BinanceOrderExecutor.getOpenAlgoOrders()', () => {
  it('is NOT gated by dryRun (read-only, same convention as getAccountInfo/getPositionRisk/getIncome)', async () => {
    const rawOrder = { algoId: 1, symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', origQty: '0.1', triggerPrice: '49000', algoStatus: 'NEW', orderType: 'STOP_MARKET', algoType: 'CONDITIONAL', reduceOnly: true, closePosition: false };
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse(200, [rawOrder]));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, fetchFn }); // dryRun defaults true
    const result = await exec.getOpenAlgoOrders('BTCUSDT');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ algoId: 1, symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', origQty: 0.1, triggerPrice: 49000, algoStatus: 'NEW', orderType: 'STOP_MARKET', algoType: 'CONDITIONAL', reduceOnly: true, closePosition: false, raw: rawOrder }]);
  });

  // TICKET-G1R-A ROUND 2 item 1: endpoint path corrected from '/fapi/v1/algoOpenOrders' to the
  // ccxt-confirmed real path '/fapi/v1/openAlgoOrders' (word order) — see binanceOrderExecutor.ts's
  // getOpenAlgoOrders() doc comment for the evidence (ccxt/ccxt binance.ts fapiPrivate endpoint table).
  it('queries /fapi/v1/openAlgoOrders with the symbol param when given', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse(200, []));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, fetchFn });
    await exec.getOpenAlgoOrders('ETHUSDT');
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain('/fapi/v1/openAlgoOrders');
    expect(url).toContain('symbol=ETHUSDT');
  });

  it('also accepts an { orders: [...] } envelope shape (unconfirmed exact envelope, parsed defensively)', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse(200, { total: 1, orders: [{ algoId: 2, symbol: 'BTCUSDT', side: 'BUY', positionSide: 'BOTH', quantity: '0.2', stopPrice: '51000', algoStatus: 'NEW', orderType: 'STOP_MARKET', algoType: 'CONDITIONAL', reduceOnly: true }] }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, fetchFn });
    const result = await exec.getOpenAlgoOrders('BTCUSDT');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ algoId: 2, side: 'BUY', origQty: 0.2, triggerPrice: 51000 });
  });

  it('throws (never silently returns []) on a response shape that is neither an array nor {orders:[]}', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse(200, { unexpected: 'shape' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, fetchFn });
    await expect(exec.getOpenAlgoOrders('BTCUSDT')).rejects.toThrow(/response shape/);
  });

  it('throws on a malformed entry (missing algoId/origQty/triggerPrice) rather than silently coercing to NaN', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse(200, [{ symbol: 'BTCUSDT' }]));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, fetchFn });
    // Message wording changed with TICKET-G1R-A item 3's strict per-field parser (it now names the
    // exact field that failed instead of a combined "thiếu/không hợp lệ algoId/origQty/triggerPrice").
    await expect(exec.getOpenAlgoOrders('BTCUSDT')).rejects.toThrow(/algoId không hữu hạn/);
  });
});

// ==== Item 2 — verifyProtectiveSlOrder() pure reconciliation logic ====

describe('Item 2 — verifyProtectiveSlOrder()', () => {
  const openOrders = [{ algoId: 555, symbol: 'BTCUSDT', side: 'SELL' as const, positionSide: 'BOTH' as const, origQty: 0.1, triggerPrice: 49000, algoStatus: 'NEW', orderType: 'STOP_MARKET' as const, algoType: 'CONDITIONAL', reduceOnly: true, closePosition: false, raw: {} }];

  it('VERIFIED when the persisted slAlgoId is open, correct side (LONG->SELL), correct qty within tolerance', () => {
    const result = verifyProtectiveSlOrder({ persistedSlAlgoId: 555, expectedSide: 'LONG', expectedQty: 0.1, quantityTolerance: 0.001, openAlgoOrders: openOrders });
    expect(result.status).toBe('VERIFIED');
  });

  it('NO_PERSISTED_ORDERS when there was no slAlgoId to check at all', () => {
    const result = verifyProtectiveSlOrder({ persistedSlAlgoId: null, expectedSide: 'LONG', expectedQty: 0.1, quantityTolerance: 0.001, openAlgoOrders: openOrders });
    expect(result.status).toBe('NO_PERSISTED_ORDERS');
  });

  it('MISSING when the persisted algoId is no longer in the real open-orders list (cancelled/filled/never existed)', () => {
    const result = verifyProtectiveSlOrder({ persistedSlAlgoId: 999, expectedSide: 'LONG', expectedQty: 0.1, quantityTolerance: 0.001, openAlgoOrders: openOrders });
    expect(result.status).toBe('MISSING');
  });

  it('WRONG_SIDE when the found order has the wrong side for the expected position side', () => {
    const wrongSideOrders = [{ ...openOrders[0], side: 'BUY' as const }];
    const result = verifyProtectiveSlOrder({ persistedSlAlgoId: 555, expectedSide: 'LONG', expectedQty: 0.1, quantityTolerance: 0.001, openAlgoOrders: wrongSideOrders });
    expect(result.status).toBe('WRONG_SIDE');
  });

  it('WRONG_QTY when the found order quantity diverges beyond tolerance', () => {
    const result = verifyProtectiveSlOrder({ persistedSlAlgoId: 555, expectedSide: 'LONG', expectedQty: 5, quantityTolerance: 0.001, openAlgoOrders: openOrders });
    expect(result.status).toBe('WRONG_QTY');
  });

  it('never auto-replaces/cancels anything — pure decision function, no side effects, no executor param at all', () => {
    // Type-level proof: verifyProtectiveSlOrder's params contain no executor/mutating capability.
    const src = fs.readFileSync(path.resolve(__dirname, 'liveStateSync.ts'), 'utf8');
    const fnStart = src.indexOf('export function verifyProtectiveSlOrder(');
    const fnBody = src.slice(fnStart, src.indexOf('\n}', fnStart));
    expect(fnBody).not.toMatch(/cancelAlgoOrder|placeStopMarket|placeTakeProfitMarket/);
  });
});

// ==== Item 2 — liveRunner.ts wiring: restart-time protective-order verification ====

describe('Item 2 — liveRunner.ts wiring: protective-order verification after restart recovery', () => {
  it('calls getOpenAlgoOrders() for symbols with a recovered persisted slAlgoId, AFTER restart recovery and BEFORE the tick loop starts', () => {
    const recoveryIdx = liveRunnerSrc.indexOf('const restartRecovery = await performStartupRestartRecovery(');
    const verifyIdx = liveRunnerSrc.indexOf('await executor.getOpenAlgoOrders(outcome.symbol)');
    const feedStartIdx = liveRunnerSrc.indexOf('await feed.start();');
    expect(recoveryIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(recoveryIdx);
    expect(verifyIdx).toBeLessThan(feedStartIdx);
  });

  it('a non-VERIFIED result quarantines the position (reuses entriesBlockedDueToRestartQuarantineBySymbol) and removes it from openPositions — never re-places an SL itself', () => {
    // TICKET-G1R-B Runtime Wiring Pass: item 3 wrapped this branch's `continue` in a block that also
    // calls the new verifyTpTiersAndWarn() helper — same VERIFIED short-circuit, legitimately grown.
    const verifyBlockIdx = liveRunnerSrc.indexOf("if (verification.status === 'VERIFIED') {");
    const addIdx = liveRunnerSrc.indexOf('entriesBlockedDueToRestartQuarantineBySymbol.add(outcome.symbol);', verifyBlockIdx);
    const filterIdx = liveRunnerSrc.indexOf('rsForVerify.symbolState.openPositions = rsForVerify.symbolState.openPositions.filter(', verifyBlockIdx);
    expect(verifyBlockIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(verifyBlockIdx);
    expect(filterIdx).toBeGreaterThan(verifyBlockIdx);
    expect(liveRunnerSrc).not.toMatch(/verification\.status[\s\S]{0,400}placeStopMarket/);
  });

  it('a getOpenAlgoOrders() read failure flips accountSyncState to ACCOUNT_STATE_UNKNOWN rather than treating the position as protected', () => {
    const readIdx = liveRunnerSrc.indexOf('openAlgoOrders = await executor.getOpenAlgoOrders(outcome.symbol);');
    const catchIdx = liveRunnerSrc.indexOf("accountSyncState = 'ACCOUNT_STATE_UNKNOWN';", readIdx);
    expect(readIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeGreaterThan(readIdx);
    expect(catchIdx - readIdx).toBeLessThan(300);
  });
});

// ==== Item 3 — explicit AccountSyncState admission gate ====

describe('Item 3 — AccountSyncState wiring in liveRunner.ts', () => {
  it('hasUnquantifiableExposureBlockingAdmission has a 3rd OR condition: accountSyncState === ACCOUNT_STATE_UNKNOWN', () => {
    // TICKET-G1R-A "Final Safety Hotfix" items 1/5 reformatted this to a multi-line `const` (adding
    // the PROTECTION_DEGRADED and balance/protective-cycle freshness OR conditions) — the original
    // 3-condition one-liner this test scanned for no longer exists verbatim; updated to check each
    // condition is still present (never silently dropped) instead of the exact old single-line string.
    const idx = liveRunnerSrc.indexOf('const hasUnquantifiableExposureBlockingAdmission =');
    expect(idx).toBeGreaterThan(-1);
    const decl = liveRunnerSrc.slice(idx, idx + 600);
    expect(decl).toContain('entriesBlockedDueToRestartQuarantineBySymbol.size > 0');
    expect(decl).toContain("accountSyncState === 'ACCOUNT_STATE_UNKNOWN'");
  });

  it('a failed balance read (refreshBalanceForTelegram) flips accountSyncState to ACCOUNT_STATE_UNKNOWN', () => {
    const nullCheckIdx = liveRunnerSrc.indexOf('if (outcome.snapshot === null) {');
    const flipIdx = liveRunnerSrc.indexOf("accountSyncState = 'ACCOUNT_STATE_UNKNOWN';", nullCheckIdx);
    expect(nullCheckIdx).toBeGreaterThan(-1);
    expect(flipIdx).toBeGreaterThan(nullCheckIdx);
    expect(flipIdx - nullCheckIdx).toBeLessThan(500);
  });

  it('recovery to SYNCED requires BOTH a successful balance read AND a subsequent getPositionRisk() confirmation — never the balance read alone, never a timer', () => {
    const recoveryBlockIdx = liveRunnerSrc.indexOf("if (accountSyncState === 'ACCOUNT_STATE_UNKNOWN') {");
    const getPosRiskIdx = liveRunnerSrc.indexOf('const posRisk = await executor.getPositionRisk();', recoveryBlockIdx);
    const syncedIdx = liveRunnerSrc.indexOf("accountSyncState = 'SYNCED';", recoveryBlockIdx);
    expect(recoveryBlockIdx).toBeGreaterThan(-1);
    expect(getPosRiskIdx).toBeGreaterThan(recoveryBlockIdx);
    expect(syncedIdx).toBeGreaterThan(getPosRiskIdx);
    expect(liveRunnerSrc).not.toMatch(/setTimeout[\s\S]{0,200}accountSyncState = 'SYNCED'/);
  });

  it('never auto-clears on a bare timer anywhere in the file', () => {
    // The only setTimeout usages in this file are unrelated (sleep/backoff in the executor, not here) —
    // confirm no setTimeout call anywhere near an accountSyncState assignment.
    const idx = liveRunnerSrc.indexOf('accountSyncState');
    expect(idx).toBeGreaterThan(-1);
    expect(liveRunnerSrc).not.toMatch(/setTimeout\([^)]*\)[\s\S]{0,100}accountSyncState/);
  });
});

// ==== Item 4 — in-run retry for unreconciled-fill block ====

// ==== Item 1 — partial/full PnL lifecycle: no double-count, verified (existing design, not modified) ====

describe('Item 1 — partial/full PnL lifecycle: no double-count (verification, orchestrator.ts/slTpManager.ts NOT modified)', () => {
  const baseInput: SlTpManagerInput = {
    scenario: 'TREND',
    entryPrice: 100,
    slPrice: 98,
    side: 'LONG',
    tpPlan: 'PLAN_A',
    positionSize: 1000,
    takerFeeRate: 0.0004,
  };

  it('a TP1 partial fill\'s computeTierNetPnl() is display-only — orchestrator.ts never adds it to accountBalance (PARTIAL_CLOSE branch has no accountBalance mutation)', () => {
    // TICKET-G1R-A item 3 (Cách B) updated this string: the branch now builds an updated `meta`
    // (bookedRealizedPnl ledger, audit-only) instead of pushing `entry.meta` verbatim — documented
    // here, not silently. The semantic property under test (accountBalance itself is never mutated
    // in this branch) is unchanged and still asserted below.
    const partialBlockStart = orchestratorSrc.indexOf("type: 'PARTIAL_CLOSE',");
    const partialBlockEnd = orchestratorSrc.indexOf('remainingPositions.push({ position, meta });', partialBlockStart);
    const partialBlock = orchestratorSrc.slice(partialBlockStart - 400, partialBlockEnd);
    expect(partialBlock).not.toMatch(/accountBalance\s*\+=/);
    expect(partialBlock).not.toMatch(/accountBalance\s*=\s*(?!input\.accountBalance)/); // no reassignment other than the initial `let accountBalance = input.accountBalance` earlier in the function
  });

  it('the full CLOSE event adds computeRealizedPnl() to accountBalance EXACTLY ONCE (single += site in the whole function)', () => {
    const matches = orchestratorSrc.match(/accountBalance\s*\+=\s*pnlUsd;/g);
    expect(matches).toHaveLength(1);
  });

  it('computeRealizedPnl() at full close already includes every previously-filled tier\'s PnL (TP1+TP2) PLUS the remainder, fees subtracted exactly once — end-to-end proof that crediting it once == crediting the whole lifetime PnL exactly once, never re-adding a partial nor missing one', () => {
    let state = openPosition(baseInput);
    const tp1 = state.tpLevels.find((t) => t.label === 'TP1')!;
    const tp2 = state.tpLevels.find((t) => t.label === 'TP2')!;
    state = onTp1Hit(state);
    const tp1DisplayPnl = computeTierNetPnl(state, 'TP1'); // Telegram-only, never booked
    state = onTp2Hit(state);
    const tp2DisplayPnl = computeTierNetPnl(state, 'TP2'); // Telegram-only, never booked
    state = onSlHit(state); // Runner (remaining 30%) exits at the ratcheted SL (TP1's price, per onTp2Hit)
    const finalExitPrice = state.currentSlPrice;
    const totalCreditedOnce = computeRealizedPnl(state, finalExitPrice);

    // Manually re-derive the "should be" total: sum of each tier's OWN gross leg (at ITS OWN price)
    // minus total fees once — this is exactly what a correct "credit once, no double-count, no
    // missed leg" bookkeeping should equal, independent of computeRealizedPnl's own implementation.
    const grossTp1 = tp1.closePercent * baseInput.positionSize * ((tp1.price! - baseInput.entryPrice) / baseInput.entryPrice);
    const grossTp2 = tp2.closePercent * baseInput.positionSize * ((tp2.price! - baseInput.entryPrice) / baseInput.entryPrice);
    const remainingPct = 1 - tp1.closePercent - tp2.closePercent;
    const grossRemainder = remainingPct * baseInput.positionSize * ((finalExitPrice - baseInput.entryPrice) / baseInput.entryPrice);
    const totalFees = baseInput.positionSize * baseInput.takerFeeRate * 2;
    const expectedTotal = grossTp1 + grossTp2 + grossRemainder - totalFees;

    expect(totalCreditedOnce).toBeCloseTo(expectedTotal, 9);
    // The display-only partial numbers are a DIFFERENT (fee-adjusted-per-tier) estimate, proving they
    // are not simply summed into totalCreditedOnce anywhere (no coincidental equality expected/asserted
    // as a sum) — they exist purely for the "Đã chốt X%" Telegram message, never for bookkeeping.
    expect(tp1DisplayPnl + tp2DisplayPnl).not.toBeCloseTo(totalCreditedOnce, 2);
  });

  it('G1-F01 (Checkpoint A, unmodified): a fresh exchange balance OVERWRITES (never adds to) accountBalance, so even if a live open/partial/close event ran while an exchange read landed this tick, the simulator\'s own incremental accounting is fully discarded, not stacked on top', () => {
    // Source-scan proof this fix (Checkpoint A) is still exactly in place — no new liveRunner.ts logic
    // added by this ticket touches accountBalance's core assignment/overwrite semantics.
    // TICKET-G1R-A "Final Internal Closure" item 1 STRENGTHENED this: overwrite (never add) semantics
    // are unchanged, but they now live in the single applyBalanceObservation() writer, and the
    // simulated write-back was REMOVED outright rather than merely gated.
    expect(liveRunnerSrc).toContain("source: 'event:refreshBalanceForTelegram'");
    expect(liveRunnerSrc).not.toMatch(/accountBalance = result\.accountBalance;/);
  });

  it('Telegram balance display always sources the LIVE number from the exchange snapshot, never the modeled accountBalance, when exchangeBalance is passed (liveRunner.ts always passes it)', () => {
    const formattersSrc = fs.readFileSync(path.resolve(__dirname, '../telegram/messageFormatters.ts'), 'utf8');
    expect(formattersSrc).toContain("if (exchangeBalance === null) return `💼 Balance: pending exchange sync`;");
    // liveRunner.ts always calls formatPositionOpenedMessage/formatPartialCloseMessage/formatFullCloseMessage
    // with an explicit exchangeBalance (snapshot-or-null), never omitting the field (which would fall
    // back to the legacy internal-number branch) — confirmed by call-site grep.
    const callSites = [...liveRunnerSrc.matchAll(/format(PositionOpened|PartialClose|FullClose)Message\([^)]*exchangeBalance[^)]*\)/gs)];
    expect(callSites.length).toBeGreaterThanOrEqual(3);
  });
});
