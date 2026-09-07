#!/usr/bin/env node
/**
 * Catalog build — ADR-001 D4.
 *
 * Reads the corporate OpenAPI specs (B2B v1, live; B2B v3, preview contract),
 * resolves `$ref`-ed path items and local/relative schema refs, merges the
 * curation overlay from `catalog/overlay/*.yaml`, and writes a deterministic
 * `src/generated/catalog.json` — one entry per operation.
 *
 * The catalog is the source of truth for the executor tools
 * (`altegio_search_operations`, `altegio_describe_operation`,
 * `altegio_call_operation`) and, later, for generated domain tool packs.
 *
 * Usage:
 *   node scripts/catalog/build.mjs [--docs <spec repo>] [--out <file>]
 *   node scripts/catalog/build.mjs --check       # fail if the committed file is stale
 *
 * The spec repository is read-only for this project (see OPENAPI.md). When it
 * is absent — CI does not clone it — the script prints a notice and exits 0.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');

/** Schema version of `catalog.json`; bump when the entry shape changes. */
export const CATALOG_VERSION = 1;

/** How deep dereferenced request/response schemas are kept (D8: context economy). */
const MAX_SCHEMA_DEPTH = 3;

/** Schema keys dropped on the way into the catalog (D8: context economy). */
const SCHEMA_DROP_KEYS = new Set(['example', 'examples', 'title', 'externalDocs']);

/** Longest schema `description` kept, in characters. */
const MAX_SCHEMA_DESCRIPTION = 200;

/**
 * Serialized-byte budget for one request/response schema. A schema over budget
 * is rebuilt one depth level shallower until it fits, so no single operation can
 * push an `altegio_describe_operation` result past the per-result token budget
 * (ADR-001 D8). ~8 KB of JSON is roughly 2k tokens.
 */
const MAX_SCHEMA_BYTES = 8000;

/** Transport plumbing headers the API client always supplies itself. */
const PLUMBING_HEADERS = new Set([
  'accept',
  'authorization',
  'content-type',
  'user-token',
]);

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const METHOD_RANK = new Map(METHODS.map((m, i) => [m, i]));

/** Specs that feed the catalog. `b2b-v2` is internal-only by API-team policy. */
const SPECS = [
  { source: 'v1', rel: 'docs/en/b2b-v1/openapi.yaml' },
  { source: 'v3', rel: 'docs/en/b2b-v3/openapi.yaml' },
];

/**
 * Legacy path/parameter names → canonical glossary names. The real HTTP path
 * keeps the spec spelling; `displayPath` and the alias table are what the model
 * sees. V1 accepts every canonical alias on the wire (see the V1 spec preamble).
 */
export const CANONICAL_ALIASES = {
  company_id: 'location_id',
  salon_id: 'location_id',
  company_group_id: 'chain_id',
  salon_group_id: 'chain_id',
  staff_id: 'team_member_id',
  master_id: 'team_member_id',
  record_id: 'appointment_id',
  good_id: 'product_id',
};

/** OpenAPI tag → catalog domain, in canonical product vocabulary. */
const TAG_DOMAINS = {
  'authentication b2b': 'auth',
  authorization: 'auth',
  locations: 'locations',
  'chain management': 'chain',
  'team members': 'team_members',
  positions: 'positions',
  services: 'services',
  'service categories': 'services',
  'schedule & resources': 'schedule',
  resources: 'resources',
  availability: 'availability',
  appointments: 'appointments',
  visits: 'visits',
  clients: 'clients',
  events: 'events',
  products: 'products',
  inventory: 'inventory',
  'users & permissions': 'users',
  'subscriptions & certificates': 'memberships',
  'analytics & reports': 'analytics',
  'loyalty cards': 'loyalty',
  'loyalty programs': 'loyalty',
  'chain loyalty programs': 'loyalty',
  deposits: 'client_accounts',
  salary: 'payroll',
  payments: 'payments',
  sales: 'sales',
  fiscalization: 'fiscalization',
  notifications: 'notifications',
  'online booking settings': 'online_booking',
  'custom fields': 'custom_fields',
  tags: 'tags',
  utilities: 'utilities',
};

