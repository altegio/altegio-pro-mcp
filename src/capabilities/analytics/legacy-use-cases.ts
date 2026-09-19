/** Use cases for the temporary stable ERP report adapter. */
import type { AltegioClient } from '../../providers/altegio-client.js';
import { V1LegacyAnalyticsAdapter } from '../../api/v1/legacy-analytics-adapter.js';
import type {
  CashFlowBreakdownRequest,
  ClientReactivationRequest,
  GroupEventPerformanceRequest,
  LegacyPeriodRequest,
  ProductSalesGroup,
  ProductSalesRequest,
  ClientForecastReport,
  ClientRetentionReport,
  ClientSalesReport,
  ServiceProfitabilityGroup,
  ServiceProfitabilityReport,
  TeamMemberSalesReport,
} from '../../api/legacy-analytics-api.js';
import { CONTACTS_WITHHELD_NOTICE } from '../../tools/contacts.js';
import { sanitizeUntrusted, UNTRUSTED_NOTE } from '../../tools/tool-result.js';
import { resolveLocationTimezone } from './location-timezone.js';
import { resolvePeriod, type Period, type PeriodInput } from './periods.js';

export interface LegacyAnalyticsResult {
  text: string;
  structuredContent: unknown;
}

function adapter(client: AltegioClient): V1LegacyAnalyticsAdapter {
  return new V1LegacyAnalyticsAdapter(client);
}

async function periodFor(
  client: AltegioClient,
  locationId: number,
  input: PeriodInput
): Promise<Period> {
  const timezone = await resolveLocationTimezone(client, locationId);
  return resolvePeriod(input, timezone);
}

function safe(value: string | null | undefined, maxChars = 200): string | null {
  return sanitizeUntrusted(value, { maxChars });
}

function safeClientSales(report: ClientSalesReport): ClientSalesReport {
  return {
    ...report,
    rows: report.rows.map((row) => ({
      ...row,
      client_name: safe(row.client_name, 160),
      ...(row.phone !== undefined ? { phone: safe(row.phone, 80) } : {}),
      ...(row.email !== undefined ? { email: safe(row.email, 160) } : {}),
    })),
  };
}

function safeRetention(report: ClientRetentionReport): ClientRetentionReport {
  return {
    ...report,
    rows: report.rows.map((row) => ({
      ...row,
      team_member_name: safe(row.team_member_name, 160),
      position_title: safe(row.position_title, 160),
    })),
  };
}

function safeForecast(report: ClientForecastReport): ClientForecastReport {
  return {
    ...report,
    rows: report.rows.map((row) => ({
      ...row,
      client_name: safe(row.client_name, 160),
      ...(row.phone !== undefined ? { phone: safe(row.phone, 80) } : {}),
      ...(row.email !== undefined ? { email: safe(row.email, 160) } : {}),
    })),
  };
}

function safeServices(
  report: ServiceProfitabilityReport
): ServiceProfitabilityReport {
  return {
    ...report,
    rows: report.rows.map((row) => ({
      ...row,
      title: safe(row.title, 200),
      service_category_title: safe(row.service_category_title, 200),
    })),
  };
}

function safeTeam(report: TeamMemberSalesReport): TeamMemberSalesReport {
  return {
    ...report,
    rows: report.rows.map((row) => ({
      ...row,
      team_member_name: safe(row.team_member_name, 160),
      position_title: safe(row.position_title, 160),
    })),
  };
}

export interface ClientSalesInput extends PeriodInput {
  location_id: number;
  page?: number;
  page_size?: number;
  include_contacts?: boolean;
}

export async function getClientSales(
  client: AltegioClient,
  input: ClientSalesInput
): Promise<LegacyAnalyticsResult> {
  const period = await periodFor(client, input.location_id, input);
  const page = input.page ?? 1;
  const pageSize = input.page_size ?? 50;
  const includeContacts = input.include_contacts === true;
  const report = safeClientSales(
    await adapter(client).getClientSales({
      location_id: input.location_id,
      date_from: period.date_from,
      date_to: period.date_to,
      page,
      page_size: pageSize,
      include_contacts: includeContacts,
    })
  );
  const lines = [
    `${report.page.total_count} client(s) generated revenue in ${period.date_from}–${period.date_to}.`,
    `Page ${page}: ${report.page.returned} row(s); total revenue ${report.totals.revenue ?? 'n/a'} ${report.currency ?? '(currency unavailable)'}.`,
  ];
  if (report.page.has_more) lines.push(`More rows: request page ${page + 1}.`);
  if (!includeContacts) lines.push(CONTACTS_WITHHELD_NOTICE);
  return {
    text: lines.join('\n'),
    structuredContent: {
      location_id: input.location_id,
      period,
      ...report,
      contacts_included: includeContacts,
      untrusted_data_note: UNTRUSTED_NOTE,
    },
  };
}

