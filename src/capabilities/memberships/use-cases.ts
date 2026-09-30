/**
 * Memberships use cases — everything the `memberships_*` tools actually do.
 *
 * A use case takes the tool's parsed input plus an `AltegioClient`, calls the
 * `MembershipsApi` port and returns the text summary next to the structured
 * content.
 *
 * Free text — membership type titles, online-sale texts, service titles,
 * membership numbers, chain and location names — is other people's text. It
 * never goes into our own summary lines; it is keyed back to them by id inside
 * the untrusted block (`withUntrustedBlock`).
 */
import type { AltegioClient } from '../../providers/altegio-client.js';
import { MembershipsAdapter } from '../../api/v1/memberships-adapter.js';
import type {
  AllowanceInput,
  BalanceEditPolicy,
  ChainAccess,
  Duration,
  Membership,
  MembershipActivation,
  MembershipAllowance,
  MembershipBalanceType,
  MembershipType,
  MembershipTypeFields,
  MembershipsApi,
} from '../../api/memberships-api.js';
import { MembershipsInputError } from './errors.js';
import {
  completeCollection,
  pageMetadata,
  paginateCollection,
  type PageInput,
} from '../../tools/pagination.js';
import {
  withUntrustedBlock,
  type UntrustedField,
} from '../../tools/tool-result.js';

export interface MembershipsResult {
  text: string;
  structuredContent: unknown;
  isError?: boolean;
}

function api(client: AltegioClient): MembershipsApi {
  return MembershipsAdapter.forClient(client);
}

const FIELD_MAX_CHARS = 200;

// ========== rendering ==========

function durationText(value: Duration | null, none: string): string {
  if (!value) return none;
  return `${value.length} ${value.unit}${value.length === 1 ? '' : 's'}`;
}

function allowanceText(a: MembershipAllowance): string {
  const what =
    a.service_id !== null
      ? `service ${a.service_id}`
      : `service category ${a.service_category_id}`;
  if (a.unlimited) return `${what} unlimited`;
  return a.visits === null ? what : `${what} ×${a.visits}`;
}

function balanceText(
  balance: MembershipBalanceType,
  sharedVisits: number | null,
  sharedUnlimited: boolean,
  services: readonly MembershipAllowance[],
  sharedLabel: string
): string {
  const covered = services.map(allowanceText).join(', ') || 'no services';
  if (balance === 'shared') {
    const pool = sharedUnlimited
      ? 'unlimited visits'
      : `${sharedVisits ?? '?'} ${sharedLabel}`;
    return `shared balance of ${pool} for ${covered}`;
  }
  return `per-service balance: ${covered}`;
}

function typeLine(t: MembershipType): string {
  return (
    `- Membership type ${t.id} (chain ${t.chain_id ?? '?'}): price ${t.price ?? 'not reported'}` +
    ` · ${balanceText(t.balance_type, t.shared_visits, t.shared_unlimited, t.services, 'visits')}` +
    ` · valid ${durationText(t.validity, 'with no expiration')}` +
    (t.activation
      ? ` from the ${t.activation === 'sale' ? 'sale' : 'first visit'}`
      : '') +
    (t.freeze_allowed
      ? ` · freezing allowed (limit ${durationText(t.freeze_limit, 'none')})`
      : '') +
    (t.sold_count !== null ? ` · ${t.sold_count} sold` : '') +
    (t.archived ? ' · archived' : '')
  );
}

function typeUntrusted(t: MembershipType): UntrustedField[] {
  const key = `membership type ${t.id}`;
  return [
    { label: `${key} title`, value: t.title },
    { label: `${key} online sale title`, value: t.online_sale_title },
    {
      label: `${key} online sale description`,
      value: t.online_sale_description,
    },
    ...t.services.map((a) => ({
      label: `${key} ${a.service_id !== null ? `service ${a.service_id}` : `service category ${a.service_category_id}`}`,
      value: a.title,
    })),
  ];
}

function membershipLine(m: Membership): string {
  return (
    `- Membership ${m.id} (chain ${m.chain_id ?? '?'}, type ${m.type_id ?? '?'}): ${m.status.replace('_', ' ')}` +
    (m.frozen ? ' · frozen' : '') +
    ` · ${balanceText(m.balance_type, m.shared_visits_left, m.shared_unlimited, m.services, 'visits left')}` +
    ` · expires ${m.expires_at ?? (m.status === 'issued' ? 'once activated' : 'not set')}`
  );
}

