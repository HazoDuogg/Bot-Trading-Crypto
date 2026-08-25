import path from 'node:path';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../src/entry/fvgStrategyConfig.js';
import {
  SYMBOLS,
  loadAllSymbolData,
  runSimulation,
  computeClosedPnl,
  type ClosedTrade,
} from './simulateOneYearNearLive.js';

// TICKET-RT-056: measures the effect of raising standard risk from 1.0% to 1.5% of balance/trade for
// BTC/ETH/SOL/XRP (every trade, regardless of breaksKeyZone) — HYPEUSDT keeps the just-settled
// 1.0%/1.5% (breaksKeyZone false/true) split unchanged. This is a REAL re-simulation via
// runSimulation()'s new riskPctResolver parameter (RT-056 addition to simulateOneYearNearLive.ts,
// additive/optional, default preserves every prior ticket's exact numbers — verified by a regression
// re-run before this script was written) — NOT a post-hoc PnL multiply like RT-050/052, because
// changing risk% changes qty/notional/margin, which can change Portfolio Exposure Tracker admission
// decisions (rejections/scale-downs), which changes which candles are free for fresh detection. Only
// a real re-run captures that correctly.
//
// closedTrades[] from runSimulation() is already in true global chronological CLOSE order (the
// simulation advances a single shared M15 index across all 5 coins, pushing to closedTrades exactly
// when each position's SL/TP touches during that candle's processing) — no separate sort needed for
// the equity curve/drawdown/streak calculations below.
//
// Equity curve starting capital (10,000 USDT, per the ticket's own example) is a DISPLAY baseline
// only, for expressing drawdown as a %. It does NOT feed into position sizing — every dollar PnL
// figure here still comes from the existing $500-notional risk-sizing pipeline (BALANCE constant in
// simulateOneYearNearLive.ts), same convention as every RT-032..055 script. Flagged explicitly here
// since the two numbers ($500 sizing basis vs $10,000 equity-curve basis) are intentionally
// different, per the ticket's own instruction.

const START_CAPITAL = 10000;

function riskPctFor4Coins(testRiskPct: number) {
  return (symbol: string, breaksKeyZone: boolean): number => {
    if (symbol === 'HYPEUSDT') return breaksKeyZone ? 0.015 : 0.01; // "logic vua chot", unchanged
    return testRiskPct;
  };
}

interface Summary {
  n: number;
  pnl: number;
  winRate: number;
  profitFactor: number;
}

function summarize(trades: ClosedTrade[]): Summary {
  let pnl = 0;
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const t of trades) {
    const p = computeClosedPnl(t);
    pnl += p;
    if (p > 0) {
      wins++;
      grossProfit += p;
    } else if (p < 0) {
      grossLoss += Math.abs(p);
    }
  }
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  return { n: trades.length, pnl, winRate, profitFactor };
}

interface DrawdownResult {
  maxDrawdownDollar: number;
  maxDrawdownPctOfStart: number;
  peakEquityBeforeTrough: number;
  troughEquity: number;
  troughCloseTime: number | null;
}

// Standard peak-to-trough max drawdown: walk the equity curve in true chronological order, track the
// running peak, and the largest (peak - current) gap seen. maxDrawdownPctOfStart is expressed as %
// of the STARTING capital (per the ticket's explicit wording "% von ban dau"), not % of the peak at
// the time (the more common finance convention) — both are valid; the ticket asked for the former.
function computeDrawdown(trades: ClosedTrade[], startCapital: number): DrawdownResult {
  let equity = startCapital;
  let peak = startCapital;
  let maxDrawdownDollar = 0;
  let peakAtMaxDrawdown = startCapital;
  let troughAtMaxDrawdown = startCapital;
  let troughCloseTime: number | null = null;

  for (const t of trades) {
    equity += computeClosedPnl(t);
    if (equity > peak) peak = equity;
    const drawdown = peak - equity;
    if (drawdown > maxDrawdownDollar) {
      maxDrawdownDollar = drawdown;
      peakAtMaxDrawdown = peak;
      troughAtMaxDrawdown = equity;
      troughCloseTime = t.closeTime;
    }
  }

  return {
    maxDrawdownDollar,
    maxDrawdownPctOfStart: (maxDrawdownDollar / startCapital) * 100,
    peakEquityBeforeTrough: peakAtMaxDrawdown,
    troughEquity: troughAtMaxDrawdown,
    troughCloseTime,
  };
}

