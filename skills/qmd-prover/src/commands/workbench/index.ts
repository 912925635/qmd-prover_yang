import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { atomicWrite } from '../../core/infrastructure/files.js';
import { auxLayout } from '../../core/infrastructure/auxiliary.js';
import { listAttempts, readAttempt, readRollout, codexHome, UUID } from '../../core/workbench/attempts.js';
import { bindSource, sourceStatus, reviewSource } from '../../core/workbench/bindings.js';
import { codexInvocation } from '../../verifiers/codex-events.js';
import { listVerifications } from '../verification/index.js';
import { compileProject } from '../../core/semantic/compiler.js';
import { verificationContext } from '../../core/verification/protocol.js';
import { readPublishedSnapshot } from '../../core/graph/snapshot.js';
import type { JsonObject, OperationResult, CompilerOptions } from '../../core/shared/types.js';
import type { Command } from '../../cli/parse.js';

export async function listSessions(root: string, factId?: string): Promise<OperationResult> {
  const records = await listAttempts(root, factId);
  const cached = await listVerifications(root);
  const seen = new Set(records.attempts.map((record) => record.attempt_id));
  const legacy = ((cached.submissions ?? []) as JsonObject[]).filter((record) => !seen.has(record.attempt_id) && (!factId || record.target === factId.replace(/^@/u, ''))).map((record) => ({
    attempt_id: record.attempt_id ?? null, fact_id: record.target, verification_record: record.file,
    session_id: null, trace_kind: record.attempt_id ? 'unavailable' : 'legacy', mathematical_outcome: record.outcome
  }));
  return { operation: 'workbench-sessions-list', ok: records.diagnostics.length === 0 && cached.ok !== false,
    sessions: [...records.attempts, ...legacy], diagnostics: [...records.diagnostics, ...((cached.diagnostics ?? []) as JsonObject[])] };
}

export async function showSession(root: string, id: string, source: 'events' | 'rollout' = 'events'): Promise<OperationResult> {
  const record = await readAttempt(root, id);
  if (source === 'rollout') {
    const rollout = await readRollout(record.execution);
    return { operation: 'workbench-session-show', ok: true, attempt_id: id, source: 'native-rollout', ...rollout };
  }
  const content = record.artifacts.includes('codex-events.jsonl') ? await readFile(path.join(record.directory, 'codex-events.jsonl'), 'utf8') : null;
  return { operation: 'workbench-session-show', ok: true, attempt_id: id, source: 'exec-events', sealed: record.sealed,
    execution: record.execution, input: record.input, report: record.report, content,
    ...(content === null ? { note: 'No sealed Codex event stream was retained; this is not a full native conversation.' } : {}) };
}

export async function resumeSession(root: string, id: string, launch = false): Promise<OperationResult> {
  const record = await readAttempt(root, id);
  const e = record.execution;
  if (!record.sealed || e.backend !== 'codex' || typeof e.session_id !== 'string' || !UUID.test(e.session_id)) throw new Error('No sealed, unambiguous Codex session is available to resume');
  if (e.host_id !== hostname() || e.codex_home !== codexHome()) throw new Error('Resume on the recorded host with its original CODEX_HOME');
  const cwd = String(e.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error('Original session working directory is unavailable');
  const invocation = codexInvocation(String(e.executable || 'codex'), ['resume', e.session_id, '--sandbox', 'read-only']);
  const descriptor = { ...invocation, cwd, purpose: 'discussion', updates_mathematical_state: false, may_invoke_model: true };
  if (!launch) return { operation: 'workbench-session-resume', ok: true, launched: false, launch: descriptor, note: 'Use --launch explicitly to continue this conversation. A new mathematical check requires a fresh verification.' };
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { cwd, stdio: 'inherit', shell: false });
    child.on('error', reject); child.on('close', resolve);
  });
  return { operation: 'workbench-session-resume', ok: code === 0, launched: true, exit_code: code, purpose: 'discussion', updates_mathematical_state: false };
}

const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

