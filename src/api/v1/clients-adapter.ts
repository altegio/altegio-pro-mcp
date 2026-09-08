/**
 * V1 adapter for the `ClientsApi` port.
 *
 * Implements the canonical port against the v1 client endpoints, translating the
 * legacy fields (`spent`, `balance`, `visits`, `gender_id`, `importance_id`,
 * `categories`, `card`, `attendance`, `fullname`) into canonical DTOs. The
 * legacy filter dialect is built in `../../capabilities/clients/filters.ts`; the
 * legacy enum codes are mapped through `../../capabilities/clients/vocabulary.ts`.
 */
import type { AltegioHttp } from '../altegio-http.js';
import { callClients, callEnveloped } from './clients-http.js';
import { buildFilterPayload } from '../../capabilities/clients/filters.js';
import {
  GENDER_FROM_CODE,
  IMPORTANCE_FROM_CODE,
  OUTCOME_FROM_ATTENDANCE_CODE,
  OUTCOME_TO_ATTENDANCE_CODE,
  PAYMENT_STATUS_FROM_WIRE,
  PAYMENT_STATUS_TO_WIRE,
  SORT_FIELD_TO_WIRE,
} from '../../capabilities/clients/vocabulary.js';
import type {
  ClientCard,
  ClientLookupQuery,
  ClientLookupRow,
  ClientSegment,
  ClientSegmentRow,
  ClientsApi,
  ClientSearchQuery,
  Gender,
  Importance,
  VisitHistory,
  VisitHistoryItem,
  VisitHistoryQuery,
  VisitPaymentStatus,
} from '../clients-api.js';

// ========== small coercions ==========

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

/** Read a v1 boolean flag stored as 0/1 (or a real boolean). */
function asFlag(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const n = asNumber(value);
  return n === null ? null : n !== 0;
}

function genderFromCode(value: unknown): Gender | null {
  const n = asNumber(value);
  return n === null ? null : (GENDER_FROM_CODE[n] ?? null);
}

function importanceFromCode(value: unknown): Importance | null {
  const n = asNumber(value);
  return n === null ? null : (IMPORTANCE_FROM_CODE[n] ?? null);
}

export class V1ClientsAdapter implements ClientsApi {
  constructor(private readonly http: AltegioHttp) {}

  async searchClients(query: ClientSearchQuery): Promise<ClientSegment> {
    const payload = buildFilterPayload(query.filters, query.match);
    const body: Record<string, unknown> = {
      page: query.page,
      page_size: query.page_size,
      operation: payload.operation,
      filters: payload.filters,
    };
    if (query.order_by) {
      body.order_by = SORT_FIELD_TO_WIRE[query.order_by];
      body.order_by_direction =
        (query.order_direction ?? 'desc').toUpperCase() === 'ASC'
          ? 'ASC'
          : 'DESC';
    }
    if (query.fields?.length) body.fields = query.fields;

    const { data, meta } = await callEnveloped<unknown>(
      this.http,
      `/company/${query.location_id}/clients/search`,
      { method: 'POST', body, context: 'search the client base' }
    );

    const rows: ClientSegmentRow[] = Array.isArray(data)
      ? data
          .filter(
            (row): row is Record<string, unknown> =>
              !!row && typeof row === 'object'
          )
          .map((row) => {
            const id = asNumber(row.id);
            const name = asString(row.name) ?? '';
            return { ...row, id: id ?? 0, name } as ClientSegmentRow;
          })
      : [];

    const totalCount = asNumber(meta.total_count) ?? rows.length;
    return {
      total_count: totalCount,
      page: query.page,
      page_size: query.page_size,
      rows,
    };
  }

  async getClientCard(query: {
    location_id: number;
    client_id: number;
  }): Promise<ClientCard> {
    const { data } = await callEnveloped<Record<string, unknown>>(
      this.http,
      `/client/${query.location_id}/${query.client_id}`,
      { context: 'read the client card' }
    );
    const card = data ?? {};

    const tagsRaw = Array.isArray(card.categories) ? card.categories : [];
    const tags = tagsRaw
      .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
      .map((t) => ({
        id: asNumber(t.id),
        title: asString(t.title),
        color: asString(t.color),
      }));

    const customFields =
      card.custom_fields &&
      typeof card.custom_fields === 'object' &&
      !Array.isArray(card.custom_fields)
        ? (card.custom_fields as Record<string, unknown>)
        : {};

    return {
      id: asNumber(card.id) ?? query.client_id,
      name: asString(card.name),
      surname: asString(card.surname),
      patronymic: asString(card.middle_name),
      phone: asString(card.phone),
      email: asString(card.email),
      gender: genderFromCode(card.gender_id),
      importance: importanceFromCode(card.importance_id),
      discount: asNumber(card.discount),
      loyalty_card_number: asString(card.card),
      birth_date: asString(card.birth_date),
      comment: asString(card.comment),
      total_spent: asNumber(card.spent),
      client_account_balance: asNumber(card.balance),
      visit_count: asNumber(card.visits),
      sms_birthday_greeting: asFlag(card.sms_check),
      sms_excluded_from_campaigns: asFlag(card.sms_not),
      tags,
      custom_fields: customFields,
      last_changed_at: asString(card.last_change_date),
    };
  }

