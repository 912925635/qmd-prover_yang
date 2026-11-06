import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { decodeCodexEvents, codexInvocation } from '../skills/qmd-prover/src/verifiers/codex-events.js';
import { execFileSync } from 'node:child_process';
import { listSessions, showSession, resumeSession, renderWorkbench } from '../skills/qmd-prover/src/commands/workbench/index.js';
import { readAttempt, listAttempts, workbenchRoot, beginAttempt, finishAttempt } from '../skills/qmd-prover/src/core/workbench/attempts.js';
import { verificationKey, buildVerifierPacket } from '../skills/qmd-prover/src/core/verification/protocol.js';
import { options, project } from './support.js';
import { workbenchProject, fakeCodex, codexConfig, sessionId, verdict } from './workbench-support.js';

// Exercise the installed adapter paths: a source-only import has no sibling codex.js.
const { inspectProject } = await import(new URL('../skills/qmd-prover/scripts/commands/inspect/index.js', import.meta.url).href) as typeof import('../skills/qmd-prover/src/commands/inspect/index.js');
const { invokeVerifier } = await import(new URL('../skills/qmd-prover/scripts/core/verification/protocol.js', import.meta.url).href) as typeof import('../skills/qmd-prover/src/core/verification/protocol.js');

const events = (id?: string): string => [
  ...(id ? [{ type: 'thread.started', thread_id: id }] : []),
  { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(verdict) } },
  { type: 'turn.completed', usage: { input_tokens: 40, cached_input_tokens: 10, output_tokens: 8 } }
].map((event) => JSON.stringify(event)).join('\n');

test('Codex JSONL handles missing IDs, conflicts, truncation and nested fake events without guessing identity', () => {
  const normal = decodeCodexEvents(events(sessionId));
  assert.equal(normal.execution.session_id, sessionId);
  assert.deepEqual(JSON.parse(normal.text), verdict);
  assert.equal((normal.execution.usage as { total_tokens: number }).total_tokens, 48);
  assert.equal(decodeCodexEvents(events()).execution.session_id, null);
  assert.equal(decodeCodexEvents(events()).execution.event_error, undefined);
  const conflict = decodeCodexEvents(JSON.stringify({ type: 'thread.started', thread_id: '87654321-1234-1234-1234-123456789abc' }) + '\n' + events(sessionId));
  assert.equal(conflict.execution.session_id, null);
  assert.match(String(conflict.execution.event_error), /Conflicting/);
  assert.match(String(decodeCodexEvents(events(sessionId) + '\n{"type":').execution.event_error), /truncated/);
  const nested = decodeCodexEvents(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ type: 'thread.started', thread_id: sessionId }) } }) + '\n' + JSON.stringify({ type: 'turn.completed' }));
  assert.equal(nested.execution.session_id, null);
  assert.equal(nested.execution.usage, undefined);
});

