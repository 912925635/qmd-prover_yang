import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, cleanId, readJson } from '../infrastructure/files.js';
import { withWriteLock } from '../infrastructure/auxiliary.js';
import { readExternalPolicy } from '../infrastructure/external.js';
import { compileProject } from '../semantic/compiler.js';
import { asRecord, hasErrorCode } from '../shared/core.js';
import type { CompilerOptions, JsonObject, OperationResult } from '../shared/types.js';
import { beginAttempt, finishAttempt, inputDigest, UUID, workbenchRoot } from './attempts.js';
import { resolveSpan, sourceContext } from './tex.js';
import type { SourceSelector } from './tex.js';
import { runCodex } from '../../verifiers/codex-events.js';

export interface BindingSpec {
  source_root: string;
  statement: SourceSelector;
  proof_spans: SourceSelector[];
  context_files: string[];
  context_resolutions: Record<string, string>;
  coverage_map: Array<{ source_index: number; qmd_ids: string[] }>;
}
interface Binding { binding_id: string; fact_id: string; spec: BindingSpec; baseline_hash: string; created_at: string; review_refs: Array<{ id: string; hash: string }> }
interface Store { schema_version: 1; bindings: Binding[] }
export interface AlignmentReport {
  statement_alignment: 'consistent' | 'mismatch' | 'inconclusive';
  proof_coverage: 'complete' | 'partial' | 'mismatch' | 'inconclusive';
  explanation: string; issues: string[];
}
const storeFile = (root: string): string => path.join(root, '.qmd-prover', 'source-bindings.json');
const receiptFile = (root: string, binding: string, review: string): string => {
  if (!UUID.test(binding) || !UUID.test(review)) throw new Error('Invalid alignment record identity');
  return path.join(workbenchRoot(root), 'alignment', binding, `${review}.json`);
};

async function readStore(root: string): Promise<Store> {
  try {
    const value = await readJson<Store>(storeFile(root));
    if (value.schema_version !== 1 || !Array.isArray(value.bindings)) throw new Error('Unsupported source binding schema');
    const ids = new Set<string>();
    for (const binding of value.bindings) {
      if (!UUID.test(binding.binding_id) || ids.has(binding.binding_id) || typeof binding.fact_id !== 'string' || !Array.isArray(binding.review_refs)) throw new Error('Invalid source binding record');
      ids.add(binding.binding_id);
    }
    return value;
  } catch (error) { if (hasErrorCode(error, 'ENOENT')) return { schema_version: 1, bindings: [] }; throw error; }
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`${name} must be an array of nonempty strings`);
  return value as string[];
}
function selector(value: unknown): SourceSelector {
  const entry = asRecord(value);
  if (typeof entry.file !== 'string') throw new Error('Each source selector needs a file');
  if (entry.label !== undefined) {
    if (typeof entry.label !== 'string' || !entry.label.trim() || entry.start_byte !== undefined || entry.end_byte !== undefined) throw new Error('A selector uses a label or byte offsets, not both');
    return { file: entry.file, label: entry.label };
  }
  if (!Number.isSafeInteger(entry.start_byte) || !Number.isSafeInteger(entry.end_byte)) throw new Error('A selector needs a label or integer start_byte/end_byte');
  return { file: entry.file, start_byte: Number(entry.start_byte), end_byte: Number(entry.end_byte) };
}