function membershipUntrusted(m: Membership): UntrustedField[] {
  const key = `membership ${m.id}`;
  return [
    { label: `${key} number`, value: m.number },
    { label: `${key} type title`, value: m.type_title },
    ...m.services.map((a) => ({
      label: `${key} ${a.service_id !== null ? `service ${a.service_id}` : `service category ${a.service_category_id}`}`,
      value: a.title,
    })),
  ];
}

function rightText(value: boolean | null): string {
  return value === null ? 'not reported' : value ? 'yes' : 'no';
}

function chainLine(c: ChainAccess): string {
  return (
    `- Chain ${c.id}: locations ${c.location_ids.join(', ') || 'none reported'}` +
    ` · loyalty ${rightText(c.rights.loyalty)}` +
    ` · manage membership types ${rightText(c.rights.manage_membership_types)}` +
    ` · change memberships ${rightText(c.rights.change_memberships)}` +
    ` · edit balances ${rightText(c.rights.edit_membership_balance)}`
  );
}

// ========== input checks ==========

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string, field: string): string {
  const text = value.trim();
  if (!DATE.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new MembershipsInputError(
      `${field} must be a date as YYYY-MM-DD (got "${text.slice(0, 40)}").`
    );
  }
  return text;
}

function checkAllowances(
  services: readonly AllowanceInput[],
  balance: MembershipBalanceType
): void {
  if (services.length === 0) {
    throw new MembershipsInputError(
      'A membership type must cover at least one service or service category: pass services.'
    );
  }
  for (const [index, a] of services.entries()) {
    const at = `services[${index}]`;
    const hasService = a.service_id !== undefined;
    const hasCategory = a.service_category_id !== undefined;
    if (hasService === hasCategory) {
      throw new MembershipsInputError(
        `${at} needs exactly one of service_id or service_category_id.`
      );
    }
    if (balance === 'shared') {
      if (a.visits !== undefined || a.unlimited !== undefined) {
        throw new MembershipsInputError(
          `${at}: visits and unlimited apply to a per_service balance only; under a shared balance set shared_visits (or shared_unlimited) instead.`
        );
      }
    } else if (a.unlimited !== true && (a.visits ?? 0) < 1) {
      throw new MembershipsInputError(
        `${at} needs visits (at least 1) or unlimited: true under a per_service balance.`
      );
    } else if (a.unlimited === true && a.visits !== undefined) {
      throw new MembershipsInputError(
        `${at}: give either visits or unlimited: true, not both.`
      );
    }
  }
}

function checkFields(fields: MembershipTypeFields): void {
  if (!fields.title.trim()) {
    throw new MembershipsInputError('title must not be blank.');
  }
  checkAllowances(fields.services, fields.balance_type);
  if (fields.balance_type === 'shared') {
    if (fields.shared_unlimited && fields.shared_visits !== null) {
      throw new MembershipsInputError(
        'Give either shared_visits or shared_unlimited: true, not both.'
      );
    }
    if (!fields.shared_unlimited && (fields.shared_visits ?? 0) < 1) {
      throw new MembershipsInputError(
        'A shared balance needs shared_visits (at least 1) or shared_unlimited: true.'
      );
    }
  }
  const unlimited =
    (fields.balance_type === 'shared' && fields.shared_unlimited) ||
    (fields.balance_type === 'per_service' &&
      fields.services.some((a) => a.unlimited === true));
  if (unlimited && !fields.validity) {
    throw new MembershipsInputError(
      'An unlimited membership needs a validity: pass validity, e.g. { length: 1, unit: "month" }.'
    );
  }
  if (unlimited && fields.recalculate_service_price) {
    throw new MembershipsInputError(
      'recalculate_service_price cannot be on for an unlimited membership.'
    );
  }
  if (fields.freeze_allowed && !fields.validity) {
    throw new MembershipsInputError(
      'Freezing needs a validity to pause: pass validity, or leave freeze_allowed off.'
    );
  }
  if (fields.online_sale_enabled && fields.online_sale_price <= 0) {
    throw new MembershipsInputError(
      'Online sale needs online_sale_price above 0.'
    );
  }
}

// ========== memberships_list_chains ==========

