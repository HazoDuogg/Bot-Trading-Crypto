import type { BinanceOrderExecutor, PositionSide } from './binanceOrderExecutor.js';
import {
  reconcileExecutedOpenState,
  isSlGeometryValidForFill,
  readPositionRiskForSide,
  submitAndClassifyMarketEntry,
  establishProtectiveStopLoss,
  recoverMissingProtectiveSl,
  buildDeterministicEntryClientOrderId,
  quarantineRecordToRiskExposure,
  writeLiveStateFileAtomic,
  cancelAlgoOrderIdempotent,
  LIVE_STATE_SCHEMA_VERSION,
  type MissingProtectiveSlFailsafePolicy,
  type EstablishProtectiveStopLossResult,
  type ReconcileExecutedOpenStateResult,
  type MissingSlRecoveryOutcome,
  type PendingEntryQuarantineRecord,
  type LiveStateFile,
} from './liveStateSync.js';
import { stableTelemetryId, type TelemetryEventDraft } from './executionTelemetry.js';
import { formatPositionOpenedMessage, formatPartialCloseMessage, formatFullCloseMessage, type ExchangeBalanceDisplay } from '../telegram/messageFormatters.js';
import type { CloseTradeEvent, OpenPositionEntry, OpenTradeEvent, PartialCloseEvent, SymbolState } from '../orchestrator/types.js';
import type { UnknownExposureForRisk } from '../risk/currentRisk.js';
import { hasAnyStaleRequiredTimeframe, type CandleFreshnessVerdict } from './candleFreshnessGate.js';

export function roundQty(qty: number): number {
  return Math.round(qty * 1000) / 1000;
}
export function roundPrice(price: number): number {
  return Math.round(price * 100) / 100;
}

export interface LiveOrderIds {
  slAlgoId: number | null;
  tpAlgoIds: number[];
}

export interface OpenEventTelemetryCommon {
  traceId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  setupType: string;
  source: string;
  candidateId: string;
  decisionId: string;
  riskAdmissionId: string;
  positionId: string;
}

export type OpenEventOutcome =
  | { kind: 'DRY_RUN' }
  | { kind: 'NOT_FILLED'; detail: string }
  | { kind: 'AMBIGUOUS'; detail: string; clientOrderId: string; orderId: number | null; executedQty: number | null; avgPrice: unknown }
  | {
      kind: 'FILLED';
      clientOrderId: string;
      orderId: number | null;
      executedQty: number;
      avgPrice: unknown;
      reconciled: ReconcileExecutedOpenStateResult;
      geometryValid: boolean;
      protection: EstablishProtectiveStopLossResult;
      tpAlgoIds: number[];
    };

export async function handleOpenEventIfFresh(
  verdicts: CandleFreshnessVerdict[],
  execute: () => Promise<OpenEventOutcome>,
): Promise<OpenEventOutcome> {
  if (hasAnyStaleRequiredTimeframe(verdicts)) return { kind: 'NOT_FILLED', detail: 'CANDLE_FRESHNESS_BLOCKED' };
  return execute();
}

export function applyAmbiguousOpenOutcome(input: {
  symbol: string;
  event: OpenTradeEvent;
  outcome: Extract<OpenEventOutcome, { kind: 'AMBIGUOUS' }>;
  symbolState: SymbolState;
  recordPendingEntryQuarantine: (record: PendingEntryQuarantineRecord) => boolean;
  enqueueTelegram: (message: string) => void;
}): SymbolState {
  const { symbol, event, outcome } = input;
  const nextState = { ...input.symbolState, openPositions: input.symbolState.openPositions.filter((entry) => entry.meta.entryTimestamp !== event.entryTimestamp) };
  input.recordPendingEntryQuarantine({
    symbol,
    side: event.side,
    phase: 'AMBIGUOUS_SUBMISSION',
    clientOrderId: outcome.clientOrderId,
    orderId: outcome.orderId,
    executedQty: outcome.executedQty,
    averageFillPrice: outcome.avgPrice,
    plannedEntryPrice: event.entryPrice,
    plannedSlPrice: event.slPrice,
    reconciledEntryPrice: null,
    reconciledPositionSize: null,
    protectionOutcome: null,
    actualRiskDollar: null,
    marginRequired: null,
    protectionStatus: null,
    recoveryStatus: null,
    recoveryDetail: null,
    exposureBasis: outcome.executedQty !== null ? { side: event.side, qty: outcome.executedQty, entryPrice: null } : null,
    entryTimestamp: event.entryTimestamp,
    reason: outcome.detail,
    detectedAtMs: Date.now(),
  });
  console.error(`[MARKET_ENTRY_AMBIGUOUS_QUARANTINE] ${symbol} entryTimestamp=${event.entryTimestamp}: ${outcome.detail} — ĐÃ quarantine ${symbol}, chặn mở lệnh mới.`);
  input.enqueueTelegram(`🚨🚨 [CRITICAL — LỆNH MARKET KHÔNG XÁC ĐỊNH] ${symbol} ${event.side}: ${outcome.detail}\nclientOrderId=${outcome.clientOrderId}\nĐÃ CHẶN mở lệnh mới trên ${symbol} — cần kiểm tra thủ công NGAY.`);
  return nextState;
}

