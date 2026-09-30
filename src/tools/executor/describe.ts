/**
 * Operation description — backs `api_describe_operation`.
 *
 * Renders one catalog entry into the contract a caller needs before invoking
 * `api_call_operation`: parameters with types and requiredness, request and
 * response shapes, authentication, deprecation, spec source, the curated tool
 * that may already do the job, and the canonical-terminology notes that say
 * which legacy parameter names the API accepts under canonical spellings.
 */
import {
  acceptedNames,
  canonicalName,
  getOperation,
  isLiveSource,
  isPreview,
  replacementFor,
  type CatalogOperation,
  type CatalogParameter,
} from './catalog.js';
import { enforceBudget, NARROW_HINT } from './budget.js';
import { searchOperations } from './search.js';
import { readingNotesFor } from './reading-notes.js';
import {
  currentView,
  elsewhereClause,
  servesPasswordLogin,
} from '../serving-view.js';

export interface DescribedParameter {
  /** Canonical name to send. */
  name: string;
  /** Spec spelling, when the spec still uses a legacy name. */
  spec_name?: string;
  /** Every spelling `api_call_operation` accepts for this parameter. */
  accepted_names?: string[];
  in: string;
  required: boolean;
  type?: string;
  format?: string;
  enum?: unknown[];
  default?: unknown;
  description?: string;
}

/** JSON-Schema `type` may be a union (`["integer", "null"]`); render it flat. */
function schemaType(schema: Record<string, unknown> | undefined): string {
  if (!schema) return 'string';
  const type = schema.type;
  if (Array.isArray(type)) return type.map(String).join(' | ');
  if (typeof type === 'string') return type;
  if (Array.isArray(schema.enum)) return 'string';
  return 'unknown';
}

/** The canonical name for a parameter: overlay rename first, then the alias table. */
export function exposedParamName(
  op: CatalogOperation,
  specName: string
): string {
  return op.curation?.param_renames?.[specName] ?? canonicalName(specName);
}

function describeParameter(
  op: CatalogOperation,
  param: CatalogParameter
): DescribedParameter {
  const exposed = exposedParamName(op, param.name);
  const accepted = acceptedNames(param.name);
  if (!accepted.includes(exposed)) accepted.push(exposed);
  const schema = param.schema;

  return {
    name: exposed,
    ...(exposed !== param.name ? { spec_name: param.name } : {}),
    ...(accepted.length > 1 ? { accepted_names: accepted.sort() } : {}),
    in: param.in,
    required: param.required === true || param.in === 'path',
    type: schemaType(schema),
    ...(typeof schema?.format === 'string' ? { format: schema.format } : {}),
    ...(Array.isArray(schema?.enum) ? { enum: schema.enum } : {}),
    ...(schema?.default !== undefined ? { default: schema.default } : {}),
    ...(param.description ? { description: param.description } : {}),
  };
}

/**
 * Which legacy spellings this operation accepts under canonical names. The V1
 * API takes the canonical aliases on the wire, so this is a naming note for the
 * model, not a translation the executor has to perform.
 */
export function terminologyNotes(op: CatalogOperation): string[] {
  const notes: string[] = [];
  const seen = new Set<string>();

  for (const param of op.parameters) {
    const exposed = exposedParamName(op, param.name);
    if (exposed === param.name || seen.has(param.name)) continue;
    seen.add(param.name);
    notes.push(`\`${param.name}\` is accepted as \`${exposed}\``);
  }

  if (op.displayPath !== op.path) {
    notes.push(
      `Canonical path \`${op.displayPath}\`; the spec still spells it \`${op.path}\``
    );
  }
  return notes;
}

export interface DescribeOutput {
  text: string;
  structuredContent: Record<string, unknown>;
  found: boolean;
}

/** Suggest neighbours when an operationId does not exist (D8: errors carry the next action). */
function notFound(operationId: string): DescribeOutput {
  const replacement = replacementFor(operationId);
  if (replacement) {
    return {
      found: false,
      text:
        `\`${operationId}\` is not in the API catalog: \`${replacement}\` replaces it. ` +
        `Describe \`${replacement}\` instead.`,
      structuredContent: {
        operation_id: operationId,
        found: false,
        replaced_by: replacement,
        suggestions: [replacement],
      },
    };
  }

  const { hits } = searchOperations(operationId.replace(/[_-]+/g, ' '), {
    limit: 5,
    includePreview: true,
  });

  const suggestions = hits
    .map((h) => `  - ${h.operationId} (${h.method} ${h.path})`)
    .join('\n');

  return {
    found: false,
    text:
      `No operation \`${operationId}\` in the API catalog.\n` +
      (suggestions
        ? `Closest matches:\n${suggestions}\n`
        : 'No close matches.\n') +
      'Use `api_search_operations` to find the operation you need.',
    structuredContent: {
      operation_id: operationId,
      found: false,
      suggestions: hits.map((h) => h.operationId),
    },
  };
}

/** Envelope → the wrapper the caller is spared, named by shape, not by API version. */
const ENVELOPE_SHAPES: Readonly<Record<string, string>> = {
  v1: '{success, data, meta}',
  jsonapi: '{data, meta}',
};

function responseForModel(
  response: NonNullable<CatalogOperation['response']>
): Record<string, unknown> {
  const { envelope, ...rest } = response;
  const shape = envelope ? ENVELOPE_SHAPES[envelope] : undefined;
  return { ...rest, ...(shape ? { unwrapped_from: shape } : {}) };
}