/** Curation fields an overlay entry may set (mirrors catalog/overlay/_schema.yaml). */
const OVERLAY_FIELDS = [
  'domain',
  'tier',
  'facets',
  'tool_name',
  'description',
  'hidden_params',
  'param_renames',
  'projection',
  'write_allowed',
  'notes',
];
const OVERLAY_TIERS = new Set(['core', 'pack', 'executor-only']);

/** Key ranking for the canonical serializer: known keys first, then alphabetical. */
const KEY_ORDER = [
  // catalog root
  'catalogVersion',
  'generator',
  'sources',
  'operationCount',
  'curatedCount',
  'domains',
  // source / domain summary entries
  'source',
  'spec',
  'title',
  'version',
  // operation entry
  'operationId',
  'method',
  'path',
  'displayPath',
  'summary',
  'description',
  'tags',
  'domain',
  'deprecated',
  'status',
  'security',
  'parameters',
  'requestBody',
  'response',
  'curation',
  // parameter / body / response detail
  'name',
  'in',
  'required',
  'schemes',
  'contentType',
  'statusCode',
  'envelope',
  'x-depth-limited',
  // curation detail
  'tier',
  'facets',
  'tool_name',
  'hidden_params',
  'param_renames',
  'projection',
  'write_allowed',
  'notes',
  // long tail last
  'schema',
  'operations',
];
const KEY_RANK = new Map(KEY_ORDER.map((k, i) => [k, i]));

/**
 * Values under these keys are free-form maps whose keys are data (JSON Schema
 * internals, field names, parameter aliases). They and everything below them
 * sort alphabetically — ranking them would order `status` or `name` by their
 * meaning in a catalog entry rather than by their own spelling.
 */
const UNRANKED_SUBTREES = new Set(['schema', 'properties', 'param_renames']);

// ---------------------------------------------------------------------------
// Spec repository discovery
// ---------------------------------------------------------------------------

/**
 * Locate the read-only spec repository. Checks (in order) an explicit path, the
 * `ALTEGIO_API_DOCS` env var, then a `biz.erp.api.docs` sibling of the repo root
 * or of any ancestor — the last case is what makes the build work inside a git
 * worktree, where `../biz.erp.api.docs` no longer resolves.
 */
