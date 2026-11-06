import { object, strings, text } from './packet.js';
import type { RecordedPacket } from './packet.js';
import type { Anchor, Decomposition, ProofObligation } from './types.js';

export function readAnchor(value: unknown, sources: Record<string, string>): Anchor {
  const raw = object(value, 'anchor');
  const source = text(raw.source, 'anchor.source');
  const { start, end } = raw;
  if (!Object.hasOwn(sources, source) || !Number.isInteger(start) || !Number.isInteger(end)
    || (start as number) < 0 || (end as number) <= (start as number) || (end as number) > sources[source].length
    || !sources[source].slice(start as number, end as number).trim()) throw new Error(`Invalid source anchor: ${source}`);
  // Check an optional legacy quote, then discard it; offsets reference the canonical corpus.
  if (raw.quoted_text !== undefined && raw.quoted_text !== sources[source].slice(start as number, end as number)) {
    throw new Error(`Anchor quotation mismatch: ${source}`);
  }
  return { source, start: start as number, end: end as number };
}

function isTarget(anchor: Anchor, sources: Record<string, string>): boolean {
  return anchor.source === 'target.statement' && anchor.start === 0 && anchor.end === sources['target.statement'].length;
}

export interface GranularityGuard { min_inference_obligations?: number; max_span_paragraphs?: number }

/** Provenance, granularity and declared-chain checks; never a mathematical validity test. */
export function readDecomposition(value: unknown, input: RecordedPacket, maxObligations: number, guard: GranularityGuard = {}): Decomposition {
  const raw = object(value, 'decomposition');
  const statement = readAnchor(raw.target_statement, input.sources);
  if (!isTarget(statement, input.sources)) throw new Error('Target statement anchor must cover the exact full target');
  const finalId = text(raw.final_obligation_id, 'final_obligation_id');
  if (!Array.isArray(raw.obligations) || !raw.obligations.length || raw.obligations.length > maxObligations) {
    throw new Error('Obligation count outside policy limit');
  }
  const proof = input.sources['target.proof'];
  const seen = new Map<string, ProofObligation>();
  let cursor = 0;
  const obligations: ProofObligation[] = raw.obligations.map((value: unknown, index: number) => {
    const item = object(value, 'obligation');
    const id = text(item.id, 'obligation.id');
    if (id !== `${input.context.target.id}#step-${index + 1}`) throw new Error('Obligation IDs must follow source order');
    if (item.kind !== 'inference' && item.kind !== 'context') throw new Error('Obligation kind must be inference or context');
    const span = readAnchor(item.source_span, input.sources);
    if (span.source !== 'target.proof' || span.start < cursor || proof.slice(cursor, span.start).trim()) {
      throw new Error('Proof spans overlap, are out of order, or omit source text');
    }
    const paragraphs = proof.slice(span.start, span.end).split(/\r?\n[\t ]*\r?\n/u).filter((part) => part.trim()).length;
    if (paragraphs > (guard.max_span_paragraphs ?? 1)) throw new Error('Granularity guard: obligation spans too many proof paragraphs');
    cursor = span.end;
    const dependencies = strings(item.internal_dependencies, 'internal_dependencies');
    if (new Set(dependencies).size !== dependencies.length || dependencies.some((dep) => !seen.has(dep))) {
      throw new Error('Internal dependency must reference a distinct earlier obligation');
    }
    if (!Array.isArray(item.premises)) throw new Error('premises must be an array');
    const premises = item.premises.map((p: unknown) => readAnchor(p, input.sources));
    for (const premise of premises) {
      if (premise.source === 'target.statement') throw new Error('Target statement is a goal, never an obligation premise');
      if (premise.source === 'target.proof') {
        if (premise.end > span.end) throw new Error('Forward proof premise');
        if (premise.start < span.start) {
          const owner = [...seen.values()].find((prior) => prior.source_span.start <= premise.start && prior.source_span.end >= premise.end);
          if (!owner || !dependencies.includes(owner.id)) throw new Error('Earlier proof premise must have an explicit dependency edge');
        }
      }
    }
    const conclusion = readAnchor(item.conclusion, input.sources);
    if (id === finalId) {
      if (item.kind !== 'inference' || !isTarget(conclusion, input.sources)) throw new Error('Final inference must conclude the entire exact target statement');
    } else if (!(conclusion.source === 'target.proof' && conclusion.start >= span.start && conclusion.end <= span.end)) {
      throw new Error('Non-final conclusion must belong to its own proof span');
    }
    const obligation: ProofObligation = { id, kind: item.kind, source_span: span, premises, conclusion,
      inference: text(item.inference, 'inference'), internal_dependencies: dependencies };
    seen.set(id, obligation);
    return obligation;
  });
  if (proof.slice(cursor).trim()) throw new Error('Decomposition omits the end of the proof');
  if (obligations.at(-1)!.id !== finalId) throw new Error('final_obligation_id must identify the last source-ordered obligation');
  const inferences = obligations.filter((item) => item.kind === 'inference');
  if (inferences.length < (guard.min_inference_obligations ?? 2)) throw new Error('Granularity guard: too few inference obligations; one-step exemptions require trusted policy');
  const ancestors = new Set<string>();
  const visit = (id: string): void => {
    if (ancestors.has(id)) return;
    ancestors.add(id);
    seen.get(id)!.internal_dependencies.forEach(visit);
  };
  visit(finalId);
  if (inferences.some((item) => !ancestors.has(item.id))) throw new Error('Load-bearing inference is disconnected from the final obligation');
  return { target_statement: statement, final_obligation_id: finalId, obligations };
}
