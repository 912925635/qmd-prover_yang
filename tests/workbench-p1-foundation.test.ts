import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { project, result, options, verifier } from './support.js';
import { withCoordinator, assertCoordinator, coordinatorState, recoverCoordinator } from '../skills/qmd-prover/src/core/workbench/coordinator.js';
import { workbenchRoot, beginAttempt, finishAttempt, readAttempt } from '../skills/qmd-prover/src/core/workbench/attempts.js';
import { compareAttempts, costs, factHistory } from '../skills/qmd-prover/src/core/workbench/history.js';
import { runManaged } from '../skills/qmd-prover/src/core/infrastructure/process.js';
import { sha256 } from '../skills/qmd-prover/src/core/infrastructure/files.js';
import { compileProject } from '../skills/qmd-prover/src/core/semantic/compiler.js';
import { verificationContext } from '../skills/qmd-prover/src/core/verification/protocol.js';
import { verifyFacts } from '../skills/qmd-prover/src/core/graph/verify.js';
import { inspectProject } from '../skills/qmd-prover/src/commands/inspect/index.js';
import { jobStatus, retryTask, planJobs, resumeJob } from '../skills/qmd-prover/src/core/workbench/jobs.js';

test('coordinator token replacement prevents an old owner from committing', async () => {
  const root = await project();
  await withCoordinator(root, 'first', async () => {
    await assertCoordinator(root);
    const file = path.join(workbenchRoot(root), 'coordinator.lock', 'owner.json');
    const owner = JSON.parse(await readFile(file, 'utf8')) as { token: string };
    assert.ok(owner.token);
    await writeFile(file, JSON.stringify({ ...owner, token: 'replacement' }));
    await assert.rejects(assertCoordinator(root), /ownership changed/);
    await writeFile(file, JSON.stringify(owner));
  });
  await withCoordinator(root, 'next', async () => assertCoordinator(root));
});

test('recovery fails closed when a lock has no verifiable owner', async () => {
  const root = await project();
  await mkdir(path.join(workbenchRoot(root), 'coordinator.lock'), { recursive: true });
  assert.equal(await coordinatorState(root), 'unknown');
  await assert.rejects(recoverCoordinator(root, 'unknown lock'), /refused/);
});

test('explicit recovery archives a dead owner and refuses a live owner', async () => {
  const root = await project();
  await withCoordinator(root, 'live', async () => {
    assert.equal(await coordinatorState(root), 'live');
    await assert.rejects(recoverCoordinator(root, 'test'), /refused/);
  });
  const lock = path.join(workbenchRoot(root), 'coordinator.lock');
  await mkdir(lock, { recursive: true });
  await mkdir(path.join(root, '.qmd-prover', 'write.lock'));
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ host_id: (await import('node:os')).hostname(), pid: 99999999, token: 'dead' }));
  assert.equal(await coordinatorState(root), 'orphaned');
  const recovered = await recoverCoordinator(root, 'synthetic crashed owner');
  assert.match(recovered.archive, /recovered/);
  assert.equal((await readdir(path.join(root, '.qmd-prover'))).includes('write.lock'), false);
  await withCoordinator(root, 'next', async () => assertCoordinator(root));
});

test('a prepared journal is reconciled from the authoritative pointer after a crash', async () => {
  const root = await project();
  const commit = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const snapshot = path.join(root, '.qmd-prover', 'graphs', 'generations', `${commit}.json`);
  const journal = path.join(workbenchRoot(root), 'commits', commit, 'journal.json');
  await Promise.all([mkdir(path.dirname(snapshot), { recursive: true }), mkdir(path.dirname(journal), { recursive: true })]);
  const bytes = JSON.stringify({ synthetic: true });
  await writeFile(snapshot, bytes);
  await writeFile(path.join(root, '.qmd-prover', 'graphs', 'latest.json'), JSON.stringify({ commit_id: commit, file: path.relative(root, snapshot) }));
  await writeFile(journal, JSON.stringify({ commit_id: commit, state: 'prepared', snapshot_hash: sha256(bytes) }));
  await withCoordinator(root, 'recover-journal', async () => {
    assert.equal(JSON.parse(await readFile(journal, 'utf8')).state, 'published');
  });
});

