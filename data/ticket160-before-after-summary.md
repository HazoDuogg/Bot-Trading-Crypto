# TICKET-160 — Before/After Summary

Input commit: `89ceab5` (branch `cai-tien`) + the uncommitted T153-T159 working-tree state present at
session start (obEnabled/momentum-timing-research wiring in `entryRouter.ts`/`types.ts`/`orchestrator.ts`/
`types.ts`/`entryRouter.test.ts`, `.gitignore` diff, and ~120 untracked files under `apps/bot/src`,
`apps/bot/scripts`, repo root, and `data/`).

## What changed (T160 cleanup only)

| Action | Count | Detail |
|---|---|---|
| Deleted (stray build artifacts) | 87 files | `apps/bot/src/**/*.js`, `*.d.ts`, `*.js.map` duplicated into `src/` instead of `dist/` by a prior errant compile. Verified byte-identical to `dist/**` before deletion. |
| Tracked via `git add` (production code, previously untracked) | 34 files | `apps/bot/src/backtest/**` (5 `.ts` + 4 `.test.ts`), `apps/bot/src/live/executionTelemetry.ts` + test + fixture, `apps/bot/src/orchestrator/replayCompatibility.test.ts`, `apps/bot/scripts/ticket147*.ts`..`ticket159*.ts` (23 scripts). No content changed — index only. |
| Moved (repo root -> `docs/archive/`) | 9 files | `ticket153*.md`..`ticket159*.md` reports, reorganized by ticket topic. Content byte-identical. |
| Moved (`data/` top level -> `data/archive/<ticket>/`) | 207 files | All `ticket147*`..`ticket159*` data artifacts, reorganized into 15 per-ticket subfolders. Content byte-identical, zero files deleted. |
| New doc created | 1 file | `docs/active-baseline-and-artifact-index.md` |
| Left untouched (out of scope) | `data/ticket140*`..`ticket146*`, `apps/bot/src/entry\|regime\|risk\|xgbFilter\|orchestrator\|live\|telegram` logic, `.env`, `models/`, `data/ohlcv/` | Predates T147-159 session or is core production logic this ticket must not touch. |

**No conditional, threshold, formula, or default value was changed anywhere in production code.** The only
tracked-file diffs present (`entryRouter.ts`, `types.ts`, `orchestrator.ts`, `orchestrator/types.ts`,
`entryRouter.test.ts`) are the prior session's own T153-T159 `obEnabled`/momentum-timing-research wiring,
already present before T160 started and explicitly listed as KEEP in this ticket's brief — T160 did not
edit their logic, only verified defaults are unchanged.

## Incident during verification (fully resolved)

While reconstructing a pristine "before-cleanup" snapshot in a separate `git worktree` (to get an
apples-to-apples backtest comparison), symlinks created inside that worktree
(`apps/bot/node_modules`, `node_modules`, `data/ohlcv` -> pointing back into the main working tree) were
followed destructively by `git worktree remove --force`, which emptied `D:\BotTradingV2\apps\bot`
entirely (all of `apps/bot/src`, `apps/bot/scripts`, `apps/bot/dist`, `package.json`, `tsconfig.json`).

**Recovery, in order:**
1. `git checkout HEAD -- apps/bot` restored every git-tracked file from the last commit.
2. `git checkout -- <path>` restored every file that had been `git add`-ed earlier in this session (content
   was already safe in the git object database/index, so nothing was lost despite the working-tree files
   being deleted).
3. Re-applied the saved `git diff` patch of the 5 modified-but-unstaged tracked files
   (`entryRouter.ts`, `entryRouter.test.ts`, `types.ts`, `orchestrator.ts`, `orchestrator/types.ts`) from a
   patch file saved to the scratchpad before the incident.
4. `npm install` confirmed `node_modules` itself was untouched (0 packages needed reinstalling).
5. `data/ohlcv/` (20 files, 4 symbols x 5 timeframes) and `models/` were confirmed intact by listing.
6. Full rebuild + typecheck + test suite re-run afterward: identical 48/48 test files, 649/649 tests,
   0 build/typecheck errors — same as every other run in this ticket.
7. The offending worktree and its symlinks were removed entirely; no dangling worktrees remain
   (`git worktree list` shows only pre-existing, unrelated worktrees from other sessions).

**Root cause takeaway (recorded in `ticket160-deferred-issues.md`):** never create a directory symlink
pointing from a scratch git worktree back into the main working tree's `node_modules`/data folders on
Windows — Windows directory reparse points can be traversed destructively by naive recursive-delete
implementations. Use a fresh `npm install` (or copy, not symlink) in throwaway worktrees instead.

No data was permanently lost. This is disclosed in full per this ticket's own honesty requirement, even
though the end state is fully recovered and verified.

## Numeric parity (official 8-flag baseline backtest)

