# Claude Code project instructions

## Authority and scope

- Read the active ticket/spec completely before editing or running an expensive replay.
- The user's current request and the active ticket's prohibitions override skills and default workflows.
- Do not invent equivalent commands, proxy metrics, methodology changes, rescue tuning, or extra scope. If a conflict or ambiguity can change the result, stop and report `CORRECTION_REQUIRED`.
- Preserve unrelated working-tree changes and work on the current branch unless the user explicitly directs otherwise.

## Safety

- Never commit, push, merge, deploy, switch production/main behavior, or call real trading/order APIs unless both the user and the active ticket explicitly authorize that exact action.
- Never use destructive Git/filesystem operations such as `git reset --hard`, `git clean`, broad recursive deletion, or deletion through unresolved globs.
- Production config, admission, sizing, risk, execution, and live defaults are frozen unless the active ticket explicitly authorizes a named change.

## Ticket execution protocol

- Before edits, record: base commit, `git status`, allowed files, frozen invariants, checkpoints, stop gates, required tests, artifacts, and cleanup obligations.
- Build a criterion-to-evidence compliance matrix. A criterion is PASS only when direct reproducible evidence exists.
- Follow checkpoint order exactly. A later or expensive gate must fail closed when its prerequisite artifact, decision, hash, identity, or timestamp is absent or invalid.
- For research tickets, keep the sequence: cause -> evidence -> preregister candidate -> cheap screen -> Central -> cross-cost/holdout -> decision -> cleanup.
- Never run Central before a valid `SCREEN_PASS`; never reuse a premature/diagnostic Central as formal evidence.
- Separate DQ-A/B/C/D/H clearly. Historical/proxy evidence is not live evidence.
- Evaluate path-dependent behavior with full replay and incremental attribution; do not substitute portfolio totals or PF/expectancy for event-path outcomes.
- Remove failed-candidate executable seams and generated orphans as required by the ticket.

## Skills and verification

- When the user invokes a skill, read its `SKILL.md` fully and obey it subject to the authority rules above.
- Use test-first work at agreed seams where practical. Run focused checks during implementation and the ticket-required final checks once at the end.
- Do not claim completion when required tests, artifacts, cleanup, or acceptance evidence are missing.
- The final report must list commands run, evidence paths, key metrics, deviations, remaining limitations, and whether any commit/push/merge/deploy occurred.

