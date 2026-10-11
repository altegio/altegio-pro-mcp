/**
 * Executor results in the product glossary (ADR-001 D5, D8).
 *
 * `api_call_operation` reaches every documented read, so its output is where a
 * model learns what the product is whenever the curated tools fall short. The
 * raw payloads speak the backend dialect (`company_id`, `staff`, `seance_length`,
 * `confirmed` next to `attendance`), carry presentation noise (avatars,
 * notification flags, empty strings) and include client contacts that every
 * curated tool withholds by default. This module projects any payload into the
 * vocabulary the curated tools use, at the adapter boundary, so wire names never
 * reach the model:
 *
 * - **renames** legacy keys to glossary keys (`company_id` → `location_id`,
 *   `staff` → `team_member`, `seance_length` → `duration_seconds`);
 * - **drops** presentation noise, and empty strings anywhere;
 * - **derives** an appointment's canonical `status` from `attendance` — the
 *   same rule as the curated tools, so the `confirmed` flag cannot be misread
 *   as a confirmed visit;
 * - **flattens** JSON:API resources (`{type, id, attributes, relationships}`)
 *   into plain objects;
 * - **withholds** phone and email unless the caller opted in with
 *   `include_contacts` (`../contacts.ts`).
 *
 * The same renames apply to the response schema `api_describe_operation`
 * shows, so the contract and the result agree.
 */
import { visitStatusOfAppointment } from '../../capabilities/analytics/vocabulary.js';

/** Legacy payload key → glossary key. */
export const KEY_RENAMES: Readonly<Record<string, string>> = {
  company_id: 'location_id',
  salon_id: 'location_id',
  company: 'location',
  company_group_id: 'chain_id',
  salon_group_id: 'chain_id',
  staff_id: 'team_member_id',
  master_id: 'team_member_id',
  staff_ids: 'team_member_ids',
  staff: 'team_member',
  master: 'team_member',
  staff_service_link: 'team_member_service_link',
  company_service_link: 'location_service_link',
  record_id: 'appointment_id',
  record_ids: 'appointment_ids',
  seance_length: 'duration_seconds',
  activity_id: 'event_id',
  activity: 'event',
  good_id: 'product_id',
  good: 'product',
  goods: 'products',
  goods_transactions: 'product_transactions',
  record_labels: 'tags',
  abonement_id: 'membership_id',
  abonement: 'membership',
  abonements: 'memberships',
  certificate_id: 'gift_card_id',
  certificate: 'gift_card',
  certificates: 'gift_cards',
};

/** JSON:API resource `type` → glossary entity name, for side-loaded resources. */
const TYPE_RENAMES: Readonly<Record<string, string>> = {
  record: 'appointment',
  staff: 'team_member',
  master: 'team_member',
  company: 'location',
  good: 'product',
  label: 'tag',
  activity: 'event',
  abonement: 'membership',
  certificate: 'gift_card',
};

/** Presentation and notification plumbing no business question needs. */
const ALWAYS_DROP = new Set([
  'avatar',
  'avatar_big',
  'votes_count',
  'short_link',
  'sms_before',
  'sms_now',
  'sms_now_text',
  'email_now',
  'notified',
  'sms_remain_hours',
  'email_remain_hours',
  'is_remind_sms_sent',
  'is_client_notification_sent',
  'review_requested',
]);

/** Keys that carry nothing when empty (null, "", "0", 0, [] or {}). */
const DROP_WHEN_EMPTY = new Set([
  'api_id',
  'external_id',
  'comer',
  'comer_id',
  'comer_person_info',
  'client_fictive_name',
  'client_fictive_phone',
  'client_fictive_email',
  'custom_fields',
  'goods_transactions',
  'assistants',
  'rating',
]);

/** Personal contact fields, withheld unless the caller opted in. */
const CONTACT_KEYS = new Set([
  'phone',
  'phones',
  'email',
  'emails',
  'phone_country_id',
  'client_phone',
  'client_email',
  'client_fictive_phone',
  'client_fictive_email',
]);

/** The coded and flag fields an appointment's canonical `status` replaces. */
const APPOINTMENT_STATUS_KEYS = [
  'attendance',
  'visit_attendance',
  'attendance_status',
  'attendance_status_slug',
  'confirmed',
];
const APPOINTMENT_DURATION_KEYS = ['seance_length', 'length', 'duration'];

