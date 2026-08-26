# TICKET-RT-061 — Purge Correction + Phase 2: Economic Quintile Validation

Audit-only. Khong dung production, khong sua RT-058/059/060, khong bat dau Shadow Mode.

Dataset: apps/bot/data/xgbAuditDatasetV3.csv (xgbFeatureAuditV3.ts — copy cua xgbFeatureAuditV2.ts/RT-059, KHONG sua file do, cong them cot closeTime). Tu-kiem-tra khop 100% voi RT-056/057 (n=1217, PnL=$2628.76, PF=1.551).

Cac thang: 2025-09, 2025-10, 2025-11, 2025-12, 2026-01, 2026-02, 2026-03, 2026-04, 2026-05, 2026-06, 2026-07, 2026-08 (12 thang), cung fold split (expanding window theo thang) nhu RT-058/059/060.

## Part A — Purge correction: AUC truoc/sau purge

Purge: loai khoi tap train moi lenh co `closeTime >= dau thang test` (RT-060 tim thay dung 1 lenh nhu vay, o Fold 2). "Truoc purge" la so lieu DA CONG BO, DA TU-KIEM-TRA trong RT-059-report.md (khong rerun xgbWalkForwardAuditV2.ts o day — file do bi dong bang, va rerun se ghi de RT-059-report.md khong can thiet).

| Fold | Test thang | Train n (truoc purge) | Train n (sau purge) | So lenh bi purge | AUC v1 truoc | AUC v1 sau | Delta v1 | AUC v2 truoc | AUC v2 sau | Delta v2 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-03 | 699 | 699 | 0 | 0.4856 | 0.4856 | -0.0000 | 0.5128 | 0.5128 | +0.0000 |
| 2 | 2026-04 | 822 | 821 | 1 | 0.6051 | 0.6561 | +0.0510 | 0.6847 | 0.6031 | -0.0816 |
| 3 | 2026-05 | 885 | 885 | 0 | 0.7038 | 0.7038 | +0.0000 | 0.6714 | 0.6714 | +0.0000 |
| 4 | 2026-06 | 950 | 950 | 0 | 0.5647 | 0.5647 | +0.0000 | 0.5684 | 0.5684 | +0.0000 |
| 5 | 2026-07 | 1108 | 1108 | 0 | 0.5708 | 0.5708 | +0.0000 | 0.5540 | 0.5540 | -0.0000 |
| 6 | 2026-08 | 1162 | 1162 | 0 | 0.5353 | 0.5353 | +0.0000 | 0.6277 | 0.6277 | +0.0000 |

So lenh bi purge khac 0 CHI o fold co 2026-04 — khop voi ky vong ticket ("khac biet toi da o dung Fold 2") va voi RT-060's straddle count (1 lenh, Fold 2). Cac fold khac co purgedCount=0 nen AUC sau purge PHAI giong het truoc purge (delta=0.0000) — day la phep do that, khong phai gia dinh.

## Part B — Economic quintile validation (Top 20% / Middle 60% / Bottom 20%, theo diem du doan v2 sau purge)

Moi fold: sap xep tap test theo diem du doan P(won) giam dan, chia Top 20% / Middle 60% / Bottom 20% (lam tron so luong). R-multiple: TP=+2.10R co dinh, SL=-1R co dinh (target R khong doi trong toan bo du lieu).

### Fold 1 (test thang 2026-03, test n=123)

| Nhom | n | Winrate | Wilson 90% CI | PF | Expectancy $ | Expectancy R | PnL$ | Max DD $ (trong nhom) | Chuoi thua dai nhat |
|---|---|---|---|---|---|---|---|---|---|
| Top 20% | 25 | 52.0% | [36.2%-67.4%] | 1.71 | $2.56 | 0.612R | $63.89 | $56.17 | 7 |
| Middle 60% | 73 | 39.7% | [30.8%-49.4%] | 0.89 | $-0.56 | 0.232R | $-40.77 | $88.20 | 10 |
| Bottom 20% | 25 | 52.0% | [36.2%-67.4%] | 1.50 | $1.84 | 0.612R | $46.11 | $25.66 | 3 |

### Fold 2 (test thang 2026-04, test n=63)

| Nhom | n | Winrate | Wilson 90% CI | PF | Expectancy $ | Expectancy R | PnL$ | Max DD $ (trong nhom) | Chuoi thua dai nhat |
|---|---|---|---|---|---|---|---|---|---|
| Top 20% | 13 | 76.9% | [54.2%-90.4%] | 3.99 | $6.79 | 1.385R | $88.26 | $10.26 | 1 |
| Middle 60% | 37 | 48.6% | [35.7%-61.8%] | 1.34 | $1.45 | 0.508R | $53.61 | $49.39 | 7 |
| Bottom 20% | 13 | 53.8% | [32.5%-73.9%] | 1.44 | $1.84 | 0.669R | $23.92 | $27.53 | 3 |