test('orphaned unknown dispatch is never resent until explicit recovery and retry', async () => {
  const root = await project();
  await writeFile(path.join(root, 'claim.qmd'), result('lem-orphan', 'A synthetic claim.', { proofText: 'A synthetic argument.' }));
  await writeFile(path.join(root, '.qmd-prover', 'config.yml'), `verification:\n  backend: command\n  command: ${JSON.stringify([process.execPath, verifier])}\n`);
  const runId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
  const taskId = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
  const file = path.join(workbenchRoot(root), 'runs', runId, 'run.json');
  const lock = path.join(workbenchRoot(root), 'coordinator.lock');
  await Promise.all([mkdir(path.dirname(file), { recursive: true }), mkdir(lock, { recursive: true })]);
  await writeFile(file, JSON.stringify({ run_id: runId, state: 'running', tasks: [{ task_id: taskId, fact_id: 'lem-orphan', execution: 'running' }] }));
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ host_id: (await import('node:os')).hostname(), pid: 99999999, token: 'dead' }));
  assert.equal((await jobStatus(root, runId)).state, 'orphaned');
  assert.equal((await readdir(path.join(workbenchRoot(root), 'attempts')).catch(() => [])).length, 0);
  await assert.rejects(retryTask(root, taskId, options), /Recover the orphaned/);
  await recoverCoordinator(root, 'synthetic crashed controller');
  const retried = await retryTask(root, taskId, options);
  assert.equal(retried.state, 'completed');
  assert.equal((await readdir(path.join(workbenchRoot(root), 'attempts'))).length, 1);
});

test('an orphaned run with only queued work resumes from a revalidated plan', async () => {
  const root = await project();
  await writeFile(path.join(root, 'claim.qmd'), result('lem-queued', 'A synthetic claim.', { proofText: 'A synthetic argument.' }));
  await writeFile(path.join(root, '.qmd-prover', 'config.yml'), `verification:\n  backend: command\n  command: ${JSON.stringify([process.execPath, verifier])}\n`);
  const old = 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee';
  const file = path.join(workbenchRoot(root), 'runs', old, 'plan.json');
  const plan = (await planJobs(root, 'fact', 'lem-queued', file, options)).plan as { plan_id: string; source_signature: string; tasks: Array<{ task_id: string; fact_id: string; packet_hash: string }> };
  await writeFile(path.join(path.dirname(file), 'run.json'), JSON.stringify({ run_id: old, plan_id: plan.plan_id, source_signature: plan.source_signature,
    state: 'running', jobs: 1, recheck: false, tasks: plan.tasks.map(({ task_id, fact_id, packet_hash }) => ({ task_id, fact_id, packet_hash, execution: 'queued' })) }));
  const lock = path.join(workbenchRoot(root), 'coordinator.lock');
  await mkdir(lock);
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ host_id: (await import('node:os')).hostname(), pid: 99999999, token: 'dead' }));
  await recoverCoordinator(root, 'synthetic pre-dispatch crash');
  const resumed = await resumeJob(root, old, options);
  assert.equal(resumed.state, 'completed');
  assert.equal((await readdir(path.join(workbenchRoot(root), 'attempts'))).length, 1);
});

