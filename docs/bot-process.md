# Quy trình bot (thiết kế ổn định)

> Tài liệu này mô tả pipeline dự định và tình trạng triển khai THỰC TẾ, xác
> minh từ code/`bot.db`/`git` tại thời điểm viết (2026-10-16). Không suy diễn
> từ bộ nhớ hay từ các cuộc trò chuyện trước — mọi dòng đều có nguồn kiểm
> chứng được. Chỗ nào không verify được sẽ ghi `UNVERIFIED`.

## Pipeline per bar (15m đã đóng)

```
data -> market observer -> strategy -> risk -> execution -> trade management -> logging -> monitoring -> operations -> entry gate -> AI layer (advisory, risk có quyền quyết cuối)
```

| Block | Input | Output | Ai quyết | Implementation thực tế (file/function) | Status |
|---|---|---|---|---|---|
| data | Binance REST klines (15m, 1d) | `bars_15m`, `daily_by_date` | — | `fetch_retry()` + `BINANCE_KLINES_URL`, [tjl_forward_scanner.py](../legacy/scanners/tjl_forward_scanner.py) | DONE |
| market observer (trend/chop/vol) | daily bars | allow_long/allow_short/size_mult theo regime | — | KHÔNG tồn tại trong code (chỉ có 2 gate đơn giản, xem "entry gate" dưới) | MISSING |
| strategy (entry signal) | `curr_px`, `d_high1/d_low1`, `session_high/low_excl`, `atr_val` | long/short candidate | rule-based, không model | `process_variant()` [tjl_forward_scanner.py:364](../legacy/scanners/tjl_forward_scanner.py) | DONE (cho 6 config đang chạy) |
| entry gate | daily trend direction | cho phép Long/Short hay không | rule-based | 3 loại gate: `sma200` (v2/v2c/v2e), `trend_structure` (v2f) qua `build_trend_gate_index()` [:198](../legacy/scanners/tjl_forward_scanner.py), `none` (SOLUSDT v2e) | DONE |
| risk (sizing, risk/trade, margin cap, leverage) | signal + equity | order size | — | KHÔNG tồn tại trong code scanner. Chỉ có trong `config/risk.json` ở trạng thái `"status": "provisional"` | MISSING (chỉ là số liệu thảo luận, chưa code) |
| circuit breaker | lịch sử thua liên tiếp theo symbol | halve size | — | KHÔNG tồn tại trong code (grep toàn repo `*.py` cho "circuit\|consecutive.loss\|halve\|margin_cap\|leverage": 0 kết quả). Chỉ có trong `config/risk.json.circuit_breaker` (provisional) | MISSING |
| execution | order | fill | — | Scanner KHÔNG đặt lệnh thật — chỉ mô phỏng PnL% trên giá đóng nến (xem "Fill convention" dưới). Không có `src/execution/Broker.ts` implementation (chỉ interface rỗng, xem bên dưới) | MISSING (thật) / DONE (mô phỏng) |
| trade management (stop/TP/trailing) | `initial_stop`, `tp_price`, `highest/lowest_since_entry` | exit | rule-based | [tjl_forward_scanner.py:410-463](../legacy/scanners/tjl_forward_scanner.py) | DONE |
| logging | mỗi lần chạy | JSON state/trades + `bot.db` (`scanner_state`, `trades`, `signals`, `runs`) | — | `append_trade()`, `db_write_results()`, [db_writer.py](../legacy/scanners/db_writer.py) | DONE (dual-write, JSON authoritative) |
| monitoring | state | cảnh báo | — | `should_notify`/`notify_reason` trong state, nhưng KHÔNG có kênh gửi (không Telegram/email) | PARTIAL (tính cờ nhưng không gửi đi đâu) |
| operations (VPS, Task Scheduler) | — | chạy định kỳ | — | Windows Task Scheduler `TjlForwardScanner`, 30 phút/lần, chạy trên máy hiện tại (không VPS) | PARTIAL |
| AI layer | feature snapshot | score (advisory) | risk có quyền phủ quyết | `src/ai/ScoringModel.ts`, `src/ai/FeatureRecorder.ts` — CHỈ interface, không có model/logic thật | MISSING (chỉ thiết kế) |

