/**
 * The curated-tool dispatcher behind `/mcp/compact` (ADR-001 D3, amended
 * 2026-10-21): `tools_search` finds a tool the view does not list, and
 * `tools_call_read` / `tools_call_write` run it by name.
 *
 * What it dispatches to is a curated tool, never a raw operation, which is
 * what answers the two objections ADR-001 §8.5 raised against writes through
 * the executor: the confirmation names the one resolved object the target tool
 * resolves, and the scope is the target tool's own, checked per call. The
 * registry (`./registry.ts`) runs a dispatched call down the same path as a
 * direct one — scope, confirmation, the handler's own validation, the
 * `tool_call` log under the target's name — so this module only decides which
 * tool a dispatcher call is for, and finds tools for `tools_search`.
 *
 * Ranking is local and deterministic, in the business vocabulary the operation
 * search uses (`./executor/search.ts`): the same query always returns the same
 * tools, which is what makes the evals in `evals/` repeatable.
 */
import {
  DISPATCH_READ_TOOL,
  DISPATCH_TOOLS,
  DISPATCH_WRITE_TOOL,
} from './facets.js';
import { CONFIRMATION_TOKEN_ARG } from './confirmation.js';
import { queryTerms, tokenize, weightedTermScore } from './executor/search.js';
import { allToolEntries, type ToolEntry } from './inventory.js';
import { legacyAliasTargets } from './legacy-aliases.js';
import { currentView, listedOn, listedOnView } from './serving-view.js';
import type { ToolResult } from './tool-result.js';

/** The dispatcher that runs a tool: by what the tool's own annotation says. */
export function dispatcherFor(spec: {
  annotations?: { readOnlyHint?: boolean };
}): typeof DISPATCH_READ_TOOL | typeof DISPATCH_WRITE_TOOL {
  return spec.annotations?.readOnlyHint === true
    ? DISPATCH_READ_TOOL
    : DISPATCH_WRITE_TOOL;
}

/** Whether a tool name is one of the two dispatchers that run a tool. */
export function isDispatchCall(name: string): boolean {
  return name === DISPATCH_READ_TOOL || name === DISPATCH_WRITE_TOOL;
}

// ==========================================================================
// tools_search
// ==========================================================================

export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 10;

/** A hit under this share of the best one is word overlap, not a candidate. */
const RELEVANCE_FLOOR = 0.4;
/** Reward covering every word of the query over matching one word loudly. */
const COVERAGE_BONUS = 10;

/** Field weights: the name and the first sentence say what a tool is for. */
const WEIGHTS = {
  name: 5,
  lead: 4,
  category: 2,
  parameters: 1.5,
  description: 1,
} as const;

type ToolIndex = Record<keyof typeof WEIGHTS, ReadonlySet<string>>;

/** The first sentence of a description: what the tool does. */
function leadOf(description: string): string {
  const match = /^.*?[.!?](\s|$)/s.exec(description);
  return (match ? match[0] : description).trim();
}

function indexTool(entry: ToolEntry): ToolIndex {
  const description = entry.spec.description ?? '';
  const properties = (
    entry.spec.inputSchema as { properties?: Record<string, unknown> }
  ).properties;
  return {
    name: new Set(tokenize(entry.spec.name)),
    lead: new Set(tokenize(leadOf(description))),
    category: new Set(tokenize(entry.category)),
    parameters: new Set(Object.keys(properties ?? {}).flatMap(tokenize)),
    description: new Set(tokenize(description)),
  };
}

/** A tool as the search sees it: its listing entry, and whether it is gated. */
export interface SearchableTool extends ToolEntry {
  readonly requiresConfirmation?: boolean;
}

/** Every tool this build serves somewhere, in `tools/list` order. */
function servedEntries(): SearchableTool[] {
  return allToolEntries().filter((entry) => !entry.disabled);
}

