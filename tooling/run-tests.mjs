import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Pass concrete paths to Node: Windows shells do not expand tests/*.test.ts.
const testsDir = fileURLToPath(new URL('../tests/', import.meta.url));
const tests = readdirSync(testsDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
  .map((entry) => path.join(testsDir, entry.name))
  .sort();

if (tests.length === 0) {
  console.error(`No test files found in ${testsDir}`);
  process.exitCode = 1;
} else {
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...tests], { stdio: 'inherit' });
  if (run.error) console.error(run.error);
  process.exitCode = run.status ?? 1;
}
