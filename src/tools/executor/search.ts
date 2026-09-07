/**
 * Keyword search over the generated API catalog — backs
 * `altegio_search_operations`.
 *
 * Deterministic and local: a small weighted term index over each operation's
 * id, summary, tags, domain, path, parameter names and description. No
 * embeddings, no external service, no network — the same query always returns
 * the same ranking, which is what makes the executor testable (ADR-001 D9).
 */
import {
  allOperations,
  curatedToolFor,
  type CatalogOperation,
} from './catalog.js';

/** Query words that carry no signal in an API catalog. */
const STOPWORDS = new Set([
  'a',
  'all',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'do',
  'does',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'them',
  'this',
  'to',
  'want',
  'was',
  'what',
  'when',
  'where',
  'which',
  'who',
  'with',
  'you',
]);

/**
 * Business-vocabulary equivalence classes. The product speaks the canonical
 * glossary while parts of the V1 spec still speak the legacy one, so a query in
 * either vocabulary has to reach the same operations. A synonym match scores
 * less than a literal one (see `SYNONYM_FACTOR`).
 */
const SYNONYM_GROUPS: string[][] = [
  ['location', 'locations', 'company', 'companies', 'salon', 'branch'],
  ['team', 'member', 'members', 'staff', 'master', 'masters', 'employee'],
  ['appointment', 'appointments', 'record', 'records', 'booking', 'bookings'],
  ['client', 'clients', 'customer', 'customers'],
  ['product', 'products', 'good', 'goods'],
  ['membership', 'memberships', 'abonement', 'subscription', 'subscriptions'],
  ['gift', 'card', 'cards', 'certificate', 'certificates'],
  ['account', 'accounts', 'deposit', 'deposits'],
  ['receptionist', 'administrator', 'admin', 'user', 'users'],
  ['analytics', 'statistic', 'statistics', 'stats', 'report', 'reports'],
  ['schedule', 'schedules', 'timetable'],
  ['visit', 'visits'],
  ['service', 'services'],
  ['position', 'positions', 'role', 'roles'],
  ['payment', 'payments', 'payroll', 'salary'],
  ['availability', 'available', 'free', 'slot', 'slots', 'seance', 'seances'],
  ['fiscal', 'fiscalization', 'kkm', 'cash', 'register', 'till', 'receipt'],
  ['inventory', 'stock', 'storage', 'storages', 'warehouse'],
];

const SYNONYMS: Map<string, string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const group of SYNONYM_GROUPS) {
    for (const word of group) {
      const others = group.filter((w) => w !== word);
      map.set(word, [...(map.get(word) ?? []), ...others]);
    }
  }
  return map;
})();

/** A synonym hit is real but weaker evidence than the word the caller typed. */
const SYNONYM_FACTOR = 0.7;

/** A prefix hit ("appoint" → "appointment") is weaker still. */
const PREFIX_FACTOR = 0.5;
const MIN_PREFIX_LENGTH = 4;

/** Field weights: identity and summary outrank prose. */
const WEIGHTS = {
  operationId: 5,
  toolName: 5,
  summary: 4,
  tags: 3,
  domain: 3,
  path: 3,
  parameters: 1.5,
  description: 1,
} as const;

/** Reward covering every word of the query over matching one word loudly. */
const COVERAGE_BONUS = 10;
/** A curated operation is a well-trodden path; nudge it up on a tie. */
const CURATED_BONUS = 1;
/** A read is what this tier can actually execute today (ADR-001 D2). */
const READ_BONUS = 1.5;
/** A deprecated operation still answers the question, but should not lead. */
const DEPRECATED_PENALTY = 2;

export const MAX_SEARCH_RESULTS = 10;

export interface SearchFilters {
  domain?: string;
  method?: string;
  /** Include V3 preview operations, which are documented but not yet callable. */
  includePreview?: boolean;
  limit?: number;
}

export interface SearchHit {
  operationId: string;
  method: string;
  /** Canonical path — legacy segments renamed for display (the real path is called). */
  path: string;
  summary: string;
  domain: string;
  source: string;
  score: number;
  deprecated?: boolean;
  status?: string;
  /** Curated tool that already covers this operation; prefer it over the executor. */
  tool?: string;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** Query terms: lowercase, de-duplicated, stopwords and single letters dropped. */
export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const token of tokenize(query)) {
    if (token.length < 2 || STOPWORDS.has(token)) continue;
    seen.add(token);
  }
  return [...seen];
}

/** Per-field token sets for one operation, built once per search. */
interface OperationIndex {
  operationId: Set<string>;
  toolName: Set<string>;
  summary: Set<string>;
  tags: Set<string>;
  domain: Set<string>;
  path: Set<string>;
  parameters: Set<string>;
  description: Set<string>;
}

