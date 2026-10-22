import { readFile } from 'node:fs/promises';
import { sha256 } from '../../skills/qmd-prover/src/core/infrastructure/files.js';
import { readRecordedPacket } from './packet.js';
import { readDecomposition } from './decomposition.js';
import { readFidelity } from './faithfulness.js';
import { loadPolicy } from './policy.js';
import { callRole } from './roles.js';
import { DECOMPOSER_PROMPT, FIDELITY_PROMPT, DECOMPOSITION_SCHEMA, FIDELITY_SCHEMA } from './prompts.js';
import type { ProofReviewReport, ReviewRequest } from './types.js';

/** Read-only with respect to the project; the caller may save this independent report. */
export async function reviewRecord(recordFile: string, policyFile: string, options: { signal?: AbortSignal } = {}): Promise<ProofReviewReport> {
  const start = Date.now();
  const input = await readRecordedPacket(recordFile);
  const loaded = await loadPolicy(policyFile);
  const report: ProofReviewReport = {
    schema_version: 2, phase: 'decomposition-and-faithfulness', target: input.context.target.id,
    verifier_packet_hash: input.packet_hash, review_policy_hash: loaded.hash, review_policy: loaded.policy,
    source_identity: input.packet.target.identity, applicability: 'recorded-packet-only', current_source_checked: false,
    sources: input.sources,
    decomposition: null, structural_issues: [], fidelity: null, stage_status: 'inconclusive',
    coverage: { assigned: 0, checked: 0, uncovered: [] }, outcome: 'inconclusive',
    limitations: [
      'This phase checks decomposition and faithfulness only; no proof obligation has been mathematically verified.',
      'The input is a historical recorded packet. Current QMD sources have not been compiled or compared.',
      'Fresh role processes and a temporary working directory do not enforce an OS sandbox or independent model judgments.'
    ],
    calls: [], metrics: { calls: 0, duration_ms: 0 }
  };
  const request: ReviewRequest = {
    schema_version: 2, role: 'decomposer', instructions: DECOMPOSER_PROMPT,
    context: input.context, sources: input.sources, output_schema: DECOMPOSITION_SCHEMA,
    granularity_guard: { min_inference_obligations: loaded.policy.min_inference_obligations!, max_span_paragraphs: loaded.policy.max_span_paragraphs! }
  };
  try {
    const decompositionCall = await callRole(request, loaded.policy, options.signal);
    report.calls.push(decompositionCall);
    if (decompositionCall.status !== 'ok') throw new Error(decompositionCall.error);
    try {
      report.decomposition = readDecomposition(decompositionCall.response, input, loaded.policy.max_obligations, loaded.policy);
      decompositionCall.response = report.decomposition;
    } catch (error) {
      report.stage_status = 'blocked';
      throw error;
    }
    report.coverage.assigned = report.decomposition.obligations.length;
    report.coverage.uncovered = report.decomposition.obligations.map((item) => item.id);
    const fidelityCall = await callRole({
      ...request, role: 'fidelity', instructions: FIDELITY_PROMPT,
      decomposition: report.decomposition, output_schema: FIDELITY_SCHEMA
    }, loaded.policy, options.signal);
    report.calls.push(fidelityCall);
    if (fidelityCall.status !== 'ok') throw new Error(fidelityCall.error);
    report.fidelity = readFidelity(fidelityCall.response, report.decomposition, input.sources);
    fidelityCall.response = report.fidelity;
    report.stage_status = report.fidelity.status === 'pass' ? 'ready_for_proof_review'
      : report.fidelity.status === 'fail' ? 'blocked' : 'inconclusive';
  } catch (error) {
    report.structural_issues.push(error instanceof Error ? error.message : String(error));
  }
  // Detect input/adapter/policy drift during the run, even when an external role failed.
  // This does not establish freshness of the original QMD source.
  try {
    if (sha256(await readFile(recordFile, 'utf8')) !== input.record_hash || (await loadPolicy(policyFile)).hash !== loaded.hash) {
      throw new Error('Recorded packet or review policy/implementation changed during review');
    }
  } catch (error) {
    report.stage_status = 'inconclusive';
    report.structural_issues.push(error instanceof Error ? error.message : String(error));
  }
  report.metrics = {
    calls: report.calls.length, duration_ms: Date.now() - start,
    ...(report.calls.length && report.calls.every((call) => call.reported_total_tokens !== undefined)
      ? { reported_total_tokens: report.calls.reduce((sum, call) => sum + call.reported_total_tokens!, 0) } : {})
  };
  return report;
}
