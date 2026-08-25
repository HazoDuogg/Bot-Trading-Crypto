// TICKET-RT-049: statistical-reliability check on RT-048's per-coin breaksKeyZone/winRate numbers —
// pure statistics on already-computed counts, NO new backtest run (per the ticket's explicit scope).
// TP/SL counts below are copied verbatim from RT-048's console output
// (apps/bot/scripts/measureKeyZoneCorrelation210.ts, targetRMultiple=2.10, floor=0.5%, n=358 total).
//
// Method: Wilson score interval at 90% confidence (z=1.645) — chosen over the normal approximation
// specifically because several per-coin cells here are tiny (BTC true n=2), where the normal
// approximation is known to misbehave (can produce CIs outside [0,1], and undercoverage at small n).
// 90% (not 95%) is a deliberate trade-off the ticket calls for: narrower intervals that are more
// usable at this sample size, at the cost of a higher false-positive rate on "significant" findings
// than the 95% convention — NOT a gold standard, stated explicitly per the ticket's instruction.

interface CoinCounts {
  symbol: string;
  trueTp: number;
  trueSl: number;
  falseTp: number;
  falseSl: number;
}

// Verbatim from RT-048's printed breakdown tables.
const COUNTS: CoinCounts[] = [
  { symbol: 'BTCUSDT', trueTp: 2, trueSl: 0, falseTp: 14, falseSl: 10 },
  { symbol: 'ETHUSDT', trueTp: 5, trueSl: 5, falseTp: 23, falseSl: 22 },
  { symbol: 'SOLUSDT', trueTp: 5, trueSl: 2, falseTp: 36, falseSl: 29 },
  { symbol: 'HYPEUSDT', trueTp: 13, trueSl: 11, falseTp: 60, falseSl: 64 },
  { symbol: 'XRPUSDT', trueTp: 4, trueSl: 4, falseTp: 27, falseSl: 22 },
];

const Z_90 = 1.6448536269514722; // two-tailed z for 90% confidence

interface WilsonResult {
  n: number;
  p: number;
  lower: number;
  upper: number;
}

function wilsonInterval(successes: number, n: number, z: number): WilsonResult {
  if (n === 0) return { n: 0, p: NaN, lower: NaN, upper: NaN };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { n, p, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function overlaps(a: WilsonResult, b: WilsonResult): boolean {
  return a.lower <= b.upper && b.lower <= a.upper;
}

function fmtPct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a';
}

function main() {
  console.log(`=== TICKET-RT-049: Wilson score interval (90% CI, z=${Z_90.toFixed(4)}) cho winRate theo coin ===`);
  console.log('Chi dung lai counts tu RT-048 (targetR=2.10R), KHONG chay backtest moi.\n');
  console.log(
    'coin'.padEnd(12) +
      'true n'.padEnd(8) +
      'true winRate [90% CI]'.padEnd(28) +
      'false n'.padEnd(9) +
      'false winRate [90% CI]'.padEnd(28) +
      'chong lan?'.padEnd(12) +
      'ket luan',
  );

  const rows: { symbol: string; trueCI: WilsonResult; falseCI: WilsonResult; overlap: boolean }[] = [];

  for (const c of COUNTS) {
    const trueN = c.trueTp + c.trueSl;
    const falseN = c.falseTp + c.falseSl;
    const trueCI = wilsonInterval(c.trueTp, trueN, Z_90);
    const falseCI = wilsonInterval(c.falseTp, falseN, Z_90);
    const ov = overlaps(trueCI, falseCI);
    rows.push({ symbol: c.symbol, trueCI, falseCI, overlap: ov });

    const trueStr = `${fmtPct(trueCI.p)} [${fmtPct(trueCI.lower)}-${fmtPct(trueCI.upper)}]`;
    const falseStr = `${fmtPct(falseCI.p)} [${fmtPct(falseCI.lower)}-${fmtPct(falseCI.upper)}]`;
    const conclusion = ov ? 'CHUA du tin cay (mau nho, khong phai tin hieu yeu)' : 'DU bang chung phan biet';

    console.log(
      c.symbol.padEnd(12) +
        String(trueN).padEnd(8) +
        trueStr.padEnd(28) +
        String(falseN).padEnd(9) +
        falseStr.padEnd(28) +
        (ov ? 'CO' : 'KHONG').padEnd(12) +
        conclusion,
    );
  }

  const confident = rows.filter((r) => !r.overlap);
  const uncertain = rows.filter((r) => r.overlap);

  console.log('\n=== Tong ket ===');
  console.log(
    `  DU bang chung (khoang tin cay KHONG chong lan, tin hieu breaksKeyZone co y nghia thong ke o muc 90%): ${
      confident.length > 0 ? confident.map((r) => r.symbol).join(', ') : '(khong coin nao)'
    }`,
  );
  console.log(
    `  CHUA DU bang chung (khoang tin cay chong lan — co the la nhieu do mau nho, KHONG phai bang chung tin hieu yeu hay sai huong):` +
      ` ${uncertain.length > 0 ? uncertain.map((r) => r.symbol).join(', ') : '(khong coin nao)'}`,
  );
  console.log(
    '\n  LUU Y: "chua du bang chung" != "tin hieu sai" hay "tin hieu yeu" — no chi co nghia mau qua nho de phan biet' +
      ' 2 ty le voi do tin cay 90%. Coin co ket qua "dao nguoc" (vd ETH/XRP PF thap hon o nhom true) van nam trong' +
      ' khoang chong lan roi, khong phai bang chung nguoc xu huong that.',
  );
}

main();
