/**
 * TICKET-05X-B/B2/B3/B4 diagnostic — kept for reference, not part of the
 * production pipeline. Verdict:
 *   UPTREND/DOWNTREND -> fixed ADX>=25 + DI direction (HMM failed: max 57.4%
 *     DI-pure even at 90-100% confidence, needs >=65%)
 *   SIDEWAY           -> HMM (passed: 68.9% ADX<25 agreement, needs >=65%)
 *   DANGER_ZONE       -> fixed true range > 3xATR14 (HMM failed: 0.75%
 *     precision, 28.8% recall, needs >=50%/50%)
 * Re-run only if re-evaluating whether HMM should replace a fixed rule.
 *
 * Run: tsx scripts/research/hmmWalkForwardVerify.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Candle, RegimeState } from "../../src/core/types.js";
import { compareLabelsToAdxDi, computeAdxDi, calculateTR, type RegimeLabel } from "../../src/regime/adxDiCompare.js";

const DATA_PATH = resolve("data/ohlcv-BTCUSDT-15m.json");
const LABELS_PATH = resolve("data/ticket05x-hmm-regime-labels.json");
const FITS_PATH = resolve("data/ticket05x-hmm-monthly-fits.json");
const REPORT_OUT_PATH = resolve("data/ticket05x-hmm-verification-report.json");

interface MonthlyFit {
  trainStart: string;
  trainEnd: string;
  states: Record<RegimeState, { mean: number; std: number; selfLoop: number }>;
  dangerZoneHasLowestSelfLoop: boolean;
}

interface LabelWithConfidence extends RegimeLabel {
  closeTime: number;
  confidence: number;
}

// Locked confidence buckets (%), not to be re-chosen after seeing results.
const CONFIDENCE_BUCKETS: [number, number][] = [
  [50, 60],
  [60, 70],
  [70, 80],
  [80, 90],
  [90, 100],
];
const GATE_DI_PURE_THRESHOLD = 65;
const GATE_MIN_SHARE_PCT = 10;
const ATR_ANOMALY_MULTIPLE = 3; // "true anomaly" bar: true range > 3xATR14
const DZ_PRECISION_RECALL_THRESHOLD = 50;
const SIDEWAY_ADX_THRESHOLD = 65;

/** True range per bar, padded like computeAdxDi's own arrays (1 leading zero). */
function computeTrueRangeSeries(candles: Candle[]): number[] {
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    tr.push(calculateTR(candles[i].high, candles[i].low, candles[i - 1].close));
  }
  return [0, ...tr];
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

/** Longest contiguous runs of a given state in a chronologically-sorted label series. */
function longestRuns(labels: RegimeLabel[], state: RegimeState, top: number) {
  const runs: { start: number; end: number; bars: number }[] = [];
  let runStart: number | null = null;
  let prevTime = -Infinity;
  const BAR_MS = 15 * 60 * 1000;

  for (let i = 0; i < labels.length; i++) {
    const isState = labels[i].state === state;
    const contiguous = labels[i].openTime === prevTime + BAR_MS;
    if (isState && runStart !== null && contiguous) {
      // extend
    } else if (isState) {
      if (runStart !== null) runs.push({ start: runStart, end: prevTime, bars: (prevTime - runStart) / BAR_MS + 1 });
      runStart = labels[i].openTime;
    } else if (runStart !== null) {
      runs.push({ start: runStart, end: prevTime, bars: (prevTime - runStart) / BAR_MS + 1 });
      runStart = null;
    }
    prevTime = labels[i].openTime;
  }
  if (runStart !== null) runs.push({ start: runStart, end: prevTime, bars: (prevTime - runStart) / BAR_MS + 1 });

  return runs
    .sort((a, b) => b.bars - a.bars)
    .slice(0, top)
    .map((r) => ({
      start: new Date(r.start).toISOString(),
      end: new Date(r.end).toISOString(),
      bars: r.bars,
      durationHours: (r.bars * 15) / 60,
    }));
}