export type LifecycleExecutor = Pick<
  BinanceOrderExecutor,
  | 'openMarketPosition'
  | 'getOrderByClientOrderId'
  | 'getPositionRisk'
  | 'placeStopMarket'
  | 'getOpenAlgoOrders'
  | 'closePositionMarket'
  | 'placeTakeProfitMarket'
  | 'updateStopOrder'
  | 'cancelAlgoOrder'
  | 'getIncome'
>;

export interface RunnerStateAccess {
  getOpenPositionCount(symbol: string): number;
  setOrderIds(symbol: string, entryTimestamp: number, ids: LiveOrderIds): void;
  getOrderIds(symbol: string, entryTimestamp: number): LiveOrderIds | undefined;
  deleteOrderIds(symbol: string, entryTimestamp: number): void;
  blockSymbolAdmission(symbol: string): void;
  blockIncomeReconciliation?(symbol: string): void;
  clearIncomeReconciliation?(symbol: string): void;
}

export interface LifecycleContext {
  executor: LifecycleExecutor;
  dryRun: boolean;
  envLabel: 'mainnet' | 'testnet';
  leverage: number;
  quantityToleranceBySymbol: Record<string, number>;
  missingProtectiveSlFailsafePolicy: MissingProtectiveSlFailsafePolicy;
  oodGuardEnabled: boolean;
  runnerState: RunnerStateAccess;
  emitTelemetry: (event: TelemetryEventDraft) => void;
  enqueueTelegram: (message: string) => void;
  refreshBalanceForTelegram: () => Promise<ExchangeBalanceDisplay | null>;
  onAccountSyncUnknown: () => void;
  onWillOpen: () => void;
  persistLiveState: () => boolean;
  incomeReconciliationRetryDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
}

