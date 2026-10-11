import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../data');
const SYMBOL = 'BTCUSDT';
const SUFFIX = '6m';
const SWING_WINDOW = 2;
const HORIZONS = [5, 10, 20, 50];
const MOVE_THRESHOLD = 0.005;
const Z_95 = 1.96;

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
    low: number;
    high: number;
    cvd: number;
}

type DivergenceType = 'BULLISH' | 'BEARISH';

interface Signal {
    type: DivergenceType;
    index: number;
}

function loadJson<T>(fileName: string): T {
    return JSON.parse(readFileSync(resolve(DATA_DIR, fileName), 'utf-8'));
}

function alignCandlesWithCvd(candles: RawCandle[], cvdBuckets: CvdBucket[]): Bar[] {
    const cvdByOpenTime = new Map(cvdBuckets.map((b) => [b.openTime, b.cvd]));
    const bars: Bar[] = [];
    for (const c of candles) {
        const cvd = cvdByOpenTime.get(c.openTime);
        if (cvd === undefined) continue;
        bars.push({ openTime: c.openTime, close: c.close, low: c.low, high: c.high, cvd });
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
    const low = bars.map((b) => b.low);
    const high = bars.map((b) => b.high);
    const cvd = bars.map((b) => b.cvd);

    const signals: Signal[] = [];
    let prevLow: number | null = null;
    let prevHigh: number | null = null;

    for (let i = 0; i < bars.length; i++) {
        if (isSwingLow(low, i, SWING_WINDOW)) {
            if (prevLow !== null && low[i] < low[prevLow] && cvd[i] > cvd[prevLow]) {
                signals.push({ type: 'BULLISH', index: i });
            }
            prevLow = i;
        }
        if (isSwingHigh(high, i, SWING_WINDOW)) {
            if (prevHigh !== null && high[i] > high[prevHigh] && cvd[i] < cvd[prevHigh]) {
                signals.push({ type: 'BEARISH', index: i });
            }
            prevHigh = i;
        }
    }
    return signals;
}

// signal.index là nến pivot — nhưng pivot chỉ được XÁC NHẬN là swing sau SWING_WINDOW nến kế tiếp
// (định nghĩa "thấp/cao hơn 2 nến sau"). Entry thực tế chỉ có thể đặt tại signal.index + SWING_WINDOW,
// không phải tại chính nến pivot — nếu không sẽ dính lookahead bias (biết trước đáy/đỉnh).
function evaluateSignal(bars: Bar[], signal: Signal, horizon: number, invert: boolean): 'CORRECT' | 'WRONG' | 'IGNORE' {
    const entryIndex = signal.index + SWING_WINDOW;
    const targetIndex = entryIndex + horizon;
    if (targetIndex >= bars.length) return 'IGNORE';

    const entryPrice = bars[entryIndex].close;
    const futurePrice = bars[targetIndex].close;
    const change = (futurePrice - entryPrice) / entryPrice;

    const effectiveType = invert ? (signal.type === 'BULLISH' ? 'BEARISH' : 'BULLISH') : signal.type;

    if (effectiveType === 'BULLISH') {
        if (change > MOVE_THRESHOLD) return 'CORRECT';
        if (change < -MOVE_THRESHOLD) return 'WRONG';
        return 'IGNORE';
    }
    if (change < -MOVE_THRESHOLD) return 'CORRECT';
    if (change > MOVE_THRESHOLD) return 'WRONG';
    return 'IGNORE';
}

function wilsonInterval(correct: number, n: number, z: number = Z_95): [number, number] {
    if (n === 0) return [0, 0];
    const phat = correct / n;
    const denom = 1 + (z * z) / n;
    const center = phat + (z * z) / (2 * n);
    const margin = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * n)) / n);
    return [Math.max(0, (center - margin) / denom) * 100, Math.min(1, (center + margin) / denom) * 100];
}

function scoreGroup(bars: Bar[], group: Signal[], horizon: number, invert: boolean) {
    let correct = 0;
    let n = 0;
    for (const s of group) {
        const outcome = evaluateSignal(bars, s, horizon, invert);
        if (outcome === 'IGNORE') continue;
        n++;
        if (outcome === 'CORRECT') correct++;
    }
    return { n, correct, pct: n > 0 ? (correct / n) * 100 : 0 };
}

