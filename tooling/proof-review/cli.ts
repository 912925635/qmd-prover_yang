import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import { reviewRecord } from './review.js';
import { saveReport } from './report.js';

const usage = 'node --import tsx tooling/proof-review/cli.ts --record <project/.qmd-prover/verification/checks/key.json> --policy <policy.json>';

/** No top-level qmd-prover dispatcher change; this is checkout-only experimental tooling. */
export async function main(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(`${usage}\n`); return 0; }
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--record', '--policy'].includes(args[i]) || !args[i + 1] || flags.has(args[i])) throw new Error(usage);
    flags.set(args[i], args[i + 1]);
  }
  if (!flags.has('--record') || !flags.has('--policy')) throw new Error(usage);
  const record = await realpath(path.resolve(flags.get('--record')!));
  const checks = path.dirname(record);
  if (path.basename(checks) !== 'checks' || path.basename(path.dirname(checks)) !== 'verification'
    || path.basename(path.dirname(path.dirname(checks))) !== '.qmd-prover') throw new Error('Record must be under .qmd-prover/verification/checks/');
  const projectRoot = path.dirname(path.dirname(path.dirname(checks)));
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let report;
  try { report = await reviewRecord(record, path.resolve(flags.get('--policy')!), { signal: controller.signal }); }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  const directory = await saveReport(projectRoot, report);
  process.stdout.write(`${JSON.stringify({ directory, stage_status: report.stage_status, outcome: report.outcome })}\n`);
  // 0 means this preparation stage completed, never mathematical acceptance.
  return report.stage_status === 'ready_for_proof_review' ? 0 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}
