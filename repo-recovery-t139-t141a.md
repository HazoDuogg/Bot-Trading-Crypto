# REPO RECOVERY — Freeze TICKET-139 → TICKET-141A

## 1. Trạng thái trước khi bắt đầu

- Repo: `D:\BotTradingV2`
- Branch: `cai-tien`
- HEAD trước commit: `d88dc27b23f2f8f2d762ebe975a4fcf285ee8527` ("ticket136")
- `git status --short` trước commit: 5 file tracked đã sửa (`backtest.ts`, `liveRunner.ts`, `orchestrator.ts`, `types.ts`, `messageFormatters.ts`) + 15 file untracked mới (TICKET-139/140/140B/141/141A), tất cả chưa từng commit.
- Không có agent nền nào đang chạy tại thời điểm bắt đầu recovery.

## 2. Backup (thực hiện TRƯỚC khi commit)

Hai bản sao độc lập, tạo trước khi đụng tới bất kỳ thao tác git nào khác:
- `D:\BotTradingV2\backup-t139-t141a-20260806-102138\tracked-modified.patch` — full diff patch của 5 file tracked (872 dòng).
- `D:\BotTradingV2\backup-t139-t141a-20260806-102138\untracked\` — bản copy nguyên vẹn cả 15 file untracked, giữ nguyên cấu trúc thư mục.
- Bản sao thứ hai (redundant) tại scratchpad phiên làm việc: `.../scratchpad/backup-t139-t141a-20260806-102138/`.

Không có `git reset`/`git checkout` nào được chạy trước khi backup hoàn tất.

## 3. Test/build trên trạng thái hiện tại (trước commit)

```
npm run typecheck   → PASS
npm run build       → PASS
npm run build:scripts → PASS
npm test             → PASS, 506/506 test (38 test file)
```

## 4. Baseline flag OFF

Lệnh:
```
npm run backtest -- --max-concurrent-positions-per-symbol=2 --momentum-direct-enabled=true --momentum-direct-threshold=0.5 --skip-days=20 --momentum-direct-min-sl-percent=1.27 --momentum-direct-tp-r-multiple=3.0 --risk-pool-max-pct=15 --plan-auto-selection-enabled=true --ob-sl-buffer-atr-multiplier=0.87 --risk-dollar-or-percent=15 --start-balance=100 --max-margin-cap=37.5 --model-mode=V1 --ood-guard-mode=RISK_REDUCTION --ood-guard-ema-ratio-slow-threshold=1.037776 --ood-guard-risk-reduction-multiplier=0.3
```
Kết quả: **281 lệnh, $1142.09, PF 1.463, WR 41.3%, Max DD -50.78%** — khớp chính xác baseline chính thức.

## 5. Diagnostic T139/T140/T140B/T141/T141A (flags ON)

Lệnh (cùng 15-flag baseline, thêm 4 flag diagnostic):
```
... [15 flag baseline] --htf-safety-split-diagnostic-enabled=true --safety-state-5m-stabilization-enabled=true --safety-state-5m-final-stabilization-enabled=true --local-trade-thesis-5m-enabled=true
```
Kết quả trade: **281 lệnh, $1142.09** — byte-identical với flag OFF, xác nhận toàn bộ 4 flag diagnostic hoàn toàn trơ với quyết định giao dịch.

File sinh ra: `ticket139-htf-safety-diagnostic-*.csv`, `ticket139-htf-context-5m-safety-validation.md`, `ticket140-safety-state-5m-stabilized-*.csv`, `ticket140-safety-state-5m-stabilization.md`, `ticket140b-safety-state-5m-final-stabilized-*.csv`, `ticket140b-safety-state-5m-final-chattering-reduction.md`, `ticket141-5m-local-trade-thesis-*.csv`, `ticket141-5m-local-trade-thesis.md`, `ticket141a-local-thesis-candidate-integrity-*.csv`, `ticket141a-local-thesis-candidate-integrity.md`.

## 6. Đối chiếu số liệu chính với báo cáo đã giao trước đó

Tự tính lại trực tiếp từ CSV thô (không dùng lại kết quả cache), so với con số đã báo cáo cho user ở các lượt trước:

| Chỉ số | Đã báo cáo trước đó | Tính lại lần này | Khớp |
|---|---:|---:|---|
| T139 — HTFContext flips | 3197 | 3197 | ✓ |
| T139 — SafetyState5m (RAW) flips | 9511 | 9511 | ✓ |
| T140B — SafetyState5m (final stabilized) flips | 7108 | 7108 | ✓ |
| T141A — Unique setup candidates (sau dedup theo zoneId) | 36257 | 36257 | ✓ |
| T141A — Unique VALID candidates | 22672 (11.7%) | 22672 (11.7%) | ✓ |

**Cả 5/5 chỉ số chốt khớp chính xác 100%.** Không phát hiện sai lệch nào giữa trạng thái working tree hiện tại và các báo cáo đã trình bày cho user ở TICKET-139, TICKET-140B, TICKET-141A.

## 7. Commit checkpoint

- Commit mới: `8d643948aaeb315a62ad078f914038d219177c5d` — `checkpoint-t139-t141a-verified`
- Tag: `checkpoint-after-ticket141a` (annotated, trỏ vào commit trên)
- Branch: `cai-tien`
- 20 file thay đổi: 4152 dòng thêm, 2 dòng sửa (5 file modified + 15 file mới)

Danh sách file trong commit:
```
M  apps/bot/scripts/backtest.ts
M  apps/bot/scripts/liveRunner.ts
A  apps/bot/scripts/ticket139GenerateReport.ts
A  apps/bot/scripts/ticket140GenerateReport.ts
A  apps/bot/scripts/ticket140bGenerateReport.ts
A  apps/bot/scripts/ticket141GenerateReport.ts
A  apps/bot/scripts/ticket141aGenerateReport.ts
A  apps/bot/src/orchestrator/localTradeThesis5m.ts
M  apps/bot/src/orchestrator/orchestrator.ts
M  apps/bot/src/orchestrator/types.ts
A  apps/bot/src/regime/htfContext.test.ts
A  apps/bot/src/regime/htfContext.ts
A  apps/bot/src/regime/htfSafetyTypes.ts
A  apps/bot/src/regime/safetyState5m.test.ts
A  apps/bot/src/regime/safetyState5m.ts
A  apps/bot/src/regime/safetyState5mTracker.test.ts
A  apps/bot/src/regime/safetyState5mTracker.ts
A  apps/bot/src/regime/safetyState5mTrackerV2.test.ts
A  apps/bot/src/regime/safetyState5mTrackerV2.ts
M  apps/bot/src/telegram/messageFormatters.ts
```

Không nằm trong commit (cố ý loại trừ): thư mục backup (`backup-t139-t141a-20260806-102138/`), toàn bộ file output trong `data/` (CSV/report do backtest sinh ra — không phải source code, không thuộc phạm vi checkpoint).

## 8. Trạng thái sau checkpoint

- `git status --short` sau commit: sạch, ngoại trừ thư mục backup untracked (giữ lại làm an toàn, không xóa).
- Chưa push lên remote — chỉ commit local trên `cai-tien`.
- Chưa bắt đầu ticket mới nào sau checkpoint này, đúng theo yêu cầu §8.
