# TICKET-G6R — Correct Shadow Screening & Funnel Protocol

## Quyết định đầu vào

G6 đã tạo ra một diagnostic Central run có số liệu tự reconcile:

```text
G6-C1 portfolio: 249 trades / PF 1.341109 / net +$557.961959 / expectancy $2.240811 / MaxDD 49.491558%
INCREMENTAL_NEW: 37 trades / net -$8.270386 / PF 0.917053 / expectancy -$0.223524
REPLACEMENT_OTHER: 24 trades / net +$103.317051 / PF 1.534647 / expectancy +$4.304877
```

Những con số này là diagnostic có ích, nhưng quyết định `NO_CANDIDATE` của G6 không hợp lệ theo protocol vì:

1. Central replay chạy trước cheap screen;
2. cheap-screen artifact được tạo sau Central và dùng chính Central PF/expectancy làm proxy;
3. PF không tương đương `+1R-before-SL`, expectancy USD không tương đương median `MFE_R`;
4. Checkpoint 2 DQ-C outcome labeling bị bỏ;
5. funnel chỉ có `SETUP/MACRO/MSS/ADMITTED`, không phải full-path funnel;
6. funnel không giữ stable event-level keys nên không chứng minh được duplicate/missing-join toàn tuyến;
7. Checkpoint 0 dùng “equivalent harness”, không chạy exact required `g2rVariantReplay.js` và không lưu fresh G6 canonical identity evidence;
8. retained `g6OpportunityFunnel.ts` thiếu enforced provenance/parity assertion và clean-workspace output handling.

Trạng thái đúng:

```text
G6 formal decision: INVALID_REPLAY
G6-C1 premature Central run: DQ-C — DIAGNOSTIC_ONLY / PREMATURE_CENTRAL
G6-C1 rule registration: FROZEN; may not be retuned or expanded
Production behavior modified: NO
```

## Mục tiêu duy nhất

Đánh giá G6-C1 đúng thứ tự bằng một shadow event population được freeze trước outcome screening, full-path funnel có provenance và DQ-C MFE/MAE/R-before-SL labels. Chỉ chạy một Central replay mới nếu cheap screen thực sự PASS.

G6R không nhằm cứu G6-C1. Nếu cheap screen fail, kết luận `NO_CANDIDATE` và dừng.

## Candidate khóa cứng

Candidate duy nhất:

```text
G6-C1 — CASCADE_FALLTHROUGH_ON_MSS_FAIL
```

Exact rule giữ nguyên registration tại `data/g6-root-cause-and-candidate-registration.md`:

```text
Evaluate the current primary OB candidate exactly as production does.
If OB confirms MSS: current OB decision wins; shadow candidate does nothing.
If OB exists but its own MSS fails:
  shadow-evaluate FVG on the same decision state;
  if FVG exists and its own unchanged MSS confirms: emit one frozen FVG shadow event;
  otherwise shadow-evaluate Sweep;
  if Sweep exists and its own unchanged MSS confirms: emit one frozen Sweep shadow event;
  otherwise emit no actionable G6-C1 event.
```

Không được thay đổi:

- cascade order;
- MSS/staleness constants;
- detector thresholds;
- entry/SL geometry;
- confirmation rules;
- missing-data behavior;
- symbol/regime eligibility;
- bất kỳ numeric threshold nào.

Không candidate thứ hai. Không Direction B. Không retune/rescue variant.

Explicit forbidden dependencies:

```text
availableRewardR
future structural boundary
extensionAtr threshold
body-ratio-only gate
T159 pullback arm/state
new reward/confirmation/retest gate
symbol/month allowlist derived from G6 outcomes
```

## Bất biến

- Risk 15%, sizing, leverage, risk pool, regime/cooldown, T152, TP/SL, management, execution assumptions và XGBoost không đổi.
- `obEnabled=true` production default không đổi.
- Không dùng premature Central metrics để chọn/đổi candidate rule hoặc cheap-screen threshold.
- Shadow analysis không được admit trade, thay balance, chiếm slot, thay risk pool, circuit breaker hoặc open-position state.
- Không sửa live config/CLI.
- Không gọi API tạo/sửa/hủy lệnh thật.
- Không commit, push, merge hoặc deploy.
- Không gọi historical evidence là live truth.

## Data-quality labels

