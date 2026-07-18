import * as ort from 'onnxruntime-node';

// B.2 — load once, cache by model path (module-level singleton). Concurrent first calls for the
// same path share the same in-flight load instead of racing to load twice.
const sessionCache = new Map<string, Promise<ort.InferenceSession>>();

function getSession(modelPath: string): Promise<ort.InferenceSession> {
  let cached = sessionCache.get(modelPath);
  if (cached === undefined) {
    cached = ort.InferenceSession.create(modelPath);
    sessionCache.set(modelPath, cached);
  }
  return cached;
}

/**
 * Runs the calibrated momentum model on one feature vector, returns P(label_bullish_momentum=1)
 * in [0,1] — this is `calibrated_probabilities[:,1]`, the ONNX graph's own already-Platt-scaled
 * output (see apps/ml-training/onnx_calibration_bridge.py), not a raw XGBoost margin.
 */
export async function scoreMomentum(modelPath: string, featureVector: Float32Array): Promise<number> {
  const session = await getSession(modelPath);
  const tensor = new ort.Tensor('float32', featureVector, [1, featureVector.length]);
  const results = await session.run({ input: tensor });
  const probabilities = results.calibrated_probabilities.data as Float32Array;
  return probabilities[1];
}
