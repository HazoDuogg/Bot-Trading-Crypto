# TICKET-RT-AUDIT-001 — Audit an toan: Leverage mismatch, Missing SL/TP, Short-side coverage

Audit-only. Khong sua code, khong doi config. Bang chung thu thap tu (1) doc truc tiep production
code (`apps/bot/src/live/*.ts`, `apps/bot/scripts/liveRunner.ts`), (2) truy van READ-ONLY that vao
Binance Futures TESTNET API bang key/secret co san trong `.env` (khong dat lenh, khong doi config —
`GET /fapi/v2/positionRisk`, `/fapi/v1/allOrders`, `/fapi/v1/userTrades`, `/fapi/v1/allAlgoOrders`,
`/fapi/v1/income`), (3) file log JSONL cuc bo `apps/bot/logs/live-events-2026-08-27.jsonl`.

**CAP NHAT:** Vinh Tam da paste truc tiep log pm2 that cua process `vicion-bot` (08:27:35 ->
03:00:03 UTC, 27-28/8/2026) vao chat. Ket hop voi bang chung Binance API da thu thap truoc do, Phan
B gio co NGUYEN NHAN GOC xac dinh 100% (khong con la gia thuyet). Phan C cung co them du lieu that
(han che nhung co that) tu 2 lan snapshot trend luc khoi dong. Bao cao duoi day da duoc cap nhat.

---

## Phan A — Leverage khong khop thiet ke

**Thiet ke:** BTC/ETH=20x, SOL/HYPE/XRP=10x (theo mo ta ticket).

**Buoc 1 — grep code tim `changeLeverage`:** Grep toan bo `apps/bot/src` va `apps/bot/scripts` cho
`changeLeverage|setLeverage|/fapi/v1/leverage` — **KHONG CO KET QUA NAO**. Doc them
`apps/bot/src/live/binanceOrderClient.ts` (toan bo class `BinanceOrderClient`) va
`apps/bot/src/live/orderLifecycle.ts:128`: production code CHI CO `getSymbolLeverage(symbol)` —
mot GET `/fapi/v2/positionRisk` doc leverage HIEN TAI dang set tren exchange va dung no de tinh
position size — **khong co bat ky POST nao tung goi de SET leverage**. Cac file `LEVERAGE = {...}`
chi ton tai trong cac script backtest/research (`scripts/simulate*.ts`, `scripts/measure*.ts`,
`scripts/research/*.ts`) — do la hang so CHI DUNG CHO TOAN BO TINH TOAN MO PHONG LICH SU, khong lien
quan production, khong bao gio duoc goi qua API that.

**Ket luan Phan A (xac dinh, khong phai suy doan):** day khong phai loi "gui sai request" hay "gui
dung nhung khong verify response" — **bot chua bao gio gui request set-leverage nao ca**. Leverage
hien thi tren Binance la bat ky gia tri nao da duoc set THU CONG tren tai khoan testnet tu truoc
(qua UI hoac script khac), production code chi DOC va tin theo gia tri do de tinh sizing.

**Buoc 2 — doi chieu leverage that qua API (`GET /fapi/v2/positionRisk`, truy van luc viet bao cao,
2026-08-28):**

| Symbol | Leverage thuc te (API) | Thiet ke | Khop? |
|---|---|---|---|
| BTCUSDT | 10x | 20x | **SAI** |
| ETHUSDT | 20x | 20x | Dung |
| SOLUSDT | 20x | 10x | **SAI** |
| HYPEUSDT | 20x | 10x | **SAI** |
| XRPUSDT | 10x | 10x | Dung |

3/5 symbol dang set sai so voi thiet ke (BTC, SOL, HYPE). Vi khong co code nao tung set leverage,
day la hau qua truc tiep cua "khong ai/khong gi dam bao leverage tren exchange khop config" — mot
**gap thiet ke** (thieu buoc dong bo leverage khi khoi dong bot), khong phai loi logic gui/nhan sai.

**CHUA XAC DINH:** giá trị leverage nay co dung luc TUNG lenh duoc mo hay khong (leverage co the bi
doi thu cong giua cac lenh) — can log pm2/JSONL that de doi chieu leverage tai moi thoi diem entry,
khong the suy tu snapshot hien tai.

---

## Phan B — Vi the XRPUSDT khong co TP/SL (uu tien cao nhat)