  async getVisitHistory(query: VisitHistoryQuery): Promise<VisitHistory> {
    // Every field of this request is required-but-nullable; send them all.
    const body = {
      client_id: query.client_id ?? null,
      client_phone: query.client_phone ?? null,
      from: query.date_from ?? null,
      to: query.date_to ?? null,
      payment_statuses: (query.payment_statuses ?? []).map(
        (status) => PAYMENT_STATUS_TO_WIRE[status]
      ),
      attendance:
        query.outcome !== undefined
          ? OUTCOME_TO_ATTENDANCE_CODE[query.outcome]
          : null,
    };

    const { data, meta } = await callEnveloped<Record<string, unknown>>(
      this.http,
      `/company/${query.location_id}/clients/visits/search`,
      { method: 'POST', body, context: 'read the client visit history' }
    );

    const records = Array.isArray(data?.records) ? data.records : [];
    const goods = Array.isArray(data?.goods_transactions)
      ? data.goods_transactions
      : [];

    const items: VisitHistoryItem[] = [];
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      items.push(visitFromRecord(record as Record<string, unknown>));
    }
    for (const sale of goods) {
      if (!sale || typeof sale !== 'object') continue;
      items.push(visitFromGoods(sale as Record<string, unknown>));
    }

    const cursor =
      meta.dateCursor && typeof meta.dateCursor === 'object'
        ? (meta.dateCursor as Record<string, unknown>)
        : {};
    const next =
      cursor.next && typeof cursor.next === 'object'
        ? (cursor.next as Record<string, unknown>)
        : {};
    const nextFrom = asString(next.from);
    const nextTo = asString(next.to);

    return {
      items,
      next_from: nextFrom,
      next_to: nextTo,
      has_more: Boolean(nextFrom || nextTo),
    };
  }

  async lookupClients(query: ClientLookupQuery): Promise<ClientLookupRow[]> {
    const limit = Math.max(1, Math.min(query.limit ?? 7, 25));
    const params = new URLSearchParams({
      name: query.query,
      limit: String(limit),
    });
    const payload = await callClients(
      this.http,
      `/company/${query.location_id}/clients/autocomplete?${params.toString()}`,
      { context: 'look up a client' }
    );

    // The autocomplete endpoint answers with a raw array (no envelope).
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { data?: unknown })?.data)
        ? (payload as { data: unknown[] }).data
        : [];

    return rows
      .filter(
        (row): row is Record<string, unknown> =>
          !!row && typeof row === 'object'
      )
      .map((row) => ({
        id: asNumber(row.id) ?? 0,
        name: asString(row.fullname) ?? asString(row.name),
        phone: asString(row.phone),
      }))
      .filter((row) => row.id !== 0);
  }
}

// ========== visit-history line helpers ==========

interface LineItem {
  title: string | null;
  cost: number | null;
}

/** Read the service / product lines of a visit and their money and status. */
function readLines(
  raw: unknown,
  costKey: string
): { lines: LineItem[]; cost: number; paid: number; statuses: string[] } {
  const lines: LineItem[] = [];
  let cost = 0;
  let paid = 0;
  const statuses: string[] = [];
  if (Array.isArray(raw)) {
    for (const line of raw) {
      if (!line || typeof line !== 'object') continue;
      const l = line as Record<string, unknown>;
      const lineCost = asNumber(l[costKey]) ?? asNumber(l.cost_to_pay);
      const paidSum = asNumber(l.paid_sum);
      lines.push({ title: asString(l.title), cost: lineCost });
      if (lineCost !== null) cost += lineCost;
      if (paidSum !== null) paid += paidSum;
      const status = asString(l.payment_status);
      if (status) statuses.push(status);
    }
  }
  return { lines, cost, paid, statuses };
}

/** One payment status for the whole visit, when every line agrees. */
function uniformPaymentStatus(statuses: string[]): VisitPaymentStatus | null {
  if (statuses.length === 0) return null;
  const first = statuses[0]!;
  return statuses.every((s) => s === first)
    ? (PAYMENT_STATUS_FROM_WIRE[first] ?? null)
    : null;
}

function teamMemberName(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  return asString((raw as Record<string, unknown>).name);
}

function visitFromRecord(record: Record<string, unknown>): VisitHistoryItem {
  const { lines, cost, paid, statuses } = readLines(
    record.services,
    'cost_to_pay'
  );
  const attendance = asNumber(record.attendance);
  return {
    visit_id: asNumber(record.visit_id) ?? asNumber(record.id),
    date: asString(record.date),
    outcome:
      attendance === null
        ? null
        : (OUTCOME_FROM_ATTENDANCE_CODE[attendance] ?? 'other'),
    payment_status: uniformPaymentStatus(statuses),
    team_member_name: teamMemberName(record.staff),
    services: lines,
    products: [],
    total_cost: lines.length ? cost : null,
    total_paid: statuses.length ? paid : null,
  };
}

function visitFromGoods(sale: Record<string, unknown>): VisitHistoryItem {
  const { lines, cost, paid, statuses } = readLines(sale.goods, 'cost_to_pay');
  return {
    visit_id: asNumber(sale.visit_id) ?? asNumber(sale.id),
    date: asString(sale.date),
    outcome: null,
    payment_status: uniformPaymentStatus(statuses),
    team_member_name: teamMemberName(sale.staff),
    services: [],
    products: lines,
    total_cost: lines.length ? cost : null,
    total_paid: statuses.length ? paid : null,
  };
}
