import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256, stableJson } from '../../skills/qmd-prover/src/core/infrastructure/files.js';
import type { ProofReviewReport } from './types.js';

export function markdownReport(report: ProofReviewReport): string {
  const json = stableJson(report);
  // A fence longer than any run in model-authored content keeps that content quoted.
  const longest = Math.max(2, ...(json.match(/`+/g) ?? []).map((match) => match.length));
  const fence = '`'.repeat(longest + 1);
  return `# Shadow proof review\n\nTarget: ${JSON.stringify(report.target)}\n\nStage: ${report.stage_status}\n\nOutcome: inconclusive. This report does not verify the proof.\n\nApplies only to the recorded packet; current QMD sources were not checked.\n\nThe complete structured report follows.\n\n${fence}json\n${json}${fence}\n`;
}

/** Save a new immutable run directory under the dedicated shadow namespace only. */
export async function saveReport(projectRoot: string, report: ProofReviewReport): Promise<string> {
  const parent = path.join(projectRoot, '.qmd-prover', 'proof-review');
  await mkdir(parent, { recursive: true });
  const key = sha256(stableJson({ packet: report.verifier_packet_hash, policy: report.review_policy_hash }, 0)).slice(7);
  const pending = await mkdtemp(path.join(parent, `.pending-${key}-`));
  const destination = path.join(parent, `${key}-${path.basename(pending).split('-').at(-1)}`);
  try {
    await writeFile(path.join(pending, 'report.json'), stableJson(report));
    await writeFile(path.join(pending, 'report.md'), markdownReport(report));
    await rename(pending, destination);
  } catch (error) {
    await rm(pending, { recursive: true, force: true });
    throw error;
  }
  return destination;
}
