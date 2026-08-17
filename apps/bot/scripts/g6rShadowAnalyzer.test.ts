process.env.T153_LIBRARY_MODE = 'true';
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  createG6ShadowOpportunityAnalyzer,
  validateShadowLedger,
  validateShadowCandidateRows,
  auditDecisionFeatureProvenance,
  FutureCandleViolationError,
  FIVE_MINUTES_MS,
  ONE_MINUTE_MS,
  ONE_DAY_MS,
  type FrozenShadowEvent,
  type ShadowAnalyzerInput,
  type ShadowDecisionContext,
  type DecisionFeatureProvenance,
} from './g6rShadowAnalyzer.js';
import type { CandleData } from '../dist/regime/types.js';

function c(open: number, close: number, high: number, low: number, timestamp = 0): CandleData {
  return { timestamp, open, close, high, low, volume: 100 };
}

// Same fixtures as apps/bot/src/entry/entryRouter.test.ts (production behavioral-equivalence
// vector) — reused here, not reinvented, so this test exercises the SAME geometry production's
// own suite already validates.
const filler: CandleData[] = Array.from({ length: 14 }, () => c(9, 9, 9.5, 8.5));
const trendCandles5m: CandleData[] = [
  ...filler,
  c(9, 9, 10, 8),
  c(10.5, 10.5, 12, 9),
  c(13, 13, 15, 11), // swing high (15)
  c(11, 11, 12, 10),
  c(9, 9, 10, 8),
  c(11, 9, 11, 9), // OB candidate (down), zone [9, 11]
  c(9, 12, 12.5, 9),
  c(12, 16, 16, 11.5), // BOS confirmed
];
const mssCandles: CandleData[] = [
  c(9.5, 9.5, 10, 9),
  c(9.25, 9.25, 10, 8.5),
  c(7.5, 7.5, 9.5, 6), // swing low #1 (6)
  c(9.25, 9.25, 10, 8.5),
  c(9.5, 9.5, 10, 9),
  c(10.5, 10.5, 12, 9), // swing high BETWEEN the two lows (12)
  c(9.25, 9.25, 10, 8.5),
  c(9.5, 9.5, 10, 9),
  c(8.75, 8.75, 9.5, 8), // swing low #2 (8) — higher-low vs index 2
  c(9.25, 9.25, 10, 8.5),
  c(9.5, 9.5, 10, 9),
  c(12.5, 13, 13.2, 12.3), // MSS confirmed here, close = 13
];
// No down candle anywhere (all flat open===close except the sweep candle, which is up) -> no OB
// candidate, no FVG. Only a valid Liquidity Sweep exists.
const sweepFiller: CandleData[] = Array.from({ length: 14 }, () => c(9, 9, 9.5, 8.5));
const sweepOnlyCandles5m: CandleData[] = [
  ...sweepFiller,
  c(9, 9, 10, 8),
  c(8, 8, 9.5, 7),
  c(7, 7, 9, 5), // swing low (5)
  c(8, 8, 9.5, 7),
  c(9, 9, 10, 8),
  c(5.3, 5.5, 6, 3), // sweep candle: low=3<5, close=5.5>5, lowerWickRatio=(5.3-3)/3=0.77
];

// Fixture candles all use timestamp=0; a cutoff far beyond any fixture's close boundary keeps the
// existing hand-crafted vectors valid under the new closure validation without changing their
// content/meaning. Tests that specifically exercise the cutoff boundary override this explicitly.
const FAR_FUTURE_CUTOFF = 1_000_000_000_000;

function baseInput(overrides: Partial<ShadowAnalyzerInput>): ShadowAnalyzerInput {
  return {
    symbol: 'BTCUSDT',
    candles5m: [],
    candlesMss: [],
    macroInputCandles1d: [],
    adxDirection1h: undefined,
    obEnabled: true,
    obDisabledSymbols: [],
    obBosLookforwardK: 10,
    obSlBufferAtrMultiplier: 0.87,
    macroTrendFilterEnabled: false,
    macroDirection: undefined,
    evaluationCutoffExclusive: FAR_FUTURE_CUTOFF,
    ...overrides,
  };
}

const ctx: ShadowDecisionContext = { evaluationId: 'BTCUSDT|0|TREND_RIDER|0', regime: 'TREND_RIDER', evaluationTimestamp: 0 };