```text
Exact C0 Central replay: DQ-B — HISTORICAL_PROXY / COMPARABLE_WITH_LIMITATIONS
Shadow event ledger: DQ-B — HISTORICAL_PROXY
MFE/MAE/R-before-SL labels: DQ-C — DIAGNOSTIC_ONLY
G6 premature Central: DQ-C — DIAGNOSTIC_ONLY / PREMATURE_CENTRAL
```

Không nâng bất kỳ output nào thành `DQ-A`.

## Thiết kế module và seam bắt buộc

G6R phải tạo một research-only **module** sâu với một **interface** nhỏ. **Seam** nằm ở research replay adapter, không nằm trong production admission path.

Interface khuyến nghị:

```ts
interface G6ShadowOpportunityAnalyzer {
  observeDecision(input: Readonly<EntryRouterInput>, context: Readonly<ShadowDecisionContext>): G6ShadowObservation;
}
```

Một call phải trả đủ implementation result, không buộc caller tự ghép detector/MSS state:

```ts
interface G6ShadowObservation {
  evaluationId: string;
  symbol: string;
  regime: MarketRegime;
  evaluationTimestamp: number;
  primary: StageEvaluation | null;
  fvgFallback: StageEvaluation | null;
  sweepFallback: StageEvaluation | null;
  actionableShadowEvent: FrozenShadowEvent | null;
}
```

Module phải:

- gọi production detector/MSS functions; không copy công thức indicator/detector;
- tự quản cascade ordering, required fields, stable keys và fail-fast validation bên trong implementation;
- trả kết quả thuần dữ liệu, không ghi file và không mutate input/state;
- không nhận callback có thể thay đổi quyết định;
- không expose nhiều threshold/config mới;
- có adapter baseline-observation và adapter G6-C1-shadow thực sự sử dụng cùng interface;
- có tests qua interface, không test xuyên qua private implementation.

Nếu cần duplicate một phần orchestration từ `runTrendStyle()` trong research module vì hàm production chưa export, phải có behavioral-equivalence test trên full replay decision population:

```text
current-policy shadow selection vs production routeEntry(): exact setup/no-setup/side/entry/sl identity
mismatches = 0
```

Không refactor production `entryRouter.ts` chỉ để làm instrumentation trừ khi không có cách research-side an toàn. Nếu buộc phải sửa production source:

- giải thích seam placement;
- flag/callback omitted phải exact parity;
- thêm tests;
- nếu G6-C1 fail, revert mọi production change chỉ phục vụ G6R;
- không được giữ speculative interface chỉ vì “có thể hữu ích sau”.

## Checkpoint 0 — Correct G6 status và freeze provenance

Trước code/replay:

1. Ghi branch, base commit, `git status --short`, timestamps và SHA-256 của:
   - `TICKET-G6-Opportunity-Expansion.md`;
   - `data/g6-root-cause-and-candidate-registration.md`;
   - `data/g6-runs/g6-c1-central-trades.csv`;
   - `data/g6-runs/g6-c1-central-summary.json`.
2. Gắn premature Central files là diagnostic-only; không sửa/xóa số liệu gốc.
3. Ghi hash candidate registration để chứng minh candidate rule frozen trước G6R screening.
4. Cập nhật `data/g6-final-summary.md` decision history: G6 formal result `INVALID_REPLAY`, premature Central diagnostic-only. Không được để `NO_CANDIDATE` là current authoritative decision trước khi G6R hoàn tất.

### Authorized narrow provenance waiver — 2026-08-15

User đã phê duyệt waiver này sau khi correction audit xác nhận `TICKET-G6-Opportunity-Expansion.md` là untracked và đã bị xóa trong một cleanup do Codex thực hiện ngoài phiên Claude triển khai. Exact file bytes, valid 64-character SHA-256 và Checkpoint-0 read timestamps của file đó không thể phục hồi trung thực từ Git, Claude worktrees hoặc retained logs.

Waiver chỉ áp dụng cho hai dữ kiện hành chính không thể phục hồi:

1. exact SHA-256/timestamp của `TICKET-G6-Opportunity-Expansion.md` đã bị xóa;
2. original Checkpoint-0 hash-read timestamps của bốn provenance inputs.

Không được reconstruct, pad, suy đoán hoặc trình bày malformed 63-character token như valid SHA-256. Manifest phải giữ trạng thái `UNRECOVERABLE` và lý do bên ngoài phiên triển khai.

