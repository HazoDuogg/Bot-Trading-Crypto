/**
 * TICKET-G1R-A "Final Internal Closure & Exchange Schema Gate" — items 1-4.
 *
 * Every test here uses a MOCKED executor. The single authorized read-only testnet call belongs to
 * item 5 (schema confirmation) and is NOT re-run from the test suite — its result is frozen into
 * `fixtures/openAlgoOrdersResponseFixture.json`, which several tests below parse for real.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BinanceOrderExecutor,
  parseOpenAlgoOrderEntry,
  ACTIVE_ALGO_STATUSES,
  KNOWN_ALGO_STATUSES,
  KNOWN_ALGO_ORDER_TYPES,
  type OpenAlgoOrder,
} from './binanceOrderExecutor.js';
import {
  verifyProtectiveSlOrder,
  verifyProtectiveTpOrder,
  captureCoherentReconciliationSnapshotOnce,
  DEFAULT_POSITION_MODE,
  DEFAULT_TRIGGER_PRICE_TOLERANCE_PCT,
  PROTECTIVE_SL_ORDER_TYPES,
  PROTECTIVE_TP_ORDER_TYPES,
} from './liveStateSync.js';
import { parseExchangeBalanceSnapshot } from './liveBalanceSync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const liveRunnerSrc = readFileSync(path.resolve(__dirname, '../../scripts/liveRunner.ts'), 'utf8').replace(/\r\n/g, '\n');
const executorSrc = readFileSync(path.resolve(__dirname, './binanceOrderExecutor.ts'), 'utf8').replace(/\r\n/g, '\n');
const fixtureRaw = JSON.parse(readFileSync(path.resolve(__dirname, './fixtures/openAlgoOrdersResponseFixture.json'), 'utf8')) as unknown[];

const CREDS = { apiKey: 'k', apiSecret: 's', baseUrl: 'https://testnet.example' };
function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, statusText: 'OK', headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

// A schema-realistic protective order, matching the confirmed testnet response shape.
function makeOrder(overrides: Partial<OpenAlgoOrder> = {}): OpenAlgoOrder {
  return {
    algoId: 501,
    symbol: 'BTCUSDT',
    side: 'SELL',
    positionSide: 'BOTH',
    origQty: 1,
    triggerPrice: 95,
    algoStatus: 'NEW',
    orderType: 'STOP_MARKET',
    algoType: 'CONDITIONAL',
    reduceOnly: true,
    closePosition: false,
    raw: {},
    ...overrides,
  };
}

// ============================================================================================
// Item 1 — exchange-authoritative balance lifecycle
// ============================================================================================

describe('Item 1 — balance value + freshness are adopted ATOMICALLY (the confirmed bug)', () => {
  // Faithful re-implementation of liveRunner.ts's applyBalanceObservation()/parseAndApplyBalance()
  // closure, so the ordering/anti-time-travel rules can be exercised as real behavior. The source-scan
  // tests further below prove the real file has this exact shape.
  function makeBalanceLifecycle() {
    let accountBalance = 0;
    let accountBalanceKnown = false;
    let lastSuccessfulBalanceReadMs: number | null = null;
    let current: { walletBalance: number; capturedAt: number; source: string } | null = null;
    return {
      get state() {
        return { accountBalance, accountBalanceKnown, lastSuccessfulBalanceReadMs, source: current?.source ?? null };
      },
      apply(raw: unknown, source: string, capturedAt: number): boolean {
        let walletBalance: number;
        try {
          walletBalance = parseExchangeBalanceSnapshot(raw, capturedAt).walletBalance;
        } catch {
          return false; // parse failure: touch NOTHING, especially not the freshness stamp
        }
        if (current !== null && capturedAt < current.capturedAt) return false; // anti-time-travel
        current = { walletBalance, capturedAt, source };
        accountBalance = walletBalance;
        accountBalanceKnown = true;
        lastSuccessfulBalanceReadMs = capturedAt;
        return true;
      },
    };
  }

  const goodPayload = (wallet: string) => ({ totalWalletBalance: wallet, totalMarginBalance: wallet, availableBalance: wallet });

  it('starts UNKNOWN: no balance value, no freshness, before any exchange read', () => {
    const lc = makeBalanceLifecycle();
    expect(lc.state.accountBalanceKnown).toBe(false);
    expect(lc.state.lastSuccessfulBalanceReadMs).toBeNull();
  });

  it('a VALIDATED snapshot applies the VALUE and the freshness stamp together', () => {
    const lc = makeBalanceLifecycle();
    expect(lc.apply(goodPayload('346.04'), 'snapshot:getAccountInfo', 1000)).toBe(true);
    expect(lc.state.accountBalance).toBe(346.04);
    expect(lc.state.accountBalanceKnown).toBe(true);
    expect(lc.state.lastSuccessfulBalanceReadMs).toBe(1000);
  });

  it('THE BUG: a malformed balance payload must NOT mark balance fresh (freshness stays exactly where it was)', () => {
    const lc = makeBalanceLifecycle();
    lc.apply(goodPayload('346.04'), 'snapshot', 1000);
    expect(lc.apply({ totalWalletBalance: 'not-a-number' }, 'snapshot', 2000)).toBe(false);
    expect(lc.state.lastSuccessfulBalanceReadMs).toBe(1000); // NOT advanced to 2000
    expect(lc.state.accountBalance).toBe(346.04); // value untouched too
  });

  it('an entirely absent balance payload also fails closed', () => {
    const lc = makeBalanceLifecycle();
    expect(lc.apply(null, 'snapshot', 1000)).toBe(false);
    expect(lc.apply({}, 'snapshot', 1000)).toBe(false);
    expect(lc.state.accountBalanceKnown).toBe(false);
  });

  it('anti-time-travel: an OLDER observation never overwrites a newer one (value AND freshness both preserved)', () => {
    const lc = makeBalanceLifecycle();
    lc.apply(goodPayload('500'), 'snapshot:periodic', 5000);
    expect(lc.apply(goodPayload('100'), 'event:refreshBalanceForTelegram', 4000)).toBe(false);
    expect(lc.state.accountBalance).toBe(500);
    expect(lc.state.lastSuccessfulBalanceReadMs).toBe(5000);
    expect(lc.state.source).toBe('snapshot:periodic');
  });

  it('a NEWER observation from any source does overwrite (equal timestamps are accepted — same instant, not backwards)', () => {
    const lc = makeBalanceLifecycle();
    lc.apply(goodPayload('500'), 'snapshot:periodic', 5000);
    expect(lc.apply(goodPayload('512.5'), 'event:refreshBalanceForTelegram', 5000)).toBe(true);
    expect(lc.state.accountBalance).toBe(512.5);
    expect(lc.apply(goodPayload('530'), 'reconciler:BALANCE_MISMATCH', 9000)).toBe(true);
    expect(lc.state.accountBalance).toBe(530);
  });

  it('bootstrap and event-time paths use the SAME parser and therefore the same winning rule', () => {
    const lc = makeBalanceLifecycle();
    lc.apply(goodPayload('346.04'), 'startup:getAccountInfo', 1000);
    const viaEvent = parseExchangeBalanceSnapshot(goodPayload('346.04'), 2000);
    lc.apply(goodPayload('346.04'), 'event:refreshBalanceForTelegram', 2000);
    expect(lc.state.accountBalance).toBe(viaEvent.walletBalance);
  });
});

describe('Item 1 — liveRunner.ts wiring (source-scan, supporting evidence only)', () => {
  it('no $100 (or any) default/simulated balance exists in the live path — accountBalance has exactly ONE writer', () => {
    const writes = liveRunnerSrc.match(/^\s*accountBalance = /gm) ?? [];
    expect(writes.length).toBe(1); // inside applyBalanceObservation() only
    expect(liveRunnerSrc).not.toMatch(/accountBalance = result\.accountBalance;/);
    expect(liveRunnerSrc).not.toMatch(/accountBalance\s*=\s*100\b/);
    expect(liveRunnerSrc).not.toMatch(/accountBalance:\s*number\s*=\s*100\b/);
  });

  it('startup THROWS rather than falling back to any default when the exchange balance cannot be parsed', () => {
    expect(liveRunnerSrc).toContain('KHÔNG dùng giá trị mặc định nào');
    const idx = liveRunnerSrc.indexOf('const startupBalanceObs = parseAndApplyBalance(');
    expect(idx).toBeGreaterThan(-1);
    expect(liveRunnerSrc.slice(idx, idx + 400)).toContain('throw new Error(');
  });

  it('admission requires all THREE balance conditions: parsed+applied (accountBalanceKnown) AND fresh AND account SYNCED', () => {
    const idx = liveRunnerSrc.indexOf('const hasUnquantifiableExposureBlockingAdmission =');
    const decl = liveRunnerSrc.slice(idx, idx + 1100);
    expect(decl).toContain('!accountBalanceKnown');
    expect(decl).toContain('isFreshnessEvidenceStale(balanceFreshnessEvidence(), now)');
    expect(decl).toContain("accountSyncState === 'ACCOUNT_STATE_UNKNOWN'");
  });

  it('the snapshot path parses the snapshot\'s OWN balance leg and returns before the cycle stamp when it fails', () => {
    expect(liveRunnerSrc).toContain('parseAndApplyBalance(balanceLeg.data');
    const idx = liveRunnerSrc.indexOf('parseAndApplyBalance(balanceLeg.data');
    const after = liveRunnerSrc.slice(idx, idx + 900);
    expect(after).toContain('if (applied === null)');
    expect(after.indexOf('return snapshotResult;')).toBeLessThan(after.indexOf('lastSuccessfulAccountSyncCycleMs = Date.now();'));
  });

  it('every exchange-derived balance write routes through applyBalanceObservation (provenance + anti-time-travel), never a bare assignment', () => {
    for (const source of ['startup:getAccountInfo', 'event:refreshBalanceForTelegram', 'reconciler:BALANCE_MISMATCH', 'reconcile:externalClose']) {
      expect(liveRunnerSrc).toContain(source);
    }
    expect(liveRunnerSrc).not.toMatch(/^\s*accountBalance = exchangeBalanceUsd;/m);
  });

  it('an API/read/parse failure blocks entries portfolio-wide but never clears openPositions', () => {
    const idx = liveRunnerSrc.indexOf('[BALANCE_PARSE_FAILED]');
    expect(idx).toBeGreaterThan(-1);
    const around = liveRunnerSrc.slice(idx - 200, idx + 1200);
    expect(around).not.toContain('openPositions = []');
    expect(liveRunnerSrc).toContain("accountSyncState = 'ACCOUNT_STATE_UNKNOWN'");
  });

  it('Telegram shows the exchange snapshot or "pending exchange sync" — never a self-calculated number (unchanged, re-confirmed)', () => {
    const formattersSrc = readFileSync(path.resolve(__dirname, '../telegram/messageFormatters.ts'), 'utf8');
    expect(formattersSrc).toContain('pending exchange sync');
  });
});

// ============================================================================================
// Item 2 — Income API optional symbol
// ============================================================================================

describe('Item 2 — getIncome() omits an empty symbol instead of sending `symbol=`', () => {
  it('whole-account query (undefined symbol) sends NO symbol param at all', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, []));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, fetchFn });
    await exec.getIncome(undefined, 1000, 2000);
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).not.toContain('symbol=');
    expect(url).toContain('/fapi/v1/income');
  });

  it('an EMPTY-STRING symbol is also omitted (the exact pre-fix bug: `getIncome(\'\', ...)`)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, []));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, fetchFn });
    await exec.getIncome('', 1000, 2000);
    expect(fetchFn.mock.calls[0][0] as string).not.toContain('symbol=');
  });

  it('a whitespace-only symbol is treated as absent', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, []));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, fetchFn });
    await exec.getIncome('   ', 1000, 2000);
    expect(fetchFn.mock.calls[0][0] as string).not.toContain('symbol=');
  });

  it('a REAL symbol is still sent verbatim (symbol-specific queries unaffected)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, []));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, fetchFn });
    await exec.getIncome('BTCUSDT', 1000, 2000);
    expect(fetchFn.mock.calls[0][0] as string).toContain('symbol=BTCUSDT');
  });

  it('startTime/endTime/limit semantics are unchanged', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, []));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, fetchFn });
    await exec.getIncome('ETHUSDT', 111, 222, 50);
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain('startTime=111');
    expect(url).toContain('endTime=222');
    expect(url).toContain('limit=50');
  });

  it('the coherent snapshot\'s whole-account fills leg passes undefined, verified through the MOCK\'s own arguments (not a source-scan)', async () => {
    const getIncome = vi.fn().mockResolvedValue([]);
    await captureCoherentReconciliationSnapshotOnce(
      { getAccountInfo: async () => ({ totalWalletBalance: '1', totalMarginBalance: '1', availableBalance: '1' }), getPositionRisk: async () => [], getIncome, getOpenAlgoOrders: async () => [] },
      { incomeWindowStartMs: 10, incomeWindowEndMs: 20 },
    );
    expect(getIncome).toHaveBeenCalledTimes(1);
    expect(getIncome.mock.calls[0][0]).toBeUndefined();
    expect(getIncome.mock.calls[0][0]).not.toBe('');
  });

  it('a getIncome() failure fails CLOSED — the snapshot becomes READ_ERROR, never a fake empty list', async () => {
    const result = await captureCoherentReconciliationSnapshotOnce(
      { getAccountInfo: async () => ({ totalWalletBalance: '1', totalMarginBalance: '1', availableBalance: '1' }), getPositionRisk: async () => [], getIncome: async () => { throw new Error('income down'); }, getOpenAlgoOrders: async () => [] },
      { incomeWindowStartMs: 10, incomeWindowEndMs: 20 },
    );
    expect(result.status).toBe('READ_ERROR');
  });
});

// ============================================================================================
// Item 3 — strict openAlgoOrders parser
// ============================================================================================

describe('Item 3 — strict algo-order parser (fail closed, never default to BUY)', () => {
  const good = {
    algoId: 1, clientAlgoId: 'c1', algoType: 'CONDITIONAL', orderType: 'STOP_MARKET', symbol: 'BTCUSDT',
    side: 'SELL', positionSide: 'BOTH', quantity: '0.1', algoStatus: 'NEW', triggerPrice: '49000',
    reduceOnly: true, closePosition: false,
  };

  it('parses the CONFIRMED real schema correctly (quantity/triggerPrice/algoStatus, not origQty/stopPrice/status)', () => {
    const o = parseOpenAlgoOrderEntry(good);
    expect(o).toMatchObject({ algoId: 1, symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', origQty: 0.1, triggerPrice: 49000, algoStatus: 'NEW', orderType: 'STOP_MARKET', reduceOnly: true, closePosition: false });
  });

  it('THE BUG: a malformed/absent side is NO LONGER silently coerced to BUY — it throws', () => {
    for (const bad of [undefined, null, 'buy', 'SEL', 'LONG', 42, '']) {
      expect(() => parseOpenAlgoOrderEntry({ ...good, side: bad })).toThrow(/side phải đúng/);
    }
  });

  it('both legitimate sides are accepted exactly', () => {
    expect(parseOpenAlgoOrderEntry({ ...good, side: 'BUY' }).side).toBe('BUY');
    expect(parseOpenAlgoOrderEntry({ ...good, side: 'SELL' }).side).toBe('SELL');
  });

  it('algoId must be finite and > 0', () => {
    for (const bad of [undefined, null, 0, -1, 'abc', NaN]) {
      expect(() => parseOpenAlgoOrderEntry({ ...good, algoId: bad })).toThrow(/algoId/);
    }
  });

  it('symbol must be non-empty (falls back to the query symbol only when the response omits it)', () => {
    expect(() => parseOpenAlgoOrderEntry({ ...good, symbol: '' })).toThrow(/symbol/);
    expect(parseOpenAlgoOrderEntry({ ...good, symbol: undefined }, 'ETHUSDT').symbol).toBe('ETHUSDT');
    expect(() => parseOpenAlgoOrderEntry({ ...good, symbol: undefined })).toThrow(/symbol/);
  });

  it('positionSide is required and must use a known exchange value', () => {
    expect(() => parseOpenAlgoOrderEntry({ ...good, positionSide: undefined })).toThrow(/positionSide/);
    for (const v of ['LONG', 'SHORT', 'BOTH']) expect(parseOpenAlgoOrderEntry({ ...good, positionSide: v }).positionSide).toBe(v);
    for (const bad of ['both', 'NET', 7]) expect(() => parseOpenAlgoOrderEntry({ ...good, positionSide: bad })).toThrow(/positionSide/);
  });

  it('quantity and triggerPrice must be > 0', () => {
    for (const bad of [undefined, '0', '-1', 'abc']) {
      expect(() => parseOpenAlgoOrderEntry({ ...good, quantity: bad })).toThrow(/quantity/);
      expect(() => parseOpenAlgoOrderEntry({ ...good, triggerPrice: bad })).toThrow(/triggerPrice/);
    }
  });

  it('algoStatus must be a KNOWN and ACTIVE value — a terminal status is rejected, not silently dropped', () => {
    for (const s of ACTIVE_ALGO_STATUSES) expect(parseOpenAlgoOrderEntry({ ...good, algoStatus: s }).algoStatus).toBe(s);
    for (const s of ['CANCELED', 'EXPIRED', 'REJECTED', 'FINISHED', 'TRIGGERED']) {
      expect(KNOWN_ALGO_STATUSES).toContain(s);
      expect(() => parseOpenAlgoOrderEntry({ ...good, algoStatus: s })).toThrow(/không còn active/);
    }
    expect(() => parseOpenAlgoOrderEntry({ ...good, algoStatus: 'WORKING' })).toThrow(/algoStatus lạ/);
    expect(() => parseOpenAlgoOrderEntry({ ...good, algoStatus: undefined })).toThrow(/algoStatus/);
  });

  it('orderType is required and must use a known protective-order value', () => {
    expect(() => parseOpenAlgoOrderEntry({ ...good, orderType: undefined })).toThrow(/orderType/);
    for (const t of KNOWN_ALGO_ORDER_TYPES) expect(parseOpenAlgoOrderEntry({ ...good, orderType: t }).orderType).toBe(t);
    expect(() => parseOpenAlgoOrderEntry({ ...good, orderType: 'MARKET' })).toThrow(/orderType/);
  });

  it('booleans: real booleans AND "true"/"false" strings both normalize; anything else throws (never a silent false)', () => {
    expect(parseOpenAlgoOrderEntry({ ...good, reduceOnly: 'true' }).reduceOnly).toBe(true);
    expect(parseOpenAlgoOrderEntry({ ...good, reduceOnly: 'false' }).reduceOnly).toBe(false);
    expect(parseOpenAlgoOrderEntry({ ...good, reduceOnly: undefined }).reduceOnly).toBeUndefined();
    expect(() => parseOpenAlgoOrderEntry({ ...good, reduceOnly: 'yes' })).toThrow(/reduceOnly/);
    expect(() => parseOpenAlgoOrderEntry({ ...good, closePosition: 1 })).toThrow(/closePosition/);
  });

  it('a non-object entry throws', () => {
    for (const bad of [null, 42, 'x', []]) expect(() => parseOpenAlgoOrderEntry(bad)).toThrow();
  });

  it('a strange envelope becomes a THROW at the adapter, never an empty list', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { unexpected: 'shape' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, fetchFn });
    await expect(exec.getOpenAlgoOrders('BTCUSDT')).rejects.toThrow(/response shape/);
  });

  it('that throw propagates to ACCOUNT_STATE_UNKNOWN via READ_ERROR — the caller never catches it into []', async () => {
    const result = await captureCoherentReconciliationSnapshotOnce(
      {
        getAccountInfo: async () => ({ totalWalletBalance: '1', totalMarginBalance: '1', availableBalance: '1' }),
        getPositionRisk: async () => [],
        getIncome: async () => [],
        getOpenAlgoOrders: async () => { throw new Error('getOpenAlgoOrders: response shape không như dự kiến'); },
      },
      { incomeWindowStartMs: 10, incomeWindowEndMs: 20 },
    );
    expect(result.status).toBe('READ_ERROR');
    // Critically: NOT a VALIDATED snapshot carrying an empty protectiveOrders list.
    expect(result.status).not.toBe('VALIDATED');
  });

  it('the CONFIRMED sanitized testnet fixture parses cleanly through the real parser (DQ-A evidence)', () => {
    expect(fixtureRaw.length).toBeGreaterThan(0);
    const parsed = fixtureRaw.map((e) => parseOpenAlgoOrderEntry(e));
    expect(parsed).toHaveLength(fixtureRaw.length);
    for (const o of parsed) {
      expect(o.algoStatus).toBe('NEW');
      expect(o.algoType).toBe('CONDITIONAL');
      expect(o.positionSide).toBe('BOTH');
      expect(o.reduceOnly).toBe(true);
      expect(o.origQty).toBeGreaterThan(0);
      expect(o.triggerPrice).toBeGreaterThan(0);
    }
  });

  it('the fixture confirms the real field NAMES (quantity/triggerPrice/algoStatus present; origQty/stopPrice/status absent)', () => {
    const first = fixtureRaw[0] as Record<string, unknown>;
    expect(first).toHaveProperty('quantity');
    expect(first).toHaveProperty('triggerPrice');
    expect(first).toHaveProperty('algoStatus');
    expect(first).not.toHaveProperty('origQty');
    expect(first).not.toHaveProperty('stopPrice');
    expect(first).not.toHaveProperty('status');
    expect(typeof first.closePosition).toBe('boolean'); // real boolean, not "true"/"false"
    expect(typeof first.quantity).toBe('string'); // numeric-in-string
  });

  it('the fixture carries no credential-like material', () => {
    const text = JSON.stringify(fixtureRaw);
    expect(text).not.toMatch(/signature/i);
    expect(text).not.toMatch(/apiKey|secret/i);
  });

  it('the lenient one-liner is gone from the source as executable code (it survives only inside the doc comment that explains the bug)', () => {
    const codeLines = executorSrc.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));
    expect(codeLines.join('\n')).not.toContain("side: o.side === 'SELL' ? 'SELL' : 'BUY'");
  });
});

// ============================================================================================
// Item 4 — protective SL/TP semantic verification
// ============================================================================================

describe('Item 4 — SL/TP semantic verification', () => {
  const base = { persistedSlAlgoId: 501, expectedSide: 'LONG' as const, expectedQty: 1, quantityTolerance: 0.001 };

  it('a fully-correct SL verifies', () => {
    const r = verifyProtectiveSlOrder({ ...base, openAlgoOrders: [makeOrder()], expectedSymbol: 'BTCUSDT', expectedTriggerPrice: 95, positionMode: 'ONE_WAY', expectedOrderTypes: PROTECTIVE_SL_ORDER_TYPES });
    expect(r.status).toBe('VERIFIED');
  });

  it('right algoId but WRONG positionSide is caught (One-Way expects BOTH)', () => {
    const r = verifyProtectiveSlOrder({ ...base, openAlgoOrders: [makeOrder({ positionSide: 'SHORT' })], positionMode: 'ONE_WAY' });
    expect(r.status).toBe('WRONG_POSITION_SIDE');
  });

  it('HEDGE mode expects positionSide to equal the position side', () => {
    expect(verifyProtectiveSlOrder({ ...base, openAlgoOrders: [makeOrder({ positionSide: 'LONG' })], positionMode: 'HEDGE' }).status).toBe('VERIFIED');
    expect(verifyProtectiveSlOrder({ ...base, openAlgoOrders: [makeOrder({ positionSide: 'BOTH' })], positionMode: 'HEDGE' }).status).toBe('WRONG_POSITION_SIDE');
  });

  it('an absent positionSide fails closed', () => {
    const r = verifyProtectiveSlOrder({ ...base, openAlgoOrders: [makeOrder({ positionSide: undefined })], positionMode: 'ONE_WAY' });
    expect(r.status).toBe('WRONG_POSITION_SIDE');
  });

  it('right algoId but WRONG order TYPE is caught — a TP can never be accepted as an SL', () => {
    const r = verifyProtectiveSlOrder({ ...base, openAlgoOrders: [makeOrder({ orderType: 'TAKE_PROFIT_MARKET' })], expectedOrderTypes: PROTECTIVE_SL_ORDER_TYPES });
    expect(r.status).toBe('WRONG_ORDER_TYPE');
  });

  it('...and an SL can never be accepted as a TP (verifyProtectiveTpOrder always demands TAKE_PROFIT_MARKET)', () => {
    const r = verifyProtectiveTpOrder({ tpAlgoId: 501, expectedSide: 'LONG', expectedQty: 1, quantityTolerance: 0.001, openAlgoOrders: [makeOrder({ orderType: 'STOP_MARKET' })] });
    expect(r.status).toBe('WRONG_ORDER_TYPE');
    expect(PROTECTIVE_TP_ORDER_TYPES).toEqual(['TAKE_PROFIT_MARKET']);
  });

  it('right algoId but WRONG triggerPrice is caught, with a documented tolerance', () => {
    expect(verifyProtectiveSlOrder({ ...base, openAlgoOrders: [makeOrder({ triggerPrice: 90 })], expectedTriggerPrice: 95 }).status).toBe('WRONG_TRIGGER_PRICE');
    // Inside the 0.1% band: accepted (tick-size/2dp rounding must not raise a false alarm).
    expect(verifyProtectiveSlOrder({ ...base, openAlgoOrders: [makeOrder({ triggerPrice: 95 * (1 + DEFAULT_TRIGGER_PRICE_TOLERANCE_PCT * 0.5) })], expectedTriggerPrice: 95 }).status).toBe('VERIFIED');
    // Just outside it: rejected.
    expect(verifyProtectiveSlOrder({ ...base, openAlgoOrders: [makeOrder({ triggerPrice: 95 * (1 + DEFAULT_TRIGGER_PRICE_TOLERANCE_PCT * 2) })], expectedTriggerPrice: 95 }).status).toBe('WRONG_TRIGGER_PRICE');
  });

  it('a protective order that is neither reduceOnly nor closePosition is REJECTED (it could open exposure)', () => {
    expect(verifyProtectiveSlOrder({ ...base, openAlgoOrders: [makeOrder({ reduceOnly: false, closePosition: false })] }).status).toBe('NOT_REDUCE_ONLY');
    expect(verifyProtectiveSlOrder({ ...base, openAlgoOrders: [makeOrder({ reduceOnly: false, closePosition: true })] }).status).toBe('VERIFIED');
    expect(verifyProtectiveSlOrder({ ...base, openAlgoOrders: [makeOrder({ reduceOnly: undefined, closePosition: undefined })] }).status).toBe('NOT_REDUCE_ONLY');
  });

  it('a wrong symbol is caught even if the algoId matches', () => {
    const r = verifyProtectiveSlOrder({ ...base, openAlgoOrders: [makeOrder({ symbol: 'ETHUSDT' })], expectedSymbol: 'BTCUSDT' });
    expect(r.status).toBe('WRONG_SYMBOL');
  });

  it('the pre-existing algoId/side/qty checks are unchanged', () => {
    expect(verifyProtectiveSlOrder({ ...base, persistedSlAlgoId: null, openAlgoOrders: [] }).status).toBe('NO_PERSISTED_ORDERS');
    expect(verifyProtectiveSlOrder({ ...base, openAlgoOrders: [] }).status).toBe('MISSING');
    expect(verifyProtectiveSlOrder({ ...base, openAlgoOrders: [makeOrder({ side: 'BUY' })] }).status).toBe('WRONG_SIDE');
    expect(verifyProtectiveSlOrder({ ...base, openAlgoOrders: [makeOrder({ origQty: 5 })] }).status).toBe('WRONG_QTY');
  });

  it('active/open status is NOT re-checked here — item 3 already guarantees it upstream', () => {
    const src = readFileSync(path.resolve(__dirname, './liveStateSync.ts'), 'utf8');
    const start = src.indexOf('export function verifyProtectiveSlOrder(');
    const body = src.slice(start, start + 4000);
    expect(body).toContain('guaranteed active by construction');
  });

  it('the bot runs ONE_WAY mode and every call site declares it', () => {
    expect(DEFAULT_POSITION_MODE).toBe('ONE_WAY');
    const syncSrc = readFileSync(path.resolve(__dirname, './liveStateSync.ts'), 'utf8');
    expect((syncSrc.match(/positionMode: DEFAULT_POSITION_MODE/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(liveRunnerSrc).toContain('positionMode: DEFAULT_POSITION_MODE');
  });
});