interface MainResultRow {
    divergence: DivergenceType;
    horizon: number;
    n: number;
    correct: number;
    pctCorrect: number;
    ciLow: number;
    ciHigh: number;
    conclusion: string;
}

interface InverseRow {
    divergence: DivergenceType;
    horizon: number;
    pctOriginal: number;
    pctInverted: number;
    conclusion: string;
}

interface PeriodRow {
    period: string;
    bullishPct: number;
    bullishN: number;
    bearishPct: number;
    bearishN: number;
}

function main() {
    const candles = loadJson<RawCandle[]>(`ohlcv-${SYMBOL}-15m-${SUFFIX}.json`);
    const cvdBuckets = loadJson<CvdBucket[]>(`cvd-${SYMBOL}-15m-${SUFFIX}.json`);
    const bars = alignCandlesWithCvd(candles, cvdBuckets);
    console.log(`Đã căn chỉnh ${bars.length}/${candles.length} nến M15 với dữ liệu CVD (${SUFFIX}).`);

    const signals = detectDivergences(bars);
    const bullishAll = signals.filter((s) => s.type === 'BULLISH');
    const bearishAll = signals.filter((s) => s.type === 'BEARISH');
    console.log(`Phát hiện ${bullishAll.length} Bullish, ${bearishAll.length} Bearish divergence trên toàn bộ ${SUFFIX}.`);

    const mainResults: MainResultRow[] = [];
    for (const horizon of HORIZONS) {
        for (const type of ['BULLISH', 'BEARISH'] as DivergenceType[]) {
            const group = signals.filter((s) => s.type === type);
            const { n, correct, pct } = scoreGroup(bars, group, horizon, false);
            const [ciLow, ciHigh] = wilsonInterval(correct, n);
            const conclusion =
                n === 0
                    ? 'Không có mẫu'
                    : ciLow > 50
                      ? 'CI không chứa 50% (có ý nghĩa)'
                      : 'CI chứa 50% (chưa kết luận được)';
            mainResults.push({ divergence: type, horizon, n, correct, pctCorrect: pct, ciLow, ciHigh, conclusion });
        }
    }

    console.log('\n========== BẢNG 1: KẾT QUẢ CHÍNH ==========\n');
    console.log('Divergence\tHorizon\tn\t%Đúng\tCI95%\t\tKết luận');
    for (const r of mainResults) {
        console.log(
            `${r.divergence}\t${r.horizon}\t${r.n}\t${r.pctCorrect.toFixed(1)}%\t[${r.ciLow.toFixed(1)}, ${r.ciHigh.toFixed(1)}]\t${r.conclusion}`,
        );
    }

    const inverseResults: InverseRow[] = [];
    for (const horizon of HORIZONS) {
        for (const type of ['BULLISH', 'BEARISH'] as DivergenceType[]) {
            const group = signals.filter((s) => s.type === type);
            const original = scoreGroup(bars, group, horizon, false);
            const inverted = scoreGroup(bars, group, horizon, true);
            const conclusion =
                inverted.pct < 45
                    ? 'Đảo ngược tụt <45% — nhất quán với tín hiệu có hướng'
                    : 'Đảo ngược vẫn ~50% — dấu hiệu nhiễu';
            inverseResults.push({ divergence: type, horizon, pctOriginal: original.pct, pctInverted: inverted.pct, conclusion });
        }
    }

    console.log('\n========== BẢNG 2: KIỂM TRA ĐẢO NGƯỢC ==========\n');
    console.log('(Lưu ý: %đúng đảo = 100 - %đúng gốc theo đúng cấu trúc đối xứng của ngưỡng ±0.5% — đây là hệ quả toán học tất yếu, không phải bằng chứng độc lập.)');
    console.log('Divergence\tHorizon\t%Đúng gốc\t%Đúng đảo\tKết luận');
    for (const r of inverseResults) {
        console.log(`${r.divergence}\t${r.horizon}\t${r.pctOriginal.toFixed(1)}%\t${r.pctInverted.toFixed(1)}%\t${r.conclusion}`);
    }

    const minTime = bars[0].openTime;
    const maxTime = bars[bars.length - 1].openTime;
    const periodMs = (maxTime - minTime) / 3;
    const periodLabels = ['GĐ1', 'GĐ2', 'GĐ3'];
    const periodResults: PeriodRow[] = [];
    for (let p = 0; p < 3; p++) {
        const periodStart = minTime + p * periodMs;
        const periodEnd = p === 2 ? maxTime + 1 : minTime + (p + 1) * periodMs;
        const periodBars = bars.filter((b) => b.openTime >= periodStart && b.openTime < periodEnd);
        const periodSignals = detectDivergences(periodBars);
        const bullishGroup = periodSignals.filter((s) => s.type === 'BULLISH');
        const bearishGroup = periodSignals.filter((s) => s.type === 'BEARISH');
        const bullishScore = scoreGroup(periodBars, bullishGroup, 5, false);
        const bearishScore = scoreGroup(periodBars, bearishGroup, 5, false);
        periodResults.push({
            period: periodLabels[p],
            bullishPct: bullishScore.pct,
            bullishN: bullishScore.n,
            bearishPct: bearishScore.pct,
            bearishN: bearishScore.n,
        });
    }

    console.log('\n========== BẢNG 3: CHIA 3 GIAI ĐOẠN (horizon=5) ==========\n');
    console.log('Giai đoạn\tBullish% (n)\tBearish% (n)');
    for (const r of periodResults) {
        console.log(`${r.period}\t${r.bullishPct.toFixed(1)}% (n=${r.bullishN})\t${r.bearishPct.toFixed(1)}% (n=${r.bearishN})`);
    }

    const h5 = mainResults.filter((r) => r.horizon === 5);
    const bothAbove55H5 = h5.every((r) => r.pctCorrect > 55);
    const bothCiSignificantH5 = h5.every((r) => r.ciLow > 50);
    const inverseH5 = inverseResults.filter((r) => r.horizon === 5);
    const inverseBelow45 = inverseH5.every((r) => r.pctInverted < 45);
    const periodsConsistent = periodResults.every((r) => r.bullishPct > 55) && periodResults.every((r) => r.bearishPct > 55);

    let finalConclusion: string;
    if (periodsConsistent && bothCiSignificantH5 && inverseBelow45) {
        finalConclusion = 'CÓ EDGE THẬT';
    } else if (bothAbove55H5 || bothCiSignificantH5) {
        finalConclusion = 'CHƯA KẾT LUẬN ĐƯỢC — cần thêm dữ liệu';
    } else {
        finalConclusion = 'KHÔNG CÓ EDGE (hoặc chưa đủ bằng chứng)';
    }
    console.log(`\n========== KẾT LUẬN CUỐI (horizon=5) ==========\n${finalConclusion}`);

    writeFileSync(resolve(DATA_DIR, 'ticket06x-extended-main-results.json'), JSON.stringify(mainResults, null, 2));
    writeFileSync(
        resolve(DATA_DIR, 'ticket06x-extended-main-results.csv'),
        [
            'divergence,horizon,n,correct,pctCorrect,ciLow,ciHigh,conclusion',
            ...mainResults.map((r) =>
                [r.divergence, r.horizon, r.n, r.correct, r.pctCorrect.toFixed(2), r.ciLow.toFixed(2), r.ciHigh.toFixed(2), `"${r.conclusion}"`].join(','),
            ),
        ].join('\n'),
    );

    writeFileSync(resolve(DATA_DIR, 'ticket06x-extended-inverse-test.json'), JSON.stringify(inverseResults, null, 2));
    writeFileSync(
        resolve(DATA_DIR, 'ticket06x-extended-inverse-test.csv'),
        [
            'divergence,horizon,pctOriginal,pctInverted,conclusion',
            ...inverseResults.map((r) => [r.divergence, r.horizon, r.pctOriginal.toFixed(2), r.pctInverted.toFixed(2), `"${r.conclusion}"`].join(',')),
        ].join('\n'),
    );

    writeFileSync(resolve(DATA_DIR, 'ticket06x-extended-period-split.json'), JSON.stringify(periodResults, null, 2));
    writeFileSync(
        resolve(DATA_DIR, 'ticket06x-extended-period-split.csv'),
        [
            'period,bullishPct,bullishN,bearishPct,bearishN',
            ...periodResults.map((r) => [r.period, r.bullishPct.toFixed(2), r.bullishN, r.bearishPct.toFixed(2), r.bearishN].join(',')),
        ].join('\n'),
    );

    console.log('\nĐã lưu 3 bảng kết quả vào data/ticket06x-extended-*.{json,csv}');
}

main();
