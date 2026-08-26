# TICKET-RT-065 Part C — Xac nhan lai chien luoc goc tren du lieu 3 nam

Audit-only. Khong dung production, khong doi entry/risk logic (chi chay lai backtest, dung dung cac ham production khong sua).

Tu-kiem-tra: script nay chay lai tren du lieu 1 nam HIEN CO (khong doi) truoc, khop 100% RT-056/057 (n=1217, PnL=$2628.76, PF=1.551, maxDD=1.24%) — xac nhan incremental EMA/ATR (RT-065 Part B) va thiet ke vong lap co-offset-cho-HYPE (RT-065 Part A) tuong duong 100% voi thiet ke backtest goc truoc khi tin dung ket qua 3 nam.

Du lieu: apps/bot/data/*_3y.csv (RT-065 Part A) — BTC/ETH/SOL/XRP: 3 nam day du (2023-08-27 den 2026-08-26); HYPE: tu ngay list (2025-05-30) den nay (~453 ngay), duoc xac nhan la mot doan lien tuc, khong gap, cua CUNG grid voi 4 coin kia (xem checkGridsAlignExactly trong code).

## Tong the 3 nam

| n | PnL$ | PF | Winrate | Max DD |
|---|---|---|---|---|
| 3468 | $6638.77 | 1.429 | 50.3% | 1.87% |

## Theo tung nam (khong gop)

| Nam | n | PnL$ | PF | Winrate | Max DD |
|---|---|---|---|---|---|
| 2023 | 223 | $464.13 | 1.434 | 50.2% | 1.01% |
| 2024 | 1074 | $2110.64 | 1.409 | 49.8% | 1.38% |
| 2025 | 1398 | $2440.79 | 1.395 | 50.1% | 1.87% |
| 2026 | 773 | $1623.22 | 1.531 | 51.6% | 1.24% |

_(2023 va 2026 la nam khong day du — 2023 chi tu 27/8, 2026 chi den 26/8. Xem con so nhu mot phan nam, khong so sanh truc tiep voi cac nam day du.)_

## Theo tung coin (3 nam, hoac toan bo lich su neu ngan hon — HYPE)

| Coin | n | PnL$ | PF | Winrate |
|---|---|---|---|---|
| BTCUSDT | 286 | $486.51 | 1.344 | 49.3% |
| ETHUSDT | 564 | $1124.52 | 1.413 | 50.5% |
| SOLUSDT | 1139 | $2418.65 | 1.448 | 50.4% |
| HYPEUSDT | 755 | $1428.74 | 1.608 | 52.5% |
| XRPUSDT | 724 | $1180.35 | 1.330 | 48.3% |

_(So lieu tho — bao cao PF/winrate/maxDD/PnL theo nam va theo coin, khong tu ket luan chien luoc "on dinh" hay "khong on dinh" qua cac giai doan.)_
