/**
 * TICKET-05X-B step 3: three independent checks on the walk-forward labels
 * produced by scripts/hmmWalkForwardBtc.ts. None of these feed back into
 * the fit — a mismatch here is a finding to report, not a reason to retune
 * the labeling convention or fit parameters.
 *
 * Run: tsx scripts/hmmWalkForwardVerify.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Candle, RegimeState } from "../src/core/types.js";
import { compareLabelsToAdxDi, type RegimeLabel } from "../src/regime/adxDiCompare.js";

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
  const labels = loadJson<RegimeLabel[]>(LABELS_PATH);
  const monthlyFits = loadJson<MonthlyFit[]>(FITS_PATH);

  const candleByTime = new Map(candles.map((c) => [c.openTime, c]));
  const alignedCandles = labels.map((l) => candleByTime.get(l.openTime)!);
  if (alignedCandles.some((c) => !c)) throw new Error("label/candle alignment failed");

  console.log("=== Check 1: ADX/DI cross-check on UPTREND/DOWNTREND labels ===");
  const adxResult = compareLabelsToAdxDi(alignedCandles, labels);
  console.log(
    `UPTREND: ${adxResult.uptrend.matches}/${adxResult.uptrend.total} (${adxResult.uptrend.pct.toFixed(1)}%)`,
  );
  console.log(
    `DOWNTREND: ${adxResult.downtrend.matches}/${adxResult.downtrend.total} (${adxResult.downtrend.pct.toFixed(1)}%)`,
  );
  console.log(
    `Overall: ${adxResult.overall.matches}/${adxResult.overall.total} (${adxResult.overall.pct.toFixed(1)}%)`,
  );

  console.log("\n=== Check 2: DANGER_ZONE lowest self-transition across monthly refits ===");
  const dzPassCount = monthlyFits.filter((f) => f.dangerZoneHasLowestSelfLoop).length;
  console.log(`${dzPassCount}/${monthlyFits.length} monthly fits have DANGER_ZONE as the lowest self-loop state`);
  for (const f of monthlyFits) {
    if (!f.dangerZoneHasLowestSelfLoop) {
      console.log(`  MISMATCH: ${f.trainStart} .. ${f.trainEnd}`);
    }
  }

  console.log("\n=== Check 3: 10 longest DANGER_ZONE periods (for manual review) ===");
  const longestDangerZone = longestRuns(labels, "DANGER_ZONE", 10);
  for (const r of longestDangerZone) {
    console.log(`  ${r.start} -> ${r.end}  (${r.bars} bars, ~${r.durationHours.toFixed(1)}h)`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    adxDiComparison: adxResult,
    dangerZoneSelfLoopCheck: {
      totalMonthlyFits: monthlyFits.length,
      passCount: dzPassCount,
      pct: (dzPassCount / monthlyFits.length) * 100,
    },
    longestDangerZonePeriods: longestDangerZone,
  };
  writeFileSync(REPORT_OUT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nSaved report to ${REPORT_OUT_PATH}`);
}

main();
