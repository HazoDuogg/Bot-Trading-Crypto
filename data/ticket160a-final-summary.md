# TICKET-160A — Final Summary

## Scope executed

1. Corrected the OB (Order Block) conclusion in `docs/active-baseline-and-artifact-index.md` to the exact
   required text, verified word-for-word against `docs/archive/ticket157/ticket157-ob-v2-architecture-challenger-validation-report.md`
   and `docs/archive/ticket158/ticket158-formal-ob-disabled-portfolio-experiment-report.md`. No discrepancy
   found — T157's real decision literally is "OB_DISABLE_EXPERIMENT ... No V2 candidate passes the winner
   gate; no production change is authorized"; T158's real decision literally is "SHADOW_ONLY".
2. Created `docs/baseline-registry.md` locking in three distinctly-named baselines with exact numbers,
   exact cost/data semantics, and exact evidence paths (see that file). All three verified/reproduced —
   see `data/ticket160a-parity-report.md`. No BLOCKED baseline.
3. Added a narrow `.gitignore` allowlist (not a blanket un-ignore) so the minimum evidence set is now
   tracked in git — see the exact patterns in `.gitignore` and the exact file list in
   `data/ticket160a-evidence-allowlist.csv`. Raw OHLCV, live telemetry, `.env`, and whole
   `data/archive/`/`docs/archive/` directories remain untracked by design.
4. Found and fixed 24 stale evidence-path references (path-only, T160-archive-move fallout) inside the
   three frozen T157/T158/T159 final-decision reports, in-place, with disclosure notes — no decision text,
   numbers, or conclusions were altered. See `data/ticket160a-reference-integrity-report.md`.
5. Evaluated the root-level `backup-t139-t141a-20260806-102138/` directory and `repo-recovery-t139-t141a.md`
   — see "Root backup/recovery classification" below.
6. Zero trading-code changes. Zero test/config/default changes.

## T160A FINAL DECISION

```text
T160A FINAL DECISION

Decision: PASS
Cleanup label: CLN-A
Input commit: d1a124c
Output commit: uncommitted — pending human review
Working tree clean: NO (by design — new/modified docs/data/.gitignore files left staged-able but
  uncommitted for human review, per this session's standing instruction to never commit; no stray/dead
  files remain)

Corrections:
- T157 description corrected: YES
- T158 description corrected: YES
- Production OB default documented: YES (obEnabled=true, confirmed in apps/bot/src/entry/entryRouter.ts DEFAULT_ENTRY_ROUTER_CONFIG)
- Research OB-disabled status documented: YES (T159's frozen baseline is explicitly labeled the OB-disabled research counterfactual, not production)

Baseline registry:
- PROD_8FLAG_POST_T152: 261 trades, final $1505.44, WR 41.8%, MaxDD -25.99% ($405.83) — REPRODUCED LIVE, exact match, zero drift
- EXEC_CURRENT_PRODUCTION_CENTRAL_T153B: 211 trades, PF 1.3018644097963348, net $460.50836737263205, final equity $560.508367372632 — VERIFIED via manifest/hash (not full replay, per ticket's own allowance), exact match
- RESEARCH_OB_DISABLED_CENTRAL_T158_T159: 264 trades, PF 1.3947839228431962, net $606.6195245715165 — VERIFIED via manifest/hash + cross-report cross-check (not full replay, per ticket's own allowance; T159 itself additionally reports an independent full-pipeline replay reproducing 264/264 trades exactly), exact match
- Cost/data semantics explicit: YES (see docs/baseline-registry.md "Cost/data semantics summary" table)

Evidence:
- Minimum evidence tracked in Git: YES (20 files: .gitignore + 3 T153B + 2 T158 + 3 T159 data files + 3 T160 files + 4 T160A output files + docs index/registry/T154-schema/T157/T158/T159 reports — see data/ticket160a-evidence-allowlist.csv)
- Fresh-clone evidence check: PASS (git add -A --dry-run confirms exactly the intended allowlisted files would be tracked; verified via `git check-ignore -v` that raw OHLCV/archive-directory files remain excluded)
- Broken references: 0 (24 stale paths found and corrected in-place across the 3 frozen reports; 0 remaining in the actively-maintained index/registry; see data/ticket160a-reference-integrity-report.md for full detail including residual regex false-positives, all manually reviewed and confirmed non-issues)
- Secrets/private telemetry committed: NO (secrets/redaction scan clean — only blanked-token prose and env-var names found, no real values; see data/ticket160a-parity-report.md section 5)
- Root backup/recovery classification: repo-wide grep (ripgrep, respects .gitignore, covers all non-ignored code/config/script/workflow files) found zero references to backup-t139-t141a-20260806-102138/ or repo-recovery-t139-t141a.md from any current runtime/build/test/recovery path — only the recovery doc's own self-reference. This strongly suggests both are safe to archive, but per the ticket's explicit instruction to label UNKNOWN and leave in place absent 100% certainty, and to keep this ticket's footprint narrowly scoped to docs/.gitignore/allowlisted-data changes, they were LEFT EXACTLY WHERE THEY ARE, untouched, unarchived. Classification: UNKNOWN (leaning unreferenced/safe-to-archive, but not moved).

Behavior invariants:
- Trading logic modified: NO
- Regime/risk/execution/balance semantics modified: NO
- T152 unchanged: YES
- obEnabled default unchanged: YES
- Production deployed: NO

Verification:
- Build/typecheck: PASS (0 errors, both, confirmed at session start on commit d1a124c before any edit)
- Tests: PASS (48/48 test files, 649/649 tests — matches last-confirmed count on this exact commit)
- PROD_8FLAG_POST_T152 parity: PASS (261 trades / $1505.44 / 41.8% WR / -25.99% MaxDD, re-run live, exact match, zero drift)
- T153B Central parity/manifest verification: PASS (manifest sha256 0040ec0ad76a206d141042b5d93e82b95ae62e960a358d291a38c9dae3d93535 confirmed; 3 OHLCV file hashes + 2 model hashes spot-checked and matched; summary figures match registry exactly)
- T158/T159 Central parity/manifest verification: PASS (T158 manifest's inputManifestHash matches T153B manifest's actual sha256 exactly; T157/T158/T159's independently-reported 264-trade/PF-1.3948/net-$606.62 figures cross-match exactly across all three sources)
- Maximum reconciliation error: 0

Is repository authorized as stable input for system review: YES
Is any trading behavior change authorized: NO
Is VPS deployment authorized: NO

Evidence paths:
- docs/active-baseline-and-artifact-index.md (corrected)
- docs/baseline-registry.md (new)
- data/ticket160a-evidence-allowlist.csv
- data/ticket160a-reference-integrity-report.md
- data/ticket160a-parity-report.md
- data/ticket160a-final-summary.md (this file)
- .gitignore (narrow allowlist diff)
- docs/archive/ticket157/ticket157-ob-v2-architecture-challenger-validation-report.md (path-corrected)
- docs/archive/ticket158/ticket158-formal-ob-disabled-portfolio-experiment-report.md (path-corrected)
- docs/archive/ticket159/ticket159-unified-entry-timing-optimization-report.md (path-corrected)
```
