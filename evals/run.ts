/**
 * Tool-selection evals: does an agent reach the right tool on a view?
 *
 * Starts this build's HTTP server locally, then runs each task in
 * `evals/tasks.ts` through a real MCP host once per view, and scores what the
 * host called. Hosts: Codex (`codex exec`, the default), which sends most
 * `/pro` traffic and defers MCP tools behind its own search, and Gemini CLI
 * (`gemini -p`, `--host gemini`), which sends every listed tool. A task passes when the agent reaches one of its expected tools,
 * directly or, when the view does not list it, through the dispatcher of its
 * tier, with arguments that tool accepts.
 *
 * Safety: every request carries the proxy's read-only grant
 * (`x-mcp-auth-scope: mcp:pro:read`) and the test location as the only
 * location it may touch (`x-altegio-company-id`). A write is refused by the
 * scope gate after the agent has chosen and called it — which is what is
 * scored — and before anything reaches Altegio. Reads run against the test
 * location.
 *
 *   ALTEGIO_API_TOKEN=… ALTEGIO_USER_TOKEN=… \
 *   ALTEGIO_EVAL_LOCATION_ID=… ALTEGIO_EVAL_TEAM_MEMBER_ID=… \
 *     npm run eval -- [--host codex|gemini] [--views default,full]
 *       [--tasks id,id] [--repeat 1] [--concurrency 3] [--model <id>]
 *       [--effort medium]
 *
 * `CODEX_BIN` and `GEMINI_BIN` name the binaries when they are not on PATH. Results go to
 * `evals/out/<timestamp>/`: one JSON per run and `summary.md`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_FACET,
  FULL_VIEW,
  type FacetKey,
} from '../src/tools/facets.js';
import { listingBytes, listView } from '../src/tools/listing.js';
import { allToolEntries, servedDefinedTools } from '../src/tools/inventory.js';
import { DISPATCH_SEARCH_TOOL } from '../src/tools/facets.js';
import { dispatcherFor, isDispatchCall } from '../src/tools/dispatch.js';
import { CONFIRMATION_TOKEN_ARG } from '../src/tools/confirmation.js';
import { TASKS, type EvalTask } from './tasks.js';

// ==========================================================================
// Configuration
// ==========================================================================

type Task = EvalTask;

type Group = 'core' | 'dispatched' | 'beyond';

function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Set ${name} (see the header of evals/run.ts).`);
    process.exit(2);
  }
  return value;
}

const ROOT = resolve(import.meta.dirname, '..');
const VIEWS = flag('views', `${DEFAULT_FACET},${FULL_VIEW}`)
  .split(',')
  .map((view) => view.trim()) as FacetKey[];
const ONLY = flag('tasks', '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const REPEAT = Number(flag('repeat', '1'));
const CONCURRENCY = Number(flag('concurrency', '3'));
const MODEL = flag('model', process.env.EVAL_MODEL ?? '');
const EFFORT = flag('effort', 'medium');
const RUN_TIMEOUT_MS = 300_000;
const HOST = flag('host', 'codex');
const CODEX = process.env.CODEX_BIN ?? 'codex';
const GEMINI = process.env.GEMINI_BIN ?? 'gemini';

const partnerToken = requireEnv('ALTEGIO_API_TOKEN');
const userToken = requireEnv('ALTEGIO_USER_TOKEN');
const location = requireEnv('ALTEGIO_EVAL_LOCATION_ID');
const teamMember = requireEnv('ALTEGIO_EVAL_TEAM_MEMBER_ID');

/** What every task is prefixed with: the host is a business assistant here. */
const PREAMBLE =
  'You are the assistant of a business owner, connected to their Altegio account through the ' +
  '"altegio" MCP server. Use only its tools — no shell, no files. Do what is asked without ' +
  'asking me follow-up questions; if a change is needed, make it. Answer briefly.\n\n';

const tasks = TASKS.filter(
  (task) => ONLY.length === 0 || ONLY.includes(task.id)
);

// ==========================================================================
// What each view offers, from the same modules the server lists with
// ==========================================================================

