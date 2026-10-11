import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../data');
const SYMBOL = 'BTCUSDT';
const SUFFIX = '2021-2024';
const LABEL_HORIZON = 20;
const MOVE_THRESHOLD = 0.005;
const WARMUP = 250;
const MIN_N_FOR_BEST = 10;

interface RawCandle {
    openTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    closeTime: number;
}

interface CvdBucket {
    openTime: number;
    delta: number;
    cvd: number;
}

interface Bar {
    openTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    cvd: number | undefined;
}

type Direction = 'UP' | 'DOWN' | null;

function loadJson<T>(fileName: string): T {
    return JSON.parse(readFileSync(resolve(DATA_DIR, fileName), 'utf-8'));
}

function alignBars(candles: RawCandle[], cvdBuckets: CvdBucket[]): Bar[] {
    const cvdByOpenTime = new Map(cvdBuckets.map((b) => [b.openTime, b.cvd]));
    return candles.map((c) => ({
        openTime: c.openTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        cvd: cvdByOpenTime.get(c.openTime),
    }));
}

// ===================== Indicator helpers =====================

function calculateEMA(data: number[], period: number): number[] {
    const result: number[] = [];
    const multiplier = 2 / (period + 1);
    for (let i = 0; i < data.length; i++) {
        result.push(i === 0 ? data[i] : (data[i] - result[i - 1]) * multiplier + result[i - 1]);
    }
    return result;
}

function calculateSMA(data: number[], period: number): (number | undefined)[] {
    const result: (number | undefined)[] = new Array(data.length).fill(undefined);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
        sum += data[i];
        if (i >= period) sum -= data[i - period];
        if (i >= period - 1) result[i] = sum / period;
    }
    return result;
}

function wilderSmooth(data: number[], period: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < data.length; i++) {
        if (i < period) {
            const sum = data.slice(0, i + 1).reduce((a, b) => a + b, 0);
            result.push(sum / (i + 1));
        } else {
            result.push((result[i - 1] * (period - 1) + data[i]) / period);
        }
    }
    return result;
}

function calculateTR(bars: Bar[]): number[] {
    const tr: number[] = [];
    for (let i = 0; i < bars.length; i++) {
        const prevClose = i > 0 ? bars[i - 1].close : bars[i].close;
        tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose)));
    }
    return tr;
}

function calculateATR(bars: Bar[], period: number): number[] {
    return wilderSmooth(calculateTR(bars), period);
}