async function crashedSealedRun(twoFacts = false): Promise<{ root: string; oldId: string; attemptId: string }> {
  const root = await project();
  await writeFile(path.join(root, 'claim.qmd'), result('lem-sealed', 'A synthetic claim.', { proofText: 'A synthetic argument.' }));
  if (twoFacts) await writeFile(path.join(root, 'other.qmd'), result('lem-second', 'A second synthetic claim.', { proofText: 'A second synthetic argument.' }));
  await writeFile(path.join(root, '.qmd-prover', 'config.yml'), `verification:\n  backend: command\n  command: ${JSON.stringify([process.execPath, verifier])}\n`);
  await planJobs(root, twoFacts ? 'project' : 'fact', twoFacts ? undefined : 'lem-sealed', 'plan.json', options);
  const cli = fileURLToPath(new URL('../skills/qmd-prover/scripts/qmd-prover.js', import.meta.url));
  const child = spawn(process.execPath, [cli, 'workbench', 'jobs', 'run', 'plan.json'], {
    cwd: root, env: { ...process.env, QMD_PROVER_PANDOC: options.pandoc, QMD_PROVER_TEST_CRASH_AFTER_SEAL: '1' }, stdio: 'ignore'
  });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(exit.signal, 'SIGKILL');
  const runs = (await readdir(path.join(workbenchRoot(root), 'runs'))).filter((name) => /^[0-9a-f-]{36}$/u.test(name));
  assert.equal(runs.length, 1);
  const attempts = await readdir(path.join(workbenchRoot(root), 'attempts'));
  assert.equal(attempts.length, 1);
  assert.equal((await readAttempt(root, attempts[0])).sealed, true);
  assert.equal((await jobStatus(root, runs[0])).state, 'orphaned');
  return { root, oldId: runs[0], attemptId: attempts[0] };
}

const posixCrash = { skip: process.platform === 'win32' ? 'SIGKILL crash injection requires POSIX; verify Windows process cleanup on Windows' : false };

test('a real controller crash after sealing reuses the exact attempt without another verifier call', posixCrash, async () => {
  const { root, oldId, attemptId } = await crashedSealedRun();
  await recoverCoordinator(root, 'test process died after seal');
  await withCoordinator(root, 'another-run', async () => {
    assert.equal((await jobStatus(root, oldId)).state, 'orphaned');
    await assert.rejects(resumeJob(root, oldId, options), /Recover the dead same-host coordinator/);
  });
  const resumed = await resumeJob(root, oldId, options);
  const verification = resumed.verification as { verifier_calls: number; recovered_attempts: number };
  const tasks = resumed.tasks as Array<{ local_verification: { status: string; source: string } }>;
  assert.equal(resumed.state, 'completed');
  assert.equal(verification.verifier_calls, 0);
  assert.equal(verification.recovered_attempts, 1);
  assert.equal(tasks[0].local_verification.status, 'verified');
  assert.equal(tasks[0].local_verification.source, 'sealed-attempt');
  assert.equal(resumed.snapshot_published, true);
  assert.deepEqual(await readdir(path.join(workbenchRoot(root), 'attempts')), [attemptId]);
  assert.equal((await jobStatus(root, oldId)).state, 'orphaned');
});

test('recovery applies sealed work and dispatches only the untouched queued task', posixCrash, async () => {
  const { root, oldId } = await crashedSealedRun(true);
  await recoverCoordinator(root, 'test mixed sealed and queued work');
  const resumed = await resumeJob(root, oldId, options);
  const verification = resumed.verification as { verifier_calls: number; recovered_attempts: number };
  assert.equal(resumed.state, 'completed');
  assert.equal(verification.verifier_calls, 1);
  assert.equal(verification.recovered_attempts, 1);
  assert.equal((await readdir(path.join(workbenchRoot(root), 'attempts'))).length, 2);
});

