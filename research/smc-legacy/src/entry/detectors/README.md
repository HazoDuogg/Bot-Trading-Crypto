# entry/detectors

Mỗi setup entry (order block, FVG, liquidity sweep, MSS, box breakout, ...) là một file
riêng, export một hàm thuần nhận `Candle[]` trả về tín hiệu hoặc `null`. `entryRouter.ts`
gọi các hàm này và chọn tín hiệu ưu tiên.
