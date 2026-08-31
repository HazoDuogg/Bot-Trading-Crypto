import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type AnnotationMapping,
  blankLabel,
  isMain,
  parseFlags,
  readJson,
  stringFlag,
} from './shared.js';

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const mappingPath = path.resolve(stringFlag(flags, 'mapping'));
  const labelsDirectory = path.resolve(stringFlag(flags, 'labels-dir', 'apps/bot/annotation-output/blinded/labels'));
  const mapping = await readJson<AnnotationMapping>(mappingPath);
  if (mapping.schemaVersion !== 1 || mapping.entries.length === 0) throw new Error('Unsupported or empty mapping');
  await mkdir(labelsDirectory, { recursive: true });
  const existing = new Set(await readdir(labelsDirectory));
  const collisions = mapping.entries.map((entry) => `${entry.segmentId}.json`).filter((name) => existing.has(name));
  if (collisions.length > 0) {
    throw new Error(`${labelsDirectory} already contains ${collisions.length} target label file(s); use a fresh directory`);
  }

  for (const entry of mapping.entries) {
    const labelPath = path.join(labelsDirectory, `${entry.segmentId}.json`);
    await writeFile(labelPath, `${JSON.stringify(blankLabel(entry.segmentId), null, 2)}\n`, 'utf8');
  }
  console.log(`Generated ${mapping.entries.length} blank label files in ${labelsDirectory}`);
  console.log('Validate them against apps/bot/scripts/annotation/labelSchema.json after annotation.');
}

if (isMain(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