async function establishReconciledProtectedPosition(
  ctx: LifecycleContext,
  params: {
    symbol: string;
    event: OpenTradeEvent;
    balanceAtOpen: number;
    clientOrderId: string;
    canonicalQty: number;
    classificationOrderId: number | null;
    classificationAvgPrice: unknown;
    preSubmissionBaselineQtyAbs: number;
    telemetryCommon: OpenEventTelemetryCommon;
  },
): Promise<OpenEventOutcome> {
  const { symbol, event, balanceAtOpen, clientOrderId, canonicalQty, classificationOrderId, classificationAvgPrice, preSubmissionBaselineQtyAbs, telemetryCommon } = params;
  const postFillPositionRisk = await readPositionRiskForSide(ctx.executor, symbol, event.side);
  const reconciled = reconcileExecutedOpenState({
    initialSlPrice: event.slPrice,
    canonicalQty,
    canonicalQtySource: 'EXECUTED_QTY',
    rawAvgPrice: classificationAvgPrice,
    freshPositionRiskEntryPrice: postFillPositionRisk?.entryPrice ?? null,
    freshPositionRiskQtyAbs: postFillPositionRisk !== null ? postFillPositionRisk.qtyAbs : null,
    preSubmissionBaselineQtyAbs,
    quantityTolerance: ctx.quantityToleranceBySymbol[symbol],
    leverage: ctx.leverage,
  });
  const geometryValid = reconciled.ok && isSlGeometryValidForFill(event.side, reconciled.entryPrice, event.slPrice);

  let protection: EstablishProtectiveStopLossResult;
  const tpAlgoIds: number[] = [];
  if (!reconciled.ok) {
    const reason = `reconcile thất bại: ${reconciled.reason}`;
    const recovery = await recoverMissingProtectiveSl({
      executor: ctx.executor,
      symbol,
      expectedSide: event.side,
      expectedQty: canonicalQty,
      quantityTolerance: ctx.quantityToleranceBySymbol[symbol],
      slTriggerPrice: event.slPrice,
      policy: ctx.missingProtectiveSlFailsafePolicy,
      skipPlacementAttempts: true,
    });
    protection =
      recovery.status === 'RECOVERED' || recovery.status === 'ALREADY_RECOVERED_ON_RESTART'
        ? { status: 'PROTECTED', slAlgoId: recovery.slAlgoId, detail: `${reason} — nhưng phục hồi SL ngay lập tức thành công: ${recovery.detail}` }
        : { status: 'PROTECTION_DEGRADED', firstAttemptReason: reason, recovery };
  } else if (!geometryValid) {
    const reason = `SL geometry không hợp lệ với giá khớp thực tế (entryPrice=${reconciled.entryPrice}, slPrice=${event.slPrice}, side=${event.side})`;
    const recovery = await recoverMissingProtectiveSl({
      executor: ctx.executor,
      symbol,
      expectedSide: event.side,
      expectedQty: canonicalQty,
      quantityTolerance: ctx.quantityToleranceBySymbol[symbol],
      slTriggerPrice: event.slPrice,
      policy: ctx.missingProtectiveSlFailsafePolicy,
      skipPlacementAttempts: true,
    });
    protection =
      recovery.status === 'RECOVERED' || recovery.status === 'ALREADY_RECOVERED_ON_RESTART'
        ? { status: 'PROTECTED', slAlgoId: recovery.slAlgoId, detail: `${reason} — nhưng phục hồi SL ngay lập tức thành công: ${recovery.detail}` }
        : { status: 'PROTECTION_DEGRADED', firstAttemptReason: reason, recovery };
  } else {
    protection = await establishProtectiveStopLoss({
      executor: ctx.executor,
      symbol,
      side: event.side,
      slPrice: roundPrice(event.slPrice),
      quantity: canonicalQty,
      quantityTolerance: ctx.quantityToleranceBySymbol[symbol],
      policy: ctx.missingProtectiveSlFailsafePolicy,
    });
  }

  if (protection.status === 'PROTECTED') {
    if (reconciled.ok && geometryValid) {
      for (const tp of event.tpLevels) {
        if (tp.price === null) continue;
        const tpQty = roundQty(canonicalQty * tp.closePercent);
        if (tpQty <= 0) continue;
        try {
          const tpResult = await ctx.executor.placeTakeProfitMarket(symbol, event.side, roundPrice(tp.price), tpQty);
          if ('algoId' in tpResult) tpAlgoIds.push(tpResult.algoId);
        } catch (err) {
          console.error(`[TP_PLACEMENT_ERROR] ${symbol} ${event.side} ${tp.label}: ${(err as Error).message} — SL đã bảo vệ vị thế (không nghiêm trọng bằng thiếu SL), chỉ cảnh báo.`);
        }
      }
    }
    ctx.runnerState.setOrderIds(symbol, event.entryTimestamp, { slAlgoId: protection.slAlgoId, tpAlgoIds });
    ctx.emitTelemetry({ ...telemetryCommon, clientOrderId, eventType: 'ORDER_SENT', quality: { role: 'OBSERVED', algoId: protection.slAlgoId !== null ? 'OBSERVED' : 'MISSING', price: 'OBSERVED' }, data: { role: 'PROTECTIVE_SL', algoId: protection.slAlgoId ?? 'MISSING', triggerPrice: roundPrice(event.slPrice) } });
    for (const algoId of tpAlgoIds) {
      ctx.emitTelemetry({ ...telemetryCommon, clientOrderId, eventType: 'ORDER_SENT', quality: { role: 'OBSERVED', algoId: 'OBSERVED', price: 'OBSERVED' }, data: { role: 'TAKE_PROFIT', algoId } });
    }
  } else {
    ctx.runnerState.setOrderIds(symbol, event.entryTimestamp, { slAlgoId: null, tpAlgoIds: [] });
    ctx.emitTelemetry({ ...telemetryCommon, clientOrderId, eventType: 'ORDER_SENT', quality: { role: 'MISSING', algoId: 'MISSING', price: 'MISSING' }, data: { role: 'PROTECTIVE_SL', algoId: 'MISSING', triggerPrice: 'MISSING', protectionStatus: protection.status } });
  }

  const oodGuardApplied = ctx.oodGuardEnabled && event.setupType === 'MOMENTUM_DIRECT' && event.side === 'SHORT' && event.riskMultiplier < 1;
  if (oodGuardApplied) console.log(`[OOD_GUARD] ${symbol} SHORT MOMENTUM_DIRECT mở lệnh với size đã giảm (riskMultiplier=${event.riskMultiplier.toFixed(3)})`);
  const exchangeBalance = await ctx.refreshBalanceForTelegram();
  ctx.enqueueTelegram(
    formatPositionOpenedMessage(event, { env: ctx.envLabel, accountBalanceAtOpen: balanceAtOpen, exchangeBalance }) +
    (protection.status !== 'PROTECTED' ? '\n\n🚨🚨 [SL CHƯA ĐƯỢC BẢO VỆ — xem cảnh báo CRITICAL riêng]' : '') +
    (oodGuardApplied ? '\n[OOD Guard: size đã giảm theo Risk Reduction P97.5]' : ''),
  );
  return { kind: 'FILLED', clientOrderId, orderId: classificationOrderId, executedQty: canonicalQty, avgPrice: classificationAvgPrice, reconciled, geometryValid, protection, tpAlgoIds };
}