export async function listChains(
  client: AltegioClient
): Promise<MembershipsResult> {
  const chains = await api(client).listChains();
  const lines = [
    `${chains.length} chain${chains.length === 1 ? '' : 's'} the signed-in user belongs to, with the membership rights in each:`,
    ...chains.map(chainLine),
  ];
  if (chains.length === 0) {
    lines.push(
      'The user belongs to no chain, so membership types and sold memberships cannot be managed. A location owner can add the user to the chain.'
    );
  }
  return {
    text: withUntrustedBlock(
      lines.join('\n'),
      chains.flatMap((c) => [
        { label: `chain ${c.id} title`, value: c.title },
        {
          label: `chain ${c.id} location names`,
          value: c.location_titles.join(', '),
        },
      ]),
      { maxChars: FIELD_MAX_CHARS }
    ),
    structuredContent: completeCollection(chains),
  };
}

// ========== membership types: reads ==========

export async function listTypes(
  client: AltegioClient,
  input: {
    chain_id: number;
    query?: string;
    archived?: boolean;
  } & PageInput
): Promise<MembershipsResult> {
  const page = await api(client).listTypes(input.chain_id, {
    ...(input.query ? { title: input.query } : {}),
    ...(input.archived ? { archived: true } : {}),
    page: input.page,
    page_size: input.page_size,
  });
  const pagination = pageMetadata(
    input,
    page.items.length,
    page.total ?? undefined
  );
  const lines = [
    `${page.total ?? page.items.length} ${input.archived ? 'archived' : 'active'} membership type(s) in chain ${input.chain_id}; page ${input.page} shows ${page.items.length}:`,
    ...page.items.map(typeLine),
  ];
  if (page.items.length === 0) lines.push('No membership types match.');
  if (pagination.has_more)
    lines.push(`More follow: request page ${pagination.next_page}.`);
  return {
    text: withUntrustedBlock(
      lines.join('\n'),
      page.items.flatMap(typeUntrusted),
      { maxChars: FIELD_MAX_CHARS }
    ),
    structuredContent: {
      chain_id: input.chain_id,
      archived: input.archived === true,
      items: page.items,
      pagination,
    },
  };
}

function savedType(
  verb: string,
  t: MembershipType,
  notes: string[] = [],
  isError = false
): MembershipsResult {
  return {
    text: withUntrustedBlock(
      [`${verb} ${typeLine(t).replace(/^- /, '')}`, ...notes].join('\n'),
      typeUntrusted(t),
      { maxChars: FIELD_MAX_CHARS }
    ),
    structuredContent: t,
    ...(isError ? { isError: true } : {}),
  };
}

export async function getType(
  client: AltegioClient,
  input: { chain_id: number; type_id: number }
): Promise<MembershipsResult> {
  const t = await api(client).getType(input.chain_id, input.type_id);
  return savedType('Read', t, [
    `Sold at locations: ${t.location_ids === null ? 'not reported' : t.location_ids.join(', ') || 'none'}.`,
  ]);
}

// ========== membership types: writes ==========

export interface TypeFieldsInput {
  title?: string;
  price?: number;
  location_ids?: number[];
  services?: AllowanceInput[];
  balance_type?: MembershipBalanceType;
  shared_visits?: number | null;
  shared_unlimited?: boolean;
  validity?: Duration | null;
  activation?: MembershipActivation;
  auto_activation_after?: Duration | null;
  personal?: boolean;
  freeze_allowed?: boolean;
  freeze_limit?: Duration | null;
  online_booking_while_frozen?: boolean;
  recalculate_service_price?: boolean;
  balance_edit?: BalanceEditPolicy;
  online_sale_enabled?: boolean;
  online_sale_title?: string;
  online_sale_price?: number;
  online_sale_description?: string;
  type_category_id?: number | null;
}

const FIELD_KEYS: readonly (keyof TypeFieldsInput)[] = [
  'title',
  'price',
  'location_ids',
  'services',
  'balance_type',
  'shared_visits',
  'shared_unlimited',
  'validity',
  'activation',
  'auto_activation_after',
  'personal',
  'freeze_allowed',
  'freeze_limit',
  'online_booking_while_frozen',
  'recalculate_service_price',
  'balance_edit',
  'online_sale_enabled',
  'online_sale_title',
  'online_sale_price',
  'online_sale_description',
  'type_category_id',
];

/** Only the keys the caller actually passed. */
function passedFields(input: TypeFieldsInput): TypeFieldsInput {
  const out: Record<string, unknown> = {};
  for (const key of FIELD_KEYS) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out as TypeFieldsInput;
}

