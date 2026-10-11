import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../data');
const RESULTS_DIR = resolve(DATA_DIR, 'results');
const SYMBOL = 'BTCUSDT';
const SUFFIX = '2021-2024';
const RANGE_END = Date.parse('2024-01-01T00:00:00Z');

// Tham số theo TICKET-11X-SIGNAL-GENERATOR (M15) — không tối ưu.
const ADX_TREND = 30;
const ADX_SIDEWAY = 22;
const EMA_PERIOD = 100;
const ATR_PERIOD = 14;
const SWING_LOOKBACK = 10;
const MIN_RR = 3;
const NOMINAL_EQUITY = 10000;
const RISK_PCT = 0.01;

interface RawCandle {
    openTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    closeTime: number;
}

type Regime = 'TREND' | 'SIDEWAY' | 'TRANSITION';
type Direction = 'UP' | 'DOWN' | 'NEUTRAL';
type EntrySignal = 'LONG' | 'SHORT' | 'WAIT';

interface AcceptedSignal {
    index: number;
    timestamp: string;
    direction: 'LONG' | 'SHORT';
    entry: number;
    stopLoss: number;
    takeProfit: number;
    size: number;
    riskRewardRatio: number;
}

function loadCandles(): RawCandle[] {
    const all = JSON.parse(readFileSync(resolve(DATA_DIR, `ohlcv-${SYMBOL}-15m-${SUFFIX}.json`), 'utf-8')) as RawCandle[];
    return all.filter((c) => c.openTime < RANGE_END);
}

// ===================== Indicators =====================

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

function calculateEMA(data: number[], period: number): number[] {
    const result: number[] = [];
    const multiplier = 2 / (period + 1);
    for (let i = 0; i < data.length; i++) {
        result.push(i === 0 ? data[i] : (data[i] - result[i - 1]) * multiplier + result[i - 1]);
    }
    return result;
}

function calculateADX(candles: RawCandle[], period: number): { adx: number[]; plusDI: number[]; minusDI: number[] } {
    const high = candles.map((c) => c.high);
    const low = candles.map((c) => c.low);
    const close = candles.map((c) => c.close);

    const tr: number[] = [];
    const plusDM: number[] = [];
    const minusDM: number[] = [];
    for (let i = 1; i < candles.length; i++) {
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

    const pad = candles.length - adx.length;
    return {
        adx: [...Array(pad).fill(0), ...adx],
        plusDI: [...Array(pad).fill(0), ...plusDI],
        minusDI: [...Array(pad).fill(0), ...minusDI],
    };
}

function calculateATR(candles: RawCandle[], period: number): number[] {
    const tr: number[] = [];
    for (let i = 0; i < candles.length; i++) {
        const prevClose = i > 0 ? candles[i - 1].close : candles[i].close;
        tr.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - prevClose), Math.abs(candles[i].low - prevClose)));
    }
    return wilderSmooth(tr, period);
}

// ===================== Candle patterns =====================
// Định nghĩa cổ điển, đơn giản — không tối ưu tham số.

function isDoji(c: RawCandle): boolean {
    const range = c.high - c.low;
    if (range <= 0) return false;
    return Math.abs(c.close - c.open) / range <= 0.1;
}

function isHammer(c: RawCandle): boolean {
    const range = c.high - c.low;
    if (range <= 0) return false;
    const body = Math.abs(c.close - c.open);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const upperWick = c.high - Math.max(c.open, c.close);
    return body > 0 && lowerWick >= 2 * body && upperWick <= body;
}

function isShootingStar(c: RawCandle): boolean {
    const range = c.high - c.low;
    if (range <= 0) return false;
    const body = Math.abs(c.close - c.open);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const upperWick = c.high - Math.max(c.open, c.close);
    return body > 0 && upperWick >= 2 * body && lowerWick <= body;
}

function isBullishEngulfing(prev: RawCandle, curr: RawCandle): boolean {
    const prevBearish = prev.close < prev.open;
    const currBullish = curr.close > curr.open;
    return prevBearish && currBullish && curr.open <= prev.close && curr.close >= prev.open;
}

function isBearishEngulfing(prev: RawCandle, curr: RawCandle): boolean {
    const prevBullish = prev.close > prev.open;
    const currBearish = curr.close < curr.open;
    return prevBullish && currBearish && curr.open >= prev.close && curr.close <= prev.open;
}

