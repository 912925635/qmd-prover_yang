#!/usr/bin/env node
// qmd-prover verifier adapter for OpenAI Codex.
//
// Enable with, in .qmd-prover/config.yml:
//   verification:
//     backend: codex
//     executable: ""      # path to the `codex` CLI, or leave blank if it is on PATH
//     model: ""           # "" uses the CLI default, or a concrete model id, e.g. gpt-5-codex
//
// qmd-prover spawns `node codex.js --executable <codex> [--model <id>]` and pipes the
// verification packet to this adapter's stdin. We run the Codex CLI non-interactively
// (`codex exec ...`) — the same entry point the Codex SDK's `thread.run()` drives — and
// return the verdict JSON on stdout.
//
// The `codex` CLI must be installed and authenticated (`codex login` or OPENAI_API_KEY).
// No qmd-prover code changes are needed to point it at a different model or executable —
// only config.
import { codexStateRemediation, runAdapter } from './lib.js';
import { runCodex } from './codex-events.js';
await runAdapter(async (prompt, options) => {
    try {
        return await runCodex(prompt, {
            executable: typeof options.executable === 'string' ? options.executable : 'codex',
            model: typeof options.model === 'string' ? options.model : undefined,
            effort: typeof options.effort === 'string' ? options.effort : undefined,
            captureDirectory: process.env.QMD_PROVER_ATTEMPT_DIR
        });
    }
    catch (error) {
        const detail = String(error instanceof Error ? error.message : error);
        const remediation = codexStateRemediation(detail);
        throw new Error(`${detail}${remediation ? `\n${remediation}` : ''}`);
    }
});