/** The current type as a full write request. */
function fieldsFromType(t: MembershipType): MembershipTypeFields {
  return {
    title: t.title ?? '',
    price: t.price ?? 0,
    location_ids: t.location_ids ?? [],
    services: t.services.map((a) => ({
      ...(a.service_id !== null ? { service_id: a.service_id } : {}),
      ...(a.service_category_id !== null
        ? { service_category_id: a.service_category_id }
        : {}),
      ...(t.balance_type === 'per_service'
        ? a.unlimited
          ? { unlimited: true }
          : { visits: a.visits ?? 0 }
        : {}),
    })),
    balance_type: t.balance_type,
    shared_visits: t.shared_visits,
    shared_unlimited: t.shared_unlimited,
    validity: t.validity,
    activation: t.activation ?? 'first_visit',
    auto_activation_after: t.auto_activation_after,
    personal: t.personal ?? false,
    freeze_allowed: t.freeze_allowed,
    freeze_limit: t.freeze_limit,
    online_booking_while_frozen: t.online_booking_while_frozen,
    recalculate_service_price: t.recalculate_service_price,
    balance_edit: t.balance_edit ?? 'not_allowed',
    online_sale_enabled: t.online_sale_enabled,
    online_sale_title: t.online_sale_title ?? '',
    online_sale_price: t.online_sale_price ?? 0,
    online_sale_description: t.online_sale_description ?? '',
    type_category_id: t.type_category_id,
  };
}

const DEFAULT_FIELDS: Omit<
  MembershipTypeFields,
  'title' | 'price' | 'location_ids' | 'services'
> = {
  balance_type: 'per_service',
  shared_visits: null,
  shared_unlimited: false,
  validity: null,
  activation: 'first_visit',
  auto_activation_after: null,
  personal: false,
  freeze_allowed: false,
  freeze_limit: null,
  online_booking_while_frozen: false,
  recalculate_service_price: false,
  balance_edit: 'not_allowed',
  online_sale_enabled: false,
  online_sale_title: '',
  online_sale_price: 0,
  online_sale_description: '',
  type_category_id: null,
};

function sameDuration(a: Duration | null, b: Duration | null): boolean {
  return a?.length === b?.length && a?.unit === b?.unit;
}

function coveredKey(a: {
  service_id?: number | null;
  service_category_id?: number | null;
}): string {
  return a.service_id ? `s${a.service_id}` : `c${a.service_category_id}`;
}

function sameServices(
  requested: readonly AllowanceInput[],
  balance: MembershipBalanceType,
  actual: readonly MembershipAllowance[]
): boolean {
  if (requested.length !== actual.length) return false;
  const byKey = new Map(actual.map((a) => [coveredKey(a), a]));
  return requested.every((r) => {
    const a = byKey.get(coveredKey(r));
    if (!a) return false;
    if (balance === 'shared') return true;
    return r.unlimited === true ? a.unlimited : a.visits === (r.visits ?? 0);
  });
}

/** The requested fields the saved type does not carry. */
function fieldsNotApplied(
  wanted: MembershipTypeFields,
  changed: TypeFieldsInput,
  saved: MembershipType
): string[] {
  const missed: string[] = [];
  const check = (key: keyof TypeFieldsInput, ok: boolean) => {
    if (changed[key] !== undefined && !ok) missed.push(key);
  };
  check('price', saved.price === wanted.price);
  check('validity', sameDuration(saved.validity, wanted.validity));
  check('activation', saved.activation === wanted.activation);
  check('personal', saved.personal === wanted.personal);
  check('balance_type', saved.balance_type === wanted.balance_type);
  check(
    'shared_visits',
    wanted.balance_type !== 'shared' ||
      wanted.shared_unlimited ||
      saved.shared_visits === wanted.shared_visits
  );
  check('shared_unlimited', saved.shared_unlimited === wanted.shared_unlimited);
  check(
    'services',
    sameServices(wanted.services, wanted.balance_type, saved.services)
  );
  check('title', saved.title === wanted.title.trim());
  return missed;
}

