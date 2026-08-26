# TICKET-RT-064 — So sanh 4 phuong an Feature/Hyperparameter: Quintile Quality + Robustness

Audit-only. Khong dung production, khong sua RT-058..063.

Pipeline: import truc tiep xgbFeatureAuditV3.ts (frozen) — cung purge logic RT-061, cung 6 fold. Tu-kiem-tra khop 100% RT-056/057 (n=1217, PnL=$2628.76, PF=1.551).

## 4 phuong an

| Ky hieu | Mo ta |
|---|---|
| A (v1) | 8 feature goc RT-058 |
| B (v2) | 14 feature RT-059 (baseline hien tai) |
| C (toi gian) | 4 feature: fvgGapSizePct, keyZoneDistancePct, atrH1Pct, slPct |
| D (v2 + reg) | 14 feature, subsample=0.8, colsample_bytree=0.8 |

## Part A — PF theo Top/Middle/Bottom, 4 phuong an x 6 fold

### A (v1, 8 feature)

| Fold | Top n | Top PF | Top Winrate | Middle n | Middle PF | Middle Winrate | Bottom n | Bottom PF | Bottom Winrate |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 25 | 1.46 | 48.0% | 73 | 1.04 | 42.5% | 25 | 1.10 | 48.0% |
| 2 | 13 | 8.25 | 84.6% | 37 | 1.30 | 51.4% | 13 | 0.94 | 38.5% |
| 3 | 13 | 3.11 | 69.2% | 39 | 2.05 | 59.0% | 13 | 0.38 | 23.1% |
| 4 | 32 | 2.98 | 65.6% | 94 | 1.53 | 51.1% | 32 | 1.47 | 50.0% |
| 5 | 11 | 2.32 | 63.6% | 32 | 0.84 | 34.4% | 11 | 0.99 | 45.5% |
| 6 | 11 | 3.20 | 72.7% | 33 | 1.55 | 51.5% | 11 | 2.98 | 63.6% |

### B (v2, 14 feature)

| Fold | Top n | Top PF | Top Winrate | Middle n | Middle PF | Middle Winrate | Bottom n | Bottom PF | Bottom Winrate |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 25 | 1.71 | 52.0% | 73 | 0.89 | 39.7% | 25 | 1.50 | 52.0% |
| 2 | 13 | 3.99 | 76.9% | 37 | 1.34 | 48.6% | 13 | 1.44 | 53.8% |
| 3 | 13 | 4.71 | 76.9% | 39 | 1.82 | 56.4% | 13 | 0.43 | 23.1% |
| 4 | 32 | 3.53 | 68.8% | 94 | 1.52 | 51.1% | 32 | 1.30 | 46.9% |
| 5 | 11 | 1.23 | 45.5% | 32 | 1.16 | 43.8% | 11 | 0.77 | 36.4% |
| 6 | 11 | 3.47 | 72.7% | 33 | 2.00 | 57.6% | 11 | 1.27 | 45.5% |

### C (toi gian, 4 feature)

| Fold | Top n | Top PF | Top Winrate | Middle n | Middle PF | Middle Winrate | Bottom n | Bottom PF | Bottom Winrate |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 25 | 1.54 | 52.0% | 73 | 0.97 | 39.7% | 25 | 1.23 | 52.0% |
| 2 | 13 | 6.75 | 84.6% | 37 | 1.43 | 51.4% | 13 | 0.73 | 38.5% |
| 3 | 13 | 4.59 | 76.9% | 39 | 1.48 | 51.3% | 13 | 0.90 | 38.5% |
| 4 | 32 | 3.24 | 68.8% | 94 | 1.51 | 50.0% | 32 | 1.45 | 50.0% |
| 5 | 11 | 2.34 | 63.6% | 32 | 1.01 | 40.6% | 11 | 0.49 | 27.3% |
| 6 | 11 | 3.35 | 72.7% | 33 | 1.39 | 48.5% | 11 | 4.07 | 72.7% |

### D (v2 + regularization)

| Fold | Top n | Top PF | Top Winrate | Middle n | Middle PF | Middle Winrate | Bottom n | Bottom PF | Bottom Winrate |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 25 | 1.69 | 52.0% | 73 | 0.99 | 42.5% | 25 | 1.09 | 44.0% |
| 2 | 13 | 2.83 | 69.2% | 37 | 2.32 | 62.2% | 13 | 0.30 | 23.1% |
| 3 | 13 | 4.35 | 76.9% | 39 | 1.54 | 51.3% | 13 | 0.83 | 38.5% |
| 4 | 32 | 2.30 | 59.4% | 94 | 1.67 | 53.2% | 32 | 1.46 | 50.0% |
| 5 | 11 | 3.93 | 72.7% | 32 | 0.66 | 31.3% | 11 | 1.25 | 45.5% |
| 6 | 11 | 1.15 | 45.5% | 33 | 4.16 | 72.7% | 11 | 0.58 | 27.3% |


---

