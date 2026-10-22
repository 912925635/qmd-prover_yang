import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function windowsSupervisor(): { command: string; args: string[] } {
  return {
    command: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./windows-job.ps1', import.meta.url))]
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
    });
    child.on('error', (error) => { failure ??= error; });
    child.on('close', (code) => {
      cleanListeners();
      terminate();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Role process exited with code ${code}`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') stop('Could not write role request');
    });
    const header = windows ? `${JSON.stringify({ command: command[0], args: command.slice(1) })}\n` : '';
    child.stdin.end(header + input);
  });
}
