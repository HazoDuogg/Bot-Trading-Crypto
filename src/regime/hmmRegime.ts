/**
 * Gaussian Hidden Markov Model fit via Baum-Welch (EM). Self-written — no
 * external HMM library — because upstream behavior needs to be verified
 * against synthetic data before it is trusted on real OHLCV series.
 *
 * The forward-backward hot path uses flat Float64Arrays (T*K), not
 * arrays-of-arrays, since T is tens of thousands of points and this runs
 * for hundreds of EM iterations across multiple random restarts.
 */

export interface GaussianHmmParams {
  numStates: number;
  means: number[];
  stds: number[];
  /** transition[i][j] = P(state_{t+1} = j | state_t = i) */
  transition: number[][];
  initial: number[];
}

export interface FitResult {
  params: GaussianHmmParams;
  logLikelihood: number;
  iterations: number;
}

function gaussianPdf(x: number, mean: number, std: number): number {
  const variance = std * std;
  const exponent = -((x - mean) ** 2) / (2 * variance);
  return Math.exp(exponent) / Math.sqrt(2 * Math.PI * variance);
}

/** Mulberry32 PRNG — deterministic when seeded, no external dependency. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomGaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Flat T*K emission probability matrix: B[t*K + k] = p(observation_t | state k). */
function emissionProbMatrix(observations: Float64Array, means: number[], stds: number[]): Float64Array {
  const T = observations.length;
  const K = means.length;
  const B = new Float64Array(T * K);
  for (let t = 0; t < T; t++) {
    const base = t * K;
    for (let k = 0; k < K; k++) {
      B[base + k] = gaussianPdf(observations[t], means[k], stds[k]);
    }
  }
  return B;
}

interface ForwardBackwardResult {
  /** flat T*K posterior state probabilities gamma[t*K+k] = P(state_t = k | O) */
  gamma: Float64Array;
  /** K*K expected transition counts, summed over t */
  xiSum: Float64Array;
  logLikelihood: number;
}

/**
 * Scaled forward-backward (Rabiner 1989) in probability space. Scaling
 * keeps alpha/beta from underflowing over sequences of thousands of steps.
 */
function forwardBackward(
  B: Float64Array,
  T: number,
  K: number,
  transitionFlat: Float64Array,
  initial: number[],
): ForwardBackwardResult {
  const alpha = new Float64Array(T * K);
  const c = new Float64Array(T);

  let sum0 = 0;
  for (let k = 0; k < K; k++) {
    const v = initial[k] * B[k];
    alpha[k] = v;
    sum0 += v;
  }
  c[0] = sum0 > 0 ? 1 / sum0 : 1;
  for (let k = 0; k < K; k++) alpha[k] *= c[0];

  for (let t = 1; t < T; t++) {
    const prevBase = (t - 1) * K;
    const base = t * K;
    let sum = 0;
    for (let j = 0; j < K; j++) {
      let s = 0;
      for (let i = 0; i < K; i++) {
        s += alpha[prevBase + i] * transitionFlat[i * K + j];
      }
      const v = s * B[base + j];
      alpha[base + j] = v;
      sum += v;
    }
    c[t] = sum > 0 ? 1 / sum : 1;
    for (let j = 0; j < K; j++) alpha[base + j] *= c[t];
  }

  const beta = new Float64Array(T * K);
  const lastBase = (T - 1) * K;
  for (let k = 0; k < K; k++) beta[lastBase + k] = c[T - 1];

  for (let t = T - 2; t >= 0; t--) {
    const base = t * K;
    const nextBase = (t + 1) * K;
    for (let i = 0; i < K; i++) {
      let s = 0;
      for (let j = 0; j < K; j++) {
        s += transitionFlat[i * K + j] * B[nextBase + j] * beta[nextBase + j];
      }
      beta[base + i] = s * c[t];
    }
  }

  const gamma = new Float64Array(T * K);
  for (let t = 0; t < T; t++) {
    const base = t * K;
    let s = 0;
    for (let k = 0; k < K; k++) {
      const v = alpha[base + k] * beta[base + k];
      gamma[base + k] = v;
      s += v;
    }
    if (s > 0) {
      for (let k = 0; k < K; k++) gamma[base + k] /= s;
    } else {
      for (let k = 0; k < K; k++) gamma[base + k] = 1 / K;
    }
  }

  const xiSum = new Float64Array(K * K);
  const xiT = new Float64Array(K * K);
  for (let t = 0; t < T - 1; t++) {
    const base = t * K;
    const nextBase = (t + 1) * K;
    let s = 0;
    for (let i = 0; i < K; i++) {
      for (let j = 0; j < K; j++) {
        const v = alpha[base + i] * transitionFlat[i * K + j] * B[nextBase + j] * beta[nextBase + j];
        xiT[i * K + j] = v;
        s += v;
      }
    }
    if (s > 0) {
      for (let idx = 0; idx < K * K; idx++) xiSum[idx] += xiT[idx] / s;
    }
  }

  let logLikelihood = 0;
  for (let t = 0; t < T; t++) logLikelihood -= Math.log(c[t]);

  return { gamma, xiSum, logLikelihood };
}