export async function createType(
  client: AltegioClient,
  input: TypeFieldsInput & {
    chain_id: number;
    title: string;
    price: number;
    location_ids: number[];
    services: AllowanceInput[];
  }
): Promise<MembershipsResult> {
  const fields: MembershipTypeFields = {
    ...DEFAULT_FIELDS,
    ...passedFields(input),
    title: input.title.trim(),
    price: input.price,
    location_ids: input.location_ids,
    services: input.services,
  } as MembershipTypeFields;
  checkFields(fields);
  const saved = await api(client).createType(input.chain_id, fields);
  const missed = fieldsNotApplied(fields, passedFields(input), saved);
  if (missed.length > 0) {
    return savedType(
      'Created, but not as requested:',
      saved,
      [
        `The API did not store ${missed.join(', ')}. Check the ids of the services and categories (they must belong to the chain), then fix the type with memberships_update_type or delete it with memberships_delete_type.`,
      ],
      true
    );
  }
  return savedType('Created', saved, [
    'Memberships of this type can now be sold at its locations. Price, validity, activation, sharing, balance and covered services are fixed once the first membership is sold.',
  ]);
}

export async function updateType(
  client: AltegioClient,
  input: TypeFieldsInput & { chain_id: number; type_id: number }
): Promise<MembershipsResult> {
  const changes = passedFields(input);
  if (Object.keys(changes).length === 0) {
    throw new MembershipsInputError(
      'Nothing to update: pass at least one field of the membership type to change.'
    );
  }
  const port = api(client);
  const current = await port.getType(input.chain_id, input.type_id);
  if (current.archived) {
    throw new MembershipsInputError(
      `Membership type ${input.type_id} is archived, and an archived type cannot be changed. Unarchive it with memberships_archive_type (archived: false) first.`
    );
  }
  const fields: MembershipTypeFields = {
    ...fieldsFromType(current),
    ...changes,
  } as MembershipTypeFields;
  if (changes.title !== undefined) fields.title = changes.title.trim();
  // Switching the balance model invalidates the other model's numbers.
  if (changes.balance_type === 'shared' && current.balance_type !== 'shared') {
    if (changes.services === undefined) {
      fields.services = fields.services.map((a) => ({
        ...(a.service_id !== undefined ? { service_id: a.service_id } : {}),
        ...(a.service_category_id !== undefined
          ? { service_category_id: a.service_category_id }
          : {}),
      }));
    }
  }
  if (fields.balance_type !== 'shared') {
    fields.shared_visits = null;
    fields.shared_unlimited = false;
  }
  checkFields(fields);
  const saved = await port.updateType(input.chain_id, input.type_id, fields);
  const missed = fieldsNotApplied(fields, changes, saved);
  if (missed.length > 0) {
    return savedType(
      'Updated only in part:',
      saved,
      [
        `The API kept the current ${missed.join(', ')}. Once memberships of a type are sold, its price, validity, activation, sharing, balance and covered services are fixed (a shared balance can only gain services). For new terms, create a new type with memberships_create_type and archive this one with memberships_archive_type.`,
      ],
      true
    );
  }
  return savedType('Updated', saved);
}

export async function archiveType(
  client: AltegioClient,
  input: { chain_id: number; type_id: number; archived: boolean }
): Promise<MembershipsResult> {
  const port = api(client);
  await port.setTypeArchived(input.chain_id, input.type_id, input.archived);
  const t = await port.getType(input.chain_id, input.type_id);
  const note = input.archived
    ? 'It is no longer sold; memberships already sold keep working.'
    : 'It can be sold again at its locations.';
  if (t.archived !== input.archived) {
    return savedType(
      'Not changed:',
      t,
      [
        `The API answered without error, but the type is still ${t.archived ? 'archived' : 'not archived'}. Retry, or change it in the Altegio app.`,
      ],
      true
    );
  }
  return savedType(input.archived ? 'Archived' : 'Unarchived', t, [note]);
}

export async function deleteType(
  client: AltegioClient,
  input: { chain_id: number; type_id: number }
): Promise<MembershipsResult> {
  await api(client).deleteType(input.chain_id, input.type_id);
  return {
    text: `Deleted membership type ${input.type_id} in chain ${input.chain_id}. It is no longer sold anywhere in the chain and no longer appears in memberships_list_types; a read by id may still return it.`,
    structuredContent: {
      chain_id: input.chain_id,
      type_id: input.type_id,
      deleted: true,
    },
  };
}

