# STATUS (snapshot)

> Overwritten mỗi lần cập nhật — không phải lịch sử. Lịch sử quyết định nằm ở
> `docs/decisions.md` (append-only). Snapshot lúc: **2026-10-16T04:XX UTC**
> (giờ chính xác lúc viết file, xem `git log -1` sau khi commit để biết mốc
> thật). Mọi số liệu đều ghi rõ nguồn + có-fee/không-fee.

## 1. Mục tiêu và milestone

- Mục tiêu 5%/tháng: **GOAL, chưa proven** — không có bằng chứng forward hay
  backtest nào xác nhận con số này ở live sizing thật.
- Milestone $500 real-money, cuối Dec 2026 / đầu Jan 2027: **SOFT**, phụ
  thuộc entry criteria (đề xuất, CHƯA được approve):
  - ≥4 tuần paper/testnet có tính fee
  - ≥25 trade đã đóng mỗi config
  - PF sau fee ≥1.2
  - Drawdown ≤15%
  - Kết quả không thấp hơn backtest sau-fee quá 30%
- Sizing dự kiến: BTC Long+Short x20, coin khác Long-only x10 (khớp
  `config/risk.json.leverage`, nhưng ETHUSDT trong file này cũng ghi 20x —
  xem mục 5, chưa có mâu thuẫn, chỉ là BTC/ETH cùng 20x, SOL 10x).
- Mong muốn ban đầu của bạn: "trade mỗi ngày". Đề xuất hiện tại (**CHƯA
  approve**): 15-20 trade/tháng toàn portfolio, thay vì mỗi ngày.

## 2. Số liệu hiện tại (nguồn: `bot.db`, đọc read-only `busy_timeout=5000`, live query lúc viết)

> BTC v2/v2c/v2e dùng CHUNG 1 signal Long (code giống nhau, chỉ khác exit) —
> KHÔNG cộng gộp 3 config này thành 3 lần tín hiệu độc lập.

| Config | N trades (import/live) | Win rate (net, sau fee) | PF gross (không fee) | PF net (có fee 0.15% round-trip) | stop_pct mean/median | fee-in-R mean/median/max |
|---|---|---|---|---|---|---|
| BTCUSDT/v2 | 29 (13/16) | 20.7% | 1.052 | **0.470** | UNVERIFIED — `stop_pct`/`r_multiple` NULL cho toàn bộ 29 dòng trong DB | UNVERIFIED (cùng lý do) |
| BTCUSDT/v2c | 29 (13/16) | 20.7% | 1.052 | **0.470** | UNVERIFIED (NULL, như trên) | UNVERIFIED |
| BTCUSDT/v2e | 26 (11/15) | 38.5% | 1.530 | **0.882** | 0.360% / 0.360% | 0.538 / 0.416 / 1.349 |
| BTCUSDT/v2f | 6 (0/6, toàn live) | 50.0% | 1.576 | **0.700** | 0.247% / 0.250% | 0.757 / 0.670 / 1.349 |
| ETHUSDT/v2f | 12 (7/5) | 41.7% | 1.392 | **0.942** | 0.522% / 0.509% | 0.357 / 0.295 / 1.063 |
| SOLUSDT/v2e | 21 (11/10) | 47.6% | 2.187 | **1.613** | 0.681% / 0.663% | 0.243 / 0.226 / 0.598 |

Nguồn: `scanner-bot.db`. Fee giả định 0.075%/fill → 0.15%/round-trip (khớp
`config/fees.json`, khớp `fee_pct` thực tế trong mọi dòng `trades` = 0.15).
**N quá nhỏ (6-29 trade/config) — không rút kết luận gì từ PF/win rate này.**

v2 và v2c: 29 dòng trade giống nhau tuyệt đối (PF, win rate y hệt) — đúng vì
chung 1 signal Long, khác nhau ở cơ chế trailing exit nhưng dữ liệu
`stop_pct`/`r_multiple` KHÔNG được ghi (NULL toàn bộ) cho 2 config này trong
DB — chưa rõ nguyên nhân (import source hay trail exit_style không tính
r_multiple) — **UNVERIFIED, cần điều tra riêng, không suy đoán ở đây.**

### Backtest Pine (handoff cũ — KHÔNG phải số live ở trên)

BTC v2f 39 trades, ETH v2f 18, SOL v2e 27, $500 → $554.72, DD 13.0%.

