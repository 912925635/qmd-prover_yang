import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256, stableJson } from '../../skills/qmd-prover/src/core/infrastructure/files.js';
import { object, strings, text } from './packet.js';
import { DECOMPOSER_PROMPT, FIDELITY_PROMPT, DECOMPOSITION_SCHEMA, FIDELITY_SCHEMA } from './prompts.js';
import type { ReviewPolicy, RolePolicy } from './types.js';

function bounded(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${label} must be an integer in [${min}, ${max}]`);
  return value as number;
}

export interface LoadedPolicy { policy: ReviewPolicy; hash: string; file: string }

/** No result cache: the hash is provenance and a report namespace, not a correctness certificate. */
export async function loadPolicy(file: string): Promise<LoadedPolicy> {
  const absolute = path.resolve(file);
  const raw = object(JSON.parse(await readFile(absolute, 'utf8')), 'policy');
  if (raw.schema_version !== 1) throw new Error('Unsupported review policy schema');
  const roles = object(raw.roles, 'policy.roles');
  const fingerprints: Record<string, unknown> = {};
  async function role(name: string): Promise<RolePolicy> {
    const value = object(roles[name], `roles.${name}`);
    const command = strings(value.command, 'role.command');
    if (!command.length || command.some((arg) => !arg.trim()) || !path.isAbsolute(command[0])) {
      throw new Error('Role command must be an argv array starting with an absolute executable path');
    }
    const files = strings(value.implementation_files, 'implementation_files').map((f) => path.resolve(path.dirname(absolute), f));
    if (!files.length) throw new Error('Declare at least one adapter implementation file');
    fingerprints[name] = await Promise.all([...new Set([command[0], ...files])].map(async (f) => ({ file: f, hash: sha256(await readFile(f)) })));
    return {
      command, model: text(value.model, 'role.model'), implementation_version: text(value.implementation_version, 'implementation_version'),
      implementation_files: files
    };
  }
  const policy: ReviewPolicy = {
    schema_version: 1,
    max_obligations: bounded(raw.max_obligations, 'max_obligations', 1, 200),
    timeout_ms: bounded(raw.timeout_ms, 'timeout_ms', 10, 300_000),
    max_output_bytes: bounded(raw.max_output_bytes, 'max_output_bytes', 1024, 10_000_000),
    roles: { decomposer: await role('decomposer'), fidelity: await role('fidelity') }
  };
  // Include this directory's complete implementation, prompts/schemas, adapters, explicit
  // model IDs and routing versions. Remotely hosted weights/config still need version discipline.
  const modules = ['types', 'packet', 'prompts', 'decomposition', 'faithfulness', 'policy', 'roles', 'review', 'report', 'cli', 'codex-adapter'];
  const implementation = await Promise.all(modules.map(async (name) => ({ name, hash: sha256(await readFile(new URL(`./${name}.ts`, import.meta.url))) })));
  const hash = sha256(stableJson({ policy, fingerprints, implementation, DECOMPOSER_PROMPT, FIDELITY_PROMPT, DECOMPOSITION_SCHEMA, FIDELITY_SCHEMA }, 0));
  return { policy, hash, file: absolute };
}