async function parseSpec(root: string, file: string, factId: string): Promise<BindingSpec> {
  const raw = await readJson<JsonObject>(file);
  if (raw.schema_version !== 1 || typeof raw.source_root !== 'string') throw new Error('Binding manifest requires schema_version: 1 and source_root');
  if (!Array.isArray(raw.proof_spans) || raw.proof_spans.length === 0) throw new Error('Binding manifest needs at least one proof span');
  const proof_spans = raw.proof_spans.map(selector);
  const resolutions = asRecord(raw.context_resolutions);
  for (const value of Object.values(resolutions)) if (typeof value !== 'string' || !value.trim()) throw new Error('context_resolutions values must be source-root-relative files');
  const coverage = raw.coverage_map ?? proof_spans.map((_, source_index) => ({ source_index, qmd_ids: [factId] }));
  if (!Array.isArray(coverage)) throw new Error('coverage_map must be an array');
  const coverage_map = coverage.map((item) => {
    const row = asRecord(item);
    if (!Number.isSafeInteger(row.source_index) || Number(row.source_index) < 0 || Number(row.source_index) >= proof_spans.length) throw new Error('Invalid coverage source_index');
    const qmd_ids = strings(row.qmd_ids, 'qmd_ids').map(cleanId);
    if (!qmd_ids.length) throw new Error('Each coverage mapping needs a QMD target');
    return { source_index: Number(row.source_index), qmd_ids };
  });
  const sourceRoot = await realpath(path.resolve(path.dirname(path.resolve(file)), raw.source_root));
  const relativeRoot = path.relative(await realpath(root), sourceRoot);
  return { source_root: (relativeRoot || '.').split(path.sep).join('/'), statement: selector(raw.statement), proof_spans,
    context_files: strings(raw.context_files ?? [], 'context_files'), context_resolutions: resolutions as Record<string, string>, coverage_map };
}

export async function alignmentInput(root: string, factId: string, spec: BindingSpec, options: CompilerOptions = {}): Promise<{ input: JsonObject; hash: string; unresolved: string[] }> {
  const compilation = await compileProject(root, { ...options, write: false });
  if (!compilation.complete || !compilation.ok) throw new Error('QMD has mechanical errors; resolve them before binding source versions');
  const byId = new Map(compilation.manifest.results.map((fact) => [fact.id, fact]));
  if (!byId.has(factId)) throw new Error(`Unknown QMD fact: ${factId}`);
  const selected = new Set<string>();
  const visit = (id: string): void => {
    if (selected.has(id)) return;
    const fact = byId.get(id);
    if (!fact) throw new Error(`Unknown coverage target: ${id}`);
    selected.add(id); fact.dependencies.forEach(visit);
  };
  visit(factId);
  for (const row of spec.coverage_map) row.qmd_ids.forEach(visit);
  const sourceRoot = path.resolve(root, spec.source_root);
  const statement = await resolveSpan(sourceRoot, spec.statement);
  const proofs = await Promise.all(spec.proof_spans.map((span) => resolveSpan(sourceRoot, span)));
  const context = await sourceContext(sourceRoot, [statement.file, ...proofs.map((span) => span.file), ...spec.context_files], spec.context_resolutions);
  const unresolved = [...context.unresolved];
  for (let index = 0; index < proofs.length; index += 1) if (!spec.coverage_map.some((row) => row.source_index === index)) unresolved.push(`Proof span ${index} has no QMD coverage mapping`);
  const input: JsonObject = {
    schema_version: 1, alignment_rules_version: 1, fact_id: factId,
    source: { statement, proof_spans: proofs, context_files: context.files, unresolved }, coverage_map: spec.coverage_map,
    qmd: { facts: [...selected].sort().map((id) => {
      const fact = byId.get(id)!;
      return { id, kind: fact.kind, statement: fact.statement_text, proof: fact.proof_text, statement_hash: fact.statement_hash,
        proof_hash: fact.proof_hash, dependencies: [...fact.dependencies].sort() };
    }), external_basis: await readExternalPolicy(root) }
  };
  return { input, hash: inputDigest(input), unresolved };
}

export async function bindSource(root: string, id: string, manifest: string, options: CompilerOptions = {}): Promise<OperationResult> {
  const factId = cleanId(id);
  const spec = await parseSpec(root, manifest, factId);
  const current = await alignmentInput(root, factId, spec, options);
  const binding: Binding = { binding_id: randomUUID(), fact_id: factId, spec, baseline_hash: current.hash, created_at: new Date().toISOString(), review_refs: [] };
  await withWriteLock(root, async () => {
    const store = await readStore(root);
    store.bindings.push(binding);
    await atomicJson(storeFile(root), store);
  });
  return { operation: 'workbench-source-bind', ok: true, binding_id: binding.binding_id, fact_id: factId,
    alignment_input_hash: current.hash, binding_status: current.unresolved.length ? 'unavailable' : 'needs-review', unresolved: current.unresolved,
    authored_file: '.qmd-prover/source-bindings.json', note: 'Review evidence is required. Existing .gitignore and mathematical state were not changed.' };
}

