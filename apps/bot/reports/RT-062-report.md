# TICKET-RT-062 Part A — 5-Quintile Ranking Monotonicity

Audit-only. Khong dung production, khong sua RT-058/059/060/061.

Dataset/pipeline: import truc tiep tu xgbFeatureAuditV3.ts (RT-059/061, dong bang, KHONG sua) — cung purge logic RT-061 (loai lenh co closeTime >= dau thang test), cung 6 fold, feature set v2 (14 feature). Tu-kiem-tra khop 100% RT-056/057 (n=1217, PnL=$2628.76, PF=1.551).

## Bang PF theo quintile (Q1=diem du doan cao nhat, Q5=thap nhat)

| Fold | Q1 (n) | Q2 (n) | Q3 (n) | Q4 (n) | Q5 (n) | Monotonic (Q1>=..>=Q5)? |
|---|---|---|---|---|---|---|
| 1 | 1.71 (25) | 1.32 (24) | 0.57 (25) | 0.93 (24) | 1.50 (25) | khong |
| 2 | 3.99 (13) | 1.56 (12) | 1.26 (13) | 1.26 (12) | 1.44 (13) | khong |
| 3 | 4.71 (13) | 0.77 (13) | 4.62 (13) | 1.74 (13) | 0.43 (13) | khong |
| 4 | 3.53 (32) | 1.17 (31) | 1.76 (32) | 1.69 (31) | 1.30 (32) | khong |
| 5 | 1.23 (11) | 1.39 (11) | 0.98 (10) | 1.11 (11) | 0.77 (11) | khong |
| 6 | 3.47 (11) | 1.78 (11) | 6.65 (11) | 0.93 (11) | 1.27 (11) | khong |

So fold co gradient PF dung huong hoan toan (Q1>=Q2>=Q3>=Q4>=Q5, cho phep bang): **0/6**.

## Bang winrate theo quintile

| Fold | Q1 | Q2 | Q3 | Q4 | Q5 | Monotonic (Q1>=..>=Q5)? |
|---|---|---|---|---|---|---|
| 1 | 52.0% | 50.0% | 28.0% | 41.7% | 52.0% | khong |
| 2 | 76.9% | 50.0% | 46.2% | 50.0% | 53.8% | khong |
| 3 | 76.9% | 38.5% | 76.9% | 53.8% | 23.1% | khong |
| 4 | 68.8% | 45.2% | 56.3% | 51.6% | 46.9% | khong |
| 5 | 45.5% | 45.5% | 40.0% | 45.5% | 36.4% | khong |
| 6 | 72.7% | 54.5% | 81.8% | 36.4% | 45.5% | khong |

So fold co gradient winrate dung huong hoan toan: **0/6**.

## Bang Expectancy R theo quintile

| Fold | Q1 | Q2 | Q3 | Q4 | Q5 |
|---|---|---|---|---|---|
| 1 | 0.612R | 0.550R | -0.132R | 0.292R | 0.612R |
| 2 | 1.385R | 0.550R | 0.431R | 0.550R | 0.669R |
| 3 | 1.385R | 0.192R | 1.385R | 0.669R | -0.285R |
| 4 | 1.131R | 0.400R | 0.744R | 0.600R | 0.453R |
| 5 | 0.409R | 0.409R | 0.240R | 0.409R | 0.127R |
| 6 | 1.255R | 0.691R | 1.536R | 0.127R | 0.409R |

## Chi tiet day du moi fold (n, winrate, Wilson 90% CI, PF, Expectancy $/R, PnL$, maxDD, chuoi thua)

### Fold 1 (test thang 2026-03)

| Quintile | n | Winrate | Wilson 90% CI | PF | Expectancy $ | Expectancy R | PnL$ | Max DD $ | Chuoi thua dai nhat |
|---|---|---|---|---|---|---|---|---|---|
| Q1 | 25 | 52.0% | [36.2%-67.4%] | 1.71 | $2.56 | 0.612R | $63.89 | $56.17 | 7 |
| Q2 | 24 | 50.0% | [34.1%-65.9%] | 1.32 | $1.37 | 0.550R | $32.77 | $30.23 | 4 |
| Q3 | 25 | 28.0% | [16.0%-44.3%] | 0.57 | $-2.60 | -0.132R | $-65.07 | $80.24 | 7 |
| Q4 | 24 | 41.7% | [26.8%-58.2%] | 0.93 | $-0.35 | 0.292R | $-8.47 | $38.48 | 4 |
| Q5 | 25 | 52.0% | [36.2%-67.4%] | 1.50 | $1.84 | 0.612R | $46.11 | $25.66 | 3 |

### Fold 2 (test thang 2026-04)

