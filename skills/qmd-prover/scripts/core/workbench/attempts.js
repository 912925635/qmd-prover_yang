import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { hostname, homedir } from 'node:os';
import path from 'node:path';
import { atomicJson, readJson, sha256, stableJson } from '../infrastructure/files.js';
import { hasErrorCode } from '../shared/core.js';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const workbenchRoot = (root) => path.join(root, '.qmd-prover', 'workbench', 'v1');
export const codexHome = () => path.resolve(process.env.CODEX_HOME || path.join(homedir(), '.codex'));
export async function beginAttempt(root, input, metadata) {
    const id = randomUUID();
    const directory = path.join(workbenchRoot(root), 'attempts', id);
    await mkdir(directory, { recursive: true });
    const execution = {
        ...metadata, schema_version: 1, attempt_id: id, host_id: hostname(), platform: process.platform,
        cwd: path.resolve(root), codex_home: codexHome(), started_at: new Date().toISOString(),
        state: 'running', session_id: null, trace_kind: 'unavailable'
    };
    await atomicJson(path.join(directory, 'input.json'), input);
    await atomicJson(path.join(directory, 'execution.json'), execution);
    return { id, directory, execution, started: performance.now() };
}
export async function finishAttempt(attempt, report, state) {
    try {
        await readFile(path.join(attempt.directory, 'seal.json'));
        throw new Error('A sealed attempt cannot be rewritten');
    }
    catch (error) {
        if (!hasErrorCode(error, 'ENOENT'))
            throw error;
    }
    let adapter = {};
    try {
        adapter = await readJson(path.join(attempt.directory, 'adapter-execution.json'));
    }
    catch (error) {
        if (!hasErrorCode(error, 'ENOENT'))
            throw error;
    }
    // Only backend-observed fields may cross this side channel. Identity and ownership stay local.
    const observed = {};
    for (const field of ['session_id', 'trace_kind', 'usage', 'reported_model', 'reported_effort', 'cli_version', 'event_error']) {
        if (Object.hasOwn(adapter, field))
            observed[field] = adapter[field];
    }
    if (typeof observed.session_id !== 'string' || !UUID.test(observed.session_id))
        observed.session_id = null;
    const execution = { ...attempt.execution, ...observed, state, finished_at: new Date().toISOString(), duration_ms: performance.now() - attempt.started };
    await atomicJson(path.join(attempt.directory, 'report.json'), report);
    await atomicJson(path.join(attempt.directory, 'execution.json'), execution);
    const hashes = {};
    for (const name of ['input.json', 'execution.json', 'report.json', 'adapter-execution.json', 'codex-events.jsonl']) {
        try {
            hashes[name] = sha256(await readFile(path.join(attempt.directory, name)));
        }
        catch (error) {
            if (!hasErrorCode(error, 'ENOENT'))
                throw error;
        }
    }
    await atomicJson(path.join(attempt.directory, 'seal.json'), { schema_version: 1, attempt_id: attempt.id, hashes });
}
export async function readAttempt(root, id) {
    if (!UUID.test(id))
        throw new Error('An attempt ID must be a UUID');
    const base = path.join(workbenchRoot(root), 'attempts');
    const directory = await realpath(path.join(base, id));
    if (path.dirname(directory) !== await realpath(base))
        throw new Error('Attempt path escapes the workbench');
    let seal = null;
    try {
        seal = await readJson(path.join(directory, 'seal.json'));
    }
    catch (error) {
        if (!hasErrorCode(error, 'ENOENT'))
            throw error;
    }
    if (seal) {
        if (seal.schema_version !== 1 || seal.attempt_id !== id || !seal.hashes)
            throw new Error('Invalid attempt seal');
        for (const required of ['input.json', 'execution.json', 'report.json']) {
            if (!seal.hashes[required])
                throw new Error(`Attempt seal omits ${required}`);
        }
        for (const [name, hash] of Object.entries(seal.hashes)) {
            if (!['input.json', 'execution.json', 'report.json', 'adapter-execution.json', 'codex-events.jsonl'].includes(name))
                throw new Error('Invalid sealed artifact name');
            const file = await realpath(path.join(directory, name));
            if (path.dirname(file) !== directory || sha256(await readFile(file)) !== hash)
                throw new Error(`Attempt integrity check failed: ${name}`);
        }
    }
    const execution = await readJson(path.join(directory, 'execution.json'));
    if (execution.attempt_id !== id)
        throw new Error('Attempt identity mismatch');
    return { directory, execution, input: await readJson(path.join(directory, 'input.json')),
        report: seal ? await readJson(path.join(directory, 'report.json')) : {}, sealed: Boolean(seal), artifacts: seal ? Object.keys(seal.hashes) : [] };
}
export async function listAttempts(root, factId) {
    let entries;
    try {
        entries = await readdir(path.join(workbenchRoot(root), 'attempts'));
    }
    catch (error) {
        if (hasErrorCode(error, 'ENOENT'))
            return { attempts: [], diagnostics: [] };
        throw error;
    }
    const attempts = [];
    const diagnostics = [];
    for (const id of entries.filter((entry) => UUID.test(entry)).sort()) {
        try {
            const record = await readAttempt(root, id);
            if (!factId || record.execution.fact_id === factId.replace(/^@/u, ''))
                attempts.push({ ...record.execution, sealed: record.sealed });
        }
        catch (error) {
            diagnostics.push({ attempt_id: id, code: 'ATTEMPT_INVALID', message: String(error) });
        }
    }
    return { attempts: attempts.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at))), diagnostics };
}
export async function readRollout(execution) {
    if (execution.host_id !== hostname())
        throw new Error('The original session belongs to another host');
    if (execution.codex_home !== codexHome())
        throw new Error('Select the original CODEX_HOME explicitly before reading its session');
    const id = String(execution.session_id ?? '');
    if (!UUID.test(id))
        throw new Error('No unambiguous Codex session ID was recorded');
    const base = await realpath(path.join(codexHome(), 'sessions'));
    const matches = [];
    const visit = async (directory, depth) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory() && depth < 4)
                await visit(file, depth + 1);
            else if (entry.isFile() && entry.name.endsWith(`${id}.jsonl`))
                matches.push(file);
        }
    };
    await visit(base, 0);
    if (matches.length !== 1)
        throw new Error(matches.length ? 'Multiple native session records match this ID' : 'Native session record is unavailable');
    const file = await realpath(matches[0]);
    if (!file.startsWith(base + path.sep))
        throw new Error('Native session path escapes CODEX_HOME/sessions');
    const content = await readFile(file, 'utf8');
    const first = JSON.parse(content.split(/\r?\n/u)[0]);
    if (first.type !== 'session_meta' || first.payload?.id !== id)
        throw new Error('Unsupported or mismatched native session metadata');
    return { path: file, content };
}
export const inputDigest = (input) => sha256(stableJson(input, 0));
