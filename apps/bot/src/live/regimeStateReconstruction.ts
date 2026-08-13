/**
 * TICKET-G3R — Cold-start regime-state reconstruction.
 *
 * Defect this closes (found by G3, `data/g3-live-trade-replay.md` §3): a cold-started/restarted
 * liveRunner begins with `INITIAL_SYMBOL_STATE.regimeState` = `{previousRegime:null,
 * previousCandidateRegime:null, streakCount:0, previousDangerZoneTimestamp:null}`
 * (`orchestrator/types.ts:169`), and nothing ever replays the already-backfilled candle history
 * through `detectRegime()`. `detectRegime()` reads `previousDangerZoneTimestamp` to apply the
 * `POST_DANGER_COOLDOWN_HOURS = 72` suppression (`regimeDetector.ts:322-325`), so a null anchor means
 * the entire 72h post-DANGER protection is silently lost after any restart.
 *
 * This module rebuilds that state by replaying the SAME `detectRegime()` (imported, never a
 * reimplementation or a shortcut "scan for DANGER labels" heuristic) candle-by-candle over closed
 * candles, exactly the way backtest.ts advances its own chain. Everything here is PURE — candles in,
 * state out, no network, no filesystem, no clock beyond the caller-supplied `nowMs` — so it is unit
 * testable with fixture OHLCV and a mocked persisted-state reader (see regimeStateReconstruction.test.ts).
 *
 * It lives beside liveStateSync.ts (same directory, same pure-decision-function + explicitly-injected-
 * input convention as the G1R chain) rather than inside it: liveStateSync.ts is already 1600 lines of
 * exchange-state reconciliation, and this concern touches no exchange API at all.
 *
 * Scope: regime state ONLY. No regime threshold, no cooldown value, no entry/exit/risk logic is
 * touched by this file.
 */
import { detectRegime } from '../regime/regimeDetector.js';
import { computeCorrelatedRiskRatio } from '../regime/correlatedRisk.js';
import { RegimeConfig } from '../regime/config.js';
import type { CandleData } from '../regime/types.js';
import type { RegimeHysteresisState } from '../orchestrator/types.js';

// ---- window/warm-up sizing ---------------------------------------------------------------------
//
// These MUST stay identical to the decision-time windows liveRunner.ts/backtest.ts already use, or
// the replayed chain would not be the same chain the live tick loop continues.

/** Mirrors liveRunner.ts WINDOW_5M / backtest.ts WINDOW_5M. */
export const RECON_WINDOW_5M = 320;
/** Mirrors liveRunner.ts WINDOW_15M / backtest.ts WINDOW_15M. */
export const RECON_WINDOW_15M = 325;
/** Mirrors liveRunner.ts WINDOW_1H / backtest.ts WINDOW_1H (also >= CORRELATED_RISK_WINDOW_CANDLES+1). */
export const RECON_WINDOW_1H = 40;
/** Mirrors backtest.ts WINDOW_5M_SESSION_VOLUME / liveCandleFeed.ts SESSION_VOLUME_WINDOW_5M. */
export const RECON_WINDOW_5M_SESSION_VOLUME = RegimeConfig.LOW_LIQUIDITY_SESSION_LOOKBACK_DAYS * 288 + 1;

export const MS_5M = 5 * 60_000;
export const MS_15M = 15 * 60_000;
export const MS_1H = 60 * 60_000;

/** 72h of 5m candles — the cooldown window itself must be fully inside the replay span. */
export const RECON_COOLDOWN_STEPS_5M = RegimeConfig.POST_DANGER_COOLDOWN_HOURS * 12;
/**
 * Extra replayed steps BEFORE the cooldown window starts. Two days. Two jobs: (1) a DANGER that is
 * about to age out is still observed, so `previousDangerZoneTimestamp` matches a continuously-running
 * chain rather than only its cooldown effect; (2) the hysteresis automaton is self-synchronising —
 * any run of N_CANDLE_CONFIRM(3) identical candidates erases all prior (regime, candidate, streak)
 * memory — so 576 steps is far more than enough for the replayed chain's hysteresis to converge onto
 * the continuous one.
 *
 * BOUNDED-SPAN PROPERTY (measured, see data/g3r-continuous-restart-parity.csv): a DANGER_ZONE older
 * than the replay span is not observed, so `previousDangerZoneTimestamp` can come back null where a
 * process running since forever would still hold that stale value. This can never change a decision:
 * `detectRegime()` only reads the anchor through `currentTimestamp - anchor < 72h`, and any anchor
 * older than the span is already older than 72h, so both forms suppress nothing, now and forever. An
 * anchor that is still LIVE is always inside the span by construction (span > 72h).
 */
