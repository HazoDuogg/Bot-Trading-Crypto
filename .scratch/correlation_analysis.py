#!/usr/bin/env python3
"""One-off: BTC/ETH and BTC/SOL correlation over Jul1-Sep20 2026, Daily and 15m returns."""
import json
import time as time_module
import urllib.request
from datetime import datetime, timezone

BINANCE_KLINES_URL = "https://api.binance.com/api/v3/klines"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"


def ms(dt_str):
    return int(datetime.strptime(dt_str, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)


def fetch_klines(symbol, interval, start_ms, end_ms):
    out = []
    cursor = start_ms
    while cursor < end_ms:
        url = (f"{BINANCE_KLINES_URL}?symbol={symbol}&interval={interval}"
               f"&startTime={cursor}&endTime={end_ms}&limit=1000")
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as resp:
            batch = json.loads(resp.read())
        if not batch:
            break
        out.extend(batch)
        last_close_time = batch[-1][6]
        if last_close_time <= cursor:
            break
        cursor = last_close_time + 1
        if len(batch) < 1000:
            break
        time_module.sleep(0.15)
    return out


def closes_by_open_time(raw):
    return {k[0]: float(k[4]) for k in raw}


def returns_aligned(closes_a, closes_b):
    """Pct returns bar-over-bar, only at open_times present in BOTH series
    (in case of any gaps), aligned by matching consecutive available times."""
    common_times = sorted(set(closes_a.keys()) & set(closes_b.keys()))
    ra, rb = [], []
    for i in range(1, len(common_times)):
        t0, t1 = common_times[i - 1], common_times[i]
        ra.append(closes_a[t1] / closes_a[t0] - 1.0)
        rb.append(closes_b[t1] / closes_b[t0] - 1.0)
    return ra, rb


def pearson(x, y):
    n = len(x)
    mx = sum(x) / n
    my = sum(y) / n
    cov = sum((xi - mx) * (yi - my) for xi, yi in zip(x, y))
    vx = sum((xi - mx) ** 2 for xi in x)
    vy = sum((yi - my) ** 2 for yi in y)
    return cov / (vx ** 0.5 * vy ** 0.5)


START = ms("2026-07-01")
END = ms("2026-09-21")  # covers through Sep 20 close

for interval, label in [("1d", "Daily"), ("15m", "15m")]:
    btc = closes_by_open_time(fetch_klines("BTCUSDT", interval, START, END))
    eth = closes_by_open_time(fetch_klines("ETHUSDT", interval, START, END))
    sol = closes_by_open_time(fetch_klines("SOLUSDT", interval, START, END))

    ra_be, rb_be = returns_aligned(btc, eth)
    ra_bs, rb_bs = returns_aligned(btc, sol)

    corr_be = pearson(ra_be, rb_be)
    corr_bs = pearson(ra_bs, rb_bs)

    print(f"=== {label} returns, Jul1-Sep20 2026 ===")
    print(f"  n bars: BTC/ETH aligned={len(ra_be)}, BTC/SOL aligned={len(ra_bs)}")
    print(f"  corr(BTC,ETH) = {corr_be:.4f}")
    print(f"  corr(BTC,SOL) = {corr_bs:.4f}")
    print()
