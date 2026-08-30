# TICKET-RT-086 — Xac nhan doc lap RT-084 + Dieu tra khoang lech PF

## Phan A — Khoi phuc + xac nhan doc lap RT-084

Khoi phuc 8 file bi xoa o commit `ef34caa` (nguon: `68be438`) khong sua gi:
`apps/bot/data/rt084Intrabar1m.csv`, `apps/bot/reports/RT-084-current-trend-live-like-baseline.md`,
`apps/bot/scripts/research/fetchRt084Intrabar.ts`, `apps/bot/scripts/research/rt084CurrentTrendLiveLikeBaseline.ts`,
`apps/bot/src/research/trendLiveLikeCandidates.ts`, `apps/bot/src/research/trendLiveLikeExecution.ts`,
`apps/bot/src/research/trendLiveLikeExecution.test.ts`, 2 dong script trong `package.json`.

Chay lai (`npx tsx apps/bot/scripts/research/rt084CurrentTrendLiveLikeBaseline.ts`), khong sua code:

```
Eligible=7133; M1 blocks=56404; mismatches=2
Realistic: filled=4919; netPF=0.936; netExp=-0.047R; netR=-229.0; maxDD=305.1R
```

**Khop 100% voi so da chot cua ticket** (Eligible=7133, filled=4919, netPF=0.936, netExp=-0.047R,
netR=-229.0, maxDD=305.1R). Report markdown tai sinh ra cung khop tung dong voi ban da co (da doi
chieu bang `M15 conventional comparator` = 1.819, khong doi). Chay lai test don vi da khoi phuc
(`trendLiveLikeExecution.test.ts`): **7/7 pass**.

Ket luan: day KHONG phai bug hay bia dat — la ket qua that, tai lap doc lap thanh cong.

## Phan B — Co lap tung bien: 1.819 (M15 conventional) -> 1.451 (RT-DOGE-001)

Phuong phap: waterfall tren **DUNG 7,133 candidate dong bang** cua RT-084 (khong doi bat ky
backtest cu nao), doi **DUNG MOT bien** moi buoc, do lai Net PF. Buoc 0 (baseline) da tai lap chinh
xac 1.819 (n=5902, wins=2943, WR=49.9%) bang code doc lap cua toi truoc khi doi bat ky bien nao —
xac nhan phuong phap dung truoc khi doi.

