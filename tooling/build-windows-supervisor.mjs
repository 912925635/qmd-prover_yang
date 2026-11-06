import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsSupervisor } from './proof-review/process.ts';

// The checkout-only Shadow Review helper uses the Windows .NET Framework compiler.
// Linux builds do not need this helper or a C# compiler.
if (process.platform === 'win32') {
  const root = fileURLToPath(new URL('./proof-review/', import.meta.url));
  const output = windowsSupervisor().command;
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe');
  mkdirSync(path.dirname(output), { recursive: true });
  execFileSync(compiler, ['/nologo', '/optimize+', '/reference:System.Web.Extensions.dll', `/out:${output}`, path.join(root, 'windows-job.cs')], {
    stdio: 'inherit', windowsHide: true
  });
}