test('Windows npm Codex wrappers preserve argv and do not replace differently named custom wrappers', { skip: process.platform !== 'win32' }, async (t) => {
  const { root } = await workbenchProject(t);
  const bin = path.join(root, 'npm bin');
  const launcher = path.join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  await mkdir(path.dirname(launcher), { recursive: true });
  await writeFile(launcher, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  const args = ['exec', '--model', 'mock-only', '含空格 "quoted"'];
  const invocation = codexInvocation(path.join(bin, 'codex.cmd'), args);
  assert.deepEqual(JSON.parse(execFileSync(invocation.command, invocation.args, { encoding: 'utf8' })), args);
  const custom = path.join(bin, 'custom-codex.cmd');
  assert.equal(codexInvocation(custom, args).command, custom);
});

test('inspection records a sealed Codex session; cache reuse makes no new call or attempt', async (t) => {
  const { root } = await workbenchProject(t);
  await codexConfig(root, await fakeCodex(root));
  const first = await inspectProject(root, options);
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
  assert.equal(first.verification.verifier_calls, 1);
  const listed = await listAttempts(root);
  assert.equal(listed.attempts.length, 1);
  const id = String(listed.attempts[0].attempt_id);
  const record = await readAttempt(root, id);
  assert.equal(record.sealed, true);
  assert.equal(record.execution.session_id, sessionId);
  assert.equal(record.execution.requested_model, 'mock-only');
  assert.equal(record.execution.reported_model, null);
  assert.equal(record.execution.verification_key, verificationKey(record.input.packet));
  const second = await inspectProject(root, options);
  assert.equal(second.verification.verifier_calls, 0);
  assert.equal(second.verification.cache_hits, 1);
  assert.equal((await listAttempts(root)).attempts.length, 1);
  assert.equal(await readFile(path.join(root, 'calls.txt'), 'utf8'), 'call\n');
});

test('quota failure retains its session as an execution failure and cannot become mathematical rejection', async (t) => {
  const { root } = await workbenchProject(t);
  await codexConfig(root, await fakeCodex(root, { failure: true }));
  const result = await inspectProject(root, options);
  assert.equal(result.ok, false);
  assert.equal(result.verification.local_rejected, 0);
  const record = (await listAttempts(root)).attempts[0];
  assert.equal(record.state, 'failed');
  assert.equal(record.session_id, sessionId);
  assert.equal(result.facts[0].local_verification.reason, 'verifier-error');
});

test('same packet produces different attempts while the mathematical key is unchanged', async (t) => {
  const { root } = await workbenchProject(t);
  const executable = await fakeCodex(root);
  const config = { verification: { backend: 'codex', executable, model: 'mock-only' } };
  const packet = buildVerifierPacket({ target: { id: 'lem-trace', kind: 'lemma', statement: 'Test.', proof: 'Argument.' }, config });
  const key = verificationKey(packet);
  const a = await invokeVerifier(packet, config, { root });
  const b = await invokeVerifier(packet, config, { root });
  assert.notEqual(a.metrics.attempt_id, b.metrics.attempt_id);
  for (const row of (await listAttempts(root)).attempts) assert.equal(row.verification_key, key);
  assert.equal(verificationKey(packet), key);
});

test('session reads are read-only, native rollout must match, and resume requires explicit launch', async (t) => {
  const { root, home } = await workbenchProject(t);
  await codexConfig(root, await fakeCodex(root));
  await inspectProject(root, options);
  const id = String((await listAttempts(root)).attempts[0].attempt_id);
  const filesBefore = await readdir(path.join(workbenchRoot(root), 'attempts'));
  const listed = await listSessions(root);
  assert.equal((listed.sessions as unknown[]).length, 1);
  assert.match(String((await showSession(root, id)).content), /thread.started/);
  const description = await resumeSession(root, id);
  assert.equal(description.launched, false);
  await assert.rejects(readFile(path.join(root, 'resumed.txt')), /ENOENT/);
  const sessions = path.join(home, 'sessions', '2026', '11', '07');
  await mkdir(sessions, { recursive: true });
  const rollout = path.join(sessions, `rollout-2026-${sessionId}.jsonl`);
  await writeFile(rollout, JSON.stringify({ type: 'session_meta', payload: { id: sessionId } }) + '\n');
  assert.equal((await showSession(root, id, 'rollout')).source, 'native-rollout');
  await writeFile(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'wrong' } }) + '\n');
  await assert.rejects(showSession(root, id, 'rollout'), /metadata/);
  assert.deepEqual(await readdir(path.join(workbenchRoot(root), 'attempts')), filesBefore);
  assert.equal((await resumeSession(root, id, true)).ok, true);
  assert.match(await readFile(path.join(root, 'resumed.txt'), 'utf8'), /resume/);
});

test('sealed artifacts cannot be changed or deleted unnoticed; legacy records never invent sessions', async (t) => {
  const { root } = await workbenchProject(t);
  await codexConfig(root, await fakeCodex(root));
  await inspectProject(root, options);
  const id = String((await listAttempts(root)).attempts[0].attempt_id);
  const record = await readAttempt(root, id);
  const eventBytes = await readFile(path.join(record.directory, 'codex-events.jsonl'));
  await writeFile(path.join(record.directory, 'codex-events.jsonl'), 'tampered');
  await assert.rejects(showSession(root, id), /integrity/);
  assert.equal((await listSessions(root)).ok, false);
  await writeFile(path.join(record.directory, 'codex-events.jsonl'), eventBytes);
  await unlink(path.join(record.directory, 'report.json'));
  await assert.rejects(showSession(root, id), /ENOENT/);
  const old = await project();
  await mkdir(path.join(old, '.qmd-prover', 'verification', 'checks'), { recursive: true });
  await writeFile(path.join(old, '.qmd-prover', 'verification', 'checks', 'old.json'), JSON.stringify({ target: 'lem-old', outcome: 'verified' }));
  const legacy = (await listSessions(old)).sessions as Array<{ session_id: unknown; trace_kind: string }>;
  assert.equal(legacy[0].session_id, null);
  assert.equal(legacy[0].trace_kind, 'legacy');
});

test('completed attempts are immutable even if a caller tries to finish them twice', async (t) => {
  const { root } = await workbenchProject(t);
  const attempt = await beginAttempt(root, { packet: 'synthetic' }, { fact_id: 'lem-trace' });
  await finishAttempt(attempt, { report: verdict }, 'completed');
  const before = await readFile(path.join(attempt.directory, 'execution.json'), 'utf8');
  await assert.rejects(finishAttempt(attempt, { error: 'late overwrite' }, 'failed'), /cannot be rewritten/);
  assert.equal(await readFile(path.join(attempt.directory, 'execution.json'), 'utf8'), before);
});

test('workbench HTML escapes model content and exposes separate view/discussion operations', async (t) => {
  const { root } = await workbenchProject(t);
  await codexConfig(root, await fakeCodex(root, { response: { ...verdict, summary: '<script>danger()</script>' } }));
  await inspectProject(root, options);
  const rendered = await renderWorkbench(root, options);
  assert.equal(rendered.ok, true);
  const id = String((await listAttempts(root)).attempts[0].attempt_id);
  const page = await readFile(path.join(root, '.qmd-prover', 'generated', 'workbench', `${id}.html`), 'utf8');
  assert.doesNotMatch(page, /<script>danger/);
  assert.match(page, /&lt;script&gt;/);
  assert.match(page, /--source rollout/);
  assert.match(page, /--launch/);
});