export interface GlossaryOptions {
  /** Keep phone and email (the caller passed `include_contacts: true`). */
  includeContacts?: boolean;
  /**
   * Keep contacts on the top-level records: a location's own phone and email
   * are business details, not a client's personal data.
   */
  keepRootContacts?: boolean;
  /** A JSON:API document's side-loads, inlined where the data links to them. */
  included?: IncludedIndex;
}

export interface GlossaryResult {
  value: unknown;
  /** A contact field was present and removed. */
  contactsWithheld: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === '' || value === 0) {
    return true;
  }
  if (value === '0') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function numericId(value: unknown): unknown {
  return typeof value === 'string' && /^\d{1,15}$/.test(value)
    ? Number(value)
    : value;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number(value);
  }
  return undefined;
}

/** `{type, id, attributes[, relationships, links, meta]}` — one JSON:API resource. */
function isJsonApiResource(value: Record<string, unknown>): boolean {
  if (typeof value.type !== 'string' || !('id' in value)) return false;
  if (!isRecord(value.attributes)) return false;
  return Object.keys(value).every((key) =>
    ['type', 'id', 'attributes', 'relationships', 'links', 'meta'].includes(key)
  );
}

/** Side-loaded resources by `type:id`, for inlining into the primary data. */
export type IncludedIndex = ReadonlyMap<string, Record<string, unknown>>;

/** Index a JSON:API document's `included` array. */
export function indexIncluded(included: unknown): IncludedIndex {
  const index = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(included)) return index;
  for (const resource of included) {
    if (isRecord(resource) && isJsonApiResource(resource)) {
      index.set(`${String(resource.type)}:${String(resource.id)}`, resource);
    }
  }
  return index;
}

/** A side-loaded resource as a plain nested object; its own links stay ids. */
function embedded(resource: Record<string, unknown>): Record<string, unknown> {
  const links = flattenRelationships(resource.relationships, new Map()).links;
  return {
    id: numericId(resource.id),
    ...(resource.attributes as Record<string, unknown>),
    ...(links ? { relationships: links } : {}),
  };
}

/**
 * Relationship linkage, resolved against the side-loads: a linked resource the
 * document included is embedded whole; one it did not stays a bare id.
 */
function flattenRelationships(
  relationships: unknown,
  included: IncludedIndex
): {
  embeds: Record<string, unknown>;
  links?: Record<string, unknown>;
} {
  const embeds: Record<string, unknown> = {};
  const links: Record<string, unknown> = {};
  if (!isRecord(relationships)) return { embeds };
  const lookup = (d: unknown) =>
    isRecord(d) ? included.get(`${String(d.type)}:${String(d.id)}`) : undefined;
  for (const [name, link] of Object.entries(relationships)) {
    const data = isRecord(link) ? link.data : undefined;
    if (Array.isArray(data)) {
      const found = data.map(lookup);
      if (data.length > 0 && found.every((r) => r !== undefined)) {
        embeds[name] = found.map((r) => embedded(r as Record<string, unknown>));
      } else {
        links[name] = data.map((d) => (isRecord(d) ? numericId(d.id) : d));
      }
    } else if (isRecord(data)) {
      const found = lookup(data);
      if (found) embeds[name] = embedded(found);
      else links[name] = numericId(data.id);
    }
  }
  return {
    embeds,
    ...(Object.keys(links).length > 0 ? { links } : {}),
  };
}

/**
 * One JSON:API resource as a plain object: id, then its attributes, then the
 * side-loaded resources it links to (as nested objects, the way V1 nests them),
 * then any linkage left unresolved. `keepType` keeps the (renamed) type, which
 * loose side-loads need to be told apart; the primary data's type is the
 * operation's own.
 */
