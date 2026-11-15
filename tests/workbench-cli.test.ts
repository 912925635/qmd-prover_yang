import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseCommand } from '../skills/qmd-prover/src/cli/parse.js';
import { fakePandoc, result } from './support.js';
import { workbenchProject, fakeCodex, codexConfig } from './workbench-support.js';
import { inspectFact } from '../skills/qmd-prover/src/commands/inspect/index.js';

const cli = fileURLToPath(new URL('../skills/qmd-prover/scripts/qmd-prover.js', import.meta.url));
const run = (root: string, args: string[]) => new Promise<{ code: number; value: Record<string, any> }>((resolve, reject) => {
  execFile(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, QMD_PROVER_PANDOC: fakePandoc } }, (error, stdout) => {
    try { resolve({ code: error ? Number(error.code) : 0, value: JSON.parse(stdout) }); } catch (parseError) { reject(parseError); }
  });
});

test('workbench parser rejects ambiguous mutation flags before accessing project files', () => {
  assert.throws(() => parseCommand(['workbench', 'sources', 'review', 'id', '--evidence', 'x', '--backend', 'codex']), /cannot be combined/);
  assert.throws(() => parseCommand(['workbench', 'sources', 'review', 'id', '--backend', 'codex']), /--model/);
  assert.throws(() => parseCommand(['workbench', 'sessions', 'show', 'id', '--source', 'other']), /--source/);
  assert.equal((parseCommand(['workbench', 'sessions', 'resume', 'id']) as { launch: boolean }).launch, false);
});

test('public CLI exposes retained sessions, binding, status and a static report without additional model calls', async (t) => {
  const { root } = await workbenchProject(t);
  await codexConfig(root, await fakeCodex(root));
  assert.equal((await run(root, ['inspect', 'project'])).code, 0);
  const sessions = await run(root, ['workbench', 'sessions', 'list', '--fact', '@lem-trace']);
  assert.equal(sessions.code, 0);
  const id = sessions.value.sessions[0].attempt_id as string;
  assert.equal((await run(root, ['workbench', 'sessions', 'show', id])).code, 0);
  assert.equal((await run(root, ['workbench', 'sessions', 'resume', id])).value.launched, false);
  const paper = path.join(root, 'paper'); await mkdir(paper);
  await writeFile(path.join(paper, 'source.tex'), '\\begin{lemma}\\label{l}A test claim.\\end{lemma}\n\\begin{proof}\\label{p}A test argument.\\end{proof}');
  const manifest = path.join(root, 'binding.json');
  await writeFile(manifest, JSON.stringify({ schema_version: 1, source_root: paper, statement: { file: 'source.tex', label: 'l' }, proof_spans: [{ file: 'source.tex', label: 'p' }] }));
  const bound = await run(root, ['workbench', 'sources', 'bind', '@lem-trace', '--manifest', manifest]);
  assert.equal(bound.code, 0);
  const status = await run(root, ['workbench', 'sources', 'status', '@lem-trace']);
  assert.equal(status.value.bindings[0].binding_status, 'needs-review');
  assert.equal((await run(root, ['workbench', 'render'])).code, 0);
  const page = await readFile(path.join(root, '.qmd-prover', 'generated', 'workbench.html'), 'utf8');
  assert.match(page, /needs-review/);
  assert.match(page, /verified/);
  assert.equal(await readFile(path.join(root, 'calls.txt'), 'utf8'), 'call\n');
});