### TJL entry rules — xác minh từ code

Cả 4 variant BTCUSDT (v2/v2c/v2e/v2f) + ETHUSDT v2f + SOLUSDT v2e dùng CÙNG một
hàm `process_variant()`, khác nhau ở tham số cấu hình:

| Variant | Symbol | buffer_mult | exit_style | rr_mult | gate | long_only |
|---|---|---|---|---|---|---|
| v2 | BTCUSDT | 0.0 | trail | — | sma200 | false |
| v2c | BTCUSDT | 0.5 | trail | — | sma200 | false |
| v2e | BTCUSDT | 0.5 | fixed_tp | 2.25 | sma200 | false |
| v2f | BTCUSDT | 0.5 | fixed_tp | 2.25 | trend_structure | false |
| v2f | ETHUSDT | 0.5 | fixed_tp | 2.25 | trend_structure | **true** |
| v2e | SOLUSDT | 0.5 | fixed_tp | 2.25 | none | **true** |

Nguồn: bảng `configs` trong `bot.db` (đọc read-only, `busy_timeout=5000`), khớp
với dict cấu hình trong [tjl_forward_scanner.py:73-93](../legacy/scanners/tjl_forward_scanner.py).

**Điều kiện Long** (code, [:478-500](../legacy/scanners/tjl_forward_scanner.py)):
`curr_px > d_high1` (daily breakout) AND trend gate cho phép Long AND
`curr_px > session_high_excl` (intraday breakout). **Không có buffer_mult áp
dụng cho phía Long** — chỉ thấy `buffer_mult` xuất hiện ở điều kiện Short
(dòng 487). Đây là bất đối xứng THẬT trong code, không phải suy diễn.

**Điều kiện Short** (code, [:483-489](../legacy/scanners/tjl_forward_scanner.py)):
chỉ áp dụng khi `long_only=false`. `curr_px < d_low1` AND trend gate cho phép
Short AND `curr_px < session_low_excl - buffer_mult * atr_val`.

**Stop / TP** (hằng số [:56-58](../legacy/scanners/tjl_forward_scanner.py)):
- `ATR_LEN = 14`, `INITIAL_STOP_ATR_MULT = 1.5` → stop ban đầu = giá vào ±
  1.5×ATR(14). Đúng như brief, xác minh trong code.
- `exit_style="trail"` (v2, v2c): trailing stop = `highest_since_entry -
  2.0×ATR` (Long) / `lowest_since_entry + 2.0×ATR` (Short) — "chandelier
  exit", KHÔNG phải fixed TP 2.25R.
- `exit_style="fixed_tp"` (v2e, v2f): TP cố định tại
  `rr_mult × INITIAL_STOP_ATR_MULT × ATR` = 2.25 × 1.5×ATR = 3.375×ATR,
  tương đương R:R = 2.25 (R = khoảng cách stop ban đầu).

**Sizing / margin cap / leverage / circuit breaker**: KHÔNG có trong code
scanner. Chỉ tồn tại dưới dạng số liệu "provisional" trong `config/risk.json`:
risk 1%/trade, margin cap 15% (trên MARGIN đã dùng, không phải notional —
xem note trong file), leverage 20x BTCUSDT/ETHUSDT, 10x SOLUSDT, circuit
breaker = halve size sau 3 lần thua liên tiếp cùng symbol (per-symbol, reset
khi thắng). Đây là GOAL/kế hoạch, chưa là code chạy thật.

**Fill convention**: xác minh từ `config/fees.json.fill_model.note` +
code — scanner vào lệnh tại GIÁ ĐÓNG của chính nến tạo breakout
(`curr_px = bar["close"]`, [:418](../legacy/scanners/tjl_forward_scanner.py)),
tức "signal bar close", khớp với dòng Pine thật (ví dụ v2f):
```
research/pine/tjl_btcusdt_v2f_trendgate.pine:5:
     slippage=1, calc_on_every_tick=false, process_orders_on_close=true,
```
Đây là giả định "same-bar, zero-latency", được chính `config/fees.json` ghi
nhận là "confirmed optimistic vs real execution" — chưa đối chiếu với Pine
Strategy Tester thật trên cùng dữ liệu (xem STATUS.md mục chờ).