interface StreakResult {
  longestLosingStreakLen: number;
  lossSumInThatStreak: number;
  lossPctOfStartInThatStreak: number;
}

// Longest run of consecutive LOSING trades (PnL < 0), in true chronological close order. When the
// max-length streak is (re)found, its own loss sum is captured — "tong % von mat trong chuoi do"
// refers to that specific streak, not the single worst-loss streak if it happens to differ in length.
function computeLongestLosingStreak(trades: ClosedTrade[], startCapital: number): StreakResult {
  let curLen = 0;
  let curLossSum = 0;
  let bestLen = 0;
  let bestLossSum = 0;

  for (const t of trades) {
    const p = computeClosedPnl(t);
    if (p < 0) {
      curLen++;
      curLossSum += p;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestLossSum = curLossSum;
      }
    } else {
      curLen = 0;
      curLossSum = 0;
    }
  }

  return {
    longestLosingStreakLen: bestLen,
    lossSumInThatStreak: bestLossSum,
    lossPctOfStartInThatStreak: (Math.abs(bestLossSum) / startCapital) * 100,
  };
}

function printSummaryRow(label: string, s: Summary): void {
  console.log(
    label.padEnd(20) +
      String(s.n).padEnd(6) +
      `$${s.pnl.toFixed(2)}`.padEnd(14) +
      `${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(3) : 'inf'}`.padEnd(9) +
      `${s.winRate.toFixed(1)}%`,
  );
}

function printDrawdownRow(label: string, d: DrawdownResult): void {
  const when = d.troughCloseTime !== null ? new Date(d.troughCloseTime).toISOString() : 'n/a';
  console.log(
    `  ${label}: -$${d.maxDrawdownDollar.toFixed(2)} (${d.maxDrawdownPctOfStart.toFixed(2)}% von ban dau $${START_CAPITAL})` +
      `  dinh=$${d.peakEquityBeforeTrough.toFixed(2)} -> day=$${d.troughEquity.toFixed(2)}  luc=${when}`,
  );
}

function printStreakRow(label: string, s: StreakResult): void {
  console.log(
    `  ${label}: ${s.longestLosingStreakLen} lenh thua lien tiep, tong lo $${Math.abs(s.lossSumInThatStreak).toFixed(2)}` +
      ` (${s.lossPctOfStartInThatStreak.toFixed(2)}% von ban dau $${START_CAPITAL})`,
  );
}