function normalizeAlignment(value: unknown): AlignmentReport {
  const report = asRecord(value);
  if (!['consistent', 'mismatch', 'inconclusive'].includes(String(report.statement_alignment)) || !['complete', 'partial', 'mismatch', 'inconclusive'].includes(String(report.proof_coverage))) throw new Error('Invalid alignment report statuses');
  if (typeof report.explanation !== 'string' || !report.explanation.trim()) throw new Error('Alignment evidence needs an explanation');
  const issues = strings(report.issues ?? [], 'issues');
  if (report.statement_alignment === 'consistent' && report.proof_coverage === 'complete' && issues.length) throw new Error('Complete alignment cannot retain unresolved issues');
  return { statement_alignment: report.statement_alignment as AlignmentReport['statement_alignment'], proof_coverage: report.proof_coverage as AlignmentReport['proof_coverage'],
    explanation: report.explanation, issues };
}

async function bindingById(root: string, id: string): Promise<Binding> {
  if (!UUID.test(id)) throw new Error('Binding ID must be a UUID');
  const binding = (await readStore(root)).bindings.find((item) => item.binding_id === id);
  if (!binding) throw new Error(`Unknown binding: ${id}`);
  return binding;
}

export async function sourceStatus(root: string, factId?: string, options: CompilerOptions = {}): Promise<OperationResult> {
  const store = await readStore(root);
  const selected = store.bindings.filter((binding) => !factId || binding.fact_id === cleanId(factId));
  const statuses: JsonObject[] = [];
  for (const binding of selected) {
    try {
      const current = await alignmentInput(root, binding.fact_id, binding.spec, options);
      let status = current.unresolved.length ? 'unavailable' : current.hash !== binding.baseline_hash ? 'stale' : 'needs-review';
      let review: JsonObject | null = null;
      if (status === 'needs-review' && binding.review_refs.length) {
        const ref = binding.review_refs.at(-1)!;
        review = await readJson<JsonObject>(receiptFile(root, binding.binding_id, ref.id));
        if (inputDigest(review) !== ref.hash) throw new Error('Alignment evidence integrity check failed');
        if (review.binding_id !== binding.binding_id || review.alignment_input_hash !== current.hash || inputDigest(review.input) !== current.hash) throw new Error('Alignment evidence identity or input hash mismatch');
        const report = normalizeAlignment(review.report);
        status = report.statement_alignment === 'mismatch' || ['partial', 'mismatch'].includes(report.proof_coverage) ? 'mismatch'
          : report.statement_alignment === 'consistent' && report.proof_coverage === 'complete' ? 'aligned' : 'needs-review';
      }
      statuses.push({ binding_id: binding.binding_id, fact_id: binding.fact_id, binding_status: status, alignment_input_hash: current.hash,
        baseline_hash: binding.baseline_hash, unresolved: current.unresolved, review, source_root: binding.spec.source_root });
    } catch (error) {
      statuses.push({ binding_id: binding.binding_id, fact_id: binding.fact_id, binding_status: 'unavailable', error: String(error) });
    }
  }
  return { operation: 'workbench-source-status', ok: true, bindings: statuses,
    ...(selected.length ? {} : { binding_status: 'unbound' }) };
}

