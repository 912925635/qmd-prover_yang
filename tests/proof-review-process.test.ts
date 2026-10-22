import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeRole } from '../tooling/proof-review/process.js';

async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    if (process.platform !== 'win32') {
      try { if (/^\d+ \(.*\) Z /u.test(await readFile(`/proc/${pid}/stat`, 'utf8'))) return false; } catch { /* non-Linux or exited */ }
    }
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

async function tree(t: test.TestContext, exitAfterReady = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'shadow process tree-'));
  const ready = path.join(directory, 'ready.json');
  const grandchild = path.join(directory, 'grandchild.mjs');
  const child = path.join(directory, 'model-cli.mjs');
  const adapter = path.join(directory, 'adapter.mjs');
  t.after(async () => {
    try { for (const pid of JSON.parse(await readFile(ready, 'utf8')) as number[]) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } } } catch { /* no processes launched */ }
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(grandchild, `import fs from 'node:fs'; fs.writeFileSync(process.argv[2],JSON.stringify([Number(process.argv[3]),Number(process.argv[4]),process.pid])); setInterval(()=>{},1000);`);
  await writeFile(child, `import {spawn} from 'node:child_process'; spawn(process.execPath,[${JSON.stringify(grandchild)},process.argv[2],process.argv[3],String(process.pid)],{stdio:'ignore'}); setInterval(()=>{},1000);`);
  await writeFile(adapter, `import {spawn} from 'node:child_process'; import fs from 'node:fs/promises';
spawn(process.execPath,[${JSON.stringify(child)},process.argv[2],String(process.pid)],{stdio:'ignore'}).unref();
${exitAfterReady ? `for(;;){try{await fs.readFile(process.argv[2]);break;}catch{await new Promise(r=>setTimeout(r,20));}} process.stdout.write('complete');` : 'setInterval(()=>{},1000);'}`);
  const options = { cwd: directory, env: process.env, timeout_ms: 15_000, max_output_bytes: 100_000 };
  return { directory, ready, command: [process.execPath, adapter, ready], options };
}

async function waitReady(file: string): Promise<number[]> {
  const deadline = Date.now() + 12_000;
  for (;;) {
    try { return JSON.parse(await readFile(file, 'utf8')) as number[]; } catch {
      if (Date.now() > deadline) throw new Error('Contained process tree did not start');
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
}

async function assertGone(pids: number[]): Promise<void> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const active = (await Promise.all(pids.map(async (pid) => await alive(pid) ? pid : null))).filter((pid) => pid !== null);
    if (!active.length) return;
    if (Date.now() > deadline) assert.fail(`Live processes remained after cleanup: ${active.join(',')}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

test('role timeout terminates the adapter, model CLI and grandchild process tree', { timeout: 30_000 }, async (t) => {
  const f = await tree(t);
  const pending = executeRole(f.command, '{}', { ...f.options, timeout_ms: process.platform === 'win32' ? 8000 : 1500 });
  const result = assert.rejects(pending, /timed out/);
  const pids = await waitReady(f.ready);
  await result;
  await assertGone(pids);
});

test('AbortSignal cancellation terminates the complete model process tree before returning', { timeout: 30_000 }, async (t) => {
  const f = await tree(t);
  const controller = new AbortController();
  const pending = executeRole(f.command, '{}', { ...f.options, signal: controller.signal });
  const result = assert.rejects(pending, /cancelled/);
  const pids = await waitReady(f.ready);
  controller.abort();
  await result;
  await assertGone(pids);
});

test('a successful adapter cannot leave detached work inside the managed tree', { timeout: 30_000 }, async (t) => {
  const f = await tree(t, true);
  assert.equal(await executeRole(f.command, '{}', f.options), 'complete');
  await assertGone(await waitReady(f.ready));
});

test('pre-cancelled roles launch no process', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(executeRole(['does-not-exist'], '{}', {
    cwd: tmpdir(), env: process.env, timeout_ms: 1000, max_output_bytes: 1024, signal: controller.signal
  }), /cancelled/);
});

test('contained transport preserves large Unicode stdin and difficult Windows argv', { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'shadow quoted args-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'echo.mjs');
  await writeFile(script, `process.stdin.setEncoding('utf8');let input='';for await(const c of process.stdin)input+=c;process.stdout.write(JSON.stringify({bytes:Buffer.byteLength(input),tail:input.slice(-10),args:process.argv.slice(2)}));`);
  const args = ['with spaces', '含数学符号 ∀ ∈', 'embedded"quote', 'backslash\\', 'slash\\"quote', ''];
  const input = 'x'.repeat(2 * 1024 * 1024) + '∀x∈ℂ🧮';
  const response = JSON.parse(await executeRole([process.execPath, script, ...args], input, {
    cwd: directory, env: process.env, timeout_ms: 15_000, max_output_bytes: 4096
  }));
  assert.equal(response.bytes, Buffer.byteLength(input));
  assert.equal(response.tail, input.slice(-10));
  assert.deepEqual(response.args, args);
});