test('sealed replay refuses corrupted bytes, unknown dispatch, forged input, changed source, owner and generation', posixCrash, async () => {
  for (const defect of ['seal', 'unknown', 'packet', 'source', 'owner', 'generation']) {
    const { root, oldId, attemptId } = await crashedSealedRun();
    await recoverCoordinator(root, `test ${defect}`);
    const attempt = path.join(workbenchRoot(root), 'attempts', attemptId);
    if (defect === 'seal') await writeFile(path.join(attempt, 'report.json'), '{}');
    if (defect === 'unknown') await (await import('node:fs/promises')).unlink(path.join(attempt, 'seal.json'));
    if (defect === 'packet') {
      const inputFile = path.join(attempt, 'input.json');
      const input = JSON.parse(await readFile(inputFile, 'utf8'));
      input.packet.target.proof = 'forged proof';
      await writeFile(inputFile, JSON.stringify(input));
      const sealFile = path.join(attempt, 'seal.json');
      const seal = JSON.parse(await readFile(sealFile, 'utf8'));
      seal.hashes['input.json'] = sha256(await readFile(inputFile));
      await writeFile(sealFile, JSON.stringify(seal));
    }
    if (defect === 'source') await writeFile(path.join(root, 'claim.qmd'), result('lem-sealed', 'A changed synthetic claim.', { proofText: 'A synthetic argument.' }));
    if (defect === 'owner') {
      const file = path.join(workbenchRoot(root), 'runs', oldId, 'run.json');
      const run = JSON.parse(await readFile(file, 'utf8'));
      run.owner_token = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
      await writeFile(file, JSON.stringify(run));
    }
    if (defect === 'generation') {
      const graph = path.join(root, '.qmd-prover', 'graphs', 'generations', 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.json');
      await mkdir(path.dirname(graph), { recursive: true });
      await writeFile(graph, JSON.stringify({ synthetic: true }));
      await writeFile(path.join(root, '.qmd-prover', 'graphs', 'latest.json'), JSON.stringify({
        commit_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', file: path.relative(root, graph)
      }));
    }
    await assert.rejects(resumeJob(root, oldId, options), defect === 'source' ? /stale/i : defect === 'generation' ? /generation/
      : defect === 'owner' ? /owner/ : defect === 'packet' ? /frozen input/ : defect === 'unknown' ? /incomplete dispatched/ : /integrity/);
    assert.deepEqual(await readdir(path.join(workbenchRoot(root), 'attempts')), [attemptId]);
  }
});

test('sealed history compares inputs without changing cache; unknown usage stays unknown', async () => {
  const root = await project();
  const packet = { target: { id: 'lem-synthetic', proof: 'test', identity: { statement_hash: 'a', proof_hash: 'b' } }, checker_contract: { model: 'mock-a' }, dependencies: [], external_basis: { mode: 'unrestricted' }, scope: { type: 'local-conditional-check' } };
  const first = await beginAttempt(root, { packet }, { kind: 'mathematical', fact_id: 'lem-synthetic', verification_key: 'sha256:test' });
  await finishAttempt(first, { report: { verdict: 'incorrect', critical_errors: ['gap'] } }, 'completed');
  const second = await beginAttempt(root, { packet: { ...packet, checker_contract: { model: 'mock-b' } } }, { kind: 'mathematical', fact_id: 'lem-synthetic', verification_key: 'sha256:other' });
  await finishAttempt(second, { report: { verdict: 'correct', critical_errors: [] } }, 'completed');
  const compared = await compareAttempts(root, first.id, second.id);
  assert.equal(compared.input_relation, 'same');
  assert.equal(compared.contract_relation, 'different');
  const incomplete = await beginAttempt(root, { packet: {} }, { kind: 'mathematical', fact_id: 'lem-synthetic', verification_key: 'sha256:incomplete' });
  await finishAttempt(incomplete, { report: { verdict: 'incorrect' } }, 'completed');
  assert.equal((await compareAttempts(root, first.id, incomplete.id)).input_relation, 'unknown');
  const history = await factHistory(root, '@lem-synthetic');
  assert.equal((history.attempts as unknown[]).length, 3);
  const sum = await costs(root);
  assert.equal(sum.unknown_usage_attempts, 3);
  assert.equal(sum.estimate, null);
  const rates = path.join(root, 'rates.json');
  await writeFile(rates, JSON.stringify({ source: 'synthetic', as_of: '2026-11-14', currency: 'USD', models: { 'mock-a': { input_per_million: 1, output_per_million: 2 } } }));
  assert.equal((await costs(root, undefined, rates)).estimate !== null, true);
});

test('costs count backend usage once and price only an explicitly sourced model rate', async () => {
  const root = await project();
  const attempt = await beginAttempt(root, { packet: {} }, { kind: 'mathematical', fact_id: 'lem-cost', verification_key: 'sha256:cost', requested_model: 'mock-a', run_id: 'dddddddd-dddd-4ddd-dddd-dddddddddddd' });
  await writeFile(path.join(attempt.directory, 'adapter-execution.json'), JSON.stringify({ usage: { source: 'backend-reported', input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, total_tokens: 110 } }));
  await finishAttempt(attempt, { report: { verdict: 'correct' } }, 'completed');
  const rates = path.join(root, 'rates.json');
  await writeFile(rates, JSON.stringify({ source: 'synthetic table', as_of: '2026-11-14', currency: 'USD', models: { 'mock-a': { input_per_million: 1, cached_input_per_million: 0.5, output_per_million: 2 } } }));
  const summary = await costs(root, 'dddddddd-dddd-4ddd-dddd-dddddddddddd', rates);
  assert.equal(summary.known_usage && (summary.known_usage as { total_tokens: number }).total_tokens, 110);
  assert.equal((summary.estimate as { known_amount: number }).known_amount, 110 / 1_000_000);
  assert.equal(summary.unknown_usage_attempts, 0);
  await writeFile(rates, JSON.stringify({ source: 'synthetic table', as_of: '2026-11-14', currency: 'USD', models: {} }));
  const unmatched = await costs(root, undefined, rates);
  assert.equal((unmatched.estimate as { unknown_price_attempts: number }).unknown_price_attempts, 1);
});

test('formal runner terminates a POSIX descendant on timeout', { skip: process.platform === 'win32' }, async () => {
  const root = await project();
  const pidFile = path.join(root, 'child.pid');
  const script = path.join(root, 'parent.mjs');
  await writeFile(script, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);`);
  await assert.rejects(runManaged(process.execPath, [script], '', { env: process.env, timeoutMs: 300 }), /timed out/);
  const pid = Number(await readFile(pidFile, 'utf8'));
  // A terminated descendant may briefly remain as a zombie until init reaps it.
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    assert.match(status, /^State:\s+Z/m);
  } catch (error) { assert.match(String(error), /ENOENT/); }
});

test('formal runner cleans a POSIX descendant after explicit cancellation', { skip: process.platform === 'win32' }, async () => {
  const root = await project();
  const pidFile = path.join(root, 'cancel-child.pid');
  const script = path.join(root, 'cancel-parent.mjs');
  await writeFile(script, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);`);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(runManaged(process.execPath, [script], '', { env: process.env, signal: controller.signal, timeoutMs: 5000 }), /cancelled/);
  const pid = Number(await readFile(pidFile, 'utf8'));
  try { assert.match(await readFile(`/proc/${pid}/status`, 'utf8'), /^State:\s+Z/m); }
  catch (error) { assert.match(String(error), /ENOENT/); }
});

