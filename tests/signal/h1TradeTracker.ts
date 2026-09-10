import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../data');
const RESULTS_DIR = resolve(DATA_DIR, 'results');
const SYMBOL = 'BTCUSDT';
const SUFFIX = '2021-2024';
const RANGE_END = Date.parse('2024-01-01T00:00:00Z');

// TICKET-11X (H1): timeout = 50 nến.
const TIMEOUT_CANDLES = 50;
const FEE_PCT_ROUND_TRIP = 0.0008; // 0.08%/lệnh, theo ghi chú ticket

interface RawCandle {
    openTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    closeTime: number;
}

interface SignalInput {
    index: number;
    timestamp: string;
    direction: 'LONG' | 'SHORT';
    entry: number;
    stopLoss: number;
    takeProfit: number;
    size: number;
    riskRewardRatio: number;
}

interface Trade {
    id: string;
    entry_time: string;
    direction: 'LONG' | 'SHORT';
    entry: number;
    stop_loss: number;
    take_profit: number;
    risk: number;
    mfe_r: number;
    mae_r: number;
    time_to_mfe: number;
    time_to_mae: number;
    exit_time: string;
    exit_price: number;
    result: 'WIN' | 'LOSS' | 'BREAKEVEN';
    exit_reason: 'TP' | 'SL' | 'TIMEOUT';
    pnl_r: number;
    fee_r: number;
    pnl_r_after_fee: number;
}

function loadCandles(): RawCandle[] {
    const all = JSON.parse(readFileSync(resolve(DATA_DIR, `ohlcv-${SYMBOL}-1h-${SUFFIX}.json`), 'utf-8')) as RawCandle[];
    return all.filter((c) => c.openTime < RANGE_END);
}

function trackTrade(candles: RawCandle[], signal: SignalInput, tradeNumber: number): Trade {
    const { index: entryIndex, direction, entry, stopLoss, takeProfit } = signal;
    const risk = direction === 'LONG' ? entry - stopLoss : stopLoss - entry;

    let mfeR = 0;
    let maeR = 0;
    let timeToMfe = 0;
    let timeToMae = 0;
    let exitIndex = Math.min(entryIndex + TIMEOUT_CANDLES, candles.length - 1);
    let exitPrice = candles[exitIndex].close;
    let exitReason: Trade['exit_reason'] = 'TIMEOUT';

    const hardEnd = Math.min(entryIndex + TIMEOUT_CANDLES, candles.length - 1);
    for (let j = entryIndex + 1; j <= hardEnd; j++) {
        const bar = candles[j];
        const offset = j - entryIndex;

        if (direction === 'LONG') {
            const favR = (bar.high - entry) / risk;
            const advR = (bar.low - entry) / risk;
            if (favR > mfeR) {
                mfeR = favR;
                timeToMfe = offset;
            }
            if (advR < maeR) {
                maeR = advR;
                timeToMae = offset;
            }
            if (bar.low <= stopLoss) {
                exitIndex = j;
                exitPrice = stopLoss;
                exitReason = 'SL';
                break;
            }
            if (bar.high >= takeProfit) {
                exitIndex = j;
                exitPrice = takeProfit;
                exitReason = 'TP';
                break;
            }
        } else {
            const favR = (entry - bar.low) / risk;
            const advR = (entry - bar.high) / risk;
            if (favR > mfeR) {
                mfeR = favR;
                timeToMfe = offset;
            }
            if (advR < maeR) {
                maeR = advR;
                timeToMae = offset;
            }
            if (bar.high >= stopLoss) {
                exitIndex = j;
                exitPrice = stopLoss;
                exitReason = 'SL';
                break;
            }
            if (bar.low <= takeProfit) {
                exitIndex = j;
                exitPrice = takeProfit;
                exitReason = 'TP';
                break;
            }
        }

        if (offset >= TIMEOUT_CANDLES) {
            exitIndex = j;
            exitPrice = bar.close;
            exitReason = 'TIMEOUT';
            break;
        }
    }

    const pnlR = direction === 'LONG' ? (exitPrice - entry) / risk : (entry - exitPrice) / risk;
    const result: Trade['result'] = pnlR > 0.001 ? 'WIN' : pnlR < -0.001 ? 'LOSS' : 'BREAKEVEN';

    const slDistancePct = Math.abs(entry - stopLoss) / entry;
    const feeR = slDistancePct > 0 ? FEE_PCT_ROUND_TRIP / slDistancePct : 0;

    return {
        id: `trade_${String(tradeNumber).padStart(3, '0')}`,
        entry_time: new Date(candles[entryIndex].openTime).toISOString(),
        direction,
        entry,
        stop_loss: stopLoss,
        take_profit: takeProfit,
        risk,
        mfe_r: Number(mfeR.toFixed(4)),
        mae_r: Number(maeR.toFixed(4)),
        time_to_mfe: timeToMfe,
        time_to_mae: timeToMae,
        exit_time: new Date(candles[exitIndex].openTime).toISOString(),
        exit_price: exitPrice,
        result,
        exit_reason: exitReason,
        pnl_r: Number(pnlR.toFixed(4)),
        fee_r: Number(feeR.toFixed(4)),
        pnl_r_after_fee: Number((pnlR - feeR).toFixed(4)),
    };
}

