# Experimental shadow proof review: phase 1

This fork of [powergiant/qmd-prover](https://github.com/powergiant/qmd-prover)
adds checkout-only tooling to prepare proof obligations and independently audit
their faithfulness. It retains the upstream MIT license and proof engine.

The first increment implements **decomposition and faithfulness only**. It does
not perform focused mathematical verification, counterexample search, automated
repair, or formal checking. Every report has mathematical `outcome: inconclusive`,
even when preparation succeeds. No official verdict, QMD source, verification
cache, graph snapshot, or dispatcher contract is changed.

## Run from a checkout

Requirements: Node >=20, `npm ci`, and an existing schema-v8 local verification
record with a protocol-v6 **proof-mode** packet. Definitions and refutations are
intentionally unsupported in this increment. To obtain records use the existing
qmd-prover verification workflow, then select a JSON file under your project's
`.qmd-prover/verification/checks/`. A packet without its original record is not
accepted. No additional QMD parser is introduced.

Configure two stateless JSON-over-stdio commands in a policy file, then run:

```sh
node --import tsx tooling/proof-review/cli.ts \
  --record /absolute/project/.qmd-prover/verification/checks/KEY.json \
  --policy /absolute/policy.json
```

There is no default model and no automatic paid call during tests. Both role
commands must be explicitly configured. A policy looks like this; replace every
example path and model ID with your own installation and selected model:

```json
{
  "schema_version": 1,
  "max_obligations": 40,
  "timeout_ms": 60000,
  "max_output_bytes": 1000000,
  "roles": {
    "decomposer": {
      "command": ["/absolute/node", "--import", "file:///checkout/node_modules/tsx/dist/loader.mjs", "/checkout/tooling/proof-review/codex-adapter.ts", "--executable", "/absolute/codex", "--effort", "high"],
      "model": "YOUR_EXPLICIT_MODEL_ID",
      "implementation_version": "codex-transport-v1-with-your-config-version",
      "implementation_files": ["/checkout/tooling/proof-review/codex-adapter.ts", "/absolute/codex"]
    },
    "fidelity": {
      "command": ["/absolute/node", "--import", "file:///checkout/node_modules/tsx/dist/loader.mjs", "/checkout/tooling/proof-review/codex-adapter.ts", "--executable", "/absolute/codex", "--effort", "high"],
      "model": "YOUR_EXPLICIT_MODEL_ID",
      "implementation_version": "codex-transport-v1-with-your-config-version",
      "implementation_files": ["/checkout/tooling/proof-review/codex-adapter.ts", "/absolute/codex"]
    }
  }
}
```

The optional Codex transport follows the shipped verifier's `codex exec`,
explicit model/effort, `--sandbox read-only`, and `--skip-git-repo-check` flags.
It starts a new non-resumed call per role. The CLI must be installed and
authenticated. This transport is tested with a fake CLI; compatibility with your
installed CLI and live model responses must be checked separately. On Windows,
use absolute paths with forward slashes, e.g. `C:/.../node.exe`, and a
`file:///C:/.../loader.mjs` URL for the `--import` argument.

You can replace this transport with any trusted stateless adapter. It receives
one `ReviewRequest` JSON object on stdin and must emit exactly one envelope:

```json
{"result": {"...": "role-specific object"}, "usage": {"total_tokens": 123}}
```

`usage` is optional and adapter-reported. No absent value is counted as zero.
The request contains role-specific instructions and `output_schema` descriptions
(these are descriptions, not JSON Schema). `types.ts` and the validating readers
define the actual schema. `QMD_PROOF_REVIEW_MODEL` carries the configured model;
`QMD_PROOF_REVIEW_FRESH_CONTEXT=1` requires stateless handling. Implementations
must honor these settings. No shell is used. Relative command arguments are
resolved in a fresh temporary directory, so use absolute adapter paths.

## Gates and reporting

1. Verify record schema, packet hash, official verification key, target identity,
   and exact dependency scope. Original verdicts are withheld. Only dependency
   statements and definitions are forwarded, even if extra fields exist.
2. Run one decomposition call. Every obligation has a proof span, anchored
   premises/conclusion, a description of the submitted inference, and references
   to earlier obligations. All non-whitespace proof text must be covered in
   order, without overlaps. The target statement is copied exactly.
3. Validate exact anchors against the packet. Coordinates are zero-based
   JavaScript UTF-16 string offsets `[start,end)`, **not QMD line numbers or byte
   offsets**. Model counting mistakes block preparation; they are not repaired
   by guessing a different source fragment.
4. Run a separate fidelity call with the entire statement-only context and the
   proposed decomposition. A pass needs explicit coverage of every obligation,
   an unchanged target, and zero sourced semantic mismatches. Textual anchoring
   cannot establish semantic equivalence by itself.
5. Recheck record bytes, policy, and implementation fingerprints for drift. Save
   JSON and Markdown together by an atomic directory rename in
   `.qmd-prover/proof-review/<packet-policy-key>-<run>/`. Each run is retained;
   prior results are never automatically reused.

Preparation stage states:

| Stage status | Meaning |
| --- | --- |
| `ready_for_proof_review` | Structural checks and the AI fidelity gate passed. Mathematical review remains to be done. |
| `blocked` | Structural decomposition error or an explicit fidelity rejection. This does not assert a mathematical error in the original proof. |
| `inconclusive` | Failed/invalid model response, uncertain fidelity, or input/policy drift. |

CLI exit codes: `0` preparation ready; `2` a report was saved but preparation is
blocked or inconclusive; `1` invalid input/configuration or an I/O failure. Exit
code `0` never means mathematical acceptance. `coverage.checked` remains zero;
all obligations remain uncovered for mathematical verification.

The report concerns **only the recorded historical packet**. Packet hashes check
record consistency, not authenticity or freshness against current QMD files.
Compiler identities are carried verbatim, not recomputed from raw text (the
compiler hashes semantic ASTs). Current-source compilation and matching remain
future work. `current_source_checked: false` records this limitation explicitly.

## Bounds, isolation, and provenance

At most two sequential role calls; no retries. Invalid decomposition stops
before the fidelity call. A per-call deadline and combined stdout/stderr byte
limit stop failed transports. On POSIX the runner kills the process group. On
Windows the runner kills the direct adapter; a custom adapter must also arrange
termination of any descendants it creates.

A separate process and empty temporary cwd help prevent accidental context
reuse, but do not enforce an OS sandbox or independent mathematical judgments.
Adapters inherit environment credentials for authentication and must be trusted.
Configure them to deny project reads, web search, code execution, and session
resumption. A CLI's read-only filesystem mode alone does not enforce all these
restrictions. No model statement about executed tools is accepted as execution
evidence in this phase.

The report retains the policy, responses, request hashes, call counts, timing,
and any reported token totals. Its policy hash includes normalized configuration,
models, explicit routing versions, command argv, declared implementation file
contents, executable contents, and the local review modules/prompts/schemas.
Declare all adapter/config files that affect behavior; update
`implementation_version` for remote routing/config changes not visible in those
files. Hosted model aliases may still change behind an unchanged name.

## Validation and remaining work

```sh
npm test
npm run typecheck
git diff --check
```

Behavior tests cover provenance, statement-only inputs, source spans, omitted
steps, quantifier drift, introduced premises, invalid fidelity passes, failed
processes, input/implementation drift, and unchanged canonical project files.
Mocks deliberately represent an unsupported proof faithfully, demonstrating
that a fidelity pass does not certify its mathematics.

These tests exercise orchestration and gates; they do not measure model error
detection or prove that an AI fidelity reviewer catches semantic drift. No
live-model accuracy, token-saving, or comparative reliability claim is made.
Next: collect independently labeled mathematical cases, add focused verification
with replayable evidence, and compare original vs decomposed reviews at matched
model budgets before considering integration with official verdicts.

This implementation is independently written. The research motivation includes
[Pseudo-Formalization](https://github.com/Slim205/pseudo-formalization); no code
from that project is incorporated.
