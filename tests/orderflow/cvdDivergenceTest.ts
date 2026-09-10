import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../data');
const SYMBOL = 'BTCUSDT';
const SWING_WINDOW = 2;
const HORIZONS = [5, 10, 20];
const MOVE_THRESHOLD = 0.005;

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
    close: number;
    cvd: number;
}

type DivergenceType = 'BULLISH' | 'BEARISH';

interface Signal {
    type: DivergenceType;
    index: number;
}

interface HorizonResult {
    divergence: DivergenceType | 'TOTAL';
    horizon: number;
    n: number;
    correct: number;
    pctCorrect: number;
}

function loadJson<T>(fileName: string): T {
    const filePath = resolve(DATA_DIR, fileName);
    return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function alignCandlesWithCvd(candles: RawCandle[], cvdBuckets: CvdBucket[]): Bar[] {
    const cvdByOpenTime = new Map(cvdBuckets.map((b) => [b.openTime, b.cvd]));
    const bars: Bar[] = [];
    for (const c of candles) {
        const cvd = cvdByOpenTime.get(c.openTime);
        if (cvd === undefined) continue;
        bars.push({ openTime: c.openTime, close: c.close, cvd });
    }
    return bars;
}

function isSwingLow(values: number[], i: number, window: number): boolean {
    if (i < window || i + window >= values.length) return false;
    for (let k = 1; k <= window; k++) {
        if (values[i - k] <= values[i] || values[i + k] <= values[i]) return false;
    }
    return true;
}

function isSwingHigh(values: number[], i: number, window: number): boolean {
    if (i < window || i + window >= values.length) return false;
    for (let k = 1; k <= window; k++) {
        if (values[i - k] >= values[i] || values[i + k] >= values[i]) return false;
    }
    return true;
}

function detectDivergences(bars: Bar[]): Signal[] {
    const price = bars.map((b) => b.close);
    const cvd = bars.map((b) => b.cvd);

    const signals: Signal[] = [];
    let prevLow: number | null = null;
    let prevHigh: number | null = null;

    for (let i = 0; i < bars.length; i++) {
        if (isSwingLow(price, i, SWING_WINDOW)) {
            if (prevLow !== null && price[i] < price[prevLow] && cvd[i] > cvd[prevLow]) {
                signals.push({ type: 'BULLISH', index: i });
            }
            prevLow = i;
        }
        if (isSwingHigh(price, i, SWING_WINDOW)) {
            if (prevHigh !== null && price[i] > price[prevHigh] && cvd[i] < cvd[prevHigh]) {
                signals.push({ type: 'BEARISH', index: i });
            }
            prevHigh = i;
        }
    }
    return signals;
}

// signal.index là nến pivot — nhưng pivot chỉ được XÁC NHẬN là swing sau SWING_WINDOW nến kế tiếp.
// Entry thực tế chỉ có thể đặt tại signal.index + SWING_WINDOW, không phải tại chính nến pivot
// (nếu không sẽ dính lookahead bias — biết trước đáy/đỉnh trước khi nó được xác nhận).
function evaluateSignal(bars: Bar[], signal: Signal, horizon: number): 'CORRECT' | 'WRONG' | 'IGNORE' {
    const entryIndex = signal.index + SWING_WINDOW;
    const targetIndex = entryIndex + horizon;
    if (targetIndex >= bars.length) return 'IGNORE';

    const entryPrice = bars[entryIndex].close;
    const futurePrice = bars[targetIndex].close;
    const change = (futurePrice - entryPrice) / entryPrice;

    if (signal.type === 'BULLISH') {
        if (change > MOVE_THRESHOLD) return 'CORRECT';
        if (change < -MOVE_THRESHOLD) return 'WRONG';
        return 'IGNORE';
    }
    if (change < -MOVE_THRESHOLD) return 'CORRECT';
    if (change > MOVE_THRESHOLD) return 'WRONG';
    return 'IGNORE';
}

function main() {
    const candles = loadJson<RawCandle[]>(`ohlcv-${SYMBOL}-15m-last30d.json`);
    const cvdBuckets = loadJson<CvdBucket[]>(`cvd-${SYMBOL}-15m.json`);
    const bars = alignCandlesWithCvd(candles, cvdBuckets);

    console.log(`Đã căn chỉnh ${bars.length}/${candles.length} nến M15 với dữ liệu CVD.`);

    const signals = detectDivergences(bars);
    const bullish = signals.filter((s) => s.type === 'BULLISH');
    const bearish = signals.filter((s) => s.type === 'BEARISH');
    console.log(`Phát hiện ${bullish.length} Bullish Divergence, ${bearish.length} Bearish Divergence.`);

    const results: HorizonResult[] = [];

    for (const horizon of HORIZONS) {
        for (const type of ['BULLISH', 'BEARISH'] as DivergenceType[]) {
            const group = signals.filter((s) => s.type === type);
            let correct = 0;
            let n = 0;
            for (const s of group) {
                const outcome = evaluateSignal(bars, s, horizon);
                if (outcome === 'IGNORE') continue;
                n++;
                if (outcome === 'CORRECT') correct++;
            }
            results.push({
                divergence: type,
                horizon,
                n,
                correct,
                pctCorrect: n > 0 ? (correct / n) * 100 : 0,
            });
        }

        let totalCorrect = 0;
        let totalN = 0;
        for (const s of signals) {
            const outcome = evaluateSignal(bars, s, horizon);
            if (outcome === 'IGNORE') continue;
            totalN++;
            if (outcome === 'CORRECT') totalCorrect++;
        }
        results.push({
            divergence: 'TOTAL',
            horizon,
            n: totalN,
            correct: totalCorrect,
            pctCorrect: totalN > 0 ? (totalCorrect / totalN) * 100 : 0,
        });
    }

    console.log('\n========== KẾT QUẢ ==========\n');
    console.log('Divergence\tHorizon\tn\t%Đúng');
    for (const r of results) {
        console.log(`${r.divergence}\t${r.horizon}\t${r.n}\t${r.pctCorrect.toFixed(1)}%`);
    }

    const bullish5 = results.find((r) => r.divergence === 'BULLISH' && r.horizon === 5);
    const bearish5 = results.find((r) => r.divergence === 'BEARISH' && r.horizon === 5);
    console.log('\n========== ĐÁNH GIÁ (horizon 5 nến) ==========');
    if (bullish5 && bearish5) {
        if (bullish5.pctCorrect > 55 && bearish5.pctCorrect > 55) {
            console.log('THÀNH CÔNG: cả 2 chiều đều > 55%.');
        } else if (bullish5.pctCorrect > 55 || bearish5.pctCorrect > 55) {
            console.log('CÓ THỂ DÙNG: 1 chiều > 55%.');
        } else if (bullish5.pctCorrect <= 52 && bearish5.pctCorrect <= 52) {
            console.log('THẤT BẠI: cả 2 chiều <= 52%.');
        } else {
            console.log('KHÔNG RÕ RÀNG: giữa 52% và 55%.');
        }
    }

    const jsonPath = resolve(DATA_DIR, 'ticket06x-cvd-divergence-results.json');
    writeFileSync(jsonPath, JSON.stringify(results, null, 2));
    console.log(`\nĐã lưu ${jsonPath}`);

    const csvHeader = 'divergence,horizon,n,correct,pctCorrect';
    const csvRows = results.map((r) => [r.divergence, r.horizon, r.n, r.correct, r.pctCorrect.toFixed(2)].join(','));
    const csvPath = resolve(DATA_DIR, 'ticket06x-cvd-divergence-results.csv');
    writeFileSync(csvPath, [csvHeader, ...csvRows].join('\n'));
    console.log(`Đã lưu ${csvPath}`);
}

main();
