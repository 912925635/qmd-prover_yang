import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { cp } from 'node:fs/promises';
import { buildVerifierPacket, verificationKey } from '../skills/qmd-prover/src/core/verification/protocol.js';
import { sha256, stableJson } from '../skills/qmd-prover/src/core/infrastructure/files.js';
import { SCHEMA_VERSION } from '../skills/qmd-prover/src/core/shared/core.js';
import { readRecordedPacket } from '../tooling/proof-review/packet.js';
import { readDecomposition } from '../tooling/proof-review/decomposition.js';
import { readFidelity } from '../tooling/proof-review/faithfulness.js';
import { loadPolicy } from '../tooling/proof-review/policy.js';
import { reviewRecord } from '../tooling/proof-review/review.js';
import { markdownReport, saveReport } from '../tooling/proof-review/report.js';
import type { Decomposition, ReviewPolicy } from '../tooling/proof-review/types.js';
import { inspectProject } from '../skills/qmd-prover/src/commands/inspect/index.js';
import { options, project, result, verifier } from './support.js';

const statement = 'There exists a minimizer of f.';
const proof = 'Choose x in the domain.\nThus x minimizes f.';
function anchor(source: string, content: string, start = 0, end = content.length) {
  return { source, start, end };
}
function proposal(): Decomposition {
  const split = proof.indexOf('\n');
  return {
    target_statement: anchor('target.statement', statement), final_obligation_id: 'lem-test#step-2',
    obligations: [
      { id: 'lem-test#step-1', kind: 'inference', source_span: anchor('target.proof', proof, 0, split), premises: [],
        conclusion: anchor('target.proof', proof, 0, split), inference: 'The author chooses an element.', internal_dependencies: [] },
      { id: 'lem-test#step-2', kind: 'inference', source_span: anchor('target.proof', proof, split + 1), premises: [anchor('target.proof', proof, 0, split)],
        conclusion: anchor('target.statement', statement), inference: 'The author asserts optimality without further justification.', internal_dependencies: ['lem-test#step-1'] }
    ]
  };
}
function faithful() {
  return { status: 'pass', checked_obligation_ids: ['lem-test#step-1', 'lem-test#step-2'], target_preserved: true,
    issues: [], explanation: 'The proposed representation retains the unsupported optimality assertion.' };
}

async function fixture(t: test.TestContext, adapterBody?: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'proof-review-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checks = path.join(root, '.qmd-prover', 'verification', 'checks');
  await mkdir(checks, { recursive: true });
  const packet = buildVerifierPacket({ target: {
    id: 'lem-test', kind: 'lemma', statement, proof, source: { file: 'proof.qmd' },
    identity: { statement_hash: sha256('original AST statement'), proof_hash: sha256('original AST proof') }
  }, dependencies: [{ id: 'def-f', kind: 'definition', statement: 'f is real-valued.',
    proof: 'UPSTREAM SECRET PROOF', status: 'verified' }],
  scope: { type: 'local-conditional-check', direct_dependency_ids: ['def-f'] } });
  const record = {
    schema_version: SCHEMA_VERSION, operation: 'local-conditional-verification', target: 'lem-test',
    statement_hash: packet.target.identity.statement_hash, proof_hash: packet.target.identity.proof_hash,
    checker_contract: packet.checker_contract, verification_key: verificationKey(packet),
    packet_hash: sha256(stableJson(packet, 0)), packet,
    report: { summary: 'ORIGINAL VERDICT SECRET', verdict: 'correct' }
  };
  const recordFile = path.join(checks, 'record.json');
  await writeFile(recordFile, stableJson(record));
  await writeFile(path.join(root, 'proof.qmd'), 'SOURCE MUST NOT CHANGE');
  await mkdir(path.join(root, '.qmd-prover', 'graphs'));
  await writeFile(path.join(root, '.qmd-prover', 'graphs', 'latest.json'), 'CANONICAL SNAPSHOT');
  const adapter = path.join(root, 'adapter.mjs');
  await writeFile(adapter, `import fs from 'node:fs/promises';
let raw=''; for await (const chunk of process.stdin) raw+=chunk;
const request=JSON.parse(raw);
if (raw.includes('UPSTREAM SECRET PROOF') || raw.includes('ORIGINAL VERDICT SECRET') || raw.includes('"status":"verified"')) throw new Error('Isolation breach');
${adapterBody ?? `const result = request.role === 'decomposer' ? ${JSON.stringify(proposal())} : ${JSON.stringify(faithful())};
process.stdout.write(JSON.stringify({result,usage:{total_tokens:123}}));`}
`);
  const role = { command: [process.execPath, adapter], model: 'mock-only', implementation_version: 'test-v1', implementation_files: ['./adapter.mjs'] };
  const policy: ReviewPolicy = {
    schema_version: 1, max_obligations: 20, timeout_ms: 2000, max_output_bytes: 100_000,
    roles: { decomposer: role, fidelity: role }
  };
  const policyFile = path.join(root, 'policy.json');
  await writeFile(policyFile, stableJson(policy));
  return { root, recordFile, policyFile, policy, adapter, record };
}

