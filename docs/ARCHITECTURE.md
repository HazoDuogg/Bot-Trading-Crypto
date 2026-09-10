# Kiến trúc

## Luồng dữ liệu mỗi nến

```
Candle
  │
  ▼
regime.detectRegime          → RegimeSnapshot
  │
  ▼
direction.detectDirection    → DirectionBias
  │
  ▼
entry.detectEntry            → EntrySignal | null
  │
  ▼
risk.sizePosition            → TradePlan
  │
  ▼
exit.manageExit (mỗi nến, cho position đang mở) → Position cập nhật
```

`core/orchestrator.ts` là nơi duy nhất gọi tuần tự các hàm trên. Các tầng không gọi
chéo lẫn nhau — muốn đổi thứ tự hay thêm bước, sửa ở orchestrator.

## Ranh giới module

- `indicators/` không phụ thuộc bất kỳ tầng nào khác — chỉ nhận `Candle[]`, trả số.
- `exchange/` là adapter I/O duy nhất chạm mạng; phần còn lại của `src/` chỉ biết
  interface `ExchangeClient`.
- `config/` là nơi duy nhất đọc `process.env`.
- `analysis/` đọc kết quả trade đã đóng, không tham gia vào luồng vào lệnh.

## Trạng thái

Khung sườn hiện tại — các hàm trong `regime/`, `direction/`, `entry/`, `risk/`, `exit/`
throw `not implemented`, chờ implement từng tầng theo spec.
