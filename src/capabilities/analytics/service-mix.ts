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

/** Two decimals, for money and percentages alike. */
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
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
      'An attended service line has no recorded line total; the report cannot be complete.'
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
  catalog: 'none' | 'categories' | 'resources' | 'both' = 'none',
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
    catalog === 'categories' || catalog === 'both'
      ? client.getServices(input.location_id)
      : Promise.resolve([]),
    catalog === 'categories' || catalog === 'both'
      ? client.getServiceCategories(input.location_id)
      : Promise.resolve([]),
    catalog === 'resources' || catalog === 'both'
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
    for (const instance of resource.instances ?? []) {
      const existing = resourceNames.get(instance.id);
      if (existing && existing.resource_id !== resource.id)
        throw new Error(
          'Resource catalog maps one instance to multiple resources.'
        );
      resourceNames.set(instance.id, {
        resource_id: resource.id,
        title: resource.title,
      });
    }
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
  | 'service'
  | 'current_category'
  | 'team_member'
  | 'assigned_resource'
  | 'assigned_device_or_current_category';

type ServiceGroup = {
  type: 'assigned_resource' | 'current_category' | 'unattributed';
  id: number | null;
  title: string | null;
  associated_resource_ids: number[];
  unmapped_resource_instance_ids: number[];
};

