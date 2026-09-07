/**
 * Typed access to the generated API catalog (ADR-001 D4).
 *
 * `src/generated/catalog.json` is built from the corporate OpenAPI specs by
 * `scripts/catalog/build.mjs` and committed, so this module is a pure read: no
 * spec repository, no network and no parsing cost beyond the JSON import that
 * `tsc` copies into `dist/generated/`.
 *
 * The catalog backs the three executor tools — `altegio_search_operations`,
 * `altegio_describe_operation`, `altegio_call_operation` — and will back the
 * generated domain packs.
 */
import catalogJson from '../../generated/catalog.json' with { type: 'json' };

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
  /** `v1` when the spec wraps the payload in `{success, data, meta}`. */
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
  notes?: string;
}

export interface CatalogOperation {
  operationId: string;
  /** Which spec the operation comes from: `v1` is live, `v3` is a preview. */
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
  operations: CatalogOperation[];
}

export const catalog = catalogJson as unknown as Catalog;

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
  catalog.operations.map((op) => [op.operationId, op])
);

export function getOperation(
  operationId: string
): CatalogOperation | undefined {
  return byOperationId.get(operationId);
}

export function allOperations(): readonly CatalogOperation[] {
  return catalog.operations;
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

/** The curated tool that already covers this operation, if any. */
export function curatedToolFor(op: CatalogOperation): string | undefined {
  return op.curation?.tool_name;
}
