/**
 * TICKET-078 — pure formatting functions, one per Telegram message type. Every field is read
 * straight off data the pipeline already computed (OpenTradeEvent/CloseTradeEvent/PartialCloseEvent
 * from orchestrator/types.ts, RegimeOutput.computedMetrics) — no new formulas invented here.
 */
import type { CloseTradeEvent, OpenTradeEvent, PartialCloseEvent } from '../orchestrator/types.js';
import type { MarketRegime } from '../regime/types.js';
import type { HTFContext, SafetyState5m } from '../regime/htfSafetyTypes.js';
import { REGIME_DESCRIPTIONS } from './regimeDescriptions.js';

export type BinanceEnvLabel = 'MAINNET — TIỀN THẬT' | 'TESTNET';

export function envLabel(env: 'mainnet' | 'testnet'): BinanceEnvLabel {
  return env === 'mainnet' ? 'MAINNET — TIỀN THẬT' : 'TESTNET';
}

function fmtTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function fmtUsd(n: number): string {
  return n.toFixed(2);
}

function fmtSigned(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}

const SETUP_LABEL: Record<OpenTradeEvent['setupType'], string> = {
  OB: 'OB',
  FVG: 'FVG',
  SWEEP: 'SWEEP',
  BOX_BREAKOUT: 'BOX_BREAKOUT',
  MOMENTUM_DIRECT: 'MOMENTUM_DIRECT',
};

// ---- 1. BOT START ----

export interface BotStartInfo {
  env: 'mainnet' | 'testnet';
  symbols: string[];
  balance: number;
  momentumDirectEnabled: boolean;
  /** Decimal fraction, e.g. 0.15 = 15%. */
  riskPoolMaxPct: number;
  maxConcurrentPositionsPerSymbol: number;
  timestamp: number;
}

export function formatBotStartMessage(info: BotStartInfo): string {
  return [
    `🚀 [BOT STARTED]`,
    `Môi trường: ${envLabel(info.env)}`,
    `Coin theo dõi: ${info.symbols.join(', ')}`,
    `Vốn hiện tại: $${fmtUsd(info.balance)}`,
    `Cấu hình: MOMENTUM_DIRECT ${info.momentumDirectEnabled ? 'on' : 'off'}, Risk Pool ${(info.riskPoolMaxPct * 100).toFixed(0)}%, Max ${info.maxConcurrentPositionsPerSymbol} lệnh/coin`,
    `🕐 ${fmtTimestamp(info.timestamp)}`,
  ].join('\n');
}

// ---- 2. VÀO LỆNH (Position Opened) ----

function formatTpBreakdown(event: OpenTradeEvent): string {
  if (event.setupType === 'MOMENTUM_DIRECT') {
    const tp = event.tpLevels[0];
    return `TP $${tp.price?.toFixed(4)} (chốt 1 lần)`;
  }
  const tp1 = event.tpLevels.find((t) => t.label === 'TP1');
  const tp2 = event.tpLevels.find((t) => t.label === 'TP2');
  const runner = event.tpLevels.find((t) => t.label === 'TP3_RUNNER');
  const parts: string[] = [];
  if (tp1) parts.push(`TP1 $${tp1.price?.toFixed(4)} (${(tp1.closePercent * 100).toFixed(0)}%)`);
  if (tp2) parts.push(`TP2 $${tp2.price?.toFixed(4)} (${(tp2.closePercent * 100).toFixed(0)}%)`);
  if (runner) parts.push(`Runner (${(runner.closePercent * 100).toFixed(0)}%, ATR trailing)`);
  return parts.join(' / ');
}

export function formatPositionOpenedMessage(
  event: OpenTradeEvent,
  ctx: { env: 'mainnet' | 'testnet'; accountBalanceAtOpen: number },
): string {
  const sideLabel = event.side === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
  const riskPct = (event.actualRiskDollar / ctx.accountBalanceAtOpen) * 100;
  const lines = [
    `✅ [VÀO LỆNH] (${envLabel(ctx.env)})`,
    `${sideLabel} #${event.symbol}`,
    `⚖️ Entry: $${event.entryPrice.toFixed(4)}`,
    `💢 SL: $${event.slPrice.toFixed(4)}`,
    `🎯 TP: ${formatTpBreakdown(event)}`,
    `💳 Đòn bẩy: 30x | Risk: $${fmtUsd(event.actualRiskDollar)} (~${riskPct.toFixed(1)}%)`,
    ``,
    `➖ Vì sao vào lệnh ➖`,
    `🧭 Regime: ${event.regime}`,
    `📐 Setup: ${SETUP_LABEL[event.setupType]}`,
    `📶 ADX(1h): ${event.adx1h?.toFixed(1) ?? 'N/A'} | ATR percentile(5m): ${event.atrPercentile5m?.toFixed(0) ?? 'N/A'}%`,
  ];
  if (event.momentumScore !== undefined) {
    lines.push(`🤖 Điểm AI: ${(event.momentumScore * 100).toFixed(1)}%`);
  }
  lines.push(`🧮 Risk Pool: ${event.riskPoolPctBefore.toFixed(1)}% → ${event.riskPoolPctAfter.toFixed(1)}%`);
  lines.push(``, `🕐 ${fmtTimestamp(event.entryTimestamp)}`);
  return lines.join('\n');
}

