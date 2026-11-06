import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, appendFile, cp } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { bindSource, sourceStatus, reviewSource } from '../skills/qmd-prover/src/core/workbench/bindings.js';
import { resolveSpan } from '../skills/qmd-prover/src/core/workbench/tex.js';
import { inspectProject } from '../skills/qmd-prover/src/commands/inspect/index.js';
import { readAttempt } from '../skills/qmd-prover/src/core/workbench/attempts.js';
import { options, verifier } from './support.js';
import { workbenchProject, fakeCodex, alignment, sessionId } from './workbench-support.js';
import type { JsonObject } from '../skills/qmd-prover/src/core/shared/types.js';

async function fixture(t: test.TestContext, extra = '') {
  const { root } = await workbenchProject(t);
  const paper = path.join(root, 'paper');
  await mkdir(paper);
  const source = '\uFEFF% 中文 source; a comment \\label{ignored}\r\n' + extra + String.raw`
\begin{theorem}\label{thm:test}
A test claim, with $\alpha\in\mathbb{R}$.
\end{theorem}
\begin{proof}\label{proof:test}
A test argument.
\end{proof}
`.replace(/\n/g, '\r\n');
  const file = path.join(paper, 'main.tex');
  await writeFile(file, source, 'utf8');
  const manifest = path.join(root, 'binding.json');
  await writeFile(manifest, JSON.stringify({ schema_version: 1, source_root: paper,
    statement: { file: 'main.tex', label: 'thm:test' }, proof_spans: [{ file: 'main.tex', label: 'proof:test' }] }));
  return { root, paper, file, manifest };
}

async function attest(root: string, binding: JsonObject, report: JsonObject = alignment) {
  const file = path.join(root, 'human-evidence.json');
  await writeFile(file, JSON.stringify({ schema_version: 1, binding_id: binding.binding_id, alignment_input_hash: binding.alignment_input_hash, reviewer: 'Synthetic human reviewer', ...report }));
  return file;
}

test('UTF-8 label spans preserve BOM/Chinese/CRLF byte offsets and reject ambiguity or split characters', async (t) => {
  const f = await fixture(t);
  const span = await resolveSpan(f.paper, { file: 'main.tex', label: 'thm:test' });
  const bytes = await readFile(f.file);
  assert.equal(bytes.subarray(span.start_byte, span.end_byte).toString('utf8'), span.text);
  assert.match(span.text, /^\\begin\{theorem\}/);
  assert.equal(span.start_line, 3);
  await assert.rejects(resolveSpan(f.paper, { file: 'main.tex', label: 'ignored' }), /Missing label/);
  await assert.rejects(resolveSpan(f.paper, { file: 'main.tex', start_byte: 1, end_byte: 6 }), /UTF-8/);
  await appendFile(f.file, '\\begin{lemma}\\label{thm:test}Duplicate.\\end{lemma}');
  await assert.rejects(resolveSpan(f.paper, { file: 'main.tex', label: 'thm:test' }), /Ambiguous/);
});

test('binding starts needs-review; attestation aligns; TeX edits stale the binding without touching mathematical results', async (t) => {
  const f = await fixture(t);
  process.env.QMD_PROVER_VERIFIER = verifier;
  const math = await inspectProject(f.root, options);
  assert.equal(math.verification.global_verified, 1);
  const graphFile = path.join(f.root, '.qmd-prover', 'graph.json');
  const graph = await readFile(graphFile, 'utf8');
  const qmd = await readFile(path.join(f.root, 'work.qmd'), 'utf8');
  const binding = await bindSource(f.root, '@lem-trace', f.manifest, options);
  assert.equal(binding.binding_status, 'needs-review');
  const saved = await reviewSource(f.root, String(binding.binding_id), { evidence: await attest(f.root, binding) }, options);
  assert.equal(saved.binding_status, 'aligned');
  const current = (await sourceStatus(f.root, '@lem-trace', options)).bindings as JsonObject[];
  assert.equal(current[0].binding_status, 'aligned');
  await appendFile(f.file, '\r\n% unrelated source change\r\n');
  const stale = (await sourceStatus(f.root, undefined, options)).bindings as JsonObject[];
  assert.equal(stale[0].binding_status, 'stale');
  assert.equal(await readFile(graphFile, 'utf8'), graph);
  assert.equal(await readFile(path.join(f.root, 'work.qmd'), 'utf8'), qmd);
  const reused = await inspectProject(f.root, options);
  assert.equal(reused.verification.cache_hits, 1);
  assert.equal(reused.verification.verifier_calls, 0);
  assert.equal(reused.verification.global_verified, 1);
  const refreshed = await reviewSource(f.root, String(binding.binding_id), { evidence: await attest(f.root, stale[0]) }, options);
  assert.equal(refreshed.binding_status, 'aligned');
});

