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
  ClientForecastReport,
  ClientRetentionReport,
  ClientSalesReport,
  LegacyTeamMemberIdentity,
  ServiceProfitabilityGroup,
  ServiceProfitabilityReport,
  TeamMemberSalesReport,
} from '../legacy-analytics-api.js';
import {
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
  report: string
): Promise<{ html: string; count: number }> {
  if (response.headers.get('need_auth') === '1')
    assertAuthenticatedBody('Need Auth');
  const body = new TextDecoder().decode(
    await readBounded(response, MAX_HTML_BYTES, report)
  );
  assertAuthenticatedBody(body);
  return parseSearchEnvelope(body, report);
}

async function readWorkbook(response: Response): Promise<Uint8Array> {
  if (response.headers.get('need_auth') === '1')
    assertAuthenticatedBody('Need Auth');
  const bytes = await readBounded(
    response,
    MAX_WORKBOOK_BYTES,
    'client forecast'
  );
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
}