test('shadow review with faithful decomposition never certifies the proof or changes canonical files', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.recordFile, 'utf8');
  const report = await reviewRecord(f.recordFile, f.policyFile);
  assert.equal(report.stage_status, 'ready_for_proof_review');
  assert.equal(report.outcome, 'inconclusive');
  assert.equal(report.current_source_checked, false);
  assert.equal(report.coverage.checked, 0);
  assert.deepEqual(report.coverage.uncovered, ['lem-test#step-1', 'lem-test#step-2']);
  assert.equal(report.metrics.calls, 2);
  assert.equal(report.metrics.reported_total_tokens, 246);
  const directory = await saveReport(f.root, report);
  assert.deepEqual((await readdir(directory)).sort(), ['report.json', 'report.md']);
  assert.equal(await readFile(f.recordFile, 'utf8'), before);
  assert.equal(await readFile(path.join(f.root, 'proof.qmd'), 'utf8'), 'SOURCE MUST NOT CHANGE');
  assert.equal(await readFile(path.join(f.root, '.qmd-prover/graphs/latest.json'), 'utf8'), 'CANONICAL SNAPSHOT');
  assert.equal((await readdir(path.dirname(f.recordFile))).length, 1);
  assert.notEqual(await saveReport(f.root, report), directory);
});

test('shadow tooling consumes an actual unchanged engine record, including unrestricted null external basis', async (t) => {
  const f = await fixture(t);
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'proof.qmd');
  await writeFile(source, result('lem-test', statement, { proofText: proof }));
  const previous = process.env.QMD_PROVER_VERIFIER;
  process.env.QMD_PROVER_VERIFIER = verifier;
  try {
    const inspected = await inspectProject(root, options);
    assert.equal(inspected.ok, true);
  } finally {
    if (previous === undefined) delete process.env.QMD_PROVER_VERIFIER;
    else process.env.QMD_PROVER_VERIFIER = previous;
  }
  const directory = path.join(root, '.qmd-prover/verification/checks');
  const [name] = await readdir(directory);
  const record = path.join(directory, name);
  const sourceBefore = await readFile(source, 'utf8');
  const recordBefore = await readFile(record, 'utf8');
  const input = await readRecordedPacket(record);
  assert.equal(input.context.external_basis.mode, 'unrestricted');
  assert.equal(input.context.external_basis.content_source, null);
  const report = await reviewRecord(record, f.policyFile);
  assert.equal(report.stage_status, 'ready_for_proof_review', JSON.stringify(report.structural_issues));
  await saveReport(root, report);
  assert.equal(await readFile(source, 'utf8'), sourceBefore);
  assert.equal(await readFile(record, 'utf8'), recordBefore);
});

test('record integrity checks reject a changed packet, key, identity, scope, and mode', async (t) => {
  const f = await fixture(t);
  for (const change of ['packet', 'key', 'identity', 'scope', 'mode', 'version']) {
    const bad = structuredClone(f.record);
    if (change === 'packet') bad.packet.target.proof += 'CHANGED';
    if (change === 'key') bad.verification_key = sha256('bad');
    if (change === 'identity') bad.proof_hash = sha256('bad');
    if (change === 'scope') bad.packet.scope = { type: 'local-conditional-check', direct_dependency_ids: [] };
    if (change === 'mode') bad.packet.target.verification_mode = 'refutation';
    if (change === 'version') bad.schema_version = 999;
    await writeFile(f.recordFile, stableJson(bad));
    await assert.rejects(readRecordedPacket(f.recordFile));
  }
});

