/**
 * Temporary adapter over authenticated ERP web reports.
 *
 * Legacy route and parameter names live only in this file. The transport is
 * stateless: each call injects the current request's user credential through
 * `AltegioClient.requestLegacyWebReport`; no cookies or browser session cross
 * owners.
 */
import type { AltegioClient } from '../../providers/altegio-client.js';
import { AltegioApiError } from '../../utils/errors.js';
import type {
  LegacyPeriodRequest,
  ClientReactivationRequest,
  GroupEventPerformanceRequest,
  ProductSalesRequest,
  CashFlowBreakdownRequest,
  ClientForecastReport,
  ClientRetentionReport,
  ClientSalesReport,
  LegacyTeamMemberIdentity,
  ServiceProfitabilityGroup,
  ServiceProfitabilityReport,
  TeamMemberSalesReport,
} from '../legacy-analytics-api.js';
import {
  parseTeamMemberCapacityHtml,
  parseClientReactivationWorkbook,
  parseGroupEventPerformanceHtml,
  parseProductSalesHtml,
  parseCashFlowBreakdownHtml,
  parseClientForecastWorkbook,
  parseClientRetentionHtml,
  parseClientSalesHtml,
  parseSearchEnvelope,
  parseServiceProfitabilityHtml,
  parseTeamMemberSalesHtml,
} from './legacy-analytics-parser.js';

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_WORKBOOK_BYTES = 12 * 1024 * 1024;

function canonicalCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

