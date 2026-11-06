import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseCommand } from '../skills/qmd-prover/src/cli/parse.js';
import { fakePandoc } from './support.js';
import { workbenchProject, fakeCodex, codexConfig } from './workbench-support.js';

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