function calculateADX(bars: Bar[], period = 14): { adx: number[]; plusDI: number[]; minusDI: number[] } {
    const high = bars.map((b) => b.high);
    const low = bars.map((b) => b.low);
    const close = bars.map((b) => b.close);

    const tr: number[] = [];
    const plusDM: number[] = [];
    const minusDM: number[] = [];
    for (let i = 1; i < bars.length; i++) {
        const hDiff = high[i] - high[i - 1];
        const lDiff = low[i - 1] - low[i];
        tr.push(Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
        plusDM.push(hDiff > lDiff && hDiff > 0 ? hDiff : 0);
        minusDM.push(lDiff > hDiff && lDiff > 0 ? lDiff : 0);
    }

    const trSmooth = wilderSmooth(tr, period);
    const plusSmooth = wilderSmooth(plusDM, period);
    const minusSmooth = wilderSmooth(minusDM, period);
    const plusDI = plusSmooth.map((p, i) => (trSmooth[i] > 0 ? (p / trSmooth[i]) * 100 : 0));
    const minusDI = minusSmooth.map((m, i) => (trSmooth[i] > 0 ? (m / trSmooth[i]) * 100 : 0));

    const dx: number[] = [];
    for (let i = 0; i < plusDI.length; i++) {
        const sum = plusDI[i] + minusDI[i];
        dx.push(sum > 0 ? (Math.abs(plusDI[i] - minusDI[i]) / sum) * 100 : 0);
    }
    const adx = wilderSmooth(dx, period);

    const pad = bars.length - adx.length;
    return {
        adx: [...Array(pad).fill(0), ...adx],
        plusDI: [...Array(pad).fill(0), ...plusDI],
        minusDI: [...Array(pad).fill(0), ...minusDI],
    };
}

function calculateMACD(close: number[]): { macd: number[]; signal: number[] } {
    const ema12 = calculateEMA(close, 12);
    const ema26 = calculateEMA(close, 26);
    const macd = ema12.map((v, i) => v - ema26[i]);
    return { macd, signal: calculateEMA(macd, 9) };
}

function calculateRSI(close: number[], period = 14): number[] {
    const gains: number[] = [];
    const losses: number[] = [];
    for (let i = 1; i < close.length; i++) {
        const change = close[i] - close[i - 1];
        gains.push(change > 0 ? change : 0);
        losses.push(change < 0 ? -change : 0);
    }
    const avgGain = wilderSmooth(gains, period);
    const avgLoss = wilderSmooth(losses, period);
    const rsi = avgGain.map((g, i) => {
        const l = avgLoss[i];
        if (l === 0) return 100;
        const rs = g / l;
        return 100 - 100 / (1 + rs);
    });
    return [0, ...rsi];
}

function highestOver(values: number[], i: number, period: number): number {
    let max = -Infinity;
    for (let k = Math.max(0, i - period + 1); k <= i; k++) max = Math.max(max, values[k]);
    return max;
}
function lowestOver(values: number[], i: number, period: number): number {
    let min = Infinity;
    for (let k = Math.max(0, i - period + 1); k <= i; k++) min = Math.min(min, values[k]);
    return min;
}

function calculateStochastic(bars: Bar[], period = 14, kSmooth = 3, dSmooth = 3): { k: (number | undefined)[]; d: (number | undefined)[] } {
    const high = bars.map((b) => b.high);
    const low = bars.map((b) => b.low);
    const close = bars.map((b) => b.close);
    const rawK: number[] = [];
    for (let i = 0; i < bars.length; i++) {
        if (i < period - 1) {
            rawK.push(NaN);
            continue;
        }
        const hh = highestOver(high, i, period);
        const ll = lowestOver(low, i, period);
        rawK.push(hh > ll ? ((close[i] - ll) / (hh - ll)) * 100 : 50);
    }
    const validRawK = rawK.map((v) => (Number.isNaN(v) ? 0 : v));
    const kSmoothed = calculateSMA(validRawK, kSmooth).map((v, i) => (i < period - 1 + kSmooth - 1 ? undefined : v));
    const kFilled = kSmoothed.map((v) => v ?? 0);
    const d = calculateSMA(kFilled, dSmooth).map((v, i) => (kSmoothed[i] === undefined ? undefined : v));
    return { k: kSmoothed, d };
}

function calculateOBV(bars: Bar[]): number[] {
    const obv: number[] = [0];
    for (let i = 1; i < bars.length; i++) {
        const prev = obv[i - 1];
        if (bars[i].close > bars[i - 1].close) obv.push(prev + bars[i].volume);
        else if (bars[i].close < bars[i - 1].close) obv.push(prev - bars[i].volume);
        else obv.push(prev);
    }
    return obv;
}

function calculateVWAP(bars: Bar[]): number[] {
    const vwap: number[] = [];
    let cumPV = 0;
    let cumV = 0;
    let currentDay = -1;
    for (const b of bars) {
        const day = Math.floor(b.openTime / (24 * 60 * 60 * 1000));
        if (day !== currentDay) {
            currentDay = day;
            cumPV = 0;
            cumV = 0;
        }
        const typicalPrice = (b.high + b.low + b.close) / 3;
        cumPV += typicalPrice * b.volume;
        cumV += b.volume;
        vwap.push(cumV > 0 ? cumPV / cumV : b.close);
    }
    return vwap;
}

interface Ichimoku {
    tenkan: (number | undefined)[];
    kijun: (number | undefined)[];
    spanA: (number | undefined)[];
    spanB: (number | undefined)[];
}

function calculateIchimoku(bars: Bar[], tenkanP = 9, kijunP = 26, spanBP = 52): Ichimoku {
    const high = bars.map((b) => b.high);
    const low = bars.map((b) => b.low);
    const tenkan: (number | undefined)[] = [];
    const kijun: (number | undefined)[] = [];
    const spanB: (number | undefined)[] = [];
    for (let i = 0; i < bars.length; i++) {
        tenkan.push(i >= tenkanP - 1 ? (highestOver(high, i, tenkanP) + lowestOver(low, i, tenkanP)) / 2 : undefined);
        kijun.push(i >= kijunP - 1 ? (highestOver(high, i, kijunP) + lowestOver(low, i, kijunP)) / 2 : undefined);
        spanB.push(i >= spanBP - 1 ? (highestOver(high, i, spanBP) + lowestOver(low, i, spanBP)) / 2 : undefined);
    }
    const spanA = tenkan.map((t, i) => (t !== undefined && kijun[i] !== undefined ? (t + kijun[i]!) / 2 : undefined));
    return { tenkan, kijun, spanA, spanB };
}

function calculateSuperTrend(bars: Bar[], period = 10, multiplier = 3): ('UP' | 'DOWN' | undefined)[] {
    const atr = calculateATR(bars, period);
    const trend: ('UP' | 'DOWN' | undefined)[] = new Array(bars.length).fill(undefined);
    const finalUpper: number[] = new Array(bars.length).fill(0);
    const finalLower: number[] = new Array(bars.length).fill(0);

    const startIndex = period;
    for (let i = startIndex; i < bars.length; i++) {
        const mid = (bars[i].high + bars[i].low) / 2;
        const basicUpper = mid + multiplier * atr[i];
        const basicLower = mid - multiplier * atr[i];

        if (i === startIndex) {
            finalUpper[i] = basicUpper;
            finalLower[i] = basicLower;
            trend[i] = bars[i].close > basicUpper ? 'UP' : 'DOWN';
            continue;
        }

        finalUpper[i] = basicUpper < finalUpper[i - 1] || bars[i - 1].close > finalUpper[i - 1] ? basicUpper : finalUpper[i - 1];
        finalLower[i] = basicLower > finalLower[i - 1] || bars[i - 1].close < finalLower[i - 1] ? basicLower : finalLower[i - 1];

        if (trend[i - 1] === 'UP') {
            trend[i] = bars[i].close < finalLower[i] ? 'DOWN' : 'UP';
        } else {
            trend[i] = bars[i].close > finalUpper[i] ? 'UP' : 'DOWN';
        }
    }
    return trend;
}

// ===================== Assemble all indicators =====================

function computeAllIndicators(bars: Bar[]) {
    const close = bars.map((b) => b.close);
    const ema50 = calculateEMA(close, 50);
    const ema200 = calculateEMA(close, 200);
    const { adx, plusDI, minusDI } = calculateADX(bars);
    const { macd, signal } = calculateMACD(close);
    const rsi = calculateRSI(close);
    const stoch = calculateStochastic(bars);
    const bbMiddle = calculateSMA(close, 20);
    const atr14 = calculateATR(bars, 14);
    const obv = calculateOBV(bars);
    const vwap = calculateVWAP(bars);
    const ichimoku = calculateIchimoku(bars);
    const superTrend = calculateSuperTrend(bars);
    return { ema50, ema200, adx, plusDI, minusDI, macd, signal, rsi, stoch, bbMiddle, atr14, obv, vwap, ichimoku, superTrend };
}

type Indicators = ReturnType<typeof computeAllIndicators>;

// ===================== 13 methods =====================

const ICHIMOKU_SHIFT = 26;

const METHODS: Record<string, (i: number, bars: Bar[], ind: Indicators) => Direction> = {
    A1: (i, _b, ind) => {
        if (ind.adx[i] >= 25 && ind.plusDI[i] > ind.minusDI[i]) return 'UP';
        if (ind.adx[i] >= 25 && ind.minusDI[i] > ind.plusDI[i]) return 'DOWN';
        return null;
    },
    A2: (i, b, ind) => {
        if (ind.ema50[i] === undefined) return null;
        if (b[i].close > ind.ema50[i]) return 'UP';
        if (b[i].close < ind.ema50[i]) return 'DOWN';
        return null;
    },
    A3: (i, _b, ind) => {
        if (ind.macd[i] > ind.signal[i]) return 'UP';
        if (ind.macd[i] < ind.signal[i]) return 'DOWN';
        return null;
    },
    A4: (i, b) => {
        if (i === 0 || b[i].cvd === undefined || b[i - 1].cvd === undefined) return null;
        if (b[i].cvd! > b[i - 1].cvd!) return 'UP';
        if (b[i].cvd! < b[i - 1].cvd!) return 'DOWN';
        return null;
    },
    A5: (i, b, ind) => {
        if (ind.ema200[i] === undefined) return null;
        if (ind.adx[i] >= 25 && ind.plusDI[i] > ind.minusDI[i] && ind.macd[i] > ind.signal[i] && b[i].close > ind.ema200[i]) return 'UP';
        if (ind.adx[i] >= 25 && ind.minusDI[i] > ind.plusDI[i] && ind.macd[i] < ind.signal[i] && b[i].close < ind.ema200[i]) return 'DOWN';
        return null;
    },
    B1: (i, _b, ind) => {
        if (ind.rsi[i] > 50) return 'UP';
        if (ind.rsi[i] < 50) return 'DOWN';
        return null;
    },
    B2: (i, _b, ind) => {
        const k = ind.stoch.k[i];
        const d = ind.stoch.d[i];
        if (k === undefined || d === undefined) return null;
        if (k > d && k > 50) return 'UP';
        if (k < d && k < 50) return 'DOWN';
        return null;
    },
    B3: (i, b, ind) => {
        const mid = ind.bbMiddle[i];
        if (mid === undefined) return null;
        if (b[i].close > mid) return 'UP';
        if (b[i].close < mid) return 'DOWN';
        return null;
    },
    B4: (i, _b, ind) => {
        if (i < 20) return null;
        if (ind.atr14[i] > ind.atr14[i - 20]) return 'UP';
        if (ind.atr14[i] < ind.atr14[i - 20]) return 'DOWN';
        return null;
    },
    B5: (i, _b, ind) => {
        if (i === 0) return null;
        if (ind.obv[i] > ind.obv[i - 1]) return 'UP';
        if (ind.obv[i] < ind.obv[i - 1]) return 'DOWN';
        return null;
    },
    B6: (i, b, ind) => {
        if (b[i].close > ind.vwap[i]) return 'UP';
        if (b[i].close < ind.vwap[i]) return 'DOWN';
        return null;
    },
    B7: (i, b, ind) => {
        const cloudIndex = i - ICHIMOKU_SHIFT;
        if (cloudIndex < 0) return null;
        const spanA = ind.ichimoku.spanA[cloudIndex];
        const spanB = ind.ichimoku.spanB[cloudIndex];
        const tenkan = ind.ichimoku.tenkan[i];
        const kijun = ind.ichimoku.kijun[i];
        if (spanA === undefined || spanB === undefined || tenkan === undefined || kijun === undefined) return null;
        const cloudTop = Math.max(spanA, spanB);
        const cloudBottom = Math.min(spanA, spanB);
        if (b[i].close > cloudTop && tenkan > kijun) return 'UP';
        if (b[i].close < cloudBottom && tenkan < kijun) return 'DOWN';
        return null;
    },
    B8: (i, _b, ind) => {
        const t = ind.superTrend[i];
        if (t === undefined) return null;
        return t;
    },
};

function labelDirection(bars: Bar[], idx: number, horizon: number): Direction {
    if (idx + horizon >= bars.length) return null;
    const change = (bars[idx + horizon].close - bars[idx].close) / bars[idx].close;
    if (change > MOVE_THRESHOLD) return 'UP';
    if (change < -MOVE_THRESHOLD) return 'DOWN';
    return null;
}

function monthKey(openTime: number): string {
    return new Date(openTime).toISOString().slice(0, 7);
}

interface MethodMonthResult {
    n: number;
    correct: number;
    pct: number;
}

function main() {
    const candles = loadJson<RawCandle[]>(`ohlcv-${SYMBOL}-1h-${SUFFIX}.json`);
    const cvdBuckets = loadJson<CvdBucket[]>(`cvd-${SYMBOL}-1h-${SUFFIX}.json`);
    const rangeEnd = Date.parse('2024-01-01T00:00:00Z');
    const bars = alignBars(
        candles.filter((c) => c.openTime < rangeEnd),
        cvdBuckets,
    );
    console.log(`Đã nạp ${bars.length} nến H1 (${SUFFIX}), CVD khớp ${bars.filter((b) => b.cvd !== undefined).length} nến.`);

    const ind = computeAllIndicators(bars);
    const methodNames = Object.keys(METHODS);

    const months = [...new Set(bars.slice(WARMUP).map((b) => monthKey(b.openTime)))].sort();
    console.log(`Số tháng: ${months.length}`);

    // results[month][method] = { n, correct, pct }
    const results = new Map<string, Map<string, MethodMonthResult>>();
    for (const m of months) results.set(m, new Map());

    for (let i = WARMUP; i < bars.length - LABEL_HORIZON; i++) {
        const label = labelDirection(bars, i, LABEL_HORIZON);
        if (!label) continue;
        const month = monthKey(bars[i].openTime);
        const monthResults = results.get(month);
        if (!monthResults) continue;

        for (const name of methodNames) {
            const pred = METHODS[name](i, bars, ind);
            if (!pred) continue;
            const r = monthResults.get(name) ?? { n: 0, correct: 0, pct: 0 };
            r.n++;
            if (pred === label) r.correct++;
            monthResults.set(name, r);
        }
    }
    for (const monthResults of results.values()) {
        for (const r of monthResults.values()) r.pct = r.n > 0 ? (r.correct / r.n) * 100 : 0;
    }

    // ===== Bảng 1: kết quả từng tháng =====
    interface Table1Row {
        month: string;
        cells: Record<string, number | null>;
        best: string;
    }
    const table1: Table1Row[] = months.map((month) => {
        const monthResults = results.get(month)!;
        const cells: Record<string, number | null> = {};
        let bestMethod = 'N/A';
        let bestPct = -1;
        for (const name of methodNames) {
            const r = monthResults.get(name);
            cells[name] = r && r.n > 0 ? r.pct : null;
            if (r && r.n >= MIN_N_FOR_BEST && r.pct > bestPct) {
                bestPct = r.pct;
                bestMethod = name;
            }
        }
        return { month, cells, best: bestMethod };
    });

    console.log('\n========== BẢNG 1: KẾT QUẢ TỪNG THÁNG (rút gọn console, đầy đủ trong CSV) ==========\n');
    console.log(`Tháng\t${methodNames.join('\t')}\tBest`);
    for (const row of table1) {
        const cellsStr = methodNames.map((m) => (row.cells[m] === null ? '-' : row.cells[m]!.toFixed(0))).join('\t');
        console.log(`${row.month}\t${cellsStr}\t${row.best}`);
    }

    // ===== Regime classification =====
    const indicesByMonth = new Map<string, number[]>();
    for (let i = 0; i < bars.length; i++) {
        const m = monthKey(bars[i].openTime);
        if (!indicesByMonth.has(m)) indicesByMonth.set(m, []);
        indicesByMonth.get(m)!.push(i);
    }
    function classifyRegime(month: string): string {
        const indices = indicesByMonth.get(month);
        if (!indices || indices.length === 0) return 'Transition';
        const firstClose = bars[indices[0]].close;
        const lastClose = bars[indices[indices.length - 1]].close;
        const monthReturn = (lastClose - firstClose) / firstClose;
        const adxValues = indices.map((i) => ind.adx[i]).filter((v) => Number.isFinite(v));
        const avgAdx = adxValues.length > 0 ? adxValues.reduce((a, b) => a + b, 0) / adxValues.length : 0;
        if (monthReturn > 0.1) return 'Bull';
        if (monthReturn < -0.1) return 'Bear';
        if (Math.abs(monthReturn) <= 0.1 && avgAdx < 20) return 'Sideway';
        return 'Transition';
    }
    const regimeByMonth = new Map(months.map((m) => [m, classifyRegime(m)]));

    // ===== Bảng 2: tổng hợp theo regime =====
    const regimes = ['Bull', 'Bear', 'Sideway', 'Transition'];
    interface Table2Row {
        regime: string;
        monthCount: number;
        bestMethod: string;
        avgPct: number;
    }
    const table2: Table2Row[] = regimes.map((regime) => {
        const regimeMonths = months.filter((m) => regimeByMonth.get(m) === regime);
        let bestMethod = 'N/A';
        let bestAvg = -1;
        for (const name of methodNames) {
            const pcts: number[] = [];
            for (const m of regimeMonths) {
                const r = results.get(m)!.get(name);
                if (r && r.n > 0) pcts.push(r.pct);
            }
            if (pcts.length === 0) continue;
            const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
            if (avg > bestAvg) {
                bestAvg = avg;
                bestMethod = name;
            }
        }
        return { regime, monthCount: regimeMonths.length, bestMethod, avgPct: bestAvg < 0 ? 0 : bestAvg };
    });

    console.log('\n========== BẢNG 2: TỔNG HỢP THEO REGIME ==========\n');
    console.log('Regime\tSố tháng\tPhương pháp tốt nhất\t%Đúng TB');
    for (const r of table2) {
        console.log(`${r.regime}\t${r.monthCount}\t${r.bestMethod}\t${r.avgPct.toFixed(1)}%`);
    }

    // ===== Bảng 3: đếm tháng > 55% =====
    interface Table3Row {
        method: string;
        monthsOver55: number;
        totalMonths: number;
        avgPct: number;
    }
    const table3: Table3Row[] = methodNames.map((name) => {
        let over55 = 0;
        const pcts: number[] = [];
        for (const m of months) {
            const r = results.get(m)!.get(name);
            if (r && r.n > 0) {
                pcts.push(r.pct);
                if (r.pct > 55) over55++;
            }
        }
        const avgPct = pcts.length > 0 ? pcts.reduce((a, b) => a + b, 0) / pcts.length : 0;
        return { method: name, monthsOver55: over55, totalMonths: months.length, avgPct };
    });

    console.log('\n========== BẢNG 3: SỐ THÁNG > 55% ==========\n');
    console.log('Phương pháp\tSố tháng > 55%\tTỷ lệ\t%Đúng TB');
    for (const r of table3) {
        console.log(`${r.method}\t${r.monthsOver55}\t${r.monthsOver55}/${r.totalMonths}\t${r.avgPct.toFixed(1)}%`);
    }

    // ===== Bảng 4: top 3 ổn định nhất =====
    const table4 = [...table3].sort((a, b) => b.monthsOver55 - a.monthsOver55 || b.avgPct - a.avgPct).slice(0, 3);
    console.log('\n========== BẢNG 4: TOP 3 PHƯƠNG PHÁP ỔN ĐỊNH NHẤT ==========\n');
    console.log('Hạng\tPhương pháp\tSố tháng > 55%\t%Đúng TB');
    table4.forEach((r, idx) => {
        console.log(`${idx + 1}\t${r.method}\t${r.monthsOver55}\t${r.avgPct.toFixed(1)}%`);
    });

    // ===== Kết luận cuối =====
    let monthsWithAnyMethodOver55 = 0;
    for (const m of months) {
        const monthResults = results.get(m)!;
        const anyOver55 = methodNames.some((name) => {
            const r = monthResults.get(name);
            return r && r.n > 0 && r.pct > 55;
        });
        if (anyOver55) monthsWithAnyMethodOver55++;
    }
    let finalConclusion: string;
    if (monthsWithAnyMethodOver55 >= 10) finalConclusion = 'CÓ EDGE — xây dựng regime-switching';
    else if (monthsWithAnyMethodOver55 >= 5) finalConclusion = 'CẦN LỌC THÊM ĐIỀU KIỆN';
    else finalConclusion = 'KHÔNG CÓ EDGE — dừng dự án';

    console.log('\n========== KẾT LUẬN CUỐI ==========');
    console.log(`Số tháng có ít nhất 1 phương pháp > 55%: ${monthsWithAnyMethodOver55}/${months.length}`);
    console.log(`=> ${finalConclusion}`);

    // ===== Xuất file =====
    writeFileSync(resolve(DATA_DIR, 'ticket08x-monthly-table1.json'), JSON.stringify(table1, null, 2));
    writeFileSync(
        resolve(DATA_DIR, 'ticket08x-monthly-table1.csv'),
        [
            `month,${methodNames.join(',')},best`,
            ...table1.map((r) => [r.month, ...methodNames.map((m) => (r.cells[m] === null ? '' : r.cells[m]!.toFixed(2))), r.best].join(',')),
        ].join('\n'),
    );

    writeFileSync(resolve(DATA_DIR, 'ticket08x-monthly-table2-regime.json'), JSON.stringify(table2, null, 2));
    writeFileSync(
        resolve(DATA_DIR, 'ticket08x-monthly-table2-regime.csv'),
        ['regime,monthCount,bestMethod,avgPct', ...table2.map((r) => [r.regime, r.monthCount, r.bestMethod, r.avgPct.toFixed(2)].join(','))].join('\n'),
    );

    writeFileSync(resolve(DATA_DIR, 'ticket08x-monthly-table3-over55.json'), JSON.stringify(table3, null, 2));
    writeFileSync(
        resolve(DATA_DIR, 'ticket08x-monthly-table3-over55.csv'),
        ['method,monthsOver55,totalMonths,avgPct', ...table3.map((r) => [r.method, r.monthsOver55, r.totalMonths, r.avgPct.toFixed(2)].join(','))].join('\n'),
    );

    writeFileSync(resolve(DATA_DIR, 'ticket08x-monthly-table4-top3.json'), JSON.stringify(table4, null, 2));
    writeFileSync(
        resolve(DATA_DIR, 'ticket08x-monthly-table4-top3.csv'),
        ['rank,method,monthsOver55,avgPct', ...table4.map((r, i) => [i + 1, r.method, r.monthsOver55, r.avgPct.toFixed(2)].join(','))].join('\n'),
    );

    console.log('\nĐã lưu 4 bảng kết quả vào data/ticket08x-monthly-*.{json,csv}');
}

main();
