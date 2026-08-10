# TICKET-160 — Reference Integrity Report

Data-quality label: **CLN-A — CLEAN_PARITY_VERIFIED** for this specific check (build/typecheck/test are
objective pass/fail signals, independently reproduced before and after cleanup).

## Method

1. `grep -rl` across `apps/bot/src`, `apps/bot/scripts`, `package.json`, `apps/bot/package.json` for every
   ticket-number token (147-159) that was moved or deleted, to catch any code that references a path by
   name/string.
2. Full `npm run build` (tsc, emits) and `npm run typecheck` (tsc --noEmit) — these fail loudly on any
   broken `import` path.
3. Full `npm test` (vitest) — fails loudly on any broken runtime `import`/`require`.
4. Manual check of every production `import` statement that resolves into `apps/bot/src/backtest/**` or
   `apps/bot/src/live/executionTelemetry.ts` (the two areas that moved from "untracked" to "tracked" this
   ticket) to confirm the import specifiers were never touched (only `git add` was run — file contents and
   paths are byte-identical to the pre-cleanup untracked copies).

## Findings

- **Zero broken code references.** No `.ts`/`.js`/`package.json` file references a data/docs file that
  moved, by literal path. The only occurrences of moved filenames are inside other **documentation/report**
  files (e.g. `data/archive/ticket153b/ticket153b-run-manifest.json` lists the generating script's
  original path `apps/bot/scripts/ticket147DrawdownLossClusterForensicAudit.ts` as a text provenance
  string) — these are historical text records, not resolved imports, and remain accurate since those
  scripts were **not** moved (left in place in `apps/bot/scripts/`, only staged into git).
- `apps/bot/src/entry/entryRouter.ts` imports `detectObV2` from `../backtest/obV2Research.js` — resolves
  correctly (file present, now tracked).
- `apps/bot/src/orchestrator/orchestrator.ts` imports from `../backtest/momentumEntryTimingResearch.js` —
  resolves correctly.
- `apps/bot/scripts/liveRunner.ts` imports `ExecutionTelemetry` from `../dist/live/executionTelemetry.js`
  — resolves correctly after `npm run build` regenerates `dist/`.
- `apps/bot/scripts/ticket159TimingDatasetBuilder.ts` imports sibling script
  `./ticket150BacktestExecutionRealismAudit.js` — resolves correctly because sibling scripts were **not**
  physically relocated (see rationale in `ticket160-repository-inventory.csv`).
- `npm run build` — 0 errors, before and after cleanup.
- `npm run typecheck` — 0 errors, before and after cleanup.
- `npm test` — 48/48 test files, 649/649 tests passed, identical before and after cleanup.
- No dangling `import`/`require` of any of the 87 deleted stray `.js`/`.d.ts`/`.js.map` files was found —
  they were dead duplicates never imported by anything (only `apps/bot/dist/**`, the real build output, is
  imported at runtime).

## Broken references found: 0
