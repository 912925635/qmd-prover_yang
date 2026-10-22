import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256, stableJson } from '../../skills/qmd-prover/src/core/infrastructure/files.js';
import { object } from './packet.js';
import { executeRole } from './process.js';
import type { CallTrace, ReviewPolicy, ReviewRequest } from './types.js';

/** Exactly one fresh process per role. No retries or conversation resumption. */
export async function callRole(request: ReviewRequest, policy: ReviewPolicy, signal?: AbortSignal): Promise<CallTrace> {
  const start = Date.now();
  const requestText = stableJson(request, 0);
  const trace: CallTrace = { role: request.role, request_hash: sha256(requestText), duration_ms: 0, status: 'error' };
  const directory = await mkdtemp(path.join(tmpdir(), 'qmd-shadow-'));
  try {
    const role = policy.roles[request.role];
    const response = await executeRole(role.command, requestText, {
      cwd: directory, timeout_ms: policy.timeout_ms, max_output_bytes: policy.max_output_bytes, signal,
      env: { ...process.env, QMD_PROOF_REVIEW_FRESH_CONTEXT: '1', QMD_PROOF_REVIEW_MODEL: role.model }
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