export const RECON_MARGIN_STEPS_5M = 576;
/** Total 5m steps replayed through detectRegime(). */
export const RECON_REPLAY_STEPS_5M = RECON_COOLDOWN_STEPS_5M + RECON_MARGIN_STEPS_5M;

/**
 * Closed-candle counts the reconstruction needs PER SYMBOL. Every one of these is
 * `<warm-up for the FIRST replayed step> + <candles consumed by advancing the replay>` — the ticket's
 * explicit "you may not replay 72h of 5m while holding only a short 15m/1h history" rule, computed
 * rather than guessed. The 5m figure is driven by the 14-day session-volume window (4033), not by
 * WINDOW_5M(320), because that is the deepest 5m input detectRegime() takes.
 */
export const RECON_REQUIRED_5M = RECON_WINDOW_5M_SESSION_VOLUME - 1 + RECON_REPLAY_STEPS_5M;
export const RECON_REQUIRED_15M = RECON_WINDOW_15M + Math.ceil(RECON_REPLAY_STEPS_5M / 3);
export const RECON_REQUIRED_1H = RECON_WINDOW_1H + Math.ceil(RECON_REPLAY_STEPS_5M / 12);

// ---- results -----------------------------------------------------------------------------------

export type RegimeStateProvenance = 'PERSISTED' | 'RECONSTRUCTED' | 'UNAVAILABLE';

export type ReconstructionFailureReason =
  | 'INSUFFICIENT_5M_HISTORY'
  | 'INSUFFICIENT_15M_WARMUP'
  | 'INSUFFICIENT_1H_WARMUP'
  | 'GAP_IN_5M_WINDOW'
  | 'GAP_IN_15M_WINDOW'
  | 'GAP_IN_1H_WINDOW'
  | 'RECONSTRUCTION_EXCEPTION'
  /** The symbols' 5m tails do not line up on the same timestamps, so a lockstep replay would pair each symbol's candle with another symbol's correlatedRiskRatio. */
  | 'SYMBOL_TIMESTAMP_MISALIGNED'
  /** Another symbol failed integrity, so the cross-symbol correlatedRiskRatio input is untrustworthy for THIS symbol too. */
  | 'CROSS_SYMBOL_INPUT_INVALID';

export type InputQuality = 'COMPLETE' | ReconstructionFailureReason;

/** Everything the ticket's §5 startup telemetry line needs, per symbol. Never carries secrets or account payloads — candles and regime labels only. */
export interface RegimeReconstructionTelemetry {
  symbol: string;
  replayStart: number | null;
  replayEnd: number | null;
  replayedCandles: number;
  previousRegime: string | null;
  candidateRegime: string | null;
  streakCount: number;
  lastDangerZoneTimestamp: number | null;
  cooldownRemainingMinutes: number;
  inputQuality: InputQuality;
  /** Closed-candle counts actually available vs required — the input-integrity evidence row. */
  available5m: number;
  available15m: number;
  available1h: number;
  detail: string;
}

export type SymbolReconstructionResult =
  | { status: 'OK'; symbol: string; regimeState: RegimeHysteresisState; telemetry: RegimeReconstructionTelemetry }
  | { status: 'INVALID'; symbol: string; reason: ReconstructionFailureReason; telemetry: RegimeReconstructionTelemetry };

// ---- input integrity ---------------------------------------------------------------------------

export interface SymbolCandleHistory {
  candles5m: CandleData[];
  candles15m: CandleData[];
  candles1h: CandleData[];
}