export async function handleOpenEvent(ctx: LifecycleContext, symbol: string, event: OpenTradeEvent, balanceAtOpen: number): Promise<OpenEventOutcome> {
  const quantity = roundQty((event.marginRequired * ctx.leverage) / event.entryPrice);
  const traceId = stableTelemetryId('trace', symbol, event.entryTimestamp, event.side, event.setupType);
  const candidateId = stableTelemetryId('candidate', traceId);
  const decisionId = stableTelemetryId('decision', traceId);
  const riskAdmissionId = stableTelemetryId('risk', traceId);
  const positionId = stableTelemetryId('position', traceId);
  const common: OpenEventTelemetryCommon = { traceId, symbol, side: event.side, setupType: event.setupType, source: 'LIVE_RUNNER', candidateId, decisionId, riskAdmissionId, positionId };
  ctx.emitTelemetry({ ...common, eventType: 'CANDIDATE_CREATED', eventTimestampUtc: new Date(event.entryTimestamp).toISOString(), quality: { entryProposal: 'DERIVED', stopProposal: 'DERIVED', takeProfitProposal: 'DERIVED', regime: 'OBSERVED' }, data: { timeframe: '5m', candleOpenTimestamp: event.entryTimestamp, entryProposal: event.entryPrice, stopProposal: event.slPrice, takeProfitProposal: event.tpLevels, regime: event.regime, xgbScore: event.momentumScore ?? 'MISSING', t152SameSideGuardEnabled: true } });
  ctx.emitTelemetry({ ...common, eventType: 'DECISION_MADE', quality: { decision: 'DERIVED' }, data: { decision: 'ALLOW', reasonCode: 'ORCHESTRATOR_OPEN_EVENT', openPositionCount: ctx.runnerState.getOpenPositionCount(symbol) } });
  ctx.emitTelemetry({ ...common, eventType: 'RISK_ADMISSION', quality: { balance: 'OBSERVED', requestedRisk: 'DERIVED', quantity: 'DERIVED' }, data: { admission: 'ALLOW', balance: balanceAtOpen, requestedRiskDollar: event.actualRiskDollar, requestedNotional: event.marginRequired * ctx.leverage, proposedQuantity: quantity, marginRequired: event.marginRequired, leverage: ctx.leverage, riskPoolPctBefore: event.riskPoolPctBefore, riskPoolPctAfter: event.riskPoolPctAfter, riskMultiplier: event.riskMultiplier } });
  ctx.emitTelemetry({ ...common, eventType: 'MARKET_SNAPSHOT', quality: { bestBid: 'MISSING', bestAsk: 'MISSING', mid: 'MISSING', markPrice: 'MISSING', indexPrice: 'MISSING' }, data: { captureStatus: 'MISSING', reasonCode: 'NO_NON_BLOCKING_BOOK_TICKER_FEED', candleReferencePrice: event.entryPrice } });

  if (ctx.dryRun) {
    console.log(`[SẼ MỞ LỆNH] ${symbol} ${event.side} entry=${event.entryPrice} sl=${event.slPrice} qty=${quantity} setupType=${event.setupType}`);
    ctx.onWillOpen();
    const exchangeBalance = await ctx.refreshBalanceForTelegram();
    ctx.enqueueTelegram(formatPositionOpenedMessage(event, { env: ctx.envLabel, accountBalanceAtOpen: balanceAtOpen, exchangeBalance }) + '\n\n[DRY-RUN]');
    return { kind: 'DRY_RUN' };
  }

  const clientOrderId = buildDeterministicEntryClientOrderId(symbol, event.side, event.entryTimestamp);
  const preSubmissionBaseline = await readPositionRiskForSide(ctx.executor, symbol, event.side);
  if (preSubmissionBaseline === null) {
    ctx.onAccountSyncUnknown();
    const detail = `Không đọc được position baseline trước MARKET cho ${symbol} ${event.side}; không gửi lệnh và chặn admission.`;
    console.error(`[PRE_SUBMISSION_BASELINE_UNAVAILABLE] ${detail}`);
    ctx.enqueueTelegram(`🚨🚨 [CRITICAL — POSITION BASELINE UNKNOWN] ${detail}`);
    return { kind: 'NOT_FILLED', detail };
  }
  const preSubmissionBaselineQtyAbs = preSubmissionBaseline.qtyAbs;
  ctx.emitTelemetry({ ...common, clientOrderId, eventType: 'ORDER_SUBMIT_INTENT', quality: { requestedQuantity: 'DERIVED' }, data: { intentTimestampMs: Date.now(), orderRole: 'ENTRY', type: 'MARKET', reduceOnly: false, requestedQuantity: quantity } });
  ctx.emitTelemetry({ ...common, clientOrderId, eventType: 'ORDER_SENT', quality: { localSendTimestamp: 'OBSERVED' }, data: { localSendTimestampMs: Date.now(), attempt: 1 } });

  const classification = await submitAndClassifyMarketEntry({ executor: ctx.executor, symbol, side: event.side, quantity, referencePrice: event.entryPrice, clientOrderId });

  if (classification.outcome === 'CONFIRMED_NOT_FILLED') {
    ctx.emitTelemetry({ ...common, clientOrderId, eventType: 'EXCHANGE_REJECT', quality: { error: 'OBSERVED' }, data: { localAckTimestampMs: Date.now(), sanitizedErrorCode: 'CONFIRMED_NOT_FILLED' } });
    console.error(`[MARKET_ENTRY_NOT_FILLED] ${symbol} ${event.side}: ${classification.detail}`);
    return { kind: 'NOT_FILLED', detail: classification.detail };
  }
  if (classification.outcome === 'AMBIGUOUS') {
    ctx.emitTelemetry({ ...common, clientOrderId, eventType: 'EXCHANGE_REJECT', quality: { error: 'OBSERVED' }, data: { localAckTimestampMs: Date.now(), sanitizedErrorCode: 'AMBIGUOUS' } });
    console.error(`[MARKET_ENTRY_AMBIGUOUS] ${symbol} ${event.side}: ${classification.detail}`);
    return { kind: 'AMBIGUOUS', detail: classification.detail, clientOrderId, orderId: classification.orderId, executedQty: classification.executedQty, avgPrice: classification.avgPrice };
  }

  const canonicalQty = classification.executedQty as number;
  const exchangeOrderIdStr = classification.orderId !== null ? String(classification.orderId) : 'UNKNOWN';
  ctx.emitTelemetry({ ...common, clientOrderId, exchangeOrderId: exchangeOrderIdStr, eventType: 'EXCHANGE_ACK', quality: { exchangeOrderId: classification.orderId !== null ? 'OBSERVED' : 'MISSING', exchangeTimestamp: 'MISSING' }, data: { localAckTimestampMs: Date.now(), exchangeTimestampMs: 'MISSING', status: 'FILLED', executedQty: String(canonicalQty), averageFillPrice: classification.avgPrice ?? 'MISSING' } });
  ctx.emitTelemetry({ ...common, clientOrderId, exchangeOrderId: exchangeOrderIdStr, fillId: stableTelemetryId('fill', classification.orderId ?? 0, Date.now()), eventType: 'FILL_COMPLETE', quality: { fillQuantity: 'OBSERVED', averageFillPrice: classification.avgPrice ? 'OBSERVED' : 'MISSING', commission: 'MISSING', funding: 'MISSING' }, data: { fillTimestampMs: Date.now(), localReceiveTimestampMs: Date.now(), fillQuantity: String(canonicalQty), averageFillPrice: classification.avgPrice ?? 'MISSING', commissionAmount: 'MISSING', commissionAsset: 'MISSING', makerTaker: 'MISSING', fundingStatus: 'MISSING', terminalStatus: 'FILLED' } });
  console.log(`[CANONICAL_QTY] ${symbol} source=CONFIRMED_FILLED submittedQty=${quantity} canonicalQty=${canonicalQty}`);

  try {
    return await establishReconciledProtectedPosition(ctx, { symbol, event, balanceAtOpen, clientOrderId, canonicalQty, classificationOrderId: classification.orderId, classificationAvgPrice: classification.avgPrice, preSubmissionBaselineQtyAbs, telemetryCommon: common });
  } catch (err) {
    const recovery: MissingSlRecoveryOutcome = { status: 'EXHAUSTED_OPERATOR_REQUIRED', attemptsUsed: 0, detail: `xử lý sau-khớp-lệnh gặp lỗi không mong đợi (đã bắt): ${(err as Error).message}` };
    const protection: EstablishProtectiveStopLossResult = { status: 'PROTECTION_DEGRADED', firstAttemptReason: `unexpected-post-fill-error: ${(err as Error).message}`, recovery };
    return {
      kind: 'FILLED',
      clientOrderId,
      orderId: classification.orderId,
      executedQty: canonicalQty,
      avgPrice: classification.avgPrice,
      reconciled: { ok: false, reason: 'CANONICAL_QTY_INVALID' },
      geometryValid: false,
      protection,
      tpAlgoIds: [],
    };
  }
}