const listings = new Map(VIEWS.map((view) => [view, listView(view)]));
/** `/mcp` as the server under test lists it: the compact listing. */
const compact = listView(DEFAULT_FACET);
const full = listView(FULL_VIEW);

function groupOf(task: Task): Group {
  if (
    task.expect.some((name) => compact.facetIndex.includes(DEFAULT_FACET, name))
  )
    return 'core';
  if (task.expect.some((name) => full.facetIndex.includes(FULL_VIEW, name)))
    return 'dispatched';
  return 'beyond';
}

/** The dispatcher of each tool's risk tier (`dispatcherFor`). */
const tierOf = new Map(
  allToolEntries().map((entry) => [entry.spec.name, dispatcherFor(entry.spec)])
);

/** The tool's own input validation, to score a call the read grant refused. */
const inputIssues = new Map(
  servedDefinedTools().map((tool) => [tool.meta.name, tool.inputIssues])
);

// ==========================================================================
// The local server
// ==========================================================================

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createNetServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });
}

async function startServer(port: number): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/http-server.ts'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'production',
        LOG_LEVEL: 'warn',
        CREDENTIALS_DIR: mkdtempSync(join(tmpdir(), 'altegio-evals-')),
        ALTEGIO_API_TOKEN: partnerToken,
        // The token travels per request, as on the hosted service.
        ALTEGIO_USER_TOKEN: '',
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    }
  );
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((done) => setTimeout(done, 500));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'evals', version: '1' },
          },
        }),
      });
      if (res.ok) return child;
    } catch {
      // not listening yet
    }
  }
  child.kill();
  throw new Error('The local server did not start.');
}

// ==========================================================================
// One run: a task on a view, through codex exec
// ==========================================================================

interface Call {
  readonly tool: string;
  /** The tool it runs: the dispatcher's target, or the tool itself. */
  readonly target: string;
  readonly args: Record<string, unknown>;
  readonly isError: boolean;
  readonly text: string;
}