export interface FitOptions {
  maxIterations?: number;
  tolerance?: number;
  minStd?: number;
}

/** One EM run from a given starting point. Returns the local optimum reached. */
export function fitGaussianHmm(
  observations: number[] | Float64Array,
  initialParams: GaussianHmmParams,
  options: FitOptions = {},
): FitResult {
  const maxIterations = options.maxIterations ?? 200;
  const tolerance = options.tolerance ?? 1e-6;
  const minStd = options.minStd ?? 1e-6;

  const obs = observations instanceof Float64Array ? observations : Float64Array.from(observations);
  const T = obs.length;
  const K = initialParams.numStates;

  let means = [...initialParams.means];
  let stds = [...initialParams.stds];
  let transitionFlat = Float64Array.from(initialParams.transition.flat());
  let initial = [...initialParams.initial];

  let prevLogLikelihood = -Infinity;
  let iterations = 0;

  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1;
    const B = emissionProbMatrix(obs, means, stds);
    const { gamma, xiSum, logLikelihood } = forwardBackward(B, T, K, transitionFlat, initial);

    const gammaSum = new Float64Array(K);
    for (let t = 0; t < T; t++) {
      const base = t * K;
      for (let k = 0; k < K; k++) gammaSum[k] += gamma[base + k];
    }

    const newMeans = new Array(K).fill(0);
    for (let t = 0; t < T; t++) {
      const base = t * K;
      for (let k = 0; k < K; k++) newMeans[k] += gamma[base + k] * obs[t];
    }
    for (let k = 0; k < K; k++) newMeans[k] = gammaSum[k] > 0 ? newMeans[k] / gammaSum[k] : means[k];

    const newVars = new Array(K).fill(0);
    for (let t = 0; t < T; t++) {
      const base = t * K;
      for (let k = 0; k < K; k++) {
        const d = obs[t] - newMeans[k];
        newVars[k] += gamma[base + k] * d * d;
      }
    }
    const newStds = newVars.map((v: number, k: number) => {
      const variance = gammaSum[k] > 0 ? v / gammaSum[k] : stds[k] * stds[k];
      return Math.max(Math.sqrt(variance), minStd);
    });

    const newTransitionFlat = new Float64Array(K * K);
    for (let i = 0; i < K; i++) {
      let denom = 0;
      for (let j = 0; j < K; j++) denom += xiSum[i * K + j];
      for (let j = 0; j < K; j++) {
        newTransitionFlat[i * K + j] = denom > 0 ? xiSum[i * K + j] / denom : transitionFlat[i * K + j];
      }
    }

    const newInitial = Array.from(gamma.slice(0, K));

    means = newMeans;
    stds = newStds;
    transitionFlat = newTransitionFlat;
    initial = newInitial;

    if (Math.abs(logLikelihood - prevLogLikelihood) < tolerance) {
      prevLogLikelihood = logLikelihood;
      break;
    }
    prevLogLikelihood = logLikelihood;
  }

  const transition: number[][] = [];
  for (let i = 0; i < K; i++) {
    transition.push(Array.from(transitionFlat.slice(i * K, i * K + K)));
  }

  return {
    params: { numStates: K, means, stds, transition, initial },
    logLikelihood: prevLogLikelihood,
    iterations,
  };
}

