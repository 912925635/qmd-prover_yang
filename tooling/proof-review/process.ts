import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function windowsSupervisor(): { command: string; args: string[] } {
  // Build locally under AppData: a checkout on an Internet-zone drive may run
  // binaries at low integrity or reject unsigned scripts. Do not change that policy.
  const source = readFileSync(new URL('./windows-job.cs', import.meta.url));
  const identity = createHash('sha256').update(source).digest('hex');
  const local = process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
  return {
    command: path.join(local, 'qmd-prover', 'shadow-runtime', identity, 'windows-job.exe'),
    args: []
  };
}

/** Await stream closure after timeout/cancellation cleanup, not just a kill request. */
export function executeRole(command: string[], input: string, options: {
  cwd: string; env: NodeJS.ProcessEnv; timeout_ms: number; max_output_bytes: number; signal?: AbortSignal;
}): Promise<string> {
  if (options.signal?.aborted) return Promise.reject(new Error('Role cancelled'));
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const actual = windows ? windowsSupervisor() : { command: command[0], args: command.slice(1) };
    const child = spawn(actual.command, actual.args, {
      cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: !windows, windowsHide: true
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    let failure: Error | null = null;
    let stopped = false;
    const terminate = (): void => {
      if (stopped) return;
      stopped = true;
      if (!windows && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
      } else child.kill('SIGKILL'); // tears down the supervisor's kill-on-close Job
    };
    const stop = (message: string): void => {
      failure ??= new Error(message);
      clearTimeout(timer);
      terminate();
    };
    const abort = (): void => stop('Role cancelled');
    const timer = setTimeout(() => stop('Role timed out; no automatic retry'), options.timeout_ms);
    options.signal?.addEventListener('abort', abort, { once: true });
    const cleanListeners = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.max_output_bytes) stop('Role output exceeded policy limit');
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.max_output_bytes) stop('Role output exceeded policy limit');
      else errors.push(chunk);
    });
    child.on('error', (error) => { failure ??= error; });
    child.on('close', (code) => {
      cleanListeners();
      terminate();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Role process exited with code ${code}: ${Buffer.concat(errors).toString('utf8').trim()}`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') stop('Could not write role request');
    });
    const header = windows ? `${JSON.stringify({ command: command[0], args: command.slice(1) })}\n` : '';
    child.stdin.end(header + input);
  });
}
