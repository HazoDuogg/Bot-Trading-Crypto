/**
 * TICKET-05X-A step 1: verifies the Baum-Welch EM implementation in
 * hmmRegime.ts against synthetic data generated from known parameters.
 * Not a unit test — a standalone script with fixed pass/fail criteria.
 * Run: tsx tests/regime/hmmSyntheticVerify.ts
 */
import {
  fitGaussianHmmMultiStart,
  viterbi,
  makeRng,
  randomGaussian,
  type GaussianHmmParams,
} from "../../src/regime/hmmRegime.js";

const STATE_NAMES = ["UPTREND", "DOWNTREND", "SIDEWAY", "DANGER_ZONE"] as const;

const TRUE_PARAMS: Record<(typeof STATE_NAMES)[number], { mean: number; std: number; selfLoop: number }> = {
  UPTREND: { mean: 0.001, std: 0.008, selfLoop: 0.98 },
  DOWNTREND: { mean: -0.001, std: 0.008, selfLoop: 0.98 },
  SIDEWAY: { mean: 0.0, std: 0.003, selfLoop: 0.98 },
  DANGER_ZONE: { mean: 0.0, std: 0.02, selfLoop: 0.85 },
};

const N = 20000;
const DATA_SEEDS = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
const EM_SEED = 42;
const NUM_RESTARTS = 10;
const MIN_STATE_MATCH_RATE = 0.7;
const MIN_PRIMARY_PASS_SEEDS = 18; // 18/20 = 90%

function buildTrueTransitionMatrix(): number[][] {
  const K = STATE_NAMES.length;
  const matrix: number[][] = [];
  for (let i = 0; i < K; i++) {
    const selfLoop = TRUE_PARAMS[STATE_NAMES[i]].selfLoop;
    const off = (1 - selfLoop) / (K - 1);
    const row = new Array(K).fill(off);
    row[i] = selfLoop;
    matrix.push(row);
  }
  return matrix;
}

function simulate(n: number, seed: number): { observations: number[]; trueStates: number[] } {
  const rng = makeRng(seed);
  const transition = buildTrueTransitionMatrix();
  const K = STATE_NAMES.length;

  const trueStates: number[] = new Array(n);
  const observations: number[] = new Array(n);

  let state = Math.floor(rng() * K);
  for (let t = 0; t < n; t++) {
    if (t > 0) {
      const row = transition[state];
      const r = rng();
      let cum = 0;
      let next = K - 1;
      for (let j = 0; j < K; j++) {
        cum += row[j];
        if (r < cum) {
          next = j;
          break;
        }
      }
      state = next;
    }
    trueStates[t] = state;
    const { mean, std } = TRUE_PARAMS[STATE_NAMES[state]];
    observations[t] = mean + std * randomGaussian(rng);
  }

  return { observations, trueStates };
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const result: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) result.push([items[i], ...p]);
  }
  return result;
}

/**
 * Matches learned states to true states by nearest parameter distance
 * (mean and std, z-scored against the true state's own scale) instead of
 * a plain "sort by mean then variance". A 1D sort by mean is unreliable
 * here: DANGER_ZONE's true mean is 0 but its std (0.02) is so large, and
 * its occupancy so small (short expected runs from its 0.85 self-loop),
 * that its estimated mean's sampling noise routinely exceeds DOWNTREND's
 * entire true mean (0.001) — a sort-by-mean rule then swaps their labels
 * even when EM has recovered both clusters correctly. Brute-forcing all
 * 4! permutations and picking the minimum-total-distance assignment is
 * the direct way to answer "which learned cluster is which regime" and
 * isn't fooled by that overlap.
 */
function matchLearnedStatesToNames(params: GaussianHmmParams): (typeof STATE_NAMES)[number][] {
  const K = params.numStates;
  let best: (typeof STATE_NAMES)[number][] | null = null;
  let bestCost = Infinity;
  for (const perm of permutations(STATE_NAMES as unknown as (typeof STATE_NAMES)[number][])) {
    let cost = 0;
    for (let k = 0; k < K; k++) {
      const t = TRUE_PARAMS[perm[k]];
      const meanZ = (params.means[k] - t.mean) / t.std;
      const stdZ = (params.stds[k] - t.std) / t.std;
      cost += meanZ * meanZ + stdZ * stdZ;
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = perm;
    }
  }
  return best!;
}

