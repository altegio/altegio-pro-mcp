/**
 * Canonical parameter names for the universal executor (ADR-001 D5).
 *
 * The specs spell the same idea several ways: V1 pages with `count`, V2 with
 * `limit`; V1 filters dates with `start_date`/`end_date`, V2 with
 * `filter[date_intersect_from]`; V1 says `activity_id` where the product says
 * event. The model is shown one vocabulary — the one the curated tools use
 * (`page_size`, `date_from`, `date_to`, `team_member_id`, `event_id`) — and the
 * executor translates it back to the spec's spelling on the wire. Every legacy
 * spelling stays accepted, so a model that read the raw spec still gets through.
 *
 * Path parameters keep the entity-id alias table only (`record_id` →
 * `appointment_id`): their names are part of the displayed path, and a date in
 * a path is a positional segment, not a filter.
 */
import {
  acceptedNames,
  canonicalName,
  type CatalogOperation,
  type CatalogParameter,
} from './catalog.js';

/**
 * Query-parameter spellings → canonical names, on top of the entity-id alias
 * table. Applied after a `filter[…]` wrapper and a trailing `[]` are removed.
 */
export const QUERY_ALIASES: Readonly<Record<string, string>> = {
  count: 'page_size',
  limit: 'page_size',
  per_page: 'page_size',
  start_date: 'date_from',
  end_date: 'date_to',
  date_intersect_from: 'date_from',
  date_intersect_to: 'date_to',
  from: 'date_from',
  to: 'date_to',
  c_start_date: 'created_from',
  c_end_date: 'created_to',
  created_start_date: 'created_from',
  created_end_date: 'created_to',
  with_deleted: 'include_deleted',
  activity_id: 'event_id',
  created_user_id: 'created_by_user_id',
  staff_ids: 'team_member_ids',
  master_ids: 'team_member_ids',
  company_ids: 'location_ids',
  record_ids: 'appointment_ids',
  good_ids: 'product_ids',
};

/** Canonical name → the query spellings that mean it (`page_size` → count, limit, per_page). */
const QUERY_LEGACY: Readonly<Record<string, readonly string[]>> = (() => {
  const out: Record<string, string[]> = {};
  for (const [legacy, canonical] of Object.entries(QUERY_ALIASES)) {
    (out[canonical] ??= []).push(legacy);
  }
  return out;
})();

/** `filter[date_intersect_from]` → `date_intersect_from`; `team_member_ids[]` → `team_member_ids`. */
export function unwrapQueryName(specName: string): string {
  const bare = specName.replace(/\[\]$/, '');
  const filter = /^filter\[([^\]]+)\](?:\[\])?$/.exec(bare);
  return filter?.[1] ?? bare;
}

function canonicalQueryName(specName: string): string {
  const bare = unwrapQueryName(specName);
  return QUERY_ALIASES[bare] ?? canonicalName(bare);
}

function paramKey(param: Pick<CatalogParameter, 'in' | 'name'>): string {
  return `${param.in}:${param.name}`;
}

const exposedCache = new WeakMap<CatalogOperation, Map<string, string>>();

/**
 * The exposed name of every path and query parameter of one operation. An
 * overlay rename wins; then path parameters take the entity alias, query
 * parameters the query alias. Two parameters never share an exposed name: the
 * later one keeps its spec spelling, so nothing becomes ambiguous.
 */
function exposedNames(op: CatalogOperation): Map<string, string> {
  const cached = exposedCache.get(op);
  if (cached) return cached;

  const names = new Map<string, string>();
  const taken = new Set<string>();
  const ordered = [
    ...op.parameters.filter((p) => p.in === 'path'),
    ...op.parameters.filter((p) => p.in !== 'path'),
  ];
  for (const param of ordered) {
    const renamed = op.curation?.param_renames?.[param.name];
    const candidate =
      renamed ??
      (param.in === 'query'
        ? canonicalQueryName(param.name)
        : canonicalName(param.name));
    const exposed = taken.has(candidate) ? param.name : candidate;
    taken.add(exposed);
    names.set(paramKey(param), exposed);
  }
  exposedCache.set(op, names);
  return names;
}

/**
 * The canonical name the model is shown for one spec parameter. A name that is
 * not a declared parameter (a path placeholder the spec forgot to declare)
 * takes the entity alias.
 */
export function exposedParamName(
  op: CatalogOperation,
  specName: string,
  location?: string
): string {
  const param = op.parameters.find(
    (p) => p.name === specName && (location === undefined || p.in === location)
  );
  if (!param) {
    return op.curation?.param_renames?.[specName] ?? canonicalName(specName);
  }
  return exposedNames(op).get(paramKey(param)) ?? param.name;
}

/**
 * Every spelling the executor accepts for one parameter, most canonical first:
 * the exposed name, the spec spelling, the entity aliases, and the legacy
 * query spellings of the same canonical idea.
 */
export function acceptedParamNames(
  op: CatalogOperation,
  specName: string,
  location?: string
): string[] {
  const exposed = exposedParamName(op, specName, location);
  const names = new Set<string>([exposed, specName]);
  for (const name of acceptedNames(specName)) names.add(name);
  if (location !== 'path') {
    names.add(unwrapQueryName(specName));
    for (const legacy of QUERY_LEGACY[exposed] ?? []) names.add(legacy);
  }
  for (const name of acceptedNames(exposed)) names.add(name);
  return [...names];
}

/** The spec parameter an operation pages with, by canonical role. */
export function pagingParameters(op: CatalogOperation): {
  page?: CatalogParameter;
  size?: CatalogParameter;
} {
  const query = op.parameters.filter((p) => p.in === 'query');
  return {
    page: query.find((p) => exposedParamName(op, p.name, 'query') === 'page'),
    size: query.find(
      (p) => exposedParamName(op, p.name, 'query') === 'page_size'
    ),
  };
}

/** Whether a spec spelling denotes a list on the wire (`ids[]`, `filter[x][]`). */
export function isArrayWireName(specName: string): boolean {
  return specName.endsWith('[]');
}