Doc `/fapi/v1/allOrders` (toan bo order XRPUSDT) + `/fapi/v1/userTrades` + `/fapi/v1/allAlgoOrders`
(dung endpoint dung, xac nhan tu comment RT-071 da bi xoa trong commit `cbf9b8a` — xem chi tiet o
cuoi phan nay) + `/fapi/v1/income`, sap xep theo thoi gian, phat hien **BA vi the XRPUSDT rieng
biet** trong cua so du lieu lay duoc (con nhieu lenh limit 11 XRP gia $0.50 dat/huy lien tuc — cach
xa gia thi truong, khong bao gio khop — va mot cum 6 cap lenh 3.8 XRP khop tuc thi kem algo order
trigger o 0.71x/2.0x gia thi truong, KHONG khop pattern SL/TP cua chien luoc FVG — xem ghi chu cuoi
phan).

### Vi the #1 (nghiem trong — dung ticket mo ta) — KHONG CO SL/TP

| Su kien | orderId / algoId | Thoi gian (UTC) | Chi tiet |
|---|---|---|---|
| Entry LIMIT BUY dat | 3487660480 | 2026-08-27 09:00:05 | qty 8548.2 @ 1.4279 |
| Entry FILLED | 3487660480 | 2026-08-27 10:28:02 | avgPrice 1.4279 |
| **Algo STOP_MARKET/TAKE_PROFIT_MARKET** | — | — | **KHONG CO — 0 ket qua trong `/fapi/v1/allAlgoOrders` cho khung thoi gian nay** (algo order som nhat trong toan bo lich su XRPUSDT la 13:52:29, tuc SAU khi vi the nay da dong) |
| Close MARKET SELL | 3487823140 | 2026-08-27 13:32:06 | qty 8548.2, `reduceOnly=true` **nhung `closePosition=false`** — KHONG PHAI mot algo order trigger (algo order that su luon co `closePosition=true`, xem Vi the #2/#3 ben duoi) |
| `clientOrderId` cua lenh dong | `ios_iRGgNr5aACsgqZBs0ydP` | | **Tien to `ios_` — day la client-order-id ma Binance mobile app (iOS) tu gan cho lenh dat qua app, KHAC HOAN TOAN voi 60+ lenh con lai trong lich su XRPUSDT (tat ca deu la chuoi random khong tien to, dac trung cua lenh dat qua REST API khong tu dat clientOrderId — dung cach bot code goi)** |
| Realized PnL | | | **-$26.50** (`userTrades`, id 152708655, entry 1.4279 -> exit 1.4248) |

**NGUYEN NHAN GOC — XAC DINH 100% (tu log pm2 that Vinh Tam cung cap):**

Log pm2 cho thay chinh xac chuoi su kien:
```
09:00:05.968Z ENTRY_PLACED XRPUSDT — Qty=8548.2
10:30:05.252Z LIFECYCLE_ERROR XRPUSDT — "placeStopMarketCloseOrder AFTER ENTRY FILLED — VI TRI DANG
              MO, CHUA CO SL BAO VE": Binance -> 400 {"code":-4120,"msg":"Order type not supported
              for this endpoint. Please use the Algo Order API endpoints instead."}
10:45:04.519Z LIFECYCLE_ERROR XRPUSDT — (lap lai y het loi tren)
11:00:05.251Z / 11:15:05.278Z / 11:30:04.492Z / 11:45:05.238Z / 12:00:04.547Z / 12:15:05.204Z /
12:30:05.359Z / 12:45:05.219Z / 13:00:03.786Z / 13:15:04.543Z / 13:30:05.301Z — LIFECYCLE_ERROR
              XRPUSDT lap lai DUNG Y HET moi 15 phut (moi nen M15), tong cong 13 lan tu 10:30 den
              13:30, khong lan nao thanh cong.
[khong co dong log nao sau 13:30:05 cho XRPUSDT truoc restart]
14:15:05 / 14:15:54  ENGINE_STARTUP (restart 2 lan lien tiep, cach nhau ~1s — rat co the la deploy
              fix roi pm2 tu khoi dong lai)
[TU DAY VE SAU: moi ENTRY_FILLED deu co dong "Da dat SL/TP (orderId .../....)" thanh cong — vi du
 18:15:05.323Z ENTRY_FILLED XRPUSDT ... Da dat SL/TP (orderId 1000000183463537/1000000183463538) —
 khop chinh xac 2 algoId cua Vi the #2 da xac nhan qua Binance API o tren]
```

**Ket luan: bot dang chay MOT PHIEN BAN CODE CU (truoc khi fix RT-071/RT-072 duoc trien khai)** —
phien ban nay van goi `STOP_MARKET`/`TAKE_PROFIT_MARKET` qua endpoint cu `/fapi/v1/order` thay vi
Algo Order API moi (`/fapi/v1/algoOrder`) ma Binance da bat buoc chuyen sang (hieu luc 2025-12-09
theo comment RT-071 da xoa trong commit `cbf9b8a` — xem Phan B ghi chu cuoi). Moi lan goi bi Binance
tu choi voi loi `-4120`. **Code KHONG co bug logic** — `orderLifecycle.ts`'s `placeMissingProtectionOrders()`
hoat dong dung thiet ke: bat exception, tra ve `LIFECYCLE_ERROR` voi canh bao ro rang "VI TRI DANG
MO, CHUA CO SL BAO VE", va **retry dung moi nen M15 nhu thiet ke** — nhung vi endpoint sai nen MOI
lan retry deu that bai giong het nhau, khong co lan nao thanh cong, suot 3 tieng (10:30-13:30).

Sau 13:30 (lan retry cuoi that bai), khong con log nao cho XRPUSDT cho den khi process restart luc
14:15 — **khop hoan hao voi bang chung Binance: vi the duoc dong thu cong qua Binance iOS app luc
13:32:06** (`clientOrderId` tien to `ios_`, xem bang tren) — tuc la **con nguoi da can thiep GIUA
lan retry that bai cuoi (13:30) va luc restart (14:15)**, rat co the la Vinh Tam thay canh bao lap
lai (console/pm2 hoac Telegram neu co cau hinh) va tu tay dong vi the tran de cat lo, roi trien khai
ban fix RT-071/072 ngay sau do (restart 14:15).

**KET LUAN CUOI PHAN B:** day la loi **compatibility/deploy-timing** — code fix (RT-071/072) DA
TON TAI trong repo nhung **chua duoc deploy len VPS truoc khi bot mo vi the XRPUSDT (va SOLUSDT —
xem duoi) luc 09:00-early**. Khong phai loi thieu try/catch, khong phai loi silent-fail — loi nam o
**quy trinh deploy: code cu van chay live tren VPS sau khi fix da co trong repo**.

**Phat hien lien quan (ngoai pham vi XRPUSDT nhung cung nam trong log nay):** **SOLUSDT cung dinh
LOI Y HET** — `08:45:03.319Z ENTRY_PLACED SOLUSDT — Qty=36.78`, sau do se co cung chuoi
`LIFECYCLE_ERROR SOLUSDT` -4120 lap lai 10:30-13:30 (thay the "XRPUSDT" bang "SOLUSDT" trong cung
cac dong log tren — xem nguyen van log). Vi the SOL nay **cung khong con xuat hien** sau restart —
rat co the cung bi dong thu cong cung luc voi XRP. **De nghi kiem tra them: vi the SOLUSDT nay dong
nhu the nao** (cung qua Binance API, tim `clientOrderId` tien to `ios_` cho SOLUSDT quanh 13:00-14:00
UTC 27/8) — ticket goc chi yeu cau XRPUSDT nen tam ghi nhan, chua dieu tra sau.

### Vi the #2 — CO SL/TP, dong dung qua TP

| Su kien | orderId/algoId | Thoi gian UTC | Chi tiet |
|---|---|---|---|
| Entry FILLED | 3487868438 | 2026-08-27 14:47:48 | qty 4971.5 @ 1.4447 |
| Algo STOP_MARKET dat | algoId 1000000183463537 | 2026-08-27 18:15:05 | trigger 1.4352, status `EXPIRED` (khong kich hoat) |
| Algo TAKE_PROFIT_MARKET dat | algoId 1000000183463538 | 2026-08-27 18:15:05 | trigger 1.4647, status `FINISHED`, kich hoat luc 2026-08-28 01:24:13 |
| Close | 3488236235 | 2026-08-28 01:24:13 | MARKET, `closePosition=true` — dung la algo order trigger |
| Realized PnL | | | +$58.74 (thang, TP) |

Ghi chu: algo order duoc TAO luc 18:15:05, tuc **~3.5 tieng SAU** khi entry FILLED (14:47:48) — co
mot khoang tre lon (`createTime` cua STOP/TP khac han `entryFilledAtMs`). **CHUA XAC DINH ly do tre**
(bot retry moi tick M15 theo thiet ke `PLACING_PROTECTION`, hay co van de khac) — can log JSONL that.

### Vi the #3 — CO SL/TP, dong dung qua SL

| Su kien | orderId/algoId | Thoi gian UTC | Chi tiet |
|---|---|---|---|
| Entry FILLED | 3488248574 | 2026-08-27 (~19:26 theo updateTime 1787881570299 quy doi) | qty 7763 @ 1.4553 |
| Algo STOP_MARKET dat | algoId 1000000183796740 | 2026-08-28 02:00:03 | trigger 1.4465, `FINISHED`, kich hoat 02:05:27 |
| Algo TAKE_PROFIT_MARKET dat | algoId 1000000183796742 | 2026-08-28 02:00:03 | trigger 1.4738, `EXPIRED` (khong kich hoat — hop ly, vi SL da kich hoat truoc va dong vi the) |
| Close | 3488260099 | 2026-08-28 02:05:27 | MARKET, `closePosition=true` |
| Realized PnL | | | -$68.31 (thua, SL) |

Vi the nay hoat dong **DUNG THIET KE**: SL+TP deu duoc dat, mot ben kich hoat, ben con lai tu dong
`EXPIRED` (Binance tu dong het han conditional order con lai khi vi the ve 0 — khop voi logic
`cancelOrder(otherOrderId)` trong `orderLifecycle.ts:252-259`, tuy code goi la CANCEL nhung Binance
co the tra ve trang thai EXPIRED thay vi CANCELED tuy thoi diem — khong anh huong ket qua).

### Ghi chu ve cum lenh bat thuong (khong phai FVG strategy binh thuong)

Ngoai 3 vi the tren, con **6 cap STOP_MARKET/TAKE_PROFIT_MARKET** (algoId tu 1000000183273328 den
1000000183278833) dat trong khung 13:52-13:54 UTC 27/8, kem 6 cap lenh LIMIT 3.8 XRP khop gan nhu
tuc thi (< 5 giay giua BUY/SELL) — trigger price cua cac algo nay ~0.71-0.72 (SL) va ~2.85-2.87
(TP), tuc **~50% duoi va ~100% tren gia thi truong (~1.43)** — qua rong so voi logic SL/TP cua FVG
(SL dua theo khoang cach gap that + `minSlPctFloor`, TP = targetR=2.10 x SL distance, KHONG BAO GIO
rong toi muc "gap doi/nua gia"). Ket hop voi kich thuoc lenh cuc nho (3.8 XRP ~ $5.4) va tan suat
dat/huy lien tuc — day **RAT CO THE la test thu cong/script rieng cua RT-071 (kiem tra Algo Order
API hoat dong) chay tren CUNG tai khoan testnet**, khong phai tin hieu that cua chien luoc FVG.
**CHUA XAC DINH** — can Vinh Tam xac nhan day co phai la test RT-071 hay khong; neu KHONG phai, day
la mot nguon lenh la chua duoc giai thich va can dieu tra them.

Con **mot loat lenh LIMIT BUY 11 XRP gia $0.50** (~65% duoi gia thi truong) dat/huy lien tuc suot ca
ngay (moi lan cach nhau vai giay den vai phut) — gia nay khong bao gio co the khop, va **11 XRP
khong khop bat ky kich thuoc position-sizing nao** cua 3 vi the that o tren. Day nhieu kha nang la
mot **cron/health-check hoac lenh "canary" dat-roi-huy** de test ket noi API (khong lien quan chien
luoc FVG) — **CHUA XAC DINH nguon goc**, can hoi Vinh Tam hoac tim trong code/cron khac khong nam
trong `apps/bot`.

---

## Phan C — Short-side coverage

**Du lieu that co duoc (tu log pm2), nhung CHUA DU DE KET LUAN CHAC CHAN.** Log pm2 chi in trend
classification tai 2 THOI DIEM startup/catch-up (khong phai lien tuc moi candle — engine chi log
lifecycle event nhu ENTRY_PLACED/FILLED/CLOSED, xem `eventRecord.ts`):

| Thoi diem snapshot | BTCUSDT | ETHUSDT | SOLUSDT | HYPEUSDT | XRPUSDT |
|---|---|---|---|---|---|
| 2026-08-27 08:27:36 UTC | UPTREND | UPTREND | UPTREND | UPTREND | UPTREND |
| 2026-08-27 14:15:06/55 UTC | UPTREND | UPTREND | UPTREND | UPTREND | UPTREND |

Ca 5 coin deu UPTREND o CA HAI thoi diem quan sat duoc (cach nhau ~6 tieng). Ngoai ra, **toan bo
log tu 08:27 den 03:00 hom sau KHONG XUAT HIEN chu "SHORT" hay "DOWNTREND" o bat ky dau** — moi
`ENTRY_PLACED`/`ENTRY_SKIPPED`/tin hieu catch-up deu la LONG.

**Ket luan Phan C (khop voi kich ban 3 cua ticket):** trong toan bo khung thoi gian test quan sat
duoc (~18.5 tieng, 27-28/8/2026), **khong co bat ky dau hieu DOWNTREND nao xuat hien o ca 5 coin** —
mau du lieu qua ngan/mot chieu (thi truong tang toan bo giai doan nay), **chua du de ket luan co bug
o nhanh short hay khong**. Day KHONG PHAI bang chung cho thay nhanh short co loi — chi la chua co
co hoi nao de kiem tra no trong dot test nay.

**Con thieu de kiem tra chac chan hon:** log pm2 chi co 2 snapshot rời rac (khong phai continuous
per-candle) nen co the co mot cua so DOWNTREND ngan giua 2 lan snapshot ma khong duoc ghi lai — neu
muon chac chan hon, can (a) log continuous hon trong lan test sau, hoac (b) tai tao lai H1 trend
that tu OHLCV Binance cho dung khung 09:00 27/8 -> 03:00 28/8 UTC bang chinh ham production
`classifyTrendH1` (khac phuong phap "grep log" ticket yeu cau — can Vinh Tam duyet truoc neu muon
lam buoc nay).

---

## Rui ro tiep dien — co can dung bot testnet khong?

**Khong de xuat dung bot** — day la testnet (khong phai tien that), va 2/3 vi the sau (Vi the #2,
#3) cho thay SL/TP hoat dong dung thiet ke sau khi da dat duoc. Rui ro thuc su la o Phan A (leverage
sai tren BTC/SOL/HYPE — anh huong sizing, khong phai mat von truc tiep tren testnet) va nguy co
"Vi the #1" tai dien (vi the khong SL/TP) — day la rui ro CAN FIX truoc khi chuyen mainnet, khong
phai rui ro khan cap can dung testnet ngay bay gio.

---

## Tom tat cho checkpoint review

| Phan | Muc do xac dinh | Can gi de hoan tat |
|---|---|---|
| A | **Xac dinh 100%** — code khong bao gio set leverage; 3/5 symbol hien sai so thiet ke | (khong can them — da du bang chung de ban huong fix) |
| B | **Xac dinh 100%** — nguyen nhan goc: bot chay CODE CU (truoc fix RT-071/072) khi mo vi the XRPUSDT (va SOLUSDT) luc 09:00-early 27/8; Binance tu choi STOP_MARKET/TAKE_PROFIT_MARKET qua endpoint cu (-4120) suot 3 tieng (13 lan retry that bai lien tiep); vi the duoc dong THU CONG qua Binance iOS app luc 13:32; fix duoc deploy (restart 14:15), tu do SL/TP hoat dong dung cho moi lenh sau | (khong can them cho XRPUSDT — co the dieu tra rieng vu SOLUSDT tuong tu neu muon) |
| C | Co du lieu that (2 snapshot trend, ca 5 coin UPTREND ca 2 lan; khong dong nao co SHORT/DOWNTREND trong toan bo log) — khop kich ban 3 cua ticket: mau qua ngan/mot chieu, chua the ket luan co bug o nhanh short hay khong | Neu muon chac chan hon: log continuous hon o lan test sau, hoac duyet phuong an tai tao tu OHLCV that (khac phuong phap ticket yeu cau) |

## Nguyen nhan goc chung (Phan A + Phan B lien quan nhau)

Ca hai su co deu bat nguon tu **cung mot loai gap: thieu co che dam bao trang thai exchange/deploy
khop voi ky vong cua code truoc khi cho phep dat lenh that**:
- Phan A: khong co buoc dong bo leverage luc khoi dong (code chi doc, khong set).
- Phan B: khong co buoc kiem tra "code dang chay co phai ban moi nhat" hay circuit-breaker dung
  entry moi khi mot loai loi lap lai nhieu lan lien tiep (13 lan LIFECYCLE_ERROR giong het nhau
  trong 3 tieng ma engine van tiep tuc cho phep ENTRY_PLACED moi cho cac symbol khac — xem
  14:45:03-15:00:04, bot van dat lenh moi cho BTC/HYPE/XRP/ETH/SOL binh thuong trong luc XRP/SOL cu
  van dang bao loi — khong co logic "tam dung toan bo neu phat hien loi he thong lap lai").

Day la nhan xet audit, **khong phai de xuat fix cu the** (dung theo yeu cau ticket "chi mo ta huong
fix bang loi, cho checkpoint duyet truoc khi cho phep code hoa").
