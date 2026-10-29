/**
 * The curated-tool dispatcher of the compact listing (`/mcp`, `/mcp/compact`;
 * ADR-001 D3): `tools_search` finds a tool the view does not list, and
 * `tools_call_read`, `tools_call_write` and `tools_call_destructive` run it by
 * name, one per risk tier.
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
  DISPATCH_DESTRUCTIVE_TOOL,
  DISPATCH_READ_TOOL,
  DISPATCH_TOOLS,
  DISPATCH_WRITE_TOOL,
} from './facets.js';
import { CONFIRMATION_TOKEN_ARG } from './confirmation.js';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from './dispatch-limits.js';
import { queryTerms, tokenize, weightedTermScore } from './executor/search.js';
import { allToolEntries, type ToolEntry } from './inventory.js';
import { legacyAliasTargets } from './legacy-aliases.js';
import { currentView, listedOn, listedOnView } from './serving-view.js';
import type { ToolResult } from './tool-result.js';

/** A dispatcher that runs a tool: one per risk tier. */
export type Dispatcher =
  | typeof DISPATCH_READ_TOOL
  | typeof DISPATCH_WRITE_TOOL
  | typeof DISPATCH_DESTRUCTIVE_TOOL;

/**
 * The dispatcher that runs a tool, by what the tool's own annotations say: a
 * read, a change, or a destructive change. A change counts as destructive
 * unless it says `destructiveHint: false`, which is MCP's default and keeps a
 * tool that forgot the hint behind the tier a host asks about.
 */
export function dispatcherFor(spec: {
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}): Dispatcher {
  if (spec.annotations?.readOnlyHint === true) return DISPATCH_READ_TOOL;
  return spec.annotations?.destructiveHint === false
    ? DISPATCH_WRITE_TOOL
    : DISPATCH_DESTRUCTIVE_TOOL;
}

/** Whether a tool name is one of the dispatchers that run a tool. */
export function isDispatchCall(name: string): name is Dispatcher {
  return (
    name === DISPATCH_READ_TOOL ||
    name === DISPATCH_WRITE_TOOL ||
    name === DISPATCH_DESTRUCTIVE_TOOL
  );
}

// ==========================================================================
// tools_search
// ==========================================================================

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

/**
 * Words that ask for a deletion, and words that ask for a change. A query
 * with neither asks to read: among tools that match it about as well, a read
 * then outranks a change, and a change outranks a deletion. A query that asks
 * for a change still ranks a deletion lower; one that asks for a deletion
 * ranks every tier alike. The factors only reorder near-ties.
 */
const DELETION_WORDS: ReadonlySet<string> = new Set([
  'delete',
  'remove',
  'cancel',
  'unlink',
  'refund',
  'void',
  'erase',
  'clear',
  'revoke',
  'drop',
  'discard',
]);
const CHANGE_WORDS: ReadonlySet<string> = new Set([
  'add',
  'create',
  'new',
  'book',
  'record',
  'sell',
  'set',
  'update',
  'change',
  'edit',
  'move',
  'reschedule',
  'link',
  'assign',
  'freeze',
  'unfreeze',
  'deposit',
  'pay',
  'payout',
  'top',
  'open',
  'archive',
  'unarchive',
  'duplicate',
  'copy',
  'upload',
  'attach',
  'import',
  'rename',
  'mark',
  'apply',
  'correct',
  'extend',
  'start',
  'make',
  'save',
  'replace',
  'enable',
  'disable',
  'send',
  'register',
]);
const WRITE_FACTOR = 0.93;
const DESTRUCTIVE_FACTOR = 0.88;

/** How much a match of this tier counts for a query of these terms. */
function tierFactor(terms: readonly string[], tier: Dispatcher): number {
  if (terms.some((term) => DELETION_WORDS.has(term))) return 1;
  if (tier === DISPATCH_DESTRUCTIVE_TOOL) return DESTRUCTIVE_FACTOR;
  if (
    tier === DISPATCH_WRITE_TOOL &&
    !terms.some((term) => CHANGE_WORDS.has(term))
  ) {
    return WRITE_FACTOR;
  }
  return 1;
}

/** One form per word: "appointments" and "categories" match "appointment", "category". */
function singular(token: string): string {
  if (token.length > 4 && token.endsWith('ies'))
    return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}