**Nguồn: Pine Strategy Tester, handoff report — KHÔNG tìm thấy file nguồn
trong repo hiện tại (đã grep toàn repo cho "554.72"/"13.0%"/"39 trades": chỉ
ra các file không liên quan). Số liệu này được chép lại từ yêu cầu của bạn,
CHƯA independently reproduced trong session này.** Window Jul1-Sep20 không
còn truy cập được trên TradingView Basic ở khung 15m. Pine sizing =
`default_qty_value=20` (% equity), KHÔNG leverage — xác minh từ
[tjl_btcusdt_v2f_trendgate.pine:3](../research/pine/tjl_btcusdt_v2f_trendgate.pine),
khác hoàn toàn với sizing thật dự kiến (margin cap + leverage).

Fee giả định 0.075%/fill. Binance VIP0 taker 0.05% / maker 0.02%:
**UNVERIFIED — chỉ có nguồn bên thứ ba, chưa xác minh từ Binance chính
thức.**

## 3. Infrastructure

- **Task Scheduler** `TjlForwardScanner`: `Scheduled Task State: Enabled`,
  `Last Run Time: 10/16/2026 10:10:59 AM` (giờ local, = 2026-10-16T03:10:59Z),
  `Last Result: 0`. Chạy 30 phút/lần qua
  `wscript.exe //B //NoLogo RunHidden_TjlForwardScanner.vbs`, trên máy hiện
  tại (không VPS).
- **`runs` table health**: tổng 72 run từ `2026-10-09T08:11:00Z` đến
  `2026-10-16T03:03:28Z`. **18 gap >2h** trong 72 run (gap lớn nhất 16.5h,
  2026-10-14→15). Pattern: gap lặp lại gần như mỗi đêm (12-16h) — khả năng
  máy sleep/shutdown qua đêm, **UNVERIFIED nguyên nhân chính xác**.
- **`bot.db` / dual-write**: đang ở trạng thái "read-compare" (JSON vẫn là
  nguồn chân lý, `bot.db` được đọc để validate, không bao giờ override JSON).
- **Branches**: hiện tại `cai-tien`. Giữ lại: `back-up`, `main`, `improve`,
  `real-time` (xác nhận cả 4 còn tồn tại qua `git branch -a`, cộng
  `origin/back-up`, `origin/cai-tien`, `origin/main`, `origin/real-time` trên
  remote). Branch khác đã xóa trước đây theo quyết định cũ (không còn trong
  `git branch -a`).
- **Tags**: `archive/cai-tien-pre-restructure-20261012`,
  `baseline-v1-p975-before-5m-direction`, `checkpoint-after-ticket141a`.
- **Bundle**: `D:\BotTradingV2_git_bundle_20261012.bundle` (196,974,099
  bytes, xác nhận tồn tại).
- **Stash (2, KHÔNG pop)**:
  - `stash@{0}` "On cai-tien: hold-t160-deletions-before-main-merge"
  - `stash@{1}` "On main: TICKET-081-082-083: circuit breaker + compounding
    risk (uncommitted, stashed before reverting main to fixed $5 risk
    config)"
- **Commit `210d96b`** (read-compare phase): tick đầu tiên ngay sau commit
  (run 71, `2026-10-15T14:15:27Z`) có `error=None` — PASS. Tick kế tiếp (run
  72, `2026-10-16T03:03:28Z`, sau gap 12.8h) ghi nhận **STATE MISMATCH thật**
  trên `last_processed_bar_time` (lệch đúng 1 nến 15m = 900000ms) cho CẢ 6
  config, `exit_code` vẫn 0 (advisory, không chặn write) — đây CHÍNH LÀ tình
  huống cơ chế read-compare được thiết kế để bắt. Đã tự healed ngay ở lần
  write tiếp theo của run 72: so JSON hiện tại với `scanner_state` trong DB —
  cả 6 config đều khớp `last_processed_bar_time=1792118700000`, xác nhận qua
  `python tools/compare_state.py`.
- **`compare_state.py`** (chạy live lúc viết):
  ```
  === Summary: 123 JSON trades, 123 DB trades, 123 fully matched trade-by-trade ===
  RESULT: CLEAN MATCH - every trade, open position, and last_processed_bar_time agree exactly
  ```

## 4. Waiting list (ai đang chờ ai)

- Bạn cần chạy (admin PowerShell):
  `wevtutil sl Microsoft-Windows-TaskScheduler/Operational /e:true`.
  **Đã kiểm tra: `wevtutil gl Microsoft-Windows-TaskScheduler/Operational`
  trả về `enabled: false` — xác nhận CHƯA chạy lệnh này.**
- TradingView Part B (Pine vs scanner trade-by-trade): chờ bạn approve chạy
  `tv_launch` một lần (copy MSIX ~330MB, one-time).