test('source anchors and full coverage reject omitted steps, invented premises, and altered quantifiers', async (t) => {
  const f = await fixture(t);
  const input = await readRecordedPacket(f.recordFile);
  const mutations = [
    (p: ReturnType<typeof proposal>) => { Object.assign(p.target_statement, { quoted_text: 'Every minimizer of f is unique.' }); },
    (p: ReturnType<typeof proposal>) => { p.obligations.pop(); },
    (p: ReturnType<typeof proposal>) => { Object.assign(p.obligations[0].source_span, { quoted_text: 'Invented proof' }); },
    (p: ReturnType<typeof proposal>) => { p.obligations[1].premises.push(anchor('dependency:missing.statement', 'f is convex')); },
    (p: ReturnType<typeof proposal>) => { p.obligations[0].internal_dependencies.push('lem-test#step-2'); },
    (p: ReturnType<typeof proposal>) => { p.obligations[0].premises.push(anchor('target.proof', proof)); },
    (p: ReturnType<typeof proposal>) => { p.obligations[1].source_span.start = 0; },
    (p: ReturnType<typeof proposal>) => { p.obligations[0].conclusion = anchor('dependency:def-f.statement', 'f is real-valued.'); }
  ];
  for (const mutate of mutations) {
    const value = proposal(); mutate(value);
    assert.throws(() => readDecomposition(value, input, 20));
  }
  assert.throws(() => readDecomposition(proposal(), input, 1));
});

test('exact UTF-16 source spans work for non-ASCII mathematics and reject imprecise offsets', async (t) => {
  const f = await fixture(t);
  const input = await readRecordedPacket(f.recordFile);
  const unicode = '取 x ∈ ℂ。🧮\n故存在。';
  input.sources['target.proof'] = unicode;
  const value = proposal();
  value.final_obligation_id = 'lem-test#step-1';
  value.obligations = [{ ...value.obligations[0], source_span: anchor('target.proof', unicode), conclusion: anchor('target.statement', statement) }];
  assert.equal(readDecomposition(value, input, 20, { min_inference_obligations: 1 }).obligations[0].source_span.end, unicode.length);
  value.obligations[0].source_span.end -= 1;
  assert.throws(() => readDecomposition(value, input, 20));
});

test('semantic fidelity can block a fully anchored decomposition which changes the inference', async (t) => {
  const altered = proposal();
  altered.obligations[1].inference = 'All minimizers are unique, by an added strict convexity assumption.';
  const fail = { ...faithful(), status: 'fail', issues: [{ kind: 'added_premise', obligation_id: 'lem-test#step-2',
    explanation: 'Strict convexity and uniqueness are not in the supplied claim or argument.', source_refs: [anchor('target.statement', statement)] }] };
  const f = await fixture(t, `process.stdout.write(JSON.stringify({result: request.role==='decomposer' ? ${JSON.stringify(altered)} : ${JSON.stringify(fail)}}));`);
  const report = await reviewRecord(f.recordFile, f.policyFile);
  assert.equal(report.stage_status, 'blocked');
  assert.equal(report.fidelity?.issues[0].kind, 'added_premise');
  assert.equal(report.outcome, 'inconclusive');
  assert.equal(report.metrics.reported_total_tokens, undefined);
});

test('fidelity pass cannot omit obligations, target preservation, or sourced mismatches', async (t) => {
  const f = await fixture(t);
  const input = await readRecordedPacket(f.recordFile);
  const decomposition = readDecomposition(proposal(), input, 20);
  for (const value of [
    { ...faithful(), checked_obligation_ids: ['lem-test#step-1'] },
    { ...faithful(), target_preserved: false },
    { ...faithful(), checked_obligation_ids: ['lem-test#step-1', 'lem-test#step-1'] },
    { ...faithful(), status: 'fail' },
    { ...faithful(), issues: [{ kind: 'other', obligation_id: null, explanation: 'problem', source_refs: [] }] }
  ]) assert.throws(() => readFidelity(value, decomposition, input.sources));
});

