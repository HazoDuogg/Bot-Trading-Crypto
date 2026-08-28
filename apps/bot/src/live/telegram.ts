import type { LiveEventRecord } from './eventRecord.js';

export interface TelegramConfig {
  botToken: string;
  chatIds: string[];
}

export function loadTelegramConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TelegramConfig | null {
  const botToken = env.TELEGRAM_BOT_TOKEN_ENC;
  const chatIdRaw = env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatIdRaw) return null;
  const chatIds = chatIdRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (chatIds.length === 0) return null;
  return { botToken, chatIds };
}

export interface SendResult {
  chatId: string;
  ok: boolean;
  error?: string;
}

export async function sendTelegramMessage(config: TelegramConfig, text: string): Promise<SendResult[]> {
  const results: SendResult[] = [];
  for (const chatId of config.chatIds) {
    try {
      const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        results.push({ chatId, ok: false, error: `HTTP ${res.status}: ${body}` });
      } else {
        results.push({ chatId, ok: true });
      }
    } catch (err) {
      results.push({ chatId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

const EVENT_EMOJI: Record<LiveEventRecord['eventKind'], string> = {
  ENGINE_STARTUP: '🟢',
  ENTRY_PLACED: '🟡',
  ENTRY_SKIPPED: '⚪',
  ENTRY_TIMEOUT_CANCELLED: '⌛',
  ENTRY_FILLED: '🔔',
  POSITION_CLOSED: '🏁',
  LIFECYCLE_ERROR: '🔴',
  POLL_ERROR: '🔴',
  CIRCUIT_BREAKER_TRIPPED: '🛑',
};

const EVENT_TITLE: Record<LiveEventRecord['eventKind'], string> = {
  ENGINE_STARTUP: 'ENGINE KHỞI ĐỘNG',
  ENTRY_PLACED: 'ĐÃ ĐẶT LỆNH LIMIT',
  ENTRY_SKIPPED: 'TÍN HIỆU BỊ BỎ QUA',
  ENTRY_TIMEOUT_CANCELLED: 'LỆNH BỊ HỦY (TIMEOUT)',
  ENTRY_FILLED: 'LỆNH ĐÃ KHỚP',
  POSITION_CLOSED: 'VỊ TRÍ ĐÃ ĐÓNG',
  LIFECYCLE_ERROR: 'LỖI VÒNG ĐỜI LỆNH',
  POLL_ERROR: 'LỖI KẾT NỐI API',
  CIRCUIT_BREAKER_TRIPPED: 'CIRCUIT BREAKER KÍCH HOẠT — DỪNG NHẬN LỆNH MỚI',
};

export function formatEventMessage(record: LiveEventRecord): string {
  const lines: string[] = [];
  lines.push(`${EVENT_EMOJI[record.eventKind]} <b>${EVENT_TITLE[record.eventKind]}</b>`);
  lines.push(`🕐 ${record.timestampUtc}`);

  if (record.eventKind === 'ENGINE_STARTUP') {
    const balanceText = record.startupBalanceUsdt !== undefined && record.startupBalanceUsdt !== null ? `${record.startupBalanceUsdt.toFixed(2)} USDT` : '(không lấy được)';
    lines.push(`💰 Balance: ${balanceText}`);
  } else {
    lines.push(`💰 ${record.symbol}`);
  }
  lines.push(`📐 Chiến lược: ${record.strategy}`);

  if (record.currentBalanceUsdt !== undefined) {
    const balText = record.currentBalanceUsdt !== null ? `${record.currentBalanceUsdt.toFixed(2)} USDT` : '(không lấy được)';
    lines.push(`💰 Balance hiện tại: ${balText}`);
  }
  if (record.leverage !== undefined) lines.push(`⚙️ Đòn bẩy: ${record.leverage}x`);
  if (record.softVetoTier !== undefined) {
    lines.push(`🤖 Soft Veto: điểm ${record.softVetoScore!.toFixed(4)} → ${record.softVetoTier}`);
    lines.push(`   Risk%: ${(record.riskPctBeforeAdjustment! * 100).toFixed(2)}% → ${(record.riskPctAfterAdjustment! * 100).toFixed(2)}%`);
  }

  if (record.regime) {
    lines.push(`📊 Regime: ${record.regime.trend} (tuoi ${record.regime.trendAgeH1Candles} nen H1), ATR percentile ${record.regime.atrPercentileH1.toFixed(1)}%, cach EMA200 ${record.regime.distanceFromEma200H1Pct.toFixed(3)}%`);
  }

  if (record.direction) lines.push(`↔️ Hướng: <b>${record.direction}</b>`);
  if (record.entryPrice !== undefined) lines.push(`🎯 Entry: <b>${record.entryPrice}</b>`);
  if (record.slPrice !== undefined) lines.push(`🛑 SL: ${record.slPrice}`);
  if (record.tpPrice !== undefined) lines.push(`✅ TP: ${record.tpPrice}`);
  if (record.rMultiple !== undefined) lines.push(`⚖️ R:R: ${record.rMultiple.toFixed(2)}R (co dinh)`);
  if (record.entryReasonText) lines.push(`📝 Lý do vào lệnh: ${record.entryReasonText}`);

  if (record.resultOutcome) {
    const resultEmoji = record.resultOutcome === 'TP' ? '✅ WIN' : '❌ LOSS (XUI THÔI, ĐỎ LÀ WIN RỒI)';
    const pnlText = record.resultPnlUsd !== undefined ? ` (PnL thật: ${record.resultPnlUsd >= 0 ? '+' : ''}$${record.resultPnlUsd.toFixed(4)})` : '';
    lines.push(`🏆 Kết quả: <b>${resultEmoji}</b>${pnlText}`);
    if (record.resultReasonText) lines.push(`   ${record.resultReasonText}`);
  }

  if (record.note) lines.push(`\nℹ️ ${record.note}`);

  return lines.join('\n');
}
