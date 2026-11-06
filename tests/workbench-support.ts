import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type test from 'node:test';
import { project, result } from './support.js';

export const sessionId = '12345678-1234-1234-1234-123456789abc';
export const verdict = { verdict: 'correct', summary: 'Mock only.', critical_errors: [], gaps: [], nonblocking_comments: [], repair_hints: '', refutation: '' };
export const alignment = { statement_alignment: 'consistent', proof_coverage: 'complete', explanation: 'Synthetic statement and argument correspond without added assumptions.', issues: [] };

export async function workbenchProject(t: test.TestContext) {
  const root = await project();
  const previous = { home: process.env.CODEX_HOME, verifier: process.env.QMD_PROVER_VERIFIER };
  const home = path.join(root, 'synthetic-codex-home');
  await mkdir(home);
  process.env.CODEX_HOME = home;
  delete process.env.QMD_PROVER_VERIFIER;
  t.after(() => {
    if (previous.home === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous.home;
    if (previous.verifier === undefined) delete process.env.QMD_PROVER_VERIFIER; else process.env.QMD_PROVER_VERIFIER = previous.verifier;
  });
  await writeFile(path.join(root, 'work.qmd'), result('lem-trace', 'A test claim.', { proofText: 'A test argument.' }));
  return { root, home };
}

export async function fakeCodex(root: string, settings: { failure?: boolean; alignment?: boolean; response?: unknown; mutate?: string } = {}): Promise<string> {
  const file = path.join(root, 'mock codex.mjs');
  const code = `#!/usr/bin/env node
import fs from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='resume'){fs.writeFileSync(${JSON.stringify(path.join(root, 'resumed.txt'))},JSON.stringify(args));process.exit(0);}
if(args[0]!=='exec'||!args.includes('--json')||args.at(-1)!=='-'||!args.includes('read-only'))throw Error('Unexpected Codex argv');
let input='';process.stdin.setEncoding('utf8');for await(const chunk of process.stdin)input+=chunk;
if(!input.length)throw Error('Expected stdin prompt');
fs.appendFileSync(${JSON.stringify(path.join(root, 'calls.txt'))},'call\n');
const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
emit({type:'thread.started',thread_id:${JSON.stringify(sessionId)}});
${settings.mutate ? `fs.appendFileSync(${JSON.stringify(settings.mutate)},'\n% changed during review\n');` : ''}
${settings.failure ? `emit({type:'turn.failed',error:{message:'insufficient credits (mock)'}});process.exitCode=1;` : `emit({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(${JSON.stringify(settings.response ?? (settings.alignment ? alignment : verdict))})}});emit({type:'turn.completed',usage:{input_tokens:40,cached_input_tokens:10,output_tokens:8}});`}
`;
  // Embed escaped newlines in generated JavaScript string literals.
  await writeFile(file, code.replace("'call\n'", "'call\\n'").replace("'\n% changed during review\n'", "'\\n% changed during review\\n'"), { mode: 0o755 });
  return file;
}

export async function codexConfig(root: string, executable: string): Promise<void> {
  await writeFile(path.join(root, '.qmd-prover', 'config.yml'), `verification:\n  backend: codex\n  executable: ${JSON.stringify(executable.replaceAll('\\', '/'))}\n  model: mock-only\n  effort: high\n`);
}