Reconstructed a true "before-T160" state in a temporary worktree (commit `89ceab5` + the exact uncommitted
diff/untracked files as they existed at session start) and ran the identical official command:

```
npm run backtest -- --max-concurrent-positions-per-symbol=2 --momentum-direct-enabled=true \
  --momentum-direct-threshold=0.5 --skip-days=20 --momentum-direct-min-sl-percent=1.0 \
  --momentum-direct-tp-r-multiple=3.0 --risk-pool-max-pct=15 --plan-auto-selection-enabled=true
```

| | Before T160 cleanup (reconstructed) | After T160 cleanup |
|---|---|---|
| Trades closed | 261 | 261 |
| Final balance | $1505.44 | $1505.44 |
| Winrate | 41.8% | 41.8% |
| Max Drawdown | -25.99% (-$405.83) | -25.99% (-$405.83) |

**Zero difference.** (Note: this 261-trade number is *not* the older 494-trade/$2107.83 figure from the
2026-07-27 memory note — that gap is fully explained by the T152 same-side-duplicate-position guard,
commit `fac1351`, merged 2026-08-08, i.e. *after* that memory note and *before* T160 started. T152 is a
previously-approved, already-merged behavior change, unrelated to and outside the scope of this cleanup
ticket. See `ticket160-regression-parity-report.md` for full detail.)

## Final decision block

```text
T160 FINAL DECISION

Decision: PASS
Cleanup label: CLN-B (CLN-A for build/test/backtest/balance parity checks; CLN-B overall because ~80
  data/archive files from T147-T150/T153/T153A/T153C/T156A/T156B were conservatively archived rather than
  individually re-verified as reproducible/redundant -- see rationale in ticket160-repository-inventory.csv)
Input commit: 89ceab5
Output commit: uncommitted -- pending human review
Working tree clean: NO (by design -- staged/modified files left for human review per instructions; no
  stray/dead files remain, see git status in ticket160-regression-parity-report.md)

Inventory:
- KEEP_ACTIVE: 34 files newly tracked (git add) + all pre-existing production src/scripts/tests (unchanged) + 5 modified tracked files (T153-159 wiring, unchanged by T160)
- KEEP_EVIDENCE: 20 (ticket153b) + 54 (ticket157) + 9 (ticket158) + 39 (ticket159) data files = 122, plus docs/archive/ticket159 final report, docs/ticket154 schema doc, and the T154 fixture
- ARCHIVE: 9 root .md reports (moved to docs/archive) + 80 data files (ticket147/147a/148/149/150/153/153a/153c/156a/156b, moved to data/archive) + 23 research scripts (git add, left in place)
- DELETE_SAFE removed: 87 stray build-artifact files
- UNKNOWN remaining: 0

Behavior invariants:
- Strategy logic modified: NO
- Regime logic modified: NO
- Risk/sizing modified: NO
- Execution semantics modified: NO
- T152 guard unchanged: YES
- Production deployed: NO

Verification:
- Build/typecheck: PASS (0 errors, before and after)
- Unit/regression tests: PASS (48/48 files, 649/649 tests, before and after)
- Live dry-run startup: PASS (testnet, dryRun=true, TELEGRAM tokens blanked for the smoke test only,
  no .env file modified; exchangeInfo loaded for 4 symbols, leverage set in DRY_RUN log-only mode,
  exchange-authoritative balance fetched successfully; process then exited safely and expectedly on
  missing Telegram config since we deliberately blanked it -- proves wiring integrity, not a real bug)
- Active baseline parity: PASS (261 trades / $1505.44 / -25.99% DD identical before vs after T160, see above)
- T159 OB-disabled Central parity: PASS (264 trades / PF 1.3947839228431962 / net $606.6195245715165 --
  exact match to the ticket's own previously-verified figures, confirmed unchanged after moving the file)
- Balance/reconciliation tests: PASS (liveBalanceSync.test.ts included in the 649 passing tests)
- Maximum numeric reconciliation error: 0 (exact match on every compared figure)

Repository status:
- Broken references: 0 (see ticket160-reference-integrity-report.md)
- Secrets/raw private telemetry found: NONE (the one live/fixtures/*.jsonl file is a synthetic/sanitized
  sample with placeholder hashed IDs, not real telemetry; .env was read only for variable NAMES, never
  values, and was not modified)
- Active baseline index complete: YES (docs/active-baseline-and-artifact-index.md)
- Deferred issues recorded: YES (data/ticket160-deferred-issues.md; 2 items)

Is repository authorized as the stable input for system review: YES
Is any trading behavior change authorized: NO
Is any VPS deployment authorized: NO

Evidence paths:
- data/ticket160-repository-inventory.csv
- data/ticket160-delete-archive-manifest.csv
- data/ticket160-reference-integrity-report.md
- data/ticket160-before-after-summary.md
- data/ticket160-regression-parity-report.md
- docs/active-baseline-and-artifact-index.md
- data/ticket160-deferred-issues.md
```
