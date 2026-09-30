/**
 * V1 adapter for the `MembershipsApi` port.
 *
 * V2 has no membership operation (checked against the backend routes,
 * 2026-09-30), so every call runs on V1: the chain's membership types under
 * `/chains/{id}/loyalty/abonement_types`, its sold memberships under
 * `/chains/{id}/loyalty/abonements`, and one client's memberships through the
 * location-level phone lookup `/loyalty/abonements`. The model never learns
 * the wire vocabulary: `abonement`, `salon_group`, `cost`, `is_united_balance`,
 * `is_allow_empty_code`, `expiration_type_id`, `balance_container` and
 * `service_price_correction` stop here.
 *
 * Contract details verified against the backend (biz.erp, 2026-09-30):
 *
 * - `PUT` on a type replaces it: every field missing from the body falls back
 *   to its default. An update therefore reads the type first and sends every
 *   field back (`toWireFields`), including the raw time-of-week rules and the
 *   type's `category`, which this port does not model.
 * - Once a membership of the type is sold, the API silently keeps the price,
 *   validity, activation, sharing, balance model and covered services on
 *   `PUT`. The use case compares what came back instead of trusting the call.
 * - Covered services travel either as `services` / `service_categories` maps
 *   or as `service_links`, depending on a per-chain feature the API does not
 *   expose, and the other form is ignored without an error. The maps are the
 *   documented form, so they go first; `service_links` is sent when a service
 *   is unlimited or when the maps did not take (`createType`, `updateType`).
 * - `PATCH` (archive) checks neither the user's rights nor the type's chain on
 *   the backend. The adapter reads the type through the checked `GET` first,
 *   so the archive switch never reaches a type the user may not see.
 * - The set-balance call answers with no body; the membership is read back.
 * - Deleting a type is a soft delete: it leaves the list, but the read by id
 *   still answers with it.
 */
import { httpFromClient, type AltegioHttp } from '../altegio-http.js';
import type { AltegioClient } from '../../providers/altegio-client.js';
import {
  MembershipsNotFoundError,
  mapMembershipsHttpError,
  type MembershipsErrorHints,
} from '../../capabilities/memberships/errors.js';
import type {
  AllowanceInput,
  BalanceChange,
  BalanceEditPolicy,
  ChainAccess,
  Duration,
  Membership,
  MembershipActivation,
  MembershipAllowance,
  MembershipListQuery,
  MembershipStatus,
  MembershipType,
  MembershipTypeFields,
  MembershipTypePage,
  MembershipsApi,
  PeriodUnit,
} from '../memberships-api.js';

// ========== wire vocabulary ==========

const UNIT_FROM_WIRE: Record<number, PeriodUnit> = {
  1: 'day',
  2: 'week',
  3: 'month',
  4: 'year',
};
const UNIT_TO_WIRE: Record<PeriodUnit, number> = {
  day: 1,
  week: 2,
  month: 3,
  year: 4,
};

const ACTIVATION_FROM_WIRE: Record<number, MembershipActivation> = {
  1: 'first_visit',
  2: 'sale',
};
const ACTIVATION_TO_WIRE: Record<MembershipActivation, number> = {
  first_visit: 1,
  sale: 2,
};

const BALANCE_EDIT_FROM_WIRE: Record<number, BalanceEditPolicy> = {
  0: 'not_allowed',
  1: 'sale_location',
  2: 'any_location',
};
const BALANCE_EDIT_TO_WIRE: Record<BalanceEditPolicy, number> = {
  not_allowed: 0,
  sale_location: 1,
  any_location: 2,
};

const STATUS_FROM_WIRE: Record<string, MembershipStatus> = {
  created: 'issued',
  active: 'active',
  expired: 'expired',
  wasted: 'used_up',
};
const STATUS_ID_FROM_WIRE: Record<number, MembershipStatus> = {
  1: 'issued',
  2: 'active',
  3: 'expired',
  4: 'used_up',
};

// ========== value helpers ==========

type Row = Record<string, unknown>;

function asRow(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Row)
    : {};
}

