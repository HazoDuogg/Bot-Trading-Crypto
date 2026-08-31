import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type AnnotationMapping,
  type LabelDocument,
  blankLabel,
  isMain,
  parseFlags,
  readJson,
  shuffled,
  stringFlag,
} from './shared.js';

interface SecondPassMappingEntry {
  secondPassSegmentId: string;
  originalSegmentId: string;
  chartFile: string;
}

interface SecondPassMapping {
  schemaVersion: 1;
  seed: string;
  sourceMappingFile: string;
  entries: SecondPassMappingEntry[];
}

const ANNOTATION_FIELDS = [
  'quality',
  'dominance',
  'swing_points',
  'base_zone',
  'compression',
  'breakout',
  'reclaim',
  'notes',
] as const;

type AnnotationField = (typeof ANNOTATION_FIELDS)[number];

function canonicalValue(field: AnnotationField, value: LabelDocument[AnnotationField]): string {
  if (field === 'swing_points' && Array.isArray(value)) {
    const sorted = [...value].sort((left, right) => left.index - right.index || left.type.localeCompare(right.type));
    return JSON.stringify(sorted);
  }
  return JSON.stringify(value);
}

function markdownCell(value: unknown): string {
  return JSON.stringify(value).replace(/\\/gu, '\\\\').replace(/\|/gu, '\\|').replace(/`/gu, '\\`').replace(/\r?\n/gu, ' ');
}

function assertCompletedLabel(label: LabelDocument, expectedSegmentId: string, filePath: string): void {
  if (label.segment_id !== expectedSegmentId) {
    throw new Error(`${filePath}: segment_id is ${label.segment_id}; expected ${expectedSegmentId}`);
  }
  const required: Array<keyof LabelDocument> = ['quality', 'dominance', 'compression', 'breakout', 'reclaim'];
  const empty = required.filter((field) => label[field] === null);
  if (empty.length > 0) throw new Error(`${filePath}: annotation is incomplete (${empty.join(', ')})`);
}

async function ensureFreshDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length > 0) throw new Error(`${directory} is not empty; use a fresh output directory`);
}

export async function prepareSecondPass(flags: Map<string, string | true>): Promise<void> {
  if (flags.has('first-labels') || flags.has('labels')) {
    throw new Error('prepare must not receive or read first-pass labels');
  }
  const mappingPath = path.resolve(stringFlag(flags, 'mapping'));
  const outputRoot = path.resolve(stringFlag(flags, 'output-dir', 'apps/bot/annotation-output/second-pass'));
  const blindedRoot = path.join(outputRoot, 'blinded');
  const chartsDirectory = path.join(blindedRoot, 'charts');
  const labelsDirectory = path.join(blindedRoot, 'labels');
  const privateDirectory = path.join(outputRoot, 'private');
  await ensureFreshDirectory(chartsDirectory);
  await ensureFreshDirectory(labelsDirectory);
  await ensureFreshDirectory(privateDirectory);

  const source = await readJson<AnnotationMapping>(mappingPath);
  if (source.schemaVersion !== 1 || source.entries.length === 0) throw new Error('Unsupported or empty first-pass mapping');
  const seed = `${source.seed}:second-pass-order`;
  const randomized = shuffled(source.entries, seed);
  const width = Math.max(4, String(randomized.length).length);
  const entries: SecondPassMappingEntry[] = [];

  for (let index = 0; index < randomized.length; index += 1) {
    const sourceEntry = randomized[index];
    const secondPassSegmentId = `seg_${String(index + 1).padStart(width, '0')}`;
    const chartFile = `${secondPassSegmentId}.png`;
    await copyFile(path.join(source.chartsDirectory, sourceEntry.chartFile), path.join(chartsDirectory, chartFile));
    await writeFile(
      path.join(labelsDirectory, `${secondPassSegmentId}.json`),
      `${JSON.stringify(blankLabel(secondPassSegmentId), null, 2)}\n`,
      'utf8',
    );
    entries.push({ secondPassSegmentId, originalSegmentId: sourceEntry.segmentId, chartFile });
  }

  const passMapping: SecondPassMapping = {
    schemaVersion: 1,
    seed,
    sourceMappingFile: mappingPath,
    entries,
  };
  const passMappingPath = path.join(privateDirectory, 'second-pass-mapping.private.json');
  await writeFile(passMappingPath, `${JSON.stringify(passMapping, null, 2)}\n`, 'utf8');
  console.log(`Prepared ${entries.length} independently re-indexed charts in ${blindedRoot}`);
  console.log(`Do not give Claude the private mapping: ${passMappingPath}`);
}