/**
 * Block-based k-means++ seeding: split the series into short contiguous
 * blocks, summarize each as (mean, std), then k-means++ cluster those
 * block statistics in 2D. Clustering raw points can't separate states
 * that share a mean but differ in variance (SIDEWAY vs DANGER_ZONE) or
 * states whose means sit within a std of each other (UPTREND vs
 * DOWNTREND) — regimes persist for many bars (self-transition ~0.85-0.98),
 * so a short block is usually pure-state and its (mean, std) is a far
 * less noisy, better-separated feature than any single observation.
 */
function blockKmeansPlusPlusInit(
  observations: Float64Array,
  numStates: number,
  rng: () => number,
  blockSize: number,
): { means: number[]; stds: number[] } {
  const K = numStates;
  const n = observations.length;

  const blockMeans: number[] = [];
  const blockStds: number[] = [];
  for (let start = 0; start + blockSize <= n; start += blockSize) {
    let sum = 0;
    for (let i = start; i < start + blockSize; i++) sum += observations[i];
    const mean = sum / blockSize;
    let variance = 0;
    for (let i = start; i < start + blockSize; i++) variance += (observations[i] - mean) ** 2;
    blockMeans.push(mean);
    blockStds.push(Math.sqrt(variance / blockSize));
  }
  const numBlocks = blockMeans.length;

  const meanScale = Math.sqrt(blockMeans.reduce((a, b) => a + b * b, 0) / numBlocks) || 1;
  const stdScale = Math.sqrt(blockStds.reduce((a, b) => a + b * b, 0) / numBlocks) || 1;
  const pointsX = blockMeans.map((m) => m / meanScale);
  const pointsY = blockStds.map((s) => s / stdScale);

  const centerX: number[] = [];
  const centerY: number[] = [];
  const firstIdx = Math.floor(rng() * numBlocks);
  centerX.push(pointsX[firstIdx]);
  centerY.push(pointsY[firstIdx]);
  const distSq = new Float64Array(numBlocks);
  for (let k = 1; k < K; k++) {
    let total = 0;
    for (let i = 0; i < numBlocks; i++) {
      let best = Infinity;
      for (let c = 0; c < centerX.length; c++) {
        const d = (pointsX[i] - centerX[c]) ** 2 + (pointsY[i] - centerY[c]) ** 2;
        if (d < best) best = d;
      }
      distSq[i] = best;
      total += best;
    }
    let r = rng() * total;
    let chosen = numBlocks - 1;
    for (let i = 0; i < numBlocks; i++) {
      r -= distSq[i];
      if (r <= 0) {
        chosen = i;
        break;
      }
    }
    centerX.push(pointsX[chosen]);
    centerY.push(pointsY[chosen]);
  }

  const assignments = new Int32Array(numBlocks);
  for (let iter = 0; iter < 20; iter++) {
    for (let i = 0; i < numBlocks; i++) {
      let best = Infinity;
      let bestK = 0;
      for (let k = 0; k < K; k++) {
        const d = (pointsX[i] - centerX[k]) ** 2 + (pointsY[i] - centerY[k]) ** 2;
        if (d < best) {
          best = d;
          bestK = k;
        }
      }
      assignments[i] = bestK;
    }
    const sumX = new Float64Array(K);
    const sumY = new Float64Array(K);
    const counts = new Float64Array(K);
    for (let i = 0; i < numBlocks; i++) {
      sumX[assignments[i]] += pointsX[i];
      sumY[assignments[i]] += pointsY[i];
      counts[assignments[i]]++;
    }
    for (let k = 0; k < K; k++) {
      if (counts[k] > 0) {
        centerX[k] = sumX[k] / counts[k];
        centerY[k] = sumY[k] / counts[k];
      }
    }
  }

  const meanSum = new Float64Array(K);
  const stdSum = new Float64Array(K);
  const counts = new Float64Array(K);
  for (let i = 0; i < numBlocks; i++) {
    const k = assignments[i];
    meanSum[k] += blockMeans[i];
    stdSum[k] += blockStds[i];
    counts[k]++;
  }
  const means = Array.from({ length: K }, (_, k) => (counts[k] > 0 ? meanSum[k] / counts[k] : 0));
  const stds = Array.from({ length: K }, (_, k) => (counts[k] > 0 ? stdSum[k] / counts[k] : stdScale));

  return { means, stds };
}

