import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, stableJson } from '../../skills/qmd-prover/src/core/infrastructure/files.js';
import { object, strings, text } from './packet.js';
import { windowsSupervisor } from './process.js';
import type { ReviewPolicy, RolePolicy } from './types.js';

function bounded(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${label} must be an integer in [${min}, ${max}]`);
  return value as number;
}

/** File/directory content identity, with only relative names inside directory manifests. */
async function contentHash(file: string): Promise<string> {
  if ((await stat(file)).isFile()) return sha256(await readFile(file));
  const entries = await readdir(file, { withFileTypes: true });
  const children: { name: string; hash: string }[] = [];
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    // Avoid silently omitting a dependency or recursively following directory cycles.
    if (entry.isSymbolicLink()) throw new Error(`Declare resolved implementation files instead of directory symlinks: ${entry.name}`);
    children.push({ name: entry.name, hash: await contentHash(path.join(file, entry.name)) });
  }
  return sha256(stableJson(children, 0));
}

function argumentPath(arg: string): string | null {
  if (arg.startsWith('file:')) return fileURLToPath(arg);
  return path.isAbsolute(arg) ? path.resolve(arg) : null;
}

export interface LoadedPolicy { policy: ReviewPolicy; hash: string; file: string }

/** Hash behavior/content, not installation paths. No automatic result cache is added. */
export async function loadPolicy(file: string): Promise<LoadedPolicy> {
  const absolute = path.resolve(file);
  const raw = object(JSON.parse(await readFile(absolute, 'utf8')), 'policy');
  if (raw.schema_version !== 1) throw new Error('Unsupported review policy schema');
  const roles = object(raw.roles, 'policy.roles');
  const roleIdentities: Record<string, unknown> = {};
  const memo = new Map<string, Promise<string>>();
  const fingerprint = (file: string): Promise<string> => {
    const resolved = path.resolve(file);
    if (!memo.has(resolved)) memo.set(resolved, contentHash(resolved));
    return memo.get(resolved)!;
  };
  async function role(name: string): Promise<RolePolicy> {
    const value = object(roles[name], `roles.${name}`);
    const command = strings(value.command, 'role.command');
    if (!command.length || command.some((arg) => !arg.trim()) || !path.isAbsolute(command[0])) {
      throw new Error('Role command must be an argv array starting with an absolute executable path');
    }
    const files = strings(value.implementation_files, 'implementation_files').map((f) => path.resolve(path.dirname(absolute), f));
    if (!files.length) throw new Error('Declare at least one adapter implementation file or runtime directory');
    const components = new Map<string, string>();
    async function component(file: string): Promise<string> {
      const normalized = path.resolve(file);
      if (!components.has(normalized)) components.set(normalized, `@component-${components.size}`);
      await fingerprint(normalized); // fail closed on a missing declared implementation
      return components.get(normalized)!;
    }
    const normalizedCommand: string[] = [];
    for (const arg of command) {
      const file = argumentPath(arg);
      if (file) normalizedCommand.push(await component(file));
      else normalizedCommand.push(arg);
    }
    const declared = await Promise.all(files.map(component));
    const model = text(value.model, 'role.model');
    const version = text(value.implementation_version, 'implementation_version');
    roleIdentities[name] = {
      command: normalizedCommand, model, implementation_version: version, implementation_components: declared,
      contents: await Promise.all([...components].map(async ([file, id]) => ({ id, hash: await fingerprint(file) })))
    };
    return { command, model, implementation_version: version, implementation_files: files };
  }
  const policy: ReviewPolicy = {
    schema_version: 1,
    max_obligations: bounded(raw.max_obligations, 'max_obligations', 1, 200),
    min_inference_obligations: bounded(raw.min_inference_obligations ?? 2, 'min_inference_obligations', 1, 200),
    max_span_paragraphs: bounded(raw.max_span_paragraphs ?? 1, 'max_span_paragraphs', 1, 200),
    timeout_ms: bounded(raw.timeout_ms, 'timeout_ms', 10, 300_000),
    max_output_bytes: bounded(raw.max_output_bytes, 'max_output_bytes', 1024, 10_000_000),
    roles: { decomposer: await role('decomposer'), fidelity: await role('fidelity') }
  };
  if (policy.min_inference_obligations! > policy.max_obligations) throw new Error('min_inference_obligations exceeds max_obligations');
  const modules = ['types', 'packet', 'prompts', 'decomposition', 'faithfulness', 'policy', 'roles', 'process', 'review', 'report', 'cli', 'codex-adapter'];
  const implementation = await Promise.all([...modules.map((name) => `${name}.ts`), 'windows-job.ps1'].map(async (name) => ({
    name, hash: sha256(await readFile(new URL(`./${name}`, import.meta.url)))
  })));
  const { roles: _locations, ...settings } = policy;
  const runtime = { platform: process.platform, arch: process.arch,
    ...(process.platform === 'win32' ? { supervisor_hash: await fingerprint(windowsSupervisor().command) } : {}) };
  const hash = sha256(stableJson({ settings, roles: roleIdentities, implementation, runtime }, 0));
  return { policy, hash, file: absolute };
}
