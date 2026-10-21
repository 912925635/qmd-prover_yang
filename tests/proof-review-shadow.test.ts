import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { buildVerifierPacket, verificationKey } from '../skills/qmd-prover/src/core/verification/protocol.js';
import { sha256, stableJson } from '../skills/qmd-prover/src/core/infrastructure/files.js';
import { SCHEMA_VERSION } from '../skills/qmd-prover/src/core/shared/core.js';
import { readRecordedPacket } from '../tooling/proof-review/packet.js';
import { readDecomposition } from '../tooling/proof-review/decomposition.js';
import { readFidelity } from '../tooling/proof-review/faithfulness.js';
import { loadPolicy } from '../tooling/proof-review/policy.js';
import { reviewRecord } from '../tooling/proof-review/review.js';
import { markdownReport, saveReport } from '../tooling/proof-review/report.js';
import type { ReviewPolicy } from '../tooling/proof-review/types.js';
import { inspectProject } from '../skills/qmd-prover/src/commands/inspect/index.js';
import { options, project, result, verifier } from './support.js';

const statement = 'There exists a minimizer of f.';
const proof = 'Choose x in the domain.\nThus x minimizes f.';
function anchor(source: string, content: string, start = 0, end = content.length) {
  return { source, start, end, quoted_text: content.slice(start, end) };
}
function proposal() {
  const split = proof.indexOf('\n');
  return {
    target_statement: statement,
    obligations: [
      { id: 'lem-test#step-1', source_span: anchor('target.proof', proof, 0, split), premises: [],
        conclusion: anchor('target.proof', proof, 0, split), inference: 'The author chooses an element.', internal_dependencies: [] },
      { id: 'lem-test#step-2', source_span: anchor('target.proof', proof, split + 1), premises: [anchor('target.proof', proof, 0, split)],
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
  assert.equal(input.context.external_basis.content, null);
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
    (p: ReturnType<typeof proposal>) => { p.target_statement = 'Every minimizer of f is unique.'; },
    (p: ReturnType<typeof proposal>) => { p.obligations.pop(); },
    (p: ReturnType<typeof proposal>) => { p.obligations[0].source_span.quoted_text = 'Invented proof'; },
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
  input.context.target.proof = unicode;
  input.sources['target.proof'] = unicode;
  const value = proposal();
  value.obligations = [{ ...value.obligations[0], source_span: anchor('target.proof', unicode), conclusion: anchor('target.proof', unicode) }];
  assert.equal(readDecomposition(value, input, 20).obligations[0].source_span.end, unicode.length);
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

test('Codex transport supplies isolated role prompts, explicit models, and usage without a live model', async (t) => {
  const f = await fixture(t);
  const fakeCli = path.join(f.root, 'fake-codex.mjs');
  // A fake executable receives the same argv as the installed Codex CLI.
  if (process.platform === 'win32') { t.skip('Executable wrapper uses a POSIX shebang'); return; }
  await writeFile(fakeCli, `#!${process.execPath}\nconst args=process.argv.slice(2);
if(args[0]!=='exec' || !args.includes('--sandbox') || !args.includes('read-only') || !args.includes('mock-only')) process.exit(8);
const prompt=args.at(-1);
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
