import { access, constants } from 'node:fs/promises';
import path from 'node:path';

/** Windows cannot execute Node scripts through a POSIX shebang. Keep argv out of a shell. */
export function executableInvocation(command: string, args: string[]): { command: string; args: string[] } {
  return process.platform === 'win32' && /\.(?:c|m)?js$/iu.test(command)
    ? { command: process.execPath, args: [command, ...args] }
    : { command, args };
}

export async function executableAvailable(command: string): Promise<boolean> {
  const windows = process.platform === 'win32';
  const hasSeparator = command.includes(path.sep) || (windows && command.includes('/'));
  const candidates = hasSeparator
    ? [path.resolve(command)]
    : String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, command));
  // Windows PATH commands commonly omit their executable extension (e.g. pandoc.exe).
  const extensions = windows && !path.extname(command)
    ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  for (const candidate of candidates) {
    for (const extension of extensions) {
      try {
        await access(candidate + extension, constants.X_OK);
        return true;
      } catch { /* Try the next extension or PATH entry. */ }
    }
  }
  return false;
}