/** True when the last `count` entries are strictly contiguous at `intervalMs` (no missing candle inside the window actually used). */
export function isTailContiguous(candles: CandleData[], count: number, intervalMs: number): boolean {
  const start = candles.length - count;
  if (start < 0) return false;
  for (let i = start + 1; i < candles.length; i++) {
    if (candles[i].timestamp - candles[i - 1].timestamp !== intervalMs) return false;
  }
  return true;
}

export function checkReconstructionInputIntegrity(history: SymbolCandleHistory): ReconstructionFailureReason | null {
  if (history.candles5m.length < RECON_REQUIRED_5M) return 'INSUFFICIENT_5M_HISTORY';
  if (history.candles15m.length < RECON_REQUIRED_15M) return 'INSUFFICIENT_15M_WARMUP';
  if (history.candles1h.length < RECON_REQUIRED_1H) return 'INSUFFICIENT_1H_WARMUP';
  if (!isTailContiguous(history.candles5m, RECON_REQUIRED_5M, MS_5M)) return 'GAP_IN_5M_WINDOW';
  if (!isTailContiguous(history.candles15m, RECON_REQUIRED_15M, MS_15M)) return 'GAP_IN_15M_WINDOW';
  if (!isTailContiguous(history.candles1h, RECON_REQUIRED_1H, MS_1H)) return 'GAP_IN_1H_WINDOW';
  return null;
}

// ---- the replay --------------------------------------------------------------------------------

/** Last `size` entries of `candles` that had already CLOSED at `decisionTimeMs` (candle close = timestamp + intervalMs). Same closed-only rule the live feed and backtest both apply. */
function closedWindowAt(candles: CandleData[], intervalMs: number, decisionTimeMs: number, size: number): CandleData[] {
  let end = candles.length; // exclusive
  while (end > 0 && candles[end - 1].timestamp + intervalMs > decisionTimeMs) end--;
  return candles.slice(Math.max(0, end - size), end);
}

function cooldownRemainingMinutes(lastDangerZoneTimestamp: number | null, currentTimestamp: number): number {
  if (lastDangerZoneTimestamp === null) return 0;
  const elapsedMs = currentTimestamp - lastDangerZoneTimestamp;
  const windowMs = RegimeConfig.POST_DANGER_COOLDOWN_HOURS * 60 * 60 * 1000;
  if (elapsedMs >= windowMs) return 0;
  return Math.round((windowMs - elapsedMs) / 60_000);
}

function emptyTelemetry(symbol: string, history: SymbolCandleHistory, inputQuality: InputQuality, detail: string): RegimeReconstructionTelemetry {
  return {
    symbol,
    replayStart: null,
    replayEnd: null,
    replayedCandles: 0,
    previousRegime: null,
    candidateRegime: null,
    streakCount: 0,
    lastDangerZoneTimestamp: null,
    cooldownRemainingMinutes: 0,
    inputQuality,
    available5m: history.candles5m.length,
    available15m: history.candles15m.length,
    available1h: history.candles1h.length,
    detail,
  };
}

export interface ReconstructAcrossSymbolsParams {
  symbols: string[];
  /** CLOSED candles only, ascending by timestamp. The caller (liveRunner) supplies feed.getClosedCandles() output — a still-forming candle must never reach this function. */
  historyBySymbol: Record<string, SymbolCandleHistory>;
  /** Anchor symbol for computeCorrelatedRiskRatio — must match liveRunner.ts/backtest.ts ('BTCUSDT'). */
  correlatedRiskAnchorSymbol?: string;
  /** Override for tests; defaults to RECON_REPLAY_STEPS_5M. */
  replaySteps?: number;
  /**
   * Diagnostic-only observer, fired after every replayed step for every symbol. Never read here and
   * never affects any decision — same convention as processCandle()'s onRegimeMetrics. Used by the
   * G3R parity harness to record a continuously-running reference chain through the exact same code
   * path the cold-start reconstruction uses.
   */
  onStep?: (symbol: string, candleTimestamp: number, state: RegimeHysteresisState) => void;
}

