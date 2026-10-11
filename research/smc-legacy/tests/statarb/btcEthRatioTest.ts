import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../data');
const SUFFIX = '2021-2024';
const DEFAULT_LOOKBACK = 100;
const DEFAULT_Z_ENTRY = 2;
const Z_STOP = 3;
const MAX_HOLD_BARS = 100;
const HORIZONS = [20, 50, 100];
const FEE_PER_TRADE = 0.0016; // 0.04% x 2 chân x 2 lần vào/ra

interface RawCandle {
    openTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    closeTime: number;
}

interface Bar {
    openTime: number;
    btcClose: number;
    ethClose: number;
}

type Side = 'SHORT_BTC_LONG_ETH' | 'LONG_BTC_SHORT_ETH';

interface Trade {
    entryIndex: number;
    exitIndex: number;
    side: Side;
    entryZ: number;
    barsHeld: number;
    exitReason: 'CONVERGE' | 'STOP' | 'TIMEOUT' | 'END_OF_DATA';
    pnl: number;
    convergedWithin: Record<number, boolean>;
}

function loadJson<T>(fileName: string): T {
    return JSON.parse(readFileSync(resolve(DATA_DIR, fileName), 'utf-8'));
}

function alignBars(btc: RawCandle[], eth: RawCandle[]): Bar[] {
    const ethByOpenTime = new Map(eth.map((c) => [c.openTime, c.close]));
    const bars: Bar[] = [];
    for (const c of btc) {
        const ethClose = ethByOpenTime.get(c.openTime);
        if (ethClose === undefined) continue;
        bars.push({ openTime: c.openTime, btcClose: c.close, ethClose });
    }
    return bars;
}

function computeZScores(ratios: number[], lookback: number): (number | undefined)[] {
    const z: (number | undefined)[] = new Array(ratios.length).fill(undefined);
    for (let i = lookback - 1; i < ratios.length; i++) {
        const window = ratios.slice(i - lookback + 1, i + 1);
        const mean = window.reduce((a, b) => a + b, 0) / window.length;
        const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / (window.length - 1);
        const std = Math.sqrt(variance);
        z[i] = std > 0 ? (ratios[i] - mean) / std : 0;
    }
    return z;
}

function checkConvergedWithin(z: (number | undefined)[], entryIndex: number, entryZ: number, horizon: number): boolean {
    const endIndex = Math.min(entryIndex + horizon, z.length - 1);
    if (endIndex - entryIndex < horizon) return false; // không đủ dữ liệu để kiểm tra hết horizon
    const entrySign = Math.sign(entryZ);
    for (let j = entryIndex + 1; j <= endIndex; j++) {
        const zj = z[j];
        if (zj === undefined) continue;
        if (Math.sign(zj) !== entrySign || zj === 0) return true;
    }
    return false;
}

function computeTradePnl(bars: Bar[], entryIndex: number, exitIndex: number, side: Side): number {
    const entryBtc = bars[entryIndex].btcClose;
    const entryEth = bars[entryIndex].ethClose;
    const exitBtc = bars[exitIndex].btcClose;
    const exitEth = bars[exitIndex].ethClose;
    const btcReturn = (exitBtc - entryBtc) / entryBtc;
    const ethReturn = (exitEth - entryEth) / entryEth;
    const grossPnl = side === 'SHORT_BTC_LONG_ETH' ? -btcReturn + ethReturn : btcReturn - ethReturn;
    return grossPnl - FEE_PER_TRADE;
}