function flattenResource(
  resource: Record<string, unknown>,
  keepType: boolean,
  included: IncludedIndex
): Record<string, unknown> {
  const type = String(resource.type);
  const attributes = resource.attributes as Record<string, unknown>;
  const { embeds, links } = flattenRelationships(
    resource.relationships,
    included
  );
  const out: Record<string, unknown> = {
    ...(keepType ? { type: TYPE_RENAMES[type] ?? type } : {}),
    id: numericId(resource.id),
    ...attributes,
  };
  const unplaced: Record<string, unknown> = { ...(links ?? {}) };
  for (const [name, value] of Object.entries(embeds)) {
    if (name in out) unplaced[name] = value;
    else out[name] = value;
  }
  if (Object.keys(unplaced).length > 0) out.relationships = unplaced;
  return out;
}

function isAppointmentShaped(value: Record<string, unknown>): boolean {
  return (
    ('attendance' in value ||
      'visit_attendance' in value ||
      'attendance_status_slug' in value) &&
    ('date' in value || 'datetime' in value)
  );
}

/**
 * The appointment fields the curated tools agree on: `status` from attendance
 * (never from `confirmed`), `duration_seconds`, `paid_in_full` as a boolean.
 * The coded fields it replaces are removed so they cannot be misread.
 */
function canonicalAppointment(
  value: Record<string, unknown>
): Record<string, unknown> {
  const status = visitStatusOfAppointment({
    deleted: value.deleted === true || value.deleted === 1,
    attendance: toNumber(value.attendance),
    visit_attendance: toNumber(value.visit_attendance),
    status:
      typeof value.attendance_status_slug === 'string'
        ? value.attendance_status_slug
        : undefined,
  });
  const duration = APPOINTMENT_DURATION_KEYS.map((key) =>
    toNumber(value[key])
  ).find((n) => n !== undefined);

  const out: Record<string, unknown> = {};
  let placed = false;
  for (const [key, entry] of Object.entries(value)) {
    if (APPOINTMENT_STATUS_KEYS.includes(key)) {
      if (!placed) {
        out.status = status;
        placed = true;
      }
      continue;
    }
    if (APPOINTMENT_DURATION_KEYS.includes(key)) {
      if (duration !== undefined && !('duration_seconds' in out)) {
        out.duration_seconds = duration;
      }
      if (toNumber(entry) !== undefined) continue;
    }
    if (key === 'paid_full') {
      out.paid_in_full = entry === true || toNumber(entry) === 1;
      continue;
    }
    out[key] = entry;
  }
  if (!placed) out.status = status;
  return out;
}

interface WalkState {
  options: GlossaryOptions;
  withheld: boolean;
}

interface WalkContext {
  /** A top-level record (or the primary data of a JSON:API document). */
  root: boolean;
  /** Inside a JSON:API document's `included` side-loads. */
  sideLoad: boolean;
}

const NESTED: WalkContext = { root: false, sideLoad: false };

function walk(value: unknown, state: WalkState, ctx: WalkContext): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, state, ctx));
  }
  if (!isRecord(value)) return value;

  let source = value;
  const resource = isJsonApiResource(source);
  if (resource) {
    source = flattenResource(
      source,
      ctx.sideLoad,
      state.options.included ?? new Map()
    );
  }
  if (isAppointmentShaped(source)) source = canonicalAppointment(source);

  const keepContacts =
    state.options.includeContacts === true ||
    (ctx.root && state.options.keepRootContacts === true);
  // A document that kept its side-loads: its `data` is still the primary data.
  const document = ctx.root && !resource && 'data' in source;

  // A key already spelled canonically wins over a legacy key renamed onto it.
  const literal = new Set(
    Object.keys(source).filter((key) => KEY_RENAMES[key] === undefined)
  );
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (ALWAYS_DROP.has(key)) continue;
    if (entry === '') continue;
    if (DROP_WHEN_EMPTY.has(key) && isEmpty(entry)) continue;
    if (CONTACT_KEYS.has(key) && !keepContacts) {
      if (!isEmpty(entry)) state.withheld = true;
      continue;
    }

    const childCtx: WalkContext =
      document && key === 'data'
        ? { root: true, sideLoad: false }
        : document && key === 'included'
          ? { root: false, sideLoad: true }
          : NESTED;
    const projected = walk(entry, state, childCtx);
    const target = KEY_RENAMES[key];
    if (target === undefined) {
      out[key] = projected;
      continue;
    }
    if (target in out || literal.has(target)) {
      const existing = target in out ? out[target] : source[target];
      // Twins carrying the same value (`staff_id` and `master_id`) collapse;
      // a different value keeps its own spelling rather than being lost.
      if (sameValue(existing, projected) || sameValue(existing, entry)) {
        continue;
      }
      out[key] = projected;
      continue;
    }
    out[target] = projected;
  }
  return out;
}

