# TICKET-RT-087 — minSlPctFloor Sweep (M1 resolution, targetRMultiple fixed at 2.10)

Audit-only. Each row regenerates its OWN candidate set for that floor value (not the frozen RT-084/086 7,133 set) and replays it at M1 resolution, "Main realistic" scenario (trade-through 1bp, base slippage 1bp, 0ms latency), under BOTH fee standards side by side.

Baseline (floor=0.5%) self-checked against RT-086: must reproduce netPF=0.936 (RT-084 fee) and netPF=0.734 (RT-DOGE-001 fee) exactly, or the script stops before sweeping further.

| minSlPctFloor | Candidates | Filled | Fill rate | WR | Net PF (RT-084 fee) | Net PF (RT-DOGE-001 fee) | Net Exp R (RT-084) | Net Exp R (RTDOGE) | Net R (RT-084) | Net R (RTDOGE) | MaxDD R (RT-084) | MaxDD R (RTDOGE) | Loss streak (RT-084) | Loss streak (RTDOGE) |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0.5% | 7133 | 4919 | 69.0% | 34.2% | 0.936 | 0.734 | -0.047 | -0.225 | -229.0 | -1108.7 | 305.1 | 1126.6 | 23 | 23 |
| 0.75% | 3151 | 2149 | 68.2% | 33.6% | 0.949 | 0.792 | -0.037 | -0.167 | -78.8 | -358.6 | 110.1 | 377.9 | 17 | 17 |
| 1% | 1441 | 988 | 68.6% | 33.1% | 0.951 | 0.822 | -0.035 | -0.139 | -34.7 | -137.2 | 55.1 | 150.4 | 20 | 20 |
| 1.5% | 315 | 205 | 65.1% | 32.2% | 0.937 | 0.846 | -0.044 | -0.116 | -9.1 | -23.8 | 19.9 | 32.2 | 11 | 11 |
| 2% | 83 | 49 | 59.0% | 36.7% | 1.162 | 1.073 | 0.106 | 0.050 | 5.2 | 2.5 | 12.4 | 13.9 | 8 | 8 |

Note: WR and fill rate are computed identically under both fee standards (fees do not affect fill/exit determination), shown once.

No floor value is recommended here — this is measurement only, per the ticket.