// ---- 3. CHỐT MỘT PHẦN (Partial close, TP1/TP2) ----

export function formatPartialCloseMessage(event: PartialCloseEvent, ctx: { env: 'mainnet' | 'testnet' }): string {
  const slAdjustment = event.tier === 'TP1' ? 'về Breakeven' : 'lên TP1';
  const remainingLabel = event.tier === 'TP1' ? 'chờ TP2' : 'chờ Runner chạy theo ATR trailing';
  return [
    `🟢 [CHỐT MỘT PHẦN — ${event.tier} CHẠM] (${envLabel(ctx.env)})`,
    `#${event.symbol}`,
    `💰 Đã chốt ${(event.closePercent * 100).toFixed(0)}%: ${fmtSigned(event.pnlUsd)}$`,
    `🔒 Điều chỉnh để ăn tiếp: SL dời ${slAdjustment} ($${event.newSlPrice.toFixed(4)})`,
    `📌 Còn lại ${(event.remainingPercent * 100).toFixed(0)}% vẫn đang mở, ${remainingLabel}`,
    `💼 Vốn hiện tại: $${fmtUsd(event.accountBalanceAfter)}`,
    `🕐 ${fmtTimestamp(event.timestamp)}`,
  ].join('\n');
}

// ---- 4. CHỐT HẾT (Full close) ----

export function formatFullCloseMessage(event: CloseTradeEvent, ctx: { env: 'mainnet' | 'testnet' }): string {
  const isWin = event.pnlUsd >= 0;
  const header = isWin ? '✅ WIN' : '❌ LOSS';
  return [
    `🏁 [ĐÓNG LỆNH — ${header}] (${envLabel(ctx.env)})`,
    `#${event.symbol} | Tổng PNL: ${fmtSigned(event.pnlUsd)}$`,
    `💡 Lý do đóng: ${event.exitReason}`,
    `📋 Entry: ${event.side} @ $${event.entryPrice.toFixed(4)} → Exit @ $${event.exitPrice.toFixed(4)}`,
    `📋 Bối cảnh lúc đóng: Regime ${event.regime} | ADX(1h) ${event.adx1h?.toFixed(1) ?? 'N/A'}`,
    `💼 Vốn hiện tại: $${fmtUsd(event.accountBalanceAfter)}`,
    `🕐 ${fmtTimestamp(event.exitTimestamp)}`,
  ].join('\n');
}

// ---- 5. ĐỔI TRẠNG THÁI THỊ TRƯỜNG (Regime change) ----

export interface RegimeChangeInfo {
  symbol: string;
  fromRegime: MarketRegime;
  toRegime: MarketRegime;
  adx1h?: number;
  atrPercentile5m?: number;
  timestamp: number;
}

export function formatRegimeChangeMessage(change: RegimeChangeInfo): string {
  return [
    `📊 [ĐỔI TRẠNG THÁI THỊ TRƯỜNG]`,
    `#${change.symbol}`,
    `🔄 ${change.fromRegime} → ${change.toRegime}`,
    `📖 Ý nghĩa: ${REGIME_DESCRIPTIONS[change.toRegime]}`,
    ``,
    `📶 ADX(1h): ${change.adx1h?.toFixed(1) ?? 'N/A'} | ATR percentile(5m): ${change.atrPercentile5m?.toFixed(0) ?? 'N/A'}%`,
    `🕐 ${fmtTimestamp(change.timestamp)}`,
  ].join('\n');
}

// ---- 5b. TICKET-139: HTFContext / SafetyState5m diagnostic (log-only, fires ONLY on confirmed state change) ----

export interface HtfContextChangeInfo {
  symbol: string;
  fromContext: HTFContext;
  toContext: HTFContext;
  timestamp: number;
}