test('jobs plan is read-only; run reuses cache and explicit recheck adds an attempt', async (t) => {
  const { root } = await workbenchProject(t);
  await codexConfig(root, await fakeCodex(root));
  const planned = await run(root, ['workbench', 'jobs', 'plan', 'fact', '@lem-trace', '--save', 'plan.json']);
  assert.equal(planned.code, 0);
  assert.equal(planned.value.model_calls, 0);
  const planFile = path.join(root, 'plan.json');
  const originalPlan = await readFile(planFile, 'utf8');
  const forged = JSON.parse(originalPlan);
  forged.tasks[0].packet.target.proof = 'Forged proof';
  await writeFile(planFile, JSON.stringify(forged));
  assert.notEqual((await run(root, ['workbench', 'jobs', 'run', 'plan.json'])).code, 0);
  await writeFile(planFile, originalPlan);
  assert.equal((await readFile(path.join(root, 'calls.txt'), 'utf8').catch(() => '')).length, 0);
  const first = await run(root, ['workbench', 'jobs', 'run', 'plan.json', '--jobs', '2']);
  assert.equal(first.code, 0);
  assert.equal(first.value.verification.verifier_calls, 1);
  const inspected = await inspectFact(root, '@lem-trace', { pandoc: fakePandoc });
  assert.equal((inspected.verification_history as unknown[]).length, 1);
  const status = await run(root, ['workbench', 'jobs', 'status', first.value.run_id]);
  assert.equal(status.value.state, 'completed');
  const second = await run(root, ['workbench', 'jobs', 'run', 'plan.json']);
  assert.equal(second.code, 0);
  assert.equal(second.value.verification.verifier_calls, 0);
  const third = await run(root, ['workbench', 'jobs', 'run', 'plan.json', '--recheck']);
  assert.equal(third.code, 0);
  assert.equal(third.value.verification.verifier_calls, 1);
  assert.equal(await readFile(path.join(root, 'calls.txt'), 'utf8'), 'call\ncall\n');
  const history = await run(root, ['workbench', 'history', 'fact', '@lem-trace']);
  assert.equal(history.value.attempts.length, 2);
  const comparison = await run(root, ['workbench', 'history', 'compare', history.value.attempts[0].attempt_id, history.value.attempts[1].attempt_id]);
  assert.equal(comparison.value.input_relation, 'same');
  assert.equal(comparison.value.contract_relation, 'same');
  const costs = await run(root, ['workbench', 'costs']);
  assert.equal(costs.value.attempt_count, 2);
  const rendered = await run(root, ['workbench', 'render']);
  assert.equal(rendered.value.task_count >= 1, true);
  assert.match(await readFile(path.join(root, '.qmd-prover', 'generated', 'workbench.html'), 'utf8'), /<h2>任务<\/h2>/);
  const retried = await run(root, ['workbench', 'jobs', 'retry', first.value.tasks[0].task_id]);
  assert.equal(retried.code, 0);
  assert.equal(retried.value.verification.verifier_calls, 1);
  assert.equal(await readFile(path.join(root, 'calls.txt'), 'utf8'), 'call\ncall\ncall\n');
});

test('failed recheck keeps an applicable older mathematical decision and records failure separately', async (t) => {
  const { root } = await workbenchProject(t);
  await codexConfig(root, await fakeCodex(root));
  assert.equal((await run(root, ['workbench', 'jobs', 'plan', 'fact', '@lem-trace', '--save', 'plan.json'])).code, 0);
  assert.equal((await run(root, ['workbench', 'jobs', 'run', 'plan.json'])).code, 0);
  await fakeCodex(root, { failure: true });
  const failed = await run(root, ['workbench', 'jobs', 'run', 'plan.json', '--recheck']);
  assert.equal(failed.code, 2);
  assert.equal(failed.value.tasks[0].execution, 'failed');
  assert.equal(failed.value.tasks[0].commit, 'superseded');
  assert.equal(failed.value.tasks[0].local_verification.status, 'verified');
  assert.ok(failed.value.tasks[0].local_verification.latest_execution_error);
  assert.equal((await run(root, ['workbench', 'jobs', 'run', 'plan.json'])).value.verification.verifier_calls, 0);
});

test('pause stops new dispatch, resume continues, and watch reads the completed run', async (t) => {
  const { root } = await workbenchProject(t);
  await writeFile(path.join(root, 'other.qmd'), result('lem-second', 'A second synthetic claim.', { proofText: 'A second synthetic argument.' }));
  const calls = path.join(root, 'slow-calls.txt');
  const script = path.join(root, 'slow.mjs');
  await writeFile(script, `#!/usr/bin/env node\nimport {appendFileSync} from 'node:fs';let input='';for await(const x of process.stdin)input+=x;appendFileSync(${JSON.stringify(calls)},JSON.parse(input).target.id+'\\n');await new Promise(r=>setTimeout(r,1000));console.log(JSON.stringify({verdict:'correct',summary:'synthetic',critical_errors:[],gaps:[],nonblocking_comments:[],repair_hints:''}));`);
  await writeFile(path.join(root, '.qmd-prover', 'config.yml'), `verification:\n  backend: command\n  command: ${JSON.stringify([process.execPath, script])}\n`);
  assert.equal((await run(root, ['workbench', 'jobs', 'plan', 'project', '--save', 'plan.json'])).code, 0);
  const running = run(root, ['workbench', 'jobs', 'run', 'plan.json']);
  const waitFor = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 80; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
    throw new Error('Timed out waiting for synthetic run');
  };
  let id = '';
  await waitFor(async () => {
    const ids = await readdir(path.join(root, '.qmd-prover', 'workbench', 'v1', 'runs')).catch(() => []);
    id = ids.find((value) => /^[0-9a-f-]{36}$/u.test(value)) ?? '';
    return Boolean(id);
  });
  await waitFor(async () => (await readFile(calls, 'utf8').catch(() => '')).trim().length > 0);
  assert.equal((await run(root, ['workbench', 'jobs', 'status', id])).value.tasks.some((task: { execution: string }) => task.execution === 'running'), true);
  assert.equal((await run(root, ['workbench', 'jobs', 'pause', id])).code, 0);
  assert.equal((await run(root, ['workbench', 'jobs', 'status', id])).value.state, 'paused');
  const contender = await run(root, ['inspect', 'project']);
  assert.notEqual(contender.code, 0);
  assert.match(JSON.stringify(contender.value), /coordinator/i);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 1);
  assert.equal((await run(root, ['workbench', 'jobs', 'resume', id])).code, 0);
  assert.equal((await running).code, 0);
  assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 2);
  const events = await readFile(path.join(root, '.qmd-prover', 'workbench', 'v1', 'runs', id, 'events.jsonl'), 'utf8');
  assert.match(events, /run-started/);
  assert.match(events, /run-finished/);
  const watched = await run(root, ['workbench', 'watch', id]);
  assert.equal(watched.value.state, 'completed');
  assert.equal((await run(root, ['workbench', 'costs', id])).value.attempt_count, 2);
});

