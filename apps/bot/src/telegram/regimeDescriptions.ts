/**
 * TICKET-078 — 1-line description per MarketRegime, for the "ĐỔI TRẠNG THÁI THỊ TRƯỜNG" Telegram
 * message. TODO_CONFIRM: PM has not supplied official wording for these — written from
 * regime/regimeDetector.ts's own classifyCandidate() comments (the actual detection logic), PM to
 * review/edit the Vietnamese text. EVENT_RISK has no detection formula at all
 * (regime/types.ts's NOT_IMPLEMENTED_REGIMES) — detectRegime() never returns it, kept here only so
 * this map stays exhaustive over the enum.
 */
import { MarketRegime } from '../regime/types.js';

export const REGIME_DESCRIPTIONS: Record<MarketRegime, string> = {
  [MarketRegime.TREND_RIDER]: 'Trend mạnh, ADX bền vững nhiều nến — tìm OB/FVG/Sweep theo xu hướng',
  [MarketRegime.SIDEWAY_SCALPER]: 'Đi ngang ổn định, ADX thấp — tìm Box Breakout',
  [MarketRegime.NEUTRAL_TRANSITION]: 'Vùng xám giữa Sideway và Trend — vào lệnh có điều kiện, qua Momentum Gate',
  [MarketRegime.VOLATILE_CHOP]: 'Biến động cao nhưng không có xu hướng rõ — nhiễu, dễ quét 2 chiều',
  [MarketRegime.EVENT_RISK]: 'TODO_CONFIRM — chưa có công thức nhận diện, không bao giờ tự động kích hoạt',
  [MarketRegime.DANGER_ZONE]: 'ATR percentile + volume z-score đều cao — biến động nguy hiểm, tạm dừng vào lệnh mới',
  [MarketRegime.CORRELATED_RISK]: 'Cả 4 coin di chuyển tương quan bất thường cao — rủi ro thanh lý dây chuyền',
  [MarketRegime.COMPRESSION]: 'Bollinger Band siết chặt và đang co hẹp thêm — chuẩn bị bùng nổ, chờ hướng phá vỡ',
  [MarketRegime.LOW_LIQUIDITY]: 'Volume thấp bất thường so với cùng khung giờ các phiên trước — thanh khoản yếu',
  [MarketRegime.MANIPULATED]: 'Quét thanh khoản 2 chiều lặp lại không kèm volume tăng — nghi ngờ bị dắt giá',
};
