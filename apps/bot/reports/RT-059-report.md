# TICKET-RT-059 — XGBoost Feature Set v2 + Month-by-Month PF Regime Audit

Audit/proof-of-concept only. Khong sua entryRouter/fvg.ts/positionSizing/* hay bat ky code production nao. Khong sua/xoa xgbFeatureAudit.ts, xgbWalkForwardAudit.ts, hay xgbAuditDataset.csv cua RT-058 — giu nguyen lam baseline.

Dataset: apps/bot/data/xgbAuditDatasetV2.csv, tao boi xgbFeatureAuditV2.ts (khong import simulateOneYearNearLive.ts — tranh side-effect da phat hien o RT-058). Tu-kiem-tra khop 100% voi RT-056/057 Config B (n=1217, PnL=$2628.76, PF=1.551, maxDD=1.24%) da xac nhan trong log chay xgbFeatureAuditV2.ts.

Cac thang co trong du lieu: 2025-09, 2025-10, 2025-11, 2025-12, 2026-01, 2026-02, 2026-03, 2026-04, 2026-05, 2026-06, 2026-07, 2026-08 (12 thang).

## Part A.1 — AUC-ROC: v1 (8 feature, RT-058) vs v2 (14 feature), theo fold

| Fold | Test thang | Train n | Test n | AUC v1 (8 feature) | AUC v2 (14 feature) | Delta (v2-v1) |
|---|---|---|---|---|---|---|
| 1 | 2026-03 | 699 | 123 | 0.4856 | 0.5128 | +0.0273 |
| 2 | 2026-04 | 822 | 63 | 0.6051 | 0.6847 | +0.0796 |
| 3 | 2026-05 | 885 | 65 | 0.7038 | 0.6714 | -0.0324 |
| 4 | 2026-06 | 950 | 158 | 0.5647 | 0.5684 | +0.0037 |
| 5 | 2026-07 | 1108 | 54 | 0.5708 | 0.5540 | -0.0168 |
| 6 | 2026-08 | 1162 | 55 | 0.5353 | 0.6277 | +0.0924 |

v1: trung binh=0.5776, std=0.0673, min=0.4856, max=0.7038.
v2: trung binh=0.6032, std=0.0628, min=0.5128, max=0.6847.

_(v1 o day duoc huan luyen lai tren CHINH xgbAuditDatasetV2.csv, chi subset 8 cot feature goc — cung 1217 dong, cung fold split voi RT-058 — nen la doi chieu tao-doi-tao voi bao cao RT-058 goc; so nho lech (neu co) chi phan anh sai so lam tron/thu tu tinh toan floating-point, khong phai du lieu khac nhau.)_

## Part A.2 — Decile breakdown (feature set v2), theo fold

### Fold 1 (test thang 2026-03, n=123)

| Decile (1=cao nhat) | n | P(won) du doan TB | Winrate thuc te |
|---|---|---|---|
| 1 | 12 | 0.810 | 58.3% |
| 2 | 12 | 0.674 | 41.7% |
| 3 | 12 | 0.602 | 58.3% |
| 4 | 13 | 0.540 | 46.2% |
| 5 | 12 | 0.509 | 33.3% |
| 6 | 12 | 0.482 | 16.7% |
| 7 | 13 | 0.446 | 38.5% |
| 8 | 12 | 0.369 | 50.0% |
| 9 | 12 | 0.284 | 58.3% |
| 10 | 13 | 0.195 | 46.2% |

### Fold 2 (test thang 2026-04, n=63)

| Decile (1=cao nhat) | n | P(won) du doan TB | Winrate thuc te |
|---|---|---|---|
| 1 | 6 | 0.700 | 83.3% |
| 2 | 6 | 0.561 | 66.7% |
| 3 | 6 | 0.533 | 100.0% |
| 4 | 7 | 0.496 | 28.6% |
| 5 | 6 | 0.470 | 66.7% |
| 6 | 6 | 0.445 | 66.7% |
| 7 | 7 | 0.415 | 42.9% |
| 8 | 6 | 0.378 | 33.3% |
| 9 | 6 | 0.322 | 50.0% |
| 10 | 7 | 0.242 | 28.6% |

### Fold 3 (test thang 2026-05, n=65)

| Decile (1=cao nhat) | n | P(won) du doan TB | Winrate thuc te |
|---|---|---|---|
| 1 | 6 | 0.858 | 83.3% |
| 2 | 7 | 0.725 | 71.4% |
| 3 | 6 | 0.633 | 66.7% |
| 4 | 7 | 0.553 | 14.3% |
| 5 | 6 | 0.517 | 66.7% |
| 6 | 7 | 0.460 | 85.7% |
| 7 | 6 | 0.407 | 50.0% |
| 8 | 7 | 0.377 | 57.1% |
| 9 | 6 | 0.309 | 16.7% |
| 10 | 7 | 0.165 | 28.6% |

### Fold 4 (test thang 2026-06, n=158)

| Decile (1=cao nhat) | n | P(won) du doan TB | Winrate thuc te |
|---|---|---|---|
| 1 | 15 | 0.868 | 80.0% |
| 2 | 16 | 0.751 | 56.3% |
| 3 | 16 | 0.670 | 50.0% |
| 4 | 16 | 0.611 | 43.8% |
| 5 | 16 | 0.563 | 68.8% |
| 6 | 15 | 0.536 | 40.0% |
| 7 | 16 | 0.504 | 56.3% |
| 8 | 16 | 0.456 | 50.0% |
| 9 | 16 | 0.395 | 43.8% |
| 10 | 16 | 0.269 | 50.0% |

### Fold 5 (test thang 2026-07, n=54)

| Decile (1=cao nhat) | n | P(won) du doan TB | Winrate thuc te |
|---|---|---|---|
| 1 | 5 | 0.781 | 60.0% |
| 2 | 5 | 0.651 | 40.0% |
| 3 | 6 | 0.586 | 50.0% |
| 4 | 5 | 0.554 | 40.0% |
| 5 | 6 | 0.501 | 33.3% |
| 6 | 5 | 0.462 | 40.0% |
| 7 | 5 | 0.412 | 40.0% |
| 8 | 6 | 0.386 | 50.0% |
| 9 | 5 | 0.335 | 40.0% |
| 10 | 6 | 0.276 | 33.3% |

### Fold 6 (test thang 2026-08, n=55)

| Decile (1=cao nhat) | n | P(won) du doan TB | Winrate thuc te |
|---|---|---|---|
| 1 | 5 | 0.807 | 80.0% |
| 2 | 6 | 0.649 | 66.7% |
| 3 | 5 | 0.564 | 80.0% |
| 4 | 6 | 0.522 | 33.3% |
| 5 | 5 | 0.497 | 80.0% |
| 6 | 6 | 0.465 | 83.3% |
| 7 | 5 | 0.432 | 40.0% |
| 8 | 6 | 0.370 | 33.3% |
| 9 | 5 | 0.288 | 80.0% |
| 10 | 6 | 0.163 | 16.7% |

## Part A.3 — Feature importance (gain), feature set v2, theo fold

| Feature | Fold 1 | Fold 2 | Fold 3 | Fold 4 | Fold 5 | Fold 6 |
|---|---|---|---|---|---|---|
| distanceFromEma200H1Pct (v1) | 1.98 | 2.47 | 2.64 | 3.09 | 2.95 | 2.32 |
| slPct (v1) | 2.61 | 2.93 | 3.13 | 2.63 | 3.13 | 3.52 |
| fvgGapSizePct (v1) | 4.78 | 4.52 | 5.24 | 5.27 | 6.00 | 6.23 |
| waitedCandlesCount (v1) | 2.86 | 3.12 | 2.84 | 3.12 | 3.67 | 4.33 |
| breaksKeyZone (v1) | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 3.40 |
| atrH1Pct (v1) | 2.63 | 2.71 | 3.01 | 3.36 | 3.01 | 3.52 |
| hourOfDayUtc (v1) | 2.79 | 2.98 | 2.97 | 2.85 | 3.09 | 3.05 |
| dayOfWeekUtc (v1) | 2.23 | 3.24 | 3.06 | 2.74 | 2.72 | 2.77 |
| **trendAgeH1Candles (moi)** | 2.17 | 2.35 | 2.80 | 3.42 | 3.59 | 3.59 |
| **atrPercentileH1 (moi)** | 2.60 | 3.34 | 2.66 | 2.89 | 3.19 | 3.18 |
| **momentumM15Pct3Candles (moi)** | 3.11 | 2.64 | 2.85 | 2.86 | 2.49 | 2.73 |
| **keyZoneDistancePct (moi)** | 3.60 | 3.51 | 3.62 | 3.21 | 3.57 | 3.60 |
| **rollingWinRateSameSymbol20 (moi)** | 2.86 | 3.09 | 2.78 | 2.94 | 3.20 | 2.97 |
| **concurrentOpenPositionsCount (moi)** | 3.73 | 2.37 | 3.43 | 2.30 | 1.21 | 1.21 |

_(Hang in dam la 6 feature moi cua RT-059. So sanh gain cua chung voi nhom 8 feature cu — KHONG tu chon feature "quan trong nhat" de de xuat tich hop, chi bao cao so lieu tho.)_

## Part A.4 — Breakdown theo coin (feature set v2 test set), Wilson 90% CI, chi khi n>=30

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

### Ghi nhan so lieu tho — Part A (khong ket luan thay Gia thuyet 1/2/3, chi mo ta so do duoc)

**AUC v2 cao hon v1 o 4/6 fold, thap hon o 2/6 fold — khong phai cai thien mot chieu.** Delta = +0.0273, +0.0796, **-0.0324**, +0.0037, **-0.0168**, +0.0924. Trung binh tang tu 0.5776 (v1) len 0.6032 (v2), std giam nhe (0.0673 -> 0.0628). Dang chu y: Fold 3 (AUC v1 cao nhat, 0.7038) va Fold 5 lai la 2 fold ma v2 THAP HON v1 — them feature khong cai thien o dung nhung fold ma v1 von da "tot nhat", ma cai thien manh nhat o Fold 2 va Fold 6 (nhung fold v1 tam trung/yeu). Day la so lieu tho, khong ket luan feature set v2 "tot hon" hay "chi la nhieu khac" thay v1.

**breaksKeyZone (boolean cu) mat gan het gain khi co keyZoneDistancePct (lien tuc, moi) canh tranh.** breaksKeyZone gain = 0.00 o 5/6 fold (chi con 3.40 o Fold 6), trong khi keyZoneDistancePct (moi) on dinh 3.21-3.62 qua ca 6 fold — cao hon hau het cac feature khac ngoai fvgGapSizePct. Dang doc nhu: khi co ca 2, model uu tien phien ban lien tuc hon phien ban boolean cua cung mot loai thong tin (khoang cach toi KeyZone) — khong phai bang chung keyZoneDistancePct mang tin hieu MOI, chi la no thay the hieu qua hon cho cung tin hieu breaksKeyZone da co.

**concurrentOpenPositionsCount (moi) khong on dinh giua cac fold** (3.73 -> 2.37 -> 3.43 -> 2.30 -> 1.21 -> 1.21, giam dan roi phang o 2 fold cuoi) — trong khi trendAgeH1Candles, atrPercentileH1, momentumM15Pct3Candles, rollingWinRateSameSymbol20 deu dao dong trong khoang tuong doi hep (2.2-3.6) khong co xu huong ro rang tang/giam qua thoi gian.

## Part B — Audit regime theo thang (khong can model, tren toan bo 1217 lenh goc RT-058)

PnL$/tung lenh lay tu viec chay lai mirrored simulation da tu-kiem-tra cua Part A (xgbFeatureAuditV2.ts, KHONG qua simulateOneYearNearLive.ts) — khop 100% voi RT-056/057 Config B da chot (n=1217, PnL=$2628.76, PF=1.551). Mot phien ban dau thu tai-tao PnL$ CHI tu cac cot da co san trong apps/bot/data/xgbAuditDataset.csv (slPct/breaksKeyZone/won, khong chay lai gi) bang cong thuc risk-based — tu-kiem-tra phat hien lech $1.71 (0.065%) so voi tong da chot, chung to mot so lenh bi clamp boi maxMarginPct hoac scale-down boi exposure tracker (cong thuc do khong the bieu dien). Da bao cao cho nguoi dung; nguoi dung chon chay lai mirrored simulation da tu-kiem-tra (giong het Part A, khong dung lai) de lay PnL$ chinh xac thay vi dung cong thuc gan dung.

| Thang | n | Winrate | Wilson 90% CI | PF | PnL$ |
|---|---|---|---|---|---|
| 2025-09 | 70 | 60.0% | [50.2%-69.1%] | 2.22 | $256.82 |
| 2025-10 | 129 | 54.3% | [47.0%-61.3%] | 1.78 | $362.42 |
| 2025-11 | 166 | 49.4% | [43.1%-55.7%] | 1.40 | $282.33 |
| 2025-12 | 81 | 48.1% | [39.2%-57.2%] | 1.28 | $94.96 |
| 2026-01 | 106 | 55.7% | [47.7%-63.4%] | 1.68 | $274.94 |
| 2026-02 | 147 | 50.3% | [43.6%-57.1%] | 1.57 | $334.17 |
| 2026-03 | 123 | 44.7% | [37.5%-52.1%] | 1.12 | $69.23 |
| 2026-04 | 63 | 55.6% | [45.2%-65.4%] | 1.69 | $165.79 |
| 2026-05 | 65 | 53.8% | [43.7%-63.7%] | 1.64 | $140.37 |
| 2026-06 | 158 | 53.8% | [47.3%-60.2%] | 1.73 | $432.69 |
| 2026-07 | 54 | 42.6% | [32.1%-53.8%] | 1.08 | $21.73 |
| 2026-08 | 55 | 58.2% | [47.1%-68.5%] | 2.02 | $193.29 |

PF theo thang: trung binh=1.60, std=0.32, min=1.08, max=2.22 (12/12 thang co PF huu han).
Winrate theo thang: trung binh=52.2%, std=5.0%, min=42.6%, max=60.0%.

### Nhan dinh (Gia thuyet 3 — regime drift)

**PF/winrate dao dong that giua cac thang, HOAN TOAN doc lap voi model/feature** — Phan B khong dung model nao, chi tinh thang/thua thuc te tren 1217 lenh goc. PF dao dong 1.08 (2026-07) den 2.22 (2025-09), winrate 42.6% (2026-07) den 60.0% (2025-09), std=5.0 diem % qua 12 thang. Day la bang chung TRUC TIEP rang chinh he thong (khong lien quan XGBoost) da co PF/winrate khac nhau ro ret theo thang, du dung R:R co dinh 2.10R nhu nhau moi thang — tuc la regime drift la co that o muc do he thong, khong phai thu duoc "phat hien" boi model.

**Doi chieu 2 thang yeu nhat voi fold walk-forward tuong ung:** thang **2026-03** (PF=1.12, winrate=44.7%, yeu thu 2) la dung test-thang cua **Fold 1** — fold co AUC v1 THAP NHAT (0.4856, duoi random) va AUC v2 cung thap (0.5128). Thang **2026-07** (PF=1.08, winrate=42.6%, yeu nhat) la test-thang cua **Fold 5** — nhung Fold 5 lai co AUC v1=0.5708 (khong dac biet thap). Nguoc lai, thang **2026-08** (PF=2.02, winrate=58.2%, manh thu 2) la test-thang cua **Fold 6** — fold co delta AUC v2-v1 lon nhat (+0.0924). Vay tuong quan "thang yeu -> AUC fold do thap" chi dung mot phan (Fold 1 khop, Fold 5 khong khop) — KHONG du de khang dinh chac chan Gia thuyet 3 la loi giai thich duy nhat, nhung Fold 1 + Fold 6 cung huong ho tro mot phan.

## Tong hop bang chung cho 3 gia thuyet (RT-058 dat ra) — khong ket luan thay, chi trinh bay so do duoc

**Gia thuyet 1 — feature set thieu "boi canh" (trend age, bien dong tuong doi, momentum, phong do gan day):** co bang chung MOT PHAN ung ho. AUC trung binh tang tu 0.5776 (8 feature) len 0.6032 (14 feature, +0.0256), va keyZoneDistancePct (moi, lien tuc) thay the gan het gain cua breaksKeyZone (boolean cu). Nhung cai thien KHONG dong deu (2/6 fold giam AUC khi them feature, bao gom dung fold co AUC cao nhat cua v1), va khong feature moi nao noi bat vuot troi han han nhom cu — gain cua ca 6 feature moi nam trong khoang tuong tu 8 feature cu (2.2-3.7 vs 2.0-6.2, ngoai tru fvgGapSizePct van la cao nhat o ca 2 phien ban). Ket luan: bo sung boi canh co giup MOT PHAN nhung khong giai quyet duoc tinh khong on dinh cua AUC qua fold.

**Gia thuyet 2 — edge nam o R:R (2.10R), khong nam o kha nang doan truoc thang/thua sau entry:** khong bi bac bo boi so lieu Phan A/B. AUC ca v1 va v2 deu dao dong quanh 0.5-0.7 (khong co fold nao vuot han 0.7, va co fold duoi random) — nhat quan voi gia thuyet rang kha nang phan biet thang/thua SAU KHI da qua bo loc entry la yeu, du them feature. Day KHONG PHAI bang chung xac nhan Gia thuyet 2 dung (ticket nay khong thiet ke thi nghiem tach rieng dong gop cua R:R) — chi la khong co bang chung mau thuan voi no.

**Gia thuyet 3 — regime drift that qua cac giai doan thi trong, cong huong voi co mau mong/fold:** co bang chung TRUC TIEP, DOC LAP voi model, tu Phan B — PF/winrate dao dong that giua cac thang (PF 1.08-2.22, winrate 42.6%-60.0%) tren chinh 1217 lenh goc, khong lien quan gi den XGBoost. Doi chieu voi Phan A: 1/2 thang yeu nhat (2026-03) khop voi fold AUC yeu nhat (Fold 1), thang manh thu 2 (2026-08) khop voi fold co cai thien AUC lon nhat (Fold 6) — nhung thang yeu nhat con lai (2026-07) khong khop ro voi mot fold AUC dac biet yeu. Wilson 90% CI theo thang deu kha rong (n=54-166/thang) va phan lon chong lan nhau, nen mot phan dao dong PF/winrate quan sat duoc co the la nhieu thong ke tu co mau nho, khong hoan toan la regime drift "that". Tom lai: Gia thuyet 3 co bang chung ung ho manh nhat trong 3 gia thuyet (regime drift la co that o cap do he thong, doc lap voi model), nhung khong loai tru dong gop cua Gia thuyet 1 (feature con thieu) VA co mau mong lam nhieu tin hieu, dung nhu chinh gia thuyet nay da neu.