function rows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter(
        (v): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
      )
    : [];
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function int(value: unknown): number | null {
  const n = num(value);
  return n !== null && Number.isInteger(n) ? n : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function flag(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function flagOrNull(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  return flag(value);
}

function ids(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .map((v) => int(v))
    .filter((v): v is number => v !== null && v > 0);
}

function duration(length: unknown, unitId: unknown): Duration | null {
  const n = int(length);
  const unit = UNIT_FROM_WIRE[int(unitId) ?? 0];
  return n !== null && n > 0 && unit ? { length: n, unit } : null;
}

// ========== wire → port ==========

/** The services and service categories inside a `balance_container`. */
function allowances(
  container: unknown,
  shared: boolean
): MembershipAllowance[] {
  return rows(asRow(container).links).map((link) => {
    const node = asRow(link.service ?? link.category);
    const isCategory =
      node.is_category === true ||
      (link.service === undefined && !!link.category);
    const unlimited = flag(link.is_unlimited);
    const id = int(node.id);
    return {
      service_id: isCategory ? null : id,
      service_category_id: isCategory ? id : null,
      title: text(node.title),
      visits: shared || unlimited ? null : int(link.count),
      unlimited,
    };
  });
}

function typeFromWire(t: Row): MembershipType {
  const shared = flag(t.is_united_balance);
  const sharedUnlimited = flag(t.is_united_balance_unlimited);
  const archivedAt = text(t.date_archived);
  return {
    id: int(t.id) ?? 0,
    chain_id: int(t.salon_group_id ?? t.chain_id),
    title: text(t.title),
    price: num(t.cost),
    archived: flag(t.is_archived) || archivedAt !== null,
    archived_at: archivedAt,
    validity: duration(t.period, t.period_unit_id),
    activation: ACTIVATION_FROM_WIRE[int(t.expiration_type_id) ?? 0] ?? null,
    auto_activation_after: duration(
      t.autoactivation_time ?? t.autoactivation_period,
      t.autoactivation_time_unit_id
    ),
    personal: flagOrNull(t.is_allow_empty_code),
    balance_type: shared ? 'shared' : 'per_service',
    shared_visits:
      shared && !sharedUnlimited ? int(t.united_balance_services_count) : null,
    shared_unlimited: shared && sharedUnlimited,
    services: allowances(t.balance_container, shared),
    freeze_allowed: flag(t.allow_freeze),
    freeze_limit: duration(t.freeze_limit, t.freeze_limit_unit_id),
    online_booking_while_frozen: flag(t.is_booking_when_frozen_allowed),
    recalculate_service_price: flag(t.service_price_correction),
    balance_edit:
      BALANCE_EDIT_FROM_WIRE[int(t.balance_edit_type_id) ?? -1] ?? null,
    time_restricted: rows(t.availability).length > 0,
    online_sale_enabled: flag(t.is_online_sale_enabled),
    online_sale_title: text(t.online_sale_title),
    online_sale_price: num(t.online_sale_price),
    online_sale_description: text(t.online_sale_description),
    location_ids: ids(t.attached_salon_ids ?? t.attached_location_ids),
    sold_count: int(t.abonements_count),
    type_category_id: int(t.category_id),
  };
}

function membershipFromWire(m: Row): Membership {
  const shared = flag(m.is_united_balance);
  const sharedUnlimited = flag(m.is_united_balance_unlimited);
  const status = asRow(m.status);
  const type = asRow(m.type);
  return {
    id: int(m.id) ?? 0,
    number: text(m.number),
    chain_id: int(type.salon_group_id ?? type.chain_id),
    type_id: int(type.id),
    type_title: text(type.title),
    status:
      STATUS_FROM_WIRE[String(status.slug ?? '')] ??
      STATUS_ID_FROM_WIRE[int(status.id) ?? 0] ??
      'unknown',
    created_at: text(m.created_date),
    activated_at: text(m.activated_date),
    expires_at: text(m.expiration_date),
    frozen: flag(m.is_frozen),
    frozen_days: int(m.freeze_period),
    validity: duration(m.period, m.period_unit_id),
    balance_type: shared ? 'shared' : 'per_service',
    shared_visits_left:
      shared && !sharedUnlimited ? int(m.united_balance_services_count) : null,
    shared_unlimited: shared && sharedUnlimited,
    services: allowances(m.balance_container, shared),
    sale_transaction_id: int(m.goods_transaction_id),
  };
}

function chainFromWire(c: Row): ChainAccess {
  const access = asRow(c.access);
  const right = (key: string) => flagOrNull(access[key]);
  const locations = rows(c.companies ?? c.locations);
  return {
    id: int(c.id) ?? 0,
    title: text(c.title),
    location_ids: locations
      .map((l) => int(l.id))
      .filter((v): v is number => v !== null),
    location_titles: locations
      .map((l) => text(l.title))
      .filter((v): v is string => v !== null),
    rights: {
      loyalty: right('loyalty_access'),
      manage_membership_types: right('loyalty_abonement_types_access'),
      change_memberships: right('loyalty_abonement_period_edit_access'),
      edit_membership_balance: right('loyalty_abonement_balance_edit_access'),
      read_membership_history: right('loyalty_abonement_history_access'),
    },
  };
}

// ========== port → wire ==========

/** Services as the documented maps: `{ "<id>": visits }`. */
function allowanceMaps(fields: MembershipTypeFields): Row {
  const services: Record<string, number> = {};
  const categories: Record<string, number> = {};
  const shared = fields.balance_type === 'shared';
  for (const a of fields.services) {
    const visits = shared ? 0 : (a.visits ?? 0);
    if (a.service_id !== undefined) services[String(a.service_id)] = visits;
    if (a.service_category_id !== undefined)
      categories[String(a.service_category_id)] = visits;
  }
  return { services, service_categories: categories };
}

/** Services as `service_links`, the form that can say "unlimited". */
function allowanceLinks(fields: MembershipTypeFields): Row {
  const shared = fields.balance_type === 'shared';
  return {
    service_links: fields.services.map((a: AllowanceInput) => ({
      service_id: a.service_id ?? null,
      service_category_id: a.service_category_id ?? null,
      is_unlimited: !shared && a.unlimited === true,
      count: shared || a.unlimited ? 0 : (a.visits ?? 0),
    })),
  };
}

export type AllowanceForm = 'maps' | 'links';

function wireDuration(
  value: Duration | null,
  lengthKey: string,
  unitKey: string
): Row {
  return {
    [lengthKey]: value?.length ?? 0,
    [unitKey]: UNIT_TO_WIRE[value?.unit ?? 'day'],
  };
}

/**
 * The full request body for a type. `passthrough` carries the fields of the
 * current type this port does not model, so a replacement keeps them.
 */
export function toWireFields(
  chainId: number,
  fields: MembershipTypeFields,
  form: AllowanceForm,
  passthrough: Row = {}
): Row {
  const shared = fields.balance_type === 'shared';
  return {
    ...passthrough,
    chain_id: chainId,
    title: fields.title,
    cost: fields.price,
    location_ids: fields.location_ids,
    ...wireDuration(fields.validity, 'period', 'period_unit_id'),
    expiration_type_id: ACTIVATION_TO_WIRE[fields.activation],
    ...wireDuration(
      fields.auto_activation_after,
      'autoactivation_period',
      'autoactivation_time_unit_id'
    ),
    is_allow_empty_code: fields.personal,
    is_united_balance: shared,
    is_united_balance_unlimited: shared && fields.shared_unlimited,
    united_balance_services_count:
      shared && !fields.shared_unlimited ? (fields.shared_visits ?? 0) : 0,
    ...(form === 'links' ? allowanceLinks(fields) : allowanceMaps(fields)),
    allow_freeze: fields.freeze_allowed,
    ...wireDuration(
      fields.freeze_limit,
      'freeze_limit',
      'freeze_limit_unit_id'
    ),
    is_booking_when_frozen_allowed: fields.online_booking_while_frozen,
    service_price_correction: fields.recalculate_service_price,
    balance_edit_type_id: BALANCE_EDIT_TO_WIRE[fields.balance_edit],
    is_online_sale_enabled: fields.online_sale_enabled,
    online_sale_title: fields.online_sale_title,
    online_sale_price: fields.online_sale_price,
    online_sale_description: fields.online_sale_description,
    category_id: fields.type_category_id,
  };
}

/** The form a request should start with: links only when one is unlimited. */
function preferredForm(fields: MembershipTypeFields): AllowanceForm {
  return fields.balance_type === 'per_service' &&
    fields.services.some((a) => a.unlimited === true)
    ? 'links'
    : 'maps';
}

/** Whether the type now covers exactly the requested services. */
export function allowancesTook(
  requested: readonly AllowanceInput[],
  actual: readonly MembershipAllowance[]
): boolean {
  const key = (
    serviceId: number | null | undefined,
    categoryId: number | null | undefined
  ) => (serviceId ? `s${serviceId}` : `c${categoryId}`);
  const want = new Set(
    requested.map((a) => key(a.service_id, a.service_category_id))
  );
  const got = new Set(
    actual.map((a) => key(a.service_id, a.service_category_id))
  );
  return want.size === got.size && [...want].every((k) => got.has(k));
}

// ========== the adapter ==========

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type QueryValue = string | number | boolean | readonly number[] | undefined;

function queryString(query: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value) search.append(`${key}[]`, String(v));
    } else {
      search.append(key, String(value));
    }
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export class MembershipsAdapter implements MembershipsApi {
  constructor(private readonly http: AltegioHttp) {}

  static forClient(client: AltegioClient): MembershipsAdapter {
    return new MembershipsAdapter(httpFromClient(client));
  }

  private async call(
    path: string,
    context: string,
    options: {
      method?: Method;
      query?: Record<string, QueryValue>;
      body?: unknown;
      hints?: MembershipsErrorHints;
    } = {}
  ): Promise<{ data: unknown; meta: Row }> {
    if (!this.http.isAuthenticated()) {
      throw mapMembershipsHttpError(401, undefined, context);
    }
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const response = await this.http.request(
      `${path}${options.query ? queryString(options.query) : ''}`,
      {
        method: options.method ?? 'GET',
        headers,
        ...(body !== undefined ? { body } : {}),
      }
    );
    const payload = await safeJson(response);
    if (!response.ok) {
      throw mapMembershipsHttpError(
        response.status,
        payload,
        context,
        options.hints
      );
    }
    const envelope = asRow(payload);
    if (envelope.success === false) {
      throw mapMembershipsHttpError(422, payload, context, options.hints);
    }
    return { data: envelope.data ?? null, meta: asRow(envelope.meta) };
  }

  private typesPath(chainId: number, typeId?: number): string {
    return `/chains/${chainId}/loyalty/abonement_types${typeId === undefined ? '' : `/${typeId}`}`;
  }

  async listChains(): Promise<ChainAccess[]> {
    const { data } = await this.call('/chains', 'list the chains');
    return rows(data).map(chainFromWire);
  }

  async listTypes(
    chainId: number,
    query: {
      title?: string;
      archived?: boolean;
      page: number;
      page_size: number;
    }
  ): Promise<MembershipTypePage> {
    const { data, meta } = await this.call(
      this.typesPath(chainId),
      `list the membership types of chain ${chainId}`,
      {
        query: {
          title: query.title,
          is_archived: query.archived ? 1 : 0,
          page: query.page,
          limit: query.page_size,
        },
      }
    );
    return {
      items: rows(data).map(typeFromWire),
      total: int(meta.total_count),
    };
  }

  /** The type as the API stores it, before mapping. */
  private async readType(chainId: number, typeId: number): Promise<Row> {
    const { data } = await this.call(
      this.typesPath(chainId, typeId),
      `read membership type ${typeId} of chain ${chainId}`,
      {
        hints: {
          notFound:
            'Check the membership type id with memberships_list_types; a deleted type cannot be read.',
        },
      }
    );
    const row = asRow(data);
    if (int(row.id) === null) {
      throw new MembershipsNotFoundError(
        `Membership type ${typeId} was not found in chain ${chainId}. Check the id with memberships_list_types.`
      );
    }
    return row;
  }

  async getType(chainId: number, typeId: number): Promise<MembershipType> {
    return typeFromWire(await this.readType(chainId, typeId));
  }

  private async writeType(
    chainId: number,
    typeId: number | undefined,
    fields: MembershipTypeFields,
    passthrough: Row
  ): Promise<MembershipType> {
    const verb =
      typeId === undefined
        ? 'create a membership type'
        : `update membership type ${typeId}`;
    const context = `${verb} in chain ${chainId}`;
    const send = async (form: AllowanceForm, id: number | undefined) => {
      const { data } = await this.call(
        id === undefined
          ? this.typesPath(chainId)
          : this.typesPath(chainId, id),
        context,
        {
          method: id === undefined ? 'POST' : 'PUT',
          body: toWireFields(chainId, fields, form, passthrough),
          hints: {
            invalid:
              'Check the services (they must belong to the chain), the price, the validity and the balance settings.',
          },
        }
      );
      return typeFromWire(asRow(data));
    };

    const first = preferredForm(fields);
    let saved = await send(first, typeId);
    // The chain accepts only one of the two service forms and ignores the
    // other; switch once when the services did not take.
    if (
      fields.services.length > 0 &&
      saved.id > 0 &&
      !allowancesTook(fields.services, saved.services)
    ) {
      saved = await send(first === 'maps' ? 'links' : 'maps', saved.id);
    }
    return saved;
  }

  async createType(
    chainId: number,
    fields: MembershipTypeFields
  ): Promise<MembershipType> {
    return this.writeType(chainId, undefined, fields, {});
  }

  async updateType(
    chainId: number,
    typeId: number,
    fields: MembershipTypeFields
  ): Promise<MembershipType> {
    const current = await this.readType(chainId, typeId);
    // Fields the port does not model, kept as the API stores them.
    const passthrough: Row = {};
    if (Array.isArray(current.availability)) {
      passthrough.availability = rows(current.availability).map((c) => ({
        week_days: Array.isArray(c.week_days) ? c.week_days : [],
        intervals: rows(c.intervals).map((i) => ({ from: i.from, to: i.to })),
      }));
    }
    if (typeof current.category === 'string') {
      passthrough.category = current.category;
    }
    return this.writeType(chainId, typeId, fields, passthrough);
  }

  async setTypeArchived(
    chainId: number,
    typeId: number,
    archived: boolean
  ): Promise<void> {
    // Read the type first so the switch only reaches a type the user can read.
    await this.readType(chainId, typeId);
    await this.call(
      this.typesPath(chainId, typeId),
      `${archived ? 'archive' : 'unarchive'} membership type ${typeId} in chain ${chainId}`,
      // The flag is validated as the strings "0" / "1"; 1, true and false
      // are refused with 422.
      { method: 'PATCH', body: { is_archived: archived ? '1' : '0' } }
    );
  }

  async deleteType(chainId: number, typeId: number): Promise<void> {
    await this.call(
      this.typesPath(chainId, typeId),
      `delete membership type ${typeId} in chain ${chainId}`,
      {
        method: 'DELETE',
        hints: {
          invalid:
            'A type with sold memberships cannot be deleted; archive it with memberships_archive_type instead.',
        },
      }
    );
  }

  async listMemberships(
    chainId: number,
    query: MembershipListQuery
  ): Promise<Membership[]> {
    const { data } = await this.call(
      `/chains/${chainId}/loyalty/abonements`,
      `list the memberships of chain ${chainId}`,
      {
        query: {
          ...(query.ids?.length
            ? { abonements_ids: query.ids }
            : {
                created_after: query.created_from,
                created_before: query.created_to,
              }),
          page: query.page,
          count: query.page_size,
        },
      }
    );
    return rows(data).map(membershipFromWire);
  }

  async listClientMemberships(
    locationId: number,
    clientId: number,
    chainId?: number
  ): Promise<Membership[]> {
    const card = await this.call(
      `/client/${locationId}/${clientId}`,
      `read client ${clientId} in location ${locationId}`,
      {
        hints: {
          forbidden:
            'Ask a location owner for access to the client base and loyalty, or call locations_list to pick a location the user can work with.',
          notFound:
            'Check the location id with locations_list and the client id with clients_lookup.',
        },
      }
    );
    const phone = text(asRow(card.data).phone);
    if (!phone) return [];
    const { data } = await this.call(
      '/loyalty/abonements',
      `list the memberships of client ${clientId} in location ${locationId}`,
      {
        query: { location_id: locationId, phone, chain_id: chainId },
        hints: {
          forbidden:
            'Ask a location owner for access to loyalty in this location, or call locations_list to pick another location.',
        },
      }
    );
    return rows(data).map(membershipFromWire);
  }

  async getMembership(
    chainId: number,
    membershipId: number
  ): Promise<Membership> {
    const [found] = await this.listMemberships(chainId, {
      ids: [membershipId],
      page: 1,
      page_size: 1,
    });
    if (!found) {
      throw new MembershipsNotFoundError(
        `Membership ${membershipId} was not found in chain ${chainId}. Find the membership and its chain with memberships_list_for_client or memberships_list.`
      );
    }
    return found;
  }

  private async membershipAction(
    chainId: number,
    membershipId: number,
    action: 'freeze' | 'unfreeze' | 'set_period' | 'set_balance',
    context: string,
    body: unknown,
    invalid: string
  ): Promise<unknown> {
    const { data } = await this.call(
      `/chains/${chainId}/loyalty/abonements/${membershipId}/${action}`,
      `${context} in chain ${chainId}`,
      {
        method: 'POST',
        body,
        hints: {
          invalid,
          notFound:
            'Find the membership and its chain with memberships_list_for_client or memberships_list.',
        },
      }
    );
    return data;
  }

  async freeze(
    chainId: number,
    membershipId: number,
    until?: string
  ): Promise<Membership> {
    const data = await this.membershipAction(
      chainId,
      membershipId,
      'freeze',
      `freeze membership ${membershipId}`,
      until ? { freeze_till: until } : {},
      'The membership type may not allow freezing, the membership may already be frozen, or the date may be past or beyond the freeze limit left.'
    );
    const row = asRow(data);
    return int(row.id) !== null
      ? membershipFromWire(row)
      : this.getMembership(chainId, membershipId);
  }

  async unfreeze(chainId: number, membershipId: number): Promise<Membership> {
    const data = await this.membershipAction(
      chainId,
      membershipId,
      'unfreeze',
      `unfreeze membership ${membershipId}`,
      {},
      'The membership may not be frozen.'
    );
    const row = asRow(data);
    return int(row.id) !== null
      ? membershipFromWire(row)
      : this.getMembership(chainId, membershipId);
  }

  async setBalance(
    chainId: number,
    membershipId: number,
    change: BalanceChange
  ): Promise<void> {
    await this.membershipAction(
      chainId,
      membershipId,
      'set_balance',
      `change the balance of membership ${membershipId}`,
      {
        ...(change.shared_visits !== undefined
          ? { united_balance_services_count: change.shared_visits }
          : {}),
        ...(change.services
          ? {
              services_balance_count: change.services.map((s) => ({
                service_id: s.id,
                balance: s.visits,
              })),
            }
          : {}),
      },
      'An unlimited balance cannot be changed, and a balance cannot be negative.'
    );
  }

  async setValidity(
    chainId: number,
    membershipId: number,
    validity: Duration
  ): Promise<Membership> {
    const data = await this.membershipAction(
      chainId,
      membershipId,
      'set_period',
      `change the validity of membership ${membershipId}`,
      { period: validity.length, period_unit_id: UNIT_TO_WIRE[validity.unit] },
      'The new expiration date cannot fall before the membership was last used.'
    );
    const row = asRow(data);
    return int(row.id) !== null
      ? membershipFromWire(row)
      : this.getMembership(chainId, membershipId);
  }
}
