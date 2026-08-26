# TICKET-RT-060 — Phase 1 hoan tat: Purge/Embargo Verification + Class Imbalance Check

Audit-only. Khong sua entryRouter/fvg.ts/positionSizing/* hay bat ky code production nao. Khong sua/xoa bat ky file RT-058/RT-059 nao.

Nguon du lieu: mirrored simulation tu-kiem-tra rieng cua ticket nay (purgeEmbargoAudit.ts — KHONG qua simulateOneYearNearLive.ts, KHONG sua xgbFeatureAuditV2.ts vi file do bi dong bang theo RT-059). Ly do can rerun: closeTime khong duoc xgbFeatureAuditV2.ts (RT-059) xuat ra, va khong the bo sung ma khong sua file da dong bang. Tu-kiem-tra khop 100% voi RT-056/057 (n=1217, PnL=$2628.76, PF=1.551).

Cac thang co trong du lieu: 2025-09, 2025-10, 2025-11, 2025-12, 2026-01, 2026-02, 2026-03, 2026-04, 2026-05, 2026-06, 2026-07, 2026-08 (12 thang), cung fold split (expanding window theo thang) nhu RT-058/059.

## Part A — Purge/Embargo: boundary straddle count

Dinh nghia "straddle" (dung nhu ticket yeu cau): lenh co `entryTimestampUtc` roi vao THANG TRAIN CUOI CUNG cua fold (thang train ngay truoc thang test), NHUNG `closeTime` roi vao THANG TEST cua chinh fold do. Day la dieu kien can cho purge/embargo — neu lenh nhu vay ton tai, nhan (won/lost) cua no duoc dung de train mang thong tin gia ca da xay ra MOT PHAN trong ky test, du feature cua no (co dinh tai thoi diem entry) khong bi anh huong.

| Fold | Thang train cuoi | Thang test | So lenh straddle (dung dinh nghia ticket) | Bonus: straddle tu thang train som hon |
|---|---|---|---|---|
| 1 | 2026-02 | 2026-03 | 0 | 0 |
| 2 | 2026-03 | 2026-04 | 1 | 0 |
| 3 | 2026-04 | 2026-05 | 0 | 0 |
| 4 | 2026-05 | 2026-06 | 0 | 0 |
| 5 | 2026-06 | 2026-07 | 0 | 0 |
| 6 | 2026-07 | 2026-08 | 0 | 0 |

Tong so lenh straddle (dung dinh nghia ticket) qua ca 6 fold: **1**.

### Chi tiet lenh straddle

| Fold | Symbol | entryTimestampUtc (UTC) | closeTime (UTC) | Outcome |
|---|---|---|---|---|
| 2 | ETHUSDT | 2026-03-31T17:30:00.000Z | 2026-04-01T02:30:00.000Z | SL |

### Xac minh khong ro ri qua rollingWinRateSameSymbol20 / concurrentOpenPositionsCount (doc code, khong chay lai)

Ca 2 feature phu thuoc trang thai lenh khac deu duoc doc trong file apps/bot/scripts/xgbFeatureAuditV2.ts (RT-059, khong sua o ticket nay). Trich dan bang so dong hien tai cua file do:

- **Vong lap chinh la mot duong di THOI GIAN THUC don le, khong phai theo thu tu mang:** `for (let i = 2; i < nCandles; i++) { for (const st of states) { ... } }` (xgbFeatureAuditV2.ts dong 210-211). `i` la chi so nen M15 tang dan don dieu — moi trang thai (mo/dong lenh, pastOutcomes, exposureState) chi duoc cap nhat khi vong lap di toi dung chi so `i` tuong ung voi thoi diem that. Khong co buoc nao trong file duyet lai theo "thu tu lenh trong mang ket qua" — mang `rows`/`closed` chi la NOI GHI output, khong phai nguon doc.
- **rollingWinRateSameSymbol20 (dong 321-324):** doc tu `st.pastOutcomes`, va `st.pastOutcomes.push(outcome === "TP")` CHI xay ra o dong 265, BEN TRONG nhanh `if (slTouched || tpTouched)` (dong 258) — tuc la CHI khi vong lap da di toi dung chi so `i` ma gia thuc su cham SL/TP cua lenh do. Vi mot symbol CHI co toi da 1 lenh mo tai mot thoi diem (phat hien bi khoa hoan toan trong khi `st.open` khac null — dong 254 `if (st.open) { ... continue; }` chay TRUOC ca nhanh phat hien lenh moi o duoi), moi lenh trong lich su cua 1 symbol chac chan da DONG (that su, theo `i`) truoc khi lenh ke tiep cua CHINH symbol do co the duoc phat hien — nen doc `pastOutcomes` tai thoi diem fill khong bao gio thay outcome cua chinh lenh dang mo hoac bat ky lenh nao chua thuc su dong.
- **concurrentOpenPositionsCount (dong 296):** `const concurrentOpenPositionsCount = exposureState.openPositions.length;` doc TRUOC dong 297 (`admitPosition(...)`) — tuc la trang thai truoc-khi-nhan lenh hien tai. `exposureState` chi thay doi qua `closePosition()` (dong 266, trong nhanh dong lenh, cung dieu kien "da thuc su cham SL/TP" nhu tren) va qua `admitPosition()` (dong 297, khi mot lenh KHAC da duoc nhan truoc do trong CHINH vong lap `i` nay hoac som hon). Vi cac symbol duoc duyet theo thu tu co dinh trong `states` (BTC, ETH, SOL, HYPE, XRP — xgbFeatureAuditV2.ts dong 84) NHUNG cung mot gia tri `i` (cung mot moc thoi gian M15), mot lenh dong/mo cua symbol duyet TRUOC trong cung buoc `i` se duoc phan anh dung cho symbol duyet SAU trong CUNG buoc `i` — dung voi ngu nghia "dong thoi tai thoi diem nay", khong phai loi thu tu.
- **Ket luan doc code:** ca 2 feature deu chi doc trang thai da duoc cap nhat boi CHINH vong lap thoi gian thuc (`i` tang don dieu), khong co duong nao trong file cho phep doc outcome cua mot lenh TRUOC khi vong lap thuc su di toi chi so `i` ma lenh do cham SL/TP. Dieu nay dung KHONG PHU THUOC vao viec co ton tai lenh straddle hay khong — lenh straddle (neu co) van tuan thu dung quy tac nay, no chi co nghia la NHAN (label) cua no duoc gan cho mot lenh nam trong fold train nhung outcome cua no chi "hoan tat" (closeTime) sau khi thang test da bat dau — day la diem Vinh Tam/AI reviewer can tu danh gia co chap nhan duoc hay can them buoc purge/embargo, KHONG phai mot loi feature-level leak nhu preview truoc.

## Part B — Class imbalance check

Toan bo 1217 lenh: 631 TP / 586 SL. Winrate = 51.8% [Wilson 90% CI: 49.5%-54.2%].

| Fold | Train n | Train winrate | Train flag (ngoai 40-60%) | Test n | Test winrate | Test flag (ngoai 40-60%) |
|---|---|---|---|---|---|---|
| 1 | 699 | 52.4% | khong | 123 | 44.7% | khong |
| 2 | 822 | 51.2% | khong | 63 | 55.6% | khong |
| 3 | 885 | 51.5% | khong | 65 | 53.8% | khong |
| 4 | 950 | 51.7% | khong | 158 | 53.8% | khong |
| 5 | 1108 | 52.0% | khong | 54 | 42.6% | khong |
| 6 | 1162 | 51.5% | khong | 55 | 58.2% | khong |

KHONG co fold nao (train hoac test) lech ngoai khoang 40-60% winrate. Luu y: `XGBClassifier` mac dinh (nhu dung trong RT-058/059) khong tu can bang class — mot fold lech xa 50/50 co the anh huong AUC/decile cua fold do, can Vinh Tam/AI reviewer tu danh gia muc do anh huong.

## Khong ket luan Phase 1 dat/khong dat

Ticket nay chi bao cao so do duoc (so lenh straddle + trich dan code + ty le class imbalance). Khong tu ket luan thay Vinh Tam/AI reviewer, va khong bat dau bat ky phan nao cua Shadow Mode (Phase 4).