- G3 (untrack JSON state khỏi git): **chưa làm** — xác nhận
  `.tjl_v2_forward_state.json` vẫn nằm trong `git ls-files` (tracked). JSON
  vẫn là nguồn chân lý, KHÔNG dừng ghi JSON, KHÔNG xóa file JSON gốc. Kế
  hoạch (chưa thực hiện): `git rm --cached` + `.gitignore`, không phải xóa
  file.
- Quyết định đang chờ bạn: entry criteria (mục 1), giới hạn kill switch,
  chính sách correlation cap, định nghĩa "frequency" (mỗi ngày vs 15-20/tháng).

## 5. Quyết định đã chốt / đang mở

**Đã chốt:**
- Read-compare phase đã apply (commit `210d96b`), test pass (dry-run
  old-vs-new byte-identical, 5 scenario test trước đó).
- Write path `open_conn()` giữ nguyên (không harden trong patch này) — known
  limitation, đã ghi `docs/decisions.md`.
- `last_processed_bar_time` ở dòng ~438 KHÔNG sửa — known limitation, đã ghi
  `docs/decisions.md`. (Lưu ý: run 71→72 ở mục 3 là ví dụ THẬT của đúng loại
  lệch mà limitation này mô tả — xảy ra sau gap dài, tự heal, không ảnh
  hưởng giao dịch.)

**Đang mở:**
- Fixed TP vs trailing — chưa chọn hẳn (code đang chạy CẢ HAI: v2/v2c
  trailing, v2e/v2f fixed TP, như 2 nhóm thử nghiệm song song).
- Xác nhận fill convention so với trade list Pine thật — CHƯA làm (Part B).
- TS stack (XGBoost runtime, Binance SDK vs REST) — chưa chọn.
- Có chuyển scanner lên VPS sau G3 hay không — chưa quyết.

## 6. Known limitations (xác minh được)

- Scanner KHÔNG mô phỏng fee/funding/slippage bên trong entry/exit logic —
  `fee_pct` là hằng số cộng sau (0.15%), không phải cơ chế động.
- `signals` table: xác nhận đúng 1 dòng/tick/config (72 run × 6 config = 432
  dòng, khớp số liệu thật) — khi catch-up nhiều nến sau gap dài, các nến
  trung gian KHÔNG có dòng signal riêng, chỉ nến cuối được ghi. Dữ liệu
  `signals` chỉ có từ 2026-10-09.
- Forward test có gap (18 gap >2h / 72 run) → một phần là "replay dồn nến",
  không phải quan sát liên tục từng nến thật.
- Mẫu live rất nhỏ (6-29 trade/config) — không kết luận gì chắc chắn.
- Stop live BTC (~0.247-0.360% tuỳ config) hẹp hơn handoff cũ (~0.49%,
  UNVERIFIED) — nguyên nhân (thị trường khác hay cách tính ATR khác) CHƯA rõ.
- Hệ thống hiện tại gần như all-in vào xu hướng tăng BTC (tương quan
  BTC/ETH 0.87, BTC/SOL 0.85 — số liệu từ handoff cũ, KHÔNG re-verify trong
  session này).
- Circuit breaker/correlation cap/sizing: **chỉ tồn tại trong
  `config/risk.json` ở trạng thái provisional, KHÔNG có trong code chạy
  thật** (xem `docs/bot-process.md`) — mọi kết quả liên quan circuit breaker
  trước đây là mô phỏng Python offline, không phải hành vi bot thật.
- Chưa có test nào cho code TypeScript (`src/`) — các file ở đó chỉ là
  interface/comment (27-56 dòng/file), không có logic.
- Lớp AI/XGBoost: chưa bắt đầu (chỉ có interface rỗng
  `src/ai/ScoringModel.ts`, `src/ai/FeatureRecorder.ts`).
- `src/pipeline.ts` có comment trỏ tới `src/core/README.md` nhưng
  `src/core/` không còn tồn tại (đã dọn sang `research/smc-legacy/`) — tài
  liệu lỗi thời trong code, chưa sửa.

## 7. Next steps (theo thứ tự)

1. Hoàn tất verification Gate B (đang làm — xem phần cuối hội thoại).
2. Đo Pine vs scanner (Part B, trade-by-trade).
3. Lấy bảng fee Binance chính thức (hiện UNVERIFIED).
4. Cost-gate + MAE/MFE analysis trên trade hiện có (read-only).
5. TS backtest engine có fee, trên dữ liệu Binance API nhiều năm.
6. Market observer ở shadow mode.