/**
 * Replays every symbol FORWARD IN LOCKSTEP, because `correlatedRiskRatio` is a cross-symbol input
 * computed once per time-step across all 4 coins (exactly as liveRunner.ts's tick() and backtest.ts's
 * step loop both do) — a per-symbol-at-a-time replay could not reproduce it.
 *
 * Fail-closed and all-or-nothing on integrity: if ANY symbol fails its own integrity check, every
 * symbol is returned INVALID, because the correlatedRiskRatio fed to the healthy symbols would have
 * been derived from an incomplete cross-symbol set and would therefore not match a continuously
 * running chain. Never falls back to a default state.
 */
export function reconstructRegimeStatesAcrossSymbols(params: ReconstructAcrossSymbolsParams): Record<string, SymbolReconstructionResult> {
  const anchor = params.correlatedRiskAnchorSymbol ?? 'BTCUSDT';
  const replaySteps = params.replaySteps ?? RECON_REPLAY_STEPS_5M;
  const results: Record<string, SymbolReconstructionResult> = {};

  const integrity: Record<string, ReconstructionFailureReason | null> = {};
  let anyInvalid = false;
  for (const symbol of params.symbols) {
    const history = params.historyBySymbol[symbol];
    const reason = history === undefined ? 'INSUFFICIENT_5M_HISTORY' : checkReconstructionInputIntegrity(history);
    integrity[symbol] = reason;
    if (reason !== null) anyInvalid = true;
  }

  // The lockstep loop below pairs symbols by position from the END of each 5m array (which is what
  // makes one shared correlatedRiskRatio per step correct). That is only sound if every symbol's tail
  // carries the SAME timestamps — verified here rather than assumed, because a symbol whose feed is
  // one candle behind would otherwise be silently replayed against another symbol's time step.
  if (!anyInvalid && params.symbols.length > 1) {
    const reference = params.historyBySymbol[params.symbols[0]].candles5m;
    for (const symbol of params.symbols.slice(1)) {
      const other = params.historyBySymbol[symbol].candles5m;
      for (let step = 0; step < replaySteps; step++) {
        if (reference[reference.length - 1 - step].timestamp !== other[other.length - 1 - step].timestamp) {
          integrity[symbol] = 'SYMBOL_TIMESTAMP_MISALIGNED';
          anyInvalid = true;
          break;
        }
      }
    }
  }

  if (anyInvalid) {
    for (const symbol of params.symbols) {
      const history = params.historyBySymbol[symbol] ?? { candles5m: [], candles15m: [], candles1h: [] };
      const own = integrity[symbol];
      const reason: ReconstructionFailureReason = own ?? 'CROSS_SYMBOL_INPUT_INVALID';
      results[symbol] = {
        status: 'INVALID',
        symbol,
        reason,
        telemetry: emptyTelemetry(
          symbol,
          history,
          reason,
          own !== null
            ? `dữ liệu nến không đủ/không liền mạch để dựng lại regime state (cần 5m>=${RECON_REQUIRED_5M}, 15m>=${RECON_REQUIRED_15M}, 1h>=${RECON_REQUIRED_1H}, liền mạch)`
            : 'symbol khác thiếu dữ liệu nên correlatedRiskRatio (đầu vào liên coin) không đáng tin cho symbol này',
        ),
      };
    }
    return results;
  }

  // All symbols are replayed over the SAME 5m timeline. Using each symbol's own tail index keeps the
  // per-symbol slicing identical to the live tick loop while the step counter stays shared.
  const chain: Record<string, RegimeHysteresisState> = {};
  const telemetry: Record<string, RegimeReconstructionTelemetry> = {};
  for (const symbol of params.symbols) {
    chain[symbol] = { previousRegime: null, previousCandidateRegime: null, streakCount: 0, previousDangerZoneTimestamp: null };
    telemetry[symbol] = emptyTelemetry(symbol, params.historyBySymbol[symbol], 'COMPLETE', 'ok');
  }

  for (let step = replaySteps - 1; step >= 0; step--) {
    // Correlated risk is computed ONCE per step across all symbols, from each symbol's own last
    // RECON_WINDOW_1H closed 1h candles at this step's decision time — same call, same window, same
    // anchor as liveRunner.ts tick() and backtest.ts.
    const w1hBySymbol: Record<string, CandleData[]> = {};
    for (const symbol of params.symbols) {
      const c5 = params.historyBySymbol[symbol].candles5m;
      const idx5 = c5.length - 1 - step;
      const candleCloseMs = c5[idx5].timestamp + MS_5M;
      w1hBySymbol[symbol] = closedWindowAt(params.historyBySymbol[symbol].candles1h, MS_1H, candleCloseMs, RECON_WINDOW_1H);
    }
    const correlatedSeries = computeCorrelatedRiskRatio(w1hBySymbol, RegimeConfig.CORRELATED_RISK_WINDOW_CANDLES, anchor);
    const correlatedRiskRatio = correlatedSeries[correlatedSeries.length - 1];

    for (const symbol of params.symbols) {
      const history = params.historyBySymbol[symbol];
      const c5 = history.candles5m;
      const idx5 = c5.length - 1 - step;
      const candleCloseMs = c5[idx5].timestamp + MS_5M;

      const window5m = c5.slice(Math.max(0, idx5 - RECON_WINDOW_5M + 1), idx5 + 1);
      const windowSessionVolume5m = c5.slice(Math.max(0, idx5 - RECON_WINDOW_5M_SESSION_VOLUME + 1), idx5 + 1);
      const window15m = closedWindowAt(history.candles15m, MS_15M, candleCloseMs, RECON_WINDOW_15M);
      const window1h = closedWindowAt(history.candles1h, MS_1H, candleCloseMs, RECON_WINDOW_1H);

      const prev = chain[symbol];
      let output: ReturnType<typeof detectRegime>;
      try {
        output = detectRegime({
          candles5m: window5m,
          candles15m: window15m,
          candles1h: window1h,
          previousRegime: prev.previousRegime,
          previousCandidateRegime: prev.previousCandidateRegime,
          streakCount: prev.streakCount,
          previousDangerZoneTimestamp: prev.previousDangerZoneTimestamp,
          // Withheld (undefined) exactly like the live path does when the window is short — never a
          // silently-substituted "volume looks normal".
          candles5mSessionVolume: windowSessionVolume5m.length === RECON_WINDOW_5M_SESSION_VOLUME ? windowSessionVolume5m : undefined,
          correlatedRiskRatio,
        });
      } catch (err) {
        results[symbol] = {
          status: 'INVALID',
          symbol,
          reason: 'RECONSTRUCTION_EXCEPTION',
          telemetry: emptyTelemetry(symbol, history, 'RECONSTRUCTION_EXCEPTION', `detectRegime() ném lỗi ở bước ${replaySteps - step}/${replaySteps}: ${(err as Error).message}`),
        };
        // One symbol throwing invalidates the whole cross-symbol chain (its future correlatedRisk
        // contribution is unchanged, but its OWN state is unusable) — mark it and stop everything.
        for (const other of params.symbols) {
          if (other === symbol) continue;
          results[other] = {
            status: 'INVALID',
            symbol: other,
            reason: 'CROSS_SYMBOL_INPUT_INVALID',
            telemetry: emptyTelemetry(other, params.historyBySymbol[other], 'CROSS_SYMBOL_INPUT_INVALID', `dừng vì ${symbol} lỗi khi dựng lại regime state`),
          };
        }
        return results;
      }

      chain[symbol] = {
        previousRegime: output.regime,
        previousCandidateRegime: output.candidateRegime,
        streakCount: output.streakCount,
        previousDangerZoneTimestamp: output.lastDangerZoneTimestamp,
      };
      const t = telemetry[symbol];
      if (t.replayStart === null) t.replayStart = c5[idx5].timestamp;
      t.replayEnd = c5[idx5].timestamp;
      t.replayedCandles += 1;
      t.previousRegime = output.regime;
      t.candidateRegime = output.candidateRegime;
      t.streakCount = output.streakCount;
      t.lastDangerZoneTimestamp = output.lastDangerZoneTimestamp;
      t.cooldownRemainingMinutes = cooldownRemainingMinutes(output.lastDangerZoneTimestamp, c5[idx5].timestamp);
      params.onStep?.(symbol, c5[idx5].timestamp, chain[symbol]);
    }
  }

  for (const symbol of params.symbols) {
    results[symbol] = { status: 'OK', symbol, regimeState: chain[symbol], telemetry: telemetry[symbol] };
  }
  return results;
}