export async function handlePartialCloseEvent(
  ctx: LifecycleContext,
  symbol: string,
  event: PartialCloseEvent,
  entryTimestampOfPosition: number,
  remainingQuantity: number,
  owner: OpenPositionEntry | undefined,
): Promise<void> {
  if (ctx.dryRun) {
    console.log(`[SẼ CHỐT MỘT PHẦN] ${symbol} ${event.tier} newSl=${event.newSlPrice}`);
  } else {
    const ids = ctx.runnerState.getOrderIds(symbol, entryTimestampOfPosition);
    if (ids?.slAlgoId != null && remainingQuantity > 0) {
      try {
        const newSl = await ctx.executor.updateStopOrder(symbol, ids.slAlgoId, event.side, roundPrice(event.newSlPrice), roundQty(remainingQuantity));
        if ('algoId' in newSl) ids.slAlgoId = newSl.algoId;
      } catch (err) {
        console.error(`[SL_REPLACE_FAILED] ${symbol} ${event.side} tier=${event.tier}: ${(err as Error).message} — SL cũ đã hủy, đang KHÔNG có SL trên sàn. Thử phục hồi ngay lập tức.`);
        const recovery = await recoverMissingProtectiveSl({
          executor: ctx.executor,
          symbol,
          expectedSide: event.side,
          expectedQty: remainingQuantity,
          quantityTolerance: ctx.quantityToleranceBySymbol[symbol],
          slTriggerPrice: event.newSlPrice,
          policy: ctx.missingProtectiveSlFailsafePolicy,
        });
        if (recovery.status === 'RECOVERED' || recovery.status === 'ALREADY_RECOVERED_ON_RESTART') {
          ids.slAlgoId = recovery.slAlgoId;
          if (owner) owner.meta.protectionStatus = 'PROTECTED';
          console.log(`[SL_REPLACE_RECOVERED] ${symbol} ${event.side}: ${recovery.detail}`);
          ctx.enqueueTelegram(`✅ [SL PHỤC HỒI SAU THẤT BẠI THAY THẾ] ${symbol} ${event.side}: ${recovery.detail}`);
        } else {
          if (owner) owner.meta.protectionStatus = 'PROTECTION_DEGRADED';
          ctx.runnerState.blockSymbolAdmission(symbol);
          console.error(`[SL_REPLACE_RECOVERY_FAILED] ${symbol} ${event.side}: ${recovery.status} — ${recovery.detail} — ĐÃ quarantine ${symbol}, chặn mở lệnh mới.`);
          ctx.enqueueTelegram(`🚨🚨 [CRITICAL — SL THAY THẾ THẤT BẠI, PHỤC HỒI CŨNG THẤT BẠI] ${symbol} ${event.side}: ${recovery.status} — ${recovery.detail}\nĐÃ CHẶN mở lệnh mới trên ${symbol} — cần kiểm tra thủ công NGAY.`);
          const persisted = ctx.persistLiveState();
          if (!persisted) console.error(`[QUARANTINE_PERSIST_FAILED] ${symbol}: PROTECTION_DEGRADED (partial-close SL replace) đã ghi nhận trong bộ nhớ nhưng GHI FILE THẤT BẠI.`);
        }
      }
    }
  }
  const exchangeBalance = await ctx.refreshBalanceForTelegram();
  ctx.enqueueTelegram(formatPartialCloseMessage(event, { env: ctx.envLabel, exchangeBalance }) + (ctx.dryRun ? '\n\n[DRY-RUN]' : ''));
}

