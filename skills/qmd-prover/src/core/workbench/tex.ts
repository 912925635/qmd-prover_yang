import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../infrastructure/files.js';

export interface SourceSelector { file: string; label?: string; start_byte?: number; end_byte?: number }
export interface SourceSpan {
  file: string; selector: SourceSelector; file_hash: string; span_hash: string;
  start_byte: number; end_byte: number; start_line: number; end_line: number; text: string;
}

export async function sourceFile(root: string, relative: string): Promise<{ file: string; bytes: Buffer; text: string }> {
  if (!relative || path.isAbsolute(relative)) throw new Error('Source file paths must be relative to source_root');
  if (!/\.(tex|ltx|sty|cls|def)$/iu.test(relative)) throw new Error('Source bindings only read TeX source/context files');
  const base = await realpath(root);
  const file = await realpath(path.resolve(base, relative));
  const inside = path.relative(base, file);
  if (inside.startsWith('..' + path.sep) || inside === '..' || path.isAbsolute(inside)) throw new Error('Source path escapes its authorized root');
  const bytes = await readFile(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`Source must use UTF-8: ${relative}`);
  return { file: inside.split(path.sep).join('/'), bytes, text };
}

/** Mask comments/opaque text without changing UTF-16 offsets used by the scanner. */
export function texScanText(text: string): string {
  const blank = (value: string): string => value.replace(/[^\r\n]/g, ' ');
  let result = text.replace(/\\begin\{(verbatim\*?|lstlisting|minted)\}[\s\S]*?\\end\{\1\}/g, blank)
    .replace(/\\verb\*?([^a-zA-Z\s])[\s\S]*?\1/g, blank);
  const chars = result.split('');
  for (let i = 0; i < chars.length; i += 1) {
    if (chars[i] !== '%') continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && chars[j] === '\\'; j -= 1) slashes += 1;
    if (slashes % 2) continue;
    for (; i < chars.length && chars[i] !== '\n' && chars[i] !== '\r'; i += 1) chars[i] = ' ';
  }
  result = chars.join('');
  return result;
}

export async function resolveSpan(root: string, selector: SourceSelector): Promise<SourceSpan> {
  const source = await sourceFile(root, selector.file);
  let start: number; let end: number;
  if (selector.label !== undefined) {
    if (typeof selector.label !== 'string' || !selector.label.trim() || selector.start_byte !== undefined || selector.end_byte !== undefined) throw new Error('Use either a label or byte offsets');
    interface Environment { name: string; start: number; end?: number }
    const stack: Environment[] = [];
    const matches: Array<Environment | null> = [];
    const tokens = /\\(begin|end)\s*\{([^{}]+)\}|\\label\s*\{([^{}]+)\}/g;
    for (const match of texScanText(source.text).matchAll(tokens)) {
      if (match[1] === 'begin') stack.push({ name: match[2], start: match.index });
      else if (match[1] === 'end') {
        const env = stack.pop();
        if (!env || env.name !== match[2]) throw new Error('Unbalanced TeX environments; use explicit byte spans');
        env.end = match.index + match[0].length;
      } else if (match[3] === selector.label) matches.push(stack.at(-1) ?? null);
    }
    if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous label: ${selector.label}` : `Missing label: ${selector.label}`);
    const env = matches[0];
    if (!env || env.end === undefined || env.name === 'document') throw new Error('Label does not identify a closed mathematical environment; use explicit byte spans');
    start = Buffer.byteLength(source.text.slice(0, env.start), 'utf8');
    end = Buffer.byteLength(source.text.slice(0, env.end), 'utf8');
  } else {
    start = selector.start_byte!; end = selector.end_byte!;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > source.bytes.length) throw new Error('Invalid UTF-8 byte span');
  }
  const fragment = source.bytes.subarray(start, end);
  const text = fragment.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(fragment)) throw new Error('Byte span splits a UTF-8 character');
  return { file: source.file, selector, file_hash: sha256(source.bytes), span_hash: sha256(fragment), start_byte: start, end_byte: end,
    start_line: source.bytes.subarray(0, start).toString('utf8').split('\n').length,
    end_line: source.bytes.subarray(0, end).toString('utf8').replace(/\r?\n$/u, '').split('\n').length, text };
}

export async function sourceContext(root: string, files: string[], resolutions: Record<string, string> = {}): Promise<{ files: Array<{ file: string; hash: string; text: string }>; unresolved: string[] }> {
  const visited = new Map<string, { file: string; hash: string; text: string }>();
  const unresolved = new Set<string>();
  const visit = async (relative: string): Promise<void> => {
    const source = await sourceFile(root, relative);
    if (visited.has(source.file)) return;
    visited.set(source.file, { file: source.file, hash: sha256(source.bytes), text: source.text });
    const scan = texScanText(source.text);
    const includes = new Set<number>();
    for (const match of scan.matchAll(/\\(?:input|include)\b\s*(?:\{([^{}]*)\}|([^\s{}]+))/gu)) {
      includes.add(match.index);
      const name = match[1] ?? match[2];
      if (resolutions[`input:${name}`]) { await visit(resolutions[`input:${name}`]); continue; }
      if (!name || /[\\#$]/u.test(name)) { unresolved.add(`${source.file}: dynamic include ${name}`); continue; }
      const file = path.join(path.dirname(source.file), path.extname(name) ? name : `${name}.tex`);
      await visit(file);
    }
    for (const match of scan.matchAll(/\\(?:input|include)\b/gu)) {
      if (!includes.has(match.index)) unresolved.add(`${source.file}: unparsed include at UTF-8 byte ${Buffer.byteLength(source.text.slice(0, match.index), 'utf8')}`);
    }
    // Only project-local packages/classes can be fingerprinted automatically.
    for (const match of scan.matchAll(/\\(usepackage|documentclass)(?:\[[^\]]*\])?\s*\{([^{}]+)\}/gu)) {
      for (const name of match[2].split(',').map((item) => item.trim())) {
        if (resolutions[`${match[1]}:${name}`]) { await visit(resolutions[`${match[1]}:${name}`]); continue; }
        const file = path.join(path.dirname(source.file), `${name}.${match[1] === 'usepackage' ? 'sty' : 'cls'}`);
        try { await visit(file); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') unresolved.add(`${source.file}: external ${match[1]} ${name}`);
          else throw error;
        }
      }
    }
  };
  for (const file of files) await visit(file);
  return { files: [...visited.values()].sort((a, b) => a.file.localeCompare(b.file)), unresolved: [...unresolved].sort() };
}