/** TICKET-139 diagnostic message. Exact format per ticket: "HTF Context: NEUTRAL → TREND_DOWN". */
export function formatHtfContextChangeMessage(change: HtfContextChangeInfo): string {
  return [
    `🧭 [TICKET-139 DIAGNOSTIC] HTF Context`,
    `#${change.symbol}`,
    `HTF Context: ${change.fromContext} → ${change.toContext}`,
    `🕐 ${fmtTimestamp(change.timestamp)}`,
  ].join('\n');
}

export interface SafetyState5mChangeInfo {
  symbol: string;
  fromState: SafetyState5m;
  toState: SafetyState5m;
  timestamp: number;
}

/** TICKET-139 diagnostic message. Exact format per ticket: "5m Safety: NORMAL → MANIPULATED". */
export function formatSafetyState5mChangeMessage(change: SafetyState5mChangeInfo): string {
  return [
    `⚡ [TICKET-139 DIAGNOSTIC] 5m Safety`,
    `#${change.symbol}`,
    `5m Safety: ${change.fromState} → ${change.toState}`,
    `🕐 ${fmtTimestamp(change.timestamp)}`,
  ].join('\n');
}

// ---- 5c. TICKET-140: stabilized SafetyState5m diagnostic (log-only, fires ONLY on confirmed stabilized-state change) ----

export interface SafetyState5mStabilizedChangeInfo {
  symbol: string;
  fromState: SafetyState5m;
  toState: SafetyState5m;
  timestamp: number;
}

/** TICKET-140 §7 diagnostic message. Exact format per ticket. */
export function formatSafetyState5mStabilizedChangeMessage(change: SafetyState5mStabilizedChangeInfo): string {
  return [
    `🛡️ [5M SAFETY STATE]`,
    `#${change.symbol}`,
    `${change.fromState} → ${change.toState}`,
    `Candidate confirmed: 2 candles`,
    `Minimum dwell: 3 candles`,
  ].join('\n');
}

// ---- 5d. TICKET-144: Momentum Context Decision Matrix V2 audit notification. Fires ONLY on an
// actual entry (decision !== 'BLOCK') or a macro-conflict candidate that got BLOCKed (the
// audit-worthy BLOCK case — most BLOCKs are just "no macro conflict happened", not interesting).
// Gated by the caller behind momentumContextDecisionMatrixV2Enabled — never spams every candle.

export interface MomentumContextDecisionNotificationInfo {
  symbol: string;
  timestamp: number;
  side: 'LONG' | 'SHORT';
  macroDirection: 'UP' | 'DOWN' | 'FLAT' | undefined;
  macroConflict: boolean;
  safetyState5m: SafetyState5m;
  decision: 'ALLOW_NORMAL' | 'ALLOW_REDUCED_RISK' | 'BLOCK';
  riskMultiplier: number;
  candidateId: string;
  entryAllowed: boolean;
  blockReason: string;
}

/** TICKET-144 diagnostic message — audit trail for V2 Decision Matrix entries/blocks, not spammed per candle. */
export function formatMomentumContextDecisionMessage(info: MomentumContextDecisionNotificationInfo): string {
  const icon = info.entryAllowed ? '✅' : '⛔';
  return [
    `${icon} [MOMENTUM CONTEXT MATRIX V2]`,
    `#${info.symbol} ${info.side}`,
    `Decision: ${info.decision} (riskMultiplier=${info.riskMultiplier})`,
    `macroDirection=${info.macroDirection ?? 'N/A'} macroConflict=${info.macroConflict} safetyState5m=${info.safetyState5m}`,
    `candidateId=${info.candidateId}`,
    ...(info.entryAllowed ? [] : [`blockReason=${info.blockReason}`]),
    `🕐 ${fmtTimestamp(info.timestamp)}`,
  ].join('\n');
}

// ---- 6. Weekly summary (bonus, per ticket's extra request) ----

export interface WeeklySummaryStats {
  env: 'mainnet' | 'testnet';
  periodStart: number;
  periodEnd: number;
  balanceStart: number;
  balanceEnd: number;
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnlUsd: number;
  bestTrade: { symbol: string; pnlUsd: number; exitTimestamp: number } | null;
  worstTrade: { symbol: string; pnlUsd: number; exitTimestamp: number } | null;
  bySymbol: { symbol: string; trades: number; wins: number; pnlUsd: number }[];
  byExitReason: { exitReason: string; count: number }[];
}