// ---- persisted-vs-reconstructed source policy --------------------------------------------------

/**
 * Persisted regime state is only usable when its own candle anchor proves it is current. Two closed
 * 5m candles of slack covers the normal "restart takes a moment" case without ever admitting a
 * persisted anchor that could have missed a DANGER_ZONE candle.
 */
export const PERSISTED_REGIME_STATE_MAX_STALENESS_MS = 2 * MS_5M;

export interface PersistedRegimeStateCandidate {
  regimeState: RegimeHysteresisState;
  /** The 5m candle timestamp this regimeState was produced from — written by liveRunner at persist time. Missing on files predating G3R, which makes the persisted state unusable (no boundary proof). */
  regimeStateCandleTimestamp: number | null | undefined;
}

export type RegimeStateSourceDecision =
  | { source: 'PERSISTED'; regimeState: RegimeHysteresisState; anchorTimestamp: number; reason: string }
  | { source: 'RECONSTRUCTED'; regimeState: RegimeHysteresisState; anchorTimestamp: number; reason: string }
  | { source: 'UNAVAILABLE'; reason: string };

export interface DecideRegimeStateSourceParams {
  persistedFileStatus: 'OK' | 'NOT_FOUND' | 'CORRUPT';
  persisted: PersistedRegimeStateCandidate | null;
  reconstruction: SymbolReconstructionResult;
  /** Timestamp of the newest CLOSED 5m candle available to this process — the "now" both sources are measured against. */
  latestClosedCandleTimestamp: number | null;
  maxPersistedStalenessMs?: number;
}