test('a target statement anchor, including a proper substring, is mechanically forbidden as a premise', async (t) => {
  const f = await fixture(t);
  const input = await readRecordedPacket(f.recordFile);
  for (const premise of [anchor('target.statement', statement), anchor('target.statement', statement, 0, 5)]) {
    const p = proposal();
    p.obligations[1].premises.push(premise);
    assert.throws(() => readDecomposition(p, input, 20), /never an obligation premise/);
  }
});

test('whole-proof single obligations need an explicit trusted one-step policy, never a model exemption', async (t) => {
  const f = await fixture(t);
  const input = await readRecordedPacket(f.recordFile);
  const p = proposal();
  p.final_obligation_id = 'lem-test#step-1';
  p.obligations = [{ ...p.obligations[1], id: 'lem-test#step-1', source_span: anchor('target.proof', proof), premises: [], internal_dependencies: [] }];
  assert.throws(() => readDecomposition(p, input, 20), /too few inference/);
  assert.doesNotThrow(() => readDecomposition(p, input, 20, { min_inference_obligations: 1 }));
  p.obligations[0].kind = 'context';
  assert.throws(() => readDecomposition(p, input, 20, { min_inference_obligations: 1 }), /Final inference/);
});

test('paragraph granularity guard uses source structure as well as inference counts', async (t) => {
  const f = await fixture(t);
  const input = await readRecordedPacket(f.recordFile);
  const body = 'Case one follows.\n\nCase two follows.\n\nCombine both cases.';
  input.sources['target.proof'] = body;
  const end = body.lastIndexOf('\n\n');
  const p = proposal();
  p.obligations[0].source_span = anchor('target.proof', body, 0, end);
  p.obligations[0].conclusion = anchor('target.proof', body, 0, end);
  p.obligations[1].source_span = anchor('target.proof', body, end + 2);
  p.obligations[1].premises = [];
  assert.throws(() => readDecomposition(p, input, 20), /too many proof paragraphs/);
  assert.doesNotThrow(() => readDecomposition(p, input, 20, { max_span_paragraphs: 2 }));
});

test('the final obligation must be last and conclude the complete exact target', async (t) => {
  const f = await fixture(t);
  const input = await readRecordedPacket(f.recordFile);
  for (const mutation of [
    (p: Decomposition) => { p.final_obligation_id = 'missing'; },
    (p: Decomposition) => { p.final_obligation_id = p.obligations[0].id; },
    (p: Decomposition) => { p.obligations[1].conclusion.end -= 1; },
    (p: Decomposition) => { p.obligations[1].conclusion = p.obligations[1].source_span; },
    (p: Decomposition) => { p.obligations[1].kind = 'context'; }
  ]) { const p = proposal(); mutation(p); assert.throws(() => readDecomposition(p, input, 20)); }
});

test('all load-bearing inference obligations must have a declared path to the final goal', async (t) => {
  const f = await fixture(t);
  const input = await readRecordedPacket(f.recordFile);
  const p = proposal();
  p.obligations[1].premises = [];
  p.obligations[1].internal_dependencies = [];
  assert.throws(() => readDecomposition(p, input, 20), /disconnected/);
  p.obligations[0].kind = 'context';
  assert.doesNotThrow(() => readDecomposition(p, input, 20, { min_inference_obligations: 1 }));
});

test('proof premises from earlier obligations cannot omit their explicit DAG edges', async (t) => {
  const f = await fixture(t);
  const input = await readRecordedPacket(f.recordFile);
  const p = proposal(); p.obligations[1].internal_dependencies = [];
  assert.throws(() => readDecomposition(p, input, 20), /explicit dependency edge/);
});

test('compact decomposition and reports resolve all quotes through the canonical corpus', async (t) => {
  const f = await fixture(t);
  const input = await readRecordedPacket(f.recordFile);
  const p = proposal();
  Object.assign(p.obligations[0].source_span, { quoted_text: proof.slice(0, proof.indexOf('\n')) });
  const normalized = readDecomposition(p, input, 20);
  assert.equal('quoted_text' in normalized.obligations[0].source_span, false);
  const report = await reviewRecord(f.recordFile, f.policyFile);
  assert.equal(report.schema_version, 2);
  const span = report.decomposition!.obligations[0].source_span;
  assert.equal(report.sources[span.source].slice(span.start, span.end), 'Choose x in the domain.');
});