function main() {
  const candles = loadJson<Candle[]>(DATA_PATH);
  const labels = loadJson<LabelWithConfidence[]>(LABELS_PATH);
  const monthlyFits = loadJson<MonthlyFit[]>(FITS_PATH);

  const candleByTime = new Map(candles.map((c) => [c.openTime, c]));
  const alignedCandles = labels.map((l) => candleByTime.get(l.openTime)!);
  if (alignedCandles.some((c) => !c)) throw new Error("label/candle alignment failed");

  console.log("=== Check 1: ADX/DI breakdown on UPTREND/DOWNTREND labels ===");
  const adxResult = compareLabelsToAdxDi(alignedCandles, labels);
  const DI_PURE_DECISION_THRESHOLD = 65;
  for (const [name, b] of [["UPTREND", adxResult.uptrend], ["DOWNTREND", adxResult.downtrend]] as const) {
    console.log(`${name} (n=${b.total}):`);
    console.log(`  ADX>=25 (regardless of DI direction): ${b.adxOver25.count}/${b.total} (${b.adxOver25.pct.toFixed(1)}%)`);
    console.log(`  DI direction correct, given ADX>=25:  ${b.diCorrectGivenAdxOver25.count}/${b.adxOver25.count} (${b.diCorrectGivenAdxOver25.pct.toFixed(1)}%)`);
    console.log(`  Both (original metric):               ${b.bothMatch.count}/${b.total} (${b.bothMatch.pct.toFixed(1)}%)`);
    console.log(`  DI direction correct, ADX ignored (DECISION METRIC): ${b.diCorrectPure.count}/${b.total} (${b.diCorrectPure.pct.toFixed(1)}%)`);
  }
  console.log(`Overall DI-pure (decision metric, both directions): ${adxResult.overall.diCorrectPure.count}/${adxResult.overall.total} (${adxResult.overall.diCorrectPure.pct.toFixed(1)}%)`);
  const diPureVerdict = adxResult.overall.diCorrectPure.pct >= DI_PURE_DECISION_THRESHOLD;
  console.log(
    diPureVerdict
      ? `  => >= ${DI_PURE_DECISION_THRESHOLD}%: low 23.7% attributed to the ADX>=25 filter, not wrong HMM direction. Continue developing HMM for the trend axis.`
      : `  => < ${DI_PURE_DECISION_THRESHOLD}%: HMM does not track real price direction reliably. Fall back to fixed ADX+DI for the UPTREND/DOWNTREND axis; keep HMM code as reference only.`,
  );

  console.log("\n=== Confidence-stratified ADX/DI (TICKET-05X-B3) ===");
  console.log("bucket\tUPTREND n\tUPTREND DI-pure%\tDOWNTREND n\tDOWNTREND DI-pure%\tcombined n\tcombined DI-pure%");
  const bucketResults = CONFIDENCE_BUCKETS.map(([lo, hi]) => {
    const inBucket = labels.filter((l) => {
      const c = l.confidence * 100;
      return hi === 100 ? c >= lo && c <= hi : c >= lo && c < hi;
    });
    const bucketCandles = inBucket.map((l) => candleByTime.get(l.openTime)!);
    const r = compareLabelsToAdxDi(bucketCandles, inBucket);
    console.log(
      `[${lo},${hi}${hi === 100 ? "]" : ")"}\t${r.uptrend.total}\t${r.uptrend.diCorrectPure.pct.toFixed(1)}%\t${r.downtrend.total}\t${r.downtrend.diCorrectPure.pct.toFixed(1)}%\t${r.overall.total}\t${r.overall.diCorrectPure.pct.toFixed(1)}%`,
    );
    return { lo, hi, result: r };
  });

  const highBuckets = bucketResults.slice(3); // [80,90) and [90,100]
  const bothHighBucketsPass = highBuckets.every((b) => b.result.overall.diCorrectPure.pct >= GATE_DI_PURE_THRESHOLD);
  const highBucketsN = highBuckets.reduce((sum, b) => sum + b.result.overall.total, 0);
  const highBucketsSharePct = (highBucketsN / adxResult.overall.total) * 100;
  const shareOk = highBucketsSharePct >= GATE_MIN_SHARE_PCT;
  const confidenceGateVerdict = bothHighBucketsPass && shareOk ? "HMM_CONFIDENCE_GATED_VIABLE" : "CONFIRMED_FALLBACK_ADX_DI";
  console.log(
    `\n[80,90)+[90,100] DI-pure>=${GATE_DI_PURE_THRESHOLD}%: ${bothHighBucketsPass}; combined n=${highBucketsN} (${highBucketsSharePct.toFixed(1)}% of all UP/DOWN labels, need >=${GATE_MIN_SHARE_PCT}%): ${shareOk}`,
  );
  console.log(`=> ${confidenceGateVerdict}`);

  console.log("\n=== Check 2: DANGER_ZONE lowest self-transition across monthly refits ===");
  const dzPassCount = monthlyFits.filter((f) => f.dangerZoneHasLowestSelfLoop).length;
  console.log(`${dzPassCount}/${monthlyFits.length} monthly fits have DANGER_ZONE as the lowest self-loop state`);
  console.log("\nSelf-loop of all 4 states per month (lowest marked *):");
  console.log("trainStart\tUPTREND\tDOWNTREND\tSIDEWAY\tDANGER_ZONE\tlowest state");
  const lowestStateCounts: Record<RegimeState, number> = { UPTREND: 0, DOWNTREND: 0, SIDEWAY: 0, DANGER_ZONE: 0 };
  for (const f of monthlyFits) {
    const names: RegimeState[] = ["UPTREND", "DOWNTREND", "SIDEWAY", "DANGER_ZONE"];
    const selfLoops = names.map((n) => f.states[n].selfLoop);
    const minIdx = selfLoops.indexOf(Math.min(...selfLoops));
    const lowestState = names[minIdx];
    lowestStateCounts[lowestState]++;
    console.log(
      `${f.trainStart.slice(0, 7)}\t${selfLoops.map((v, i) => `${v.toFixed(3)}${i === minIdx ? "*" : ""}`).join("\t")}\t${lowestState}`,
    );
  }
  console.log("\nWhich state most often has the lowest self-loop (across 31 months):");
  for (const [name, count] of Object.entries(lowestStateCounts)) {
    console.log(`  ${name}: ${count}/${monthlyFits.length} (${((count / monthlyFits.length) * 100).toFixed(1)}%)`);
  }

  console.log("\n=== Check 3: 10 longest DANGER_ZONE periods (for manual review) ===");
  const longestDangerZone = longestRuns(labels, "DANGER_ZONE", 10);
  for (const r of longestDangerZone) {
    console.log(`  ${r.start} -> ${r.end}  (${r.bars} bars, ~${r.durationHours.toFixed(1)}h)`);
  }

  console.log("\n=== TICKET-05X-B4 Part 1: DANGER_ZONE precision/recall vs true-range anomaly ===");
  const { atr } = computeAdxDi(alignedCandles);
  const trueRange = computeTrueRangeSeries(alignedCandles);
  let dzTotal = 0, dzTruePositive = 0, anomalyTotal = 0, anomalyRecalled = 0;
  for (let i = 0; i < labels.length; i++) {
    const isAnomaly = trueRange[i] > ATR_ANOMALY_MULTIPLE * atr[i];
    const isDangerZone = labels[i].state === "DANGER_ZONE";
    if (isDangerZone) { dzTotal++; if (isAnomaly) dzTruePositive++; }
    if (isAnomaly) { anomalyTotal++; if (isDangerZone) anomalyRecalled++; }
  }
  const dzPrecisionPct = dzTotal > 0 ? (dzTruePositive / dzTotal) * 100 : 0;
  const dzRecallPct = anomalyTotal > 0 ? (anomalyRecalled / anomalyTotal) * 100 : 0;
  console.log(`Precision: ${dzTruePositive}/${dzTotal} DANGER_ZONE bars are true-range > ${ATR_ANOMALY_MULTIPLE}xATR14 (${dzPrecisionPct.toFixed(1)}%)`);
  console.log(`Recall: ${anomalyRecalled}/${anomalyTotal} true anomaly bars were labeled DANGER_ZONE (${dzRecallPct.toFixed(1)}%)`);
  const dzViable = dzPrecisionPct >= DZ_PRECISION_RECALL_THRESHOLD && dzRecallPct >= DZ_PRECISION_RECALL_THRESHOLD;
  console.log(
    dzViable
      ? `  => both >= ${DZ_PRECISION_RECALL_THRESHOLD}%: keep HMM for DANGER_ZONE.`
      : `  => not both >= ${DZ_PRECISION_RECALL_THRESHOLD}%: fall back to the fixed rule (true range > ${ATR_ANOMALY_MULTIPLE}xATR14) for DANGER_ZONE.`,
  );

  console.log("\n=== TICKET-05X-B4 Part 2: SIDEWAY vs ADX<25 ===");
  const { adx } = computeAdxDi(alignedCandles);
  let sidewayTotal = 0, sidewayAdxUnder25 = 0;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i].state === "SIDEWAY") { sidewayTotal++; if (adx[i] < 25) sidewayAdxUnder25++; }
  }
  const sidewayAdxUnder25Pct = sidewayTotal > 0 ? (sidewayAdxUnder25 / sidewayTotal) * 100 : 0;
  console.log(`${sidewayAdxUnder25}/${sidewayTotal} SIDEWAY-labeled bars have ADX<25 (${sidewayAdxUnder25Pct.toFixed(1)}%)`);
  const sidewayViable = sidewayAdxUnder25Pct >= SIDEWAY_ADX_THRESHOLD;
  console.log(
    sidewayViable
      ? `  => >= ${SIDEWAY_ADX_THRESHOLD}%: keep HMM for SIDEWAY.`
      : `  => < ${SIDEWAY_ADX_THRESHOLD}%: fall back to SIDEWAY = complement of the fixed ADX+DI rule (ADX<25 / not UPTREND or DOWNTREND).`,
  );

  const report = {
    generatedAt: new Date().toISOString(),
    adxDiComparison: adxResult,
    trendAxisDecision: {
      diPureDecisionThresholdPct: DI_PURE_DECISION_THRESHOLD,
      overallDiPurePct: adxResult.overall.diCorrectPure.pct,
      verdict: diPureVerdict ? "KEEP_HMM_FOR_TREND_AXIS" : "FALL_BACK_TO_FIXED_ADX_DI",
    },
    confidenceStratified: {
      buckets: bucketResults.map((b) => ({ range: [b.lo, b.hi], result: b.result })),
      gate: {
        diPureThresholdPct: GATE_DI_PURE_THRESHOLD,
        minSharePct: GATE_MIN_SHARE_PCT,
        highBucketsBothPass: bothHighBucketsPass,
        highBucketsN,
        highBucketsSharePct,
        verdict: confidenceGateVerdict,
      },
    },
    dangerZoneSelfLoopCheck: {
      totalMonthlyFits: monthlyFits.length,
      passCount: dzPassCount,
      pct: (dzPassCount / monthlyFits.length) * 100,
      lowestStateCounts,
    },
    longestDangerZonePeriods: longestDangerZone,
    dangerZonePrecisionRecall: {
      atrAnomalyMultiple: ATR_ANOMALY_MULTIPLE,
      thresholdPct: DZ_PRECISION_RECALL_THRESHOLD,
      precisionPct: dzPrecisionPct,
      recallPct: dzRecallPct,
      dzTotal,
      dzTruePositive,
      anomalyTotal,
      anomalyRecalled,
      verdict: dzViable ? "KEEP_HMM_FOR_DANGER_ZONE" : "FALLBACK_FIXED_ATR_RULE",
    },
    sidewayAdxCheck: {
      thresholdPct: SIDEWAY_ADX_THRESHOLD,
      pct: sidewayAdxUnder25Pct,
      sidewayTotal,
      sidewayAdxUnder25,
      verdict: sidewayViable ? "KEEP_HMM_FOR_SIDEWAY" : "FALLBACK_ADX_DI_COMPLEMENT",
    },
  };
  writeFileSync(REPORT_OUT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nSaved report to ${REPORT_OUT_PATH}`);
}

main();