function simulate(
    bars: Bar[],
    z: (number | undefined)[],
    options: { zEntry: number; zStop: number; maxHold: number; invert: boolean },
): Trade[] {
    const { zEntry, zStop, maxHold, invert } = options;
    const trades: Trade[] = [];
    let i = 0;

    while (i < bars.length) {
        const zi = z[i];
        if (zi === undefined) {
            i++;
            continue;
        }

        let side: Side | null = null;
        if (zi >= zEntry) side = invert ? 'LONG_BTC_SHORT_ETH' : 'SHORT_BTC_LONG_ETH';
        else if (zi <= -zEntry) side = invert ? 'SHORT_BTC_LONG_ETH' : 'LONG_BTC_SHORT_ETH';

        if (side === null) {
            i++;
            continue;
        }

        const entryIndex = i;
        const entryZ = zi;
        let exitIndex = -1;
        let exitReason: Trade['exitReason'] = 'END_OF_DATA';

        const hardEnd = Math.min(entryIndex + maxHold, bars.length - 1);
        for (let j = entryIndex + 1; j <= hardEnd; j++) {
            const zj = z[j];
            if (zj === undefined) continue;

            if (Math.sign(zj) !== Math.sign(entryZ) || zj === 0) {
                exitIndex = j;
                exitReason = 'CONVERGE';
                break;
            }
            if (Math.abs(zj) >= zStop) {
                exitIndex = j;
                exitReason = 'STOP';
                break;
            }
            if (j - entryIndex >= maxHold) {
                exitIndex = j;
                exitReason = 'TIMEOUT';
                break;
            }
        }
        if (exitIndex === -1) {
            exitIndex = hardEnd;
            exitReason = hardEnd - entryIndex >= maxHold ? 'TIMEOUT' : 'END_OF_DATA';
        }

        const pnl = computeTradePnl(bars, entryIndex, exitIndex, side);
        const convergedWithin: Record<number, boolean> = {};
        for (const h of HORIZONS) {
            convergedWithin[h] = checkConvergedWithin(z, entryIndex, entryZ, h);
        }

        trades.push({
            entryIndex,
            exitIndex,
            side,
            entryZ,
            barsHeld: exitIndex - entryIndex,
            exitReason,
            pnl,
            convergedWithin,
        });

        i = exitIndex + 1;
    }
    return trades;
}