Exit (stop/TP) lại check bằng HIGH/LOW trong nến, không phải close
([:457-460](../legacy/scanners/tjl_forward_scanner.py)): `hit_stop =
bar["high"] >= initial_stop` (Short) — nghĩa là entry dùng close, exit dùng
intrabar touch. Hai quy ước khác nhau trong cùng 1 file, xác minh từ code,
chưa so với Pine thật.

**Symbol/side đang chạy**: `long_only` = `false` cho cả 4 config BTCUSDT (Long
+ Short), `true` cho ETHUSDT v2f và SOLUSDT v2e (chỉ Long) — khớp với bảng
`configs` trong `bot.db`.

## Missing / gaps

| Gap | Loại | Owner |
|---|---|---|
| Market state observer (trend/chop/vol, allow_long/allow_short/size_mult) | (c) cần xây | chưa ai |
| Cost gate (skip nếu round-trip fee > ~0.3R) | (c) cần xây | chưa ai |
| Mechanical zones (weekly high/low, round numbers) | (c) cần xây | chưa ai |
| Session/time filter | (c) cần xây | chưa ai |
| Exit variants (partial TP, time stop) | (b) cần đo trước, rồi (c) xây | chưa ai |
| Portfolio correlation cap (BTC/ETH/SOL) | (a) cần quyết định của bạn — đã test "cross-symbol correlation cap" và KHÔNG áp dụng (`config/risk.json.circuit_breaker.rejected_alternative`), nhưng vẫn là open question theo yêu cầu STATUS.md | bạn |
| Daily/weekly loss limit + kill switch | (a) cần quyết định của bạn | bạn |
| Short-side evidence | (b) cần đo trước | chưa ai |
| Execution lên exchange thật (reduce-only SL/TP, startup reconciliation) | (c) cần xây | chưa ai |
| Monitoring/Telegram | (c) cần xây (cờ `should_notify` đã có, kênh gửi chưa có) | chưa ai |
| VPS deployment | (c) cần xây (hiện chạy trên máy hiện tại qua Task Scheduler) | chưa ai |
| Funding/slippage modelling | (c) cần xây (scanner hiện không mô phỏng funding/slippage) | chưa ai |
| Data quality checks | (c) cần xây | chưa ai |
| Signals table granularity | (b)/(c) — xem limitation trong STATUS.md | chưa ai |
| `src/execution/Broker.ts`, `src/ai/ScoringModel.ts` chỉ là interface rỗng (38-56 dòng/file, không logic) | (c) cần xây | chưa ai |
| `src/pipeline.ts` comment còn trỏ tới `src/core/README.md` — nhưng `src/core/` không còn tồn tại (đã dọn sang `research/smc-legacy/` trong restructure) | tài liệu lỗi thời, cần sửa comment | chưa ai |

## Metrics to optimize

Nguyên tắc: **optimize after-fee expectancy, không optimize raw profit.**

- Expectancy sau fee (R/trade)
- Profit Factor (PF) sau fee
- Fee tính theo R (fee-in-R) — xem STATUS.md cho số liệu thật từ `bot.db`
- Max drawdown
- Win rate so với breakeven win rate (phụ thuộc R:R của từng variant)
- MAE/MFE (Maximum Adverse/Favorable Excursion)
- Tỷ lệ stop-out-rồi-đảo-chiều ngay (stop-out-then-reverse rate)
- Số trade/tháng

## Rules of work

- Đổi một biến một lần (one variable at a time).
- Dừng sweep tham số khi kết quả đã plateau, không cố ép thêm.
- Chỉ tin **Pine Strategy Tester thật** hoặc **TS backtest engine tương lai**
  (chưa xây) làm bằng chứng chính thức.
- Python replica (các script mô phỏng portfolio/circuit breaker) chỉ mang
  tính **định hướng (directional)** — không phải bằng chứng cuối cùng.
- Không filter nào được bật live nếu chưa có bằng chứng after-fee trên mẫu
  đủ dài.
- Mọi filter mới chạy **shadow mode** trước (ghi nhận, không tác động quyết
  định) trước khi được phép ảnh hưởng lệnh thật.
