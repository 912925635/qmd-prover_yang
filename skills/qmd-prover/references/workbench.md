# Session provenance and TeX source binding

The P0 workbench adds execution provenance and manuscript alignment to the existing
mathematical verifier. Run these commands from the mathematical project, not the engine checkout.

## Sessions

New verifier invocations retain immutable attempts under
`.qmd-prover/workbench/v1/attempts/<UUID>/`. Codex uses JSONL events and a stdin prompt.
Records contain the packet, requested model/effort, reported usage, session ID, execution
state and artifact hashes. Unreported model resolution, CLI version or usage stays unknown.

```powershell
qmd-prover workbench sessions list --fact @lem-example
qmd-prover workbench sessions show ATTEMPT_ID
qmd-prover workbench sessions show ATTEMPT_ID --source rollout
qmd-prover workbench sessions resume ATTEMPT_ID
```

These commands invoke no model. `show` defaults to self-retained execution events, not a
complete native conversation. `--source rollout` reads the matching native session under
the original host's selected CODEX_HOME/sessions and checks its session metadata.
Missing, ambiguous or unsupported records fail explicitly. No authentication file is read.

`resume` prints a launch descriptor. Add `--launch` explicitly to open a read-only Codex
discussion; it may incur model usage but cannot import discussion answers into mathematical
caches. The original host, CODEX_HOME and working directory must be available.
Ordinary inspection still prefers valid caches: a hit creates no attempt or session.
Old records remain legacy/unavailable; missing IDs are not invented.

Windows supports native executables and Node entrypoints. Standard global npm Codex
wrappers are resolved to the adjacent Node launcher without shell evaluation. Other
installations can set verification.executable to their actual .exe, .js or .mjs entrypoint.

## Bind a manuscript

Create a manifest. source_root is relative to the manifest file; all source paths are
relative to that authorized root. coverage_map is optional and defaults to the target fact.

```json
{
  "schema_version": 1,
  "source_root": "./paper",
  "statement": { "file": "main.tex", "label": "thm:example" },
  "proof_spans": [{ "file": "main.tex", "label": "proof:example" }],
  "context_files": ["definitions.tex"],
  "context_resolutions": {},
  "coverage_map": [{ "source_index": 0, "qmd_ids": ["lem-example"] }]
}
```

```powershell
qmd-prover workbench sources bind @lem-example --manifest binding.json
qmd-prover workbench sources status @lem-example
```

The first command returns a binding ID and alignment_input_hash. A binding is not an
alignment conclusion. Status performs read-only compilation and never invokes a verifier.
Selectors may instead use start_byte/end_byte: a half-open range in original UTF-8 bytes,
including the BOM. Line numbers are one-based. Invalid UTF-8 boundaries, ambiguous labels
and unbalanced environments are rejected. Comments and common verbatim regions are masked;
the scanner does not execute TeX or expand arbitrary macros.

Literal input/include files and project-local packages/classes are fingerprinted. Unresolved
context makes the binding unavailable. Add explicit context_resolutions entries such as
`"usepackage:local-math": "vendor/local-math.sty"`,
`"documentclass:paper-class": "vendor/paper-class.cls"`, or
`"input:\\chapterfile": "chapters/lemma.tex"`. Mapped files must be inside source_root.
System packages are not fetched or silently declared resolved. Unsupported macro-generated
labels require explicit byte spans. Source/context files must be UTF-8 TeX files.

Bindings are authored inputs in .qmd-prover/source-bindings.json. New project scaffolds
whitelist this file. Existing custom gitignore files and AGENTS contracts are preserved;
track the binding registry explicitly in existing projects when desired.
The stored source root is relative to the QMD project when the filesystem permits it,
so moving the QMD project together with its paper preserves bindings. A source on a
different Windows drive keeps an absolute path; update that authored root explicitly
when moving to another host. The source-root location is not part of alignment's content hash.

## Record alignment evidence

Use the current hash from sources status in a human attestation:

```json
{
  "schema_version": 1,
  "binding_id": "REPLACE_WITH_BINDING_UUID",
  "alignment_input_hash": "sha256:REPLACE_WITH_CURRENT_HASH",
  "reviewer": "Reviewer name",
  "statement_alignment": "consistent",
  "proof_coverage": "complete",
  "explanation": "Describe the assumptions, quantifiers, definitions and proof mapping checked.",
  "issues": []
}
```

```powershell
qmd-prover workbench sources review BINDING_ID --evidence alignment.json
```

This is a user-supplied attestation, not a formal proof. Statement status accepts
consistent/mismatch/inconclusive; coverage accepts complete/partial/mismatch/inconclusive.
Partial coverage never becomes aligned. Receipt hashes and frozen inputs are retained.
An assertion of complete alignment cannot simultaneously retain unresolved issues.

An explicit AI alignment audit is separate from mathematical verification:

```powershell
qmd-prover workbench sources review BINDING_ID --backend codex --model MODEL --effort high
```

