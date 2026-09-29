/**
 * Typed access to the generated API catalog (ADR-001 D4).
 *
 * `src/generated/catalog.json` is built from the corporate OpenAPI specs by
 * `scripts/catalog/build.mjs` and committed, so this module is a pure read: no
 * spec repository, no network and no parsing cost beyond the JSON import that
 * `tsc` copies into `dist/generated/`.
 *
 * The catalog backs the three executor tools — `api_search_operations`,
 * `api_describe_operation`, `api_call_operation` — and will back the
 * generated domain packs.
 */
import catalogJson from '../../generated/catalog.json' with { type: 'json' };
import { isDisabledOperationPath } from '../disabled-tools.js';

/** One documented parameter of an operation. */
export interface CatalogParameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

/** Request or response payload shape, dereferenced to a bounded depth. */
export interface CatalogPayload {
  required?: boolean;
  contentType?: string;
  statusCode?: string;
  /**
   * How the response is wrapped: `v1` for `{success, data, meta}`, `jsonapi`
   * for a `{data, meta}` document. Either is unwrapped before the caller sees it.
   */
  envelope?: string;
  schema?: Record<string, unknown>;
}

/** Human curation merged in from `catalog/overlay/*.yaml`. */
export interface CatalogCuration {
  domain?: string;
  tier?: 'core' | 'pack' | 'executor-only';
  facets?: string[];
  tool_name?: string;
  description?: string;
  hidden_params?: string[];
  param_renames?: Record<string, string>;
  projection?: string[];
  write_allowed?: boolean;
  /** V1 operationIds this operation replaces (they are not in the catalog). */
  supersedes?: string[];
  notes?: string;
}

export interface CatalogOperation {
  operationId: string;
  /**
   * The spec's own operationId when the catalog id differs from it — the V2
   * spec suffixes some ids with `_v2`, which the catalog drops. Internal: the
   * model is shown the catalog id only.
   */
  specOperationId?: string;
  /**
   * Which spec the operation comes from: `v1` and `v2` are live, `v3` is a
   * preview. Internal for live operations — the model never sees a version;
   * only a preview operation is labelled as one.
   */
  source: string;
  method: string;
  /** Real HTTP path, with the spec's own parameter spelling. */
  path: string;
  /** Same path with legacy segments renamed to canonical ones, for display. */
  displayPath: string;
  summary?: string;
  description?: string;
  tags: string[];
  domain: string;
  deprecated: boolean;
  /** `x-altegio-status` from the V3 preview contract. */
  status?: string;
  security: { required: boolean; schemes: string[] };
  parameters: CatalogParameter[];
  requestBody?: CatalogPayload;
  response?: CatalogPayload;
  curation?: CatalogCuration;
}

export interface Catalog {
  catalogVersion: number;
  generator: string;
  sources: Array<{
    source: string;
    spec: string;
    title: string;
    version: string;
    operations: number;
  }>;
  /** Legacy spec parameter name → canonical glossary name. */
  canonicalAliases: Record<string, string>;
  operationCount: number;
  curatedCount: number;
  domains: Array<{ domain: string; operations: number }>;
  supersededCount: number;
  operations: CatalogOperation[];
  /**
   * V1 operations whose V2 twin is canonical. They are not callable,
   * searchable or describable; an id from this list resolves to its survivor
   * only to point a caller at it.
   */
  superseded: SupersededOperation[];
}

export interface SupersededOperation {
  operationId: string;
  source: string;
  method: string;
  path: string;
  supersededBy: string;
  /** `same-id` (the specs share the id) or `declared` (the overlay names it). */
  reason: string;
}

export const catalog = catalogJson as unknown as Catalog;

/** Specs served by the live API; anything else (`v3`) is a preview contract. */
const LIVE_SOURCES = new Set(['v1', 'v2']);

/** Whether an operation's spec is served by the live API today. */
export function isLiveSource(source: string): boolean {
  return LIVE_SOURCES.has(source);
}

/** Legacy spec name → canonical name (`staff_id` → `team_member_id`). */
export const canonicalAliases: Record<string, string> =
  catalog.canonicalAliases;

/** Canonical name → every legacy spec name that means the same thing. */
export const legacyAliases: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  for (const [legacy, canonicalName] of Object.entries(canonicalAliases)) {
    (out[canonicalName] ??= []).push(legacy);
  }
  for (const names of Object.values(out)) names.sort();
  return out;
})();

const byOperationId = new Map<string, CatalogOperation>(
  catalog.operations
    .filter((op) => !isDisabledOperationPath(op.path))
    .map((op) => [op.operationId, op])
);

export function getOperation(
  operationId: string
): CatalogOperation | undefined {
  return byOperationId.get(operationId);
}

/**
 * Every operation the executor may see. The report-builder routes are filtered
 * out here — the one funnel search, describe and call share — for the reasons in
 * `../disabled-tools.ts`.
 */
const searchableOperations: readonly CatalogOperation[] =
  catalog.operations.filter((op) => !isDisabledOperationPath(op.path));

export function allOperations(): readonly CatalogOperation[] {
  return searchableOperations;
}

/** The canonical name for a spec parameter, or the name itself when it is already canonical. */
export function canonicalName(specName: string): string {
  return canonicalAliases[specName] ?? specName;
}

/**
 * Every parameter name the executor accepts for one spec parameter: the spec
 * spelling, its canonical alias, and the other legacy spellings of that same
 * canonical name — so a model that learned `team_member_id` from the glossary
 * and a model that read `staff_id` from the spec both get through.
 */
export function acceptedNames(specName: string): string[] {
  const canonical = canonicalName(specName);
  const names = new Set<string>([specName, canonical]);
  for (const legacy of legacyAliases[canonical] ?? []) names.add(legacy);
  return [...names];
}

const supersededIds = new Map<string, string>(
  (catalog.superseded ?? []).map((s) => [s.operationId, s.supersededBy])
);

/**
 * The canonical operation that replaced a retired id, if the id was retired.
 * Only ids that differ from their survivor can reach this: a same-id twin
 * resolves to the survivor directly.
 */
export function replacementFor(operationId: string): string | undefined {
  const survivor = supersededIds.get(operationId);
  return survivor && survivor !== operationId ? survivor : undefined;
}

/** Whether an operation is only a preview of a future contract. */
export function isPreview(op: Pick<CatalogOperation, 'source'>): boolean {
  return !isLiveSource(op.source);
}

/** The curated tool that already covers this operation, if any. */
export function curatedToolFor(op: CatalogOperation): string | undefined {
  return op.curation?.tool_name;
}