export interface ClientRetentionInput extends PeriodInput {
  location_id: number;
  service_id?: number;
}

export async function getClientRetention(
  client: AltegioClient,
  input: ClientRetentionInput
): Promise<LegacyAnalyticsResult> {
  const period = await periodFor(client, input.location_id, input);
  const report = safeRetention(
    await adapter(client).getClientRetention({
      location_id: input.location_id,
      date_from: period.date_from,
      date_to: period.date_to,
      ...(input.service_id ? { service_id: input.service_id } : {}),
    })
  );
  return {
    text: [
      `Client retention for ${period.date_from}–${period.date_to}: ${report.rows.length} team member(s).`,
      `Unique clients ${report.totals.clients_count}; returned ${report.totals.clients_returned_count} of ${report.totals.clients_eligible_for_return_count} eligible (${report.totals.retention_percent ?? 'n/a'}%).`,
    ].join('\n'),
    structuredContent: {
      location_id: input.location_id,
      period,
      ...(input.service_id ? { service_id: input.service_id } : {}),
      ...report,
      untrusted_data_note: UNTRUSTED_NOTE,
    },
  };
}

export interface ClientForecastInput {
  location_id: number;
  prediction_date?: string;
  page?: number;
  page_size?: number;
  include_contacts?: boolean;
}

export async function getClientForecast(
  client: AltegioClient,
  input: ClientForecastInput
): Promise<LegacyAnalyticsResult> {
  const page = input.page ?? 1;
  const pageSize = input.page_size ?? 50;
  const includeContacts = input.include_contacts === true;
  const report = safeForecast(
    await adapter(client).getClientForecast({
      location_id: input.location_id,
      ...(input.prediction_date
        ? { prediction_date: input.prediction_date }
        : {}),
      page,
      page_size: pageSize,
      include_contacts: includeContacts,
    })
  );
  const lines = [
    `Client forecast: ${report.page.total_count} row(s); showing page ${page} with ${report.page.returned}.`,
    'The temporary workbook does not expose client ids, so client_id is null rather than guessed.',
  ];
  if (report.page.has_more) lines.push(`More rows: request page ${page + 1}.`);
  if (!includeContacts) lines.push(CONTACTS_WITHHELD_NOTICE);
  return {
    text: lines.join('\n'),
    structuredContent: {
      location_id: input.location_id,
      ...report,
      contacts_included: includeContacts,
      client_identity_status: 'unavailable_from_legacy_export',
      untrusted_data_note: UNTRUSTED_NOTE,
    },
  };
}

export interface ServiceProfitabilityInput extends PeriodInput {
  location_id: number;
  group_by?: ServiceProfitabilityGroup;
  team_member_id?: number;
  service_category_id?: number;
  page?: number;
  page_size?: number;
}

export async function getServiceProfitability(
  client: AltegioClient,
  input: ServiceProfitabilityInput
): Promise<LegacyAnalyticsResult> {
  const period = await periodFor(client, input.location_id, input);
  const page = input.page ?? 1;
  const pageSize = input.page_size ?? 100;
  const groupBy = input.group_by ?? 'service';
  const report = safeServices(
    await adapter(client).getServiceProfitability({
      location_id: input.location_id,
      date_from: period.date_from,
      date_to: period.date_to,
      page,
      page_size: pageSize,
      group_by: groupBy,
      ...(input.team_member_id ? { team_member_id: input.team_member_id } : {}),
      ...(input.service_category_id
        ? { service_category_id: input.service_category_id }
        : {}),
    })
  );
  return {
    text: [
      `${report.page.total_count} ${groupBy === 'service' ? 'service' : 'service-category'} row(s) for ${period.date_from}–${period.date_to}; showing ${report.page.returned}.`,
      `Total service contribution ${report.totals.contribution_result ?? 'n/a'} ${report.currency ?? '(currency unavailable)'} after consumables and team-member compensation.`,
      ...(report.page.has_more ? [`More rows: request page ${page + 1}.`] : []),
    ].join('\n'),
    structuredContent: {
      location_id: input.location_id,
      period,
      ...report,
      untrusted_data_note: UNTRUSTED_NOTE,
    },
  };
}