interface Run {
  readonly task: string;
  readonly group: Group;
  readonly view: FacetKey;
  readonly attempt: number;
  readonly calls: readonly Call[];
  /** Index of the first call that reached an expected tool, or -1. */
  readonly reachedAt: number;
  /** That call's arguments pass the tool's own validation. */
  readonly valid: boolean;
  readonly pass: boolean;
  readonly searches: number;
  /** Dispatcher calls refused before reaching a tool (wrong tier, name). */
  readonly dispatchRefusals: number;
  /** Dispatcher calls naming a tool of another tier. */
  readonly wrongTier: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly seconds: number;
  readonly answer: string;
  readonly failure?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function resultOf(raw: unknown): { isError: boolean; text: string } {
  const result = isRecord(raw) ? raw : {};
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((block) =>
      isRecord(block) && typeof block.text === 'string' ? block.text : ''
    )
    .join('\n');
  return { isError: result.isError === true, text };
}

/** A tool call as the host reported it, before it is scored. */
interface HostCall {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly isError: boolean;
  readonly text: string;
}

/** What one host run produced, whatever the host. */
interface HostOutput {
  readonly calls: readonly HostCall[];
  readonly answer: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly failure?: string;
}

function callOf(raw: HostCall): Call {
  const { tool, args } = raw;
  const dispatched = isDispatchCall(tool);
  const target = dispatched ? String(args.tool ?? '') : tool;
  const targetArgs = dispatched
    ? isRecord(args.arguments)
      ? args.arguments
      : {}
    : args;
  return {
    tool,
    target,
    args: targetArgs,
    isError: raw.isError,
    text: raw.text.slice(0, 600),
  };
}

function validFor(call: Call): boolean {
  const issues = inputIssues.get(call.target);
  if (!issues) {
    // A hand-written onboarding tool: judged by its answer.
    return !(call.isError && /invalid|required|expected/i.test(call.text));
  }
  const args = { ...call.args };
  delete args[CONFIRMATION_TOKEN_ARG];
  return issues(args) === undefined;
}

function score(
  task: Task,
  view: FacetKey,
  attempt: number,
  output: HostOutput,
  seconds: number
): Run {
  const calls = output.calls.map(callOf);
  // Through a dispatcher, only the dispatcher of the tool's tier runs it; the
  // host may refuse a write before the server can, so judge the tier here.
  const wrongTier = (call: Call) =>
    isDispatchCall(call.tool) &&
    tierOf.has(call.target) &&
    tierOf.get(call.target) !== call.tool;
  // The dispatcher refuses a tool the view lists, which is called directly.
  const listing = listings.get(view)!;
  const listedThroughDispatcher = (call: Call) =>
    isDispatchCall(call.tool) && listing.facetIndex.includes(view, call.target);
  const reachedAt = calls.findIndex(
    (call) =>
      task.expect.includes(call.target) &&
      !wrongTier(call) &&
      !listedThroughDispatcher(call)
  );
  const valid = reachedAt >= 0 && validFor(calls[reachedAt]!);
  return {
    task: task.id,
    group: groupOf(task),
    view,
    attempt,
    calls,
    reachedAt,
    valid,
    pass: reachedAt >= 0 && valid,
    searches: calls.filter((call) => call.tool === DISPATCH_SEARCH_TOOL).length,
    dispatchRefusals: calls.filter(
      (call) =>
        isDispatchCall(call.tool) &&
        call.isError &&
        /^(Nothing was run|No tool|tools_call_\w+ (needs|takes|runs|does not))/.test(
          call.text
        )
    ).length,
    wrongTier: calls.filter(wrongTier).length,
    inputTokens: output.inputTokens,
    cachedInputTokens: output.cachedInputTokens,
    outputTokens: output.outputTokens,
    seconds,
    answer: output.answer.slice(0, 600),
    ...(output.failure ? { failure: output.failure } : {}),
  };
}

function jsonLines(text: string): Record<string, unknown>[] {
  return text.split('\n').flatMap((line) => {
    try {
      const event = JSON.parse(line) as unknown;
      return isRecord(event) ? [event] : [];
    } catch {
      return [];
    }
  });
}

/** Run a host CLI to completion, or until the run's time is up. */
function spawnHost(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ out: string; code: number | null }> {
  return new Promise((done) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', () => undefined);
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ out, code });
    });
  });
}

/** The headers the proxy would send: the read-only grant, the test location. */
const HEADERS = {
  'x-altegio-user-token': userToken,
  'x-altegio-company-id': location,
  'x-mcp-auth-scope': 'mcp:pro:read',
};

/** Codex (`codex exec --json`), which defers MCP tools behind its own search. */
async function codexRun(url: string, prompt: string): Promise<HostOutput> {
  const table = Object.entries(HEADERS)
    .map(([key, value]) => `"${key}"=${JSON.stringify(value)}`)
    .join(',');
  const { out, code } = await spawnHost(
    CODEX,
    [
      'exec',
      '--json',
      '--ephemeral',
      '--ignore-user-config',
      '--skip-git-repo-check',
      '-s',
      'read-only',
      '-c',
      `model_reasoning_effort="${EFFORT}"`,
      '-c',
      `mcp_servers.altegio.url="${url}"`,
      '-c',
      `mcp_servers.altegio.http_headers={${table}}`,
      ...(MODEL ? ['-m', MODEL] : []),
      prompt,
    ],
    mkdtempSync(join(tmpdir(), 'altegio-eval-run-'))
  );
  const calls: HostCall[] = [];
  let answer = '';
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  for (const event of jsonLines(out)) {
    const item = isRecord(event.item) ? event.item : undefined;
    if (event.type === 'item.completed' && item?.type === 'mcp_tool_call') {
      const result = item.error
        ? { isError: true, text: JSON.stringify(item.error) }
        : resultOf(item.result);
      calls.push({
        tool: String(item.tool ?? ''),
        args: isRecord(item.arguments) ? item.arguments : {},
        ...result,
      });
    }
    if (event.type === 'item.completed' && item?.type === 'agent_message') {
      answer = String(item.text ?? '');
    }
    if (event.type === 'turn.completed' && isRecord(event.usage)) {
      inputTokens += Number(event.usage.input_tokens ?? 0);
      cachedInputTokens += Number(event.usage.cached_input_tokens ?? 0);
      outputTokens += Number(event.usage.output_tokens ?? 0);
    }
  }
  return {
    calls,
    answer,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    ...(code === 0
      ? {}
      : { failure: `codex exited with ${code ?? 'a signal'}` }),
  };
}