/** A short, resolved description of a type for confirmation prompts. */
export async function describeType(
  client: AltegioClient,
  input: { chain_id: number; type_id: number }
): Promise<string> {
  const t = await api(client).getType(input.chain_id, input.type_id);
  return [
    `membership type ${t.id}`,
    t.title ? `"${t.title}"` : null,
    t.price !== null ? `priced ${t.price}` : null,
    `in chain ${input.chain_id}`,
  ]
    .filter(Boolean)
    .join(' ');
}

// ========== sold memberships: reads ==========

function membershipsResult(
  header: string,
  items: readonly Membership[],
  extra: Record<string, unknown>,
  footer: string[] = []
): MembershipsResult {
  const lines = [header, ...items.map(membershipLine)];
  if (items.length === 0) lines.push('No memberships match.');
  lines.push(...footer);
  return {
    text: withUntrustedBlock(
      lines.join('\n'),
      items.flatMap(membershipUntrusted),
      { maxChars: FIELD_MAX_CHARS }
    ),
    structuredContent: { ...extra, items },
  };
}

export async function listMemberships(
  client: AltegioClient,
  input: {
    chain_id: number;
    membership_ids?: number[];
    created_from?: string;
    created_to?: string;
  } & PageInput
): Promise<MembershipsResult> {
  const byIds = (input.membership_ids?.length ?? 0) > 0;
  const hasPeriod =
    input.created_from !== undefined || input.created_to !== undefined;
  if (byIds === hasPeriod) {
    throw new MembershipsInputError(
      'Pass either membership_ids or both created_from and created_to, not both and not neither.'
    );
  }
  let from: string | undefined;
  let to: string | undefined;
  if (hasPeriod) {
    if (input.created_from === undefined || input.created_to === undefined) {
      throw new MembershipsInputError(
        'A creation period needs both created_from and created_to (YYYY-MM-DD).'
      );
    }
    from = assertDate(input.created_from, 'created_from');
    to = assertDate(input.created_to, 'created_to');
    if (to < from) {
      throw new MembershipsInputError(
        'created_to must not be before created_from.'
      );
    }
  }
  const items = await api(client).listMemberships(input.chain_id, {
    ...(byIds
      ? { ids: input.membership_ids }
      : { created_from: from, created_to: to }),
    page: input.page,
    page_size: input.page_size,
  });
  const pagination = pageMetadata(input, items.length);
  return membershipsResult(
    byIds
      ? `${items.length} of ${input.membership_ids!.length} requested membership(s) found in chain ${input.chain_id}:`
      : `${items.length} membership(s) created in chain ${input.chain_id} from ${from} to ${to}, page ${input.page}:`,
    items,
    {
      chain_id: input.chain_id,
      ...(byIds ? {} : { period: { from, to } }),
      pagination,
    },
    pagination.has_more
      ? [`More may follow: request page ${pagination.next_page}.`]
      : []
  );
}

export async function listClientMemberships(
  client: AltegioClient,
  input: {
    location_id: number;
    client_id: number;
    chain_id?: number;
  } & PageInput
): Promise<MembershipsResult> {
  const all = await api(client).listClientMemberships(
    input.location_id,
    input.client_id,
    input.chain_id
  );
  const { items, pagination } = paginateCollection(all, input);
  return membershipsResult(
    `${pagination.total} current membership(s) of client ${input.client_id}, looked up in location ${input.location_id}${input.chain_id ? ` for chain ${input.chain_id}` : ''}; page ${input.page} shows ${items.length}:`,
    items,
    {
      location_id: input.location_id,
      client_id: input.client_id,
      ...(input.chain_id ? { chain_id: input.chain_id } : {}),
      pagination,
    },
    [
      ...(pagination.has_more
        ? [`More follow: request page ${pagination.next_page}.`]
        : []),
      'Memberships are found by the phone on the client card; expired and used-up ones are not listed, and one sold under an earlier phone is missed. Change a membership with the tools that take its chain_id.',
    ]
  );
}

/** A short, resolved description of a membership for confirmation prompts. */
export async function describeMembership(
  client: AltegioClient,
  input: { chain_id: number; membership_id: number }
): Promise<string> {
  const m = await api(client).getMembership(
    input.chain_id,
    input.membership_id
  );
  return [
    `membership ${m.id}`,
    m.number ? `number ${m.number}` : null,
    m.type_title ? `of type "${m.type_title}"` : null,
    `(${m.status.replace('_', ' ')}${m.frozen ? ', frozen' : ''}; ${balanceText(m.balance_type, m.shared_visits_left, m.shared_unlimited, m.services, 'visits left')}; expires ${m.expires_at ?? 'not set'})`,
    `in chain ${input.chain_id}`,
  ]
    .filter(Boolean)
    .join(' ');
}