/**
 * Forms of one word that the plural rule does not join: a client pays, the
 * visit is paid, a payment is recorded. "pay" is also under the prefix
 * minimum, so without this "pay for appointment" never reached a payment.
 */
const WORD_ROOTS: ReadonlyMap<string, string> = new Map([
  ['paid', 'pay'],
  ['payment', 'pay'],
]);

/** One form per word: its singular, then its root. */
function wordForm(token: string): string {
  const one = singular(token);
  return WORD_ROOTS.get(one) ?? one;
}

/** A field's tokens, each also in its one form. */
function tokenSet(text: string): ReadonlySet<string> {
  const tokens = tokenize(text);
  return new Set([...tokens, ...tokens.map(wordForm)]);
}

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
    name: tokenSet(entry.spec.name),
    lead: tokenSet(leadOf(description)),
    category: tokenSet(entry.category),
    parameters: new Set(
      Object.keys(properties ?? {}).flatMap((key) => [...tokenSet(key)])
    ),
    description: tokenSet(description),
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
  /** The dispatcher that runs it on this address; absent for a listed tool. */
  readonly call_with?: Dispatcher;
  /** In this address's `tools/list`, so it is called directly. */
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
 * result looks it up by that name. Among matches about as good, the tier the
 * query asks for comes first (`tierFactor`).
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
  const terms = [...new Set(queryTerms(query).map(wordForm))];
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
    score *= tierFactor(terms, dispatcherFor(entry.spec));
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
      ...(listed ? {} : { call_with: dispatcherFor(entry.spec) }),
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
      ? 'in your tool list: call it directly'
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
    `Tools for "${result.query}", best first. Call a listed one directly; run any other as {"tool": "<name>", "arguments": {…}} with the dispatcher named.`,
    ...lines,
  ]
    .join('\n')
    .concat(more);
}

// ==========================================================================
// tools_call_read / tools_call_write / tools_call_destructive
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

/** Why a tool belongs to another tier, as the refusal says it. */
const TIER_REASON: Readonly<Record<Dispatcher, string>> = {
  [DISPATCH_READ_TOOL]: 'only reads',
  [DISPATCH_WRITE_TOOL]: 'creates or changes data and deletes nothing',
  [DISPATCH_DESTRUCTIVE_TOOL]:
    'deletes data or makes a change that is hard to undo',
};

/** What each dispatcher runs, as the refusal says it. */
const TIER_RUNS: Readonly<Record<Dispatcher, string>> = {
  [DISPATCH_READ_TOOL]: 'reads only',
  [DISPATCH_WRITE_TOOL]: 'changes that delete nothing',
  [DISPATCH_DESTRUCTIVE_TOOL]: 'deletions and changes that are hard to undo',
};

export interface DispatchTargets {
  /** Whether this view lists the tool, so it is called directly. */
  lists(name: string): boolean;
  /** Whether this view's dispatcher runs the tool. */
  reaches(name: string): boolean;
  /** The dispatcher that runs the tool (`dispatcherFor`); undefined when unknown. */
  dispatcherOf(name: string): Dispatcher | undefined;
  /** Addresses of other views that serve it, for a tool out of reach. */
  addressesServing(name: string): readonly string[];
}

/**
 * Which tool a `tools_call_read` / `tools_call_write` / `tools_call_destructive`
 * call runs, with which arguments — or the refusal the caller reads instead.
 * Each dispatcher runs its own tier only and names the one that runs the tool,
 * so a host that approves `tools_call_read`, or `tools_call_write`, without
 * asking never runs a change, or a deletion, through it. A tool the view
 * lists is refused, to be called directly, so a host's setting for that tool
 * holds. A `confirmation_token` sent beside `arguments` is moved into them.
 */
export function resolveDispatch(
  dispatcher: Dispatcher,
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
  if (targets.lists(name)) {
    return refuse(
      `Nothing was run: ${name} is in your tool list, so call it directly with these arguments.`,
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

  // Unknown means not annotated: the destructive tier, as `dispatcherFor`.
  const tier = targets.dispatcherOf(name) ?? DISPATCH_DESTRUCTIVE_TOOL;
  if (tier !== dispatcher) {
    return refuse(
      `Nothing was run: ${name} ${TIER_REASON[tier]}, and ${dispatcher} runs ${TIER_RUNS[dispatcher]}. Run it with ${tier}.`,
      'validation'
    );
  }
  return { target: name, args };
}