test('relocating identical adapters and runtime files does not change the review policy identity', async (t) => {
  const f = await fixture(t);
  const other = path.join(f.root, 'relocated');
  await mkdir(other);
  await cp(f.adapter, path.join(other, 'adapter.mjs'));
  const p = structuredClone(f.policy);
  for (const role of Object.values(p.roles)) role.command[1] = path.join(other, 'adapter.mjs');
  const policyFile = path.join(other, 'policy.json');
  await writeFile(policyFile, stableJson(p));
  assert.equal((await loadPolicy(f.policyFile)).hash, (await loadPolicy(policyFile)).hash);
});

test('loader arguments and declared runtime directories participate in policy fingerprints', async (t) => {
  const f = await fixture(t);
  const loader = path.join(f.root, 'loader.mjs');
  const runtime = path.join(f.root, 'runtime');
  await mkdir(runtime);
  await writeFile(path.join(runtime, 'runtime.js'), 'version 1');
  await writeFile(loader, '// loader version 1');
  for (const role of Object.values(f.policy.roles)) {
    role.command = [process.execPath, '--import', pathToFileURL(loader).href, f.adapter];
    role.implementation_files = [f.adapter, runtime];
  }
  await writeFile(f.policyFile, stableJson(f.policy));
  const original = (await loadPolicy(f.policyFile)).hash;
  await writeFile(loader, '// loader version 2');
  const changedLoader = (await loadPolicy(f.policyFile)).hash;
  assert.notEqual(original, changedLoader);
  await writeFile(path.join(runtime, 'runtime.js'), 'version 2');
  assert.notEqual((await loadPolicy(f.policyFile)).hash, changedLoader);
});

test('failed structural gate stops before fidelity, with no retries', async (t) => {
  const incomplete = proposal(); incomplete.obligations.pop();
  const f = await fixture(t, `process.stdout.write(JSON.stringify({result:${JSON.stringify(incomplete)}}));`);
  const report = await reviewRecord(f.recordFile, f.policyFile);
  assert.equal(report.stage_status, 'blocked');
  assert.equal(report.metrics.calls, 1);
  assert.equal(report.fidelity, null);
  assert.match(report.structural_issues[0], /end of the proof/);
});

test('invalid, crashed, timed-out, and excessive role outputs remain inconclusive', async (t) => {
  for (const body of ["process.stdout.write('not JSON');", 'process.exitCode=7;', 'setInterval(()=>{},1000);', "process.stdout.write('x'.repeat(110000));"]) {
    const f = await fixture(t, body);
    f.policy.timeout_ms = 100;
    await writeFile(f.policyFile, stableJson(f.policy));
    const report = await reviewRecord(f.recordFile, f.policyFile);
    assert.equal(report.outcome, 'inconclusive');
    assert.equal(report.stage_status, 'inconclusive');
    assert.equal(report.metrics.calls, 1);
    assert.equal(report.calls[0].status, 'error');
  }
});

test('invalid fidelity response never retains readiness or treats a pass string as success', async (t) => {
  const f = await fixture(t, `process.stdout.write(JSON.stringify({result:request.role==='decomposer' ? ${JSON.stringify(proposal())} : {status:'pass'}}));`);
  const report = await reviewRecord(f.recordFile, f.policyFile);
  assert.equal(report.stage_status, 'inconclusive');
  assert.equal(report.fidelity, null);
  assert.equal(report.outcome, 'inconclusive');
});

test('explicit semantic uncertainty remains inconclusive after complete structural coverage', async (t) => {
  const uncertain = { ...faithful(), status: 'inconclusive', explanation: 'The inference description may change the original claim.' };
  const f = await fixture(t, `process.stdout.write(JSON.stringify({result:request.role==='decomposer' ? ${JSON.stringify(proposal())} : ${JSON.stringify(uncertain)}}));`);
  const report = await reviewRecord(f.recordFile, f.policyFile);
  assert.equal(report.stage_status, 'inconclusive');
  assert.equal(report.fidelity?.status, 'inconclusive');
  assert.equal(report.metrics.calls, 2);
});