Optional --executable PATH selects a Codex entrypoint. This command invokes the selected
model to compare the source and QMD corpus, saves an alignment attempt and receipt, and
never grants mathematical verified/rejected status. Failure or source drift cannot produce
aligned. Automated tests use fake CLIs, not live-model accuracy measurements.

After source edits, get the new hash and provide new evidence or explicitly run another
audit. Successful review updates the baseline and retains previous receipts. Changing only
the mathematical model or effort does not change the alignment hash.

| Binding state | Meaning |
| --- | --- |
| unbound | No matching binding exists |
| needs-review | Resolved input lacks complete applicable evidence |
| aligned | Current input has consistent statement and complete coverage evidence |
| mismatch | Applicable evidence reports mismatch or partial coverage |
| stale | Source or QMD input changed after the stored baseline |
| unavailable | Required source, context or evidence cannot be validated |

Raw file changes, including outside the bound span or line-ending changes, make the old
evidence stale. Manuscript states do not clear mathematical caches.

## Plan and run local checks

Planning reads the current project and constructs the exact local conditional packets. It
does not call a verifier. Save a plan explicitly before running it:

```powershell
qmd-prover workbench jobs plan project --save review-plan.json
qmd-prover workbench jobs plan fact @lem-example --save review-plan.json
qmd-prover workbench jobs run review-plan.json --jobs 2
qmd-prover workbench jobs status RUN_ID
```

`--jobs` defaults to 1 and accepts at most 3. `run` checks the saved source signature,
checker contract, selected closure and every frozen packet before dispatch. It stops if
these no longer match. Direct dependency statements are conditional inputs even when an
upstream proof is unverified or rejected; dependency proofs and verification status are
not sent. The published graph still uses the ordinary deterministic global composition.
Background jobs do not write `status` attributes into QMD. Synchronous `inspect` keeps
its existing display projection and reports skipped writes in `projection_issues` when
source bytes changed or the projection write failed. Such a failure does not reverse a
published mathematical snapshot.

A valid cache makes a normal run invoke no model. For a fresh independent attempt on
the same mathematical input, explicitly request:

```powershell
qmd-prover workbench jobs run review-plan.json --recheck
```

This preserves the old attempt and mathematical key. If the fresh call fails, an
applicable cached mathematical decision remains visible with its prior source, while
the new execution failure is reported separately.

An active local run can be paused, resumed or cancelled from another terminal:

```powershell
qmd-prover workbench jobs pause RUN_ID
qmd-prover workbench jobs resume RUN_ID
qmd-prover workbench jobs cancel RUN_ID
qmd-prover workbench watch RUN_ID
```

Pause prevents new dispatch and lets active calls finish. Cancel waits for process
cleanup and returns a cleanup acknowledgement; killing the local process cannot prove
remote billing stopped. `watch` streams read-only JSON lines only when state changes.
After a controller crash, status reports `orphaned`. On the original host, first check
that the old process is gone, then recover its owner and resume the run:

```powershell
qmd-prover workbench jobs recover --reason "controller crashed"
qmd-prover workbench jobs resume RUN_ID
```

Resume rechecks the frozen plan, source, owner record and published generation. It
reuses a completed sealed attempt only when its hashes, exact packet, key and report
validate; queued tasks may then run. A dispatched task without a unique valid seal
is never automatically resent. Resolve its outcome before explicitly requesting:

```powershell
qmd-prover workbench jobs retry TASK_ID
```

Retry is an explicit new attempt against a newly prepared current plan. Recovery refuses
a live or foreign host owner. The owner protocol is for one host and a local filesystem;
it does not provide a distributed lock across network mounts.

## History and usage

```powershell
qmd-prover workbench history fact @lem-example
qmd-prover workbench history compare ATTEMPT_A ATTEMPT_B
qmd-prover workbench costs RUN_ID
qmd-prover workbench costs RUN_ID --rates rates.json
```

History and comparison are read-only. Comparison names input and contract differences;
an opinion absent from a later report is not automatically resolved. Old cache records
without session provenance remain legacy records. Costs show a sum of reported token
fields and the number of attempts with unknown usage. Cache reuse adds no new call.
Amount estimates require a user supplied rate table with an explicit source, date,
currency and per-model rates. For example:

```json
{
  "source": "User supplied pricing record",
  "as_of": "2026-11-14",
  "currency": "USD",
  "models": {
    "model-id": {
      "input_per_million": 1,
      "cached_input_per_million": 0.5,
      "output_per_million": 2
    }
  }
}
```

These numbers are an illustrative file format, not current prices. An attempt with an
unpriced model or missing usage leaves the estimate incomplete.

## Read-only report

```powershell
qmd-prover workbench render
```

This writes .qmd-prover/generated/workbench.html and execution detail pages. The existing
render command also links to the workbench. The static view shows task execution, commit,
math and manuscript states separately. Mathematical status comes from a current
published snapshot. Native-session viewing and discussion commands are separate terminal
actions. Static HTML does not launch apps, run models or control jobs.