function mean(xs: number[]): number {
    return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function stdDev(xs: number[]): number {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function maxDrawdown(pnls: number[]): number {
    let cumulative = 0;
    let peak = 0;
    let maxDd = 0;
    for (const p of pnls) {
        cumulative += p;
        peak = Math.max(peak, cumulative);
        maxDd = Math.max(maxDd, peak - cumulative);
    }
    return maxDd;
}

interface TradeStats {
    n: number;
    winRate: number;
    meanPnl: number;
    sharpe: number;
    maxDrawdown: number;
}

function computeStats(trades: Trade[]): TradeStats {
    const pnls = trades.map((t) => t.pnl);
    const n = trades.length;
    const winRate = n > 0 ? (pnls.filter((p) => p > 0).length / n) * 100 : 0;
    const meanP = mean(pnls);
    const std = stdDev(pnls);
    return {
        n,
        winRate,
        meanPnl: meanP,
        sharpe: std > 0 ? meanP / std : 0,
        maxDrawdown: maxDrawdown(pnls),
    };
}

function main() {
    const btc = loadJson<RawCandle[]>(`ohlcv-BTCUSDT-1h-${SUFFIX}.json`);
    const eth = loadJson<RawCandle[]>(`ohlcv-ETHUSDT-1h-${SUFFIX}.json`);
    const bars = alignBars(btc, eth);
    console.log(`Đã căn chỉnh ${bars.length} nến H1 chung giữa BTCUSDT (${btc.length}) và ETHUSDT (${eth.length}).`);

    const ratios = bars.map((b) => b.btcClose / b.ethClose);

    // ===== Bảng 1: kết quả chính (lookback=100, Z=±2) =====
    const zMain = computeZScores(ratios, DEFAULT_LOOKBACK);
    const tradesMain = simulate(bars, zMain, { zEntry: DEFAULT_Z_ENTRY, zStop: Z_STOP, maxHold: MAX_HOLD_BARS, invert: false });
    const statsMain = computeStats(tradesMain);

    console.log(`\nTổng số lệnh (lookback=100, Z=±2): ${tradesMain.length}`);
    console.log('\n========== BẢNG 1: KẾT QUẢ CHÍNH ==========\n');
    console.log('Horizon\tn\t%Đúng (Z hồi quy về 0)\tPnL TB\tWin rate');
    const table1 = HORIZONS.map((h) => {
        const pctCorrect = statsMain.n > 0 ? (tradesMain.filter((t) => t.convergedWithin[h]).length / statsMain.n) * 100 : 0;
        return { horizon: h, n: statsMain.n, pctCorrect, pnlTrungBinh: statsMain.meanPnl, winRate: statsMain.winRate };
    });
    for (const r of table1) {
        console.log(`${r.horizon} nến\t${r.n}\t${r.pctCorrect.toFixed(1)}%\t${(r.pnlTrungBinh * 100).toFixed(3)}%\t${r.winRate.toFixed(1)}%`);
    }
    console.log(`Sharpe (per-trade): ${statsMain.sharpe.toFixed(3)}, Max drawdown: ${(statsMain.maxDrawdown * 100).toFixed(2)}%`);

    // ===== Kiểm tra 1: đảo ngược tín hiệu =====
    const tradesInverted = simulate(bars, zMain, { zEntry: DEFAULT_Z_ENTRY, zStop: Z_STOP, maxHold: MAX_HOLD_BARS, invert: true });
    const statsInverted = computeStats(tradesInverted);
    console.log('\n========== KIỂM TRA 1: ĐẢO NGƯỢC TÍN HIỆU ==========\n');
    console.log(`Gốc:  n=${statsMain.n}, Win rate=${statsMain.winRate.toFixed(1)}%, Sharpe=${statsMain.sharpe.toFixed(3)}`);
    console.log(`Đảo:  n=${statsInverted.n}, Win rate=${statsInverted.winRate.toFixed(1)}%, Sharpe=${statsInverted.sharpe.toFixed(3)}`);
    const inverseConclusion =
        statsInverted.winRate < 45 || statsInverted.sharpe < -0.3
            ? 'Đảo ngược tệ hẳn đi — nhất quán với tín hiệu có hướng'
            : 'Đảo ngược vẫn quanh mức gốc/50% — dấu hiệu nhiễu';
    console.log(inverseConclusion);

    // ===== Bảng 2: chia 3 giai đoạn (theo năm) =====
    const periodDefs = [
        { label: '2021', start: Date.parse('2021-01-01T00:00:00Z'), end: Date.parse('2022-01-01T00:00:00Z') },
        { label: '2022', start: Date.parse('2022-01-01T00:00:00Z'), end: Date.parse('2023-01-01T00:00:00Z') },
        { label: '2023', start: Date.parse('2023-01-01T00:00:00Z'), end: Date.parse('2024-01-01T00:00:00Z') },
    ];
    console.log('\n========== BẢNG 2: CHIA 3 GIAI ĐOẠN ==========\n');
    console.log('Giai đoạn\tn\t%Đúng (win rate)\tSharpe');
    const table2 = periodDefs.map((p) => {
        const periodBars = bars.filter((b) => b.openTime >= p.start && b.openTime < p.end);
        const periodRatios = periodBars.map((b) => b.btcClose / b.ethClose);
        const periodZ = computeZScores(periodRatios, DEFAULT_LOOKBACK);
        const periodTrades = simulate(periodBars, periodZ, { zEntry: DEFAULT_Z_ENTRY, zStop: Z_STOP, maxHold: MAX_HOLD_BARS, invert: false });
        const periodStats = computeStats(periodTrades);
        return { period: p.label, n: periodStats.n, pctCorrect: periodStats.winRate, sharpe: periodStats.sharpe };
    });
    for (const r of table2) {
        console.log(`${r.period}\t${r.n}\t${r.pctCorrect.toFixed(1)}%\t${r.sharpe.toFixed(3)}`);
    }
    const periodsConsistent = table2.every((r) => r.pctCorrect > 55 && r.sharpe > 1.0);

    // ===== Bảng 3: độ nhạy tham số =====
    const paramGrid: Array<{ lookback: number; zEntry: number }> = [
        { lookback: 50, zEntry: 1.5 },
        { lookback: 50, zEntry: 2.0 },
        { lookback: 100, zEntry: 1.5 },
        { lookback: 100, zEntry: 2.0 },
        { lookback: 200, zEntry: 2.0 },
    ];
    console.log('\n========== BẢNG 3: ĐỘ NHẠY THAM SỐ ==========\n');
    console.log('Lookback\tNgưỡng Z\tn\t%Đúng (win rate)\tSharpe');
    const table3 = paramGrid.map(({ lookback, zEntry }) => {
        const z = computeZScores(ratios, lookback);
        const trades = simulate(bars, z, { zEntry, zStop: Z_STOP, maxHold: MAX_HOLD_BARS, invert: false });
        const stats = computeStats(trades);
        return { lookback, zEntry, n: stats.n, pctCorrect: stats.winRate, sharpe: stats.sharpe };
    });
    for (const r of table3) {
        console.log(`${r.lookback}\t±${r.zEntry}\t${r.n}\t${r.pctCorrect.toFixed(1)}%\t${r.sharpe.toFixed(3)}`);
    }
    const sensitivityStable = table3.every((r) => Math.abs(r.sharpe - statsMain.sharpe) < 1.0);

    // ===== Kết luận cuối =====
    let finalConclusion: string;
    if (statsMain.winRate > 55 && statsMain.sharpe > 1.0 && periodsConsistent) {
        finalConclusion = 'CÓ EDGE → pivot sang Stat Arb';
    } else if (statsMain.winRate >= 52 && statsMain.sharpe >= 0.5) {
        finalConclusion = 'CẦN TỐI ƯU THÊM (ngưỡng Z, lookback)';
    } else {
        finalConclusion = 'KHÔNG CÓ EDGE → chuyển hướng khác';
    }
    console.log('\n========== KẾT LUẬN CUỐI ==========');
    console.log(`Win rate gốc: ${statsMain.winRate.toFixed(1)}%, Sharpe gốc: ${statsMain.sharpe.toFixed(3)}`);
    console.log(`Nhất quán 3 giai đoạn (>55% & Sharpe>1.0 cả 3): ${periodsConsistent ? 'CÓ' : 'KHÔNG'}`);
    console.log(`Ổn định qua tham số (Sharpe lệch <1.0 so với gốc ở mọi tổ hợp): ${sensitivityStable ? 'CÓ' : 'KHÔNG'}`);
    console.log(`=> ${finalConclusion}`);

    // ===== Xuất file =====
    writeFileSync(resolve(DATA_DIR, 'ticket07x-statarb-main-results.json'), JSON.stringify(table1, null, 2));
    writeFileSync(
        resolve(DATA_DIR, 'ticket07x-statarb-main-results.csv'),
        ['horizon,n,pctCorrect,pnlTrungBinh,winRate', ...table1.map((r) => [r.horizon, r.n, r.pctCorrect.toFixed(2), (r.pnlTrungBinh * 100).toFixed(4), r.winRate.toFixed(2)].join(','))].join('\n'),
    );

    writeFileSync(resolve(DATA_DIR, 'ticket07x-statarb-period-split.json'), JSON.stringify(table2, null, 2));
    writeFileSync(
        resolve(DATA_DIR, 'ticket07x-statarb-period-split.csv'),
        ['period,n,pctCorrect,sharpe', ...table2.map((r) => [r.period, r.n, r.pctCorrect.toFixed(2), r.sharpe.toFixed(3)].join(','))].join('\n'),
    );

    writeFileSync(resolve(DATA_DIR, 'ticket07x-statarb-param-sensitivity.json'), JSON.stringify(table3, null, 2));
    writeFileSync(
        resolve(DATA_DIR, 'ticket07x-statarb-param-sensitivity.csv'),
        ['lookback,zEntry,n,pctCorrect,sharpe', ...table3.map((r) => [r.lookback, r.zEntry, r.n, r.pctCorrect.toFixed(2), r.sharpe.toFixed(3)].join(','))].join('\n'),
    );

    writeFileSync(
        resolve(DATA_DIR, 'ticket07x-statarb-inverse-test.json'),
        JSON.stringify(
            {
                original: { n: statsMain.n, winRate: statsMain.winRate, sharpe: statsMain.sharpe },
                inverted: { n: statsInverted.n, winRate: statsInverted.winRate, sharpe: statsInverted.sharpe },
                conclusion: inverseConclusion,
            },
            null,
            2,
        ),
    );

    console.log('\nĐã lưu 4 bộ kết quả vào data/ticket07x-statarb-*.{json,csv}');
}

main();