| Quintile | n | Winrate | Wilson 90% CI | PF | Expectancy $ | Expectancy R | PnL$ | Max DD $ | Chuoi thua dai nhat |
|---|---|---|---|---|---|---|---|---|---|
| Q1 | 13 | 76.9% | [54.2%-90.4%] | 3.99 | $6.79 | 1.385R | $88.26 | $10.26 | 1 |
| Q2 | 12 | 50.0% | [28.6%-71.4%] | 1.56 | $2.11 | 0.550R | $25.29 | $22.63 | 3 |
| Q3 | 13 | 46.2% | [26.1%-67.5%] | 1.26 | $1.12 | 0.431R | $14.59 | $36.88 | 4 |
| Q4 | 12 | 50.0% | [28.6%-71.4%] | 1.26 | $1.14 | 0.550R | $13.73 | $35.23 | 3 |
| Q5 | 13 | 53.8% | [32.5%-73.9%] | 1.44 | $1.84 | 0.669R | $23.92 | $27.53 | 3 |

### Fold 3 (test thang 2026-05)

| Quintile | n | Winrate | Wilson 90% CI | PF | Expectancy $ | Expectancy R | PnL$ | Max DD $ | Chuoi thua dai nhat |
|---|---|---|---|---|---|---|---|---|---|
| Q1 | 13 | 76.9% | [54.2%-90.4%] | 4.71 | $6.22 | 1.385R | $80.84 | $9.74 | 1 |
| Q2 | 13 | 38.5% | [20.2%-60.7%] | 0.77 | $-1.08 | 0.192R | $-14.03 | $35.13 | 5 |
| Q3 | 13 | 76.9% | [54.2%-90.4%] | 4.62 | $6.65 | 1.385R | $86.42 | $9.01 | 1 |
| Q4 | 13 | 53.8% | [32.5%-73.9%] | 1.74 | $2.23 | 0.669R | $29.00 | $13.55 | 2 |
| Q5 | 13 | 23.1% | [9.6%-45.8%] | 0.43 | $-3.22 | -0.285R | $-41.87 | $47.64 | 5 |

### Fold 4 (test thang 2026-06)

| Quintile | n | Winrate | Wilson 90% CI | PF | Expectancy $ | Expectancy R | PnL$ | Max DD $ | Chuoi thua dai nhat |
|---|---|---|---|---|---|---|---|---|---|
| Q1 | 32 | 68.8% | [54.3%-80.3%] | 3.53 | $6.21 | 1.131R | $198.78 | $28.59 | 3 |
| Q2 | 31 | 45.2% | [31.4%-59.7%] | 1.17 | $0.75 | 0.400R | $23.31 | $39.07 | 4 |
| Q3 | 32 | 56.3% | [41.9%-69.6%] | 1.76 | $2.85 | 0.744R | $91.06 | $49.62 | 6 |
| Q4 | 31 | 51.6% | [37.3%-65.6%] | 1.69 | $2.51 | 0.600R | $77.89 | $31.12 | 3 |
| Q5 | 32 | 46.9% | [33.2%-61.1%] | 1.30 | $1.30 | 0.453R | $41.66 | $62.61 | 5 |

### Fold 5 (test thang 2026-07)

| Quintile | n | Winrate | Wilson 90% CI | PF | Expectancy $ | Expectancy R | PnL$ | Max DD $ | Chuoi thua dai nhat |
|---|---|---|---|---|---|---|---|---|---|
| Q1 | 11 | 45.5% | [24.2%-68.5%] | 1.23 | $1.12 | 0.409R | $12.31 | $34.79 | 4 |
| Q2 | 11 | 45.5% | [24.2%-68.5%] | 1.39 | $1.63 | 0.409R | $17.94 | $26.62 | 3 |
| Q3 | 10 | 40.0% | [19.4%-64.8%] | 0.98 | $-0.08 | 0.240R | $-0.78 | $40.93 | 5 |
| Q4 | 11 | 45.5% | [24.2%-68.5%] | 1.11 | $0.50 | 0.409R | $5.50 | $16.44 | 2 |
| Q5 | 11 | 36.4% | [17.5%-60.6%] | 0.77 | $-1.20 | 0.127R | $-13.23 | $35.49 | 4 |

### Fold 6 (test thang 2026-08)

| Quintile | n | Winrate | Wilson 90% CI | PF | Expectancy $ | Expectancy R | PnL$ | Max DD $ | Chuoi thua dai nhat |
|---|---|---|---|---|---|---|---|---|---|
| Q1 | 11 | 72.7% | [48.0%-88.5%] | 3.47 | $6.20 | 1.255R | $68.21 | $17.67 | 2 |
| Q2 | 11 | 54.5% | [31.5%-75.8%] | 1.78 | $2.69 | 0.691R | $29.54 | $18.48 | 2 |
| Q3 | 11 | 81.8% | [57.3%-93.8%] | 6.65 | $7.80 | 1.536R | $85.82 | $9.16 | 1 |
| Q4 | 11 | 36.4% | [17.5%-60.6%] | 0.93 | $-0.38 | 0.127R | $-4.15 | $21.29 | 2 |
| Q5 | 11 | 45.5% | [24.2%-68.5%] | 1.27 | $1.26 | 0.409R | $13.87 | $20.84 | 2 |

## Pooled (gop tat ca lenh cung vi tri quintile qua ca 6 fold — khong phai trung binh cua trung binh)