function mean(xs: number[]): number {
    return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function stdDev(xs: number[]): number {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
function profitFactor(pnls: number[]): number {
    const grossWin = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(pnls.filter((p) => p < 0).reduce((a, b) => a + b, 0));
    if (grossLoss === 0) return grossWin > 0 ? Infinity : 0;
    return grossWin / grossLoss;
}
function maxDrawdownR(pnls: number[]): number {
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

interface MonthlySummary {
    month: string;
    total_trades: number;
    wins: number;
    losses: number;
    win_rate: number;
    avg_mfe_r: number;
    avg_mae_r: number;
    avg_time_to_mfe: number;
    avg_time_to_mae: number;
    profit_factor: number;
    profit_factor_after_fee: number;
    pnl_r: number;
    pnl_r_after_fee: number;
}

function main() {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const candles = loadCandles();
    const signals = JSON.parse(readFileSync(resolve(RESULTS_DIR, 'h1-signals.json'), 'utf-8')) as SignalInput[];
    console.log(`Đã nạp ${candles.length} nến H1 và ${signals.length} tín hiệu ứng viên.`);

    const trades: Trade[] = [];
    let flatFromIndex = 0;
    let tradeCounter = 1;
    for (const signal of signals) {
        if (signal.index < flatFromIndex) continue;
        const trade = trackTrade(candles, signal, tradeCounter++);
        trades.push(trade);
        const exitCandleIndex = candles.findIndex((c) => c.openTime === Date.parse(trade.exit_time));
        flatFromIndex = (exitCandleIndex >= 0 ? exitCandleIndex : signal.index + TIMEOUT_CANDLES) + 1;
    }

    console.log(`Số lệnh thực tế thực thi (không chồng lệnh): ${trades.length}/${signals.length} tín hiệu.`);
    writeFileSync(resolve(RESULTS_DIR, 'h1-trades.json'), JSON.stringify(trades, null, 2));

    const monthKeys = [...new Set(trades.map((t) => t.entry_time.slice(0, 7)))].sort();
    const monthlySummaries: MonthlySummary[] = monthKeys.map((month) => {
        const monthTrades = trades.filter((t) => t.entry_time.slice(0, 7) === month);
        const pnls = monthTrades.map((t) => t.pnl_r);
        const pnlsAfterFee = monthTrades.map((t) => t.pnl_r_after_fee);
        const wins = monthTrades.filter((t) => t.result === 'WIN').length;
        const losses = monthTrades.filter((t) => t.result === 'LOSS').length;
        return {
            month,
            total_trades: monthTrades.length,
            wins,
            losses,
            win_rate: monthTrades.length > 0 ? wins / monthTrades.length : 0,
            avg_mfe_r: mean(monthTrades.map((t) => t.mfe_r)),
            avg_mae_r: mean(monthTrades.map((t) => t.mae_r)),
            avg_time_to_mfe: mean(monthTrades.map((t) => t.time_to_mfe)),
            avg_time_to_mae: mean(monthTrades.map((t) => t.time_to_mae)),
            profit_factor: profitFactor(pnls),
            profit_factor_after_fee: profitFactor(pnlsAfterFee),
            pnl_r: pnls.reduce((a, b) => a + b, 0),
            pnl_r_after_fee: pnlsAfterFee.reduce((a, b) => a + b, 0),
        };
    });
    writeFileSync(resolve(RESULTS_DIR, 'h1-monthly-summary.json'), JSON.stringify(monthlySummaries, null, 2));

    console.log('\n========== TỔNG HỢP THEO THÁNG (H1) ==========\n');
    console.log('Tháng\tn\tWin%\tPF thô\tPF sau phí\tPnL_R thô\tPnL_R sau phí');
    for (const m of monthlySummaries) {
        console.log(
            `${m.month}\t${m.total_trades}\t${(m.win_rate * 100).toFixed(1)}%\t${m.profit_factor === Infinity ? '∞' : m.profit_factor.toFixed(2)}\t${m.profit_factor_after_fee === Infinity ? '∞' : m.profit_factor_after_fee.toFixed(2)}\t${m.pnl_r.toFixed(2)}\t${m.pnl_r_after_fee.toFixed(2)}`,
        );
    }

    const allPnls = trades.map((t) => t.pnl_r);
    const allPnlsAfterFee = trades.map((t) => t.pnl_r_after_fee);
    const wins = trades.filter((t) => t.result === 'WIN').length;
    const losses = trades.filter((t) => t.result === 'LOSS').length;
    const avgMfe = mean(trades.map((t) => t.mfe_r));
    const avgMae = mean(trades.map((t) => t.mae_r));
    const pfRaw = profitFactor(allPnls);
    const pfAfterFee = profitFactor(allPnlsAfterFee);
    const totalFeeR = trades.reduce((a, t) => a + t.fee_r, 0);

    const overall = {
        period: '2021-2024',
        timeframe: 'H1',
        total_trades: trades.length,
        wins,
        losses,
        win_rate: trades.length > 0 ? wins / trades.length : 0,
        avg_mfe_r: avgMfe,
        avg_mae_r: avgMae,
        avg_time_to_mfe: mean(trades.map((t) => t.time_to_mfe)),
        avg_time_to_mae: mean(trades.map((t) => t.time_to_mae)),
        profit_factor_raw: pfRaw,
        profit_factor_after_fee: pfAfterFee,
        total_fee_r: totalFeeR,
        pnl_r_raw: allPnls.reduce((a, b) => a + b, 0),
        pnl_r_after_fee: allPnlsAfterFee.reduce((a, b) => a + b, 0),
        mfe_mae_ratio: avgMae !== 0 ? avgMfe / Math.abs(avgMae) : Infinity,
        max_drawdown_r_raw: maxDrawdownR(allPnls),
        max_drawdown_r_after_fee: maxDrawdownR(allPnlsAfterFee),
        sharpe_ratio_per_trade_raw: stdDev(allPnls) > 0 ? mean(allPnls) / stdDev(allPnls) : 0,
        sharpe_ratio_per_trade_after_fee: stdDev(allPnlsAfterFee) > 0 ? mean(allPnlsAfterFee) / stdDev(allPnlsAfterFee) : 0,
    };
    writeFileSync(resolve(RESULTS_DIR, 'h1-overall-summary.json'), JSON.stringify(overall, null, 2));

    console.log('\n========== TỔNG HỢP TOÀN BỘ H1 (2021-2024) ==========\n');
    console.log(`Tổng số lệnh: ${overall.total_trades}`);
    console.log(`Win rate: ${(overall.win_rate * 100).toFixed(1)}% (${wins}W / ${losses}L)`);
    console.log(`MFE TB: ${avgMfe.toFixed(3)}R, MAE TB: ${avgMae.toFixed(3)}R, MFE/MAE ratio: ${overall.mfe_mae_ratio.toFixed(2)}`);
    console.log(`PnL_R thô: ${overall.pnl_r_raw.toFixed(2)}R, Tổng phí ước tính: ${totalFeeR.toFixed(2)}R, PnL_R sau phí: ${overall.pnl_r_after_fee.toFixed(2)}R`);
    console.log(`Profit Factor thô: ${pfRaw === Infinity ? '∞' : pfRaw.toFixed(3)}`);
    console.log(`Profit Factor sau phí: ${pfAfterFee === Infinity ? '∞' : pfAfterFee.toFixed(3)}`);
    console.log(`Max Drawdown thô/sau phí: ${overall.max_drawdown_r_raw.toFixed(2)}R / ${overall.max_drawdown_r_after_fee.toFixed(2)}R`);
    console.log(`Sharpe (per-trade) thô/sau phí: ${overall.sharpe_ratio_per_trade_raw.toFixed(3)} / ${overall.sharpe_ratio_per_trade_after_fee.toFixed(3)}`);

    const buckets = [
        { label: '< 0.5R', min: -Infinity, max: 0.5 },
        { label: '0.5-1R', min: 0.5, max: 1 },
        { label: '1-2R', min: 1, max: 2 },
        { label: '2-3R', min: 2, max: 3 },
        { label: '> 3R', min: 3, max: Infinity },
    ];
    const mfeDistribution = buckets.map((b) => {
        const inBucket = trades.filter((t) => t.mfe_r >= b.min && t.mfe_r < b.max);
        const winsInBucket = inBucket.filter((t) => t.result === 'WIN').length;
        return {
            range: b.label,
            count: inBucket.length,
            pct: trades.length > 0 ? (inBucket.length / trades.length) * 100 : 0,
            winRate: inBucket.length > 0 ? (winsInBucket / inBucket.length) * 100 : 0,
        };
    });
    writeFileSync(resolve(RESULTS_DIR, 'h1-mfe-distribution.json'), JSON.stringify(mfeDistribution, null, 2));

    console.log('\n========== BẢNG 4: PHÂN BỐ MFE (H1) ==========\n');
    console.log('Khoảng MFE\tSố lệnh\tTỷ lệ\tWin rate trong khoảng');
    for (const b of mfeDistribution) {
        console.log(`${b.range}\t${b.count}\t${b.pct.toFixed(1)}%\t${b.winRate.toFixed(1)}%`);
    }

    let conclusion: string;
    if (pfAfterFee > 1.2) conclusion = 'CÓ EDGE — tiếp tục';
    else if (pfAfterFee >= 1.0) conclusion = 'CẦN ĐIỀU CHỈNH';
    else conclusion = 'KHÔNG CÓ EDGE — dừng track giá thô';
    console.log(`\n========== KẾT LUẬN (theo PF sau phí) ==========\nPF sau phí=${pfAfterFee === Infinity ? '∞' : pfAfterFee.toFixed(3)} => ${conclusion}`);

    console.log('\nĐã lưu data/results/h1-{trades,monthly-summary,overall-summary,mfe-distribution}.json');
}

main();