export function resolveDocsRoot(explicit) {
  const candidates = [];
  if (explicit) candidates.push(path.resolve(explicit));
  if (process.env.ALTEGIO_API_DOCS)
    candidates.push(path.resolve(process.env.ALTEGIO_API_DOCS));

  let dir = REPO_ROOT;
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(dir, '..', 'biz.erp.api.docs'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'docs/en/b2b-v1/openapi.yaml'))) {
      return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// YAML loading and $ref resolution
// ---------------------------------------------------------------------------

const docCache = new Map();

function loadDoc(file) {
  const key = path.resolve(file);
  if (!docCache.has(key)) {
    docCache.set(key, yaml.load(fs.readFileSync(key, 'utf8')));
  }
  return docCache.get(key);
}

/** One-line, length-capped description for a schema node. */
function shortDescription(value) {
  if (typeof value !== 'string') return undefined;
  const line = value.trim().replace(/\s+/g, ' ');
  if (line.length === 0) return undefined;
  return line.length > MAX_SCHEMA_DESCRIPTION
    ? `${line.slice(0, MAX_SCHEMA_DESCRIPTION - 1).trimEnd()}…`
    : line;
}

function pointerLookup(doc, pointer) {
  let node = doc;
  for (const rawPart of pointer.split('/')) {
    if (rawPart === '' || rawPart === '#') continue;
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object') return undefined;
    node = Array.isArray(node) ? node[Number(part)] : node[part];
  }
  return node;
}

/**
 * Resolve one `$ref` (`file`, `#/pointer`, or `file#/pointer`) against the file
 * it appeared in. Returns the target node plus the file that now owns nested
 * relative refs, or `null` when the target is missing.
 */
function resolveRef(ref, baseFile, rootFile) {
  const [filePart, pointerPart] = ref.split('#');
  let targetFile = baseFile;

  if (filePart) {
    targetFile = path.resolve(path.dirname(baseFile), filePart);
    if (!fs.existsSync(targetFile)) return null;
  }

  let doc = loadDoc(targetFile);
  if (!pointerPart) return { value: doc, file: targetFile };

  let value = pointerLookup(doc, pointerPart);
  // Local pointers inside a fragment file usually address the spec root.
  if (value === undefined && !filePart && rootFile && rootFile !== targetFile) {
    value = pointerLookup(loadDoc(rootFile), pointerPart);
    if (value !== undefined) return { value, file: rootFile };
  }
  return value === undefined ? null : { value, file: targetFile };
}

/**
 * Dereference a schema to `maxDepth` levels. Cycles collapse to
 * `{ 'x-circular': <ref> }`; anything below the depth budget collapses to
 * `{ 'x-truncated': true }` so the catalog stays small enough to keep a
 * describe/call result inside the per-result token budget (D8).
 */
function derefSchema(node, ctx, depth = 0, refStack = []) {
  const maxDepth = ctx.maxDepth ?? MAX_SCHEMA_DEPTH;
  if (node === null || typeof node !== 'object') return node;

  if (Array.isArray(node)) {
    return node.map((item) => derefSchema(item, ctx, depth, refStack));
  }

  if (typeof node.$ref === 'string') {
    const ref = node.$ref;
    if (refStack.includes(ref)) {
      return { 'x-circular': ref };
    }
    const resolved = resolveRef(ref, ctx.file, ctx.rootFile);
    if (!resolved) {
      ctx.warnings.push(`unresolved $ref ${ref} (from ${ctx.file})`);
      return { 'x-unresolved-ref': ref };
    }
    const { $ref: _ignored, ...siblings } = node;
    const inner = derefSchema(
      resolved.value,
      { ...ctx, file: resolved.file },
      depth,
      [...refStack, ref]
    );
    return typeof inner === 'object' && inner !== null && !Array.isArray(inner)
      ? { ...inner, ...derefSchema(siblings, ctx, depth, refStack) }
      : inner;
  }

  if (depth >= maxDepth) {
    const kept = {};
    if (node.type !== undefined) kept.type = node.type;
    const description = shortDescription(node.description);
    if (description) kept.description = description;
    kept['x-truncated'] = true;
    return kept;
  }

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    // Spec prose for human readers; multiplies the catalog size for no gain.
    if (SCHEMA_DROP_KEYS.has(key) || key.startsWith('x-')) continue;
    if (key === 'description') {
      const description = shortDescription(value);
      if (description) out.description = description;
      continue;
    }
    // A depth level is one step from a schema to a nested schema — the
    // `properties` map itself is not a level, or truncation would erase whole
    // field lists instead of the objects behind them.
    if (
      key === 'properties' &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([field, fieldSchema]) => [
          field,
          derefSchema(fieldSchema, ctx, depth + 1, refStack),
        ])
      );
      continue;
    }
    const nextDepth =
      key === 'items' || key === 'additionalProperties' ? depth + 1 : depth;
    out[key] = derefSchema(value, ctx, nextDepth, refStack);
  }
  return out;
}

/**
 * Dereference a schema, shrinking the depth budget until it fits
 * `MAX_SCHEMA_BYTES`. `x-depth-limited` records the level it settled on.
 */