const INCOME_RECONCILIATION_BUFFER_MS = 5_000;

export interface TradeIncomeReconciliation {
  quality: 'OBSERVED' | 'AMBIGUOUS' | 'MISSING';
  realizedPnl: number | null;
  commission: number | null;
  funding: number | null;
  detail: string;
}

export function reconcileTradeIncomeFromRecords(records: unknown, entryTimestamp: number, exitTimestamp: number, bufferMs: number = INCOME_RECONCILIATION_BUFFER_MS): TradeIncomeReconciliation {
  if (!Array.isArray(records)) {
    return { quality: 'MISSING', realizedPnl: null, commission: null, funding: null, detail: 'getIncome() không trả về mảng — không đối soát được.' };
  }
  const windowStart = entryTimestamp - bufferMs;
  const windowEnd = exitTimestamp + bufferMs;
  const inWindow = records.filter((r): r is { incomeType: unknown; income: unknown; time: unknown } => {
    if (typeof r !== 'object' || r === null) return false;
    const time = (r as { time?: unknown }).time;
    return typeof time === 'number' && time >= windowStart && time <= windowEnd;
  });
  if (inWindow.length === 0) {
    return { quality: 'MISSING', realizedPnl: null, commission: null, funding: null, detail: `Không có income record nào trong window [${windowStart},${windowEnd}].` };
  }
  let realizedPnl = 0;
  let commission = 0;
  let funding = 0;
  let sawRealizedPnl = false;
  let sawCommission = false;
  let sawFunding = false;
  for (const record of inWindow) {
    const amount = Number(record.income);
    if (!Number.isFinite(amount)) {
      return { quality: 'AMBIGUOUS', realizedPnl: null, commission: null, funding: null, detail: `income record có giá trị không parse được: ${JSON.stringify(record)}.` };
    }
    if (record.incomeType === 'REALIZED_PNL') { realizedPnl += amount; sawRealizedPnl = true; }
    else if (record.incomeType === 'COMMISSION') { commission += amount; sawCommission = true; }
    else if (record.incomeType === 'FUNDING_FEE') { funding += amount; sawFunding = true; }
  }
  if (!sawRealizedPnl || !sawCommission) {
    const missing = [!sawRealizedPnl ? 'REALIZED_PNL' : null, !sawCommission ? 'COMMISSION' : null].filter(Boolean).join(',');
    return { quality: 'MISSING', realizedPnl: sawRealizedPnl ? realizedPnl : null, commission: sawCommission ? commission : null, funding: sawFunding ? funding : null, detail: `Thiếu income type bắt buộc trong window: ${missing}.` };
  }
  return {
    quality: 'OBSERVED',
    realizedPnl: sawRealizedPnl ? realizedPnl : null,
    commission: sawCommission ? commission : null,
    funding: sawFunding ? funding : null,
    detail: `${inWindow.length} income record(s) trong window (${records.length - inWindow.length} bị loại vì ngoài window).`,
  };
}

