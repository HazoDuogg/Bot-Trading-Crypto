import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// TICKET-RT-066 Part D: trains the production Soft Veto model (Option C, 4 features) on the FULL
// 3-year dataset (apps/bot/data/xgbAuditDatasetThreeYear.csv — RT-065's research artifact, read
// only, not modified). No train/test split: this is the production model, meant to score FUTURE
// trades, not a walk-forward audit. Saves the trained model + fixed inference-time thresholds to
// apps/bot/data/models/. Run manually for now (retrain cadence/automation deferred — RT-066's
// ticket item 4 explicitly asked to confirm the exact frequency before coding a scheduler; not
// done here).
//
// NOT wired into any production decision path — src/positionSizing/softVeto.ts (this ticket)
// exposes the scoring/threshold/risk-adjustment logic as a ready-to-call, tested, additive
// module, but nothing in src/ currently calls it (there is no live-trading orchestrator in this
// repo yet — verified by search, "entryRouter" does not exist under apps/bot/src). Per the
// ticket: "chua bat that — cho qua Testnet 2 giai doan (Phan E) truoc".

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

async function main() {
  const datasetPath = path.resolve(process.cwd(), 'apps/bot/data/xgbAuditDatasetThreeYear.csv');
  const modelsDir = path.resolve(process.cwd(), 'apps/bot/data/models');
  const modelPath = path.join(modelsDir, 'softVetoModelC.json');
  const metaPath = path.join(modelsDir, 'softVetoModelC.meta.json');
  const trainScriptPath = path.resolve(process.cwd(), 'apps/bot/scripts/trainSoftVetoModel.py');

  console.log(`Doi chieu ${datasetPath} (RT-065, khong sua) — xac nhan dung 3468 dong da chot...`);
  const raw = await readFile(datasetPath, 'utf8');
  const rowCount = raw.trim().split('\n').length - 1;
  if (rowCount !== 3468) {
    console.error(`CORRECTION_REQUIRED: dataset co ${rowCount} dong, khong phai 3468 (RT-065 Part C da chot) — DUNG lai.`);
    process.exitCode = 1;
    return;
  }
  console.log('-> KHOP 100%.\n');

  await mkdir(modelsDir, { recursive: true });

  console.log('Dang train Option C (4 feature: fvgGapSizePct, keyZoneDistancePct, atrH1Pct, slPct) tren toan bo 3468 dong (khong walk-forward)...');
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
    trainedFrom: 'apps/bot/data/xgbAuditDatasetThreeYear.csv',
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
