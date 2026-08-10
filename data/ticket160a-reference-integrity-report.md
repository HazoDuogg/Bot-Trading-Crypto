# TICKET-160A — Reference Integrity Report

## Method

1. Extracted every `data/...`, `docs/...`, `apps/...` path-shaped token from the two authoritative,
   actively-maintained documents (`docs/active-baseline-and-artifact-index.md`,
   `docs/baseline-registry.md`) and confirmed each resolves to a real file on disk.
2. Did the same for the newly-git-allowlisted evidence files themselves
   (`data/archive/ticket153b/*`, `data/archive/ticket158/*`, `data/archive/ticket159/*`,
   `data/ticket160-*`, `docs/archive/ticket157|158|159/*`, `docs/ticket154-*`).
3. Cross-checked manifest-declared hashes against the actual files they describe (see
   `data/ticket160a-parity-report.md` for the hash verification detail).
4. Confirmed `.gitignore`'s new allowlist patterns produce exactly the intended tracked-file set via
   `git add -A --dry-run` (no accidental over-inclusion, no accidental omission).

## Findings — authoritative documents (index + registry)

**Zero unresolved references**, with one explained false-positive from a naive path-token regex:

- `docs/baseline-registry.md` contains the sentence "...its `frozenBaselinePopulation` field records the
  pre-T160-move filename `data/ticket157-ob_disabled-central-ledger.csv`; current path after T160's
  reorganization is `data/archive/ticket157/ticket157-ob_disabled-central-ledger.csv`, byte-identical" —
  a naive regex flags the first (deliberately-quoted, historical, pre-move) filename as "missing" because
  it no longer exists at that path. This is intentional explanatory text, not a live reference; the
  immediately-following current path does resolve. Confirmed by manual read, not just regex.
- All other referenced paths in both documents resolve to real files, verified by direct filesystem check
  (`test -e`) for every extracted path.

## Findings — frozen final-decision reports (T157/T158/T159, now git-tracked for the first time)

**Found and fixed.** The "Evidence paths" list embedded in each ticket's own FINAL DECISION block was
written before TICKET-160 moved the underlying data files from `data/ticket<N>-*` to
`data/archive/ticket<N>/ticket<N>-*`. Those embedded lists referenced filenames that no longer existed at
the stated (unprefixed) path — e.g. `docs/archive/ticket157/ticket157-ob-v2-architecture-challenger-validation-report.md`'s
own "Evidence paths" section said `data/ticket157-v1-parity.csv` (actual current path:
`data/archive/ticket157/ticket157-v1-parity.csv`). Same pattern for T158's and T159's embedded
evidence-path lists (7, 8, and 6 lines respectively).

**Resolution taken:** since this is a mechanical path relocation (caused entirely by T160's own archiving
action, not a substantive change to any decision, number, or conclusion), TICKET-160A updated the
"Evidence paths" list in-place inside all three reports' FINAL DECISION blocks to the correct current
`data/archive/ticket<N>/...` paths, and added a short note above each report's title disclosing exactly
what was changed and why (decision text, numbers, and conclusions were NOT touched — only the path
prefixes in the evidence list). Every one of the 21 corrected paths (7 + 8 + 6) was individually confirmed
to exist on disk at its new location (see Method step 2).

**Result:** all three frozen reports now have fully resolvable evidence-path references. No known broken
reference remains in any tracked document as of this report.

## Findings — code references

Not re-scanned in full by TICKET-160A (T160 already did this exhaustively per
`data/ticket160-reference-integrity-report.md`, and TICKET-160A made zero production-code changes — see
`git diff --stat` in `data/ticket160a-parity-report.md`, which is empty outside `docs/`, `data/`,
`.gitignore`). No code file was touched by this ticket, so no new code-import breakage is possible.

## Broken references found: 0 (24 stale paths across 3 frozen reports found and corrected in-place: 7 in
T157, 8 in T158, 9 in T159 including its human-reviewer CORRECTION note prose — see above)

## Residual regex false-positives (manually reviewed, not live references)

A final full re-scan across all newly-tracked docs still flags a handful of path-shaped strings as
"missing" — every one is deliberate explanatory prose quoting a historical pre-move filename immediately
alongside its corrected current path, not a dangling reference a reader would follow on its own:
`data/ticket157-ob_disabled-central-ledger.csv` and `data/ticket157-v1-parity.csv` (in
`docs/baseline-registry.md` / this report, explaining what changed), `data/ticket159-failure-classification.csv`
/ `data/ticket159-timing-dataset.csv` (in the T159 report's own path-update annotation), and
`data/archive/ticket147..ticket156` (a glob-pattern in `data/ticket160a-evidence-allowlist.csv` prose, not
a literal path). Each was manually confirmed to be paired with a resolvable current path in the same
sentence.