interface SeedResult {
  seed: number;
  matchRate: number;
  matchRateOk: boolean;
  dangerZoneLowestOk: boolean;
  perState: Record<(typeof STATE_NAMES)[number], { meanErr: number; stdErr: number }>;
}

function evaluateSeed(dataSeed: number): SeedResult {
  const { observations, trueStates } = simulate(N, dataSeed);
  const best = fitGaussianHmmMultiStart(observations, STATE_NAMES.length, NUM_RESTARTS, EM_SEED);

  const namesByLearnedIndex = matchLearnedStatesToNames(best.params);
  const learned = namesByLearnedIndex.map((name, i) => ({
    name,
    mean: best.params.means[i],
    std: best.params.stds[i],
    selfLoop: best.params.transition[i][i],
  }));

  const perState = {} as SeedResult["perState"];
  for (const s of learned) {
    const t = TRUE_PARAMS[s.name];
    const meanRef = Math.abs(t.mean) > 1e-9 ? Math.abs(t.mean) : t.std;
    perState[s.name] = {
      meanErr: Math.abs(s.mean - t.mean) / meanRef,
      stdErr: Math.abs(s.std - t.std) / t.std,
    };
  }

  const dangerZone = learned.find((s) => s.name === "DANGER_ZONE")!;
  const dangerZoneLowestOk = learned.every((s) => s.name === "DANGER_ZONE" || s.selfLoop > dangerZone.selfLoop);

  const decoded = viterbi(observations, best.params);
  let matches = 0;
  for (let t = 0; t < N; t++) {
    if (namesByLearnedIndex[decoded[t]] === STATE_NAMES[trueStates[t]]) matches++;
  }
  const matchRate = matches / N;

  return { seed: dataSeed, matchRate, matchRateOk: matchRate > MIN_STATE_MATCH_RATE, dangerZoneLowestOk, perState };
}

function main() {
  console.log(
    `Evaluating ${DATA_SEEDS.length} data seeds (EM_SEED=${EM_SEED}, ${NUM_RESTARTS} restarts each)...\n`,
  );
  console.log("seed\tViterbi%\tViterbi>70%\tDZ lowest self-loop\tprimary gate");

  const results: SeedResult[] = [];
  for (const seed of DATA_SEEDS) {
    const r = evaluateSeed(seed);
    results.push(r);
    const primaryOk = r.matchRateOk && r.dangerZoneLowestOk;
    console.log(
      `${seed}\t${(r.matchRate * 100).toFixed(1)}%\t\t${r.matchRateOk ? "PASS" : "FAIL"}\t\t${r.dangerZoneLowestOk ? "PASS" : "FAIL"}\t\t\t${primaryOk ? "PASS" : "FAIL"}`,
    );
  }

  const primaryPassCount = results.filter((r) => r.matchRateOk && r.dangerZoneLowestOk).length;

  // Secondary/reference only: average meanErr/stdErr per state across all seeds.
  // Not gated — small-magnitude means (UPTREND/DOWNTREND=+/-0.001) are known to
  // have limited statistical power at N=20000; see TICKET-05X-A commit.
  console.log("\nMean/std error averaged over all seeds (reference only, no pass/fail bar):");
  console.log("state\t\tavg meanErr\tavg stdErr");
  for (const name of STATE_NAMES) {
    const meanErrs = results.map((r) => r.perState[name].meanErr);
    const stdErrs = results.map((r) => r.perState[name].stdErr);
    const avgMeanErr = meanErrs.reduce((a, b) => a + b, 0) / meanErrs.length;
    const avgStdErr = stdErrs.reduce((a, b) => a + b, 0) / stdErrs.length;
    console.log(`${name}\t${(avgMeanErr * 100).toFixed(1)}%\t\t${(avgStdErr * 100).toFixed(1)}%`);
  }

  console.log(
    `\nPrimary gate (Viterbi>70% AND DANGER_ZONE lowest self-loop): ${primaryPassCount}/${DATA_SEEDS.length} seeds passed (need >= ${MIN_PRIMARY_PASS_SEEDS})`,
  );
  const gatePass = primaryPassCount >= MIN_PRIMARY_PASS_SEEDS;
  console.log(`\n${gatePass ? "TICKET-05X-A VERIFIED" : "VERIFICATION FAILED"}`);
  if (!gatePass) process.exitCode = 1;
}

main();