/** Gemini CLI (`gemini -p -o stream-json`), which sends every MCP tool. */
async function geminiRun(url: string, prompt: string): Promise<HostOutput> {
  const cwd = mkdtempSync(join(tmpdir(), 'altegio-eval-run-'));
  mkdirSync(join(cwd, '.gemini'));
  writeFileSync(
    join(cwd, '.gemini', 'settings.json'),
    JSON.stringify({
      mcpServers: { altegio: { httpUrl: url, headers: HEADERS, trust: true } },
      tools: {
        exclude: [
          'run_shell_command',
          'write_file',
          'replace',
          'web_fetch',
          'google_web_search',
        ],
      },
    })
  );
  const { out, code } = await spawnHost(
    GEMINI,
    [
      '-p',
      prompt,
      '-o',
      'stream-json',
      '--allowed-mcp-server-names',
      'altegio',
      ...(MODEL ? ['-m', MODEL] : []),
    ],
    cwd,
    { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: 'true' }
  );
  const prefix = 'mcp_altegio_';
  const pending = new Map<
    string,
    { tool: string; args: Record<string, unknown> }
  >();
  const calls: HostCall[] = [];
  let answer = '';
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  for (const event of jsonLines(out)) {
    if (event.type === 'tool_use') {
      const name = String(event.tool_name ?? '');
      pending.set(String(event.tool_id), {
        tool: name.startsWith(prefix) ? name.slice(prefix.length) : name,
        args: isRecord(event.parameters) ? event.parameters : {},
      });
    }
    if (event.type === 'tool_result') {
      const used = pending.get(String(event.tool_id));
      if (!used) continue;
      const error = isRecord(event.error) ? event.error : undefined;
      calls.push({
        ...used,
        isError: event.status !== 'success',
        text: String(error?.message ?? event.output ?? ''),
      });
    }
    if (event.type === 'message' && event.role === 'assistant') {
      answer += String(event.content ?? '');
    }
    if (event.type === 'result' && isRecord(event.stats)) {
      inputTokens = Number(event.stats.input_tokens ?? 0);
      cachedInputTokens = Number(event.stats.cached ?? 0);
      outputTokens = Number(event.stats.output_tokens ?? 0);
    }
  }
  return {
    calls,
    answer,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    ...(code === 0
      ? {}
      : { failure: `gemini exited with ${code ?? 'a signal'}` }),
  };
}

async function runOnce(
  port: number,
  task: Task,
  view: FacetKey,
  attempt: number
): Promise<Run> {
  const path = view === DEFAULT_FACET ? '/mcp' : `/mcp/${view}`;
  const url = `http://127.0.0.1:${port}${path}`;
  const prompt =
    PREAMBLE +
    task.prompt
      .replaceAll('{location}', location)
      .replaceAll('{team_member}', teamMember);
  const started = Date.now();
  const output =
    HOST === 'gemini'
      ? await geminiRun(url, prompt)
      : await codexRun(url, prompt);
  const seconds = Math.round((Date.now() - started) / 1000);
  return score(task, view, attempt, output, seconds);
}

// ==========================================================================
// Summary
// ==========================================================================

const pct = (part: number, whole: number) =>
  whole === 0 ? '—' : `${Math.round((part / whole) * 100)} %`;
const mean = (values: readonly number[]) =>
  values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