## Part B — Robustness (nhieu du lieu, giong RT-063 Phan A), 4 phuong an

Phuong phap: 30 lan bootstrap-resample train set sau purge (co hoan lai, cung kich thuoc goc, mulberry32(iteration) iteration=0..29, dung lai moi fold) — CUNG mot bo 30 lan resample duoc dung lai cho ca 4 phuong an trong 1 fold (chi khac cot feature). So voi Top-20% baseline (khong nhieu, random_state=42) cua chinh phuong an do.

### A (v1, 8 feature)

| Fold | Top size (baseline) | Overlap% (mean) | Overlap% (min-max) | Spearman (mean) | Spearman (min-max) |
|---|---|---|---|---|---|
| 1 | 25 | 61.5% | 48.0%-80.0% | 0.548 | 0.154-0.786 |
| 2 | 13 | 50.8% | 30.8%-76.9% | 0.366 | -0.407-0.863 |
| 3 | 13 | 54.4% | 38.5%-76.9% | 0.518 | -0.110-0.923 |
| 4 | 32 | 62.0% | 43.8%-75.0% | 0.351 | 0.014-0.658 |
| 5 | 11 | 53.3% | 27.3%-72.7% | 0.472 | 0.127-0.882 |
| 6 | 11 | 70.0% | 36.4%-90.9% | 0.648 | 0.127-0.918 |

### B (v2, 14 feature)

| Fold | Top size (baseline) | Overlap% (mean) | Overlap% (min-max) | Spearman (mean) | Spearman (min-max) |
|---|---|---|---|---|---|
| 1 | 25 | 55.5% | 24.0%-72.0% | 0.551 | 0.138-0.782 |
| 2 | 13 | 50.0% | 38.5%-69.2% | 0.340 | -0.225-0.780 |
| 3 | 13 | 56.2% | 30.8%-76.9% | 0.401 | 0.011-0.769 |
| 4 | 32 | 61.5% | 46.9%-71.9% | 0.507 | 0.229-0.792 |
| 5 | 11 | 48.2% | 18.2%-72.7% | 0.564 | -0.055-0.909 |
| 6 | 11 | 53.3% | 27.3%-81.8% | 0.450 | -0.118-0.891 |

### C (toi gian, 4 feature)

| Fold | Top size (baseline) | Overlap% (mean) | Overlap% (min-max) | Spearman (mean) | Spearman (min-max) |
|---|---|---|---|---|---|
| 1 | 25 | 62.1% | 48.0%-80.0% | 0.533 | 0.048-0.823 |
| 2 | 13 | 64.4% | 38.5%-92.3% | 0.271 | -0.346-0.725 |
| 3 | 13 | 51.8% | 30.8%-69.2% | 0.494 | 0.055-0.830 |
| 4 | 32 | 59.2% | 40.6%-75.0% | 0.473 | 0.223-0.688 |
| 5 | 11 | 61.5% | 27.3%-81.8% | 0.373 | -0.109-0.809 |
| 6 | 11 | 63.0% | 36.4%-90.9% | 0.503 | -0.036-0.836 |

### D (v2 + regularization)

| Fold | Top size (baseline) | Overlap% (mean) | Overlap% (min-max) | Spearman (mean) | Spearman (min-max) |
|---|---|---|---|---|---|
| 1 | 25 | 57.7% | 24.0%-76.0% | 0.413 | 0.043-0.626 |
| 2 | 13 | 55.9% | 30.8%-69.2% | 0.465 | 0.044-0.868 |
| 3 | 13 | 61.0% | 38.5%-84.6% | 0.398 | -0.126-0.797 |
| 4 | 32 | 61.1% | 46.9%-71.9% | 0.517 | 0.189-0.748 |
| 5 | 11 | 57.3% | 36.4%-81.8% | 0.527 | 0.073-0.827 |
| 6 | 11 | 60.6% | 18.2%-81.8% | 0.483 | 0.027-0.818 |

_(So lieu tho, khong tu ket luan phuong an nao "on dinh hon".)_

---

## Part C — Tong hop: 1 dong / phuong an

Khong tu chon "phuong an thang" — trinh bay so, de Vinh Tam/AI reviewer quyet dinh dua tren danh doi (PF cao nhat chua chac on dinh nhat).

| Phuong an | PF Top trung binh (pooled qua 6 fold) | Overlap% trung binh | Spearman trung binh |
|---|---|---|---|
| A (v1, 8 feature) | 2.73 | 58.7% | 0.484 |
| B (v2, 14 feature) | 2.69 | 54.1% | 0.469 |
| C (toi gian, 4 feature) | 2.89 | 60.3% | 0.441 |
| D (v2 + regularization) | 2.27 | 58.9% | 0.467 |

_(PF Top pooled: gop tat ca lenh Top-20% cua phuong an do qua ca 6 fold roi tinh 1 PF tong the — khong phai trung binh cua 6 PF rieng le. Overlap%/Spearman: trung binh cua 6 gia tri trung binh-theo-fold.)_