function isRegimeStateShapeValid(state: unknown): state is RegimeHysteresisState {
  if (state === null || typeof state !== 'object') return false;
  const s = state as Partial<RegimeHysteresisState>;
  return (
    (s.previousRegime === null || typeof s.previousRegime === 'string') &&
    (s.previousCandidateRegime === null || typeof s.previousCandidateRegime === 'string') &&
    typeof s.streakCount === 'number' &&
    (s.previousDangerZoneTimestamp === null || typeof s.previousDangerZoneTimestamp === 'number')
  );
}

/**
 * The ticket's §3 policy, as one pure decision:
 *   - persisted valid + fresh + on a real candle boundary  -> MAY be used;
 *   - persisted missing/stale/corrupt/unaligned            -> MUST reconstruct;
 *   - neither trustworthy                                  -> UNAVAILABLE (caller blocks new entries);
 *   - never let an OLDER reconstruction overwrite a NEWER persisted state — the two anchors are
 *     compared explicitly, persisted wins on a strict tie-break in its favour.
 * Reconstruction is preferred when it is at least as current as persisted, because it is derived from
 * the same candle history the backtest uses and therefore cannot carry a stale/hand-edited anchor.
 */
export function decideRegimeStateSource(params: DecideRegimeStateSourceParams): RegimeStateSourceDecision {
  const maxStaleness = params.maxPersistedStalenessMs ?? PERSISTED_REGIME_STATE_MAX_STALENESS_MS;
  const recon = params.reconstruction;
  const reconOk = recon.status === 'OK';
  const reconAnchor = reconOk ? (recon.telemetry.replayEnd ?? null) : null;

  let persistedUsable = false;
  let persistedAnchor: number | null = null;
  let persistedRejectReason = '';
  if (params.persistedFileStatus !== 'OK' || params.persisted === null) {
    persistedRejectReason = `persisted file status=${params.persistedFileStatus}`;
  } else if (!isRegimeStateShapeValid(params.persisted.regimeState)) {
    persistedRejectReason = 'persisted regimeState sai cấu trúc (corrupt)';
  } else if (typeof params.persisted.regimeStateCandleTimestamp !== 'number') {
    persistedRejectReason = 'persisted regimeState không có mốc nến (regimeStateCandleTimestamp) để chứng minh candle boundary';
  } else if (params.persisted.regimeStateCandleTimestamp % MS_5M !== 0) {
    persistedRejectReason = `persisted regimeStateCandleTimestamp=${params.persisted.regimeStateCandleTimestamp} không nằm đúng biên nến 5m`;
  } else if (params.latestClosedCandleTimestamp === null) {
    // No closed candle at all means freshness cannot be PROVEN — never accept a persisted anchor of
    // unknown age just because there is nothing to compare it against.
    persistedRejectReason = 'không có nến 5m đã đóng nào để chứng minh persisted regimeState còn mới';
  } else if (params.latestClosedCandleTimestamp - params.persisted.regimeStateCandleTimestamp > maxStaleness) {
    persistedAnchor = params.persisted.regimeStateCandleTimestamp;
    persistedRejectReason = `persisted regimeState cũ (mốc ${params.persisted.regimeStateCandleTimestamp}, nến đóng mới nhất ${params.latestClosedCandleTimestamp}, vượt ${maxStaleness}ms)`;
  } else {
    persistedUsable = true;
    persistedAnchor = params.persisted.regimeStateCandleTimestamp;
  }

  if (persistedUsable && persistedAnchor !== null && (reconAnchor === null || persistedAnchor > reconAnchor)) {
    return {
      source: 'PERSISTED',
      regimeState: (params.persisted as PersistedRegimeStateCandidate).regimeState,
      anchorTimestamp: persistedAnchor,
      reason: reconAnchor === null ? 'reconstruction không khả dụng, persisted hợp lệ và còn mới' : `persisted (${persistedAnchor}) MỚI HƠN reconstruction (${reconAnchor}) — không ghi đè bằng state cũ hơn`,
    };
  }
  if (reconOk && reconAnchor !== null) {
    return {
      source: 'RECONSTRUCTED',
      regimeState: (recon as Extract<SymbolReconstructionResult, { status: 'OK' }>).regimeState,
      anchorTimestamp: reconAnchor,
      reason: persistedUsable ? `reconstruction (${reconAnchor}) ít nhất cũng mới bằng persisted (${persistedAnchor}) — ưu tiên nguồn dựng lại từ nến` : `persisted không dùng được (${persistedRejectReason})`,
    };
  }
  if (persistedUsable && persistedAnchor !== null) {
    return {
      source: 'PERSISTED',
      regimeState: (params.persisted as PersistedRegimeStateCandidate).regimeState,
      anchorTimestamp: persistedAnchor,
      reason: 'reconstruction thất bại, persisted hợp lệ và còn mới',
    };
  }
  return {
    source: 'UNAVAILABLE',
    reason: `không có nguồn regime state đáng tin: ${persistedRejectReason}; reconstruction=${recon.status === 'INVALID' ? recon.reason : 'OK nhưng không có mốc nến'} — CHẶN mở lệnh mới, vẫn quản lý vị thế đang mở`,
  };
}