test('multi-megabyte proof requests carry each corpus entry once and retain auditable offsets', async (t) => {
  const f = await fixture(t);
  const marker = 'UNIQUE_LARGE_PROOF_CORPUS_';
  const large = marker + 'x'.repeat(2 * 1024 * 1024) + '\nThus the claim follows.';
  f.record.packet.target.proof = large;
  f.record.packet_hash = sha256(stableJson(f.record.packet, 0));
  f.record.verification_key = verificationKey(f.record.packet);
  await writeFile(f.recordFile, stableJson(f.record));
  const p = proposal();
  const end = large.indexOf('\n');
  p.obligations[0].source_span = anchor('target.proof', large, 0, end);
  p.obligations[0].conclusion = anchor('target.proof', large, 0, end);
  p.obligations[1].source_span = anchor('target.proof', large, end + 1);
  p.obligations[1].premises = [anchor('target.proof', large, 0, end)];
  await writeFile(f.adapter, `process.stdin.setEncoding('utf8');let raw='';for await(const c of process.stdin)raw+=c;const request=JSON.parse(raw);
if(raw.split(${JSON.stringify(marker)}).length!==2)throw new Error('Duplicate corpus');
if(Buffer.byteLength(raw)-Buffer.byteLength(request.sources['target.proof'])>16000)throw new Error('Unexpected payload duplication');
if(request.decomposition && JSON.stringify(request.decomposition).includes(${JSON.stringify(marker)}))throw new Error('Repeated quoted spans');
process.stdout.write(JSON.stringify({result:request.role==='decomposer'?${JSON.stringify(p)}:${JSON.stringify(faithful())}}));`);
  const report = await reviewRecord(f.recordFile, f.policyFile);
  assert.equal(report.stage_status, 'ready_for_proof_review', JSON.stringify(report.structural_issues));
  assert.equal(report.sources['target.proof'], large);
  assert.equal(report.decomposition!.obligations[0].source_span.end, end);
  assert.equal(report.metrics.calls, 2);
});

test('Codex adapter transports a multi-megabyte Unicode prompt by stdin, never argv', async (t) => {
  if (process.platform === 'win32') { t.skip('Fake Codex CLI uses a POSIX shebang; Windows pipe/tree tests run separately'); return; }
  const f = await fixture(t);
  const fakeCli = path.join(f.root, 'fake-large-codex.mjs');
  await writeFile(fakeCli, `#!${process.execPath}\nconst args=process.argv.slice(2);
if(args.at(-1)!=='-' || args.some(x=>Buffer.byteLength(x)>1024))process.exit(8);
process.stdin.setEncoding('utf8');let prompt='';for await(const c of process.stdin)prompt+=c;
if(Buffer.byteLength(prompt)<2000000 || prompt.includes('�') || (prompt.match(/∀x∈ℂ🧮/gu)||[]).length!==20000)process.exit(9);
process.stdout.write(JSON.stringify({large_input_received:true}));`, { mode: 0o700 });
  const adapter = fileURLToPath(new URL('../tooling/proof-review/codex-adapter.ts', import.meta.url));
  const loader = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
  const request = JSON.stringify({ schema_version: 2, role: 'decomposer', instructions: 'Return JSON.',
    context: {}, sources: { 'target.proof': 'x'.repeat(2 * 1024 * 1024) + '∀x∈ℂ🧮'.repeat(20000) }, output_schema: {} });
  const response = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, adapter, '--executable', fakeCli], {
      env: { ...process.env, QMD_PROOF_REVIEW_MODEL: 'mock-only' }, stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    child.stdin.end(request);
  });
  assert.equal(JSON.parse(response).result.large_input_received, true);
});