/** The record API exposes appointment resources, not the service-resource link. */
function serviceGroup(
  data: Source,
  record: ServiceRecord,
  line: ServiceRecord['services'][number]
): ServiceGroup {
  const instances = [...new Set(record.resource_instance_ids)].sort(
    (a, b) => a - b
  );
  const known = instances.map((id) => data.resource_names.get(id));
  const associatedResourceIds = [
    ...new Set(
      known.flatMap((resource) => (resource ? [resource.resource_id] : []))
    ),
  ].sort((a, b) => a - b);
  const unmappedInstanceIds = instances.filter((_, index) => !known[index]);
  if (instances.length > 0) {
    // Multiple service lines may share one recorded resource. Several
    // instances of the same parent resource still form one additive group.
    if (
      associatedResourceIds.length === 1 &&
      unmappedInstanceIds.length === 0
    ) {
      const resource = known[0]!;
      return {
        type: 'assigned_resource',
        id: resource.resource_id,
        title: resource.title,
        associated_resource_ids: associatedResourceIds,
        unmapped_resource_instance_ids: [],
      };
    }
    return {
      type: 'unattributed',
      id: null,
      title: null,
      associated_resource_ids: associatedResourceIds,
      unmapped_resource_instance_ids: unmappedInstanceIds,
    };
  }
  const categoryId = data.service_categories.get(line.id);
  return categoryId === undefined
    ? {
        type: 'unattributed',
        id: null,
        title: null,
        associated_resource_ids: [],
        unmapped_resource_instance_ids: [],
      }
    : {
        type: 'current_category',
        id: categoryId,
        title: data.category_names.get(categoryId) ?? null,
        associated_resource_ids: [],
        unmapped_resource_instance_ids: [],
      };
}
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
  group_type: ServiceGroup['type'] | null;
  service_id: number | null;
  service_title: string | null;
  associated_resource_ids: number[];
  unmapped_resource_instance_ids: number[];
  line_count: number;
  appointment_count: number;
  client_count: number;
  delivered_service_value: number;
  charge_after_loyalty: number | null;
  attribution:
    | 'direct'
    | 'current_catalog'
    | 'single_appointment_resource'
    | 'shared_appointment_resource'
    | 'mixed_appointment_resource'
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
    groupBy === 'assigned_device_or_current_category'
      ? 'both'
      : groupBy === 'current_category'
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
      let groupType: MixRow['group_type'] = null;
      let associatedResourceIds: number[] = [];
      let unmappedInstanceIds: number[] = [];
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
        const group = serviceGroup(data, record, line);
        associatedResourceIds = group.associated_resource_ids;
        unmappedInstanceIds = group.unmapped_resource_instance_ids;
        if (groupBy === 'assigned_resource') {
          if (group.type === 'assigned_resource') {
            groupId = group.id;
            title = group.title;
          }
        } else {
          groupId = group.id;
          title = group.title;
          groupType = group.type;
        }
        attribution =
          groupId === null
            ? 'unattributed'
            : group.type === 'assigned_resource'
              ? lines.length === 1
                ? 'single_appointment_resource'
                : 'shared_appointment_resource'
              : 'current_catalog';
      }
      if (attribution === 'unattributed') unattributedLines += 1;
      const key = `${month}:${groupType ?? groupBy}:${groupId ?? 'null'}:${groupBy === 'assigned_device_or_current_category' ? line.id : ''}:${associatedResourceIds.join(',')}:${unmappedInstanceIds.join(',')}`;
      let row = groups.get(key);
      if (!row) {
        row = {
          month,
          group_id: groupId,
          group_title: title,
          group_type: groupType,
          service_id:
            groupBy === 'assigned_device_or_current_category' ? line.id : null,
          service_title:
            groupBy === 'assigned_device_or_current_category'
              ? (line.title ?? null)
              : null,
          associated_resource_ids: associatedResourceIds,
          unmapped_resource_instance_ids: unmappedInstanceIds,
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
      if (row.attribution !== attribution) {
        if (
          [
            'single_appointment_resource',
            'shared_appointment_resource',
            'mixed_appointment_resource',
          ].includes(row.attribution) &&
          [
            'single_appointment_resource',
            'shared_appointment_resource',
          ].includes(attribution)
        )
          row.attribution = 'mixed_appointment_resource';
        else throw new Error('Incompatible service grouping provenance.');
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
      group_type: row.group_type,
      service_id: row.service_id,
      service_title: sanitizeUntrusted(row.service_title, { maxChars: 140 }),
      associated_resource_ids: row.associated_resource_ids,
      unmapped_resource_instance_ids: row.unmapped_resource_instance_ids,
      line_count: row.line_count,
      appointment_count: row.appointments.size,
      client_count: row.clients.size,
      delivered_service_value: round2(row.delivered_service_value),
      charge_after_loyalty: row.charge_missing
        ? null
        : round2(row.charge_after_loyalty ?? 0),
      attribution: row.attribution,
    }))
    .sort(
      (a, b) =>
        a.month.localeCompare(b.month) ||
        (a.group_type ?? '').localeCompare(b.group_type ?? '') ||
        (a.group_id ?? -1) - (b.group_id ?? -1) ||
        (a.service_id ?? -1) - (b.service_id ?? -1) ||
        a.attribution.localeCompare(b.attribution) ||
        a.associated_resource_ids
          .join(',')
          .localeCompare(b.associated_resource_ids.join(',')) ||
        a.unmapped_resource_instance_ids
          .join(',')
          .localeCompare(b.unmapped_resource_instance_ids.join(','))
    );
  const page = input.page ?? 1;
  const pageSize = input.page_size ?? 25;
  return {
    text: `${allRows.length} monthly ${groupBy} cells; ${arrivedAppointments} attended appointments. Delivered service value ${round2(deliveredTotal)} ${data.currency ?? '(currency unavailable)'}.`,
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
        delivered_service_value: round2(deliveredTotal),
        unattributed_service_lines: unattributedLines,
      },
      provenance: {
        source: 'documented V1 appointment list',
        source_count: data.source_count,
        pages_scanned: data.pages,
        scanned_at: data.scanned_at,
        completeness: 'all_source_pages_read; no transactional snapshot',
        amount_basis:
          'recorded service-line total before loyalty deductions; not cash received or recognized accounting revenue',
        category_basis: 'current catalog category, not historical category',
        resource_basis:
          'one known assigned resource type can cover several appointment service lines; multiple resource types remain unallocated with their associations shown',
        hybrid_group_basis:
          'assigned resource when every known appointment instance belongs to one resource type; otherwise current category when no instance is assigned; multiple resource types and missing mappings remain unattributed',
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
  source_resource_ids?: number[];
  target_service_ids?: number[];
  target_category_ids?: number[];
  target_resource_ids?: number[];
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
      (input.target_category_ids?.length ?? 0) +
      (input.target_resource_ids?.length ?? 0) ===
    0
  )
    throw new AnalyticsInputError(
      'Select at least one target service, current category or assigned resource id.'
    );
  const data = await source(client, input, 'both');
  const target = new Set(input.target_service_ids ?? []);
  const targetCategories = new Set(input.target_category_ids ?? []);
  const targetResources = new Set(input.target_resource_ids ?? []);
  const sourceIds = new Set(input.source_service_ids ?? []);
  const sourceCategories = new Set(input.source_category_ids ?? []);
  const sourceResources = new Set(input.source_resource_ids ?? []);
  const knownResources = new Set(
    [...data.resource_names.values()].map((resource) => resource.resource_id)
  );
  const resourceTitles = new Map<number, string>(
    [...data.resource_names.values()].map((resource) => [
      resource.resource_id,
      resource.title,
    ])
  );
  for (const id of [...targetResources, ...sourceResources])
    if (!knownResources.has(id))
      throw new AnalyticsInputError(
        `Resource ${id} has no current instance in this location; its historical assignments cannot be identified.`
      );
  const clients = new Map<
    number,
    {
      value: number;
      target: boolean;
      source: boolean;
      groups: Set<string>;
      has_unknown: boolean;
    }
  >();
  const groupLabels = new Map<string, ServiceGroup>();
  const skuClients = new Map<
    number,
    { title: string | null; clients: Set<number>; lines: number; value: number }
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
      item = {
        value: 0,
        target: false,
        source: false,
        groups: new Set(),
        has_unknown: false,
      };
      clients.set(id, item);
    }
    for (const line of record.services ?? []) {
      if (!positiveId(line.id))
        throw new Error('An attended service line has no stable service id.');
      const value = lineValue(line);
      item.value += value;
      const group = serviceGroup(data, record, line);
      if (group.type === 'unattributed') item.has_unknown = true;
      else {
        const key = `${group.type}:${group.id}`;
        item.groups.add(key);
        groupLabels.set(key, group);
      }
      // Resource adoption is appointment-level. Even when money cannot be
      // allocated among several devices, preserve every recorded association.
      for (const resourceId of group.associated_resource_ids) {
        const key = `assigned_resource:${resourceId}`;
        item.groups.add(key);
        groupLabels.set(key, {
          type: 'assigned_resource',
          id: resourceId,
          title: resourceTitles.get(resourceId) ?? null,
          associated_resource_ids: [resourceId],
          unmapped_resource_instance_ids: [],
        });
      }
      let sku = skuClients.get(line.id);
      if (!sku) {
        sku = {
          title: line.title ?? null,
          clients: new Set(),
          lines: 0,
          value: 0,
        };
        skuClients.set(line.id, sku);
      }
      sku.clients.add(id);
      sku.lines += 1;
      sku.value += value;
      const category = data.service_categories.get(line.id);
      if (
        target.has(line.id) ||
        (category !== undefined && targetCategories.has(category)) ||
        group.associated_resource_ids.some((resourceId) =>
          targetResources.has(resourceId)
        )
      )
        item.target = true;
      if (
        sourceIds.has(line.id) ||
        (category !== undefined && sourceCategories.has(category)) ||
        group.associated_resource_ids.some((resourceId) =>
          sourceResources.has(resourceId)
        )
      )
        item.source = true;
    }
  }
  const ranked = [...clients.entries()].sort(
    (a, b) => b[1].value - a[1].value || a[0] - b[0]
  );
  const decile = Math.floor(ranked.length / 10);
  const cohorts = [
    { name: 'top_delivered_value_decile', members: ranked.slice(0, decile) },
    {
      name: 'next_delivered_value_decile',
      members: ranked.slice(decile, 2 * decile),
    },
    { name: 'remaining_active_clients', members: ranked.slice(2 * decile) },
  ];
  const cohortRows = cohorts.map(({ name, members }) => ({
    cohort: name,
    denominator: members.length,
    target_adopters: members.filter(([, item]) => item.target).length,
    penetration_percent: members.length
      ? round2(
          (100 * members.filter(([, item]) => item.target).length) /
            members.length
        )
      : 0,
    target_non_adopters: members.filter(([, item]) => !item.target).length,
    confirmed_mono_group_clients: members.filter(
      ([, item]) => item.groups.size === 1 && !item.has_unknown
    ).length,
    clients_with_unattributed_lines: members.filter(
      ([, item]) => item.has_unknown
    ).length,
  }));
  const sourceClients = ranked.filter(
    ([, item]) =>
      sourceIds.size + sourceCategories.size + sourceResources.size === 0 ||
      item.source
  );
  const groupCounts = new Map<
    string,
    { clients: number; mono_clients: number; cohort_clients: number[] }
  >();
  const pairCounts = new Map<string, number>();
  for (const [rank, [, item]] of ranked.entries()) {
    const groups = [...item.groups].sort();
    for (const key of groups) {
      let count = groupCounts.get(key);
      if (!count) {
        count = { clients: 0, mono_clients: 0, cohort_clients: [0, 0, 0] };
        groupCounts.set(key, count);
      }
      count.clients += 1;
      if (groups.length === 1 && !item.has_unknown) count.mono_clients += 1;
      count.cohort_clients[rank < decile ? 0 : rank < 2 * decile ? 1 : 2]! += 1;
    }
    for (let i = 0; i < groups.length; i++)
      for (let j = i + 1; j < groups.length; j++) {
        const pair = `${groups[i]}|${groups[j]}`;
        pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
        if (pairCounts.size > 2000)
          throw new AnalyticsInputError(
            'More than 2,000 distinct service-group pairs; narrow the period.'
          );
      }
  }
  const groupRef = (key: string) => {
    const group = groupLabels.get(key)!;
    return {
      group_type: group.type,
      group_id: group.id,
      group_title: sanitizeUntrusted(group.title, { maxChars: 140 }),
    };
  };
  const topGroups = [...groupCounts.entries()]
    .map(([key, count]) => ({
      ...groupRef(key),
      active_clients: count.clients,
      penetration_percent: ranked.length
        ? round2((100 * count.clients) / ranked.length)
        : 0,
      confirmed_mono_group_clients: count.mono_clients,
      cohort_penetration: cohortRows.map((cohort, index) => ({
        cohort: cohort.cohort,
        denominator: cohort.denominator,
        adopters: count.cohort_clients[index]!,
        penetration_percent: cohort.denominator
          ? round2((100 * count.cohort_clients[index]!) / cohort.denominator)
          : null,
      })),
      top_vs_remaining_gap_percentage_points:
        cohortRows[0]!.denominator && cohortRows[2]!.denominator
          ? round2(
              (100 * count.cohort_clients[0]!) / cohortRows[0]!.denominator -
                (100 * count.cohort_clients[2]!) / cohortRows[2]!.denominator
            )
          : null,
    }))
    .sort(
      (a, b) =>
        b.active_clients - a.active_clients ||
        a.group_type.localeCompare(b.group_type) ||
        (a.group_id ?? 0) - (b.group_id ?? 0)
    );
  const topSkus = [...skuClients.entries()]
    .map(([serviceId, sku]) => ({
      service_id: serviceId,
      service_title: sanitizeUntrusted(sku.title, { maxChars: 140 }),
      active_clients: sku.clients.size,
      penetration_percent: ranked.length
        ? round2((100 * sku.clients.size) / ranked.length)
        : 0,
      service_lines: sku.lines,
      delivered_service_value: round2(sku.value),
    }))
    .sort(
      (a, b) =>
        b.active_clients - a.active_clients || a.service_id - b.service_id
    );
  const topPairs = [...pairCounts.entries()]
    .map(([pair, activeClients]) => {
      const [left, right] = pair.split('|');
      return {
        first_group: groupRef(left!),
        second_group: groupRef(right!),
        active_clients: activeClients,
        penetration_percent: ranked.length
          ? round2((100 * activeClients) / ranked.length)
          : 0,
      };
    })
    .sort(
      (a, b) =>
        b.active_clients - a.active_clients ||
        a.first_group.group_type.localeCompare(b.first_group.group_type) ||
        (a.first_group.group_id ?? 0) - (b.first_group.group_id ?? 0) ||
        a.second_group.group_type.localeCompare(b.second_group.group_type) ||
        (a.second_group.group_id ?? 0) - (b.second_group.group_id ?? 0)
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
    text: `${adopters} of ${ranked.length} identified active clients used the target service group (${ranked.length ? round2((100 * adopters) / ranked.length) : 0}%). ${candidates.length} source-group clients did not use it.`,
    structuredContent: {
      location_id: input.location_id,
      period: data.period,
      source_service_ids: [...sourceIds],
      source_category_ids: [...sourceCategories],
      source_resource_ids: [...sourceResources],
      target_service_ids: [...target],
      target_category_ids: [...targetCategories],
      target_resource_ids: [...targetResources],
      denominator: {
        identified_active_attended_clients: ranked.length,
        anonymous_attended_appointments_excluded: anonymousAppointments,
      },
      target_adopters: adopters,
      penetration_percent: ranked.length
        ? round2((100 * adopters) / ranked.length)
        : 0,
      source_clients: sourceClients.length,
      source_target_overlap: overlap,
      source_without_target: candidates.length,
      delivered_value_cohorts: cohortRows,
      cohort_penetration_gap_percentage_points:
        cohortRows[0]!.denominator && cohortRows[2]!.denominator
          ? round2(
              cohortRows[0]!.penetration_percent -
                cohortRows[2]!.penetration_percent
            )
          : null,
      group_insights: {
        group_basis:
          'all known appointment resource associations count for client adoption; delivered value is assigned only when every instance belongs to one resource type; otherwise current category when no resource is assigned or unattributed',
        ranking_limit: 20,
        total_attributed_groups: topGroups.length,
        top_groups: topGroups.slice(0, 20),
        total_service_skus: topSkus.length,
        top_service_skus: topSkus.slice(0, 20),
        total_group_pairs: topPairs.length,
        top_group_cooccurrence: topPairs.slice(0, 20),
        clients_with_unattributed_lines: ranked.filter(
          ([, item]) => item.has_unknown
        ).length,
        confirmed_mono_group_clients: ranked.filter(
          ([, item]) => item.groups.size === 1 && !item.has_unknown
        ).length,
      },
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
        source: 'documented V1 appointment list',
        source_count: data.source_count,
        pages_scanned: data.pages,
        scanned_at: data.scanned_at,
        completeness: 'all_source_pages_read; no transactional snapshot',
        cohort_basis:
          'delivered service value (recorded service-line totals before loyalty deductions) among identified active attended clients; not incoming cash — payer cohorts come from analytics_get_client_payer_cohorts',
        category_basis:
          'current service catalog category, not historical category',
        resource_basis:
          'appointment-level assigned resource associations on attended service visits; multiple resources may count for client adoption but delivered value is not duplicated across them',
        rank_rule:
          'descending delivered value; ties by ascending client id; first floor(N/10) and next floor(N/10)',
      },
      untrusted_data_note: UNTRUSTED_NOTE,
    },
  };
}
