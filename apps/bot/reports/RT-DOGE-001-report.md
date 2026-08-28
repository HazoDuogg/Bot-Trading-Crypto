# TICKET-RT-DOGE-001 Buoc 1+2 — DOGEUSDT thay XRPUSDT, backtest 5-coin lineup moi

Audit-only. Khong dung production, khong doi entry/risk logic (chi chay lai backtest, dung dung cac ham production khong sua).

Tu-kiem-tra: script nay chay lai tren bo 5 coin GOC (voi XRPUSDT) tren du lieu 1 nam HIEN CO (khong doi) truoc, khop 100% RT-056/057 (n=1217, PnL=$2628.76, PF=1.551, maxDD=1.24%) — xac nhan viec refactor thanh ham nhan tham so khong lam thay doi hanh vi mo phong truoc khi tin dung ket qua DOGE.

Du lieu: apps/bot/data/*_3y.csv, fetch lai 2026-08-27T15:14:34.848Z (fetchOhlcvThreeYear.ts, XRPUSDT -> DOGEUSDT). BTC/ETH/SOL/DOGE: day du 3 nam (2023-08-28 den 2026-08-27, 26279 nen H1 / 105119 nen M15 moi coin, 0 gap); HYPE: tu ngay list (2025-05-30) den nay (~454 ngay), la mot doan lien tuc khong gap cua CUNG grid.

**GIA DINH CAN XAC NHAN (TODO_CONFIRM):** DOGEUSDT leverage dung tam 10x, lay theo leverage XRPUSDT cu — chua co gia tri DOGE rieng duoc xac nhan. Neu Vinh Tam muon gia tri khac, ket qua duoi day se doi va can chay lai.

## Tong the (3 nam, BTC/ETH/SOL/HYPE/DOGE)

| n | PnL$ | PF | Winrate | Max DD |
|---|---|---|---|---|
| 3804 | $7642.57 | 1.451 | 50.6% | 2.28% |

## Theo tung coin

| Coin | n | PnL$ | PF | Winrate | Max DD |
|---|---|---|---|---|---|
| BTCUSDT | 286 | $486.51 | 1.344 | 49.3% | 1.34% |
| ETHUSDT | 565 | $1106.77 | 1.405 | 50.4% | 1.28% |
| SOLUSDT | 1141 | $2424.67 | 1.448 | 50.4% | 1.60% |
| HYPEUSDT | 757 | $1432.10 | 1.608 | 52.4% | 0.59% |
| DOGEUSDT | 1055 | $2192.52 | 1.437 | 50.0% | 1.48% |

_(So lieu tho — bao cao PF/winrate/maxDD/PnL tong the va theo coin, khong tu ket luan.)_