export interface ToolMatch {
  readonly name: string;
  /** The dispatcher that runs it on this address. */
  readonly call_with: typeof DISPATCH_READ_TOOL | typeof DISPATCH_WRITE_TOOL;
  /** In this address's `tools/list` too, so it can also be called directly. */
  readonly listed: boolean;
  /** Stops for a person's approval before it changes anything. */
  readonly asks_confirmation: boolean;
  readonly description: string;
  /** Its input schema as listed; left out for a listed tool the host has. */
  readonly input_schema?: unknown;
}

export interface ToolSearchResult {
  readonly query: string;
  readonly matches: readonly ToolMatch[];
  /** Relevant tools before the limit. */
  readonly total_matches: number;
}

/**
 * Tools the running call's view reaches, best match first. A tool named in
 * the query outranks everything else: a model that read a tool name in a
 * result looks it up by that name.
 */
export function searchTools(
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
  entries: readonly SearchableTool[] = servedEntries()
): ToolSearchResult {
  const view = currentView();
  const reachable = entries.filter(
    (entry) =>
      view.serves(entry.spec.name) && !DISPATCH_TOOLS.includes(entry.spec.name)
  );
  const terms = queryTerms(query);
  const named = new Set(
    (query.toLowerCase().match(/[a-z0-9_]+/g) ?? []).flatMap((word) => [
      word,
      ...(legacyAliasTargets(word) ?? []),
    ])
  );

  const scored: Array<{ entry: SearchableTool; score: number }> = [];
  for (const entry of reachable) {
    const index = indexTool(entry);
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      const termScore = weightedTermScore(index, WEIGHTS, term);
      if (termScore > 0) matched += 1;
      score += termScore;
    }
    if (terms.length > 0) score += (matched / terms.length) * COVERAGE_BONUS;
    if (named.has(entry.spec.name)) score += 100;
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score || (a.entry.spec.name < b.entry.spec.name ? -1 : 1)
  );
  const floor = (scored[0]?.score ?? 0) * RELEVANCE_FLOOR;
  const relevant = scored.filter(({ score }) => score >= floor);

  const toolNames = entries.map((entry) => entry.spec.name);
  const bounded = Math.min(Math.max(limit, 1), MAX_SEARCH_LIMIT);
  const matches = relevant.slice(0, bounded).map(({ entry }): ToolMatch => {
    const listed = listedOn(view, entry.spec.name);
    const shown = listedOnView(entry.spec, view, toolNames);
    return {
      name: entry.spec.name,
      call_with: dispatcherFor(entry.spec),
      listed,
      asks_confirmation: entry.requiresConfirmation === true,
      description: shown.description ?? '',
      ...(listed ? {} : { input_schema: shown.inputSchema }),
    };
  });
  return { query, matches, total_matches: relevant.length };
}

/** The text a model reads: each match, and how to run it. */
export function searchText(result: ToolSearchResult): string {
  if (result.matches.length === 0) {
    return `No tool here matches "${result.query}". Search again with other words, or read the API with api_search_operations.`;
  }
  const lines = result.matches.map((match) => {
    const how = match.listed
      ? `in your tool list; also runs with ${match.call_with}`
      : `run with ${match.call_with}`;
    const gate = match.asks_confirmation ? '; asks for confirmation' : '';
    const schema =
      match.input_schema === undefined
        ? ''
        : `\n  arguments: ${JSON.stringify(match.input_schema)}`;
    return `- ${match.name} (${how}${gate}): ${match.description}${schema}`;
  });
  const more =
    result.total_matches > result.matches.length
      ? `\n${result.total_matches - result.matches.length} more matched; raise limit or narrow the query.`
      : '';
  return [
    `Tools for "${result.query}", best first. Run one as {"tool": "<name>", "arguments": {…}} with the dispatcher named.`,
    ...lines,
  ]
    .join('\n')
    .concat(more);
}

// ==========================================================================
// tools_call_read / tools_call_write
// ==========================================================================

/** What a dispatcher call resolves to: the target and its arguments. */
export type Dispatch =
  | { readonly target: string; readonly args: Record<string, unknown> }
  | {
      readonly refusal: ToolResult;
      readonly errorClass: 'validation' | 'unknown_tool' | 'out_of_view';
    };

