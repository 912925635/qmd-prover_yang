import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { atomicJson, exists, readJson, sha256 } from '../infrastructure/files.js';
import { hasErrorCode } from '../shared/core.js';
import { workbenchRoot } from './attempts.js';
const active = new AsyncLocalStorage();
async function reconcileJournals(root) {
    const commits = path.join(workbenchRoot(root), 'commits');
    let entries = [];
    try {
        entries = await readdir(commits);
    }
    catch (error) {
        if (!hasErrorCode(error, 'ENOENT'))
            throw error;
    }
    const pointer = await readJson(path.join(root, '.qmd-prover', 'graphs', 'latest.json'), {});
    for (const id of entries.filter((entry) => /^[0-9a-f-]{36}$/iu.test(entry))) {
        const file = path.join(commits, id, 'journal.json');
        const journal = await readJson(file);
        if (journal.state !== 'prepared')
            continue;
        if (pointer.commit_id === id && pointer.file) {
            const snapshotFile = path.resolve(root, pointer.file);
            if (!snapshotFile.startsWith(path.join(root, '.qmd-prover', 'graphs') + path.sep)
                || sha256(await readFile(snapshotFile)) !== journal.snapshot_hash)
                throw new Error(`Published generation integrity failed for commit ${id}`);
            await atomicJson(file, { ...journal, state: 'published', recovered_at: new Date().toISOString() });
        }
        else
            await atomicJson(file, { ...journal, state: 'abandoned-before-pointer', recovered_at: new Date().toISOString() });
    }
}
function isLive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return !hasErrorCode(error, 'ESRCH');
    }
}
export async function coordinatorState(root) {
    const lock = path.join(workbenchRoot(await realpath(root)), 'coordinator.lock');
    try {
        await stat(lock);
    }
    catch (error) {
        if (hasErrorCode(error, 'ENOENT'))
            return 'free';
        throw error;
    }
    const file = path.join(lock, 'owner.json');
    let owner;
    try {
        owner = JSON.parse(await readFile(file, 'utf8'));
    }
    catch {
        return 'unknown';
    }
    if (typeof owner.host_id !== 'string' || typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid <= 0)
        return 'unknown';
    if (owner.host_id !== hostname())
        return 'foreign';
    return isLive(owner.pid) ? 'live' : 'orphaned';
}
export async function recoverCoordinator(root, reason) {
    if (!reason.trim())
        throw new Error('Explicit recovery requires a reason');
    root = await realpath(root);
    const state = await coordinatorState(root);
    if (state !== 'orphaned')
        throw new Error(`Coordinator recovery refused: owner state is ${state}`);
    const lock = path.join(workbenchRoot(root), 'coordinator.lock');
    const archive = path.join(workbenchRoot(root), 'recovered', randomUUID());
    await mkdir(path.dirname(archive), { recursive: true });
    const shortLock = path.join(root, '.qmd-prover', 'write.lock');
    let shortLockArchive = null;
    if (await exists(shortLock)) {
        shortLockArchive = path.join(workbenchRoot(root), 'recovered-write', randomUUID());
        await mkdir(path.dirname(shortLockArchive), { recursive: true });
        await rename(shortLock, shortLockArchive);
    }
    await rename(lock, archive);
    await atomicJson(path.join(archive, 'recovery.json'), { schema_version: 1, reason, recovered_at: new Date().toISOString(),
        stale_short_lock_archive: shortLockArchive ? path.relative(root, shortLockArchive).split(path.sep).join('/') : null,
        recovered_by: { host_id: hostname(), pid: process.pid } });
    return { archive: path.relative(root, archive).split(path.sep).join('/') };
}
export async function assertCoordinator(root) {
    const owner = active.getStore();
    if (!owner || owner.root !== await realpath(root))
        throw new Error('A coordinator is required for a formal state write');
    const file = path.join(workbenchRoot(owner.root), 'coordinator.lock', 'owner.json');
    const recorded = JSON.parse(await readFile(file, 'utf8'));
    if (recorded.token !== owner.token)
        throw new Error('Coordinator ownership changed before commit');
}
/** An exclusive lifetime lease. A crashed owner is never removed by elapsed time alone. */
export async function withCoordinator(root, runId, operation) {
    root = await realpath(root);
    const nested = active.getStore();
    if (nested?.root === root) {
        await assertCoordinator(root);
        return operation();
    }
    const lock = path.join(workbenchRoot(root), 'coordinator.lock');
    await mkdir(path.dirname(lock), { recursive: true });
    try {
        await mkdir(lock);
    }
    catch (error) {
        if (hasErrorCode(error, 'EEXIST'))
            throw new Error(`Another coordinator owns this project: ${lock}. Inspect its owner before explicit recovery.`);
        throw error;
    }
    const token = randomUUID();
    const ownership = { root, token, run_id: runId };
    const owner = { schema_version: 1, host_id: hostname(), pid: process.pid, process_started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(), run_id: runId, token, acquired_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() };
    let timer;
    try {
        await atomicJson(path.join(lock, 'owner.json'), owner);
        await reconcileJournals(root);
        timer = setInterval(() => { void atomicJson(path.join(lock, 'owner.json'), { ...owner, heartbeat_at: new Date().toISOString() }).catch(() => { }); }, 1000);
        timer.unref();
        return await active.run(ownership, operation);
    }
    finally {
        if (timer)
            clearInterval(timer);
        try {
            const current = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'));
            if (current.token === token)
                await rm(lock, { recursive: true, force: true });
        }
        catch { /* A replacement owner must never be removed. */ }
    }
}
