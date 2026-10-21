import { readFile } from 'node:fs/promises';
import { sha256, stableJson } from '../../skills/qmd-prover/src/core/infrastructure/files.js';
import { VERIFIER_PROTOCOL_VERSION, verificationKey } from '../../skills/qmd-prover/src/core/verification/protocol.js';
import { SCHEMA_VERSION } from '../../skills/qmd-prover/src/core/shared/core.js';
import type { VerifierPacket } from '../../skills/qmd-prover/src/core/verification/protocol.js';
import type { ReviewRequest } from './types.js';

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}

export function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${label} must be a string array`);
  return value;
}

function hash(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^sha256:[a-f0-9]{64}$/.test(result)) throw new Error(`${label} must be a SHA-256 identity`);
  return result;
}

export interface RecordedPacket {
  packet: VerifierPacket;
  packet_hash: string;
  record_hash: string;
  context: ReviewRequest['context'];
  sources: Record<string, string>;
}

/** Read an existing current-schema check record. Never forward its original verdict. */
export async function readRecordedPacket(file: string): Promise<RecordedPacket> {
  const raw = await readFile(file, 'utf8');
  const record = object(JSON.parse(raw), 'record');
  if (record.schema_version !== SCHEMA_VERSION || record.operation !== 'local-conditional-verification') {
    throw new Error(`Expected an existing schema-v${SCHEMA_VERSION} local-conditional-verification record`);
  }
  const packet = object(record.packet, 'packet');
  const protocol = object(packet.protocol, 'packet.protocol');
  if (packet.schema_version !== VERIFIER_PROTOCOL_VERSION || protocol.version !== VERIFIER_PROTOCOL_VERSION
    || protocol.name !== 'qmd-prover-independent-verifier' || packet.task !== 'local-conditional-mathematical-verification') {
    throw new Error('Unsupported verifier packet protocol');
  }
  const target = object(packet.target, 'packet.target');
  if (target.verification_mode !== 'proof') throw new Error('This prototype supports proof-mode records only');
  const id = text(target.id, 'target.id');
  const statement = text(target.statement, 'target.statement');
  const proof = text(target.proof, 'target.proof');
  const identity = object(target.identity, 'target.identity');
  hash(identity.statement_hash, 'statement_hash');
  hash(identity.proof_hash, 'proof_hash');
  if (record.target !== id || record.statement_hash !== identity.statement_hash || record.proof_hash !== identity.proof_hash) {
    throw new Error('Record target/identity does not match its packet');
  }
  const packetHash = sha256(stableJson(packet, 0));
  if (record.packet_hash !== packetHash || record.verification_key !== verificationKey(packet)
    || stableJson(record.checker_contract, 0) !== stableJson(packet.checker_contract, 0)) {
    throw new Error('Record packet hash, verification key, or checker contract mismatch');
  }
  object(packet.checker_contract, 'checker_contract');
  const basis = object(packet.external_basis, 'external_basis');
  if (!['none', 'declared', 'unrestricted'].includes(String(basis.mode))
    || (typeof basis.content !== 'string' && !(basis.mode === 'unrestricted' && basis.content === null))) {
    throw new Error('Invalid external basis');
  }
  if (!Array.isArray(packet.dependencies)) throw new Error('packet.dependencies must be an array');
  const ids = new Set<string>();
  const dependencies = packet.dependencies.map((value: unknown) => {
    const dep = object(value, 'dependency');
    const depId = text(dep.id, 'dependency.id');
    if (depId === id || ids.has(depId)) throw new Error('Duplicate or self dependency');
    ids.add(depId);
    // Whitelist statement-only fields: never forward an upstream proof or status.
    return { id: depId, kind: text(dep.kind, 'dependency.kind'), statement: text(dep.statement, 'dependency.statement') };
  });
  const scope = object(packet.scope, 'scope');
  const scopeIds = strings(scope.direct_dependency_ids, 'scope.direct_dependency_ids');
  if (scope.type !== 'local-conditional-check' || scopeIds.length !== ids.size || new Set(scopeIds).size !== ids.size
    || scopeIds.some((depId) => !ids.has(depId))) throw new Error('Dependency scope mismatch');
  const context: ReviewRequest['context'] = {
    target: { id, kind: text(target.kind, 'target.kind'), statement, proof },
    dependencies,
    external_basis: { mode: String(basis.mode), content: basis.content as string | null },
    checker_contract: packet.checker_contract
  };
  const sources: Record<string, string> = {
    'target.statement': statement,
    'target.proof': proof,
    'external_basis.content': (basis.content as string | null) ?? '',
    ...Object.fromEntries(dependencies.map((dep) => [`dependency:${dep.id}.statement`, dep.statement]))
  };
  return { packet: packet as VerifierPacket, packet_hash: packetHash, record_hash: sha256(raw), context, sources };
}
