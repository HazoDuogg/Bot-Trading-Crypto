# TICKET-RT-058 — XGBoost Proof-of-Concept: Walk-Forward Feature Audit

Audit/proof-of-concept only. Khong sua entryRouter/fvg.ts/positionSizing/* hay bat ky code production nao.
Dataset: apps/bot/data/xgbAuditDataset.csv, tao boi xgbFeatureAudit.ts tu chinh backtest 1 nam da chot (RT-056/057 Config B, n=1217, PF=1.551) — tu-kiem-tra khop 100% da xac nhan trong log chay xgbFeatureAudit.ts.

Cong cu: XGBoost qua Python subprocess (khong co JS/TS xgboost binding san co trong repo) — thu vien `xgboost` 3.3.0 + pandas/scikit-learn da co san trong moi truong Python he thong.

Cac thang calendar co trong du lieu: 2025-09, 2025-10, 2025-11, 2025-12, 2026-01, 2026-02, 2026-03, 2026-04, 2026-05, 2026-06, 2026-07, 2026-08 (12 thang).

## 1. AUC-ROC theo fold

| Fold | Train thang | Test thang | Train n | Test n | AUC-ROC |
|---|---|---|---|---|---|
| 1 | 2025-09, 2025-10, 2025-11, 2025-12, 2026-01, 2026-02 | 2026-03 | 699 | 123 | 0.4856 |
| 2 | 2025-09, 2025-10, 2025-11, 2025-12, 2026-01, 2026-02, 2026-03 | 2026-04 | 822 | 63 | 0.6051 |
| 3 | 2025-09, 2025-10, 2025-11, 2025-12, 2026-01, 2026-02, 2026-03, 2026-04 | 2026-05 | 885 | 65 | 0.7038 |
| 4 | 2025-09, 2025-10, 2025-11, 2025-12, 2026-01, 2026-02, 2026-03, 2026-04, 2026-05 | 2026-06 | 950 | 158 | 0.5647 |
| 5 | 2025-09, 2025-10, 2025-11, 2025-12, 2026-01, 2026-02, 2026-03, 2026-04, 2026-05, 2026-06 | 2026-07 | 1108 | 54 | 0.5708 |
| 6 | 2025-09, 2025-10, 2025-11, 2025-12, 2026-01, 2026-02, 2026-03, 2026-04, 2026-05, 2026-06, 2026-07 | 2026-08 | 1162 | 55 | 0.5353 |

AUC trung binh qua 6 fold co gia tri: 0.5776 (std=0.0673, min=0.4856, max=0.7038).

## 2. Decile breakdown (P(won) du doan vs winrate thuc te), theo fold

### Fold 1 (test thang 2026-03, n=123)

| Decile (1=cao nhat) | n | P(won) du doan TB | Winrate thuc te |
|---|---|---|---|
| 1 | 12 | 0.831 | 41.7% |
| 2 | 12 | 0.715 | 50.0% |
| 3 | 12 | 0.618 | 50.0% |
| 4 | 13 | 0.552 | 30.8% |
| 5 | 12 | 0.518 | 50.0% |
| 6 | 12 | 0.471 | 41.7% |
| 7 | 13 | 0.427 | 38.5% |
| 8 | 12 | 0.379 | 50.0% |
| 9 | 12 | 0.322 | 50.0% |
| 10 | 13 | 0.196 | 46.2% |

### Fold 2 (test thang 2026-04, n=63)

| Decile (1=cao nhat) | n | P(won) du doan TB | Winrate thuc te |
|---|---|---|---|
| 1 | 6 | 0.742 | 100.0% |
| 2 | 6 | 0.677 | 66.7% |
| 3 | 6 | 0.616 | 50.0% |
| 4 | 7 | 0.553 | 57.1% |
| 5 | 6 | 0.507 | 50.0% |
| 6 | 6 | 0.475 | 33.3% |
| 7 | 7 | 0.434 | 57.1% |
| 8 | 6 | 0.378 | 33.3% |
| 9 | 6 | 0.330 | 33.3% |
| 10 | 7 | 0.254 | 71.4% |

### Fold 3 (test thang 2026-05, n=65)

| Decile (1=cao nhat) | n | P(won) du doan TB | Winrate thuc te |
|---|---|---|---|
| 1 | 6 | 0.802 | 83.3% |
| 2 | 7 | 0.639 | 57.1% |
| 3 | 6 | 0.595 | 66.7% |
| 4 | 7 | 0.558 | 71.4% |
| 5 | 6 | 0.529 | 66.7% |
| 6 | 7 | 0.459 | 57.1% |
| 7 | 6 | 0.429 | 33.3% |
| 8 | 7 | 0.366 | 57.1% |
| 9 | 6 | 0.250 | 33.3% |
| 10 | 7 | 0.170 | 14.3% |

### Fold 4 (test thang 2026-06, n=158)

| Decile (1=cao nhat) | n | P(won) du doan TB | Winrate thuc te |
|---|---|---|---|
| 1 | 15 | 0.860 | 66.7% |
| 2 | 16 | 0.744 | 68.8% |
| 3 | 16 | 0.672 | 56.3% |
| 4 | 16 | 0.624 | 50.0% |
| 5 | 16 | 0.580 | 50.0% |
| 6 | 15 | 0.536 | 60.0% |
| 7 | 16 | 0.507 | 25.0% |
| 8 | 16 | 0.449 | 62.5% |
| 9 | 16 | 0.394 | 50.0% |
| 10 | 16 | 0.264 | 50.0% |

### Fold 5 (test thang 2026-07, n=54)

| Decile (1=cao nhat) | n | P(won) du doan TB | Winrate thuc te |
|---|---|---|---|
| 1 | 5 | 0.768 | 80.0% |
| 2 | 5 | 0.631 | 40.0% |
| 3 | 6 | 0.598 | 33.3% |
| 4 | 5 | 0.550 | 60.0% |
| 5 | 6 | 0.492 | 16.7% |
| 6 | 5 | 0.455 | 40.0% |
| 7 | 5 | 0.418 | 20.0% |
| 8 | 6 | 0.384 | 50.0% |
| 9 | 5 | 0.350 | 80.0% |
| 10 | 6 | 0.292 | 16.7% |

### Fold 6 (test thang 2026-08, n=55)

| Decile (1=cao nhat) | n | P(won) du doan TB | Winrate thuc te |
|---|---|---|---|
| 1 | 5 | 0.858 | 60.0% |
| 2 | 6 | 0.753 | 83.3% |
| 3 | 5 | 0.625 | 60.0% |
| 4 | 6 | 0.551 | 50.0% |
| 5 | 5 | 0.495 | 80.0% |
| 6 | 6 | 0.456 | 33.3% |
| 7 | 5 | 0.413 | 20.0% |
| 8 | 6 | 0.369 | 66.7% |
| 9 | 5 | 0.307 | 40.0% |
| 10 | 6 | 0.234 | 83.3% |

## 3. Feature importance (gain) theo fold

| Feature | Fold 1 | Fold 2 | Fold 3 | Fold 4 | Fold 5 | Fold 6 |
|---|---|---|---|---|---|---|
| distanceFromEma200H1Pct | 2.29 | 2.47 | 2.20 | 2.63 | 2.69 | 2.58 |
| slPct | 2.55 | 2.22 | 2.25 | 2.09 | 2.56 | 2.59 |
| fvgGapSizePct | 3.19 | 3.38 | 3.82 | 3.98 | 4.18 | 4.39 |
| waitedCandlesCount | 2.51 | 2.51 | 2.50 | 2.65 | 2.99 | 3.16 |
| breaksKeyZone | 1.66 | 1.79 | 1.12 | 1.63 | 0.92 | 0.39 |
| atrH1Pct | 2.47 | 2.33 | 2.66 | 2.53 | 2.50 | 2.63 |
| hourOfDayUtc | 2.28 | 2.48 | 2.27 | 2.57 | 2.70 | 2.71 |
| dayOfWeekUtc | 2.01 | 1.87 | 2.16 | 2.53 | 2.16 | 2.52 |

## 4. Breakdown theo coin (winrate thuc te trong tap test), Wilson 90% CI, chi khi n>=30

### Fold 1 (test thang 2026-03)

| Coin | n | Winrate thuc te | Wilson 90% CI |
|---|---|---|---|
| HYPEUSDT | 55 | 49.1% | [38.3%-60.0%] |

### Fold 2 (test thang 2026-04)

Khong coin nao dat n>=30 trong fold nay — khong bao cao breakdown theo coin (khong noi suy).

### Fold 3 (test thang 2026-05)

| Coin | n | Winrate thuc te | Wilson 90% CI |
|---|---|---|---|
| HYPEUSDT | 52 | 57.7% | [46.3%-68.3%] |

### Fold 4 (test thang 2026-06)

| Coin | n | Winrate thuc te | Wilson 90% CI |
|---|---|---|---|
| HYPEUSDT | 70 | 48.6% | [39.0%-58.3%] |

### Fold 5 (test thang 2026-07)

Khong coin nao dat n>=30 trong fold nay — khong bao cao breakdown theo coin (khong noi suy).

### Fold 6 (test thang 2026-08)

Khong coin nao dat n>=30 trong fold nay — khong bao cao breakdown theo coin (khong noi suy).

## 5. Nhan dinh

**AUC khong on dinh qua cac fold.** 6 fold cho AUC = 0.4856, 0.6051, 0.7038, 0.5647, 0.5708, 0.5353 — trung binh 0.5776, std=0.0673, nhung dai gia tri chay tu **duoi ca muc ngau nhien (Fold 1 = 0.4856, tuc te hon random)** den **0.7038 o Fold 3**. Khong co fold nao lap lai muc AUC cua fold ngay truoc do voi sai so nho; do lech giua fold thap nhat va cao nhat (~0.22) lon hon ca chinh gia tri trung binh cach 0.5 (~0.08). Day la dau hieu ro cua **nhieu (noise)**, khong phai tin hieu thong ke on dinh qua thoi gian — dung nhu moi lo ngai "Van de 1" cua ticket nay ve tinh khong on dinh cua bat ky "edge" nao do tren du lieu backtest gioi han.

**Decile khong don dieu tang nhat quan.** Chi Fold 3 va Fold 5 cho pattern decile-1-cao-hon-decile-10 kha ro rang va gan don dieu (Fold 3: 83.3% -> 14.3%; Fold 5: 80.0% -> 16.7%) — day cung la 2 fold co AUC cao nhat/thu nhi (0.7038 va 0.5708). Fold 1 gan nhu phang (41.7% vs 46.2%, thap hon random o mot so decile giua). **Fold 6 dao nguoc hoan toan** (decile 1 = 60.0% thap hon decile 2 = 83.3% va decile 10 = 83.3%). Voi n moi decile chi ~5-16 lenh/fold, muc dao dong nay hoan toan nam trong bien do nhieu thong ke ky vong cho co mau nho nay — khong the phan biet voi random tren du lieu hien co.

**Feature importance tuong doi on dinh ve THU HANG nhung khong chi ra tin hieu manh.** `fvgGapSizePct` luon la feature co gain cao nhat qua ca 6 fold (3.19 -> 4.39, tang dan theo thoi gian train), `breaksKeyZone` luon thap nhat (0.39-1.79). 6 feature con lai (distanceFromEma200H1Pct, slPct, waitedCandlesCount, atrH1Pct, hourOfDayUtc, dayOfWeekUtc) phan bo tuong doi deu trong khoang 1.87-3.16, khong co feature nao noi bat ro rang. Thu hang khong doi hoan toan giua cac fold la diem tot (khong phai dau hieu overfit-dao-lon-hoan-toan ma ticket canh bao), nhung do lon gain kha dong deu giua cac feature (khong co mot feature chiem uu the) nhat quan voi mot mo hinh dang hoc **nhieu yeu, phan tan**, khop voi ket luan AUC/decile o tren — khong phai mot feature don le mang tin hieu manh.

**Breakdown theo coin qua thua du lieu de ket luan.** Chi HYPEUSDT dat nguong n>=30/fold (3/6 fold: n=55, 52, 70), voi Wilson 90% CI deu bao trum 50% (38.3%-60.0%, 46.3%-68.3%, 39.0%-58.3%) — khong co bang chung phan biet duoc voi coin tossing. 4 coin con lai (BTC/ETH/SOL/XRP) khong dat nguong mau o bat ky fold nao trong walk-forward setup nay (khac voi bai kiem tra breaksKeyZone tren toan bo 1217 lenh gop chung trong log xgbFeatureAudit.ts, noi mau du lon hon nhieu).

**Ket luan tong the:** tren du lieu 1 nam hien co, walk-forward expanding-window KHONG the hien mot tin hieu thong ke on dinh giua cac feature entry-time da trich va ket qua thang/thua. AUC dao dong manh qua fold (bao gom 1 fold duoi random), decile khong don dieu nhat quan (bao gom 1 fold dao nguoc), va khong coin nao co du mau de kiem chung rieng ngoai HYPEUSDT (voi CI trung tam quanh 50%). Ket qua nay nhat quan hon voi **nhieu (noise)** hon la mot "edge" du bao duoc va on dinh. Day la dung ket luan "Van de 1" ma ticket dat ra can kiem tra — khong de xuat threshold hay tich hop, chi bao cao so lieu tho nhu tren.