test('formal runner cleans a POSIX descendant after the parent exits normally', { skip: process.platform === 'win32' }, async () => {
  const root = await project();
  const pidFile = path.join(root, 'exit-child.pid');
  const script = path.join(root, 'exit-parent.mjs');
  await writeFile(script, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();console.log('done');`);
  const completed = await runManaged(process.execPath, [script], '', { env: process.env, timeoutMs: 5000 });
  assert.equal(completed.code, 0);
  const pid = Number(await readFile(pidFile, 'utf8'));
  try { assert.match(await readFile(`/proc/${pid}/status`, 'utf8'), /^State:\s+Z/m); }
  catch (error) { assert.match(String(error), /ENOENT/); }
});

test('frozen local checks honor 1/2/3 concurrency and retain the same mathematical result', async () => {
  const root = await project();
  await writeFile(path.join(root, 'claims.qmd'), [1, 2, 3].map((i) => result(`lem-${i}`, `Synthetic claim ${i}.`, { proofText: `Synthetic argument ${i}.` })).join('\n'));
  const events = path.join(root, 'events.log');
  const script = path.join(root, 'slow-verifier.mjs');
  await writeFile(script, `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';let input='';for await(const chunk of process.stdin)input+=chunk;
const id=JSON.parse(input).target.id;appendFileSync(${JSON.stringify(events)},'start '+id+'\\n');
await new Promise(r=>setTimeout(r,200));appendFileSync(${JSON.stringify(events)},'end '+id+'\\n');
console.log(JSON.stringify({verdict:'correct',summary:'Synthetic only',critical_errors:[],gaps:[],nonblocking_comments:[],repair_hints:''}));`);
  await writeFile(path.join(root, '.qmd-prover', 'config.yml'), `verification:\n  backend: command\n  command: ${JSON.stringify([process.execPath, script])}\n`);
  const before = process.env.QMD_PROVER_VERIFIER;
  delete process.env.QMD_PROVER_VERIFIER;
  try {
    const compilation = await compileProject(root, { ...options, write: false });
    const context = await verificationContext(compilation);
    const signatures: string[] = [];
    for (const jobs of [1, 2, 3]) {
      await writeFile(events, '');
      const run = await verifyFacts(await compileProject(root, { ...options, write: false }), context, { ...options, write: false, jobs, recheck: true });
      signatures.push(JSON.stringify(run.facts.map((fact) => [fact.id, fact.local_verification.status, fact.global_verification.status])));
      const lines = (await readFile(events, 'utf8')).trim().split('\n');
      let active = 0, maximum = 0;
      for (const line of lines) { active += line.startsWith('start ') ? 1 : -1; maximum = Math.max(maximum, active); }
      assert.equal(maximum, jobs);
      assert.equal(run.verification.verifier_calls, 3);
    }
    assert.equal(new Set(signatures).size, 1);
  } finally {
    if (before === undefined) delete process.env.QMD_PROVER_VERIFIER; else process.env.QMD_PROVER_VERIFIER = before;
  }
});

test('parallel downstream conditional check runs despite a rejected upstream proof', async () => {
  const root = await project();
  await writeFile(path.join(root, 'chain.qmd'), [
    result('lem-upstream', 'Synthetic upstream claim.', { proofText: 'INVALID synthetic step.' }),
    result('lem-downstream', 'Synthetic downstream claim.', { proofText: 'Use @lem-upstream.' })
  ].join('\n'));
  await writeFile(path.join(root, '.qmd-prover', 'config.yml'), `verification:\n  backend: command\n  command: ${JSON.stringify([process.execPath, verifier])}\n`);
  const checked = await inspectProject(root, { ...options, jobs: 2, projectStatus: false });
  const byId = new Map(checked.facts.map((fact) => [fact.id, fact]));
  assert.equal(checked.verification.verifier_calls, 2);
  assert.equal(byId.get('lem-upstream')?.local_verification.status, 'rejected');
  assert.equal(byId.get('lem-downstream')?.local_verification.status, 'verified');
  assert.equal(byId.get('lem-downstream')?.global_verification.status, 'blocked');
  const checks = path.join(root, '.qmd-prover', 'verification', 'checks');
  const records = await Promise.all((await readdir(checks)).map(async (name) => JSON.parse(await readFile(path.join(checks, name), 'utf8')) as { target: string; packet: { dependencies: Array<Record<string, unknown>> } }));
  const packet = records.find((record) => record.target === 'lem-downstream')!.packet;
  assert.equal('proof' in packet.dependencies[0], false);
  assert.equal('status' in packet.dependencies[0], false);
});
