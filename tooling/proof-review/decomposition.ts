import { object, strings, text } from './packet.js';
import type { RecordedPacket } from './packet.js';
import type { Anchor, Decomposition, ProofObligation } from './types.js';

export function readAnchor(value: unknown, sources: Record<string, string>): Anchor {
  const raw = object(value, 'anchor');
  const source = text(raw.source, 'anchor.source');
  const quoted = text(raw.quoted_text, 'anchor.quoted_text');
  const { start, end } = raw;
  if (!Object.hasOwn(sources, source) || !Number.isInteger(start) || !Number.isInteger(end)
    || (start as number) < 0 || (end as number) <= (start as number) || (end as number) > sources[source].length
    || sources[source].slice(start as number, end as number) !== quoted) throw new Error(`Invalid source anchor: ${source}`);
  return { source, start: start as number, end: end as number, quoted_text: quoted };
}

/** Structural provenance/coverage checks. These do NOT certify semantic faithfulness. */
export function readDecomposition(value: unknown, input: RecordedPacket, maxObligations: number): Decomposition {
  const raw = object(value, 'decomposition');
  const statement = text(raw.target_statement, 'target_statement');
  if (statement !== input.context.target.statement) throw new Error('Target statement changed during decomposition');
  if (!Array.isArray(raw.obligations) || !raw.obligations.length || raw.obligations.length > maxObligations) {
    throw new Error('Obligation count outside policy limit');
  }
  const proof = input.context.target.proof;
  const seen = new Set<string>();
  let cursor = 0;
  const obligations: ProofObligation[] = raw.obligations.map((value: unknown, index: number) => {
    const item = object(value, 'obligation');
    const id = text(item.id, 'obligation.id');
    if (id !== `${input.context.target.id}#step-${index + 1}`) throw new Error('Obligation IDs must follow source order');
    const span = readAnchor(item.source_span, input.sources);
    if (span.source !== 'target.proof' || span.start < cursor || proof.slice(cursor, span.start).trim()) {
      throw new Error('Proof spans overlap, are out of order, or omit source text');
    }
    cursor = span.end;
    const dependencies = strings(item.internal_dependencies, 'internal_dependencies');
    if (new Set(dependencies).size !== dependencies.length || dependencies.some((dep) => !seen.has(dep))) {
      throw new Error('Internal dependency must reference a distinct earlier obligation');
    }
    if (!Array.isArray(item.premises)) throw new Error('premises must be an array');
    const premises = item.premises.map((p: unknown) => readAnchor(p, input.sources));
    if (premises.some((p) => p.source === 'target.proof' && p.end > span.end)) throw new Error('Forward proof premise');
    const conclusion = readAnchor(item.conclusion, input.sources);
    if (conclusion.source !== 'target.statement' && !(conclusion.source === 'target.proof'
      && conclusion.start >= span.start && conclusion.end <= span.end)) throw new Error('Conclusion must belong to its proof span or target statement');
    seen.add(id);
    return { id, source_span: span, premises, conclusion, inference: text(item.inference, 'inference'), internal_dependencies: dependencies };
  });
  if (proof.slice(cursor).trim()) throw new Error('Decomposition omits the end of the proof');
  return { target_statement: statement, obligations };
}