/** Project one payload into the product glossary. */
export function projectToGlossary(
  payload: unknown,
  options: GlossaryOptions = {}
): GlossaryResult {
  const state: WalkState = { options, withheld: false };
  const value = walk(payload, state, { root: true, sideLoad: false });
  return { value, contactsWithheld: state.withheld };
}

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const STATUS_SCHEMA = {
  type: 'string',
  enum: ['waiting', 'confirmed', 'arrived', 'no_show', 'cancelled', 'unknown'],
  description:
    'Canonical visit status, derived from the coded attendance field (deleted → cancelled).',
};

const CONTACT_NOTE = ' Withheld unless `include_contacts` is true.';

function projectProperties(
  properties: Record<string, unknown>
): Record<string, unknown> {
  let source = properties;
  const attributes = properties.attributes;
  if (
    'type' in properties &&
    'id' in properties &&
    isRecord(attributes) &&
    isRecord(attributes.properties)
  ) {
    source = {
      id: properties.id,
      ...attributes.properties,
      ...(properties.relationships
        ? { relationships: properties.relationships }
        : {}),
    };
  }

  const appointment =
    ('attendance' in source || 'visit_attendance' in source) &&
    ('date' in source || 'datetime' in source);

  const literal = new Set(
    Object.keys(source).filter((key) => KEY_RENAMES[key] === undefined)
  );
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (ALWAYS_DROP.has(key)) continue;
    if (appointment && APPOINTMENT_STATUS_KEYS.includes(key)) {
      out.status ??= STATUS_SCHEMA;
      continue;
    }
    if (appointment && APPOINTMENT_DURATION_KEYS.includes(key)) {
      out.duration_seconds ??= {
        type: 'integer',
        description: 'Duration in seconds',
      };
      continue;
    }
    if (appointment && key === 'paid_full') {
      out.paid_in_full = {
        type: 'boolean',
        description: 'Whether it is fully paid',
      };
      continue;
    }
    let projected = projectSchema(entry);
    if (CONTACT_KEYS.has(key) && isRecord(projected)) {
      const description =
        typeof projected.description === 'string' ? projected.description : '';
      projected = {
        ...projected,
        description: `${description}${CONTACT_NOTE}`.trim(),
      };
    }
    const target = KEY_RENAMES[key];
    if (target === undefined) {
      out[key] = projected;
      continue;
    }
    // One field per glossary name: the canonical spelling, else the primary
    // legacy one (`staff_id` over its deprecated twin `master_id`).
    if (literal.has(target) || chosenSource(source, target) !== key) continue;
    out[target] = projected;
  }
  return out;
}

/** Legacy keys that are the primary spelling when several rename onto one name. */
const PRIMARY_SOURCE: Readonly<Record<string, string>> = {
  team_member_id: 'staff_id',
  team_member: 'staff',
  location_id: 'company_id',
};

function chosenSource(
  source: Record<string, unknown>,
  target: string
): string | undefined {
  const primary = PRIMARY_SOURCE[target];
  if (primary && primary in source) return primary;
  return Object.keys(source).find((key) => KEY_RENAMES[key] === target);
}

/**
 * The response schema in the glossary the result will use. Applies the same
 * renames, drops and appointment rules as `projectToGlossary`, to `properties`
 * maps at every depth.
 */
export function projectSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(projectSchema);
  if (!isRecord(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(schema)) {
    if (key === 'properties' && isRecord(entry)) {
      out.properties = projectProperties(entry);
    } else if (key === 'required' && Array.isArray(entry)) {
      continue;
    } else if (
      key === 'items' ||
      key === 'anyOf' ||
      key === 'oneOf' ||
      key === 'allOf' ||
      key === 'additionalProperties'
    ) {
      out[key] = projectSchema(entry);
    } else {
      out[key] = entry;
    }
  }
  return out;
}
