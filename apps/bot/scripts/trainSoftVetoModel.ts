import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// TICKET-RT-066 Part D, retrained by RT-076 on the DOGE lineup: trains the production Soft Veto
// model (Option C, 4 features) on the full backtest dataset passed in via argv, no train/test
// split — this is the live model (src/positionSizing/softVeto.ts, wired into orderLifecycle.ts
// since RT-077). Saves the trained model + fixed inference-time thresholds to apps/bot/data/models/,
// overwriting the previous coin lineup's model. Run manually — retrain automation not implemented.

function findPython(): string {
  const candidates = ['python', 'python3'];
  for (const c of candidates) {
    try {
      execFileSync(c, ['-c', 'import xgboost, pandas'], { stdio: 'ignore' });
      return c;
    } catch {
      // try next
    }
  }
  throw new Error('CORRECTION_REQUIRED: no Python interpreter with xgboost/pandas found on PATH.');
}

interface TrainOutput {
  trainN: number;
  featureColumns: string[];
  topThreshold: number;
  bottomThreshold: number;
  meanScore: number;
  minScore: number;
  maxScore: number;
}

const DATASET_RELATIVE_PATH = 'apps/bot/data/xgbAuditDatasetDoge.csv';
const EXPECTED_ROW_COUNT = 3804; // RT-DOGE-001-confirmed n, reproduced by rt076FeatureAuditDoge.ts

async function main() {
  const datasetPath = path.resolve(process.cwd(), DATASET_RELATIVE_PATH);
  const modelsDir = path.resolve(process.cwd(), 'apps/bot/data/models');
  const modelPath = path.join(modelsDir, 'softVetoModelC.json');
  const metaPath = path.join(modelsDir, 'softVetoModelC.meta.json');
  const trainScriptPath = path.resolve(process.cwd(), 'apps/bot/scripts/trainSoftVetoModel.py');

  console.log(`Doi chieu ${datasetPath} — xac nhan dung ${EXPECTED_ROW_COUNT} dong da chot (RT-DOGE-001)...`);
  const raw = await readFile(datasetPath, 'utf8');
  const rowCount = raw.trim().split('\n').length - 1;
  if (rowCount !== EXPECTED_ROW_COUNT) {
    console.error(`CORRECTION_REQUIRED: dataset co ${rowCount} dong, khong phai ${EXPECTED_ROW_COUNT} — DUNG lai.`);
    process.exitCode = 1;
    return;
  }
  console.log('-> KHOP 100%.\n');

  await mkdir(modelsDir, { recursive: true });

  console.log(`Dang train Option C (4 feature: fvgGapSizePct, keyZoneDistancePct, atrH1Pct, slPct) tren toan bo ${EXPECTED_ROW_COUNT} dong (khong walk-forward)...`);
  const pythonExe = findPython();
  const stdout = execFileSync(pythonExe, [trainScriptPath, datasetPath, modelPath], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const result: TrainOutput = JSON.parse(stdout);

  console.log(`Train xong: n=${result.trainN}  score range=[${result.minScore.toFixed(4)}, ${result.maxScore.toFixed(4)}]  mean=${result.meanScore.toFixed(4)}`);
  console.log(`Nguong CO DINH (tu phan phoi diem tren chinh tap train, khong tinh lai sau nay):`);
  console.log(`  topThreshold (>=)    = ${result.topThreshold.toFixed(6)}  (~20% lenh diem cao nhat)`);
  console.log(`  bottomThreshold (<=) = ${result.bottomThreshold.toFixed(6)}  (~20% lenh diem thap nhat)`);

  const meta = {
    ...result,
    modelPath: path.relative(process.cwd(), modelPath).replace(/\\/g, '/'),
    trainedAtUtc: new Date().toISOString(),
    trainedFrom: DATASET_RELATIVE_PATH,
    coinLineup: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'DOGEUSDT'],
    xgboostHyperparams: { n_estimators: 100, max_depth: 3, learning_rate: 0.1, random_state: 42 },
  };
  await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  console.log(`\nDa ghi model vao ${modelPath}`);
  console.log(`Da ghi metadata (nguong + thong tin train) vao ${metaPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