### Fold 3 (test thang 2026-05, test n=65)

| Nhom | n | Winrate | Wilson 90% CI | PF | Expectancy $ | Expectancy R | PnL$ | Max DD $ (trong nhom) | Chuoi thua dai nhat |
|---|---|---|---|---|---|---|---|---|---|
| Top 20% | 13 | 76.9% | [54.2%-90.4%] | 4.71 | $6.22 | 1.385R | $80.84 | $9.74 | 1 |
| Middle 60% | 39 | 56.4% | [43.4%-68.6%] | 1.82 | $2.60 | 0.749R | $101.39 | $22.45 | 3 |
| Bottom 20% | 13 | 23.1% | [9.6%-45.8%] | 0.43 | $-3.22 | -0.285R | $-41.87 | $47.64 | 5 |

### Fold 4 (test thang 2026-06, test n=158)

| Nhom | n | Winrate | Wilson 90% CI | PF | Expectancy $ | Expectancy R | PnL$ | Max DD $ (trong nhom) | Chuoi thua dai nhat |
|---|---|---|---|---|---|---|---|---|---|
| Top 20% | 32 | 68.8% | [54.3%-80.3%] | 3.53 | $6.21 | 1.131R | $198.78 | $28.59 | 3 |
| Middle 60% | 94 | 51.1% | [42.7%-59.4%] | 1.52 | $2.05 | 0.583R | $192.26 | $57.81 | 6 |
| Bottom 20% | 32 | 46.9% | [33.2%-61.1%] | 1.30 | $1.30 | 0.453R | $41.66 | $62.61 | 5 |

### Fold 5 (test thang 2026-07, test n=54)

| Nhom | n | Winrate | Wilson 90% CI | PF | Expectancy $ | Expectancy R | PnL$ | Max DD $ (trong nhom) | Chuoi thua dai nhat |
|---|---|---|---|---|---|---|---|---|---|
| Top 20% | 11 | 45.5% | [24.2%-68.5%] | 1.23 | $1.12 | 0.409R | $12.31 | $34.79 | 4 |
| Middle 60% | 32 | 43.8% | [30.4%-58.1%] | 1.16 | $0.71 | 0.356R | $22.65 | $66.58 | 7 |
| Bottom 20% | 11 | 36.4% | [17.5%-60.6%] | 0.77 | $-1.20 | 0.127R | $-13.23 | $35.49 | 4 |

### Fold 6 (test thang 2026-08, test n=55)

| Nhom | n | Winrate | Wilson 90% CI | PF | Expectancy $ | Expectancy R | PnL$ | Max DD $ (trong nhom) | Chuoi thua dai nhat |
|---|---|---|---|---|---|---|---|---|---|
| Top 20% | 11 | 72.7% | [48.0%-88.5%] | 3.47 | $6.20 | 1.255R | $68.21 | $17.67 | 2 |
| Middle 60% | 33 | 57.6% | [43.4%-70.6%] | 2.00 | $3.37 | 0.785R | $111.21 | $26.39 | 4 |
| Bottom 20% | 11 | 45.5% | [24.2%-68.5%] | 1.27 | $1.26 | 0.409R | $13.87 | $20.84 | 2 |

### Doi chieu Top vs Middle vs Bottom qua 6 fold (khong tu ket luan — chi trinh bay)

| Fold | Top winrate | Middle winrate | Bottom winrate | Top > Middle? | Middle > Bottom? | Top > Bottom? |
|---|---|---|---|---|---|---|
| 1 | 52.0% | 39.7% | 52.0% | co | khong | khong |
| 2 | 76.9% | 48.6% | 53.8% | co | khong | co |
| 3 | 76.9% | 56.4% | 23.1% | co | co | co |
| 4 | 68.8% | 51.1% | 46.9% | co | co | co |
| 5 | 45.5% | 43.8% | 36.4% | co | co | co |
| 6 | 72.7% | 57.6% | 45.5% | co | co | co |

Top > Middle: 6/6 fold. Middle > Bottom: 4/6 fold. Top > Bottom: 5/6 fold.

_(So lieu tho, khong tu ket luan Top/Middle/Bottom co "nhat quan tot hon" hay khong — de Vinh Tam/AI reviewer tu danh gia, luu y n moi nhom rat mong (~11-32 lenh/fold) nen Wilson CI o bang tren can duoc doc cung voi ket luan nay.)_
