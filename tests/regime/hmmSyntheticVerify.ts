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
const DATA_SEED = 4;
const EM_SEED = 42;
const NUM_RESTARTS = 10;
const MEAN_STD_TOLERANCE = 0.15;
const MIN_STATE_MATCH_RATE = 0.7;

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

function main() {
  console.log(`Simulating ${N} points from known 4-state Gaussian HMM (seed=${DATA_SEED})...`);
  const { observations, trueStates } = simulate(N, DATA_SEED);

  console.log(`Running EM: ${NUM_RESTARTS} random restarts (seed=${EM_SEED}), keeping best log-likelihood...`);
  const best = fitGaussianHmmMultiStart(observations, STATE_NAMES.length, NUM_RESTARTS, EM_SEED);
  console.log(`Best log-likelihood: ${best.logLikelihood.toFixed(2)} (${best.iterations} EM iterations)`);

  const namesByLearnedIndex = matchLearnedStatesToNames(best.params);
  const learned = namesByLearnedIndex.map((name, i) => ({
    name,
    mean: best.params.means[i],
    std: best.params.stds[i],
    selfLoop: best.params.transition[i][i],
  }));

  console.log("\nLearned vs true parameters:");
  console.log("state\t\tmean(learned/true)\tstd(learned/true)\tselfLoop(learned/true)");
  for (const s of learned) {
    const t = TRUE_PARAMS[s.name];
    console.log(
      `${s.name}\t${s.mean.toFixed(5)}/${t.mean.toFixed(5)}\t${s.std.toFixed(5)}/${t.std.toFixed(5)}\t${s.selfLoop.toFixed(3)}/${t.selfLoop.toFixed(3)}`,
    );
  }

  let meanStdOk = true;
  for (const s of learned) {
    const t = TRUE_PARAMS[s.name];
    const meanRef = Math.abs(t.mean) > 1e-9 ? Math.abs(t.mean) : t.std;
    const meanErr = Math.abs(s.mean - t.mean) / meanRef;
    const stdErr = Math.abs(s.std - t.std) / t.std;
    const ok = meanErr <= MEAN_STD_TOLERANCE && stdErr <= MEAN_STD_TOLERANCE;
    if (!ok) {
      meanStdOk = false;
      console.log(
        `  FAIL ${s.name}: meanErr=${(meanErr * 100).toFixed(1)}% stdErr=${(stdErr * 100).toFixed(1)}% (tolerance ${MEAN_STD_TOLERANCE * 100}%)`,
      );
    }
  }

  const dangerZone = learned.find((s) => s.name === "DANGER_ZONE")!;
  const dangerZoneHasLowestSelfLoop = learned.every((s) => s.name === "DANGER_ZONE" || s.selfLoop > dangerZone.selfLoop);

  const decoded = viterbi(observations, best.params);
  let matches = 0;
  for (let t = 0; t < N; t++) {
    const decodedName = namesByLearnedIndex[decoded[t]];
    const trueName = STATE_NAMES[trueStates[t]];
    if (decodedName === trueName) matches++;
  }
  const matchRate = matches / N;
  const matchRateOk = matchRate > MIN_STATE_MATCH_RATE;

  console.log(`\nDANGER_ZONE self-transition lowest among 4 states: ${dangerZoneHasLowestSelfLoop ? "PASS" : "FAIL"}`);
  console.log(
    `Viterbi state-sequence match rate: ${(matchRate * 100).toFixed(2)}% (need > ${MIN_STATE_MATCH_RATE * 100}%): ${matchRateOk ? "PASS" : "FAIL"}`,
  );
  console.log(`Mean/std within ${MEAN_STD_TOLERANCE * 100}% tolerance: ${meanStdOk ? "PASS" : "FAIL"}`);

  const allPass = meanStdOk && dangerZoneHasLowestSelfLoop && matchRateOk;
  console.log(`\n${allPass ? "ALL CRITERIA PASSED" : "VERIFICATION FAILED"}`);
  if (!allPass) process.exitCode = 1;
}

main();
