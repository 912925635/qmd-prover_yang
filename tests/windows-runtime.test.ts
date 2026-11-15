import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('Windows cold helper initialization is safe across processes and simultaneous callers', { skip: process.platform !== 'win32', timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'qmd cold runtime '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = path.join(root, `long application data ${'x'.repeat(105)}`);
  const scope = createHash('sha256').update(path.resolve(local).toLowerCase()).digest('hex').slice(0, 16);
  const cache = path.join(tmpdir(), `qmd-formal-${scope}`);
  t.after(() => rm(cache, { recursive: true, force: true }));
  const probe = path.join(root, 'probe.mjs');
  const runner = process.env.QMD_TEST_RUNNER
    ? pathToFileURL(process.env.QMD_TEST_RUNNER).href
    : new URL('../skills/qmd-prover/src/core/infrastructure/process.ts', import.meta.url).href;
  await writeFile(probe, `import { runManaged } from ${JSON.stringify(runner)};
const replies = await Promise.all([1,2].map(async () => {
  const result = await runManaged(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], 'cold runtime ∀x∈ℂ', { env: process.env, timeoutMs: 5000 });
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}));
console.log(JSON.stringify(replies));`);
  const run = () => new Promise<string[]>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', probe], {
      env: { ...process.env, LOCALAPPDATA: local }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error(`Cold helper process exited ${code}: ${stderr}`)); return; }
      try { resolve(JSON.parse(stdout) as string[]); } catch (error) { reject(error); }
    });
  });
  const replies = await Promise.allSettled(Array.from({ length: 6 }, run));
  assert.deepEqual(replies.filter((reply) => reply.status === 'rejected'), [], JSON.stringify(replies));
  for (const reply of replies) {
    if (reply.status === 'fulfilled') assert.deepEqual(reply.value, ['cold runtime ∀x∈ℂ', 'cold runtime ∀x∈ℂ']);
  }
  const runtime = cache;
  const versions = await readdir(runtime);
  assert.equal(versions.length, 1);
  assert.deepEqual(await readdir(path.join(runtime, versions[0])), ['windows-job.exe']);
  assert.deepEqual(await run(), ['cold runtime ∀x∈ℂ', 'cold runtime ∀x∈ℂ']);
});
