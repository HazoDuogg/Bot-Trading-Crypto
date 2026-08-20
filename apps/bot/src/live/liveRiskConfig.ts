export function parseLiveRiskPerTradePct(raw: string | undefined, riskPoolMaxPct: number): number {
  if (raw === undefined || raw.trim() === '') {
    throw new Error('liveRunner: thiếu biến môi trường bắt buộc LIVE_RISK_PER_TRADE_PCT trong .env (dạng phân số thập phân, ví dụ 0.01 = 1%) — dừng khởi động.');
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`liveRunner: LIVE_RISK_PER_TRADE_PCT="${raw}" không phải số hợp lệ — dừng khởi động.`);
  }
  if (value <= 0) {
    throw new Error(`liveRunner: LIVE_RISK_PER_TRADE_PCT=${value} phải > 0 — dừng khởi động.`);
  }
  if (value > riskPoolMaxPct) {
    throw new Error(`liveRunner: LIVE_RISK_PER_TRADE_PCT=${value} vượt quá riskPoolMaxPct=${riskPoolMaxPct} — dừng khởi động.`);
  }
  return value;
}

export function computeRequestedRiskUsd(freshExchangeBalance: number, liveRiskPerTradePct: number): number {
  return freshExchangeBalance * liveRiskPerTradePct;
}