function randomInitialParams(observations: Float64Array, numStates: number, rng: () => number): GaussianHmmParams {
  const K = numStates;
  const blockSize = Math.max(5, Math.min(50, Math.floor(observations.length / (K * 100))));
  const { means, stds } = blockKmeansPlusPlusInit(observations, K, rng, blockSize);

  // Diagonal-heavy: regimes are expected to persist, and a self-loop-biased
  // starting transition matrix converges far more reliably than a uniform
  // random one (verified empirically on the ticket's synthetic scenario).
  const transition: number[][] = [];
  for (let i = 0; i < K; i++) {
    const selfLoop = 0.7 + 0.25 * rng();
    const row = new Array(K).fill((1 - selfLoop) / (K - 1));
    row[i] = selfLoop;
    transition.push(row);
  }

  const initial = new Array(K);
  let sumInit = 0;
  for (let k = 0; k < K; k++) {
    initial[k] = rng() + 0.1;
    sumInit += initial[k];
  }
  for (let k = 0; k < K; k++) initial[k] /= sumInit;

  return { numStates: K, means, stds, transition, initial };
}

/**
 * Runs EM from `numRestarts` random initializations and keeps the highest
 * log-likelihood result, to avoid reporting a local optimum.
 */
export function fitGaussianHmmMultiStart(
  observations: number[],
  numStates: number,
  numRestarts: number,
  seed: number,
  options: FitOptions = {},
): FitResult {
  const rng = makeRng(seed);
  const obs = Float64Array.from(observations);
  let best: FitResult | null = null;
  for (let r = 0; r < numRestarts; r++) {
    const init = randomInitialParams(obs, numStates, rng);
    const result = fitGaussianHmm(obs, init, options);
    if (!best || result.logLikelihood > best.logLikelihood) {
      best = result;
    }
  }
  if (!best) throw new Error("numRestarts must be >= 1");
  return best;
}

/** Most-likely state sequence given fitted params (Viterbi, log-space). */
export function viterbi(observations: number[], params: GaussianHmmParams): number[] {
  const obs = Float64Array.from(observations);
  const T = obs.length;
  const K = params.numStates;
  const B = emissionProbMatrix(obs, params.means, params.stds);
  const logTransition = params.transition.map((row) => row.map((p) => Math.log(Math.max(p, 1e-300))));
  const logInitial = params.initial.map((p) => Math.log(Math.max(p, 1e-300)));

  const delta = new Float64Array(T * K);
  const psi = new Int32Array(T * K);

  for (let k = 0; k < K; k++) delta[k] = logInitial[k] + Math.log(Math.max(B[k], 1e-300));

  for (let t = 1; t < T; t++) {
    const prevBase = (t - 1) * K;
    const base = t * K;
    for (let j = 0; j < K; j++) {
      let bestVal = -Infinity;
      let bestI = 0;
      for (let i = 0; i < K; i++) {
        const v = delta[prevBase + i] + logTransition[i][j];
        if (v > bestVal) {
          bestVal = v;
          bestI = i;
        }
      }
      delta[base + j] = bestVal + Math.log(Math.max(B[base + j], 1e-300));
      psi[base + j] = bestI;
    }
  }

  const path = new Array(T);
  const lastBase = (T - 1) * K;
  let lastBest = 0;
  let lastVal = -Infinity;
  for (let k = 0; k < K; k++) {
    if (delta[lastBase + k] > lastVal) {
      lastVal = delta[lastBase + k];
      lastBest = k;
    }
  }
  path[T - 1] = lastBest;
  for (let t = T - 2; t >= 0; t--) {
    path[t] = psi[(t + 1) * K + path[t + 1]];
  }
  return path;
}

export function sequenceLogLikelihood(observations: number[], params: GaussianHmmParams): number {
  const obs = Float64Array.from(observations);
  const B = emissionProbMatrix(obs, params.means, params.stds);
  const transitionFlat = Float64Array.from(params.transition.flat());
  const { logLikelihood } = forwardBackward(B, obs.length, params.numStates, transitionFlat, params.initial);
  return logLikelihood;
}