export async function renderWorkbench(root: string, options: CompilerOptions = {}): Promise<OperationResult> {
  const sessions = await listSessions(root);
  const sources = await sourceStatus(root, undefined, options);
  const compiled = await compileProject(root, { ...options, write: false });
  const context = await verificationContext(compiled);
  const snapshot = await readPublishedSnapshot(compiled, context.contextHash);
  const math = new Map(snapshot?.graph.nodes.map((node) => [node.id, node.status]) ?? []);
  const directory = path.join(auxLayout(root).generated, 'workbench');
  const rows: string[] = [];
  for (const session of sessions.sessions as JsonObject[]) {
    const id = session.attempt_id;
    let link = '原生会话信息不可用';
    if (typeof id === 'string' && UUID.test(id)) {
      try {
        const shown = await showSession(root, id);
        const code = `qmd-prover workbench sessions resume ${id} --launch`;
        const original = `qmd-prover workbench sessions show ${id} --source rollout`;
        const html = `<!doctype html><meta charset="utf-8"><title>执行记录 ${escape(id)}</title><h1>执行记录</h1><p>自留事件不是完整原生会话。继续对话用于讨论，不更新数学判定。</p><h2>原生会话只读查看</h2><pre>${escape(original)}</pre><h2>继续讨论（显式执行，可能产生模型调用）</h2><pre>${escape(code)}</pre><h2>执行元数据</h2><pre>${escape(JSON.stringify(shown.execution, null, 2))}</pre><h2>原始事件</h2><pre>${escape(shown.content ?? '没有保留事件流')}</pre><h2>报告</h2><pre>${escape(JSON.stringify(shown.report, null, 2))}</pre>`;
        await atomicWrite(path.join(directory, `${id}.html`), html);
        link = `<a href="workbench/${id}.html">查看执行记录与会话操作</a>`;
      } catch (error) { link = escape(error); }
    }
    rows.push(`<tr><td>${escape(session.fact_id)}</td><td>${escape(session.backend)}</td><td>${escape(session.requested_model)}</td><td>${escape(session.requested_effort)}</td><td>${escape(math.get(String(session.fact_id)) ?? '无当前数学快照')}</td><td>${escape(session.sealed === false ? '未封存（运行中或已中断）' : session.state)}</td><td>${escape(session.session_id)}</td><td>${link}</td></tr>`);
  }
  const bindingRows = (sources.bindings as JsonObject[]).map((binding) => `<tr><td>${escape(binding.fact_id)}</td><td>${escape(binding.binding_id)}</td><td>${escape(binding.binding_status)}</td><td>${escape(binding.error ?? JSON.stringify(binding.unresolved))}</td></tr>`).join('');
  const output = path.join(auxLayout(root).generated, 'workbench.html');
  const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>证明审查追溯</title><style>body{font:16px system-ui;margin:2rem;line-height:1.6}table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:.5rem;text-align:left;overflow-wrap:anywhere}pre{white-space:pre-wrap}a{color:#1565c0}</style><h1>证明审查追溯</h1><p>只读报告。执行状态、稿件一致性与数学状态分别记录。数学列来自当前有效快照；历史尝试不会被当作新的数学判定。会话操作在终端显式执行。</p><h2>执行与会话</h2><table><tr><th>目标</th><th>后端</th><th>配置模型</th><th>推理强度</th><th>当前数学状态</th><th>执行状态</th><th>会话 ID</th><th>记录</th></tr>${rows.join('')}</table><h2>稿件绑定</h2><table><tr><th>目标</th><th>绑定 ID</th><th>稿件状态</th><th>说明</th></tr>${bindingRows}</table><p>aligned 表示记录范围内的一致性审查，不表示数学证明通过。stale 不会自行清除数学缓存。</p></html>`;
  await atomicWrite(output, html);
  return { operation: 'workbench-render', ok: sessions.ok !== false, output: path.relative(root, output).split(path.sep).join('/'), session_count: rows.length,
    binding_count: (sources.bindings as JsonObject[]).length, diagnostics: sessions.diagnostics };
}

export async function runWorkbench(root: string, command: Extract<Command, { kind: 'workbench' }>, options: CompilerOptions): Promise<OperationResult> {
  switch (command.action) {
    case 'sessions-list': return listSessions(root, command.fact);
    case 'sessions-show': return showSession(root, command.id, command.source);
    case 'sessions-resume': return resumeSession(root, command.id, command.launch);
    case 'sources-bind': return bindSource(root, command.id, command.manifest, options);
    case 'sources-status': return sourceStatus(root, command.fact, options);
    case 'sources-review': return reviewSource(root, command.id, command.settings, options);
    case 'render': return renderWorkbench(root, options);
    default: return command satisfies never;
  }
}