// ========== sold memberships: writes ==========

function savedMembership(
  verb: string,
  m: Membership,
  notes: string[] = [],
  isError = false
): MembershipsResult {
  return {
    text: withUntrustedBlock(
      [`${verb} ${membershipLine(m).replace(/^- /, '')}`, ...notes].join('\n'),
      membershipUntrusted(m),
      { maxChars: FIELD_MAX_CHARS }
    ),
    structuredContent: m,
    ...(isError ? { isError: true } : {}),
  };
}

export async function freezeMembership(
  client: AltegioClient,
  input: { chain_id: number; membership_id: number; until?: string }
): Promise<MembershipsResult> {
  const until =
    input.until !== undefined ? assertDate(input.until, 'until') : undefined;
  const m = await api(client).freeze(
    input.chain_id,
    input.membership_id,
    until
  );
  return savedMembership('Froze', m, [
    until
      ? `It unfreezes by itself on ${until}; its expiration date moves out by the days it stays frozen.`
      : 'It stays frozen until memberships_unfreeze; its expiration date moves out by the days it stays frozen.',
  ]);
}

export async function unfreezeMembership(
  client: AltegioClient,
  input: { chain_id: number; membership_id: number }
): Promise<MembershipsResult> {
  const m = await api(client).unfreeze(input.chain_id, input.membership_id);
  return savedMembership('Unfroze', m);
}

export async function setBalance(
  client: AltegioClient,
  input: {
    chain_id: number;
    membership_id: number;
    shared_visits?: number;
    services?: {
      service_id?: number;
      service_category_id?: number;
      visits: number;
    }[];
  }
): Promise<MembershipsResult> {
  const port = api(client);
  const current = await port.getMembership(input.chain_id, input.membership_id);
  if (current.balance_type === 'shared') {
    if (input.shared_visits === undefined || input.services !== undefined) {
      throw new MembershipsInputError(
        `Membership ${input.membership_id} has a shared balance: pass shared_visits only.`
      );
    }
    if (current.shared_unlimited) {
      throw new MembershipsInputError(
        `Membership ${input.membership_id} has unlimited visits; there is no balance to change.`
      );
    }
    await port.setBalance(input.chain_id, input.membership_id, {
      shared_visits: input.shared_visits,
    });
  } else {
    if (!input.services?.length || input.shared_visits !== undefined) {
      throw new MembershipsInputError(
        `Membership ${input.membership_id} has a per-service balance: pass services, each with service_id or service_category_id and visits.`
      );
    }
    const covered = new Map(current.services.map((a) => [coveredKey(a), a]));
    const changes = input.services.map((s, index) => {
      if (
        (s.service_id === undefined) ===
        (s.service_category_id === undefined)
      ) {
        throw new MembershipsInputError(
          `services[${index}] needs exactly one of service_id or service_category_id.`
        );
      }
      const a = covered.get(coveredKey(s));
      if (!a) {
        throw new MembershipsInputError(
          `services[${index}] is not covered by membership ${input.membership_id}; its covered services are: ${current.services.map(allowanceText).join(', ') || 'none'}.`
        );
      }
      if (a.unlimited) {
        throw new MembershipsInputError(
          `services[${index}] is unlimited on this membership; its balance cannot be changed.`
        );
      }
      return {
        id: (s.service_id ?? s.service_category_id)!,
        visits: s.visits,
      };
    });
    await port.setBalance(input.chain_id, input.membership_id, {
      services: changes,
    });
  }
  const after = await port.getMembership(input.chain_id, input.membership_id);
  return savedMembership(
    'Changed the balance of',
    after,
    after.status === 'used_up'
      ? ['With no visits left, the membership is now used up.']
      : []
  );
}

export async function setValidity(
  client: AltegioClient,
  input: { chain_id: number; membership_id: number; validity: Duration }
): Promise<MembershipsResult> {
  const m = await api(client).setValidity(
    input.chain_id,
    input.membership_id,
    input.validity
  );
  return savedMembership(
    'Changed the validity of',
    m,
    m.status === 'issued'
      ? [
          'It is not activated yet, so the expiration date is counted from its activation.',
        ]
      : m.status === 'expired'
        ? ['With the new validity the membership has already expired.']
        : []
  );
}
