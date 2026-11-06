import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { doctorProject } from '../skills/qmd-prover/src/commands/doctor/index.js';
import { executableAvailable, executableInvocation } from '../skills/qmd-prover/src/core/infrastructure/executables.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'qmd-executables-'));
  const names = ['PATH', 'PATHEXT', 'QMD_PROVER_PANDOC', 'QMD_PROVER_VERIFIER'];
  const previous = names.map((name) => [name, process.env[name]] as const);
  t.after(async () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  process.env.PATH = root;
  process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  delete process.env.QMD_PROVER_PANDOC;
  delete process.env.QMD_PROVER_VERIFIER;
  return root;
}

test('executable detection accepts an exact path, including Windows forward slashes', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'exact-tool.exe');
  await writeFile(file, '', { mode: 0o755 });
  assert.equal(await executableAvailable(file), true);
  assert.equal(await executableAvailable(file.split(path.sep).join('/')), true);
});

test('executable detection finds a native command on PATH without an explicit extension', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, process.platform === 'win32' ? 'native-tool.exe' : 'native-tool'), '', { mode: 0o755 });
  assert.equal(await executableAvailable('native-tool'), true);
  assert.equal(await executableAvailable('missing-tool'), false);
});

test('Windows executable detection uses PATHEXT and its default when unset', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'extension-tool.cmd'), '');
  process.env.PATHEXT = '.EXE';
  assert.equal(await executableAvailable('extension-tool'), false);
  process.env.PATHEXT = '.CMD;.EXE';
  assert.equal(await executableAvailable('extension-tool'), true);
  await writeFile(path.join(root, 'fallback-tool.exe'), '');
  delete process.env.PATHEXT;
  assert.equal(await executableAvailable('fallback-tool'), true);
});

test('Windows extensionless paths resolve with either separator without falling back to PATH', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'path-tool.exe'), '');
  assert.equal(await executableAvailable(path.join(root, 'path-tool')), true);
  assert.equal(await executableAvailable(path.join(root, 'path-tool').replaceAll('\\', '/')), true);
  assert.equal(await executableAvailable(path.join(root, 'missing-directory', 'path-tool')), false);
});

test('doctor finds Pandoc on PATH with no explicit Pandoc override', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, process.platform === 'win32' ? 'pandoc.exe' : 'pandoc'), '', { mode: 0o755 });
  const health = await doctorProject(root);
  assert.equal(health.ok, true);
  const dependencies = health.dependencies as Record<string, { available: boolean; command: string }>;
  assert.equal(dependencies.pandoc.available, true);
  assert.equal(dependencies.pandoc.command, 'pandoc');
});

test('Node script invocation preserves Unicode argv and stdin without a shell', async (t) => {
  const root = await fixture(t);
  const script = path.join(root, 'script with spaces.mjs');
  await writeFile(script, `#!${process.execPath}\nlet input='';process.stdin.setEncoding('utf8');for await(const chunk of process.stdin)input+=chunk;process.stdout.write(JSON.stringify({args:process.argv.slice(2),input}));`, { mode: 0o755 });
  const args = ['a b', '∀x∈ℂ', 'quote"and\\slash'];
  const invocation = executableInvocation(script, args);
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(invocation.command, invocation.args, (error, output) => error ? reject(error) : resolve(output));
    child.stdin!.end('Unicode stdin: ∀x∈ℂ');
  });
  assert.deepEqual(JSON.parse(stdout), { args, input: 'Unicode stdin: ∀x∈ℂ' });
  assert.deepEqual(executableInvocation(process.execPath, args), { command: process.execPath, args });
});