test('cancel waits for a contained verifier and leaves undispatched work without a model call', async (t) => {
  const { root } = await workbenchProject(t);
  await writeFile(path.join(root, 'other.qmd'), result('lem-second', 'Another synthetic claim.', { proofText: 'Another synthetic argument.' }));
  const calls = path.join(root, 'cancel-calls.txt');
  const script = path.join(root, 'cancel-verifier.mjs');
  await writeFile(script, `#!/usr/bin/env node\nimport {appendFileSync} from 'node:fs';let input='';for await(const x of process.stdin)input+=x;appendFileSync(${JSON.stringify(calls)},JSON.parse(input).target.id+'\\n');await new Promise(r=>setTimeout(r,5000));console.log(JSON.stringify({verdict:'correct',summary:'synthetic',critical_errors:[],gaps:[],nonblocking_comments:[],repair_hints:''}));`);
  await writeFile(path.join(root, '.qmd-prover', 'config.yml'), `verification:\n  backend: command\n  command: ${JSON.stringify([process.execPath, script])}\n`);
  assert.equal((await run(root, ['workbench', 'jobs', 'plan', 'project', '--save', 'plan.json'])).code, 0);
  const running = run(root, ['workbench', 'jobs', 'run', 'plan.json']);
  let id = '';
  for (let i = 0; i < 100; i++) {
    const ids = await readdir(path.join(root, '.qmd-prover', 'workbench', 'v1', 'runs')).catch(() => []);
    id = ids.find((value) => /^[0-9a-f-]{36}$/u.test(value)) ?? '';
    if (id && (await readFile(calls, 'utf8').catch(() => '')).trim()) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(id);
  const cancelled = await run(root, ['workbench', 'jobs', 'cancel', id]);
  assert.equal(cancelled.value.cleanup_acknowledged, true);
  const finished = await running;
  assert.equal(finished.value.state, 'cancelled');
  assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 1);
  const history = await run(root, ['workbench', 'history', 'fact', '@lem-second']);
  assert.equal(history.value.attempts.length <= 1, true);
});

test('a mid-run source edit discards the new decision but retains the sealed attempt', async (t) => {
  const { root } = await workbenchProject(t);
  const source = path.join(root, 'work.qmd');
  const script = path.join(root, 'mutating-verifier.mjs');
  await writeFile(script, `#!/usr/bin/env node\nimport {readFileSync,writeFileSync} from 'node:fs';let input='';for await(const x of process.stdin)input+=x;const f=${JSON.stringify(source)};writeFileSync(f,readFileSync(f,'utf8').replace('A test argument.','A changed argument.'));console.log(JSON.stringify({verdict:'correct',summary:'synthetic',critical_errors:[],gaps:[],nonblocking_comments:[],repair_hints:''}));`);
  await writeFile(path.join(root, '.qmd-prover', 'config.yml'), `verification:\n  backend: command\n  command: ${JSON.stringify([process.execPath, script])}\n`);
  assert.equal((await run(root, ['workbench', 'jobs', 'plan', 'fact', '@lem-trace', '--save', 'plan.json'])).code, 0);
  const failed = await run(root, ['workbench', 'jobs', 'run', 'plan.json']);
  assert.equal(failed.code, 2);
  assert.equal(failed.value.state, 'failed');
  assert.equal(failed.value.snapshot_published, false);
  assert.equal(failed.value.tasks[0].commit, 'discarded-stale');
  const attempts = (await run(root, ['workbench', 'history', 'fact', '@lem-trace'])).value.attempts;
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].sealed, true);
});
