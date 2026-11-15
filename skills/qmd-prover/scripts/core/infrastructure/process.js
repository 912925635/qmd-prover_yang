import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, mkdir, stat, rename, rm, mkdtemp, copyFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const sourceFile = fileURLToPath(new URL('./windows-job.cs', import.meta.url));
const supervisorBuilds = new Map();
async function groupQuiescent(pgid) {
    if (process.platform !== 'linux') {
        try {
            process.kill(-pgid, 0);
            return false;
        }
        catch {
            return true;
        }
    }
    for (const name of await readdir('/proc')) {
        if (!/^\d+$/u.test(name))
            continue;
        let value;
        try {
            value = await readFile(`/proc/${name}/stat`, 'utf8');
        }
        catch {
            continue;
        }
        const fields = value.slice(value.lastIndexOf(') ') + 2).split(' ');
        if (Number(fields[2]) === pgid && fields[0] !== 'Z' && fields[0] !== 'X')
            return false;
    }
    return true;
}
async function waitForGroupCleanup(pgid) {
    const deadline = Date.now() + 1500;
    while (!(await groupQuiescent(pgid))) {
        if (Date.now() >= deadline)
            throw new Error('Verifier process group cleanup could not be confirmed');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
async function windowsSupervisor() {
    const source = await readFile(sourceFile);
    const digest = createHash('sha256').update(source).digest('hex');
    const local = process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
    let output = path.join(local, 'qmd-prover', 'formal-runtime', digest, 'windows-job.exe');
    if (output.length >= 240) {
        // Framework executables cannot reliably launch from extended-length paths.
        // Keep a separate, user-local temp cache for each long application-data root.
        const scope = createHash('sha256').update(path.resolve(local).toLowerCase()).digest('hex').slice(0, 16);
        output = path.join(tmpdir(), `qmd-formal-${scope}`, digest, 'windows-job.exe');
        if (output.length >= 240)
            throw new Error('Windows runtime path is too long; configure a shorter LOCALAPPDATA or TEMP directory');
    }
    const pending = supervisorBuilds.get(output);
    if (pending)
        return pending;
    const build = (async () => {
        const published = async () => {
            try {
                await stat(output);
                return true;
            }
            catch (error) {
                if (error.code === 'ENOENT')
                    return false;
                throw error;
            }
        };
        if (await published())
            return output;
        const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe');
        await mkdir(path.dirname(output), { recursive: true });
        // Independent processes may initialize together. Never compile into the shared
        // executable: publish only a complete image, without waiting on a persistent lock.
        const temporary = path.join(path.dirname(output), `windows-job-${randomUUID()}.exe`);
        // The Framework compiler still has MAX_PATH limits. Compile a local source copy
        // in a short temp directory, then use Node's filesystem APIs for publication.
        const buildDirectory = await mkdtemp(path.join(tmpdir(), 'qmd-job-'));
        try {
            await copyFile(sourceFile, path.join(buildDirectory, 'windows-job.cs'));
            await new Promise((resolve, reject) => execFile(compiler, ['/nologo', '/optimize+', '/reference:System.Web.Extensions.dll', '/out:windows-job.exe', 'windows-job.cs'], { windowsHide: true, cwd: buildDirectory }, (error, stdout, stderr) => error
                ? reject(new Error(`Windows Job supervisor compilation failed: ${error.message}\n${stdout}${stderr}`)) : resolve()));
            await copyFile(path.join(buildDirectory, 'windows-job.exe'), temporary);
            if (!await published()) {
                try {
                    await rename(temporary, output);
                }
                catch (error) {
                    // Windows refuses replacement if a concurrent winner is already running.
                    if (!await published())
                        throw error;
                }
            }
            return output;
        }
        finally {
            try {
                await rm(temporary, { force: true });
            }
            finally {
                await rm(buildDirectory, { recursive: true, force: true });
            }
        }
    })();
    supervisorBuilds.set(output, build);
    try {
        return await build;
    }
    finally {
        supervisorBuilds.delete(output);
    }
}
/** Contains every verifier descendant and waits for stdout/stderr closure on termination. */
export async function runManaged(command, args, input, options) {
    if (options.signal?.aborted)
        throw new Error('Verifier cancelled before launch');
    const windows = process.platform === 'win32';
    const actual = windows ? { command: await windowsSupervisor(), args: [] } : { command, args };
    const start = performance.now();
    return new Promise((resolve, reject) => {
        const child = spawn(actual.command, actual.args, {
            cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: !windows, windowsHide: true, shell: false
        });
        const output = [], errors = [];
        let bytes = 0, failure = null, terminated = false;
        const terminate = () => {
            if (terminated)
                return;
            terminated = true;
            if (!windows && child.pid) {
                try {
                    process.kill(-child.pid, 'SIGKILL');
                }
                catch { /* exited */ }
            }
            else
                child.kill('SIGKILL');
        };
        const fail = (message) => { failure ??= new Error(message); terminate(); };
        const abort = () => fail('Verifier cancelled');
        const timer = setTimeout(() => fail('Verifier timed out'), options.timeoutMs ?? 600_000);
        options.signal?.addEventListener('abort', abort, { once: true });
        child.stdout.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > (options.maxOutputBytes ?? 32_000_000))
                fail('Verifier output exceeded limit');
            else
                output.push(chunk);
        });
        child.stderr.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > (options.maxOutputBytes ?? 32_000_000))
                fail('Verifier output exceeded limit');
            else
                errors.push(chunk);
        });
        child.on('error', (error) => { failure ??= error; });
        child.on('close', async (code, signal) => {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', abort);
            terminate();
            if (!windows && child.pid) {
                try {
                    await waitForGroupCleanup(child.pid);
                }
                catch (error) {
                    failure ??= error;
                }
            }
            if (failure)
                reject(failure);
            else
                resolve({ code, signal, stdout: Buffer.concat(output).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8'), duration_ms: performance.now() - start });
        });
        child.stdin.on('error', (error) => { if (error.code !== 'EPIPE')
            fail('Could not write verifier request'); });
        child.stdin.end((windows ? `${JSON.stringify({ command, args })}\n` : '') + input);
    });
}
