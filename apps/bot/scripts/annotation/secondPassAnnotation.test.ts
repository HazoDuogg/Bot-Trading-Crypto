import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compareSecondPass, prepareSecondPass } from './secondPassAnnotation.js';
import { type AnnotationMapping, blankLabel, type LabelDocument } from './shared.js';

let temporaryRoot: string | undefined;

afterEach(async () => {
  if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

function completedLabel(segmentId: string): LabelDocument {
  return {
    ...blankLabel(segmentId),
    quality: 'CLEAN',
    dominance: 'BULL',
    compression: false,
    breakout: 'NONE',
    reclaim: 'NOT_APPLICABLE',
  };
}

describe('second-pass workflow', () => {
  it('prepares without first-pass labels and compares through its private remapping', async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), 'nukida-pass2-test-'));
    const firstCharts = path.join(temporaryRoot, 'first-charts');
    const firstLabels = path.join(temporaryRoot, 'first-labels');
    await mkdir(firstCharts);
    await mkdir(firstLabels);
    const entries = ['seg_0001', 'seg_0002'].map((segmentId, index) => ({
      segmentId,
      chartFile: `${segmentId}.png`,
      sourceId: `source:${index}`,
      symbol: index === 0 ? 'BTCUSDT' : 'ETHUSDT',
      decisionOpenTime: 1_700_000_000_000 + index,
      sourceStartIndex: index * 100,
      candleCount: 81,
    }));
    for (const entry of entries) {
      await writeFile(path.join(firstCharts, entry.chartFile), Buffer.from([137, 80, 78, 71]));
      await writeFile(
        path.join(firstLabels, `${entry.segmentId}.json`),
        JSON.stringify(completedLabel(entry.segmentId)),
      );
    }
    const mapping: AnnotationMapping = {
      schemaVersion: 1,
      seed: 'workflow-seed',
      shuffleSeed: 'workflow-seed:render-order',
      datasetFile: path.join(temporaryRoot, 'segments.private.json'),
      chartsDirectory: firstCharts,
      entries,
    };
    const mappingPath = path.join(temporaryRoot, 'mapping.private.json');
    await writeFile(mappingPath, JSON.stringify(mapping));

    const secondRoot = path.join(temporaryRoot, 'second');
    await prepareSecondPass(new Map([['mapping', mappingPath], ['output-dir', secondRoot]]));
    const pass2MappingPath = path.join(secondRoot, 'private', 'second-pass-mapping.private.json');
    const pass2Mapping = JSON.parse(await readFile(pass2MappingPath, 'utf8')) as {
      entries: Array<{ secondPassSegmentId: string }>;
    };
    const secondLabels = path.join(secondRoot, 'blinded', 'labels');
    for (const entry of pass2Mapping.entries) {
      await writeFile(
        path.join(secondLabels, `${entry.secondPassSegmentId}.json`),
        JSON.stringify(completedLabel(entry.secondPassSegmentId)),
      );
    }

    const reportPath = path.join(temporaryRoot, 'agreement.json');
    await compareSecondPass(
      new Map([
        ['first-labels', firstLabels],
        ['second-labels', secondLabels],
        ['pass2-mapping', pass2MappingPath],
        ['output', reportPath],
      ]),
    );
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      comparisonCount: number;
      agreementByField: Record<string, { rate: number }>;
    };
    expect(report.comparisonCount).toBe(2);
    expect(Object.values(report.agreementByField).every((field) => field.rate === 1)).toBe(true);
  });

  it('refuses any first-pass-label argument during preparation', async () => {
    await expect(
      prepareSecondPass(new Map([['mapping', 'unused'], ['first-labels', 'must-not-be-read']])),
    ).rejects.toThrow('must not receive or read first-pass labels');
  });
});