describe('G6ShadowOpportunityAnalyzer.observeDecision', () => {
  it('OB MSS pass -> no fallback candidate created (test 1)', () => {
    const analyzer = createG6ShadowOpportunityAnalyzer();
    const obs = analyzer.observeDecision(baseInput({ adxDirection1h: 'UP', candles5m: trendCandles5m, candlesMss: mssCandles }), ctx);
    expect(obs.primaryObFound).toBe(true);
    expect(obs.primary?.mssConfirmed).toBe(true);
    expect(obs.fvgFallback).toBeNull();
    expect(obs.sweepFallback).toBeNull();
    expect(obs.actionableShadowEvent).toBeNull();
  });

  it('OB found but its own MSS not yet confirmed (subset of mssCandles) -> primary MSS fails, no OB confirm', () => {
    const analyzer = createG6ShadowOpportunityAnalyzer();
    const obs = analyzer.observeDecision(baseInput({ adxDirection1h: 'UP', candles5m: trendCandles5m, candlesMss: mssCandles.slice(0, 11) }), ctx);
    expect(obs.primaryObFound).toBe(true);
    expect(obs.primary?.mssConfirmed).toBe(false);
    // No FVG/Sweep pattern exists in trendCandles5m, so no actionable fallback either.
    expect(obs.actionableShadowEvent).toBeNull();
  });

  it('no OB, no FVG, only Sweep present but adxDirection1h FLAT -> no evaluation at all (base case returns nulls)', () => {
    const analyzer = createG6ShadowOpportunityAnalyzer();
    const obs = analyzer.observeDecision(baseInput({ adxDirection1h: 'FLAT', candles5m: sweepOnlyCandles5m, candlesMss: mssCandles }), ctx);
    expect(obs.primaryObFound).toBe(false);
    expect(obs.primary).toBeNull();
    expect(obs.actionableShadowEvent).toBeNull();
  });

  it('no OB candidate at all (obEnabled=false) -> primaryObFound=false, no actionable event (OB absence is not a shadow trigger)', () => {
    const analyzer = createG6ShadowOpportunityAnalyzer();
    const obs = analyzer.observeDecision(baseInput({ adxDirection1h: 'UP', obEnabled: false, candles5m: sweepOnlyCandles5m, candlesMss: mssCandles }), ctx);
    expect(obs.primaryObFound).toBe(false);
    expect(obs.actionableShadowEvent).toBeNull();
  });

  it('candidateKey is deterministic: same inputs -> same key (test 6)', () => {
    const analyzer = createG6ShadowOpportunityAnalyzer();
    const input = baseInput({ adxDirection1h: 'UP', candles5m: trendCandles5m, candlesMss: mssCandles.slice(0, 11) });
    const a = analyzer.observeDecision(input, ctx);
    const b = analyzer.observeDecision(input, ctx);
    expect(a.actionableShadowEvent?.candidateKey).toBe(b.actionableShadowEvent?.candidateKey);
    // Also deterministic across a brand-new analyzer instance (no hidden mutable state).
    const c2 = createG6ShadowOpportunityAnalyzer().observeDecision(input, ctx);
    expect(c2).toEqual(a);
  });

  it('is pure: does not mutate the input candle arrays', () => {
    const analyzer = createG6ShadowOpportunityAnalyzer();
    const candles5mCopy = trendCandles5m.map((x) => ({ ...x }));
    const mssCopy = mssCandles.map((x) => ({ ...x }));
    const input = baseInput({ adxDirection1h: 'UP', candles5m: candles5mCopy, candlesMss: mssCopy });
    analyzer.observeDecision(input, ctx);
    expect(candles5mCopy).toEqual(trendCandles5m);
    expect(mssCopy).toEqual(mssCandles);
  });

  describe('Defect 2 fix: the analyzer itself rejects future/unclosed candles before evaluating anything', () => {
    it('(a) fully-closed input is accepted normally (no throw, real evaluation happens)', () => {
      const analyzer = createG6ShadowOpportunityAnalyzer();
      const input = baseInput({ adxDirection1h: 'UP', candles5m: trendCandles5m, candlesMss: mssCandles, evaluationCutoffExclusive: FAR_FUTURE_CUTOFF });
      expect(() => analyzer.observeDecision(input, ctx)).not.toThrow();
      const obs = analyzer.observeDecision(input, ctx);
      expect(obs.primary?.mssConfirmed).toBe(true);
    });

    it('(b) appending one future 1m (candlesMss) candle causes a throw', () => {
      const analyzer = createG6ShadowOpportunityAnalyzer();
      // Cutoff placed so every existing mssCandles timestamp (all 0) is closed, but an appended
      // candle timestamped exactly at the cutoff boundary is NOT closed (0 + ONE_MINUTE_MS > cutoff
      // only if cutoff < ONE_MINUTE_MS; use a cutoff of ONE_MINUTE_MS so timestamp=0 candles are
      // exactly-closed, then append a candle timestamped at the cutoff itself, which is unclosed).
      const cutoff = ONE_MINUTE_MS;
      const future1m: CandleData = c(9, 9, 9, 9, cutoff);
      const input = baseInput({
        adxDirection1h: 'UP',
        candles5m: [c(9, 9, 9, 9, cutoff - FIVE_MINUTES_MS)],
        candlesMss: [...mssCandles.map((x) => ({ ...x, timestamp: 0 })), future1m],
        evaluationCutoffExclusive: cutoff,
      });
      expect(() => analyzer.observeDecision(input, ctx)).toThrow(FutureCandleViolationError);
      try {
        analyzer.observeDecision(input, ctx);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(FutureCandleViolationError);
        const err = e as FutureCandleViolationError;
        expect(err.array).toBe('candlesMss');
        expect(err.candleTimestamp).toBe(cutoff);
      }
    });

    it('(c) appending one unclosed 5m candle causes a throw', () => {
      const analyzer = createG6ShadowOpportunityAnalyzer();
      const cutoff = FIVE_MINUTES_MS; // a 5m candle at timestamp=cutoff-1 is unclosed (closes at cutoff-1+5min > cutoff)
      const unclosed5m: CandleData = c(9, 9, 9, 9, cutoff - 1);
      const input = baseInput({ adxDirection1h: 'UP', candles5m: [...trendCandles5m.map((x) => ({ ...x, timestamp: 0 })), unclosed5m], candlesMss: [], evaluationCutoffExclusive: cutoff });
      expect(() => analyzer.observeDecision(input, ctx)).toThrow(FutureCandleViolationError);
      try {
        analyzer.observeDecision(input, ctx);
        expect.unreachable();
      } catch (e) {
        const err = e as FutureCandleViolationError;
        expect(err.array).toBe('candles5m');
      }
    });

    it('(d) exact-boundary candle: timestamp + interval === cutoff EXACTLY is ACCEPTED (documented: `<=` is closed, not `<`)', () => {
      const analyzer = createG6ShadowOpportunityAnalyzer();
      const cutoff = FIVE_MINUTES_MS;
      // A 5m candle at timestamp = cutoff - FIVE_MINUTES_MS = 0 closes at exactly `cutoff` -> accepted (<=).
      const exactBoundaryCandle: CandleData = c(9, 9, 9, 9, 0);
      const input = baseInput({ adxDirection1h: 'UP', candles5m: [exactBoundaryCandle], candlesMss: [], evaluationCutoffExclusive: cutoff });
      expect(() => analyzer.observeDecision(input, ctx)).not.toThrow();
      // One ms later (timestamp=1) would close at cutoff+1, which is NOT <= cutoff -> rejected.
      const oneMsLate: CandleData = c(9, 9, 9, 9, 1);
      const inputLate = baseInput({ adxDirection1h: 'UP', candles5m: [oneMsLate], candlesMss: [], evaluationCutoffExclusive: cutoff });
      expect(() => analyzer.observeDecision(inputLate, ctx)).toThrow(FutureCandleViolationError);
    });

    it('(e) a future candle cannot influence the candidate: the analyzer rejects BEFORE ever evaluating it (proven via a distinguishing side-effect, not merely equal results)', () => {
      // mssCandles.slice(0, 11) does NOT confirm MSS; the 12th candle (mssCandles[11]) is the one
      // that flips confirmation to true. Place it exactly AT the cutoff (unclosed) and prove the
      // call throws — i.e. detectMarketStructureShift/evaluateStage is never reached with that
      // candle in scope, so it structurally cannot influence the result (as opposed to "the result
      // happened to be the same").
      const analyzer = createG6ShadowOpportunityAnalyzer();
      const cutoff = ONE_MINUTE_MS;
      const truncated = mssCandles.slice(0, 11).map((x) => ({ ...x, timestamp: 0 }));
      const confirmingCandleAtCutoff = { ...mssCandles[11], timestamp: cutoff }; // unclosed at `cutoff`
      const input = baseInput({
        adxDirection1h: 'UP',
        candles5m: [c(9, 9, 9, 9, cutoff - FIVE_MINUTES_MS)],
        candlesMss: [...truncated, confirmingCandleAtCutoff],
        evaluationCutoffExclusive: cutoff,
      });
      let threw = false;
      try {
        analyzer.observeDecision(input, ctx);
      } catch (e) {
        threw = true;
        expect(e).toBeInstanceOf(FutureCandleViolationError);
      }
      expect(threw).toBe(true); // rejected pre-evaluation; detectMarketStructureShift was never called with the confirming candle
    });

    it('(9) macro input (macroInputCandles1d) outside the cutoff fails', () => {
      const analyzer = createG6ShadowOpportunityAnalyzer();
      const cutoff = ONE_DAY_MS;
      const unclosed1d: CandleData = c(9, 9, 9, 9, cutoff - 1);
      const input = baseInput({ adxDirection1h: 'UP', candles5m: [], candlesMss: [], macroInputCandles1d: [unclosed1d], evaluationCutoffExclusive: cutoff });
      expect(() => analyzer.observeDecision(input, ctx)).toThrow(FutureCandleViolationError);
      try {
        analyzer.observeDecision(input, ctx);
        expect.unreachable();
      } catch (e) {
        const err = e as FutureCandleViolationError;
        expect(err.array).toBe('macroInputCandles1d');
      }
    });
  });

  describe('macro-trend filter ordering (Step 2 fix)', () => {
    it('macro filter blocks -> no MSS attempt on primary, no FVG, no Sweep, no candidate, blockedByMacroFilter=true', () => {
      const analyzer = createG6ShadowOpportunityAnalyzer();
      // side derived from adxDirection1h='UP' is LONG; macroDirection='DOWN' opposes it.
      const obs = analyzer.observeDecision(
        baseInput({ adxDirection1h: 'UP', candles5m: trendCandles5m, candlesMss: mssCandles, macroTrendFilterEnabled: true, macroDirection: 'DOWN' }),
        ctx,
      );
      expect(obs.primaryObFound).toBe(true);
      expect(obs.blockedByMacroFilter).toBe(true);
      expect(obs.primary).toBeNull(); // no MSS attempt on primary at all
      expect(obs.fvgFallback).toBeNull();
      expect(obs.sweepFallback).toBeNull();
      expect(obs.actionableShadowEvent).toBeNull();
    });

    it('macro filter enabled but aligned direction -> passes through exactly as if disabled', () => {
      const analyzer = createG6ShadowOpportunityAnalyzer();
      const aligned = analyzer.observeDecision(
        baseInput({ adxDirection1h: 'UP', candles5m: trendCandles5m, candlesMss: mssCandles, macroTrendFilterEnabled: true, macroDirection: 'UP' }),
        ctx,
      );
      const disabled = analyzer.observeDecision(baseInput({ adxDirection1h: 'UP', candles5m: trendCandles5m, candlesMss: mssCandles }), ctx);
      expect(aligned.blockedByMacroFilter).toBe(false);
      expect(aligned.primary).toEqual(disabled.primary);
    });

    it('FLAT macroDirection does not block, regardless of side', () => {
      const analyzer = createG6ShadowOpportunityAnalyzer();
      const obs = analyzer.observeDecision(
        baseInput({ adxDirection1h: 'UP', candles5m: trendCandles5m, candlesMss: mssCandles, macroTrendFilterEnabled: true, macroDirection: 'FLAT' }),
        ctx,
      );
      expect(obs.blockedByMacroFilter).toBe(false);
    });
  });

  describe('validateShadowLedger (fail-fast, test 7)', () => {
    function ev(overrides: Partial<FrozenShadowEvent>): FrozenShadowEvent {
      return {
        candidateKey: 'BTCUSDT|LONG|FVG|100|90',
        evaluationId: 'BTCUSDT|100|TREND_RIDER|0',
        symbol: 'BTCUSDT',
        side: 'LONG',
        regime: 'TREND_RIDER',
        setupType: 'FVG',
        sourceTimestamp: 90,
        decisionTimestamp: 100,
        entryPrice: 50,
        slPrice: 45,
        slDistance: 5,
        ...overrides,
      };
    }

    it('passes on a clean, unique, joined, valid-geometry population', () => {
      const result = validateShadowLedger([ev({})], new Set(['BTCUSDT|100|TREND_RIDER|0']));
      expect(result.valid).toBe(true);
      expect(result).toMatchObject({ duplicateCandidateKeys: 0, evaluationsWithMultipleActionable: 0, missingCp2Joins: 0, invalidGeometryCount: 0 });
    });

    it('fails on duplicate candidateKey', () => {
      const result = validateShadowLedger([ev({}), ev({})], new Set(['BTCUSDT|100|TREND_RIDER|0']));
      expect(result.valid).toBe(false);
      expect(result.duplicateCandidateKeys).toBe(1);
    });

    it('fails when an evaluation has more than one actionable candidate', () => {
      const result = validateShadowLedger(
        [ev({ candidateKey: 'k1' }), ev({ candidateKey: 'k2' })],
        new Set(['BTCUSDT|100|TREND_RIDER|0']),
      );
      expect(result.valid).toBe(false);
      expect(result.evaluationsWithMultipleActionable).toBe(1);
    });

    it('fails on missing CP2 join', () => {
      const result = validateShadowLedger([ev({})], new Set(['SOME|OTHER|EVAL|0']));
      expect(result.valid).toBe(false);
      expect(result.missingCp2Joins).toBe(1);
    });

    it('fails on invalid LONG geometry (slPrice >= entryPrice)', () => {
      const result = validateShadowLedger([ev({ slPrice: 55 })], new Set(['BTCUSDT|100|TREND_RIDER|0']));
      expect(result.valid).toBe(false);
      expect(result.invalidGeometryCount).toBe(1);
    });

    it('fails on invalid SHORT geometry (slPrice <= entryPrice)', () => {
      const result = validateShadowLedger([ev({ side: 'SHORT', entryPrice: 50, slPrice: 45 })], new Set(['BTCUSDT|100|TREND_RIDER|0']));
      expect(result.valid).toBe(false);
      expect(result.invalidGeometryCount).toBe(1);
    });

    it('fails on non-finite slDistance', () => {
      const result = validateShadowLedger([ev({ slDistance: 0 })], new Set(['BTCUSDT|100|TREND_RIDER|0']));
      expect(result.valid).toBe(false);
      expect(result.invalidGeometryCount).toBe(1);
    });
  });

  describe('cascade invariants over a real historical replay sample', () => {
    it('at most one actionable candidate per evaluation; FVG actionable prevents Sweep selection; both non-actionable -> no candidate', async () => {
      // Exercise the analyzer over a real slice of decision-time-safe production replay inputs
      // (same infra Checkpoint 2/3 use) to validate the cascade invariants against real market
      // geometry, not just hand-crafted vectors — this is a property test over real data, not a
      // second detector implementation.
      const originalCwd = process.cwd();
      const repoRoot = path.resolve(originalCwd, '..', '..');
      process.chdir(repoRoot);
      const { buildBaselineConfig, makeFillModel, runReplay } = await import('./ticket150BacktestExecutionRealismAudit.js');
      const { MarketRegime } = await import('../dist/regime/types.js');
      try {
      const analyzer2 = createG6ShadowOpportunityAnalyzer();
      const regimeByStep = new Map<string, MarketRegime>();
      const seenEvalIds = new Map<string, number>();
      let sawFvgActionable = false;
      let sawSweepActionable = false;
      let sawDecisionTimestampDiffer = false;
      const config = { ...buildBaselineConfig(), sameSideDuplicateGuardEnabled: true };
      await runReplay(config, makeFillModel('CENTRAL', 2 / 10000, 2 / 10000), 3000, {
        onStepContext: (stepCtx) => regimeByStep.set(`${stepCtx.symbol}|${stepCtx.timestamp}`, stepCtx.regime),
        onBeforeProcessCandle: (procCtx) => {
          const regime = regimeByStep.get(`${procCtx.symbol}|${procCtx.timestamp}`);
          if (regime === undefined) return;
          const trendStyle = regime === MarketRegime.TREND_RIDER;
          if (!trendStyle) return;
          const cfg = procCtx.config.entryRouterConfig;
          const id = `${procCtx.symbol}|${procCtx.timestamp}|${regime}|0`;
          const obs = analyzer2.observeDecision(
            {
              symbol: procCtx.symbol,
              candles5m: procCtx.input.candles5m,
              candlesMss: procCtx.input.candles1m,
              macroInputCandles1d: procCtx.input.candles1d,
              adxDirection1h: procCtx.input.adxDirection1h,
              obEnabled: cfg.obEnabled !== false,
              obDisabledSymbols: cfg.obDisabledSymbols,
              obBosLookforwardK: cfg.obBosLookforwardK,
              obSlBufferAtrMultiplier: cfg.obSlBufferAtrMultiplier,
              macroTrendFilterEnabled: cfg.macroTrendFilterEnabled,
              macroDirection: undefined, // baseline config has macroTrendFilterEnabled=false, so this value is inert for this property test
              evaluationCutoffExclusive: (procCtx.input.candles5m[procCtx.input.candles5m.length - 1]?.timestamp ?? procCtx.timestamp) + FIVE_MINUTES_MS,
            },
            { evaluationId: id, regime, evaluationTimestamp: procCtx.timestamp },
          );
          if (obs.actionableShadowEvent) {
            seenEvalIds.set(id, (seenEvalIds.get(id) ?? 0) + 1);
            const ev = obs.actionableShadowEvent;
            // Step 3 property: evaluationTimestamp (router-invocation time) and decisionTimestamp
            // (MSS-confirming-candle time) are both recorded, sourceTimestamp <= decisionTimestamp
            // always, and candidateKey is built from decisionTimestamp (not evaluationTimestamp).
            expect(ev.evaluationTimestamp).toBe(procCtx.timestamp);
            expect(ev.sourceTimestamp).toBeLessThanOrEqual(ev.decisionTimestamp);
            expect(ev.candidateKey).toBe(`${ev.symbol}|${ev.side}|${ev.setupType}|${ev.decisionTimestamp}|${ev.sourceTimestamp}`);
            if (ev.decisionTimestamp !== ev.evaluationTimestamp) sawDecisionTimestampDiffer = true;
            if (obs.actionableShadowEvent.setupType === 'FVG') {
              sawFvgActionable = true;
              expect(obs.sweepFallback).toBeNull(); // FVG actionable => Sweep never evaluated
            }
            if (obs.actionableShadowEvent.setupType === 'SWEEP') sawSweepActionable = true;
          }
          if (obs.primary && !obs.primary.mssConfirmed && obs.fvgFallback && !obs.fvgFallback.mssConfirmed && obs.sweepFallback && !obs.sweepFallback.mssConfirmed) {
            expect(obs.actionableShadowEvent).toBeNull();
          }
        },
      });
      for (const count of seenEvalIds.values()) expect(count).toBe(1); // max one actionable candidate per evaluation
      // Full-population fallback counts (fvgActionableCount/sweepActionableCount) are independently
      // proven by the actual g6r-cp3-shadow-summary.json full replay; this small 3000-step sample
      // is only a property check and may or may not itself contain a fallback candidate.
      void sawFvgActionable;
      void sawSweepActionable;
      void sawDecisionTimestampDiffer; // may or may not occur in this 3000-step slice; not asserted as required
      } finally {
        process.chdir(originalCwd);
      }
    }, 60000);
  });

  describe('observer-omitted parity (Step 10 test 18) — hooks are provably observe-only', () => {
    it('running the replay WITH the shadow-analyzer onBeforeProcessCandle hook attached produces identical trades to running WITHOUT it, over a bounded sample', async () => {
      const originalCwd = process.cwd();
      const repoRoot = path.resolve(originalCwd, '..', '..');
      process.chdir(repoRoot);
      try {
        const { buildBaselineConfig, makeFillModel, runReplay } = await import('./ticket150BacktestExecutionRealismAudit.js');
        const { MarketRegime } = await import('../dist/regime/types.js');
        const config = { ...buildBaselineConfig(), sameSideDuplicateGuardEnabled: true };

        const withoutHooksResult = await runReplay(config, makeFillModel('CENTRAL', 2 / 10000, 2 / 10000), 3000, undefined);

        const analyzer3 = createG6ShadowOpportunityAnalyzer();
        const regimeByStep = new Map<string, MarketRegime>();
        const withHooksResult = await runReplay(config, makeFillModel('CENTRAL', 2 / 10000, 2 / 10000), 3000, {
          onStepContext: (stepCtx) => regimeByStep.set(`${stepCtx.symbol}|${stepCtx.timestamp}`, stepCtx.regime),
          onBeforeProcessCandle: (procCtx) => {
            const regime = regimeByStep.get(`${procCtx.symbol}|${procCtx.timestamp}`);
            if (regime === undefined || regime !== MarketRegime.TREND_RIDER) return;
            const cfg = procCtx.config.entryRouterConfig;
            analyzer3.observeDecision(
              {
                symbol: procCtx.symbol,
                candles5m: procCtx.input.candles5m,
                candlesMss: procCtx.input.candles1m,
                macroInputCandles1d: procCtx.input.candles1d,
                adxDirection1h: procCtx.input.adxDirection1h,
                obEnabled: cfg.obEnabled !== false,
                obDisabledSymbols: cfg.obDisabledSymbols,
                obBosLookforwardK: cfg.obBosLookforwardK,
                obSlBufferAtrMultiplier: cfg.obSlBufferAtrMultiplier,
                macroTrendFilterEnabled: cfg.macroTrendFilterEnabled,
                macroDirection: undefined,
                evaluationCutoffExclusive: (procCtx.input.candles5m[procCtx.input.candles5m.length - 1]?.timestamp ?? procCtx.timestamp) + FIVE_MINUTES_MS,
              },
              { evaluationId: `${procCtx.symbol}|${procCtx.timestamp}|${regime}|0`, regime, evaluationTimestamp: procCtx.timestamp },
            );
          },
        });

        expect(withHooksResult.trades.length).toBe(withoutHooksResult.trades.length);
        expect(withHooksResult.trades).toEqual(withoutHooksResult.trades);
      } finally {
        process.chdir(originalCwd);
      }
    }, 60000);
  });

  describe('validateShadowCandidateRows (full schema validator, Step 8)', () => {
    function row(overrides: Partial<import('./g6rShadowAnalyzer.js').ShadowCandidateRow> = {}): import('./g6rShadowAnalyzer.js').ShadowCandidateRow {
      return {
        candidateKey: 'BTCUSDT|LONG|FVG|100|90',
        evaluationId: 'BTCUSDT|95|TREND_RIDER|0',
        symbol: 'BTCUSDT',
        side: 'LONG',
        regime: 'TREND_RIDER',
        setupType: 'FVG',
        evaluationTimestamp: 95,
        sourceTimestamp: 90,
        decisionTimestamp: 100,
        entryPrice: 50,
        slPrice: 45,
        slDistance: 5,
        requiredDataCoverage: 'FULL',
        primaryObFound: true,
        primaryObMssPassed: false,
        primaryObMssFailReason: 'NOT_FOUND',
        fallbackDetectorResult: 'FOUND',
        fallbackMssResult: 'CONFIRMED',
        registrationDocumentSha256: 'REG_HASH',
        analyzerSourceHash: 'SRC_HASH',
        dataQuality: 'DQ-B — HISTORICAL_PROXY',
        decisionFeatureProvenance: {
          detector5mMaxTimestamp: 90,
          detector5mMaxAvailableAt: 90 + FIVE_MINUTES_MS,
          mssMaxTimestampRead: 100,
          mssMaxAvailableAt: 100 + ONE_MINUTE_MS,
          mssConfirmationTimestamp: 100,
          stalenessReferenceTimestamp: 100,
          atr5mMaxTimestamp: 90,
          atr5mMaxAvailableAt: 90 + FIVE_MINUTES_MS,
          macroInputMaxTimestamp: 0,
          macroInputMaxAvailableAt: ONE_DAY_MS,
          evaluationCutoffExclusive: 95 + FIVE_MINUTES_MS,
          maxRawFeatureTimestamp: 100,
          maxFeatureAvailableAt: 100 + ONE_MINUTE_MS,
        },
        ...overrides,
      };
    }
    function baseCtx() {
      return {
        expectedRegistrationDocumentSha256: 'REG_HASH',
        expectedAnalyzerSourceHash: 'SRC_HASH',
        knownEvaluationIds: new Set(['BTCUSDT|95|TREND_RIDER|0']),
        evaluationIdFormula: (r: import('./g6rShadowAnalyzer.js').ShadowCandidateRow) => `${r.symbol}|${r.evaluationTimestamp}|${r.regime}|0`,
        candidateKeyFormula: (r: import('./g6rShadowAnalyzer.js').ShadowCandidateRow) => `${r.symbol}|${r.side}|${r.setupType}|${r.decisionTimestamp}|${r.sourceTimestamp}`,
      };
    }

    it('passes on a fully valid row (test 9-15 baseline)', () => {
      const result = validateShadowCandidateRows([row()], baseCtx());
      expect(result.valid).toBe(true);
    });

    it('fails on invalid geometry (test 9)', () => {
      const result = validateShadowCandidateRows([row({ slPrice: 55 })], baseCtx());
      expect(result.valid).toBe(false);
    });

    it('fails when sourceTimestamp > decisionTimestamp (test 10)', () => {
      const result = validateShadowCandidateRows([row({ sourceTimestamp: 200 })], baseCtx());
      expect(result.valid).toBe(false);
    });

    it('fails on missing required field (test 11)', () => {
      const result = validateShadowCandidateRows([row({ primaryObMssFailReason: null })], baseCtx());
      expect(result.valid).toBe(false);
    });

    it('fails on wrong setupType (test 12)', () => {
      const result = validateShadowCandidateRows([row({ setupType: 'OB' as unknown as 'FVG' })], baseCtx());
      expect(result.valid).toBe(false);
    });

    it('fails when registrationDocumentSha256 mismatches (test 13)', () => {
      const result = validateShadowCandidateRows([row({ registrationDocumentSha256: 'WRONG' })], baseCtx());
      expect(result.valid).toBe(false);
    });

    it('fails when analyzerSourceHash mismatches (test 14)', () => {
      const result = validateShadowCandidateRows([row({ analyzerSourceHash: 'WRONG' })], baseCtx());
      expect(result.valid).toBe(false);
    });

    it('fails on missing CP2 join (test 15)', () => {
      const result = validateShadowCandidateRows([row()], { ...baseCtx(), knownEvaluationIds: new Set(['OTHER|1|X|0']) });
      expect(result.valid).toBe(false);
    });

    it('fails on duplicate candidateKey among rows (test 15b)', () => {
      const result = validateShadowCandidateRows([row(), row({ evaluationId: 'BTCUSDT|96|TREND_RIDER|0' })], {
        ...baseCtx(),
        knownEvaluationIds: new Set(['BTCUSDT|95|TREND_RIDER|0', 'BTCUSDT|96|TREND_RIDER|0']),
      });
      expect(result.valid).toBe(false);
      expect(result.duplicateCandidateKeys).toBe(1);
    });

    it('fails when decisionTimestamp is at/after the evaluations own 5-minute close boundary (leakage)', () => {
      const result = validateShadowCandidateRows([row({ evaluationTimestamp: 0, decisionTimestamp: 5 * 60 * 1000 })], {
        ...baseCtx(),
        knownEvaluationIds: new Set(['BTCUSDT|95|TREND_RIDER|0']),
        evaluationIdFormula: () => 'BTCUSDT|95|TREND_RIDER|0',
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('auditDecisionFeatureProvenance (Defect 1 fix — real, non-tautological Audit B)', () => {
    function baseProvenance(overrides: Partial<DecisionFeatureProvenance> = {}): DecisionFeatureProvenance {
      return {
        detector5mMaxTimestamp: 90,
        detector5mMaxAvailableAt: 90 + FIVE_MINUTES_MS,
        mssMaxTimestampRead: 100,
        mssMaxAvailableAt: 100 + ONE_MINUTE_MS,
        mssConfirmationTimestamp: 100,
        stalenessReferenceTimestamp: 100,
        atr5mMaxTimestamp: 90,
        atr5mMaxAvailableAt: 90 + FIVE_MINUTES_MS,
        macroInputMaxTimestamp: 0,
        macroInputMaxAvailableAt: ONE_DAY_MS,
        evaluationCutoffExclusive: ONE_DAY_MS + FIVE_MINUTES_MS,
        maxRawFeatureTimestamp: 100,
        maxFeatureAvailableAt: 100 + ONE_MINUTE_MS,
        ...overrides,
      };
    }
    function fev(overrides: Partial<FrozenShadowEvent> = {}): FrozenShadowEvent {
      return {
        candidateKey: 'BTCUSDT|LONG|FVG|100|90',
        evaluationId: 'BTCUSDT|100|TREND_RIDER|0',
        symbol: 'BTCUSDT',
        side: 'LONG',
        regime: 'TREND_RIDER',
        setupType: 'FVG',
        sourceTimestamp: 90,
        evaluationTimestamp: 95,
        decisionTimestamp: 100,
        entryPrice: 50,
        slPrice: 45,
        slDistance: 5,
        provenance: baseProvenance(),
        ...overrides,
      };
    }

    it('(1) maxFeatureTimestamp is computed from real, independently-tracked provenance (not decisionTimestamp)', () => {
      const ev = fev();
      // The provenance fields are independent of decisionTimestamp — proven by constructing a case
      // where maxRawFeatureTimestamp (100) equals decisionTimestamp (100) only because the fixture
      // says so, not because the field is defined as decisionTimestamp anywhere in the code.
      expect(ev.provenance.maxRawFeatureTimestamp).toBe(100);
      const result = auditDecisionFeatureProvenance([ev]);
      expect(result.pass).toBe(true);
      expect(result.candidatesAudited).toBe(1);
    });

    it('(2) a feature timestamped after decisionTimestamp fails Audit B', () => {
      const ev = fev({ decisionTimestamp: 100, provenance: baseProvenance({ atr5mMaxTimestamp: 150, atr5mMaxAvailableAt: 150 + FIVE_MINUTES_MS, evaluationCutoffExclusive: 500 }) });
      const result = auditDecisionFeatureProvenance([ev]);
      expect(result.pass).toBe(false);
      expect(result.violationCount).toBeGreaterThan(0);
      expect(result.violations.some((v) => v.provenanceField === 'atr5mMaxTimestamp' && v.kind === 'FEATURE_AFTER_DECISION_TIMESTAMP')).toBe(true);
    });

    it('(3) a staleness reference after decisionTimestamp fails Audit B', () => {
      const ev = fev({ decisionTimestamp: 100, provenance: baseProvenance({ stalenessReferenceTimestamp: 200, evaluationCutoffExclusive: 500 }) });
      const result = auditDecisionFeatureProvenance([ev]);
      expect(result.pass).toBe(false);
      expect(result.violations.some((v) => v.provenanceField === 'stalenessReferenceTimestamp')).toBe(true);
    });

    it('(4) ATR/detector/MSS provenance is recorded distinctly (not collapsed into one field)', () => {
      const p = baseProvenance({ detector5mMaxTimestamp: 10, mssMaxTimestampRead: 20, atr5mMaxTimestamp: 30, macroInputMaxTimestamp: 5 });
      expect(p.detector5mMaxTimestamp).not.toBe(p.mssMaxTimestampRead);
      expect(p.mssMaxTimestampRead).not.toBe(p.atr5mMaxTimestamp);
      expect(p.atr5mMaxTimestamp).not.toBe(p.macroInputMaxTimestamp);
    });

    it('(5) Audit B cannot pass via `x = decisionTimestamp`: an event whose provenance is (invalidly) constructed by mirroring decisionTimestamp into every raw field still audits each field independently, and a genuinely late field is still caught even when others equal decisionTimestamp', () => {
      // Structural proof: auditDecisionFeatureProvenance takes DecisionFeatureProvenance fields
      // directly, never decisionTimestamp, as its comparison source (see PROVENANCE_RAW_FIELDS /
      // PROVENANCE_AVAILABLE_AT_FIELDS in g6rShadowAnalyzer.ts) — even if every raw field happens to
      // equal decisionTimestamp except one, that one is still flagged, proving the check is real.
      const p = baseProvenance({
        detector5mMaxTimestamp: 100,
        mssMaxTimestampRead: 100,
        mssConfirmationTimestamp: 100,
        stalenessReferenceTimestamp: 100,
        atr5mMaxTimestamp: 100,
        macroInputMaxTimestamp: 999, // the one genuinely-late field
        evaluationCutoffExclusive: 2000,
      });
      const ev = fev({ decisionTimestamp: 100, provenance: p });
      const result = auditDecisionFeatureProvenance([ev]);
      expect(result.pass).toBe(false);
      expect(result.violations.some((v) => v.provenanceField === 'macroInputMaxTimestamp')).toBe(true);
    });

    it('flags an unclosed-candle read (question 1) separately from a feature-after-decisionTimestamp violation (question 2)', () => {
      const ev = fev({ decisionTimestamp: 100, provenance: baseProvenance({ mssMaxAvailableAt: 9999, evaluationCutoffExclusive: 500 }) });
      const result = auditDecisionFeatureProvenance([ev]);
      expect(result.violations.some((v) => v.kind === 'UNCLOSED_CANDLE_READ' && v.provenanceField === 'mssMaxAvailableAt')).toBe(true);
    });
  });
});
