import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsSupervisor } from './proof-review/process.ts';

const asset = fileURLToPath(new URL('../skills/qmd-prover/scripts/core/infrastructure/windows-job.cs', import.meta.url));
mkdirSync(path.dirname(asset), { recursive: true });
copyFileSync(fileURLToPath(new URL('../skills/qmd-prover/src/core/infrastructure/windows-job.cs', import.meta.url)), asset);

// The checkout-only Shadow Review helper uses the Windows .NET Framework compiler.
// Linux builds do not need this helper or a C# compiler.
if (process.platform === 'win32') {
  const source = fileURLToPath(new URL('../skills/qmd-prover/src/core/infrastructure/windows-job.cs', import.meta.url));
  const output = windowsSupervisor().command;
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe');
  mkdirSync(path.dirname(output), { recursive: true });
  execFileSync(compiler, ['/nologo', '/optimize+', '/reference:System.Web.Extensions.dll', `/out:${output}`, source], {
    stdio: 'inherit', windowsHide: true
  });
}
