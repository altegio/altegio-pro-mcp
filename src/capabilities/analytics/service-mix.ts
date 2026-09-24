/** Service analytics from complete, bounded V1 appointment pages. */
import type { AltegioClient } from '../../providers/altegio-client.js';
import {
  scanRecords,
  type ServiceRecord,
} from '../../api/v1/records-analytics-adapter.js';
import { sanitizeUntrusted, UNTRUSTED_NOTE } from '../../tools/tool-result.js';
import { AnalyticsInputError } from './errors.js';
import { resolveLocationTimezone } from './location-timezone.js';
import { resolvePeriod, type PeriodInput } from './periods.js';

const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const positiveId = (n: unknown): n is number =>
  Number.isSafeInteger(n) && (n as number) > 0;
const attended = (r: ServiceRecord): boolean =>
  !r.deleted && (r.attendance ?? r.visit_attendance) === 1;
const localDay = (r: ServiceRecord): string =>
  String(r.datetime ?? r.date ?? '').slice(0, 10);
const lineValue = (line: ServiceRecord['services'][number]): number => {
  if (
    typeof line.manual_cost !== 'number' ||
    !Number.isFinite(line.manual_cost)
  )
    throw new Error(
      'An attended service line has no valid manual_cost; the report cannot be complete.'
    );
  // Backend AttendanceServiceItem::getManualCost returns the line total. It is
  // NOT a per-unit price and must not be multiplied by amount.
  return line.manual_cost;
};
const chargeValue = (line: ServiceRecord['services'][number]): number | null =>
  typeof line.cost === 'number' && Number.isFinite(line.cost)
    ? line.cost
    : null;

interface Source {
  period: ReturnType<typeof resolvePeriod>;
  rows: ServiceRecord[];
  source_count: number;
  pages: number;
  scanned_at: string;
  currency: string | null;
  service_categories: Map<number, number>;
  category_names: Map<number, string>;
  resource_names: Map<number, { resource_id: number; title: string }>;
}

async function source(
  client: AltegioClient,
  input: PeriodInput & { location_id: number },
  catalog: 'none' | 'categories' | 'resources' = 'none',
  teamMemberId?: number
): Promise<Source> {
  const timezone = await resolveLocationTimezone(client, input.location_id);
  const period = resolvePeriod(input, timezone);
  const scan = await scanRecords(
    client,
    input.location_id,
    period.date_from,
    period.date_to,
    teamMemberId
  );
  const [company, services, categories, resources] = await Promise.all([
    client.getLocation(input.location_id),
    catalog === 'categories'
      ? client.getServices(input.location_id)
      : Promise.resolve([]),
    catalog === 'categories'
      ? client.getServiceCategories(input.location_id)
      : Promise.resolve([]),
    catalog === 'resources'
      ? client.getResources(input.location_id)
      : Promise.resolve([]),
  ]);
  const serviceCategories = new Map<number, number>();
  for (const service of services)
    if (positiveId(service.id) && positiveId(service.category_id))
      serviceCategories.set(service.id, service.category_id);
  const categoryNames = new Map<number, string>();
  for (const category of categories)
    if (positiveId(category.id)) categoryNames.set(category.id, category.title);
  const resourceNames = new Map<
    number,
    { resource_id: number; title: string }
  >();
  for (const resource of resources)
    for (const instance of resource.instances ?? [])
      resourceNames.set(instance.id, {
        resource_id: resource.id,
        title: resource.title,
      });
  return {
    period,
    rows: scan.records.filter((r) => {
      const day = localDay(r);
      return day >= period.date_from && day <= period.date_to;
    }),
    source_count: scan.source_count,
    pages: scan.pages,
    scanned_at: scan.scanned_at,
    currency: sanitizeUntrusted(company.currency_short_title, { maxChars: 16 }),
    service_categories: serviceCategories,
    resource_names: resourceNames,
    category_names: categoryNames,
  };
}

type GroupBy =
  'service' | 'current_category' | 'team_member' | 'assigned_resource';
export interface ServiceMixInput extends PeriodInput {
  location_id: number;
  group_by?: GroupBy;
  team_member_id?: number;
  page?: number;
  page_size?: number;
}

interface MixRow {
  month: string;
  group_id: number | null;
  group_title: string | null;
  line_count: number;
  appointment_count: number;
  client_count: number;
  delivered_service_value: number;
  charge_after_loyalty: number | null;
  attribution:
    | 'direct'
    | 'current_catalog'
    | 'single_appointment_resource'
    | 'unattributed';
}