test('changing the mathematical model does not change alignment input; changing QMD proof does', async (t) => {
  const f = await fixture(t);
  const binding = await bindSource(f.root, 'lem-trace', f.manifest, options);
  await writeFile(path.join(f.root, '.qmd-prover', 'config.yml'), 'verification:\n  backend: codex\n  model: deliberately-not-called\n  effort: max\n');
  const same = (await sourceStatus(f.root, undefined, options)).bindings as JsonObject[];
  assert.equal(same[0].alignment_input_hash, binding.alignment_input_hash);
  await appendFile(path.join(f.root, 'work.qmd'), '\n');
  const file = path.join(f.root, 'work.qmd');
  await writeFile(file, (await readFile(file, 'utf8')).replace('A test argument.', 'A changed test argument.'));
  const changed = (await sourceStatus(f.root, undefined, options)).bindings as JsonObject[];
  assert.equal(changed[0].binding_status, 'stale');
});

test('context files and include resolutions are fingerprinted; unresolved external context cannot align', async (t) => {
  const f = await fixture(t, '\\input{defs}\r\n\\usepackage{example}\r\n');
  await writeFile(path.join(f.paper, 'defs.tex'), '\\newcommand{\\test}{one}');
  const unavailable = await bindSource(f.root, 'lem-trace', f.manifest, options);
  assert.equal(unavailable.binding_status, 'unavailable');
  await writeFile(path.join(f.paper, 'external.sty'), '% explicit context copy');
  const manifest = JSON.parse(await readFile(f.manifest, 'utf8'));
  manifest.context_resolutions = { 'usepackage:example': 'external.sty' };
  await writeFile(f.manifest, JSON.stringify(manifest));
  const bound = await bindSource(f.root, 'lem-trace', f.manifest, options);
  assert.equal(bound.binding_status, 'needs-review');
  await appendFile(path.join(f.paper, 'defs.tex'), '\n% changed');
  const statuses = (await sourceStatus(f.root, undefined, options)).bindings as JsonObject[];
  assert.equal(statuses.find((item) => item.binding_id === bound.binding_id)?.binding_status, 'stale');
});

test('unsupported nested include syntax is unavailable rather than silently omitted', async (t) => {
  const f = await fixture(t, '\\input{\\chapter{one}}\r\n');
  const bound = await bindSource(f.root, 'lem-trace', f.manifest, options);
  assert.equal(bound.binding_status, 'unavailable');
  assert.match(JSON.stringify(bound.unresolved), /unparsed include/);
});

test('partial/mismatched evidence cannot align, wrong fingerprints are refused, and outside-root paths are rejected', async (t) => {
  const f = await fixture(t);
  const binding = await bindSource(f.root, 'lem-trace', f.manifest, options);
  const partial = await reviewSource(f.root, String(binding.binding_id), { evidence: await attest(f.root, binding, { ...alignment, proof_coverage: 'partial', issues: ['An additional hypothesis was introduced.'] }) }, options);
  assert.equal(partial.binding_status, 'mismatch');
  const contradictory = await attest(f.root, binding, { ...alignment, issues: ['An extra hypothesis is not in the paper.'] });
  await assert.rejects(reviewSource(f.root, String(binding.binding_id), { evidence: contradictory }, options), /unresolved issues/);
  const wrong = await attest(f.root, { ...binding, alignment_input_hash: 'sha256:wrong' });
  await assert.rejects(reviewSource(f.root, String(binding.binding_id), { evidence: wrong }, options), /current binding/);
  await writeFile(path.join(f.root, 'outside.tex'), 'private');
  await assert.rejects(resolveSpan(f.paper, { file: '../outside.tex', start_byte: 0, end_byte: 2 }), /escapes/);
  await assert.rejects(resolveSpan(f.paper, { file: '../auth.json', start_byte: 0, end_byte: 2 }), /TeX source/);
});

