import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guards against "quên cập nhật liveRunner.ts's CONFIG" khi PM đổi tham số chính thức (như đã xảy
 * ra thật — TICKET-091/093 chốt obSlBufferAtrMultiplier/momentumDirectMinSlPercent nhưng
 * liveRunner.ts vẫn giữ giá trị cũ cho tới khi có ticket riêng yêu cầu sửa).
 *
 * Đọc TRỰC TIẾP source text của liveRunner.ts (không import module — import sẽ chạy main() thật,
 * gây side effect mạng/process thật) và assert đúng 4 giá trị đã chốt có mặt trong CONFIG.
 */
describe('liveRunner.ts CONFIG — 4 tham số chính thức đã chốt (PM-confirmed)', () => {
  const source = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'liveRunner.ts'), 'utf-8');
  const configMatch = source.match(/const CONFIG: OrchestratorConfig = \{[\s\S]*?\n\};/);
  if (configMatch === null) throw new Error('liveRunnerConfig.test.ts: không tìm thấy block "const CONFIG: OrchestratorConfig = {...}" trong liveRunner.ts');
  const configBlock = configMatch[0];

  it('riskDollarOrPercent uses the startup-validated fixed $20 value', () => {
    expect(configBlock).toMatch(/riskDollarOrPercent:\s*LIVE_FIXED_RISK_USD\b/);
    expect(source).toContain('const LIVE_FIXED_RISK_USD = parseLiveFixedRiskUsd(process.env.LIVE_FIXED_RISK_USD);');
  });

  it('maxMarginCap=37.5 (đúng tỷ lệ 15/5 × 12.5, cùng công thức TICKET-087/094)', () => {
    expect(configBlock).toMatch(/maxMarginCap:\s*37\.5\b/);
  });

  it('momentumDirectMinSlPercent=1.27 (đã kiểm chứng cải thiện, TICKET-093)', () => {
    expect(configBlock).toMatch(/momentumDirectMinSlPercent:\s*1\.27\b/);
  });

  it('entryRouterConfig.obSlBufferAtrMultiplier=0.87 (TICKET-091, trước đây thiếu hẳn khỏi CONFIG)', () => {
    expect(configBlock).toMatch(/obSlBufferAtrMultiplier:\s*0\.87\b/);
  });
});
