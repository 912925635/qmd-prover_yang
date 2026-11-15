import { randomUUID } from 'node:crypto';
import { appendFile, readFile, readdir, realpath } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { atomicJson, readJson, sha256, stableJson } from '../infrastructure/files.js';
import { compileProject } from '../semantic/compiler.js';
import { checkerContract, normalizeReport, verificationContext, verificationKey } from '../verification/protocol.js';
import { cachedDecision } from '../verification/cache.js';
import { projectSourceSignature } from '../graph/snapshot.js';
import { inspectProject } from '../../commands/inspect/index.js';
import { buildFactPacket } from '../graph/verify.js';
import { withCoordinator, coordinatorState } from './coordinator.js';
import { readAttempt, workbenchRoot, UUID } from './attempts.js';
export async function planJobs(root, scope, fact, save, options) {
    root = path.resolve(root);
    const compiled = await compileProject(root, { ...options, write: false });
    const context = await verificationContext(compiled);
    const byId = new Map(compiled.manifest.results.map((result) => [result.id, result]));
    const factId = scope === 'fact' ? String(fact ?? '').replace(/^@/u, '') : null;
    if (factId && !byId.has(factId))
        throw new Error(`Unknown fact @${factId}`);
    const selected = new Set();
    const visit = (id) => {
        if (selected.has(id))
            return;
        selected.add(id);
        for (const dep of byId.get(id)?.dependencies ?? [])
            if (byId.has(dep))
                visit(dep);
    };
    if (factId)
        visit(factId);
    else
        for (const id of byId.keys())
            selected.add(id);
    const tasks = [];
    for (const id of [...selected].sort()) {
        try {
            const packet = await buildFactPacket(compiled, context, byId.get(id));
            tasks.push({ task_id: randomUUID(), fact_id: id, packet_hash: sha256(stableJson(packet, 0)), packet });
        }
        catch (error) {
            tasks.push({ task_id: randomUUID(), fact_id: id, packet_hash: null, packet: null, packet_error: String(error) });
        }
    }
    const after = await compileProject(root, { ...options, write: false });
    const afterContext = await verificationContext(after);
    if (projectSourceSignature(after, afterContext.contextHash) !== projectSourceSignature(compiled, context.contextHash))
        throw new Error('Sources changed while preparing the plan');
    const plan = { schema_version: 1, plan_id: randomUUID(), project_root: root,
        source_signature: projectSourceSignature(compiled, context.contextHash), scope, fact_id: factId,
        checker_contract: checkerContract(compiled.config), selected_ids: [...selected].sort(), tasks };
    if (save)
        await atomicJson(path.resolve(root, save), plan);
    return { operation: 'workbench-jobs-plan', ok: true, plan, saved_to: save ?? null, model_calls: 0 };
}
function runFile(root, id) {
    if (!UUID.test(id))
        throw new Error('Run ID must be a UUID');
    return path.join(workbenchRoot(root), 'runs', id, 'run.json');
}
function controlFile(root, id) { return path.join(path.dirname(runFile(root, id)), 'control.json'); }
async function generation(root) {
    const pointer = await readJson(path.join(root, '.qmd-prover', 'graphs', 'latest.json'), {});
    if (!pointer.file && !pointer.commit_id)
        return null;
    if (!pointer.file || pointer.commit_id && !UUID.test(pointer.commit_id))
        throw new Error('Published generation pointer is invalid');
    const graphs = path.join(root, '.qmd-prover', 'graphs');
    const file = path.resolve(root, pointer.file);
    if (!file.startsWith(`${graphs}${path.sep}`) || !(await realpath(file)).startsWith(`${await realpath(graphs)}${path.sep}`)) {
        throw new Error('Published generation path escapes graphs');
    }
    return sha256(stableJson({ pointer, snapshot_hash: sha256(await readFile(file)) }, 0));
}
async function sealedRecovery(root, oldId, plan) {
    const old = await readJson(runFile(root, oldId));
    const tasks = old.tasks;
    if (old.state !== 'running' || old.run_id !== oldId || old.plan_id !== plan.plan_id
        || old.source_signature !== plan.source_signature || !Array.isArray(tasks)
        || tasks.length !== plan.tasks.length || tasks.some((task, i) => task.task_id !== plan.tasks[i].task_id
        || task.fact_id !== plan.tasks[i].fact_id || task.packet_hash !== plan.tasks[i].packet_hash)) {
        throw new Error('Original run no longer matches its frozen plan');
    }
    const dispatched = tasks.some((task) => task.execution !== 'queued');
    if (!dispatched)
        return {};
    if (typeof old.owner_token !== 'string' || !UUID.test(old.owner_token)
        || !Object.hasOwn(old, 'base_generation') || old.base_generation !== await generation(root)) {
        throw new Error('Sealed recovery requires the original owner and unchanged published generation');
    }
    const archives = await readdir(path.join(workbenchRoot(root), 'recovered')).catch(() => []);
    let matchingOwners = 0;
    for (const archive of archives.filter((name) => UUID.test(name))) {
        const directory = path.join(workbenchRoot(root), 'recovered', archive);
        const owner = await readJson(path.join(directory, 'owner.json'), {});
        if (owner.run_id === oldId && owner.token === old.owner_token) {
            const recovery = await readJson(path.join(directory, 'recovery.json'), {});
            if (recovery.schema_version !== 1 || owner.host_id !== hostname() || !Number.isInteger(owner.pid) || Number(owner.pid) <= 0
                || recovery.recovered_by?.host_id !== hostname())
                throw new Error('Original owner has no valid same-host recovery record');
            matchingOwners += 1;
        }
    }
    if (matchingOwners !== 1)
        throw new Error('Original coordinator owner cannot be identified uniquely');
    const found = new Map();
    const attemptRoot = path.join(workbenchRoot(root), 'attempts');
    for (const attemptId of (await readdir(attemptRoot).catch(() => [])).filter((name) => UUID.test(name))) {
        const execution = await readJson(path.join(attemptRoot, attemptId, 'execution.json'), {});
        if (execution.run_id !== oldId)
            continue;
        const attempt = await readAttempt(root, attemptId);
        if (!attempt.sealed || attempt.execution.state !== 'completed')
            throw new Error(`Unknown or incomplete dispatched attempt ${attemptId} cannot be replayed`);
        const task = plan.tasks.find((item) => item.fact_id === attempt.execution.fact_id);
        if (!task || !task.packet || attempt.execution.source_signature !== plan.source_signature
            || attempt.execution.packet_hash !== task.packet_hash
            || attempt.execution.verification_key !== verificationKey(task.packet)
            || stableJson(attempt.input, 0) !== stableJson({ packet: task.packet }, 0)) {
            throw new Error(`Sealed attempt ${attemptId} does not match the frozen input`);
        }
        const raw = attempt.report.report;
        const report = normalizeReport(raw);
        if (stableJson(report, 0) !== stableJson(raw, 0))
            throw new Error(`Sealed attempt ${attemptId} has an incomplete report`);
        const metrics = attempt.report.metrics;
        if (!metrics || typeof metrics.duration_ms !== 'number' || !Number.isFinite(metrics.duration_ms) || metrics.duration_ms < 0) {
            throw new Error(`Sealed attempt ${attemptId} has invalid metrics`);
        }
        const record = { attempt_id: attemptId, packet_hash: task.packet_hash, verification_key: verificationKey(task.packet), report, metrics };
        found.set(task.fact_id, [...(found.get(task.fact_id) ?? []), record]);
    }
    const reports = {};
    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const frozen = plan.tasks[i];
        const attempts = found.get(frozen.fact_id) ?? [];
        if (task.execution === 'queued') {
            if (attempts.length)
                throw new Error('A queued task unexpectedly has a dispatched attempt');
        }
        else if (task.execution === 'reused') {
            if (attempts.length || !frozen.packet || !(await cachedDecision(root, frozen.fact_id, verificationKey(frozen.packet), frozen.packet)).record) {
                throw new Error('Previously reused cache decision is no longer valid');
            }
        }
        else if (task.execution === 'running' || task.execution === 'completed') {
            if (attempts.length !== 1)
                throw new Error('Unknown or ambiguous dispatched call is never automatically resent');
            reports[frozen.fact_id] = attempts[0];
        }
        else
            throw new Error(`Task execution state ${String(task.execution)} cannot be recovered automatically`);
    }
    return reports;
}
async function controlAction(root, id) {
    const control = await readJson(controlFile(root, id), { action: 'run' });
    return control.action ?? 'run';
}
export async function runJobs(root, planFile, jobs, recheck, options, recoverRunId) {
    if (!Number.isInteger(jobs) || jobs < 1 || jobs > 3)
        throw new Error('--jobs must be 1, 2 or 3');
    root = path.resolve(root);
    const plan = await readJson(path.resolve(root, planFile));
    if (plan.schema_version !== 1 || !UUID.test(plan.plan_id) || plan.project_root !== root
        || !['project', 'fact'].includes(plan.scope) || !Array.isArray(plan.selected_ids) || !Array.isArray(plan.tasks)
        || (plan.retry_of_task_id !== undefined && !UUID.test(plan.retry_of_task_id)))
        throw new Error('Invalid workbench plan');
    const compiled = await compileProject(root, { ...options, write: false });
    const context = await verificationContext(compiled);
    if (projectSourceSignature(compiled, context.contextHash) !== plan.source_signature)
        throw new Error('Plan is stale; create a new plan from current sources and config');
    const expected = await planJobs(root, plan.scope, plan.fact_id ?? undefined, undefined, options);
    const expectedIds = expected.plan.selected_ids;
    const expectedTasks = expected.plan.tasks;
    if (JSON.stringify(plan.selected_ids) !== JSON.stringify(expectedIds)
        || stableJson(plan.checker_contract, 0) !== stableJson(checkerContract(compiled.config), 0)
        || plan.tasks.length !== expectedIds.length || plan.tasks.some((task, i) => task.fact_id !== expectedIds[i] || !UUID.test(task.task_id)
        || task.packet_hash !== expectedTasks[i].packet_hash || stableJson(task.packet, 0) !== stableJson(expectedTasks[i].packet, 0)))
        throw new Error('Plan scope, checker contract, or frozen packet is invalid');
    const id = randomUUID();
    return withCoordinator(root, id, async () => {
        const recoveredReports = recoverRunId ? await sealedRecovery(root, recoverRunId, plan) : {};
        const owner = await readJson(path.join(workbenchRoot(root), 'coordinator.lock', 'owner.json'));
        const file = runFile(root, id);
        const eventsFile = path.join(path.dirname(file), 'events.jsonl');
        const event = async (type, detail = {}) => {
            await appendFile(eventsFile, `${JSON.stringify({ schema_version: 1, run_id: id, at: new Date().toISOString(), type, ...detail })}\n`);
        };
        const started = new Date().toISOString();
        const base = { schema_version: 1, run_id: id, plan_id: plan.plan_id, source_signature: plan.source_signature,
            owner_token: owner.token, base_generation: await generation(root), recovered_from_run_id: recoverRunId ?? null,
            scope: plan.scope, selected_ids: plan.selected_ids, jobs, recheck, started_at: started, retry_of_task_id: plan.retry_of_task_id ?? null };
        await atomicJson(path.join(path.dirname(file), 'plan.json'), plan);
        const liveTasks = plan.tasks.map(({ task_id, fact_id, packet_hash }) => ({ task_id, fact_id, packet_hash, execution: 'queued', commit: 'pending' }));
        await atomicJson(file, { ...base, state: 'running', tasks: liveTasks });
        await event('run-started', { plan_id: plan.plan_id, jobs, recheck });
        let taskWrites = Promise.resolve();
        const onTaskEvent = (factId, execution) => {
            taskWrites = taskWrites.then(async () => {
                const task = liveTasks.find((item) => item.fact_id === factId);
                if (!task)
                    throw new Error('Worker task is outside frozen plan');
                task.execution = execution;
                await atomicJson(file, { ...base, state: 'running', tasks: liveTasks });
                await event('task-execution', { task_id: task.task_id, fact_id: factId, execution });
            });
            return taskWrites;
        };
        await atomicJson(controlFile(root, id), { action: 'run', updated_at: started });
        const abort = new AbortController();
        const poll = setInterval(() => { void controlAction(root, id).then((action) => { if (action === 'cancel')
            abort.abort(); }).catch(() => abort.abort()); }, 100);
        poll.unref();
        try {
            const beforeDispatch = async () => {
                while (!abort.signal.aborted) {
                    const action = await controlAction(root, id);
                    if (action === 'cancel') {
                        abort.abort();
                        return false;
                    }
                    if (action === 'run')
                        return true;
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
                return false;
            };
            const result = await inspectProject(root, { ...options, selectedIds: plan.scope === 'fact' ? [plan.fact_id] : undefined,
                jobs, recheck, signal: abort.signal, runId: id, beforeDispatch, onTaskEvent, projectStatus: false, recoveredReports,
                expectedSourceSignature: plan.source_signature,
                onFrozenPackets: async (packets) => {
                    for (const item of packets) {
                        const task = plan.tasks.find((candidate) => candidate.fact_id === item.fact_id);
                        if (!task || task.packet_hash !== item.packet_hash)
                            throw new Error(`Frozen packet changed before dispatch: @${item.fact_id}`);
                    }
                } });
            const byFact = new Map(result.facts.map((fact) => [fact.id, fact]));
            const tasks = plan.tasks.map(({ task_id, fact_id, packet_hash }) => {
                const fact = byFact.get(fact_id);
                const local = fact?.local_verification;
                return { task_id, fact_id, packet_hash, execution: local?.code === 'RUN_CANCELLED' || local?.code === 'cancelled' || local?.latest_execution_error?.code === 'cancelled'
                        ? 'cancelled' : local?.latest_execution_error ? 'failed' : local?.cached ? 'reused' : local?.reason === 'verifier-error' ? 'failed'
                        : local?.status === 'not-run' ? 'skipped' : 'completed',
                    commit: local?.latest_execution_error ? 'superseded' : !result.snapshot_published ? 'discarded-stale'
                        : local?.status === 'not-run' ? 'pending' : 'applied',
                    local_verification: local ?? null, global_verification: fact?.global_verification ?? null };
            });
            const final = { ...base, state: abort.signal.aborted ? 'cancelled' : result.verification.stopped_after ? 'failed' : 'completed',
                finished_at: new Date().toISOString(), snapshot_id: result.snapshot_id, snapshot_published: result.snapshot_published,
                verification: result.verification, tasks };
            await atomicJson(file, final);
            await event('run-finished', { state: final.state, snapshot_id: result.snapshot_id ?? null });
            return { operation: 'workbench-jobs-run', ok: final.state === 'completed' && result.ok, run_id: id, state: final.state,
                snapshot_id: result.snapshot_id, snapshot_published: result.snapshot_published,
                verification: result.verification, tasks };
        }
        catch (error) {
            await atomicJson(file, { ...base, state: 'failed', finished_at: new Date().toISOString(), error: String(error) });
            await event('run-failed', { error: String(error) });
            throw error;
        }
        finally {
            clearInterval(poll);
        }
    });
}
export async function controlJob(root, id, action) {
    const current = await jobStatus(root, id);
    if (!['running', 'paused'].includes(String(current.state)) || await coordinatorState(root) !== 'live')
        throw new Error('Run is not active; an orphaned call is never automatically resent');
    await atomicJson(controlFile(root, id), { action: action === 'resume' ? 'run' : action, updated_at: new Date().toISOString() });
    if (action === 'cancel') {
        for (let i = 0; i < 300; i++) {
            const status = await jobStatus(root, id);
            if (status.state !== 'running' && status.state !== 'paused')
                return { operation: 'workbench-jobs-cancel', ok: status.state === 'cancelled', run_id: id, state: status.state, cleanup_acknowledged: status.state === 'cancelled' };
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return { operation: 'workbench-jobs-cancel', ok: false, run_id: id, state: 'pending', cleanup_acknowledged: false };
    }
    return { operation: `workbench-jobs-${action}`, ok: true, run_id: id, requested_action: action };
}
export async function resumeJob(root, id, options) {
    const status = await jobStatus(root, id);
    if (status.state === 'running' || status.state === 'paused')
        return controlJob(root, id, 'resume');
    if (status.state !== 'orphaned')
        throw new Error('Only a paused or orphaned run can be resumed');
    if (await coordinatorState(root) !== 'free')
        throw new Error('Recover the dead same-host coordinator before resuming an orphaned run');
    return runJobs(root, path.join(path.dirname(runFile(root, id)), 'plan.json'), Number(status.jobs ?? 1), Boolean(status.recheck), options, id);
}
export async function retryTask(root, taskId, options) {
    if (!UUID.test(taskId))
        throw new Error('Task ID must be a UUID');
    const runs = path.join(workbenchRoot(root), 'runs');
    for (const id of await readdir(runs)) {
        if (!UUID.test(id))
            continue;
        const record = await readJson(runFile(root, id));
        const task = record.tasks?.find((entry) => entry.task_id === taskId);
        if (!task)
            continue;
        if (record.state === 'running') {
            const owner = await coordinatorState(root);
            if (owner === 'live')
                throw new Error('Cannot retry a task while its coordinator is active');
            if (owner !== 'free')
                throw new Error('Recover the orphaned same-host coordinator before explicit retry');
        }
        const file = path.join(workbenchRoot(root), 'retries', `${randomUUID()}.json`);
        await planJobs(root, 'fact', String(task.fact_id), file, options);
        const plan = await readJson(file);
        await atomicJson(file, { ...plan, retry_of_task_id: taskId });
        return runJobs(root, file, 1, true, options);
    }
    throw new Error('Task ID was not found in retained runs');
}
export async function jobStatus(root, id) {
    const record = await readJson(runFile(root, id));
    if (record.run_id !== id)
        throw new Error('Run identity mismatch');
    const ownerState = record.state === 'running' ? await coordinatorState(root) : 'free';
    const owner = ownerState === 'live' ? await readJson(path.join(workbenchRoot(root), 'coordinator.lock', 'owner.json'), {}) : {};
    if (record.state === 'running' && (ownerState !== 'live' || owner.run_id !== id)) {
        return { operation: 'workbench-jobs-status', ok: true, ...record, state: 'orphaned', note: 'The coordinator owner is unavailable; unknown dispatched calls require explicit retry.' };
    }
    if (record.state === 'running' && await controlAction(root, id) === 'pause') {
        return { operation: 'workbench-jobs-status', ok: true, ...record, state: 'paused' };
    }
    return { operation: 'workbench-jobs-status', ok: true, ...record };
}
export async function watchJobs(root, selected, emit) {
    const runs = path.join(workbenchRoot(root), 'runs');
    const entries = (await readdir(runs)).filter((entry) => UUID.test(entry));
    const latest = selected ? null : (await Promise.all(entries.map(async (id) => ({ id, record: await readJson(runFile(root, id)) })))).sort((a, b) => String(a.record.started_at ?? '').localeCompare(String(b.record.started_at ?? ''))).at(-1);
    const id = selected ?? latest?.id;
    if (!id)
        throw new Error('No retained workbench run is available');
    let previous = '';
    while (true) {
        const status = await jobStatus(root, id);
        const line = JSON.stringify(status);
        if (line !== previous) {
            emit(`${line}\n`);
            previous = line;
        }
        if (status.state !== 'running' && status.state !== 'paused')
            return;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
}