| Quintile | n (pooled) | Winrate | Wilson 90% CI | PF | Expectancy $ | Expectancy R | PnL$ |
|---|---|---|---|---|---|---|---|
| Q1 | 105 | 64.8% | [56.8%-72.0%] | 2.69 | $4.88 | 1.008R | $512.30 |
| Q2 | 102 | 47.1% | [39.1%-55.2%] | 1.27 | $1.13 | 0.459R | $114.81 |
| Q3 | 104 | 51.9% | [43.9%-59.8%] | 1.51 | $2.04 | 0.610R | $212.04 |
| Q4 | 102 | 47.1% | [39.1%-55.2%] | 1.26 | $1.11 | 0.459R | $113.50 |
| Q5 | 105 | 44.8% | [37.0%-52.8%] | 1.15 | $0.67 | 0.388R | $70.46 |

Pooled monotonic PF (Q1>=..>=Q5)? khong. Pooled monotonic winrate? khong.

_(So lieu tho — khong tu ket luan "5-quintile co du phan giai" hay khong, de Vinh Tam/AI reviewer tu danh gia dua tren n moi Q (~11-32/fold rieng le, lon hon nhieu khi pooled).)_

---

# TICKET-RT-062 Part B — Fold 2 Leave-One-Out Sensitivity Test

Audit-only. Khong dung production, khong sua RT-058/059/060/061. Khong tu ket luan "model on dinh hay khong" — chi bao cao phan phoi + vi tri percentile.

Base pool: tap train Fold 2 TRUOC purge (822 mau — khac voi cach doc dau tien cua ticket, da xac nhan lai voi nguoi dung qua chat truoc khi code: moi lan lap bo 1 mau ngau nhien tu chinh 822 mau nay, tao tap 821-mau, de so sanh truc tiep, cung co-mau, voi AUC=0.6031 da biet cua RT-061 (ban than 0.6031 cung la mot lan chon-bo-1-mau cu the tu 822 — chinh la mau straddle).

Tu-kiem-tra: tai-tao AUC khi bo dung mau straddle (index 821/822, ETHUSDT, closeTime=2026-04-01T02:30:00.000Z) = **0.6031**, khop RT-061's 0.6031 trong dung sai 0.0001.

Seed: mulberry32(seed), seed = 0..29 (chinh la so thu tu lan lap), lay gia tri random dau tien, nhan voi 822 roi lam tron xuong de chon index bi bo. Tai lap 100% khi chay lai file nay.

## 30 lan bo-ngau-nhien-1-mau

| Seed | Dropped index (/822) | AUC |
|---|---|---|
| 0 | 219 | 0.6153 |
| 1 | 515 | 0.5980 |
| 2 | 603 | 0.6286 |
| 3 | 592 | 0.5459 |
| 4 | 759 | 0.5990 |
| 5 | 566 | 0.5776 |
| 6 | 432 | 0.6408 |
| 7 | 9 | 0.6010 |
| 8 | 128 | 0.5612 |
| 9 | 163 | 0.6541 |
| 10 | 412 | 0.6184 |
| 11 | 420 | 0.6153 |
| 12 | 236 | 0.5755 |
| 13 | 465 | 0.6061 |
| 14 | 368 | 0.6092 |
| 15 | 195 | 0.6102 |
| 16 | 519 | 0.6163 |
| 17 | 556 | 0.5663 |
| 18 | 327 | 0.6194 |
| 19 | 48 | 0.6265 |
| 20 | 618 | 0.5776 |
| 21 | 355 | 0.6122 |
| 22 | 511 | 0.5939 |
| 23 | 76 | 0.6347 |
| 24 | 272 | 0.5592 |
| 25 | 491 | 0.6051 |
| 26 | 420 | 0.6153 |
| 27 | 331 | 0.6061 |
| 28 | 352 | 0.6316 |
| 29 | 173 | 0.6112 |

## Phan phoi 30 gia tri AUC

| Median | P10 | P90 | Min | Max |
|---|---|---|---|---|
| 0.6097 | 0.5658 | 0.6319 | 0.5459 | 0.6541 |

## Vi tri cua AUC=0.6031 (bo mau straddle) trong phan phoi 30 lan random

AUC bo-mau-straddle = 0.6031. Trong 30 gia tri random: 11/30 gia tri THAP HON no (percentile rank = 36.7%). Median cua 30 lan random = 0.6097 (chenh lech = -0.0066). Khoang [P10, P90] cua 30 lan random = [0.5658, 0.6319] — gia tri straddle nam trong khoang nay.

_(Khong tu ket luan thay: percentile rank cang gan 0 hoac 100 (cang gan min/max cua phan phoi random) cang ung ho gia thuyet "mau straddle dac biet influential"; percentile rank cang gan 50 (gan median) cang ung ho gia thuyet "model noi chung bat on voi nhieu 1 mau, straddle khong dac biet hon cac mau khac". Vinh Tam/AI reviewer tu doc so lieu tren de danh gia.)_
