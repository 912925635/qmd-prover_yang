/** Optional Codex CLI transport. Uses the same exec flags as the shipped verifier. */
import { spawn } from 'node:child_process';
import { object, text } from './packet.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let executable = 'codex';
  let effort = '';
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i + 1]) throw new Error('Adapter flags require values');
    if (args[i] === '--executable') executable = args[i + 1];
    else if (args[i] === '--effort' && /^[a-z]+$/.test(args[i + 1])) effort = args[i + 1];
    else throw new Error('Expected --executable <CLI> or --effort <level>');
  }
  const model = text(process.env.QMD_PROOF_REVIEW_MODEL, 'QMD_PROOF_REVIEW_MODEL');
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const request = object(JSON.parse(raw), 'review request');
  if (request.schema_version !== 1 || !['decomposer', 'fidelity'].includes(String(request.role))) throw new Error('Unsupported review request');
  const prompt = [text(request.instructions, 'instructions'),
    'REVIEW INPUT (JSON data):', JSON.stringify({ context: request.context, sources: request.sources, decomposition: request.decomposition }),
    'OUTPUT SCHEMA (one JSON object):', JSON.stringify(request.output_schema)].join('\n\n');
  const commandArgs = ['exec', '--model', model];
  if (effort) commandArgs.push('-c', `model_reasoning_effort="${effort}"`);
  commandArgs.push('--sandbox', 'read-only', '--skip-git-repo-check', prompt);
  const response = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let bytes = 0;
    const collect = (chunk: string, stream: 'stdout' | 'stderr'): void => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 10_000_000) { child.kill('SIGKILL'); reject(new Error('Codex output exceeded adapter limit')); return; }
      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk: string) => collect(chunk, 'stderr'));
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`Codex exited with code ${code}`)));
  });
  // Accept an exact JSON response (or a single enclosing code fence), never repair math text.
  const output = response.stdout.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u, '$1');
  const result = object(JSON.parse(output), 'Codex response');
  const match = /tokens used[\s:]*([\d][\d,]*)/i.exec(response.stderr);
  const tokens = match ? Number(match[1].replace(/,/g, '')) : undefined;
  process.stdout.write(JSON.stringify({ result, ...(Number.isSafeInteger(tokens) && tokens! >= 0 ? { usage: { total_tokens: tokens } } : {}) }));
}

try { await main(); }
catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