| Buoc | Thay doi them vao | Net PF | Delta so buoc truoc |
|---|---|---:|---:|
| 0 | (baseline) RT-084 M15 conventional comparator | **1.819** | — |
| 1 | + Yeu cau NTZ khong bi block tai nen khop lenh (RT-DOGE-001's `!ntz.blocked`) | 1.821 | +0.002 |
| 2 | + Doi hang so phi ve dung RT-DOGE-001 (flat 0.2% notional thay vi 0.02%/0.05% tach entry/exit) | **1.427** | **-0.395** |
| 3 | + Portfolio exposure/sizing admission (candidate suppression toan danh muc) | 1.435 | +0.008 |
| 4 | + Trong so theo $ that (thay vi dem R binh dang moi lenh) | 1.436 | +0.001 |
| — | RT-DOGE-001 goc (muc tieu) | 1.451 | phan du = +0.015 |

### Ket luan Phan B — ro rang, khong mo ho

**Hang so phi la nguyen nhan gan nhu DUY NHAT** cua khoang lech 1.819 -> 1.451 (dong gop -0.395,
lon hon ca khoang lech thuc te 0.368 — 2 buoc con lai (portfolio admission + trong so $) thuc ra
KEO PF LEN LAI mot chut, khong keo xuong). Con:
- **Cach khop gap (NTZ-tai-fill)**: gan nhu khong dong gop gi (+0.002) — chi 48/5902 lenh bi loai
  khac biet.
- **Candidate suppression qua portfolio exposure**: nho (+0.008) — chi 34/5854 lenh bi tu choi do
  vuot han muc margin 70% toan danh muc, va viec tu choi nay tinh co lai LAM TANG PF nhe (cac lenh
  bi loai không thien ve phia thua nhieu hon lenh duoc giu).
- **Don vi bao cao $/% vs R**: KHONG phai bien doc lap thu 6 — day chi la he qua cua viec dinh gia
  lai theo size that (Buoc 4), va tac dong do do gan bang khong (+0.001, chi 61/5820 lenh bi scale
  down bo portfolio cap, khong du de lech PF dang ke).
- **Phan du con lai** (+0.015, RT-DOGE-001 that = 1.451 vs tai lap cua toi = 1.436): nho, giai
  thich hop ly boi (a) breaksKeyZone cua HYPEUSDT khong luu duoc tren candidate dong bang (gia dinh
  false, chi anh huong sizing/margin cua rieng HYPE, khong anh huong thang/thua), (b) RT-DOGE-001
  dung mot code path mo phong doc lap rieng (`rtDogeThreeYearBacktest.ts`) thay vi goi thang
  `SymbolSignalEngine`, nen co the lech nho o cach lam tron/thu tu xu ly.

**Ham y quan trong cho quyet dinh mainnet**: hang so phi RT-DOGE-001 dung (flat 0.2% round-trip)
**cao hon** hang so phi RT-084 dung cho ca so M1 "hien thuc" (0.936) (0.02%/0.05% tach rieng, ~0.07%
tong). Kiem tra bo sung (script `rt086M1WithDogeFee.ts`, chay tren dung 7,133 candidate + du lieu
M1 that):

```
M1 realistic, RT-084 fee (dung so hien thi cua RT-084)      : netPF=0.936, netExpR=-0.047, netR=-229.0
M1 realistic, RT-DOGE-001 fee (cung chuan phi da dung de xanh den mainnet): netPF=0.734, netExpR=-0.225, netR=-1108.7
```

Neu danh gia bang **dung** chuan phi da tung dung de tin tuong chien luoc (RT-DOGE-001's 0.2%), thi
o do phan giai M1 thuc te, Net PF con thap hon nua: **0.734**, khong phai 0.936. Buc tranh that con
xau hon con so headline cua RT-084.

## Phan C — De xuat huong di (chi bang loi, KHONG code)

Du lieu chinh: chien luoc hien tai o do phan giai M15 (dung de quyet dinh mainnet ban dau) cho PF
~1.4-1.8 tuy chuan phi; o do phan giai M1 (gan voi thuc te khop lenh that hon), PF roi ve **0.936
(chuan phi RT-084) den 0.734 (chuan phi RT-DOGE-001)** — deu duoi 1, tuc ky vong am sau phi tren
toan bo 3 nam.

**Phuong an 1 — Dieu chinh nguong de bu rui ro trong-nen (minSlPctFloor va/hoac targetR)**
- Uu: gia thiet hop ly nhat de "sua" van de goc (SL dat qua sat gia khien mot ty le lon lenh bi
  quet SL ngay trong 15 phut do bien dong trong nen, thu hep bang tang khoang cach SL se giam ty le
  nay). Khong doi kien truc, chi doi 2 hang so da co san co che sweep tu RT-028/029/RT-042..045.
- Nhuoc: **chua co bang chung** rang tang floor se sua duoc van de — can sweep lai TREN DO PHAN GIAI
  M1 (khong phai M15 nhu cac sweep RT-028/042 truoc day) de xac nhan, vi chinh sweep M15 cu la thu
  da an di van de nay tu dau. Co nguy co "vá" mot con so ma khong hieu ban chat (rui ro trong-nen co
  the van con o muc SL rong hon, chi giam bot).

**Phuong an 2 — Nghien cuu sau them bang M1 truoc khi quyet dinh (sweep minSlPctFloor/targetR TREN
M1, khong phai M15)**
- Uu: dung phuong phap luan RT-084 da xay (co san, da xac nhan doc lap) de sweep lai cac tham so
  chien luoc o DUNG do phan giai co the phat hien van de — day la cach lam dung dan nhat de tra loi
  "Phuong an 1 co thuc su sua duoc khong" truoc khi doi bat ky config nao.
- Nhuoc: ton them thoi gian (moi lan sweep 1 gia tri can chay lai toan bo M1 replay, ~25-30 phut/lan
  theo thoi gian da do o Phan A/B); can quyet dinh truoc pham vi sweep (bao nhieu gia tri
  minSlPctFloor/targetR) de tranh keo dai vo han.

**Phuong an 3 — Hoan mainnet, cho them du lieu giai doan gan nhat (testnet DOGE dang chay)**
- Uu: an toan nhat, khong doi gi ca — testnet dang chay that (RT-078..081) se tu tich luy du lieu
  M1-that (khop lenh that, khong phai mo phong) trong vai tuan, cho phep doi chieu true edge that
  thay vi chi dua vao backtest.
- Nhuoc: cham nhat — neu chien luoc thuc su co edge duong (PF>1 that su o M1), tri hoan mainnet
  dong nghia mat co hoi trong luc do. Testnet 3-5 ngay (RT-079 Phan C) la qua ngan de co ket luan
  thong ke chac chan ve edge that (7,133 candidate/3 nam moi cho PF on dinh; vai chuc lenh
  testnet/tuan se can hang thang moi co du mau tuong duong).

**Khong de xuat**: giu nguyen ke hoach mainnet dua tren so PF cu (1.4-1.8, tinh o M15) ma khong xu
ly gi — Phan A+B da chung minh con so do dua tren mot gia dinh don gian hoa (nen M15 = 1 khoi) DA
BIET la sai lech dang ke so voi thuc te khop lenh, va them nua, dung theo dung chuan phi da dung de
tin tuong chien luoc thi con so M1 con te hon (0.734).

**De xuat ca nhan** (chi de tham khao, Vinh Tam quyet dinh): **Phuong an 2 truoc, roi Phuong an 3**
— sweep nhanh minSlPctFloor/targetR tren M1 (da co code san, chi mat vai gio chay) de biet chac
chan co huong sua kha thi hay khong, TRUOC khi quyet dinh giua "sua config roi mainnet" hay "hoan
mainnet cho du lieu testnet dai hon". Khong lam Phuong an 1 truoc khi co bang chung tu Phuong an 2.

## Ghi chu moi truong (khong lien quan RT-086)

Trong luc chay lai, phat hien dong ho he thong cuc bo lech ~5.6 giay so voi server Binance (vuot
recvWindow 5000ms mac dinh), khien 6/13 test tich hop that trong `binanceOrderClient.test.ts` (dat
lenh/leverage that qua API) that bai voi loi `-1021`. Day la van de dong ho MAY LOCAL cua toi
(Windows Time service khong chay, khong sua duoc trong quyen han hien tai), **khong lien quan gi
den code RT-086** (khong dung file nao). Toan bo 218 test con lai (logic/pure/M15/M1 nghien cuu,
khong goi API that) pass sach. Neu VPS that cung tung gap loi `-1021` trong log — day la dieu can
kiem tra rieng (dong ho VPS), khong phai bug code.