test('Codex transport supplies isolated role prompts, explicit models, and usage without a live model', async (t) => {
  const f = await fixture(t);
  const fakeCli = path.join(f.root, 'fake-codex.mjs');
  // A fake executable receives the same argv as the installed Codex CLI.
  if (process.platform === 'win32') { t.skip('Executable wrapper uses a POSIX shebang'); return; }
  await writeFile(fakeCli, `#!${process.execPath}\nconst args=process.argv.slice(2);
if(args[0]!=='exec' || !args.includes('--sandbox') || !args.includes('read-only') || !args.includes('mock-only')) process.exit(8);
if(args.at(-1)!=='-') process.exit(11);
let prompt=''; process.stdin.setEncoding('utf8'); for await(const chunk of process.stdin) prompt+=chunk;
if(prompt.includes('UPSTREAM SECRET PROOF') || prompt.includes('ORIGINAL VERDICT SECRET')) process.exit(9);
const isFidelity=prompt.includes('Independently compare the proposed decomposition');
if(isFidelity && !prompt.includes('"decomposition"')) process.exit(10);
process.stdout.write(JSON.stringify(isFidelity ? ${JSON.stringify(faithful())} : ${JSON.stringify(proposal())}));
process.stderr.write('tokens used\\n321');\n`, { mode: 0o700 });
  const adapter = fileURLToPath(new URL('../tooling/proof-review/codex-adapter.ts', import.meta.url));
  const tsx = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
  for (const role of Object.values(f.policy.roles)) {
    role.command = [process.execPath, '--import', tsx, adapter, '--executable', fakeCli, '--effort', 'high'];
    role.implementation_files = [adapter, fakeCli];
  }
  f.policy.timeout_ms = 5000;
  await writeFile(f.policyFile, stableJson(f.policy));
  const report = await reviewRecord(f.recordFile, f.policyFile);
  assert.equal(report.stage_status, 'ready_for_proof_review', JSON.stringify(report.structural_issues));
  assert.equal(report.metrics.reported_total_tokens, 642);
  assert.equal(report.outcome, 'inconclusive');
});

test('policy identities change with model, routing version, prompt transport, and adapter content', async (t) => {
  const f = await fixture(t);
  let previous = (await loadPolicy(f.policyFile)).hash;
  for (const mutation of [
    () => { f.policy.roles.fidelity.model = 'changed-model'; },
    () => { f.policy.roles.fidelity.implementation_version = 'test-v2'; },
    () => { f.policy.max_obligations = 21; }
  ]) {
    mutation(); await writeFile(f.policyFile, stableJson(f.policy));
    const next = (await loadPolicy(f.policyFile)).hash;
    assert.notEqual(next, previous); previous = next;
  }
  await writeFile(f.adapter, `${await readFile(f.adapter, 'utf8')}\n// adapter changed\n`);
  assert.notEqual((await loadPolicy(f.policyFile)).hash, previous);
});

test('record and adapter changes during a role run discard stage readiness', async (t) => {
  for (const which of ['record', 'adapter']) {
    const f = await fixture(t);
    const touched = which === 'record' ? f.recordFile : f.adapter;
    const body = await readFile(f.adapter, 'utf8');
    await writeFile(f.adapter, `${body}\nif(request.role==='fidelity') await fs.appendFile(${JSON.stringify(touched)}, '\\n');\n`);
    const report = await reviewRecord(f.recordFile, f.policyFile);
    assert.equal(report.stage_status, 'inconclusive');
    assert.match(report.structural_issues.at(-1)!, /changed during review/);
  }
});

test('changing QMD after a historical record cannot turn the report into a current-source claim', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'proof.qmd'), 'A DIFFERENT CURRENT PROOF');
  const report = await reviewRecord(f.recordFile, f.policyFile);
  assert.equal(report.applicability, 'recorded-packet-only');
  assert.equal(report.current_source_checked, false);
  assert.equal(report.outcome, 'inconclusive');
});

test('Markdown keeps model-authored backtick fences inside a quoted JSON block', async (t) => {
  const f = await fixture(t);
  const report = await reviewRecord(f.recordFile, f.policyFile);
  report.structural_issues.push('```\n# Untrusted heading\n```');
  assert.match(markdownReport(report), /````json/);
});

test('checkout CLI writes shadow reports and returns preparation-stage status', async (t) => {
  const f = await fixture(t);
  const cli = fileURLToPath(new URL('../tooling/proof-review/cli.ts', import.meta.url));
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, '--record', f.recordFile, '--policy', f.policyFile], { cwd });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.outcome, 'inconclusive');
  assert.equal(JSON.parse(await readFile(path.join(output.directory, 'report.json'), 'utf8')).stage_status, 'ready_for_proof_review');
});
