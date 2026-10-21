import { object, strings, text } from './packet.js';
import { readAnchor } from './decomposition.js';
import type { Decomposition, FidelityIssue, FidelityReview } from './types.js';

export function readFidelity(value: unknown, decomposition: Decomposition, sources: Record<string, string>): FidelityReview {
  const raw = object(value, 'fidelity');
  if (raw.status !== 'pass' && raw.status !== 'fail' && raw.status !== 'inconclusive') throw new Error('Invalid fidelity status');
  const known = new Set(decomposition.obligations.map((item) => item.id));
  const checked = strings(raw.checked_obligation_ids, 'checked_obligation_ids');
  if (new Set(checked).size !== checked.length || checked.some((id) => !known.has(id))) throw new Error('Invalid fidelity coverage');
  if (typeof raw.target_preserved !== 'boolean' || !Array.isArray(raw.issues)) throw new Error('Malformed fidelity review');
  const issues: FidelityIssue[] = raw.issues.map((value: unknown) => {
    const issue = object(value, 'fidelity issue');
    if (!['added_premise', 'quantifier_shift', 'changed_claim', 'omission', 'other'].includes(String(issue.kind))) throw new Error('Invalid fidelity issue kind');
    if (issue.obligation_id !== null && (typeof issue.obligation_id !== 'string' || !known.has(issue.obligation_id))) throw new Error('Invalid issue obligation');
    if (!Array.isArray(issue.source_refs) || !issue.source_refs.length) throw new Error('Fidelity issue requires source evidence');
    return {
      kind: issue.kind as FidelityIssue['kind'], obligation_id: issue.obligation_id as string | null,
      explanation: text(issue.explanation, 'issue.explanation'),
      source_refs: issue.source_refs.map((ref: unknown) => readAnchor(ref, sources))
    };
  });
  if (raw.status === 'pass' && (!raw.target_preserved || checked.length !== known.size || issues.length)) {
    throw new Error('Fidelity pass requires full review coverage, an unchanged target, and zero issues');
  }
  if (raw.status === 'fail' && !issues.length) throw new Error('Fidelity fail requires a specific sourced issue');
  return {
    status: raw.status, checked_obligation_ids: checked, target_preserved: raw.target_preserved,
    issues, explanation: text(raw.explanation, 'fidelity.explanation')
  };
}
