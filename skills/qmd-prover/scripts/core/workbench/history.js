import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { auxLayout } from '../infrastructure/auxiliary.js';
import { readJson, sha256, stableJson } from '../infrastructure/files.js';
import { hasErrorCode } from '../shared/core.js';
import { listAttempts, readAttempt, UUID } from './attempts.js';
export async function factHistory(root, fact) {
    const id = fact.replace(/^@/u, '');
    const attempts = await listAttempts(root, id);
    const records = [];
    const layout = auxLayout(root);
    for (const directory of [layout.verification, layout.checks]) {
        let entries = [];
        try {
            entries = await readdir(directory);
        }
        catch (error) {
            if (!hasErrorCode(error, 'ENOENT'))
                throw error;
        }
        for (const name of entries.filter((entry) => entry.endsWith('.json')).sort()) {
            const file = path.join(directory, name);
            const bytes = await readFile(file);
            const record = JSON.parse(bytes.toString('utf8'));
            if (record.target !== id)
                continue;
            const report = record.report;
            records.push({ file: path.relative(root, file).split(path.sep).join('/'), artifact_hash: sha256(bytes),
                attempt_id: record.attempt_id ?? null, submission_id: record.submission_id ?? null,
                verified_at: record.verified_at ?? null, verdict: report?.verdict ?? record.verdict ?? null,
                outcome: record.outcome ?? null, verification_key: record.verification_key ?? null });
        }
    }
    return { operation: 'workbench-history-fact', ok: attempts.diagnostics.length === 0, fact_id: id,
        attempts: attempts.attempts, cache_records: records, diagnostics: attempts.diagnostics };
}
export async function compareAttempts(root, a, b) {
    if (!UUID.test(a) || !UUID.test(b))
        throw new Error('Compare requires two retained attempt UUIDs');
    const left = await readAttempt(root, a);
    const right = await readAttempt(root, b);
    const packet = (record) => {
        const value = record.input.packet;
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    };
    const lp = packet(left), rp = packet(right);
    const completeInput = (value) => Boolean(value && value.target && Array.isArray(value.dependencies)
        && value.external_basis && value.scope && value.checker_contract
        && typeof value.target.proof === 'string'
        && value.target.identity);
    const mathematicalInput = (value) => value ? {
        target: value.target, dependencies: value.dependencies, external_basis: value.external_basis, scope: value.scope
    } : null;
    const report = (record) => {
        const value = record.report.report;
        return value && typeof value === 'object' && !Array.isArray(value) ? value : record.report;
    };
    const lr = report(left), rr = report(right);
    const fields = ['critical_errors', 'gaps', 'nonblocking_comments', 'repair_hints', 'refutation'];
    const changes = Object.fromEntries(fields.map((field) => [field, {
            before: lr[field] ?? null, after: rr[field] ?? null,
            relation: stableJson(lr[field] ?? null, 0) === stableJson(rr[field] ?? null, 0) ? 'unchanged' : 'different'
        }]));
    return { operation: 'workbench-history-compare', ok: true, attempts: [a, b],
        input_relation: completeInput(lp) && completeInput(rp) ? (stableJson(mathematicalInput(lp), 0) === stableJson(mathematicalInput(rp), 0) ? 'same' : 'different') : 'unknown',
        input_hashes: [completeInput(lp) ? sha256(stableJson(mathematicalInput(lp), 0)) : null, completeInput(rp) ? sha256(stableJson(mathematicalInput(rp), 0)) : null],
        contract_relation: lp?.checker_contract && rp?.checker_contract ? (stableJson(lp.checker_contract, 0) === stableJson(rp.checker_contract, 0) ? 'same' : 'different') : 'unknown',
        checker_contracts: [lp?.checker_contract ?? null, rp?.checker_contract ?? null],
        source_versions: [left.execution.source_signature ?? null, right.execution.source_signature ?? null],
        verdicts: [lr.verdict ?? null, rr.verdict ?? null], changes,
        note: 'A missing opinion in the later report is not evidence that it was resolved; comparison does not change a mathematical decision.' };
}
export async function costs(root, runId, ratesFile) {
    const records = await listAttempts(root);
    if (runId && !UUID.test(runId))
        throw new Error('Run ID must be a UUID');
    const math = records.attempts.filter((record) => record.verification_key && (!runId || record.run_id === runId));
    const known = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
    const reported = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
    let unknown = 0;
    for (const record of math) {
        const usage = record.usage;
        if (!usage || typeof usage.total_tokens !== 'number')
            unknown++;
        for (const key of Object.keys(known)) {
            const value = usage?.[key];
            if (typeof value === 'number') {
                known[key] += value;
                reported[key]++;
            }
        }
    }
    let estimate = null;
    if (ratesFile) {
        const bytes = await readFile(ratesFile);
        const rates = await readJson(ratesFile);
        if (typeof rates.source !== 'string' || !rates.source.trim() || typeof rates.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(rates.as_of)
            || typeof rates.currency !== 'string' || !/^[A-Z]{3}$/u.test(rates.currency)
            || !rates.models || typeof rates.models !== 'object' || Array.isArray(rates.models)) {
            throw new Error('Rates require source, as_of date, currency and per-model rates');
        }
        let amount = 0, unknownPrice = 0;
        const models = rates.models;
        const validRate = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
        for (const [model, value] of Object.entries(models)) {
            const price = value;
            if (!model.trim() || !price || typeof price !== 'object' || Array.isArray(price)
                || !validRate(price.input_per_million) || !validRate(price.output_per_million)
                || (price.cached_input_per_million !== undefined && !validRate(price.cached_input_per_million))) {
                throw new Error(`Invalid explicit rate for model ${model}`);
            }
        }
        for (const record of math) {
            const usage = record.usage;
            if (!usage || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number')
                continue;
            const model = String(record.reported_model ?? record.requested_model ?? '');
            const price = models[model];
            const cached = typeof usage.cached_input_tokens === 'number' ? usage.cached_input_tokens : 0;
            if (!price || typeof price.input_per_million !== 'number' || typeof price.output_per_million !== 'number'
                || cached < 0 || cached > usage.input_tokens || (cached > 0 && typeof price.cached_input_per_million !== 'number')) {
                unknownPrice++;
                continue;
            }
            amount += ((usage.input_tokens - cached) * price.input_per_million
                + cached * Number(price.cached_input_per_million ?? 0)
                + usage.output_tokens * price.output_per_million) / 1_000_000;
        }
        estimate = { currency: rates.currency, source: rates.source, as_of: rates.as_of, rates_hash: sha256(bytes),
            known_amount: amount, unknown_price_attempts: unknownPrice, incomplete: unknown > 0 || unknownPrice > 0 };
    }
    return { operation: 'workbench-costs', ok: records.diagnostics.length === 0, run_id: runId ?? null, known_usage: known,
        reported_usage_fields: reported, unknown_usage_attempts: unknown, attempt_count: math.length, estimate, diagnostics: records.diagnostics };
}