export async function getServiceMixTrend(
  client: AltegioClient,
  input: ServiceMixInput
) {
  const groupBy = input.group_by ?? 'service';
  const data = await source(
    client,
    input,
    groupBy === 'current_category'
      ? 'categories'
      : groupBy === 'assigned_resource'
        ? 'resources'
        : 'none',
    input.team_member_id
  );
  const groups = new Map<
    string,
    MixRow & {
      appointments: Set<number>;
      clients: Set<number>;
      charge_missing: boolean;
    }
  >();
  let deliveredTotal = 0;
  let arrivedAppointments = 0;
  let unattributedLines = 0;
  for (const record of data.rows) {
    if (
      !attended(record) ||
      (input.team_member_id && record.staff_id !== input.team_member_id)
    )
      continue;
    arrivedAppointments += 1;
    const lines = record.services ?? [];
    for (const line of lines) {
      if (!positiveId(line.id))
        throw new Error('An attended service line has no stable service id.');
      const value = lineValue(line);
      deliveredTotal += value;
      const month = localDay(record).slice(0, 7);
      let groupId: number | null = null;
      let title: string | null = null;
      let attribution: MixRow['attribution'] = 'direct';
      if (groupBy === 'service') {
        groupId = line.id;
        title = line.title ?? null;
      } else if (groupBy === 'current_category') {
        groupId = data.service_categories.get(line.id) ?? null;
        title =
          groupId === null ? null : (data.category_names.get(groupId) ?? null);
        attribution = groupId === null ? 'unattributed' : 'current_catalog';
      } else if (groupBy === 'team_member') {
        groupId = positiveId(record.staff_id) ? record.staff_id : null;
        title = record.staff?.name ?? null;
        attribution = groupId === null ? 'unattributed' : 'direct';
      } else {
        const instances = Array.isArray(record.resource_instance_ids)
          ? record.resource_instance_ids.filter(positiveId)
          : [];
        if (lines.length === 1 && instances.length === 1) {
          const resource = data.resource_names.get(instances[0]!);
          groupId = resource?.resource_id ?? null;
          title = resource?.title ?? null;
        }
        attribution =
          groupId === null ? 'unattributed' : 'single_appointment_resource';
      }
      if (attribution === 'unattributed') unattributedLines += 1;
      const key = `${month}:${groupId ?? 'null'}`;
      let row = groups.get(key);
      if (!row) {
        row = {
          month,
          group_id: groupId,
          group_title: title,
          line_count: 0,
          appointment_count: 0,
          client_count: 0,
          delivered_service_value: 0,
          charge_after_loyalty: 0,
          attribution,
          appointments: new Set(),
          clients: new Set(),
          charge_missing: false,
        };
        groups.set(key, row);
      }
      row.line_count += 1;
      row.delivered_service_value += value;
      row.appointments.add(record.id);
      if (positiveId(record.client?.id)) row.clients.add(record.client.id);
      const charge = chargeValue(line);
      if (charge === null) row.charge_missing = true;
      else row.charge_after_loyalty = (row.charge_after_loyalty ?? 0) + charge;
    }
  }
  const allRows = [...groups.values()]
    .map((row): MixRow => ({
      month: row.month,
      group_id: row.group_id,
      group_title: sanitizeUntrusted(row.group_title, { maxChars: 140 }),
      line_count: row.line_count,
      appointment_count: row.appointments.size,
      client_count: row.clients.size,
      delivered_service_value: money(row.delivered_service_value),
      charge_after_loyalty: row.charge_missing
        ? null
        : money(row.charge_after_loyalty ?? 0),
      attribution: row.attribution,
    }))
    .sort(
      (a, b) =>
        a.month.localeCompare(b.month) ||
        (a.group_id ?? -1) - (b.group_id ?? -1)
    );
  const page = input.page ?? 1;
  const pageSize = input.page_size ?? 25;
  return {
    text: `${allRows.length} monthly ${groupBy} cells; ${arrivedAppointments} attended appointments. Delivered service value ${money(deliveredTotal)} ${data.currency ?? '(currency unavailable)'}.`,
    structuredContent: {
      location_id: input.location_id,
      period: data.period,
      currency: data.currency,
      group_by: groupBy,
      team_member_id: input.team_member_id ?? null,
      rows: allRows.slice((page - 1) * pageSize, page * pageSize),
      page: {
        page,
        page_size: pageSize,
        total_count: allRows.length,
        has_more: page * pageSize < allRows.length,
      },
      totals: {
        attended_appointments: arrivedAppointments,
        delivered_service_value: money(deliveredTotal),
        unattributed_service_lines: unattributedLines,
      },
      provenance: {
        source: 'GET /records/{location_id}',
        source_count: data.source_count,
        pages_scanned: data.pages,
        scanned_at: data.scanned_at,
        completeness: 'all_source_pages_read; no transactional snapshot',
        amount_basis:
          'attendance_service_item.manual_cost line total; before loyalty deductions; not cash or recognized accounting revenue',
        category_basis: 'current catalog category, not historical category',
        resource_basis:
          'appointment assigned resource, attributed only for one service line and one known resource instance; not proof of actual device use',
        product_sales_included: false,
      },
      untrusted_data_note: UNTRUSTED_NOTE,
    },
  };
}