function fitSchema(schema, ctx) {
  let out;
  for (let maxDepth = MAX_SCHEMA_DEPTH; maxDepth >= 1; maxDepth--) {
    out = derefSchema(schema, { ...ctx, maxDepth }, 0);
    const fits = JSON.stringify(out ?? null).length <= MAX_SCHEMA_BYTES;
    if (fits || maxDepth === 1) {
      if (
        maxDepth < MAX_SCHEMA_DEPTH &&
        out !== null &&
        typeof out === 'object' &&
        !Array.isArray(out)
      ) {
        out['x-depth-limited'] = maxDepth;
      }
      return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Operation extraction
// ---------------------------------------------------------------------------

function canonicalisePath(specPath) {
  return specPath.replace(/\{([^}]+)\}/g, (match, name) => {
    const canonical = CANONICAL_ALIASES[name];
    return canonical ? `{${canonical}}` : match;
  });
}

function slugifyDomain(tag) {
  return tag
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function inferDomain(tags, specPath) {
  for (const tag of tags) {
    const mapped = TAG_DOMAINS[tag.toLowerCase()];
    if (mapped) return mapped;
  }
  if (tags.length > 0) return slugifyDomain(tags[0]);
  const [firstSegment] = specPath.replace(/^\//, '').split('/');
  return firstSegment ? slugifyDomain(firstSegment) : 'other';
}

function firstLine(text) {
  if (typeof text !== 'string') return undefined;
  const line = text.trim().split('\n')[0].trim();
  return line.length > 0 ? line : undefined;
}

function extractSecurity(operation, rootDoc) {
  const security = operation.security ?? rootDoc.security;
  if (!Array.isArray(security)) return { required: true, schemes: [] };
  if (security.length === 0) return { required: false, schemes: [] };
  const schemes = [
    ...new Set(security.flatMap((entry) => Object.keys(entry ?? {}))),
  ].sort();
  return { required: true, schemes };
}

function pickParameters(pathItem, operation, ctx) {
  const merged = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])];
  const seen = new Set();
  const out = [];

  for (const raw of merged) {
    const param =
      typeof raw?.$ref === 'string'
        ? (resolveRef(raw.$ref, ctx.file, ctx.rootFile)?.value ?? null)
        : raw;
    if (!param || typeof param.name !== 'string') continue;
    if (param.in === 'header' && PLUMBING_HEADERS.has(param.name.toLowerCase()))
      continue;

    const key = `${param.in}:${param.name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const entry = { name: param.name, in: param.in ?? 'query' };
    entry.required = param.required === true || param.in === 'path';
    const description = firstLine(param.description);
    if (description) entry.description = description;
    if (param.schema) entry.schema = derefSchema(param.schema, ctx, 1);
    out.push(entry);
  }

  return out.sort((a, b) => {
    const inRank = (p) => (p.in === 'path' ? 0 : p.in === 'query' ? 1 : 2);
    return inRank(a) - inRank(b) || a.name.localeCompare(b.name);
  });
}

function pickBody(operation, ctx) {
  let requestBody = operation.requestBody;
  if (typeof requestBody?.$ref === 'string') {
    requestBody = resolveRef(requestBody.$ref, ctx.file, ctx.rootFile)?.value;
  }
  const content = requestBody?.content;
  if (!content) return undefined;

  const contentType =
    ['application/json', 'application/*+json', '*/*'].find((t) => content[t]) ??
    Object.keys(content).sort()[0];
  if (!contentType) return undefined;

  const entry = {
    required: requestBody.required === true,
    contentType,
  };
  const schema = content[contentType]?.schema;
  if (schema) entry.schema = fitSchema(schema, ctx);
  return entry;
}

/**
 * Follow a `$ref` chain without spending depth budget, so the caller can look
 * at the real node. Returns the node and the file that owns its nested refs.
 */
function resolveTopSchema(schema, ctx) {
  let node = schema;
  let file = ctx.file;
  const seen = new Set();

  while (node && typeof node.$ref === 'string' && !seen.has(node.$ref)) {
    seen.add(node.$ref);
    const resolved = resolveRef(node.$ref, file, ctx.rootFile);
    if (!resolved) return { node: schema, file };
    node = resolved.value;
    file = resolved.file;
  }
  return { node, file };
}

/**
 * The V1 `{success, data, meta}` wrapper is transport, not payload: the client
 * unwraps it and so does `altegio_call_operation`. Storing `data` directly keeps
 * the catalog describing what a caller actually receives and spends the depth
 * budget on the payload instead of the envelope.
 */
function unwrapEnvelope(schema, ctx) {
  const { node, file } = resolveTopSchema(schema, ctx);
  const properties = node?.properties;
  if (
    node?.type === 'object' &&
    properties &&
    typeof properties === 'object' &&
    properties.data !== undefined &&
    properties.success !== undefined
  ) {
    return { schema: properties.data, file, envelope: 'v1' };
  }
  return { schema, file: ctx.file };
}

function pickResponse(operation, ctx) {
  let responses = operation.responses;
  if (typeof responses?.$ref === 'string') {
    responses = resolveRef(responses.$ref, ctx.file, ctx.rootFile)?.value;
  }
  if (!responses || typeof responses !== 'object') return undefined;

  const codes = Object.keys(responses).map(String);
  const preferred =
    ['200', '201', '202', '204'].find((c) => codes.includes(c)) ??
    codes.filter((c) => /^2\d\d$/.test(c)).sort()[0];
  if (!preferred) return undefined;

  let response = responses[preferred] ?? responses[Number(preferred)];
  if (typeof response?.$ref === 'string') {
    response = resolveRef(response.$ref, ctx.file, ctx.rootFile)?.value;
  }
  if (!response) return undefined;

  const entry = { statusCode: preferred };
  const content = response.content;
  if (content) {
    const contentType =
      ['application/json', 'application/*+json', '*/*'].find(
        (t) => content[t]
      ) ?? Object.keys(content).sort()[0];
    if (contentType) {
      entry.contentType = contentType;
      const schema = content[contentType]?.schema;
      if (schema) {
        const unwrapped = unwrapEnvelope(schema, ctx);
        if (unwrapped.envelope) entry.envelope = unwrapped.envelope;
        entry.schema = fitSchema(unwrapped.schema, {
          ...ctx,
          file: unwrapped.file,
        });
      }
    }
  }
  return entry;
}

/** Read one spec file and return its operation entries plus source metadata. */
function readSpec({ source, rel }, docsRoot, warnings) {
  const specFile = path.join(docsRoot, rel);
  if (!fs.existsSync(specFile)) {
    warnings.push(`spec not found, skipped: ${rel}`);
    return null;
  }

  const rootDoc = loadDoc(specFile);
  const operations = [];

  for (const [specPath, rawItem] of Object.entries(rootDoc.paths ?? {})) {
    let pathItem = rawItem;
    let itemFile = specFile;

    if (typeof rawItem?.$ref === 'string') {
      const resolved = resolveRef(rawItem.$ref, specFile, specFile);
      if (!resolved) {
        warnings.push(`missing path item for ${specPath}: ${rawItem.$ref}`);
        continue;
      }
      pathItem = resolved.value;
      itemFile = resolved.file;
    }
    if (!pathItem || typeof pathItem !== 'object') continue;

    for (const method of METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== 'object') continue;

      const ctx = { file: itemFile, rootFile: specFile, warnings };
      const tags = Array.isArray(operation.tags) ? [...operation.tags] : [];
      const operationId =
        typeof operation.operationId === 'string' && operation.operationId
          ? operation.operationId
          : `${source}_${method}_${slugifyDomain(specPath)}`;

      const entry = {
        operationId,
        source,
        method: method.toUpperCase(),
        path: specPath,
        displayPath: canonicalisePath(specPath),
        tags,
        domain: inferDomain(tags, specPath),
        deprecated: operation.deprecated === true,
        security: extractSecurity(operation, rootDoc),
        parameters: pickParameters(pathItem, operation, ctx),
      };

      const summary = firstLine(operation.summary);
      if (summary) entry.summary = summary;
      const description =
        typeof operation.description === 'string'
          ? operation.description.trim()
          : undefined;
      if (description) entry.description = description;
      if (typeof operation['x-altegio-status'] === 'string') {
        entry.status = operation['x-altegio-status'];
      }

      const body = pickBody(operation, ctx);
      if (body) entry.requestBody = body;
      const response = pickResponse(operation, ctx);
      if (response) entry.response = response;

      operations.push(entry);
    }
  }

  return {
    meta: {
      source,
      spec: rel,
      title: rootDoc.info?.title ?? '',
      version: String(rootDoc.info?.version ?? ''),
      operations: operations.length,
    },
    operations,
  };
}

// ---------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------

/**
 * Load `catalog/overlay/*.yaml` (files starting with `_` are format docs, not
 * data) into `operationId → curation` entries. Unknown fields and bad tiers
 * fail the build so a typo in the overlay never silently disappears.
 */
export function loadOverlay(overlayDir) {
  const curation = new Map();
  if (!fs.existsSync(overlayDir)) return curation;

  const files = fs
    .readdirSync(overlayDir)
    .filter((f) => /\.ya?ml$/.test(f) && !f.startsWith('_'))
    .sort();

  for (const file of files) {
    const full = path.join(overlayDir, file);
    const doc = yaml.load(fs.readFileSync(full, 'utf8')) ?? {};
    for (const [operationId, raw] of Object.entries(doc.operations ?? {})) {
      if (!raw || typeof raw !== 'object') continue;

      const unknown = Object.keys(raw).filter(
        (k) => !OVERLAY_FIELDS.includes(k)
      );
      if (unknown.length > 0) {
        throw new Error(
          `${file}: operation "${operationId}" has unknown overlay field(s): ${unknown.join(', ')}`
        );
      }
      if (raw.tier !== undefined && !OVERLAY_TIERS.has(raw.tier)) {
        throw new Error(
          `${file}: operation "${operationId}" has invalid tier "${raw.tier}" (expected ${[...OVERLAY_TIERS].join(' | ')})`
        );
      }
      if (curation.has(operationId)) {
        throw new Error(
          `duplicate overlay entry for "${operationId}" (second one in ${file})`
        );
      }

      const entry = {};
      for (const field of OVERLAY_FIELDS) {
        if (raw[field] !== undefined) entry[field] = raw[field];
      }
      curation.set(operationId, entry);
    }
  }

  return curation;
}

// ---------------------------------------------------------------------------
// Deterministic serialization
// ---------------------------------------------------------------------------

function rank(key, ranked) {
  if (!ranked) return KEY_ORDER.length;
  return KEY_RANK.has(key) ? KEY_RANK.get(key) : KEY_ORDER.length;
}

/**
 * JSON.stringify with a stable key order: catalog-structure keys in the order a
 * reviewer reads them, everything else alphabetical. Deterministic for a given
 * input, so a rebuild produces a byte-identical file.
 */
export function stableStringify(value, indent = 2, level = 0, ranked = true) {
  const pad = ' '.repeat(indent * level);
  const padInner = ' '.repeat(indent * (level + 1));

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map(
      (item) => padInner + stableStringify(item, indent, level + 1, ranked)
    );
    return `[\n${items.join(',\n')}\n${pad}]`;
  }

  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort((a, b) => rank(a, ranked) - rank(b, ranked) || a.localeCompare(b));
    if (keys.length === 0) return '{}';
    const entries = keys.map((key) => {
      const childRanked = ranked && !UNRANKED_SUBTREES.has(key);
      return `${padInner}${JSON.stringify(key)}: ${stableStringify(value[key], indent, level + 1, childRanked)}`;
    });
    return `{\n${entries.join(',\n')}\n${pad}}`;
  }

  return JSON.stringify(value ?? null);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/** Build the catalog object from a spec repository plus the overlay directory. */
export function buildCatalog({ docsRoot, overlayDir }) {
  const warnings = [];
  const sources = [];
  const operations = [];

  for (const spec of SPECS) {
    const read = readSpec(spec, docsRoot, warnings);
    if (!read) continue;
    sources.push(read.meta);
    operations.push(...read.operations);
  }

  const byId = new Map();
  for (const op of operations) {
    const clash = byId.get(op.operationId);
    if (clash) {
      throw new Error(
        `duplicate operationId "${op.operationId}": ` +
          `${clash.source} ${clash.method} ${clash.path} and ${op.source} ${op.method} ${op.path}`
      );
    }
    byId.set(op.operationId, op);
  }

  const curation = loadOverlay(overlayDir);
  let curatedCount = 0;
  for (const [operationId, entry] of curation) {
    const op = byId.get(operationId);
    if (!op) {
      warnings.push(
        `overlay entry "${operationId}" matches no operation in the specs`
      );
      continue;
    }
    op.curation = entry;
    if (entry.domain) op.domain = entry.domain;
    curatedCount += 1;
  }

  operations.sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.path.localeCompare(b.path) ||
      METHOD_RANK.get(a.method.toLowerCase()) -
        METHOD_RANK.get(b.method.toLowerCase())
  );

  // An array, not a map: domain names would otherwise collide with the
  // serializer's key ranking and sort unpredictably.
  const counts = new Map();
  for (const op of operations) {
    counts.set(op.domain, (counts.get(op.domain) ?? 0) + 1);
  }
  const domains = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([domain, count]) => ({ domain, operations: count }));

  return {
    catalog: {
      catalogVersion: CATALOG_VERSION,
      generator: 'scripts/catalog/build.mjs',
      sources,
      operationCount: operations.length,
      curatedCount,
      domains,
      operations,
    },
    warnings,
  };
}