async function main() {
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');
  const targetR = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple; // 2.1, production as of RT-045

  console.log('Dang load du lieu 1 nam (da fix RT-054)...');
  const allData = await loadAllSymbolData(dataDir);

  console.log('\n=== Chay CONFIG A: 4 coin risk chuan = 1.0% (baseline hien tai), HYPE giu logic 1.0%/1.5% ===');
  const { closedTrades: tradesA } = runSimulation(allData, targetR, riskPctFor4Coins(0.01));
  const filledA = tradesA.filter((t) => t.outcome !== 'STILL_OPEN');

  console.log('=== Chay CONFIG B: 4 coin risk chuan = 1.5% (TANG), HYPE giu logic 1.0%/1.5% (khong doi) ===');
  const { closedTrades: tradesB } = runSimulation(allData, targetR, riskPctFor4Coins(0.015));
  const filledB = tradesB.filter((t) => t.outcome !== 'STILL_OPEN');

  console.log(`\n=== Bang tong: PnL$/PF/winRate ===`);
  console.log('config'.padEnd(20) + 'n'.padEnd(6) + 'PnL$'.padEnd(14) + 'PF'.padEnd(9) + 'winRate');
  const sA = summarize(filledA);
  const sB = summarize(filledB);
  printSummaryRow('A: 1.0% (baseline)', sA);
  printSummaryRow('B: 1.5% (4 coin)', sB);
  console.log(`  dPnL$ B vs A: ${sB.pnl - sA.pnl >= 0 ? '+' : ''}$${(sB.pnl - sA.pnl).toFixed(2)}`);

  console.log(`\n=== Equity curve (bat dau $${START_CAPITAL}, dung TOAN DANH MUC, dung thu tu chronological that) ===`);
  const ddA = computeDrawdown(filledA, START_CAPITAL);
  const ddB = computeDrawdown(filledB, START_CAPITAL);
  console.log('MAX DRAWDOWN:');
  printDrawdownRow('Config A (1.0%)', ddA);
  printDrawdownRow('Config B (1.5%)', ddB);

  const streakA = computeLongestLosingStreak(filledA, START_CAPITAL);
  const streakB = computeLongestLosingStreak(filledB, START_CAPITAL);
  console.log('\nCHUOI THUA LIEN TIEP DAI NHAT:');
  printStreakRow('Config A (1.0%)', streakA);
  printStreakRow('Config B (1.5%)', streakB);

  console.log(
    `\n  So sanh truc tiep: drawdown tang tu ${ddA.maxDrawdownPctOfStart.toFixed(2)}% -> ${ddB.maxDrawdownPctOfStart.toFixed(2)}% von ban dau` +
      ` (x${(ddB.maxDrawdownPctOfStart / ddA.maxDrawdownPctOfStart).toFixed(2)}); chuoi thua dai nhat ${streakA.longestLosingStreakLen} -> ${streakB.longestLosingStreakLen} lenh,` +
      ` tong % von mat trong chuoi ${streakA.lossPctOfStartInThatStreak.toFixed(2)}% -> ${streakB.lossPctOfStartInThatStreak.toFixed(2)}%.` +
      ' Khong tu danh gia "chap nhan duoc" hay khong — so lieu de Vinh Tam tu quyet theo khau vi rui ro.',
  );

  console.log('\n=== Breakdown 5 coin rieng (isolate tung coin, bat dau tu $0, xem dong gop rui ro rieng) ===');
  console.log(
    'coin'.padEnd(12) +
      'n(A)'.padEnd(6) +
      'PnL$(A)'.padEnd(12) +
      'maxDD$(A)'.padEnd(12) +
      'streak(A)'.padEnd(11) +
      'n(B)'.padEnd(6) +
      'PnL$(B)'.padEnd(12) +
      'maxDD$(B)'.padEnd(12) +
      'streak(B)',
  );
  for (const symbol of SYMBOLS) {
    const coinA = filledA.filter((t) => t.symbol === symbol);
    const coinB = filledB.filter((t) => t.symbol === symbol);
    const sCoinA = summarize(coinA);
    const sCoinB = summarize(coinB);
    const ddCoinA = computeDrawdown(coinA, 0); // isolate: own equity from $0, own PnL only
    const ddCoinB = computeDrawdown(coinB, 0);
    const streakCoinA = computeLongestLosingStreak(coinA, 1); // startCapital=1 avoids div-by-zero; % not used here
    const streakCoinB = computeLongestLosingStreak(coinB, 1);
    console.log(
      symbol.padEnd(12) +
        String(sCoinA.n).padEnd(6) +
        `$${sCoinA.pnl.toFixed(2)}`.padEnd(12) +
        `-$${ddCoinA.maxDrawdownDollar.toFixed(2)}`.padEnd(12) +
        `${streakCoinA.longestLosingStreakLen}`.padEnd(11) +
        String(sCoinB.n).padEnd(6) +
        `$${sCoinB.pnl.toFixed(2)}`.padEnd(12) +
        `-$${ddCoinB.maxDrawdownDollar.toFixed(2)}`.padEnd(12) +
        `${streakCoinB.longestLosingStreakLen}`,
    );
  }
  console.log(
    '\n  LUU Y: maxDD$ o bang nay la drawdown RIENG cua tung coin neu tach ra tinh doc lap tu $0 (khong phai % von' +
      ' toan danh muc — khong cong don duoc voi nhau vi khong xay ra cung luc). Dung de so sanh coin nao gay bien' +
      ' dong lon hon tuong doi, khong phai de suy ra drawdown toan danh muc (da tinh o bang tren, dua tren dung' +
      ' thu tu chronological xen ke ca 5 coin).',
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
