import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256, stableJson } from '../../skills/qmd-prover/src/core/infrastructure/files.js';
import { object } from './packet.js';
import type { CallTrace, ReviewPolicy, ReviewRequest } from './types.js';

/** Exactly one fresh process per role. No retries or conversation resumption. */
export async function callRole(request: ReviewRequest, policy: ReviewPolicy): Promise<CallTrace> {
  const start = Date.now();
  const requestText = stableJson(request, 0);
  const trace: CallTrace = { role: request.role, request_hash: sha256(requestText), duration_ms: 0, status: 'error' };
  const directory = await mkdtemp(path.join(tmpdir(), 'qmd-shadow-'));
  try {
    const role = policy.roles[request.role];
    const response = await new Promise<string>((resolve, reject) => {
      const child = spawn(role.command[0], role.command.slice(1), {
        cwd: directory,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        // Authentication stays available to trusted adapters. A temporary cwd is NOT a
        // security sandbox; the adapter is responsible for denying file/network tools.
        env: { ...process.env, QMD_PROOF_REVIEW_FRESH_CONTEXT: '1', QMD_PROOF_REVIEW_MODEL: role.model }
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failure: Error | null = null;
      const terminate = (): void => {
        if (process.platform !== 'win32' && child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
        } else {
          // Windows adapters must terminate any model CLI children on parent exit.
          child.kill('SIGKILL');
        }
      };
      const stop = (message: string): void => {
        failure ??= new Error(message);
        terminate();
        clearTimeout(timer);
        reject(failure);
      };
      const timer = setTimeout(() => stop('Role timed out; no automatic retry'), policy.timeout_ms);
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > policy.max_output_bytes) stop('Role output exceeded policy limit');
        else chunks.push(chunk);
      });
      // Bound stderr too, but do not persist potentially sensitive diagnostics in reports.
      child.stderr.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > policy.max_output_bytes) stop('Role output exceeded policy limit');
      });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => {
        clearTimeout(timer);
        terminate();
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`Role process exited with code ${code}`));
        else resolve(Buffer.concat(chunks).toString('utf8'));
      });
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') stop('Could not write role request');
      });
      child.stdin.end(requestText);
    });
    const envelope = object(JSON.parse(response), 'role response');
    trace.response = envelope.result;
    if (!Object.hasOwn(envelope, 'result')) throw new Error('Role response must contain result');
    if (envelope.usage !== undefined) {
      const usage = object(envelope.usage, 'usage');
      if (typeof usage.total_tokens !== 'number' || !Number.isSafeInteger(usage.total_tokens) || usage.total_tokens < 0) {
        throw new Error('usage.total_tokens must be a nonnegative safe integer');
      }
      trace.reported_total_tokens = usage.total_tokens;
    }
    trace.status = 'ok';
  } catch (error) {
    trace.error = error instanceof Error ? error.message : String(error);
  } finally {
    trace.duration_ms = Date.now() - start;
    await rm(directory, { recursive: true, force: true });
  }
  return trace;
}
