import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { compileProject } from '../skills/qmd-prover/src/core/semantic/compiler.js';
import { verifyFacts, writeStatusProjection } from '../skills/qmd-prover/src/core/graph/verify.js';
import { describeSourceDrift } from '../skills/qmd-prover/src/core/graph/snapshot.js';
import { verificationContext } from '../skills/qmd-prover/src/core/verification/protocol.js';
import { inspectProject } from '../skills/qmd-prover/src/commands/inspect/index.js';
import { must, options, project, result, staleVerifier, verifier } from './support.js';

test('a genuine mid-run edit is SOURCE_STALE, names what drifted, and still counts the discarded call cost', async () => {
  const root = await project();
  const file = path.join(root, 'work.qmd');
  await writeFile(file, result('lem-stale-live', 'A checkable claim.', { proofText: 'A full argument.' }));
  const ready = path.join(root, '.qmd-prover', 'stale-ready');
  process.env.QMD_PROVER_VERIFIER = staleVerifier;
  process.env.QMD_PROVER_VERIFIER_READY = ready;
  try {
    const pending = inspectProject(root, options);
    // Wait for the verifier to signal it holds the packet, then edit a source before it answers.
    const deadline = Date.now() + 10000;
    for (;;) {
      try { await readFile(ready); break; }
      catch {
        if (Date.now() > deadline) throw new Error('the stale verifier never signalled readiness');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    const edited = [
      result('lem-stale-live', 'A checkable claim.', { proofText: 'A full argument.' }),
      result('lem-appeared-mid-run', 'A claim added during the check.', { proofText: 'Another argument.' })
    ].join('\n');
    await writeFile(file, edited);
    const inspected = await pending;
    const fact = must(inspected.facts.find((item) => item.id === 'lem-stale-live'));
    assert.equal(fact.local_verification.status, 'not-run');
    assert.equal(fact.local_verification.reason, 'verifier-error');
    const details = JSON.stringify(fact);
    assert.ok(details.includes('SOURCE_STALE'), details);
    // The diagnostic names the drifted component instead of only reporting an opaque hash change.
    assert.ok(details.includes('results appeared: @lem-appeared-mid-run'), details);
    // The referee call really happened; discarding its verdict must not erase its recorded cost.
    assert.ok(inspected.verification.verifier_calls >= 1);
    assert.ok(inspected.verification.verifier_duration_ms > 0);
    // The mid-run edit survives inspection untouched: nothing is projected onto drifted bytes.
    assert.equal(await readFile(file, 'utf8'), edited);
  } finally {
    delete process.env.QMD_PROVER_VERIFIER;
    delete process.env.QMD_PROVER_VERIFIER_READY;
  }
});

test('status projection refuses to write onto bytes that changed after compilation', async () => {
  const root = await project();
  const file = path.join(root, 'work.qmd');
  const original = result('lem-projection-guard', 'A guarded claim.', { proofText: 'An argument.' });
  await writeFile(file, original);
  const previousPandoc = process.env.QMD_PROVER_PANDOC;
  // Require the explicitly selected parser for the freshness recompile too.
  // Even a system Pandoc must not hide a dropped CompilerOptions argument.
  process.env.QMD_PROVER_PANDOC = path.join(root, 'missing-fallback-pandoc');
  process.env.QMD_PROVER_VERIFIER = verifier;
  try {
    // Control: with the bytes untouched, the verdict is projected as a status attribute.
    const compilation = await compileProject(root, options);
    const context = await verificationContext(compilation);
    const run = await verifyFacts(compilation, context, options);
    await writeStatusProjection(compilation, run, options);
    const projected = await readFile(file, 'utf8');
    assert.ok(projected.includes('status="verified"'), projected);

    // A concurrent edit lands after verification: the projection must leave the file alone.
    const compilationBefore = await compileProject(root, options);
    const contextBefore = await verificationContext(compilationBefore);
    const runBefore = await verifyFacts(compilationBefore, contextBefore, options);
    const edited = original.replace('An argument.', 'A rewritten argument.');
    await writeFile(file, edited);
    await writeStatusProjection(compilationBefore, runBefore, options);
    assert.equal(await readFile(file, 'utf8'), edited);
  } finally {
    if (previousPandoc === undefined) delete process.env.QMD_PROVER_PANDOC;
    else process.env.QMD_PROVER_PANDOC = previousPandoc;
    delete process.env.QMD_PROVER_VERIFIER;
  }
});

test('describeSourceDrift is null on identical sources and names the changed result otherwise', async () => {
  const root = await project();
  const file = path.join(root, 'work.qmd');
  await writeFile(file, result('lem-drift-probe', 'A stable claim.', { proofText: 'A first argument.' }));
  const before = await compileProject(root, options);
  const beforeContext = await verificationContext(before);
  assert.equal(describeSourceDrift(before, beforeContext.contextHash, before, beforeContext.contextHash), null);

  await writeFile(file, result('lem-drift-probe', 'A stable claim.', { proofText: 'A changed argument.' }));
  const after = await compileProject(root, options);
  const afterContext = await verificationContext(after);
  const drift = must(describeSourceDrift(before, beforeContext.contextHash, after, afterContext.contextHash));
  assert.ok(drift.includes('result content changed: @lem-drift-probe'), drift);
});