function isInsideBar(prev: RawCandle, curr: RawCandle): boolean {
    return curr.high <= prev.high && curr.low >= prev.low;
}

// ===================== Structure: rolling swing high/low =====================
// "Swing lookback 10 nến": dùng highest-high / lowest-low của 10 nến liền trước (không tính nến hiện tại).

function rollingLow(candles: RawCandle[], i: number, period: number): number {
    let min = Infinity;
    for (let k = Math.max(0, i - period); k < i; k++) min = Math.min(min, candles[k].low);
    return min;
}
function rollingHigh(candles: RawCandle[], i: number, period: number): number {
    let max = -Infinity;
    for (let k = Math.max(0, i - period); k < i; k++) max = Math.max(max, candles[k].high);
    return max;
}

// ===================== 4-layer pipeline =====================

interface FunnelStats {
    totalCandles: number;
    regimeTrend: number;
    regimeSideway: number;
    regimeTransition: number;
    directionUp: number;
    directionDown: number;
    directionNeutral: number;
    entryLong: number;
    entryShort: number;
    entryWait: number;
    rejectedByRR: number;
    accepted: number;
}

function main() {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const candles = loadCandles();
    console.log(`Đã nạp ${candles.length} nến M15 (${SUFFIX}).`);

    const close = candles.map((c) => c.close);
    const { adx, plusDI, minusDI } = calculateADX(candles, ATR_PERIOD);
    const ema100 = calculateEMA(close, EMA_PERIOD);
    const atr = calculateATR(candles, ATR_PERIOD);

    const WARMUP = Math.max(EMA_PERIOD, ATR_PERIOD, SWING_LOOKBACK) + 5;

    const stats: FunnelStats = {
        totalCandles: 0,
        regimeTrend: 0,
        regimeSideway: 0,
        regimeTransition: 0,
        directionUp: 0,
        directionDown: 0,
        directionNeutral: 0,
        entryLong: 0,
        entryShort: 0,
        entryWait: 0,
        rejectedByRR: 0,
        accepted: 0,
    };

    const accepted: AcceptedSignal[] = [];

    for (let i = WARMUP; i < candles.length - 3; i++) {
        stats.totalCandles++;

        // Tầng 1: Regime
        let regime: Regime;
        if (adx[i] >= ADX_TREND) regime = 'TREND';
        else if (adx[i] < ADX_SIDEWAY) regime = 'SIDEWAY';
        else regime = 'TRANSITION';

        if (regime === 'TREND') stats.regimeTrend++;
        else if (regime === 'SIDEWAY') stats.regimeSideway++;
        else stats.regimeTransition++;

        if (regime !== 'TREND') continue; // Tầng 1 dừng

        // Tầng 2: Direction
        let direction: Direction;
        if (plusDI[i] > minusDI[i] && close[i] > ema100[i]) direction = 'UP';
        else if (minusDI[i] > plusDI[i] && close[i] < ema100[i]) direction = 'DOWN';
        else direction = 'NEUTRAL';

        if (direction === 'UP') stats.directionUp++;
        else if (direction === 'DOWN') stats.directionDown++;
        else stats.directionNeutral++;

        if (direction === 'NEUTRAL') continue; // Tầng 2 dừng

        // Tầng 3: Entry
        const curr = candles[i];
        const prev = candles[i - 1];
        let entrySignal: EntrySignal = 'WAIT';

        if (direction === 'UP') {
            const swingLow = rollingLow(candles, i, SWING_LOOKBACK);
            const zoneLow = swingLow - 0.5 * atr[i];
            const zoneHigh = swingLow + 0.5 * atr[i];
            const touchedZone = curr.low <= zoneHigh && curr.low >= zoneLow;
            if (touchedZone) {
                const strongConfirm = isHammer(curr) || isBullishEngulfing(prev, curr);
                const weakConfirm = curr.close > curr.open;
                const blocked = isDoji(curr) || isInsideBar(prev, curr);
                if (!blocked && (strongConfirm || weakConfirm)) entrySignal = 'LONG';
            }
        } else {
            const swingHigh = rollingHigh(candles, i, SWING_LOOKBACK);
            const zoneLow = swingHigh - 0.5 * atr[i];
            const zoneHigh = swingHigh + 0.5 * atr[i];
            const touchedZone = curr.high <= zoneHigh && curr.high >= zoneLow;
            if (touchedZone) {
                const strongConfirm = isShootingStar(curr) || isBearishEngulfing(prev, curr);
                const weakConfirm = curr.close < curr.open;
                const blocked = isDoji(curr) || isInsideBar(prev, curr);
                if (!blocked && (strongConfirm || weakConfirm)) entrySignal = 'SHORT';
            }
        }

        if (entrySignal === 'LONG') stats.entryLong++;
        else if (entrySignal === 'SHORT') stats.entryShort++;
        else stats.entryWait++;

        if (entrySignal === 'WAIT') continue; // Tầng 3 dừng

        // Tầng 4: Exit + Risk
        const entry = curr.close;
        const last3Low = Math.min(candles[i - 2].low, candles[i - 1].low, candles[i].low);
        const last3High = Math.max(candles[i - 2].high, candles[i - 1].high, candles[i].high);

        if (entrySignal === 'LONG') {
            const stopLoss = last3Low - 0.5 * atr[i];
            const takeProfit = rollingHigh(candles, i, SWING_LOOKBACK);
            const risk = entry - stopLoss;
            const reward = takeProfit - entry;
            const rr = risk > 0 ? reward / risk : 0;
            if (rr < MIN_RR || risk <= 0) {
                stats.rejectedByRR++;
                continue;
            }
            const size = (NOMINAL_EQUITY * RISK_PCT) / risk;
            accepted.push({
                index: i,
                timestamp: new Date(curr.openTime).toISOString(),
                direction: 'LONG',
                entry,
                stopLoss,
                takeProfit,
                size,
                riskRewardRatio: rr,
            });
            stats.accepted++;
        } else {
            const stopLoss = last3High + 0.5 * atr[i];
            const takeProfit = rollingLow(candles, i, SWING_LOOKBACK);
            const risk = stopLoss - entry;
            const reward = entry - takeProfit;
            const rr = risk > 0 ? reward / risk : 0;
            if (rr < MIN_RR || risk <= 0) {
                stats.rejectedByRR++;
                continue;
            }
            const size = (NOMINAL_EQUITY * RISK_PCT) / risk;
            accepted.push({
                index: i,
                timestamp: new Date(curr.openTime).toISOString(),
                direction: 'SHORT',
                entry,
                stopLoss,
                takeProfit,
                size,
                riskRewardRatio: rr,
            });
            stats.accepted++;
        }
    }

    console.log('\n========== FUNNEL (Tầng 1 -> Tầng 4) ==========\n');
    console.log(`Tổng nến xét: ${stats.totalCandles}`);
    console.log(`Tầng 1 - Regime: TREND=${stats.regimeTrend}, SIDEWAY=${stats.regimeSideway}, TRANSITION=${stats.regimeTransition}`);
    console.log(`Tầng 2 - Direction (trong TREND): UP=${stats.directionUp}, DOWN=${stats.directionDown}, NEUTRAL=${stats.directionNeutral}`);
    console.log(`Tầng 3 - Entry (trong UP/DOWN): LONG=${stats.entryLong}, SHORT=${stats.entryShort}, WAIT=${stats.entryWait}`);
    console.log(`Tầng 4 - Risk filter: bị chặn do R:R<${MIN_RR} = ${stats.rejectedByRR}`);
    console.log(`=> Tín hiệu được chấp nhận: ${stats.accepted}`);

    const months = new Set(accepted.map((s) => s.timestamp.slice(0, 7)));
    console.log(`Trải trên ${months.size} tháng, trung bình ${(stats.accepted / months.size).toFixed(1)} lệnh/tháng.`);

    writeFileSync(resolve(RESULTS_DIR, 'm15-signals.json'), JSON.stringify(accepted, null, 2));
    writeFileSync(resolve(DATA_DIR, 'ticket11x-funnel-stats.json'), JSON.stringify(stats, null, 2));
    console.log(`\nĐã lưu ${accepted.length} tín hiệu vào data/results/m15-signals.json`);
    console.log('Đã lưu funnel stats vào data/ticket11x-funnel-stats.json');
}

main();