export interface TeamMemberSalesInput extends PeriodInput {
  location_id: number;
  service_ids?: number[];
  service_category_ids?: number[];
  product_ids?: number[];
  product_category_ids?: number[];
  position_ids?: number[];
}

export async function getTeamMemberSales(
  client: AltegioClient,
  input: TeamMemberSalesInput
): Promise<LegacyAnalyticsResult> {
  const period = await periodFor(client, input.location_id, input);
  const report = safeTeam(
    await adapter(client).getTeamMemberSales({
      location_id: input.location_id,
      date_from: period.date_from,
      date_to: period.date_to,
      ...(input.service_ids ? { service_ids: input.service_ids } : {}),
      ...(input.service_category_ids
        ? { service_category_ids: input.service_category_ids }
        : {}),
      ...(input.product_ids ? { product_ids: input.product_ids } : {}),
      ...(input.product_category_ids
        ? { product_category_ids: input.product_category_ids }
        : {}),
      ...(input.position_ids ? { position_ids: input.position_ids } : {}),
    })
  );
  return {
    text: [
      `Team-member sales for ${period.date_from}–${period.date_to}: ${report.rows.length} row(s).`,
      `Total revenue ${report.totals.revenue ?? 'n/a'} ${report.currency ?? '(currency unavailable)'}; services ${report.totals.services_revenue ?? 'n/a'}, products ${report.totals.products_revenue ?? 'n/a'}.`,
    ].join('\n'),
    structuredContent: {
      location_id: input.location_id,
      period,
      filters_applied: {
        service_ids: input.service_ids ?? [],
        service_category_ids: input.service_category_ids ?? [],
        product_ids: input.product_ids ?? [],
        product_category_ids: input.product_category_ids ?? [],
        position_ids: input.position_ids ?? [],
      },
      ...report,
      untrusted_data_note: UNTRUSTED_NOTE,
    },
  };
}

/** Canonical request shapes survive replacement of the temporary adapter by V3. */
type WithPeriod<T> = Omit<T, 'date_from' | 'date_to'> & PeriodInput;
export type TeamMemberCapacityInput = WithPeriod<LegacyPeriodRequest>;
export type ClientReactivationInput = WithPeriod<
  Omit<ClientReactivationRequest, 'page' | 'page_size' | 'include_contacts'>
> & { page?: number; page_size?: number; include_contacts?: boolean };
export type GroupEventPerformanceInput = WithPeriod<
  Omit<GroupEventPerformanceRequest, 'page' | 'page_size'>
> & { page?: number; page_size?: number };
export type ProductSalesInput = WithPeriod<
  Omit<ProductSalesRequest, 'page' | 'page_size' | 'group_by'>
> & {
  page?: number;
  page_size?: number;
  group_by?: ProductSalesGroup;
};
export type CashFlowBreakdownInput = WithPeriod<CashFlowBreakdownRequest>;

function sanitizeReport(value: unknown): unknown {
  if (typeof value === 'string') return safe(value, 200);
  if (Array.isArray(value)) return value.map(sanitizeReport);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeReport(item)])
    );
  return value;
}

function nextReportResult(
  locationId: number,
  period: Period,
  report: object,
  text: string,
  extra: object = {}
): LegacyAnalyticsResult {
  const structuredContent = {
    location_id: locationId,
    period,
    ...(sanitizeReport(report) as object),
    ...extra,
    untrusted_data_note: UNTRUSTED_NOTE,
  };
  // Refuse an oversized answer rather than silently dropping rows or columns.
  if (JSON.stringify(structuredContent).length > 24000)
    throw new Error(
      'This analytics result is too large. Narrow the period or filters, or reduce page_size.'
    );
  return { text, structuredContent };
}