/** A name a reply may repeat: nothing else a caller sent is. */
const SAFE_NAME = /^[a-z0-9_]{1,64}$/;

function refuse(
  text: string,
  errorClass: 'validation' | 'unknown_tool' | 'out_of_view'
): Dispatch {
  return {
    refusal: { content: [{ type: 'text', text }], isError: true },
    errorClass,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export interface DispatchTargets {
  /** Whether this view's dispatcher runs the tool. */
  reaches(name: string): boolean;
  /** Whether the tool only reads (`readOnlyHint`); undefined when unknown. */
  readOnly(name: string): boolean | undefined;
  /** Addresses of other views that serve it, for a tool out of reach. */
  addressesServing(name: string): readonly string[];
}

/**
 * Which tool a `tools_call_read` / `tools_call_write` call runs, with which
 * arguments — or the refusal the caller reads instead. Refuses a read through
 * `tools_call_write` and a change through `tools_call_read`, so a host that
 * approves `tools_call_read` without asking never runs a change. A
 * `confirmation_token` sent beside `arguments` is moved into them.
 */
export function resolveDispatch(
  dispatcher: string,
  raw: unknown,
  targets: DispatchTargets
): Dispatch {
  const input = isRecord(raw) ? raw : {};
  const tool = input.tool;
  if (typeof tool !== 'string' || tool.trim() === '') {
    return refuse(
      `${dispatcher} needs "tool": the name of the tool to run, from tools_search, and "arguments": its arguments.`,
      'validation'
    );
  }
  const name = tool.trim();
  const shown = SAFE_NAME.test(name) ? `"${name}"` : 'that name';
  const extra = Object.keys(input).filter(
    (key) =>
      key !== 'tool' && key !== 'arguments' && key !== CONFIRMATION_TOKEN_ARG
  );
  if (extra.length > 0) {
    return refuse(
      `${dispatcher} takes "tool" and "arguments" only; put every argument of ${shown} inside "arguments".`,
      'validation'
    );
  }
  if (input.arguments !== undefined && !isRecord(input.arguments)) {
    return refuse(
      `"arguments" must be an object of the arguments ${shown} takes, as tools_search shows them.`,
      'validation'
    );
  }
  const args: Record<string, unknown> = { ...(input.arguments ?? {}) };
  if (
    input[CONFIRMATION_TOKEN_ARG] !== undefined &&
    args[CONFIRMATION_TOKEN_ARG] === undefined
  ) {
    args[CONFIRMATION_TOKEN_ARG] = input[CONFIRMATION_TOKEN_ARG];
  }

  if (DISPATCH_TOOLS.includes(name)) {
    return refuse(
      `${dispatcher} runs a tool, not another dispatcher: call ${name} directly.`,
      'validation'
    );
  }
  if (!targets.reaches(name)) {
    const replacements = legacyAliasTargets(name);
    if (replacements?.length) {
      return refuse(
        `${shown} is a former tool name; run ${replacements.join(' or ')} instead, with the arguments tools_search shows for it.`,
        'unknown_tool'
      );
    }
    const where = targets.addressesServing(name);
    return where.length > 0
      ? refuse(
          `${dispatcher} does not run ${shown} on this address; it is served on ${where.join(' or ')}.`,
          'out_of_view'
        )
      : refuse(
          `No tool ${shown} is reachable here. Find the right one with tools_search.`,
          'unknown_tool'
        );
  }

  const readOnly = targets.readOnly(name) === true;
  if (dispatcher === DISPATCH_READ_TOOL && !readOnly) {
    return refuse(
      `Nothing was run: ${name} changes data, and ${DISPATCH_READ_TOOL} runs reads only. Run it with ${DISPATCH_WRITE_TOOL}.`,
      'validation'
    );
  }
  if (dispatcher === DISPATCH_WRITE_TOOL && readOnly) {
    return refuse(
      `Nothing was run: ${name} only reads. Run it with ${DISPATCH_READ_TOOL}.`,
      'validation'
    );
  }
  return { target: name, args };
}