async function readCompletedLabel(directory: string, segmentId: string): Promise<LabelDocument> {
  const filePath = path.join(directory, `${segmentId}.json`);
  const label = await readJson<LabelDocument>(filePath);
  assertCompletedLabel(label, segmentId, filePath);
  return label;
}

export async function compareSecondPass(flags: Map<string, string | true>): Promise<void> {
  const firstLabels = path.resolve(stringFlag(flags, 'first-labels'));
  const secondLabels = path.resolve(stringFlag(flags, 'second-labels'));
  const passMappingPath = path.resolve(stringFlag(flags, 'pass2-mapping'));
  const outputPath = path.resolve(
    stringFlag(flags, 'output', 'apps/bot/annotation-output/private/agreement-report.json'),
  );
  const mapping = await readJson<SecondPassMapping>(passMappingPath);
  if (mapping.schemaVersion !== 1 || mapping.entries.length === 0) throw new Error('Unsupported or empty second-pass mapping');

  const matches = Object.fromEntries(ANNOTATION_FIELDS.map((field) => [field, 0])) as Record<AnnotationField, number>;
  const comparisons = [];
  for (const entry of mapping.entries) {
    const first = await readCompletedLabel(firstLabels, entry.originalSegmentId);
    const second = await readCompletedLabel(secondLabels, entry.secondPassSegmentId);
    const fields = Object.fromEntries(
      ANNOTATION_FIELDS.map((field) => {
        const match = canonicalValue(field, first[field]) === canonicalValue(field, second[field]);
        if (match) matches[field] += 1;
        return [field, { match, first: first[field], second: second[field] }];
      }),
    );
    comparisons.push({
      originalSegmentId: entry.originalSegmentId,
      secondPassSegmentId: entry.secondPassSegmentId,
      fields,
    });
  }

  const total = mapping.entries.length;
  const agreementByField = Object.fromEntries(
    ANNOTATION_FIELDS.map((field) => [field, { matches: matches[field], total, rate: matches[field] / total }]),
  );
  const report = {
    schemaVersion: 1,
    comparedAt: new Date().toISOString(),
    comparisonCount: total,
    comparisonRule: 'Exact JSON value; swing_points are sorted by index/type before comparison.',
    agreementByField,
    comparisons,
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const markdownPath = outputPath.replace(/\.json$/u, '.md');
  const summaryRows = ANNOTATION_FIELDS.map(
    (field) => `| ${field} | ${matches[field]} | ${total} | ${(100 * matches[field] / total).toFixed(2)}% |`,
  );
  const mismatchRows = comparisons.flatMap((comparison) =>
    ANNOTATION_FIELDS.filter((field) => !comparison.fields[field].match).map(
      (field) =>
        `| ${comparison.originalSegmentId} | ${comparison.secondPassSegmentId} | ${field} | ` +
        `\`${markdownCell(comparison.fields[field].first)}\` | \`${markdownCell(comparison.fields[field].second)}\` |`,
    ),
  );
  const markdown = [
    '# Second-pass annotation agreement',
    '',
    'No disagreement is resolved automatically. Review every mismatch manually.',
    '',
    '| Field | Matches | Total | Agreement |',
    '|---|---:|---:|---:|',
    ...summaryRows,
    '',
    '## Mismatches',
    '',
    '| Pass 1 segment | Pass 2 segment | Field | Pass 1 | Pass 2 |',
    '|---|---|---|---|---|',
    ...(mismatchRows.length > 0 ? mismatchRows : ['| — | — | — | — | — |']),
    '',
  ].join('\n');
  await writeFile(markdownPath, markdown, 'utf8');
  console.log(`Compared ${total} segments; wrote ${outputPath} and ${markdownPath}`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command !== 'prepare' && command !== 'compare') {
    throw new Error('Usage: secondPassAnnotation.js <prepare|compare> [flags]');
  }
  const flags = parseFlags(args);
  if (command === 'prepare') await prepareSecondPass(flags);
  else await compareSecondPass(flags);
}

if (isMain(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