export async function getTeamMemberCapacity(
  client: AltegioClient,
  input: TeamMemberCapacityInput
): Promise<LegacyAnalyticsResult> {
  const period = await periodFor(client, input.location_id, input);
  const report = await adapter(client).getTeamMemberCapacity({
    ...input,
    date_from: period.date_from,
    date_to: period.date_to,
  });
  return nextReportResult(
    input.location_id,
    period,
    report,
    `Capacity for ${report.rows.length} team member(s): ${report.totals.booked_hours ?? 'n/a'} booked hours of ${report.totals.scheduled_hours ?? 'n/a'} scheduled hours; occupancy ${report.totals.occupancy_percent ?? 'n/a'}%.`
  );
}
export async function getClientReactivationCandidates(
  client: AltegioClient,
  input: ClientReactivationInput
): Promise<LegacyAnalyticsResult> {
  const period = await periodFor(client, input.location_id, input);
  const includeContacts = input.include_contacts === true;
  const report = await adapter(client).getClientReactivationCandidates({
    ...input,
    date_from: period.date_from,
    date_to: period.date_to,
    page: input.page ?? 1,
    page_size: input.page_size ?? 25,
    include_contacts: includeContacts,
  });
  return nextReportResult(
    input.location_id,
    period,
    report,
    `${report.page.total_count} reactivation candidate(s); showing ${report.page.returned}. Paid amounts are lifetime values. Client ids are unavailable; visit descriptions do not identify individual services or team members.${report.page.has_more ? ' Request the next page for more.' : ''}${includeContacts ? ' Source contacts may be masked.' : ` ${CONTACTS_WITHHELD_NOTICE}`}`,
    {
      loyalty_program_id: input.loyalty_program_id,
      contacts_included: includeContacts,
      client_identity_status: 'unavailable_from_legacy_export',
    }
  );
}
export async function getGroupEventPerformance(
  client: AltegioClient,
  input: GroupEventPerformanceInput
): Promise<LegacyAnalyticsResult> {
  const period = await periodFor(client, input.location_id, input);
  const report = await adapter(client).getGroupEventPerformance({
    ...input,
    date_from: period.date_from,
    date_to: period.date_to,
    page: input.page ?? 1,
    page_size: input.page_size ?? 25,
  });
  return nextReportResult(
    input.location_id,
    period,
    report,
    `${report.page.total_count} group event(s); showing ${report.page.returned}. Amounts are appointment value, not collected revenue. Dates retain the source display format; service ids are unavailable.${report.page.has_more ? ' Request the next page for more.' : ''}`
  );
}
export async function getProductSales(
  client: AltegioClient,
  input: ProductSalesInput
): Promise<LegacyAnalyticsResult> {
  const period = await periodFor(client, input.location_id, input);
  const report = await adapter(client).getProductSales({
    ...input,
    date_from: period.date_from,
    date_to: period.date_to,
    page: input.page ?? 1,
    page_size: input.page_size ?? 25,
    group_by: input.group_by ?? 'product',
  });
  return nextReportResult(
    input.location_id,
    period,
    report,
    `${report.page.total_count} product sales row(s); showing ${report.page.returned}. Total revenue ${report.totals.revenue ?? 'n/a'} ${report.currency ?? ''} includes client-account payments. Cost is total cost of sold quantity. Category costs are withheld; hierarchical category rows must not be summed.${report.page.has_more ? ' Request the next page for more.' : ''}`
  );
}
export async function getCashFlowBreakdown(
  client: AltegioClient,
  input: CashFlowBreakdownInput
): Promise<LegacyAnalyticsResult> {
  const period = await periodFor(client, input.location_id, input);
  const report = await adapter(client).getCashFlowBreakdown({
    ...input,
    date_from: period.date_from,
    date_to: period.date_to,
  });
  return nextReportResult(
    input.location_id,
    period,
    report,
    `Cash flow: inflow ${report.totals.inflow ?? 'n/a'}, signed outflow ${report.totals.outflow ?? 'n/a'}, net movement ${report.totals.net_movement ?? 'n/a'} ${report.currency ?? ''}. Net movement is not an opening or closing account balance. Amount arrays correspond to columns; account and account-type breakdowns overlap and must not be added together.`,
    {
      filters_applied: {
        cash_account_ids: input.cash_account_ids ?? [],
        team_member_id: input.team_member_id ?? null,
        supplier_id: input.supplier_id ?? null,
        payment_item_id: input.payment_item_id ?? null,
        cash_account_type: input.cash_account_type ?? 'all',
        service_ids: input.service_ids ?? [],
        product_ids: input.product_ids ?? [],
        service_category_ids: input.service_category_ids ?? [],
        product_category_ids: input.product_category_ids ?? [],
        include_zero_movement_rows: input.include_zero_movement_rows !== false,
      },
    }
  );
}