async function reconcileTradeIncomeAfterClose(ctx: LifecycleContext, symbol: string, event: CloseTradeEvent, traceId: string, positionId: string): Promise<void> {
  if (ctx.dryRun) return;
  const emitReconciled = (quality: TradeIncomeReconciliation['quality'], result: Omit<TradeIncomeReconciliation, 'quality'>) => {
    const observed = (value: number | null) => quality === 'OBSERVED' && value !== null ? 'OBSERVED' as const : 'MISSING' as const;
    ctx.emitTelemetry({
      traceId, symbol, side: event.side, setupType: event.setupType, positionId,
      eventType: 'POSITION_RECONCILED', source: 'EXCHANGE_INCOME_RECONCILIATION',
      quality: { realizedPnl: observed(result.realizedPnl), commission: observed(result.commission), funding: observed(result.funding) },
      data: { realizedPnl: result.realizedPnl ?? 'MISSING', commission: result.commission ?? 'MISSING', funding: result.funding ?? 'MISSING', modeledPnl: event.pnlUsd, detail: result.detail },
    });
  };
  const startTime = event.entryTimestamp - INCOME_RECONCILIATION_BUFFER_MS;
  const endTime = event.exitTimestamp + INCOME_RECONCILIATION_BUFFER_MS;
  const retryDelays = ctx.incomeReconciliationRetryDelaysMs ?? [500, 1_500, 3_000];
  const wait = ctx.wait ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let lastResult: TradeIncomeReconciliation = { quality: 'MISSING', realizedPnl: null, commission: null, funding: null, detail: 'Chưa đối soát.' };
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      const raw = await ctx.executor.getIncome(symbol, startTime, endTime);
      lastResult = reconcileTradeIncomeFromRecords(raw, event.entryTimestamp, event.exitTimestamp);
    } catch (err) {
      lastResult = { quality: 'MISSING', realizedPnl: null, commission: null, funding: null, detail: `lỗi getIncome(): ${(err as Error).message}` };
    }
    if (lastResult.quality === 'OBSERVED') {
      ctx.runnerState.clearIncomeReconciliation?.(symbol);
      emitReconciled(lastResult.quality, lastResult);
      return;
    }
    if (ctx.runnerState.blockIncomeReconciliation) ctx.runnerState.blockIncomeReconciliation(symbol);
    else ctx.runnerState.blockSymbolAdmission(symbol);
    if (attempt < retryDelays.length) await wait(retryDelays[attempt]);
  }
  emitReconciled(lastResult.quality, lastResult);
  console.error(`[EXCHANGE_INCOME_RECONCILIATION_${lastResult.quality}] ${symbol}: ${lastResult.detail} — ĐÃ CHẶN mở lệnh mới trên ${symbol} cho tới khi đối soát PnL sàn xong.`);
  ctx.enqueueTelegram(`🚨🚨 [CRITICAL — ĐỐI SOÁT PNL SÀN ${lastResult.quality}] ${symbol}: ${lastResult.detail}\nĐÃ CHẶN mở lệnh mới trên ${symbol} — cần kiểm tra thủ công.`);
}

export async function handleCloseEvent(ctx: LifecycleContext, symbol: string, event: CloseTradeEvent): Promise<void> {
  const closeTraceId = stableTelemetryId('trace', symbol, event.entryTimestamp, event.side, event.setupType);
  const closePositionId = stableTelemetryId('position', closeTraceId);
  ctx.emitTelemetry({ traceId: closeTraceId, symbol, side: event.side, setupType: event.setupType, positionId: closePositionId, eventType: 'TRADE_CLOSED', eventTimestampUtc: new Date(event.exitTimestamp).toISOString(), source: 'LIVE_RUNNER', quality: { pnl: 'MODELED', fees: 'MODELED', funding: 'MISSING', entryVwap: 'MISSING', exitVwap: 'MISSING' }, data: { exitReason: event.exitReason, modeledNetPnl: event.pnlUsd, referenceEntry: event.entryPrice, referenceExit: event.exitPrice, holdingDurationMs: event.exitTimestamp - event.entryTimestamp, observedFees: 'MISSING', funding: 'MISSING' } });
  if (ctx.dryRun) {
    console.log(`[SẼ ĐÓNG LỆNH] ${symbol} exitReason=${event.exitReason} pnlUsd=${event.pnlUsd.toFixed(2)}`);
  } else {
    const ids = ctx.runnerState.getOrderIds(symbol, event.entryTimestamp);
    if (ids) {
      let isConfirmedClosed = false;
      try {
        const posRisk = (await ctx.executor.getPositionRisk(symbol)) as Array<{ symbol?: string; positionAmt?: string }>;
        const amt = Array.isArray(posRisk) ? Number(posRisk.find((p) => p.symbol === symbol)?.positionAmt ?? '0') : NaN;
        isConfirmedClosed = Number.isFinite(amt) && Math.abs(amt) < 1e-9;
      } catch (e) {
        console.error(`[CLOSE_CONFIRM_ERROR] ${symbol}: không xác nhận được vị thế qua getPositionRisk() trước khi hủy SL/TP còn treo — coi mọi -2011 sau đây là lỗi thật (an toàn hơn): ${(e as Error).message}`);
      }

      if (ids.slAlgoId != null) {
        const outcome = await cancelAlgoOrderIdempotent(ctx.executor, symbol, ids.slAlgoId, `handleCloseEvent(${symbol}) SL`, isConfirmedClosed);
        if (outcome.status === 'ALREADY_TERMINAL') console.log(outcome.logLine);
        else if (outcome.status === 'ERROR') console.error(`[CLEANUP] hủy SL lỗi: ${outcome.error.message}`);
      }
      for (const tpId of ids.tpAlgoIds) {
        const outcome = await cancelAlgoOrderIdempotent(ctx.executor, symbol, tpId, `handleCloseEvent(${symbol}) TP`, isConfirmedClosed);
        if (outcome.status === 'ALREADY_TERMINAL') console.log(outcome.logLine);
        else if (outcome.status === 'ERROR') console.error(`[CLEANUP] hủy TP lỗi: ${outcome.error.message}`);
      }
      ctx.runnerState.deleteOrderIds(symbol, event.entryTimestamp);
    }
  }
  const exchangeBalance = await ctx.refreshBalanceForTelegram();
  ctx.enqueueTelegram(formatFullCloseMessage(event, { env: ctx.envLabel, exchangeBalance }) + (ctx.dryRun ? '\n\n[DRY-RUN]' : ''));
  await reconcileTradeIncomeAfterClose(ctx, symbol, event, closeTraceId, closePositionId);
}

