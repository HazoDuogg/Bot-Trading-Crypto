# entry (Tầng 2)

`entryRouter.ts` gộp kết quả từ các detector trong `detectors/` (OB, FVG, Sweep, MSS,
Box Breakout, ...) thành một `EntrySignal` duy nhất. Mỗi detector là một file riêng
trong `detectors/`.