Thay cho file ticket bị mất, freeze và hash đầy đủ các anchor còn kiểm chứng được tại thời điểm C0 rerun:

- `data/g6-final-summary.md` — authoritative G6 status `INVALID_REPLAY` và premature Central diagnostic-only;
- `data/g6-root-cause-and-candidate-registration.md` — exact frozen G6-C1 rule;
- `data/g6-runs/g6-c1-central-trades.csv` — premature diagnostic ledger;
- `data/g6-runs/g6-c1-central-summary.json` — premature diagnostic summary;
- active `TICKET-G6R-Correct-Shadow-Screening-and-Funnel-Protocol.md` — current evaluation contract including this waiver.

Checkpoint 0 chỉ được ghi `PASS_WITH_AUTHORIZED_PROVENANCE_WAIVER`, không được ghi clean `PASS`. Waiver phải xuất hiện trong run manifest và final summary với scope, approver (`USER`), approval date, missing evidence và substitute-anchor hashes.

Waiver **không áp dụng** cho candidate registration/rule hash, dataset/tool/output hashes, fresh C0 identity, event/shadow/outcome ledger hashes, leakage audit, cheap-screen timestamp/decision, Central authorization guard, Central/cross-cost gates, tests hoặc cleanup. Không nới threshold, candidate rule hay checkpoint order.

## Checkpoint 1 — Exact fresh C0 baseline

Run C0 trước waiver có numeric result đúng nhưng thiếu exact process timestamps và raw starting-status preimage, nên giữ `INVALID_REPLAY` và không được promote/relabel. Phải chạy một **fresh C0 rerun**; đây là current-baseline replay, không phải candidate Central.

Trước rerun, tạo fail-fast logging wrapper/research harness chỉ bao quanh exact command, không thay replay config/code path. Wrapper phải persist dưới `data/g6r-runs/`:

- exact raw `git status --short` bytes trước replay và SHA-256 của chính bytes đó;
- resolved branch/base commit và active-ticket hash;
- exact UTC timestamp ngay trước process start;
- exact command/env values;
- process exit code;
- exact UTC timestamp ngay sau process exit;
- build/tool/dataset hashes trước run;
- output paths/hashes/mtimes sau successful exit.

Wrapper phải write start/status record trước khi spawn Node và finalize end/exit record sau khi process trả về. Nếu wrapper/log write, process spawn, exit code hoặc required evidence fail: `INVALID_REPLAY`, không tiếp tục Checkpoint 2. Không back-derive UTC start/end từ runtime hoặc mtimes.

Chạy đúng command, không dùng “equivalent harness” thay thế:

```powershell
$env:T153_LIBRARY_MODE='true'
$env:G2R_VARIANT='N0_CURRENT'
$env:G2R_SCENARIO='CENTRAL'
node apps/bot/scripts-dist/g2rVariantReplay.js
```

Copy/link fresh output vào `data/g6r-runs/` với run manifest chứa:

- command;
- UTC start/end;
- base commit/working-tree status hash;
- dataset file hashes/ranges;
- config/cost scenario;
- output hashes;
- tool source hash.

So trực tiếp với:

```text
data/archive/ticket153b/ticket153b-central-ledger.csv
```

Key:

```text
entryTimestamp|symbol|side
```

Gate:

```text
211 trades
82/129 wins/losses
WR 38.862559241706165%
PF 1.3018644097963348
Net +$460.50836737263205
Expectancy $2.182504110770768
MaxDD 56.4586700334848%
Streak 14
Fresh/canonical rows 211/211
Unique 211/211
Duplicates 0/0
Only-fresh/only-canonical 0/0
```

Fail bất kỳ gate nào: `INVALID_REPLAY`, dừng.

## Checkpoint 2 — Event-level full-path baseline funnel

Thay thế/harden `apps/bot/scripts/g6OpportunityFunnel.ts`. Canonical funnel không được chỉ là aggregate CSV.

Mỗi evaluation phải giữ stable ID:

```text
evaluationId = symbol|evaluationTimestamp|regime|routeInvocationOrdinal
```

Mỗi actionable candidate event phải giữ stable key:

```text
candidateKey = symbol|side|setupType|decisionTimestamp|sourceTimestamp
```

Event ledger phải có tối thiểu:

```text
evaluationId
candidateKey (nullable before candidate exists)
symbol
side
regime
setupType
evaluationTimestamp
sourceTimestamp
decisionTimestamp
stage
outcome
reason
entryPrice
slPrice
dataQuality
```

Required non-overlapping stages/reasons:

```text
RAW_DETECTOR_EVALUATION
DETECTOR_FOUND / DETECTOR_NOT_FOUND
SELECTED_BY_ROUTER / PREEMPTED_BY_HIGHER_PRIORITY
MSS_PASS / MSS_FAIL
BLOCKED_BY_REGIME_OR_HTF
BLOCKED_BY_CIRCUIT_BREAKER
BLOCKED_BY_SAME_SIDE_OR_CONCURRENCY
BLOCKED_BY_RISK_OR_MARGIN
ADMITTED_AS_TRADE
```

Nếu production path không gọi router vì open-position/concurrency state, ghi stage/reason tương ứng thay vì bỏ mất evaluation.

Funnel phải reconcile event-level rồi mới aggregate:

- duplicate `evaluationId` = 0;
- duplicate actionable `candidateKey` = 0, hoặc explicit dedupe invariant có evidence;
- missing parent/child joins = 0;
- every evaluation ends in exactly one terminal reason;
- admitted candidate keys match fresh C0 ledger 211/211 where applicable;
- breakdown theo setupType, symbol, month, regime và side.

Không gọi aggregate count là proof nếu event ledger không tồn tại.

## Checkpoint 3 — Freeze G6-C1 shadow population

Chạy baseline replay một lần với shadow analyzer attached. Shadow adapter chỉ quan sát decision state; production route/admission vẫn chạy current behavior.

Với mỗi OB-primary evaluation:

1. reproduce OB current selection and MSS result;
2. chỉ khi OB exists và OB MSS fails, evaluate FVG;
3. nếu FVG actionable, emit FVG shadow event và không evaluate Sweep for candidate selection;
4. nếu FVG absent/non-actionable, evaluate Sweep;
5. emit tối đa một actionable G6-C1 shadow event cho một evaluation.

Frozen shadow event fields:

```text
candidateKey
evaluationId
symbol/side/regime/setupType
sourceTimestamp
decisionTimestamp
entryPrice/slPrice
slDistance
required-data coverage flags
primary OB MSS fail reason
fallback detector/MSS result
registrationHash
analyzerSourceHash
```

Freeze trước outcome labeling:

- write event ledger;
- compute SHA-256;
- record row/unique/duplicate counts;
- không sửa ledger sau khi outcome labels được tính;
- candidate rule/threshold không đổi sau freeze.

Không dùng config flag availability để kết luận Sweep `BLOCKED_BY_DATA`. Research shadow analyzer được phép gọi production Sweep detector trực tiếp trên cùng decision-time input. Nếu Sweep vẫn không đo được, phải chỉ ra required decision-time field thực sự thiếu, không phải thiếu CLI toggle.

## Checkpoint 4 — DQ-C outcome labeling đúng nghĩa

Chỉ đọc frozen shadow ledger. Không admit candidate và không chạy candidate Central.

Horizon khóa cứng:

```text
1h = decisionTimestamp + 60 minutes
3h = decisionTimestamp + 180 minutes
```

Path ordering:

- dùng closed 1m candles với timestamp strictly greater than `decisionTimestamp` và <= horizon end;
- nếu required 1m path bị thiếu/gap, label `MISSING_OUTCOME_PATH`, không fallback im lặng sang 5m;
- nếu SL và R-target chạm cùng một 1m candle, conservative ordering = SL first;
- LONG/SHORT mirror đúng;
- outcome candles chỉ dùng làm labels, không làm decision features.

Risk geometry:

```text
R = abs(entryPrice - slPrice)
LONG requires slPrice < entryPrice
SHORT requires slPrice > entryPrice
R > 0 and finite
```

Mỗi horizon phải xuất:

- `MFE_R`;
- `MAE_R`;
- `hit1RBeforeSL`;
- `hit2RBeforeSL`;
- `hit3RBeforeSL`;
- `slBefore1R`;
- `firstHitTimestamp` và `firstHitType`;
- missing/gap label.

Aggregate bắt buộc:

- n;
- valid geometry coverage;
- valid path coverage;
- MFE_R p25/median/p75;
- MAE_R p25/median/p75;
- +1R/+2R/+3R-before-SL rates;
- SL-before-1R rate;
- breakdown theo setupType/symbol/month/regime/side.

Cấm dùng:

- trade PF làm proxy cho R-before-SL;
- USD expectancy làm proxy cho median MFE_R;
- premature Central results làm input label;
- post-outcome deletion/filtering event rows.

## Checkpoint 5 — Cheap screen trước Central

Cheap screen chỉ đọc frozen event ledger + DQ-C labels.

G6-C1 PASS khi và chỉ khi PASS toàn bộ:

```text
Eligible actionable shadow events >= 20
Valid risk geometry coverage >= 95%
Valid 3h outcome-path coverage >= 95%
+1R-before-SL rate > SL-before-1R rate
Median MFE_R at 3h > 1.0
No symbol > 60% population
No month > 50% population
At least 3 symbols
At least 3 calendar months
Duplicate candidate keys = 0
Missing joins = 0
Leakage audit = PASS
```

Screen artifact phải được write/finalize trước mọi candidate Central process start. Ghi:

- screen timestamp;
- frozen ledger hash;
- registration hash;
- decision;
- exact gate table.

Nếu fail bất kỳ gate nào:

```text
Decision: NO_CANDIDATE
New Central replay: NOT_RUN
Premature G6 Central: DIAGNOSTIC_ONLY, not used for formal decision
```

Sau fail: cleanup candidate/shadow runtime seam; chỉ giữ research analyzer nếu đáp ứng retention gate bên dưới.

## Checkpoint 6 — Conditional new Central replay

Chỉ thực hiện nếu Checkpoint 5 artifact đã tồn tại với `SCREEN_PASS` và timestamp sớm hơn Central start.

Không reuse premature G6 Central. Reimplement exact frozen G6-C1 rule, verify source/rule hash, rồi chạy đúng một new Central replay.

### Fail-closed Central authorization guard

Điều kiện trên phải được enforce bằng code ở entry point chạy candidate Central, không chỉ bằng convention, console message hoặc kiểm tra thủ công. Central runner phải nhận explicit path tới finalized cheap-screen artifact và, **trước khi khởi tạo candidate replay hoặc tạo bất kỳ Central output nào**, verify toàn bộ:

- artifact tồn tại, parse được và đúng required schema;
- decision đúng chính xác `SCREEN_PASS`;
- candidate ID là `G6-C1` và candidate registration/rule hash khớp frozen registration;
- `shadowLedgerHash` khớp SHA-256 của frozen shadow ledger được cung cấp;
- `outcomeLabelsHash` khớp SHA-256 của frozen DQ-C outcome-label artifact được cung cấp;
- screen timestamp parse được, sớm hơn Central process start và chính artifact đã được finalized trước start;
- duplicate candidate keys = 0, missing joins = 0 và leakage audit = `PASS` như đã ghi trong gate table.

Nếu thiếu hoặc fail bất kỳ check nào: process phải exit non-zero, không initialize/run candidate replay, không write/overwrite Central ledger/attribution/summary, và ghi rõ check nào bị từ chối. Không được có `--force`, env flag, diagnostic mode hoặc fallback path bypass guard. Premature G6 Central không thể thỏa guard này và không được nhận diện như authorized run.

Mỗi Central run manifest phải lưu screen artifact path/hash, registration hash, shadow-ledger hash, outcome-label hash, screen timestamp, Central start timestamp và kết quả từng authorization check. Chỉ một authorization với mọi check PASS mới được phép tạo đúng một new Central replay.

Áp dụng nguyên Central winner/attribution gates của G6:

- KEPT_BASELINE;
- REMOVED_BASELINE;
- INCREMENTAL_NEW;
- REPLACEMENT_OTHER;
- setup-type collisions explicit;
- portfolio net >= $506.559204110;
- PF >= 1.35;
- expectancy >= $2.25;
- WR không giảm;
- MaxDD/streak không xấu;
- incremental n>=20, net>0, PF>1, expectancy>0;
- stability/extreme-winner gates.

Nếu Central fail: `NO_CANDIDATE`, cleanup, không cross-cost.

Nếu Central pass: mới chạy Fee-only/Light/Conservative/holdout theo G6. Không thay threshold/rule.

## Retention gate cho research tooling