export interface ServicePenetrationInput extends PeriodInput {
  location_id: number;
  source_service_ids?: number[];
  source_category_ids?: number[];
  target_service_ids?: number[];
  target_category_ids?: number[];
  page?: number;
  page_size?: number;
}

/** Distinct attended clients, overlap, delivered-value cohorts and a paged ID list. */
export async function getClientServicePenetration(
  client: AltegioClient,
  input: ServicePenetrationInput
) {
  if (
    (input.target_service_ids?.length ?? 0) +
      (input.target_category_ids?.length ?? 0) ===
    0
  )
    throw new AnalyticsInputError(
      'Select at least one target service or current category id.'
    );
  const data = await source(
    client,
    input,
    (input.source_category_ids?.length ?? 0) +
      (input.target_category_ids?.length ?? 0) >
      0
      ? 'categories'
      : 'none'
  );
  const target = new Set(input.target_service_ids ?? []);
  const targetCategories = new Set(input.target_category_ids ?? []);
  const sourceIds = new Set(input.source_service_ids ?? []);
  const sourceCategories = new Set(input.source_category_ids ?? []);
  const clients = new Map<
    number,
    { value: number; target: boolean; source: boolean }
  >();
  let anonymousAppointments = 0;
  for (const record of data.rows) {
    if (!attended(record)) continue;
    if (!positiveId(record.client?.id)) {
      anonymousAppointments += 1;
      continue;
    }
    const id = record.client.id;
    let item = clients.get(id);
    if (!item) {
      item = { value: 0, target: false, source: false };
      clients.set(id, item);
    }
    for (const line of record.services ?? []) {
      if (!positiveId(line.id))
        throw new Error('An attended service line has no stable service id.');
      item.value += lineValue(line);
      const category = data.service_categories.get(line.id);
      if (
        target.has(line.id) ||
        (category !== undefined && targetCategories.has(category))
      )
        item.target = true;
      if (
        sourceIds.has(line.id) ||
        (category !== undefined && sourceCategories.has(category))
      )
        item.source = true;
    }
  }
  const ranked = [...clients.entries()].sort(
    (a, b) => b[1].value - a[1].value || a[0] - b[0]
  );
  const decile = Math.floor(ranked.length / 10);
  const cohortRows = [
    { name: 'top_delivered_value_decile', members: ranked.slice(0, decile) },
    {
      name: 'next_delivered_value_decile',
      members: ranked.slice(decile, 2 * decile),
    },
    { name: 'remaining_active_clients', members: ranked.slice(2 * decile) },
  ].map(({ name, members }) => ({
    name,
    denominator: members.length,
    target_adopters: members.filter(([, item]) => item.target).length,
    target_penetration_percent: members.length
      ? money(
          (100 * members.filter(([, item]) => item.target).length) /
            members.length
        )
      : 0,
  }));
  const sourceClients = ranked.filter(
    ([, item]) => sourceIds.size + sourceCategories.size === 0 || item.source
  );
  const adopters = ranked.filter(([, item]) => item.target).length;
  const overlap = sourceClients.filter(([, item]) => item.target).length;
  const candidates = sourceClients
    .filter(([, item]) => !item.target)
    .map(([id]) => id)
    .sort((a, b) => a - b);
  const page = input.page ?? 1;
  const pageSize = input.page_size ?? 50;
  return {
    text: `${adopters} of ${ranked.length} identified active clients used the target service group (${ranked.length ? money((100 * adopters) / ranked.length) : 0}%). ${candidates.length} source-group clients did not use it.`,
    structuredContent: {
      location_id: input.location_id,
      period: data.period,
      source_service_ids: [...sourceIds],
      source_category_ids: [...sourceCategories],
      target_service_ids: [...target],
      target_category_ids: [...targetCategories],
      denominator: {
        identified_active_attended_clients: ranked.length,
        anonymous_attended_appointments_excluded: anonymousAppointments,
      },
      target_adopters: adopters,
      penetration_percent: ranked.length
        ? money((100 * adopters) / ranked.length)
        : 0,
      source_clients: sourceClients.length,
      source_target_overlap: overlap,
      source_without_target: candidates.length,
      delivered_value_cohorts: cohortRows,
      candidate_client_ids: candidates.slice(
        (page - 1) * pageSize,
        page * pageSize
      ),
      page: {
        page,
        page_size: pageSize,
        total_count: candidates.length,
        has_more: page * pageSize < candidates.length,
      },
      provenance: {
        source: 'GET /records/{location_id}',
        source_count: data.source_count,
        pages_scanned: data.pages,
        scanned_at: data.scanned_at,
        completeness: 'all_source_pages_read; no transactional snapshot',
        cohort_basis:
          'attendance_service_item.manual_cost delivered value among identified active attended clients; not incoming cash or payer cohorts',
        category_basis:
          'current service catalog category, not historical category',
        rank_rule:
          'descending delivered value; ties by ascending client id; first floor(N/10) and next floor(N/10)',
      },
    },
  };
}