/** The ticket's §5 startup telemetry line. No secrets, no account payload — symbol/candle/regime fields only. */
export function formatRegimeReconstructionLog(symbol: string, source: RegimeStateProvenance, t: RegimeReconstructionTelemetry, reason: string): string {
  return (
    `[REGIME_STATE_RECONSTRUCTION] symbol=${symbol} stateSource=${source} ` +
    `replayStart=${t.replayStart === null ? 'null' : new Date(t.replayStart).toISOString()} ` +
    `replayEnd=${t.replayEnd === null ? 'null' : new Date(t.replayEnd).toISOString()} ` +
    `replayedCandles=${t.replayedCandles} previousRegime=${t.previousRegime ?? 'null'} candidateRegime=${t.candidateRegime ?? 'null'} ` +
    `streakCount=${t.streakCount} lastDangerZoneTimestamp=${t.lastDangerZoneTimestamp === null ? 'null' : new Date(t.lastDangerZoneTimestamp).toISOString()} ` +
    `cooldownRemainingMinutes=${t.cooldownRemainingMinutes} inputQuality=${t.inputQuality} ` +
    `available5m=${t.available5m}/${RECON_REQUIRED_5M} available15m=${t.available15m}/${RECON_REQUIRED_15M} available1h=${t.available1h}/${RECON_REQUIRED_1H} reason="${reason}"`
  );
}
