import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../data');

interface Candle {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    timestamp: number;
}

interface RawCandle {
    openTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    closeTime: number;
}

interface IndicatorSet {
    adx: number;
    plusDI: number;
    minusDI: number;
    macd: number;
    signal: number;
    ema50: number;
    ema200: number;
}

interface Result {
    method: string;
    timeframe: string;
    total: number;
    correct: number;
    correctUp: number;
    totalUp: number;
    correctDown: number;
    totalDown: number;
    pctCorrect: number;
    pctCorrectUp: number;
    pctCorrectDown: number;
}

function calculateEMA(data: number[], period: number): number[] {
    const result: number[] = [];
    const multiplier = 2 / (period + 1);

    for (let i = 0; i < data.length; i++) {
        if (i === 0) {
            result.push(data[i]);
        } else {
            result.push((data[i] - result[i - 1]) * multiplier + result[i - 1]);
        }
    }
    return result;
}

function calculateTR(high: number, low: number, prevClose: number): number {
    return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
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

function calculateADX(candles: Candle[], period: number = 14): { adx: number[], plusDI: number[], minusDI: number[] } {
    const high = candles.map(c => c.high);
    const low = candles.map(c => c.low);
    const close = candles.map(c => c.close);

    const tr: number[] = [];
    const plusDM: number[] = [];
    const minusDM: number[] = [];

    for (let i = 1; i < candles.length; i++) {
        const hDiff = high[i] - high[i - 1];
        const lDiff = low[i - 1] - low[i];
        tr.push(calculateTR(high[i], low[i], close[i - 1]));
        plusDM.push(hDiff > lDiff && hDiff > 0 ? hDiff : 0);
        minusDM.push(lDiff > hDiff && lDiff > 0 ? lDiff : 0);
    }

    const trSmooth = wilderSmooth(tr, period);
    const plusSmooth = wilderSmooth(plusDM, period);
    const minusSmooth = wilderSmooth(minusDM, period);

    const plusDI = plusSmooth.map((p, i) => trSmooth[i] > 0 ? (p / trSmooth[i]) * 100 : 0);
    const minusDI = minusSmooth.map((m, i) => trSmooth[i] > 0 ? (m / trSmooth[i]) * 100 : 0);

    const dx: number[] = [];
    for (let i = 0; i < plusDI.length; i++) {
        const sum = plusDI[i] + minusDI[i];
        dx.push(sum > 0 ? Math.abs(plusDI[i] - minusDI[i]) / sum * 100 : 0);
    }
    const adx = wilderSmooth(dx, period);

    const pad = candles.length - adx.length;
    const result = {
        adx: [...Array(pad).fill(0), ...adx],
        plusDI: [...Array(pad).fill(0), ...plusDI],
        minusDI: [...Array(pad).fill(0), ...minusDI]
    };
    return result;
}

function calculateMACD(candles: Candle[]): { macd: number[], signal: number[] } {
    const close = candles.map(c => c.close);
    const ema12 = calculateEMA(close, 12);
    const ema26 = calculateEMA(close, 26);
    const macdLine = ema12.map((v, i) => v - ema26[i]);
    const signal = calculateEMA(macdLine, 9);
    return { macd: macdLine, signal };
}

function computeIndicators(candles: Candle[]): IndicatorSet[] {
    const close = candles.map(c => c.close);
    const ema50 = calculateEMA(close, 50);
    const ema200 = calculateEMA(close, 200);
    const { adx, plusDI, minusDI } = calculateADX(candles);
    const { macd, signal } = calculateMACD(candles);

    const result: IndicatorSet[] = [];
    for (let i = 0; i < candles.length; i++) {
        result.push({
            adx: adx[i],
            plusDI: plusDI[i],
            minusDI: minusDI[i],
            macd: macd[i],
            signal: signal[i],
            ema50: ema50[i],
            ema200: ema200[i]
        });
    }
    return result;
}

type DirectionMethod = (idx: number, c: Candle, ind: IndicatorSet) => 'UP' | 'DOWN' | null;

const METHODS: Record<string, DirectionMethod> = {
    A1: (idx, c, ind) => {
        if (ind.plusDI > ind.minusDI) return 'UP';
        if (ind.minusDI > ind.plusDI) return 'DOWN';
        return null;
    },

    A2: (idx, c, ind) => {
        if (ind.adx >= 25 && ind.plusDI > ind.minusDI) return 'UP';
        if (ind.adx >= 25 && ind.minusDI > ind.plusDI) return 'DOWN';
        return null;
    },

    A3: (idx, c, ind) => {
        if (c.close > ind.ema50) return 'UP';
        if (c.close < ind.ema50) return 'DOWN';
        return null;
    },

    A4: (idx, c, ind) => {
        if (c.close > ind.ema200) return 'UP';
        if (c.close < ind.ema200) return 'DOWN';
        return null;
    },

    A5: (idx, c, ind) => {
        if (ind.macd > ind.signal) return 'UP';
        if (ind.macd < ind.signal) return 'DOWN';
        return null;
    },

    B1: (idx, c, ind) => {
        if (ind.adx >= 25 && ind.plusDI > ind.minusDI && c.close > ind.ema50) return 'UP';
        if (ind.adx >= 25 && ind.minusDI > ind.plusDI && c.close < ind.ema50) return 'DOWN';
        return null;
    },

    B2: (idx, c, ind) => {
        if (ind.adx >= 25 && ind.plusDI > ind.minusDI && ind.macd > ind.signal) return 'UP';
        if (ind.adx >= 25 && ind.minusDI > ind.plusDI && ind.macd < ind.signal) return 'DOWN';
        return null;
    },

    B3: (idx, c, ind) => {
        if (c.close > ind.ema50 && ind.macd > ind.signal) return 'UP';
        if (c.close < ind.ema50 && ind.macd < ind.signal) return 'DOWN';
        return null;
    },

    B4: (idx, c, ind) => {
        if (ind.adx >= 25 && ind.plusDI > ind.minusDI && c.close > ind.ema200) return 'UP';
        if (ind.adx >= 25 && ind.minusDI > ind.plusDI && c.close < ind.ema200) return 'DOWN';
        return null;
    },

    C1: (idx, c, ind) => {
        if (ind.adx >= 25 && ind.plusDI > ind.minusDI && c.close > ind.ema50 && ind.macd > ind.signal) return 'UP';
        if (ind.adx >= 25 && ind.minusDI > ind.plusDI && c.close < ind.ema50 && ind.macd < ind.signal) return 'DOWN';
        return null;
    },

    C2: (idx, c, ind) => {
        if (ind.adx >= 25 && ind.plusDI > ind.minusDI && c.close > ind.ema200 && ind.macd > ind.signal) return 'UP';
        if (ind.adx >= 25 && ind.minusDI > ind.plusDI && c.close < ind.ema200 && ind.macd < ind.signal) return 'DOWN';
        return null;
    }
};

function labelDirection(candles: Candle[], idx: number, horizon: number = 20): 'UP' | 'DOWN' | null {
    if (idx + horizon >= candles.length) return null;

    const currentPrice = candles[idx].close;
    const futurePrice = candles[idx + horizon].close;
    const change = (futurePrice - currentPrice) / currentPrice;

    if (change > 0.005) return 'UP';
    if (change < -0.005) return 'DOWN';
    return null;
}

function testTimeframe(
    candles: Candle[],
    methodName: string,
    method: DirectionMethod,
    labelHorizon: number = 20
): Result {
    const indicators = computeIndicators(candles);

    let total = 0, correct = 0;
    let totalUp = 0, correctUp = 0;
    let totalDown = 0, correctDown = 0;

    for (let i = 200; i < candles.length - labelHorizon; i++) {
        const label = labelDirection(candles, i, labelHorizon);
        if (!label) continue;

        const pred = method(i, candles[i], indicators[i]);
        if (!pred) continue;

        total++;
        if (pred === label) correct++;

        if (pred === 'UP') {
            totalUp++;
            if (label === 'UP') correctUp++;
        } else if (pred === 'DOWN') {
            totalDown++;
            if (label === 'DOWN') correctDown++;
        }
    }

    return {
        method: methodName,
        timeframe: '',
        total,
        correct,
        correctUp,
        totalUp,
        correctDown,
        totalDown,
        pctCorrect: total > 0 ? (correct / total) * 100 : 0,
        pctCorrectUp: totalUp > 0 ? (correctUp / totalUp) * 100 : 0,
        pctCorrectDown: totalDown > 0 ? (correctDown / totalDown) * 100 : 0
    };
}

function loadData(symbol: string, timeframe: string): Candle[] {
    const filePath = resolve(DATA_DIR, `ohlcv-${symbol}-${timeframe}.json`);
    let raw: RawCandle[];
    try {
        raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch (err) {
        console.error(`Không đọc được ${filePath}: ${(err as Error).message}`);
        return [];
    }
    return raw.map((c) => ({
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        timestamp: c.openTime,
    }));
}

function main() {
    const symbols = ['BTCUSDT'];
    const timeframes = ['15m', '1h', '4h'];
    const methodNames = Object.keys(METHODS);
    const allResults: Result[] = [];

    for (const symbol of symbols) {
        for (const tf of timeframes) {
            console.log(`Loading ${symbol} ${tf}...`);
            const candles = loadData(symbol, tf);
            if (candles.length === 0) {
                console.error(`No data for ${symbol} ${tf}`);
                continue;
            }

            console.log(`Testing ${methodNames.length} methods on ${tf}...`);
            for (const name of methodNames) {
                const result = testTimeframe(candles, name, METHODS[name]);
                result.timeframe = tf;
                allResults.push(result);
            }
        }
    }

    console.log('\n========== KẾT QUẢ ==========\n');
    console.log('Method\tTF\tn\t%tổng\t%UP\t%DOWN');

    const sorted = allResults.sort((a, b) => b.pctCorrect - a.pctCorrect);
    for (const r of sorted) {
        console.log(
            `${r.method}\t${r.timeframe}\t${r.total}\t${r.pctCorrect.toFixed(1)}%\t${r.pctCorrectUp.toFixed(1)}%\t${r.pctCorrectDown.toFixed(1)}%`
        );
    }

    console.log('\n========== TOP 3 ==========');
    const top3 = sorted.slice(0, 3);
    for (let i = 0; i < top3.length; i++) {
        const r = top3[i];
        console.log(`${i + 1}. ${r.method} (${r.timeframe}): ${r.pctCorrect.toFixed(1)}% (n=${r.total})`);
    }

    const jsonPath = resolve(DATA_DIR, 'ticket05x-regime-direction-results.json');
    writeFileSync(jsonPath, JSON.stringify(sorted, null, 2));
    console.log(`\nĐã lưu ${jsonPath}`);

    const csvHeader = 'method,timeframe,n,pctCorrect,pctCorrectUp,pctCorrectDown,totalUp,correctUp,totalDown,correctDown';
    const csvRows = sorted.map((r) =>
        [
            r.method,
            r.timeframe,
            r.total,
            r.pctCorrect.toFixed(2),
            r.pctCorrectUp.toFixed(2),
            r.pctCorrectDown.toFixed(2),
            r.totalUp,
            r.correctUp,
            r.totalDown,
            r.correctDown,
        ].join(','),
    );
    const csvPath = resolve(DATA_DIR, 'ticket05x-regime-direction-results.csv');
    writeFileSync(csvPath, [csvHeader, ...csvRows].join('\n'));
    console.log(`Đã lưu ${csvPath}`);
}

main();