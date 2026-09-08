/**
 * Operation description — backs `altegio_describe_operation`.
 *
 * Renders one catalog entry into the contract a caller needs before invoking
 * `altegio_call_operation`: parameters with types and requiredness, request and
 * response shapes, authentication, deprecation, spec source, the curated tool
 * that may already do the job, and the canonical-terminology notes that say
 * which legacy parameter names the API accepts under canonical spellings.
 */
import {
  acceptedNames,
  canonicalName,
  getOperation,
  type CatalogOperation,
  type CatalogParameter,
} from './catalog.js';
import { enforceBudget, NARROW_HINT } from './budget.js';
import { searchOperations } from './search.js';
import { readingNotesFor } from './reading-notes.js';

export interface DescribedParameter {
  /** Canonical name to send. */
  name: string;
  /** Spec spelling, when the spec still uses a legacy name. */
  spec_name?: string;
  /** Every spelling `altegio_call_operation` accepts for this parameter. */
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
      'Use `altegio_search_operations` to find the operation you need.',
    structuredContent: {
      operation_id: operationId,
      found: false,
      suggestions: hits.map((h) => h.operationId),
    },
  };
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
    source: op.source,
    ...(op.status ? { status: op.status } : {}),
    domain: op.domain,
    ...(op.summary ? { summary: op.summary } : {}),
    ...(op.description ? { description: op.description } : {}),
    deprecated: op.deprecated,
    authentication: {
      required: op.security.required,
      schemes: op.security.schemes,
      note: op.security.required
        ? 'Requires a logged-in session — call `altegio_login` first.'
        : 'Partner token only; no user session needed.',
    },
    parameters,
    ...(op.requestBody ? { request_body: op.requestBody } : {}),
    ...(op.response ? { response: op.response } : {}),
    callable_by_executor: op.method === 'GET' && op.source === 'v1',
    ...(curatedTool ? { curated_tool: curatedTool } : {}),
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
    `Domain: ${op.domain} · Source: ${op.source}${op.status ? ` (${op.status})` : ''}` +
      `${op.deprecated ? ' · DEPRECATED' : ''}`
  );
  lines.push(
    op.security.required
      ? 'Auth: logged-in session required (call `altegio_login` first).'
      : 'Auth: partner token only.'
  );

  if (op.method !== 'GET') {
    lines.push(
      `Not callable through \`altegio_call_operation\`: ${op.method} is a write. ` +
        (op.curation?.tool_name
          ? `Use the curated tool \`${op.curation.tool_name}\`.`
          : 'Writes are available through curated tools only.')
    );
  } else if (op.source !== 'v1') {
    lines.push(
      `Not callable yet: ${op.source} is a preview contract (${op.status ?? 'preview'}).`
    );
  }
  if (op.curation?.tool_name && op.method === 'GET') {
    lines.push(
      `A curated tool already covers this: \`${op.curation.tool_name}\` — prefer it.`
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
        `${op.response.envelope === 'v1' ? ' (the `{success, data, meta}` envelope is unwrapped for you)' : ''}` +
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