const thousands = (value: number) =>
  String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function summary(runs: readonly Run[]): string {
  const out: string[] = [];
  out.push('# Tool-selection eval');
  out.push('');
  out.push(
    `Host: ${HOST === 'gemini' ? 'gemini -p' : `codex exec, reasoning effort ${EFFORT}`} (${MODEL || 'default model'}); ${tasks.length} tasks × ${VIEWS.length} views × ${REPEAT}.`
  );
  out.push('');
  out.push(
    '| View | Listing bytes | Tools listed | Pass | core | dispatched | beyond | Calls to reach | tools_search | Dispatch refusals | Wrong tier | Input tokens / run | Seconds / run |'
  );
  out.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const view of VIEWS) {
    const mine = runs.filter((run) => run.view === view);
    const listing = listings.get(view)!;
    const inGroup = (group: Group) => {
      const runsIn = mine.filter((run) => run.group === group);
      return `${runsIn.filter((run) => run.pass).length}/${runsIn.length}`;
    };
    const reached = mine.filter((run) => run.reachedAt >= 0);
    out.push(
      `| ${view === DEFAULT_FACET ? '/mcp' : `/mcp/${view}`} | ${thousands(listingBytes(listing.tools))} | ${listing.tools.length} | ${pct(mine.filter((run) => run.pass).length, mine.length)} | ${inGroup('core')} | ${inGroup('dispatched')} | ${inGroup('beyond')} | ${mean(reached.map((run) => run.reachedAt + 1)).toFixed(1)} | ${mean(mine.map((run) => run.searches)).toFixed(1)} | ${mine.reduce((sum, run) => sum + run.dispatchRefusals, 0)} | ${mine.reduce((sum, run) => sum + run.wrongTier, 0)} | ${thousands(mean(mine.map((run) => run.inputTokens)))} | ${Math.round(mean(mine.map((run) => run.seconds)))} |`
    );
  }
  out.push('');
  out.push(
    '"Calls to reach" counts tool calls up to and including the first one that reaches an expected tool, among runs that reached one. A dispatched call reaches its tool only through the dispatcher of the tool\'s risk tier, and only when the view does not list the tool; "Wrong tier" counts the calls that named another tier.'
  );
  out.push('');
  out.push(
    `| Task | Group | ${VIEWS.map((view) => (view === DEFAULT_FACET ? '/mcp' : `/mcp/${view}`)).join(' | ')} |`
  );
  out.push(`|---|---|${VIEWS.map(() => '---').join('|')}|`);
  for (const task of tasks) {
    const cells = VIEWS.map((view) =>
      runs
        .filter((run) => run.task === task.id && run.view === view)
        .map((run) =>
          run.pass
            ? `✓ ${run.calls
                .slice(0, run.reachedAt + 1)
                .map((call) =>
                  call.tool === call.target
                    ? call.tool
                    : `${call.tool}→${call.target}`
                )
                .join(', ')}`
            : `✗ ${run.failure ?? (run.reachedAt >= 0 ? 'invalid arguments' : run.calls.map((call) => (call.tool === call.target || !call.target ? call.tool : `${call.tool}→${call.target}`)).join(', ') || 'no call')}`
        )
        .join('<br>')
    );
    out.push(`| ${task.id} | ${groupOf(task)} | ${cells.join(' | ')} |`);
  }
  out.push('');
  return out.join('\n');
}

// ==========================================================================
// Main
// ==========================================================================

async function main(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(ROOT, 'evals/out', `${stamp}-${HOST}`);
  mkdirSync(outDir, { recursive: true });
  const port = await freePort();
  const server = await startServer(port);
  const jobs = tasks.flatMap((task) =>
    VIEWS.flatMap((view) =>
      Array.from({ length: REPEAT }, (_, attempt) => ({ task, view, attempt }))
    )
  );
  const runs: Run[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      const run = await runOnce(port, job.task, job.view, job.attempt);
      runs.push(run);
      writeFileSync(
        join(outDir, `${job.task.id}.${job.view}.${job.attempt}.json`),
        JSON.stringify(run, null, 2)
      );
      console.log(
        `${run.pass ? 'PASS' : 'FAIL'} ${job.task.id} on ${job.view} (${run.calls.length} calls, ${run.seconds} s)`
      );
    }
  };
  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } finally {
    server.kill();
  }
  const text = summary(runs);
  writeFileSync(join(outDir, 'summary.md'), text);
  console.log(`\n${text}\nWritten to ${outDir}`);
}

await main();