function contentLength(response: Response): number | null {
  const raw = response.headers.get('content-length');
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function assertWithinDeclaredLimit(
  response: Response,
  limit: number,
  report: string
): void {
  const length = contentLength(response);
  if (length !== null && length > limit) {
    throw new AltegioApiError(
      `The temporary ${report} report is too large to process safely. Narrow the filters or request a smaller page.`,
      413
    );
  }
}

async function readBounded(
  response: Response,
  limit: number,
  report: string
): Promise<Uint8Array> {
  assertWithinDeclaredLimit(response, limit, report);
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new AltegioApiError(
          `The temporary ${report} report is too large to process safely. Narrow the filters or request a smaller page.`,
          413
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AltegioApiError) throw error;
    // A native stream error can carry implementation diagnostics. Keep the
    // transport URL (and its credential query) outside the surfaced error.
    throw new AltegioApiError(
      `The temporary ${report} report response could not be read safely. Retry later.`,
      502
    );
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function assertAuthenticatedBody(body: string): void {
  if (body.trim() === 'Need Auth') {
    throw new AltegioApiError(
      'The delegated Altegio authentication was not accepted by the legacy analytics report. Refresh it and retry.',
      401
    );
  }
}

async function readSearchEnvelope(
  response: Response,
  report: string,
  permissionErrorEnvelope = false
): Promise<{ html: string; count: number }> {
  if (response.headers.get('need_auth') === '1')
    assertAuthenticatedBody('Need Auth');
  const body = new TextDecoder().decode(
    await readBounded(response, MAX_HTML_BYTES, report)
  );
  assertAuthenticatedBody(body);
  if (permissionErrorEnvelope) {
    let envelope: unknown;
    try {
      envelope = JSON.parse(body);
    } catch {
      /* The structural parser reports malformed JSON below. */
    }
    if (
      envelope &&
      typeof envelope === 'object' &&
      !('success' in envelope) &&
      'error' in envelope &&
      typeof envelope.error === 'string'
    ) {
      throw new AltegioApiError(
        'Access to this analytics report is denied for the current Altegio user. Ask a location owner to grant the finance period-report permission.',
        403
      );
    }
  }
  return parseSearchEnvelope(body, report);
}

async function readWorkbook(
  response: Response,
  report = 'client forecast'
): Promise<Uint8Array> {
  if (response.headers.get('need_auth') === '1')
    assertAuthenticatedBody('Need Auth');
  const bytes = await readBounded(response, MAX_WORKBOOK_BYTES, report);
  const preview = new TextDecoder().decode(bytes.subarray(0, 128)).trim();
  assertAuthenticatedBody(preview);
  return bytes;
}

export class V1LegacyAnalyticsAdapter {
  constructor(private readonly client: AltegioClient) {}

  private async currency(locationId: number): Promise<string | null> {
    const location = await this.client.getLocation(locationId, { my: 1 });
    return canonicalCurrency(
      location.currency_short_title ?? location.currency ?? null
    );
  }

  private async teamMembers(
    locationId: number
  ): Promise<LegacyTeamMemberIdentity[]> {
    const rows = await this.client.getStaff(locationId);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      position_title: row.specialization ?? row.position?.title ?? null,
    }));
  }

  async getClientSales(input: {
    location_id: number;
    date_from: string;
    date_to: string;
    page: number;
    page_size: number;
    include_contacts: boolean;
  }): Promise<ClientSalesReport> {
    const [response, currency] = await Promise.all([
      this.client.requestLegacyWebReport({
        locationId: input.location_id,
        path: `/analytics_clients/clients_search/${input.location_id}/`,
        query: {
          start_date: input.date_from,
          end_date: input.date_to,
          page: input.page,
          editable_length: input.page_size,
        },
      }),
      this.currency(input.location_id),
    ]);
    const envelope = await readSearchEnvelope(response, 'client sales');
    return parseClientSalesHtml({
      ...envelope,
      page: input.page,
      pageSize: input.page_size,
      currency,
      includeContacts: input.include_contacts,
    });
  }

  async getClientRetention(input: {
    location_id: number;
    date_from: string;
    date_to: string;
    service_id?: number;
  }): Promise<ClientRetentionReport> {
    const [response, teamMembers] = await Promise.all([
      this.client.requestLegacyWebReport({
        locationId: input.location_id,
        path: `/analytics_retention/retention_search/${input.location_id}/`,
        query: {
          start_date: input.date_from,
          end_date: input.date_to,
          service_id: input.service_id ?? 0,
        },
      }),
      this.teamMembers(input.location_id),
    ]);
    const envelope = await readSearchEnvelope(response, 'client retention');
    return parseClientRetentionHtml({ ...envelope, teamMembers });
  }

  async getClientForecast(input: {
    location_id: number;
    prediction_date?: string;
    page: number;
    page_size: number;
    include_contacts: boolean;
  }): Promise<ClientForecastReport> {
    const [response, currency] = await Promise.all([
      this.client.requestLegacyWebReport({
        locationId: input.location_id,
        path: `/analytics/rfm/${input.location_id}/excel/clients`,
        query: { prediction_date: input.prediction_date },
      }),
      this.currency(input.location_id),
    ]);
    const bytes = await readWorkbook(response);
    return parseClientForecastWorkbook({
      bytes,
      currency,
      predictionDate: input.prediction_date ?? null,
      page: input.page,
      pageSize: input.page_size,
      includeContacts: input.include_contacts,
    });
  }

  async getServiceProfitability(input: {
    location_id: number;
    date_from: string;
    date_to: string;
    page: number;
    page_size: number;
    group_by: ServiceProfitabilityGroup;
    team_member_id?: number;
    service_category_id?: number;
  }): Promise<ServiceProfitabilityReport> {
    const [response, currency] = await Promise.all([
      this.client.requestLegacyWebReport({
        locationId: input.location_id,
        path: `/analytics_services/services_search/${input.location_id}/`,
        query: {
          start_date: input.date_from,
          end_date: input.date_to,
          page: input.page,
          editable_length: input.page_size,
          master_id: input.team_member_id ?? 0,
          category_id: input.service_category_id ?? 0,
          detailing: input.group_by === 'service_category' ? 1 : 0,
        },
      }),
      this.currency(input.location_id),
    ]);
    const envelope = await readSearchEnvelope(
      response,
      'service profitability'
    );
    return parseServiceProfitabilityHtml({
      ...envelope,
      page: input.page,
      pageSize: input.page_size,
      currency,
      groupBy: input.group_by,
    });
  }

  async getTeamMemberSales(input: {
    location_id: number;
    date_from: string;
    date_to: string;
    service_ids?: number[];
    service_category_ids?: number[];
    product_ids?: number[];
    product_category_ids?: number[];
    position_ids?: number[];
  }): Promise<TeamMemberSalesReport> {
    const [response, currency, teamMembers] = await Promise.all([
      this.client.requestLegacyWebReport({
        locationId: input.location_id,
        path: `/analytics_masters/masters_search/${input.location_id}/`,
        query: {
          start_date: input.date_from,
          end_date: input.date_to,
          'services_ids[]': input.service_ids,
          'groups_ids[]': input.service_category_ids,
          'goods_ids[]': input.product_ids,
          'goods_categories_ids[]': input.product_category_ids,
          'position_ids[]': input.position_ids,
        },
      }),
      this.currency(input.location_id),
      this.teamMembers(input.location_id),
    ]);
    const envelope = await readSearchEnvelope(response, 'team-member sales');
    return parseTeamMemberSalesHtml({
      ...envelope,
      currency,
      teamMembers,
    });
  }

  async getTeamMemberCapacity(input: LegacyPeriodRequest) {
    const response = await this.client.requestLegacyWebReport({
      locationId: input.location_id,
      path: `/analytics_workload/workload_search/${input.location_id}/`,
      query: { start_date: input.date_from, end_date: input.date_to },
    });
    return parseTeamMemberCapacityHtml(
      await readSearchEnvelope(response, 'team-member capacity')
    );
  }

  async getClientReactivationCandidates(input: ClientReactivationRequest) {
    const [response, currency] = await Promise.all([
      this.client.requestLegacyWebReport({
        locationId: input.location_id,
        path: `/analytics/loyalty_programs/${input.location_id}/excel/lost_clients`,
        query: {
          loyalty_program_id: input.loyalty_program_id,
          date_from: input.date_from,
          date_to: input.date_to,
        },
      }),
      this.currency(input.location_id),
    ]);
    return parseClientReactivationWorkbook({
      bytes: await readWorkbook(response, 'client reactivation'),
      currency,
      page: input.page,
      pageSize: input.page_size,
      includeContacts: input.include_contacts,
    });
  }

  async getGroupEventPerformance(input: GroupEventPerformanceRequest) {
    const [response, currency, teamMembers] = await Promise.all([
      this.client.requestLegacyWebReport({
        locationId: input.location_id,
        path: `/dashboard/activities/${input.location_id}/search`,
        query: {
          start_date: input.date_from,
          end_date: input.date_to,
          page: input.page,
          editable_length: input.page_size,
          master: input.team_member_id ?? 0,
          service: input.service_id ?? 0,
          service_category: input.service_category_id ?? 0,
          category: input.label_id ?? 0,
          removed:
            input.status === 'deleted' ? 1 : input.status === 'active' ? 2 : 0,
        },
      }),
      this.currency(input.location_id),
      this.teamMembers(input.location_id),
    ]);
    return parseGroupEventPerformanceHtml({
      ...(await readSearchEnvelope(response, 'group-event performance')),
      currency,
      teamMembers,
      page: input.page,
      pageSize: input.page_size,
    });
  }

  async getProductSales(input: ProductSalesRequest) {
    const [response, currency] = await Promise.all([
      this.client.requestLegacyWebReport({
        locationId: input.location_id,
        path: `/storages/sales_analysis/${input.group_by === 'product_category' ? 'categories_search' : 'search'}/${input.location_id}/`,
        query: {
          start_date: input.date_from,
          end_date: input.date_to,
          page: input.page,
          editable_length: input.page_size,
          category_id: input.product_category_id ?? 0,
          employee_id: input.team_member_id ?? 0,
          supplier_id: input.supplier_id ?? -1,
        },
      }),
      this.currency(input.location_id),
    ]);
    return parseProductSalesHtml({
      ...(await readSearchEnvelope(response, 'product sales')),
      currency,
      groupBy: input.group_by,
      page: input.page,
      pageSize: input.page_size,
    });
  }

  async getCashFlowBreakdown(input: CashFlowBreakdownRequest) {
    const [response, currency] = await Promise.all([
      this.client.requestLegacyWebReport({
        locationId: input.location_id,
        path: `/finances_reports/account_period_search/${input.location_id}/`,
        query: {
          start_date: input.date_from,
          end_date: input.date_to,
          'accounts_ids[]': input.cash_account_ids,
          master_id: input.team_member_id ?? 0,
          supplier_id: input.supplier_id ?? 0,
          type: input.transaction_type ?? 0,
          account_type:
            input.cash_account_type === 'cash'
              ? 0
              : input.cash_account_type === 'cashless'
                ? 1
                : 2,
          'services_ids[]': input.service_ids,
          'goods_ids[]': input.product_ids,
          'groups_ids[]': input.service_category_ids,
          'goods_categories_ids[]': input.product_category_ids,
          // The source false filter checks only cash totals and drops nonzero
          // cashless items. Read all permitted rows, then filter canonical amounts.
          movements_funds: 1,
        },
      }),
      this.currency(input.location_id),
    ]);
    const report = parseCashFlowBreakdownHtml({
      ...(await readSearchEnvelope(response, 'cash-flow breakdown', true)),
      currency,
      accountType: input.cash_account_type ?? 'all',
      ...(input.transaction_type
        ? { paymentItemId: input.transaction_type }
        : {}),
    });
    if (input.include_zero_movement_rows === false) {
      report.rows = report.rows.filter(
        (row) =>
          row.kind !== 'payment_item' ||
          row.total !== 0 ||
          row.amounts.some((value) => value !== 0)
      );
    }
    return report;
  }
}