`g6OpportunityFunnel.ts` hiện tại không được giữ nguyên dưới nhãn active tooling.

Chọn một:

### DELETE

Xóa source + exact `scripts-dist` outputs nếu đã được thay thế hoặc không đáp ứng validation.

### RETAIN_WITH_FULL_VALIDATION

Tool/module chỉ được giữ nếu đồng thời:

- dùng typed `FunnelEvent`/typed discriminated events, không `Record<string, unknown>` casts;
- exhaustive stage handling, unknown stage fail-fast;
- explicit CLI mode, không silent env-only behavior;
- tự tạo output directory hoặc fail-fast rõ precondition;
- không overwrite canonical artifact trước parity/provenance validation;
- assert exact 211 C0 metrics/identity before baseline canonical write;
- embed manifest/config/dataset/tool/output hashes;
- required-column validation;
- duplicate-key rejection;
- missing-join fail-fast;
- reproducible from clean checkout plus documented data prerequisites;
- no production import/caller depends on it.

Không đạt đủ thì xóa, giữ artifacts làm historical evidence.

## Required tests

- analyzer is pure: inputs unchanged, no account/admission mutation;
- current-policy shadow vs production `routeEntry` full-population equivalence = 0 mismatch;
- exact G6-C1 cascade ordering;
- at most one actionable shadow event per evaluation;
- FVG actionable prevents Sweep selection for same evaluation;
- LONG/SHORT risk-geometry symmetry;
- decision timestamp boundary;
- only candles `> decisionTimestamp` used for outcome;
- 1h/3h horizon boundary;
- SL-first same-candle ambiguity;
- missing 1m gap behavior;
- stable key determinism;
- duplicate/missing-join fail-fast;
- forbidden dependency source audit;
- no-callback/observer production parity;
- Central authorization guard happy path cho phép đúng một replay sau valid `SCREEN_PASS`;
- Central authorization guard từ chối riêng từng trường hợp: missing/malformed artifact, non-PASS decision, candidate/rule/registration hash mismatch, shadow-ledger hash mismatch, outcome-label hash mismatch, invalid/non-prior timestamp, duplicate key, missing join và leakage audit fail;
- mỗi guard rejection exit non-zero và chứng minh candidate replay chưa initialize, không Central output nào được tạo/overwrite;
- không CLI/env/diagnostic bypass được Central authorization guard.

## Cost gate

- Một candidate duy nhất, exact G6-C1.
- Không new threshold.
- Không grid search.
- Không candidate rescue.
- Một exact fresh C0 replay.
- Một baseline shadow-analysis replay để freeze events.
- Zero candidate Central nếu cheap screen fail.
- Tối đa một new candidate Central nếu screen pass.
- Cross-cost chỉ nếu new Central winner.
- Không chạy production 8-flag baseline nếu final diff không còn production changes; dùng source/diff/reference/tests chứng minh untouched.

## Required outputs — giới hạn artifact

Tối đa 7 canonical outputs:

1. `data/g6r-run-manifest.json`
2. `data/g6r-full-funnel-events.csv`
3. `data/g6r-shadow-events.csv`
4. `data/g6r-outcome-labels.csv`
5. `data/g6r-cheap-screen.csv`
6. `data/g6r-central-attribution.csv` — chỉ nếu screen PASS và new Central chạy
7. `data/g6r-final-summary.md`

Machine replay ledgers có thể nằm dưới `data/g6r-runs/`; scratch/reconcile scripts và duplicate reports phải cleanup.

Không sửa historical G6 raw artifacts; chỉ cập nhật `data/g6-final-summary.md` decision history/status để đánh dấu formal G6 `INVALID_REPLAY` và premature Central diagnostic-only.

## Verification cuối

Sau cleanup:

```text
npm run typecheck
npm run build
npm run build:scripts
npm test
git diff --check
```

Reference audit:

- failed G6-C1 runtime/config/type/state refs = 0 nếu decision không ADOPT;
- rejected T159/G5/G5R refs = 0;
- orphan generated outputs = 0;
- no imports/tests point deleted files;
- production config/CLI unchanged;
- `g6OpportunityFunnel.ts` = deleted hoặc full retention gate PASS.

## Acceptance criteria