test('explicit AI alignment review uses a separate attempt and never creates mathematical verification records', async (t) => {
  const f = await fixture(t);
  const binding = await bindSource(f.root, 'lem-trace', f.manifest, options);
  const reviewed = await reviewSource(f.root, String(binding.binding_id), { backend: 'codex', model: 'mock-only', executable: await fakeCodex(f.root, { alignment: true }) }, options);
  assert.equal(reviewed.binding_status, 'aligned');
  const attempt = await readAttempt(f.root, String((reviewed.reviewer as JsonObject).attempt_id));
  assert.equal(attempt.execution.kind, 'alignment');
  assert.equal(attempt.execution.session_id, sessionId);
  await assert.rejects(readFile(path.join(f.root, '.qmd-prover', 'graph.json')), /ENOENT/);
  const statuses = (await sourceStatus(f.root, undefined, options)).bindings as JsonObject[];
  assert.equal(statuses[0].binding_status, 'aligned');
});

test('AI quota failure and mid-review source drift preserve evidence without declaring alignment', async (t) => {
  const f = await fixture(t);
  const binding = await bindSource(f.root, 'lem-trace', f.manifest, options);
  const failed = await reviewSource(f.root, String(binding.binding_id), { backend: 'codex', model: 'mock-only', executable: await fakeCodex(f.root, { failure: true }) }, options);
  assert.equal(failed.ok, false);
  assert.equal(failed.binding_status, 'needs-review');
  const drift = await reviewSource(f.root, String(binding.binding_id), { backend: 'codex', model: 'mock-only', executable: await fakeCodex(f.root, { alignment: true, mutate: f.file }) }, options);
  assert.equal(drift.ok, false);
  assert.equal(drift.binding_status, 'stale');
  assert.match(String(drift.execution_error), /changed during/);
});

test('alignment receipt edits are detected and status inspection leaves the binding registry untouched', async (t) => {
  const f = await fixture(t);
  const binding = await bindSource(f.root, 'lem-trace', f.manifest, options);
  const saved = await reviewSource(f.root, String(binding.binding_id), { evidence: await attest(f.root, binding) }, options);
  const registry = path.join(f.root, '.qmd-prover', 'source-bindings.json');
  const before = await readFile(registry, 'utf8');
  await sourceStatus(f.root, undefined, options);
  assert.equal(await readFile(registry, 'utf8'), before);
  const receipt = path.join(f.root, '.qmd-prover', 'workbench', 'v1', 'alignment', String(binding.binding_id), `${saved.review_id}.json`);
  const contents = JSON.parse(await readFile(receipt, 'utf8'));
  contents.report.explanation = 'edited';
  await writeFile(receipt, JSON.stringify(contents));
  const status = (await sourceStatus(f.root, undefined, options)).bindings as JsonObject[];
  assert.equal(status[0].binding_status, 'unavailable');
});

test('moving a project and its source together preserves content-bound alignment', async (t) => {
  const f = await fixture(t);
  const binding = await bindSource(f.root, 'lem-trace', f.manifest, options);
  await reviewSource(f.root, String(binding.binding_id), { evidence: await attest(f.root, binding) }, options);
  const registry = JSON.parse(await readFile(path.join(f.root, '.qmd-prover', 'source-bindings.json'), 'utf8'));
  assert.equal(registry.bindings[0].spec.source_root, 'paper');
  const moved = `${f.root}-relocated`;
  await cp(f.root, moved, { recursive: true, errorOnExist: true, force: false });
  const rows = (await sourceStatus(moved, undefined, options)).bindings as JsonObject[];
  assert.equal(rows[0].binding_status, 'aligned');
  assert.equal(rows[0].alignment_input_hash, binding.alignment_input_hash);
});