function indexOperation(op: CatalogOperation): OperationIndex {
  return {
    operationId: new Set(tokenize(op.operationId)),
    toolName: new Set(tokenize(curatedToolFor(op) ?? '')),
    summary: new Set(tokenize(op.summary ?? '')),
    tags: new Set(op.tags.flatMap(tokenize)),
    domain: new Set(tokenize(op.domain)),
    // Both spellings: the model may know either vocabulary.
    path: new Set([...tokenize(op.displayPath), ...tokenize(op.path)]),
    parameters: new Set(op.parameters.flatMap((p) => tokenize(p.name))),
    description: new Set(tokenize(op.description ?? '')),
  };
}

/** Best evidence for one term in one token set: literal, then prefix. */
function termHit(tokens: Set<string>, term: string): number {
  if (tokens.has(term)) return 1;
  if (term.length < MIN_PREFIX_LENGTH) return 0;
  for (const token of tokens) {
    if (token.startsWith(term) || term.startsWith(token)) return PREFIX_FACTOR;
  }
  return 0;
}

/** Best evidence for one term, counting its synonyms at a discount. */
function scoreTerm(index: OperationIndex, term: string): number {
  const variants: Array<[string, number]> = [[term, 1]];
  for (const synonym of SYNONYMS.get(term) ?? []) {
    variants.push([synonym, SYNONYM_FACTOR]);
  }

  let total = 0;
  for (const [field, weight] of Object.entries(WEIGHTS)) {
    const tokens = index[field as keyof OperationIndex];
    let best = 0;
    for (const [variant, factor] of variants) {
      best = Math.max(best, termHit(tokens, variant) * factor);
    }
    total += best * weight;
  }
  return total;
}

const METHOD_RANK = new Map(
  ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m, i) => [m, i])
);

function tieBreak(a: CatalogOperation, b: CatalogOperation): number {
  // Live V1 before V3 preview: a preview operation cannot be called yet.
  if (a.source !== b.source) return a.source.localeCompare(b.source);
  const rank =
    (METHOD_RANK.get(a.method) ?? 9) - (METHOD_RANK.get(b.method) ?? 9);
  if (rank !== 0) return rank;
  return a.operationId.localeCompare(b.operationId);
}

export interface SearchResult {
  terms: string[];
  hits: SearchHit[];
  /** How many operations scored above zero, before the result limit. */
  totalMatches: number;
  /** How many operations the filters left searchable. */
  searched: number;
}

export function searchOperations(
  query: string,
  filters: SearchFilters = {}
): SearchResult {
  const terms = queryTerms(query);
  const wantedDomain = filters.domain?.trim().toLowerCase();
  const wantedMethod = filters.method?.trim().toUpperCase();
  const limit = Math.min(
    Math.max(filters.limit ?? MAX_SEARCH_RESULTS, 1),
    MAX_SEARCH_RESULTS
  );

  const candidates = allOperations().filter((op) => {
    if (!filters.includePreview && op.source !== 'v1') return false;
    if (wantedDomain && op.domain !== wantedDomain) return false;
    if (wantedMethod && op.method !== wantedMethod) return false;
    return true;
  });

  const normalizedQuery = query.trim().toLowerCase();
  const scored: Array<{ op: CatalogOperation; score: number }> = [];

  for (const op of candidates) {
    const index = indexOperation(op);
    let score = 0;
    let matched = 0;

    for (const term of terms) {
      const termScore = scoreTerm(index, term);
      if (termScore > 0) matched += 1;
      score += termScore;
    }

    if (score === 0) continue;

    score += (matched / terms.length) * COVERAGE_BONUS;
    if (curatedToolFor(op)) score += CURATED_BONUS;
    if (op.method === 'GET') score += READ_BONUS;
    if (op.deprecated) score -= DEPRECATED_PENALTY;
    // Someone who typed the exact identifier wants that operation, not a
    // neighbour that happens to share more words.
    if (op.operationId.toLowerCase() === normalizedQuery) score += 100;

    scored.push({ op, score });
  }

  scored.sort((a, b) => b.score - a.score || tieBreak(a.op, b.op));

  return {
    terms,
    totalMatches: scored.length,
    searched: candidates.length,
    hits: scored.slice(0, limit).map(({ op, score }) => ({
      operationId: op.operationId,
      method: op.method,
      path: op.displayPath,
      summary: op.summary ?? op.description?.split('\n')[0] ?? '',
      domain: op.domain,
      source: op.source,
      score: Math.round(score * 100) / 100,
      ...(op.deprecated ? { deprecated: true } : {}),
      ...(op.status ? { status: op.status } : {}),
      ...(curatedToolFor(op) ? { tool: curatedToolFor(op) } : {}),
    })),
  };
}