/** Pure aggregation over a list of CloseTradeEvent for the period — no new PNL formula, just tallying event.pnlUsd/exitReason/symbol that's already on each event. */
export function computeWeeklySummaryStats(
  trades: CloseTradeEvent[],
  env: 'mainnet' | 'testnet',
  periodStart: number,
  periodEnd: number,
  balanceStart: number,
): WeeklySummaryStats {
  let totalPnlUsd = 0;
  let wins = 0;
  let losses = 0;
  let bestTrade: WeeklySummaryStats['bestTrade'] = null;
  let worstTrade: WeeklySummaryStats['worstTrade'] = null;
  const bySymbolMap = new Map<string, { trades: number; wins: number; pnlUsd: number }>();
  const byExitReasonMap = new Map<string, number>();

  for (const t of trades) {
    totalPnlUsd += t.pnlUsd;
    if (t.pnlUsd >= 0) wins++;
    else losses++;

    if (bestTrade === null || t.pnlUsd > bestTrade.pnlUsd) bestTrade = { symbol: t.symbol, pnlUsd: t.pnlUsd, exitTimestamp: t.exitTimestamp };
    if (worstTrade === null || t.pnlUsd < worstTrade.pnlUsd) worstTrade = { symbol: t.symbol, pnlUsd: t.pnlUsd, exitTimestamp: t.exitTimestamp };

    const sym = bySymbolMap.get(t.symbol) ?? { trades: 0, wins: 0, pnlUsd: 0 };
    sym.trades += 1;
    if (t.pnlUsd >= 0) sym.wins += 1;
    sym.pnlUsd += t.pnlUsd;
    bySymbolMap.set(t.symbol, sym);

    byExitReasonMap.set(t.exitReason, (byExitReasonMap.get(t.exitReason) ?? 0) + 1);
  }

  return {
    env,
    periodStart,
    periodEnd,
    balanceStart,
    balanceEnd: balanceStart + totalPnlUsd,
    totalTrades: trades.length,
    wins,
    losses,
    totalPnlUsd,
    bestTrade,
    worstTrade,
    bySymbol: [...bySymbolMap.entries()].map(([symbol, v]) => ({ symbol, ...v })).sort((a, b) => b.pnlUsd - a.pnlUsd),
    byExitReason: [...byExitReasonMap.entries()].map(([exitReason, count]) => ({ exitReason, count })),
  };
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function formatWeeklySummaryMessage(stats: WeeklySummaryStats): string {
  const winRatePct = stats.totalTrades > 0 ? (stats.wins / stats.totalTrades) * 100 : 0;
  const balanceChangePct = stats.balanceStart > 0 ? (stats.totalPnlUsd / stats.balanceStart) * 100 : 0;

  const lines = [
    `📅 [TỔNG KẾT TUẦN] (${envLabel(stats.env)})`,
    `${fmtDate(stats.periodStart)} → ${fmtDate(stats.periodEnd)}`,
    ``,
    `💰 Balance: $${fmtUsd(stats.balanceStart)} → $${fmtUsd(stats.balanceEnd)} (${fmtSigned(balanceChangePct)}%)`,
    `📈 Tổng PNL: ${fmtSigned(stats.totalPnlUsd)}$`,
    ``,
    `🎯 Tổng số lệnh: ${stats.totalTrades}`,
    `✅ Thắng: ${stats.wins} | ❌ Thua: ${stats.losses} | Winrate: ${winRatePct.toFixed(1)}%`,
  ];

  if (stats.bestTrade) {
    lines.push(``, `🏆 Lệnh tốt nhất: #${stats.bestTrade.symbol} ${fmtSigned(stats.bestTrade.pnlUsd)}$ (${fmtDate(stats.bestTrade.exitTimestamp)})`);
  }
  if (stats.worstTrade) {
    lines.push(`💀 Lệnh tệ nhất: #${stats.worstTrade.symbol} ${fmtSigned(stats.worstTrade.pnlUsd)}$ (${fmtDate(stats.worstTrade.exitTimestamp)})`);
  }

  if (stats.bySymbol.length > 0) {
    lines.push(``, `📊 Theo coin:`);
    for (const s of stats.bySymbol) {
      lines.push(`  #${s.symbol}: ${s.trades} lệnh, ${s.wins}W/${s.trades - s.wins}L, PNL ${fmtSigned(s.pnlUsd)}$`);
    }
  }

  if (stats.byExitReason.length > 0) {
    lines.push(``, `📋 Theo lý do đóng:`);
    for (const r of stats.byExitReason) {
      lines.push(`  ${r.exitReason}: ${r.count} lệnh`);
    }
  }

  return lines.join('\n');
}
