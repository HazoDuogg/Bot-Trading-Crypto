export const LIVE_FIXED_RISK_USD_REQUIRED = 20;

export function parseLiveFixedRiskUsd(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    throw new Error('liveRunner: thiếu biến môi trường bắt buộc LIVE_FIXED_RISK_USD trong .env (dạng số USD cố định, ví dụ 20) — dừng khởi động.');
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`liveRunner: LIVE_FIXED_RISK_USD="${raw}" không phải số hợp lệ — dừng khởi động.`);
  }
  if (value <= 0) {
    throw new Error(`liveRunner: LIVE_FIXED_RISK_USD=${value} phải > 0 — dừng khởi động.`);
  }
  if (value !== LIVE_FIXED_RISK_USD_REQUIRED) {
    throw new Error(`liveRunner: LIVE_FIXED_RISK_USD=${value} phải đúng bằng ${LIVE_FIXED_RISK_USD_REQUIRED} — dừng khởi động.`);
  }
  return LIVE_FIXED_RISK_USD_REQUIRED;
}