- G6 status corrected to `INVALID_REPLAY`; premature Central labeled diagnostic-only.
- Checkpoint 0 uses only the explicitly authorized narrow provenance waiver, records all substitute-anchor hashes, and does not waive any research/performance gate.
- Candidate registration hash frozen; no rule/threshold drift.
- Fresh logged exact `g2rVariantReplay.js` C0 rerun parity + canonical identity 211/211; prior incompletely logged run remains `INVALID_REPLAY`.
- Full event-level funnel with required stages, keys, provenance and reconciliation.
- G6-C1 shadow population frozen before outcome labels.
- DQ-C 1h/3h MFE/MAE/R-before-SL computed correctly.
- Cheap screen uses only frozen ledger/labels and predates any new Central.
- Candidate Central entry point fail closed bằng required artifact/schema/decision/identity/hash/timestamp/integrity guard; mọi rejection không chạy replay và không tạo/overwrite output.
- PF/expectancy are not used as MFE/R-before-SL proxies.
- If screen fail: Central NOT_RUN and `NO_CANDIDATE`.
- If screen pass: exactly one new Central after PASS; premature Central not reused.
- Candidate fail cleanup complete.
- Tool retention gate satisfied or tool deleted.
- Typecheck/build/build:scripts/tests/diff-check PASS.
- No commit/push/merge/deploy.

## Final decision block bắt buộc

```text
G6R FINAL DECISION
Decision: ADOPT_CANDIDATE | SHADOW_ONLY | NO_CANDIDATE | BLOCKED_BY_DATA | INVALID_REPLAY | CORRECTION_REQUIRED
Code/commit: working tree / <base commit>
Production behavior modified: YES | NO

G6 previous formal decision: INVALID_REPLAY
Premature G6 Central: DQ-C_DIAGNOSTIC_ONLY
Candidate: G6-C1 CASCADE_FALLTHROUGH_ON_MSS_FAIL (registration hash=<hash>, rule drift=0)
Checkpoint 0 provenance: PASS_WITH_AUTHORIZED_PROVENANCE_WAIVER (scope=<exact scope>; substitute anchors=<hashes>)

Exact C0 command: PASS/FAIL
C0 execution logging: PASS/FAIL (raw status hash=<hash>; UTC start/end=<times>; exit=<code>)
C0 metrics parity: PASS/FAIL + metrics
Canonical identity: matched=<n>/211; duplicates=<fresh>/<canonical>; unmatched=<fresh>/<canonical>
Run manifest/provenance: PASS/FAIL

Full funnel: PASS/FAIL
Evaluation rows/unique/duplicates: <n>/<n>/<n>
Candidate rows/unique/duplicates: <n>/<n>/<n>
Missing joins/unterminated evaluations: <n>/<n>
Production admitted identity: <matched>/211

Frozen G6-C1 shadow population: <n> events; ledger hash=<hash>
Valid geometry/path coverage: <pct>/<pct>
1h MFE_R p25/median/p75: <values>
3h MFE_R p25/median/p75: <values>
1R/2R/3R-before-SL rates: <values>
SL-before-1R rate: <value>
Leakage audit: PASS/FAIL

Cheap screen: PASS/FAIL (artifact timestamp=<time>, ledger hash match=YES/NO)
Central authorization guard: PASS/FAIL/NOT_RUN; rejected attempts=<n>; replay/output before authorization=0/0
New candidate Central: NOT_RUN_SCREEN_FAIL | RUN_AFTER_SCREEN_PASS | INVALID_ORDER
Candidate Central/attribution: <metrics | NOT_RUN>
Cross-cost/holdout: <result | NOT_RUN>

g6OpportunityFunnel tooling: DELETED | RETAINED_WITH_FULL_VALIDATION
Failed-candidate executable refs: 0
Rejected T159/G5/G5R refs: 0
Orphan generated outputs: 0
Typecheck/build/build:scripts/tests/diff-check: PASS/FAIL
Production baseline: NOT_RERUN_NOT_REQUIRED | PASS | FAIL

Known limitations: <value>
Commit/push/merge/deploy performed: NO
Next action: <specific action authorized by decision>
Evidence paths: data/g6r-run-manifest.json, data/g6r-full-funnel-events.csv, data/g6r-shadow-events.csv, data/g6r-outcome-labels.csv, data/g6r-cheap-screen.csv, data/g6r-central-attribution.csv (if created), data/g6r-final-summary.md
```