export function describeOperation(operationId: string): DescribeOutput {
  const op = getOperation(operationId);
  if (!op) return notFound(operationId);

  const parameters = op.parameters.map((p) => describeParameter(op, p));
  const notes = terminologyNotes(op);
  const readingNotes = readingNotesFor(op);
  const curatedTool = op.curation?.tool_name;

  const structured: Record<string, unknown> = {
    operation_id: op.operationId,
    method: op.method,
    path: op.displayPath,
    ...(op.path !== op.displayPath ? { spec_path: op.path } : {}),
    // Only a preview names its spec: a live operation is one capability,
    // whichever API version serves it.
    ...(isPreview(op) ? { source: op.source } : {}),
    ...(op.status ? { status: op.status } : {}),
    domain: op.domain,
    ...(op.summary ? { summary: op.summary } : {}),
    ...(op.description ? { description: op.description } : {}),
    deprecated: op.deprecated,
    authentication: {
      required: op.security.required,
      schemes: op.security.schemes,
      note: op.security.required
        ? servesPasswordLogin()
          ? 'Requires a logged-in session — call `auth_login` first.'
          : 'Requires a signed-in user; the app this connection runs in signs it in.'
        : 'Partner token only; no user session needed.',
    },
    parameters,
    ...(op.requestBody ? { request_body: op.requestBody } : {}),
    ...(op.response ? { response: responseForModel(op.response) } : {}),
    callable_by_executor: op.method === 'GET' && isLiveSource(op.source),
    ...(curatedTool ? { curated_tool: curatedTool } : {}),
    // Named as callable only where this view serves it (`../serving-view.ts`).
    ...(curatedTool && !currentView().serves(curatedTool)
      ? {
          curated_tool_served: false,
          curated_tool_addresses: currentView().addressesServing(curatedTool),
        }
      : {}),
    ...(op.curation?.tier ? { tier: op.curation.tier } : {}),
    ...(op.curation?.projection ? { projection: op.curation.projection } : {}),
    ...(notes.length > 0 ? { terminology_notes: notes } : {}),
    ...(readingNotes.length > 0 ? { reading_notes: readingNotes } : {}),
  };

  const budgeted = enforceBudget(structured);
  const value = budgeted.value as Record<string, unknown>;
  if (budgeted.truncated) {
    value.truncated = true;
    value.hint = NARROW_HINT;
  }

  return {
    found: true,
    text: renderText(op, parameters, notes, readingNotes),
    structuredContent: value,
  };
}

function renderText(
  op: CatalogOperation,
  parameters: DescribedParameter[],
  notes: string[],
  readingNotes: string[]
): string {
  const lines: string[] = [];

  lines.push(`${op.operationId} — ${op.method} ${op.displayPath}`);
  if (op.summary) lines.push(op.summary);
  lines.push(
    `Domain: ${op.domain}` +
      `${isPreview(op) ? ` · Source: ${op.source} (${op.status ?? 'preview'})` : ''}` +
      `${op.deprecated ? ' · DEPRECATED' : ''}`
  );
  lines.push(
    !op.security.required
      ? 'Auth: partner token only.'
      : servesPasswordLogin()
        ? 'Auth: logged-in session required (call `auth_login` first).'
        : 'Auth: signed-in user required (the app this connection runs in signs it in).'
  );

  const curatedTool = op.curation?.tool_name;
  // Where this view does not serve the curated tool, say where it is served
  // instead of telling the caller to use a tool it does not have.
  const elsewhere = curatedTool ? elsewhereClause(curatedTool) : undefined;
  if (op.method !== 'GET') {
    lines.push(
      `Not callable through \`api_call_operation\`: ${op.method} is a write. ` +
        (!curatedTool
          ? 'Writes are available through curated tools only.'
          : elsewhere === undefined
            ? `Use the curated tool \`${curatedTool}\`.`
            : `The curated tool \`${curatedTool}\` performs it, but this address does not serve it; ${elsewhere}.`)
    );
  } else if (!isLiveSource(op.source)) {
    lines.push(
      `Not callable yet: ${op.source} is a preview contract (${op.status ?? 'preview'}).`
    );
  }
  if (curatedTool && op.method === 'GET') {
    lines.push(
      elsewhere === undefined
        ? `A curated tool already covers this: \`${curatedTool}\` — prefer it.`
        : `The curated tool \`${curatedTool}\` covers this, but this address does not serve it (${elsewhere})` +
            (isLiveSource(op.source)
              ? '; here, use `api_call_operation`.'
              : '.')
    );
  }

  if (parameters.length > 0) {
    lines.push('', 'Parameters:');
    for (const p of parameters) {
      const flags = [p.in, p.required ? 'required' : 'optional', p.type]
        .filter(Boolean)
        .join(', ');
      const enums = p.enum ? ` One of: ${p.enum.map(String).join(', ')}.` : '';
      lines.push(
        `  - ${p.name} (${flags})${p.description ? ` — ${p.description}` : ''}${enums}`
      );
    }
  } else {
    lines.push('', 'Parameters: none documented.');
  }

  if (op.requestBody) {
    lines.push(
      '',
      `Request body (${op.requestBody.contentType ?? 'application/json'}` +
        `${op.requestBody.required ? ', required' : ', optional'}): see \`request_body.schema\` in the structured result.`
    );
  }
  if (op.response) {
    lines.push(
      '',
      `Response ${op.response.statusCode ?? '200'}` +
        `${op.response.envelope && ENVELOPE_SHAPES[op.response.envelope] ? ` (the \`${ENVELOPE_SHAPES[op.response.envelope]}\` wrapper is unwrapped for you)` : ''}` +
        ': see `response.schema` in the structured result.'
    );
  }
  if (notes.length > 0) {
    lines.push('', 'Canonical terminology:');
    for (const note of notes) lines.push(`  - ${note}`);
  }
  if (readingNotes.length > 0) {
    lines.push('', 'Reading the data:');
    for (const note of readingNotes) lines.push(`  - ${note}`);
  }

  return lines.join('\n');
}
