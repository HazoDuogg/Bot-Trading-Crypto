import type { Direction } from '../entry/types.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../entry/fvgStrategyConfig.js';
import type { LifecycleEvent } from './orderLifecycle.js';
import type { RegimeSnapshot } from './signalEngine.js';

// TICKET-RT-068 Part D+E: ONE canonical record shape built from every event source (signal
// detection skip, order placed/filled/cancelled/closed, engine lifecycle) — Telegram formatting
// (Part D) and JSONL logging (Part E) both consume this SAME structure, so the log is guaranteed
// to contain exactly what the Telegram message said, per the ticket's "log... chua toan bo du
// lieu o Phan D".

export const STRATEGY_NAME = 'FVG H1+M15'; // "chi co 1" per the ticket — fixed text, not a config lookup
export const R_MULTIPLE = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple; // read from production config, not a hardcoded literal, even though "co dinh" per the ticket

export type EventRecordKind =
  | 'ENGINE_STARTUP'
  | 'ENTRY_PLACED'
  | 'ENTRY_SKIPPED'
  | 'ENTRY_TIMEOUT_CANCELLED'
  | 'ENTRY_FILLED'
  | 'POSITION_CLOSED'
  | 'LIFECYCLE_ERROR'
  | 'POLL_ERROR';

export interface LiveEventRecord {
  timestampUtc: string; // Part D: "thoi gian"
  symbol: string; // Part D: "tai san"
  strategy: string; // Part D: "chien luoc" — fixed "FVG H1+M15"
  eventKind: EventRecordKind;
  regime?: RegimeSnapshot; // Part C
  direction?: Direction;
  entryPrice?: number;
  slPrice?: number;
  tpPrice?: number;
  rMultiple?: number; // Part D: "R:R (co dinh 2.10R nhung van hien thi ro)"
  entryReasonText?: string; // Part D: "ly do vao lenh (mo ta gap + trend)"
  resultOutcome?: 'TP' | 'SL';
  resultPnlUsd?: number; // real, from ExchangeOrderClient.getRealizedPnlSince — never hand-computed
  resultReasonText?: string; // Part D: "ket qua (...) + ly do"
  note?: string; // Part D: "ghi chu su kien dac biet (loi API, huy lenh do timeout, v.v.)"
  raw: unknown; // the full underlying event object, for programmatic analysis beyond the display fields
}

function describeEntryReason(direction: Direction, gapLow: number, gapHigh: number, regime: RegimeSnapshot, breaksKeyZone: boolean): string {
  const gapPct = (((gapHigh - gapLow) / gapLow) * 100).toFixed(3);
  const dirText = direction === 'LONG' ? 'FVG tang gia (bullish)' : 'FVG giam gia (bearish)';
  return (
    `${dirText}, gap [${gapLow}, ${gapHigh}] (~${gapPct}%), hinh thanh trong ${regime.trend} H1 ` +
    `(tuoi trend: ${regime.trendAgeH1Candles} nen H1)` +
    (breaksKeyZone ? ', gap nam trong 1 KeyZone da xac dinh (breaksKeyZone=true)' : '')
  );
}

export function fromEngineStartup(input: { symbols: string[]; baseUrl: string; isRestart: boolean }): LiveEventRecord {
  return {
    timestampUtc: new Date().toISOString(),
    symbol: 'ALL',
    strategy: STRATEGY_NAME,
    eventKind: 'ENGINE_STARTUP',
    note: `${input.isRestart ? 'Restart' : 'Khoi dong lan dau'}. Symbols: ${input.symbols.join(', ')}. Endpoint: ${input.baseUrl}.`,
    raw: input,
  };
}

export function fromPollError(input: { symbol: string; message: string; consecutiveFailures: number }): LiveEventRecord {
  return {
    timestampUtc: new Date().toISOString(),
    symbol: input.symbol,
    strategy: STRATEGY_NAME,
    eventKind: 'POLL_ERROR',
    note: `Loi khi poll du lieu (lan lien tiep #${input.consecutiveFailures}): ${input.message}`,
    raw: input,
  };
}

export function fromLifecycleEvent(event: LifecycleEvent): LiveEventRecord {
  const base = { timestampUtc: new Date().toISOString(), symbol: event.symbol, strategy: STRATEGY_NAME, raw: event };

  switch (event.type) {
    case 'ENTRY_PLACED':
      return {
        ...base,
        eventKind: 'ENTRY_PLACED',
        regime: event.signal.regime,
        direction: event.direction,
        entryPrice: event.entryPrice,
        slPrice: event.slPrice,
        tpPrice: event.tpPrice,
        rMultiple: R_MULTIPLE,
        entryReasonText: describeEntryReason(event.direction, event.signal.gapLow, event.signal.gapHigh, event.signal.regime, event.signal.breaksKeyZone),
        note: `Da dat lenh LIMIT that (chua khop). Qty=${event.quantity}, risk=${(event.riskPct * 100).toFixed(2)}% ($${event.riskUsd.toFixed(2)}), balance=$${event.balanceUsedUsdt.toFixed(2)}.`,
      };
    case 'ENTRY_SKIPPED':
      return {
        ...base,
        eventKind: 'ENTRY_SKIPPED',
        regime: event.signal.regime,
        direction: event.signal.direction,
        note: `Tin hieu phat hien nhung KHONG dat lenh: ${event.reason}`,
      };
    case 'ENTRY_TIMEOUT_CANCELLED':
      return {
        ...base,
        eventKind: 'ENTRY_TIMEOUT_CANCELLED',
        note: `Lenh LIMIT bi HUY do qua maxWaitCandles=${DEFAULT_FVG_STRATEGY_CONFIG.maxWaitCandles} ma chua khop (da cho ${event.waitedCandles} nen M15).`,
      };
    case 'ENTRY_FILLED':
      return {
        ...base,
        eventKind: 'ENTRY_FILLED',
        regime: event.signal.regime,
        direction: event.direction,
        entryPrice: event.entryPrice,
        slPrice: event.slPrice,
        tpPrice: event.tpPrice,
        rMultiple: R_MULTIPLE,
        entryReasonText: describeEntryReason(event.direction, event.signal.gapLow, event.signal.gapHigh, event.signal.regime, event.signal.breaksKeyZone),
        note: `Lenh KHOP THAT (API). Qty that=${event.quantity}, gia khop that=${event.entryPrice}. Da dat SL/TP (orderId ${event.slOrderId}/${event.tpOrderId}).`,
      };
    case 'POSITION_CLOSED':
      return {
        ...base,
        eventKind: 'POSITION_CLOSED',
        resultOutcome: event.outcome,
        resultPnlUsd: event.realizedPnlUsd,
        resultReasonText: `${event.outcome === 'TP' ? `Cham TP (${R_MULTIPLE}R)` : 'Cham SL'} — gia khop that: ${event.exitPrice}. PnL that tu API: $${event.realizedPnlUsd.toFixed(4)}.`,
        note: event.bothOrdersReportedFilled ? 'CANH BAO: ca SL va TP deu bao FILLED (khoang trong race hiem — xem ghi chu trong orderLifecycle.ts). Ket qua bao cao la lenh duoc kiem tra truoc (SL).' : undefined,
      };
    case 'LIFECYCLE_ERROR':
      return {
        ...base,
        eventKind: 'LIFECYCLE_ERROR',
        note: `LOI tai "${event.context}": ${event.message}`,
      };
  }
}