export interface PersistLiveStateDeps {
  filePath: string;
  symbols: string[];
  getSymbolStateForPersist(symbol: string): { symbolState: SymbolState; orderIds: [number, LiveOrderIds][]; regimeStateCandleTimestamp: number | null };
  getPendingEntryQuarantinesBySymbol(): Record<string, PendingEntryQuarantineRecord[]>;
  enqueueTelegram: (message: string) => void;
  onPersistFailure: (failed: boolean) => void;
}

export function createPersistLiveState(deps: PersistLiveStateDeps): () => boolean {
  return function persistLiveState(): boolean {
    try {
      const file: LiveStateFile = {
        schemaVersion: LIVE_STATE_SCHEMA_VERSION,
        savedAtMs: Date.now(),
        symbols: Object.fromEntries(deps.symbols.map((s) => [s, deps.getSymbolStateForPersist(s)])),
        pendingEntryQuarantines: deps.getPendingEntryQuarantinesBySymbol(),
      };
      writeLiveStateFileAtomic(deps.filePath, file);
      deps.onPersistFailure(false);
      return true;
    } catch (err) {
      deps.onPersistFailure(true);
      console.error(`[LIVE_STATE_PERSIST_ERROR] ghi trạng thái thất bại (đã bắt, KHÔNG crash tiến trình): ${(err as Error).message}`);
      deps.enqueueTelegram(`🚨🚨 [CRITICAL — GHI TRẠNG THÁI THẤT BẠI] ${(err as Error).message}\nĐÃ CHẶN mở lệnh mới TOÀN BỘ portfolio cho tới khi ghi lại thành công — các vị thế đang mở vẫn được quản lý bình thường.`);
      return false;
    }
  };
}

export interface RecordPendingEntryQuarantineDeps {
  blockSymbolAdmission(symbol: string): void;
  getPendingEntryQuarantinesBySymbol(): Record<string, PendingEntryQuarantineRecord[]>;
  setPendingEntryQuarantinesBySymbol(next: Record<string, PendingEntryQuarantineRecord[]>): void;
  persistLiveState: () => boolean;
}

export function createRecordPendingEntryQuarantine(deps: RecordPendingEntryQuarantineDeps): (record: PendingEntryQuarantineRecord) => boolean {
  return function recordPendingEntryQuarantine(record: PendingEntryQuarantineRecord): boolean {
    deps.blockSymbolAdmission(record.symbol);
    const current = deps.getPendingEntryQuarantinesBySymbol();
    deps.setPendingEntryQuarantinesBySymbol({ ...current, [record.symbol]: [...(current[record.symbol] ?? []), record] });
    const persisted = deps.persistLiveState();
    if (!persisted) {
      console.error(`[QUARANTINE_PERSIST_FAILED] ${record.symbol} phase=${record.phase}: bản ghi quarantine đang ở trong bộ nhớ nhưng GHI FILE THẤT BẠI — chưa được lưu bền vững.`);
    }
    return persisted;
  };
}

export interface FoldedRestartQuarantineSymbol {
  symbol: string;
  recordCount: number;
}

export interface FoldPendingEntryQuarantinesResult {
  blockedSymbols: FoldedRestartQuarantineSymbol[];
  quarantinedUnknownExposures: UnknownExposureForRisk[];
}

export function foldPendingEntryQuarantinesOnRestart(pendingEntryQuarantinesBySymbol: Record<string, PendingEntryQuarantineRecord[]>): FoldPendingEntryQuarantinesResult {
  const blockedSymbols: FoldedRestartQuarantineSymbol[] = [];
  const quarantinedUnknownExposures: UnknownExposureForRisk[] = [];
  for (const [symbol, records] of Object.entries(pendingEntryQuarantinesBySymbol)) {
    if (records.length === 0) continue;
    blockedSymbols.push({ symbol, recordCount: records.length });
    for (const [idx, record] of records.entries()) {
      quarantinedUnknownExposures.push(quarantineRecordToRiskExposure(record, idx));
    }
  }
  return { blockedSymbols, quarantinedUnknownExposures };
}

export type { PositionSide };
