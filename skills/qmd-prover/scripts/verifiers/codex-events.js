import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from '../core/infrastructure/files.js';
import { executableInvocation } from '../core/infrastructure/executables.js';
import { UUID } from '../core/workbench/attempts.js';
import { asRecord } from '../core/shared/core.js';
export function codexInvocation(executable, args) {
    if (process.platform === 'win32' && (executable === 'codex' || ['codex.cmd', 'codex.ps1'].includes(path.basename(executable).toLowerCase()))) {
        const directories = executable === 'codex' ? (process.env.PATH ?? '').split(path.delimiter) : [path.dirname(path.resolve(executable))];
        for (const directory of directories) {
            const native = path.join(directory, 'codex.exe');
            if (existsSync(native))
                return { command: native, args };
            const launcher = path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
            if (existsSync(launcher))
                return { command: process.execPath, args: [launcher, ...args] };
        }
        throw new Error('Codex launcher not found. Set verification.executable to its native .exe or Node .js entrypoint.');
    }
    return executableInvocation(executable, args);
}
export function decodeCodexEvents(raw) {
    let session = null;
    let ambiguousSession = false;
    let message;
    let completed = false;
    let eventError;
    let usage;
    for (const line of raw.split(/\r?\n/u).filter((value) => value.trim())) {
        let event;
        try {
            event = asRecord(JSON.parse(line));
        }
        catch {
            eventError ??= 'Malformed or truncated Codex JSONL event';
            continue;
        }
        if (event.type === 'thread.started') {
            const id = event.thread_id;
            if (typeof id !== 'string' || !UUID.test(id)) {
                eventError ??= 'Invalid Codex session ID';
                ambiguousSession = true;
            }
            else if (session && session !== id) {
                eventError ??= 'Conflicting Codex session IDs';
                ambiguousSession = true;
            }
            else
                session = id;
        }
        if (event.type === 'item.completed') {
            const item = asRecord(event.item);
            if (item.type === 'agent_message' && typeof item.text === 'string')
                message = item.text;
        }
        if (event.type === 'turn.completed') {
            completed = true;
            const original = asRecord(event.usage);
            const counters = {};
            for (const field of ['input_tokens', 'output_tokens', 'cached_input_tokens', 'reasoning_output_tokens', 'total_tokens']) {
                if (typeof original[field] === 'number' && Number.isSafeInteger(original[field]) && Number(original[field]) >= 0)
                    counters[field] = original[field];
            }
            if (counters.total_tokens === undefined && typeof counters.input_tokens === 'number' && typeof counters.output_tokens === 'number')
                counters.total_tokens = counters.input_tokens + counters.output_tokens;
            if (Object.keys(counters).length)
                usage = { ...counters, source: 'backend-reported' };
        }
        if (event.type === 'turn.failed' || event.type === 'error')
            eventError ??= String(asRecord(event.error).message ?? event.message ?? 'Codex turn failed');
    }
    if (!completed || message === undefined)
        eventError ??= 'Codex did not complete a final agent message';
    return { text: message ?? '', execution: {
            session_id: ambiguousSession ? null : session,
            trace_kind: session && !eventError ? 'structured' : 'partial', reported_model: null, reported_effort: null, cli_version: null,
            ...(usage ? { usage } : {}), ...(eventError ? { event_error: eventError } : {})
        } };
}
export async function runCodex(prompt, options) {
    const args = ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check'];
    if (options.model)
        args.push('--model', options.model);
    if (options.effort) {
        if (!/^(low|medium|high|xhigh|max)$/u.test(options.effort))
            throw new Error('Unsupported reasoning effort');
        args.push('-c', `model_reasoning_effort="${options.effort}"`);
    }
    args.push('-');
    const invocation = codexInvocation(options.executable || 'codex', args);
    const result = await new Promise((resolve, reject) => {
        const child = spawn(invocation.command, invocation.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.stdin.on('error', (error) => { if (error.code !== 'EPIPE')
            reject(error); });
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(prompt);
    });
    const decoded = decodeCodexEvents(result.stdout);
    if (options.captureDirectory) {
        // The parent creates this directory. Model output never supplies a destination.
        await readFile(path.join(options.captureDirectory, 'input.json'));
        await writeFile(path.join(options.captureDirectory, 'codex-events.jsonl'), result.stdout, 'utf8');
        await atomicJson(path.join(options.captureDirectory, 'adapter-execution.json'), decoded.execution);
    }
    if (result.code !== 0)
        throw new Error(`codex exited ${result.code}: ${result.stderr.trim() || decoded.execution.event_error || 'execution failed'}`);
    if (decoded.execution.event_error)
        throw new Error(String(decoded.execution.event_error));
    return { text: decoded.text, ...(decoded.execution.usage ? { usage: asRecord(decoded.execution.usage) } : {}) };
}