export async function reviewSource(root: string, id: string, settings: { evidence?: string; backend?: string; model?: string; effort?: string; executable?: string }, options: CompilerOptions = {}): Promise<OperationResult> {
  const binding = await bindingById(root, id);
  const frozen = await alignmentInput(root, binding.fact_id, binding.spec, options);
  if (frozen.unresolved.length) return { operation: 'workbench-source-review', ok: false, binding_status: 'unavailable', unresolved: frozen.unresolved };
  let report: AlignmentReport;
  let reviewer: JsonObject;
  let attempt;
  if (settings.evidence) {
    const evidence = await readJson<JsonObject>(settings.evidence);
    if (evidence.schema_version !== 1 || evidence.binding_id !== id || evidence.alignment_input_hash !== frozen.hash) throw new Error('Evidence must have schema_version: 1 and name the current binding ID and alignment_input_hash');
    if (typeof evidence.reviewer !== 'string' || !evidence.reviewer.trim()) throw new Error('Human evidence needs a reviewer name');
    report = normalizeAlignment(evidence);
    reviewer = { kind: 'human', name: evidence.reviewer, source: 'user-supplied-attestation' };
  } else {
    if (settings.backend !== 'codex' || !settings.model) throw new Error('AI alignment review requires an explicit --backend codex and --model');
    attempt = await beginAttempt(root, frozen.input, { kind: 'alignment', fact_id: binding.fact_id, binding_id: id, alignment_input_hash: frozen.hash,
      backend: 'codex', requested_model: settings.model, requested_effort: settings.effort || 'high', executable: settings.executable || 'codex' });
    try {
      const prompt = ['Compare the recorded TeX statement/proof with the QMD representation. This is an alignment audit, not mathematical verification.',
        'Check every hypothesis, quantifier, definition, normalization and conclusion. Extra assumptions, stronger/weaker targets, and omitted load-bearing proof steps must be reported.',
        'Do not execute tools, read project files, or use prior sessions. Use only the supplied source corpus. Literal matching or complete span coverage alone is not semantic equivalence.',
        'Return one JSON object: statement_alignment (consistent|mismatch|inconclusive), proof_coverage (complete|partial|mismatch|inconclusive), explanation (nonempty string), issues (string array).',
        JSON.stringify(frozen.input)].join('\n\n');
      const response = await runCodex(prompt, { ...settings, effort: settings.effort || 'high', captureDirectory: attempt.directory });
      report = normalizeAlignment(JSON.parse(response.text));
      reviewer = { kind: 'ai', backend: 'codex', requested_model: settings.model, attempt_id: attempt.id };
      const current = await alignmentInput(root, binding.fact_id, binding.spec, options);
      if (current.hash !== frozen.hash) throw new Error('Source changed during alignment review; result was not applied');
      await finishAttempt(attempt, { alignment_report: report }, 'completed');
    } catch (error) {
      await finishAttempt(attempt, { error: String(error) }, 'failed');
      const statuses = await sourceStatus(root, binding.fact_id, options);
      const previous = (statuses.bindings as JsonObject[]).find((item) => item.binding_id === id);
      return { operation: 'workbench-source-review', ok: false, binding_status: previous?.binding_status ?? 'needs-review', attempt_id: attempt.id, execution_error: String(error) };
    }
  }
  const reviewId = randomUUID();
  await withWriteLock(root, async () => {
    const store = await readStore(root);
    const stored = store.bindings.find((item) => item.binding_id === id);
    if (!stored || inputDigest(stored.spec) !== inputDigest(binding.spec)) throw new Error('Binding changed during review');
    const current = await alignmentInput(root, binding.fact_id, stored.spec, options);
    if (current.hash !== frozen.hash) throw new Error('Source changed before evidence could be saved');
    const receipt = { schema_version: 1, review_id: reviewId, binding_id: id, alignment_input_hash: frozen.hash,
      reviewed_at: new Date().toISOString(), reviewer, report, input: frozen.input };
    await atomicJson(receiptFile(root, id, reviewId), receipt);
    stored.baseline_hash = frozen.hash;
    stored.review_refs.push({ id: reviewId, hash: inputDigest(receipt) });
    await atomicJson(storeFile(root), store);
  });
  return { operation: 'workbench-source-review', ok: true, binding_id: id, review_id: reviewId,
    binding_status: report.statement_alignment === 'mismatch' || ['partial', 'mismatch'].includes(report.proof_coverage) ? 'mismatch'
      : report.statement_alignment === 'consistent' && report.proof_coverage === 'complete' ? 'aligned' : 'needs-review',
    reviewer, report };
}