/** Serialize a catalog object exactly the way the committed file is written. */
export function serializeCatalog(catalog) {
  return `${stableStringify(catalog)}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { check: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') out.check = true;
    else if (arg === '--docs') out.docs = argv[++i];
    else if (arg === '--out') out.out = argv[++i];
    else if (arg === '--quiet') out.quiet = true;
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  const outFile = path.resolve(
    args.out ?? path.join(REPO_ROOT, 'src/generated/catalog.json')
  );
  const overlayDir = path.join(REPO_ROOT, 'catalog/overlay');

  const docsRoot = resolveDocsRoot(args.docs);
  if (!docsRoot) {
    console.log(
      'catalog: OpenAPI spec repository not found — skipping.\n' +
        '  Expected a `biz.erp.api.docs` checkout next to this repository, or\n' +
        '  pass --docs <path> / set ALTEGIO_API_DOCS. See OPENAPI.md.\n' +
        (args.check
          ? '  --check is a no-op without the spec (CI does not clone it).'
          : `  Nothing written; the committed ${path.relative(REPO_ROOT, outFile)} is unchanged.`)
    );
    return 0;
  }

  const { catalog, warnings } = buildCatalog({ docsRoot, overlayDir });
  const serialized = serializeCatalog(catalog);

  if (args.check) {
    if (!fs.existsSync(outFile)) {
      console.error(
        `catalog:check FAILED — ${path.relative(REPO_ROOT, outFile)} is missing. Run \`npm run catalog:build\`.`
      );
      return 1;
    }
    const committed = fs.readFileSync(outFile, 'utf8');
    if (committed !== serialized) {
      const tmp = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'altegio-catalog-')),
        'catalog.json'
      );
      fs.writeFileSync(tmp, serialized);
      console.error(
        `catalog:check FAILED — ${path.relative(REPO_ROOT, outFile)} is stale.\n` +
          `  Rebuilt catalog written to ${tmp}\n` +
          '  Run `npm run catalog:build` and commit the result.'
      );
      return 1;
    }
    console.log(
      `catalog:check OK — ${catalog.operationCount} operations, ${catalog.curatedCount} curated.`
    );
    return 0;
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, serialized);

  if (!args.quiet) {
    for (const source of catalog.sources) {
      console.log(
        `  ${source.source.padEnd(3)} ${source.spec} → ${source.operations} operations`
      );
    }
    console.log(
      `catalog: ${catalog.operationCount} operations, ${catalog.curatedCount} curated, ` +
        `${Object.keys(catalog.domains).length} domains, ` +
        `${(Buffer.byteLength(serialized) / 1024).toFixed(0)} KB → ${path.relative(REPO_ROOT, outFile)}`
    );
    for (const warning of warnings.slice(0, 20)) {
      console.warn(`  warning: ${warning}`);
    }
    if (warnings.length > 20) {
      console.warn(`  ... and ${warnings.length - 20} more warnings`);
    }
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
