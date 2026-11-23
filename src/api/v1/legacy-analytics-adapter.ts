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
import {
  parseCashReceiptsHtml,
  type PostedIncomeMonth,
} from './cash-receipts-parser.js';
import {
  parseFinanceTransactionListPage,
  type FinanceTransactionListPage,
} from './finance-transactions-parser.js';
import { isValidTimezone } from '../../capabilities/analytics/periods.js';
import {
  addDays,
  appendDays,
  buildCashFlowReport,
  chunkToDays,
  daysBetween,
  type CashFlowDayRow,
  type CashFlowDays,
} from '../../capabilities/analytics/cash-flow.js';
import { resolveLocationCurrency } from './location-currency.js';
import type {
  LegacyPeriodRequest,
  GroupEventPerformanceRequest,
  ProductSalesRequest,
  CashAccountType,
  CashFlowBreakdownReport,
  CashFlowBreakdownRequest,
  ClientForecastReport,
  ClientRetentionReport,
  ClientSalesReport,
  LegacyTeamMemberIdentity,
  ServiceProfitabilityGroup,
  ServiceProfitabilityReport,
  TeamMemberSalesReport,
  ProfitAndLossReport,
  InventoryTurnoverReport,
} from '../legacy-analytics-api.js';
import {
  parseTeamMemberCapacityHtml,
  parseGroupEventPerformanceHtml,
  parseProductSalesHtml,
  parseCashFlowBreakdownHtml,
  parseClientForecastWorkbook,
  parseClientRetentionHtml,
  parseClientSalesHtml,
  parseSearchEnvelope,
  parseServiceProfitabilityHtml,
  parseTeamMemberSalesHtml,
  parseProfitAndLossHtml,
  parseInventoryTurnoverHtml,
  legacyEnvelopeDenial,
  LegacyAnalyticsParseError,
} from './legacy-analytics-parser.js';

/**
 * Days one cash-flow source page covers. Across all account types the page
 * has a column per day for each type and each cash account, so it is read a
 * month at a time; one account type is a column per day.
 */
const CASH_FLOW_CHUNK_DAYS: Record<CashAccountType, number> = {
  all: 31,
  cash: 92,
  non_cash: 92,
};
/** Source pages one cash-flow answer may read, halved chunks included. */
const MAX_CASH_FLOW_PAGES = 24;
/** Source pages read at once for one answer. */
const CASH_FLOW_CONCURRENCY = 2;

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_WORKBOOK_BYTES = 12 * 1024 * 1024;
/**
 * Bytes of a full ERP page streamed while looking for its report table. The
 * page layout inlines the whole front-end translation bundle ahead of the
 * table, several megabytes at any period, so the page is scanned and dropped
 * as it arrives; only the table (at most `MAX_HTML_BYTES`) is kept.
 */
const MAX_PAGE_BYTES = 48 * 1024 * 1024;
/** Leading characters kept to recognize a refusal instead of a page. */
const PAGE_HEAD_CHARS = 64 * 1024;

export interface ProductUnitStock {
  product_id: number;
  /** Consumable (write-off) units in one sale unit; null when unknown. */
  consumable_units_per_sale_unit: number | null;
  /** Current stock in sale units per inventory; null when not returned. */
  stock_by_inventory: Array<{ inventory_id: number; amount: number }> | null;
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

const AUTHENTICATION_REJECTED =
  'The delegated Altegio authentication was not accepted by the legacy analytics report. Refresh it and retry.';

function assertAuthenticatedBody(body: string): void {
  if (body.trim() === 'Need Auth') {
    throw new AltegioApiError(AUTHENTICATION_REJECTED, 401);
  }
}

/** Surface the ERP's `success:false` 401/403 envelope as an access error. */
function assertPermittedEnvelope(envelope: unknown, report: string): void {
  const denial = legacyEnvelopeDenial(envelope);
  if (denial === 401) throw new AltegioApiError(AUTHENTICATION_REJECTED, 401);
  if (denial === 403) {
    throw new AltegioApiError(
      `Access to the ${report} report is denied for the current Altegio user. Ask a location owner to grant the required analytics permission.`,
      403
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
  let envelope: unknown;
  try {
    envelope = JSON.parse(body);
  } catch {
    /* The structural parser reports malformed JSON below. */
  }
  assertPermittedEnvelope(envelope, report);
  if (permissionErrorEnvelope) {
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

const TABLE_OPEN = /<table\b[^>]*\btable-report\b[^>]*>/i;

/**
 * Index just past the `</table>` closing the table that opens at `0`, or -1
 * while it is still open. Nested tables are balanced, not cut at the first
 * closing tag.
 */
function tableEnd(section: string): number {
  const tags = /<(\/?)table\b/gi;
  let depth = 0;
  for (let match = tags.exec(section); match; match = tags.exec(section)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) {
      const close = section.indexOf('>', match.index);
      return close === -1 ? -1 : close + 1;
    }
  }
  return -1;
}

/**
 * Stream a full ERP page and keep only its first `table-report` table.
 *
 * The authenticated finance page renders the report table after a layout
 * that inlines the front-end translation bundle, so the page as a whole is
 * larger than `MAX_HTML_BYTES` for any period (prod, 2026-11: every P&L and
 * cash-receipts call refused as too large, a single day included). Holding
 * the page would fail every caller; this bounds memory by the table instead:
 * at most `MAX_PAGE_BYTES` are scanned and dropped as they arrive, the table
 * is held up to `MAX_HTML_BYTES`, and the rest of the page is not read. A body
 * without the table (an access refusal envelope, a sign-in answer, a changed
 * page) comes back as its first characters, for the caller's refusal checks
 * and the parser's structural error.
 */
async function readReportTable(
  response: Response,
  report: string
): Promise<string> {
  if (response.headers.get('need_auth') === '1')
    assertAuthenticatedBody('Need Auth');
  if (!response.body) return '';
  const tooLarge = () =>
    new AltegioApiError(
      `The temporary ${report} report is too large to process safely. Narrow the filters or request a smaller page.`,
      413
    );
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let head = '';
  let pending = '';
  let section: string | null = null;
  let scanned = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      const text = done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      if (!done) scanned += value.byteLength;
      if (head.length < PAGE_HEAD_CHARS)
        head += text.slice(0, PAGE_HEAD_CHARS - head.length);
      if (section === null) {
        pending += text;
        const open = TABLE_OPEN.exec(pending);
        if (open) {
          section = pending.slice(open.index);
          pending = '';
        } else {
          // Keep enough of the tail for an opening tag split across chunks.
          pending = pending.slice(-1024);
        }
      } else {
        section += text;
      }
      if (section !== null) {
        const end = tableEnd(section);
        if (end !== -1) {
          await reader.cancel().catch(() => undefined);
          return section.slice(0, end);
        }
        if (Buffer.byteLength(section) > MAX_HTML_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw tooLarge();
        }
      }
      if (done) break;
      if (scanned > MAX_PAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
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
  // No complete table: return the start of the body for refusal checks; an
  // unterminated table is a changed page, which the parser reports.
  return head;
}

/** A full ERP report page reduced to its report table (`readReportTable`). */
async function readReportPage(
  response: Response,
  report: string
): Promise<string> {
  const body = await readReportTable(response, report);
  assertAuthenticatedBody(body);
  // A refused HTML report comes back as the same HTTP 200 JSON envelope as a
  // refused search report (`{success: false, meta: {status_code: 403}}`), not
  // as HTML. Without this check the page parser reports a changed ERP markup
  // for what is a missing access right.
  if (body.trimStart().startsWith('{')) {
    let envelope: unknown;
    try {
      envelope = JSON.parse(body);
    } catch {
      /* Not an envelope; the page parser reports the structure. */
    }
    assertPermittedEnvelope(envelope, report);
  }
  return body;
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
  if (response.headers.get('content-type')?.includes('application/json')) {
    let envelope: unknown;
    try {
      envelope = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new AltegioApiError(
        `The temporary ${report} report returned malformed JSON instead of a workbook.`,
        502
      );
    }
    assertPermittedEnvelope(envelope, report);
    throw new AltegioApiError(
      `The temporary ${report} report rejected the export request.`,
      502
    );
  }
  return bytes;
}

export class V1LegacyAnalyticsAdapter {
  constructor(private readonly client: AltegioClient) {}

  private async currency(locationId: number): Promise<string | null> {
    return resolveLocationCurrency(this.client, locationId);
  }

  /** Posted income by local calendar month, using the same ledger as P&L. */
  async getPostedIncomeMonths(input: {
    location_id: number;
    date_from: string;
    date_to: string;
  }): Promise<{
    currency: string | null;
    timezone: string | null;
    months: PostedIncomeMonth[];
  }> {
    const [response, location, currency] = await Promise.all([
      this.client.requestLegacyWebReport({
        locationId: input.location_id,
        path: `/finances_reports/annual_report/${input.location_id}/`,
        query: { date_from: input.date_from, date_to: input.date_to },
      }),
      this.client.getLocation(input.location_id, { my: 1 }),
      this.currency(input.location_id),
    ]);
    return {
      currency,
      timezone:
        typeof location.timezone_name === 'string' &&
        isValidTimezone(location.timezone_name)
          ? location.timezone_name
          : null,
      months: parseCashReceiptsHtml(
        await readReportPage(response, 'cash receipts'),
        input.date_from,
        input.date_to
      ),
    };
  }

  /**
   * One page of ordered active finance transaction IDs and their ERP-rendered
   * local dates. Transport only; `finance-transactions-parser.ts` owns the
   * markup contract.
   */
  async getFinanceTransactionIdsPage(input: {
    location_id: number;
    date_from: string;
    date_to: string;
    page: number;
    page_size: number;
    type_id: number;
  }): Promise<FinanceTransactionListPage> {
    const response = await this.client.requestLegacyWebReport({
      locationId: input.location_id,
      path: `/finances/transactions_search/${input.location_id}/`,
      query: {
        start_date: input.date_from,
        end_date: input.date_to,
        page: input.page,
        editable_length: input.page_size,
        type: input.type_id,
      },
    });
    const { html, count } = await readSearchEnvelope(response, 'payer cohorts');
    return parseFinanceTransactionListPage(html, count, input);
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

  async getProfitAndLoss(input: {
    location_id: number;
    date_from: string;
    date_to: string;
  }): Promise<ProfitAndLossReport> {
    const [response, currency] = await Promise.all([
      this.client.requestLegacyWebReport({
        locationId: input.location_id,
        path: `/finances_reports/annual_report/${input.location_id}/`,
        query: { date_from: input.date_from, date_to: input.date_to },
      }),
      this.currency(input.location_id),
    ]);
    return parseProfitAndLossHtml({
      html: await readReportPage(response, 'profit and loss'),
      currency,
    });
  }

  /**
   * A product's consumable units per sale unit and its current stock per
   * inventory, from the product card; `null` when the card cannot be read.
   * The inventory turnover report divides consumable write-offs by that
   * ratio although they are already stored in sale units, so its sales and
   * stock figures for such a product are wrong (see `getInventoryTurnover`).
   */
  async getProductUnitStock(
    locationId: number,
    productId: number
  ): Promise<ProductUnitStock | null> {
    try {
      const response = await this.client.apiRequest(
        `/locations/${locationId}/products/${productId}`
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const payload = (await response.json()) as { data?: unknown };
      const data = payload?.data;
      if (!data || typeof data !== 'object') return null;
      const card = data as {
        unit_equals?: unknown;
        actual_amounts?: unknown;
      };
      const ratio = Number(card.unit_equals);
      const amounts = Array.isArray(card.actual_amounts)
        ? card.actual_amounts.flatMap((item: unknown) => {
            if (!item || typeof item !== 'object') return [];
            const entry = item as { storage_id?: unknown; amount?: unknown };
            const inventory = Number(entry.storage_id);
            const amount = Number(entry.amount);
            return Number.isSafeInteger(inventory) && Number.isFinite(amount)
              ? [{ inventory_id: inventory, amount }]
              : [];
          })
        : null;
      return {
        product_id: productId,
        consumable_units_per_sale_unit:
          Number.isFinite(ratio) && ratio > 0 ? ratio : null,
        stock_by_inventory: amounts,
      };
    } catch (error) {
      // A company outside the declared scope is the caller's error to see.
      if (error instanceof AltegioApiError && error.statusCode === 403)
        throw error;
      return null;
    }
  }

  async getInventoryTurnover(input: {
    location_id: number;
    date_from: string;
    date_to: string;
    page: number;
    page_size: number;
    inventory_id?: number;
    product_category_id?: number;
    supplier_id?: number;
  }): Promise<InventoryTurnoverReport> {
    const response = await this.client.requestLegacyWebReport({
      locationId: input.location_id,
      path: `/storages/turnover/search/${input.location_id}/`,
      query: {
        start_date: input.date_from,
        end_date: input.date_to,
        page: input.page,
        editable_length: input.page_size,
        storage_id: input.inventory_id ?? 0,
        category_id: input.product_category_id ?? 0,
        supplier_id: input.supplier_id ?? 0,
      },
    });
    return parseInventoryTurnoverHtml({
      ...(await readSearchEnvelope(response, 'inventory turnover')),
      page: input.page,
      pageSize: input.page_size,
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

  /** One cash-flow source page, as cents per day; halved while too large. */
  private async cashFlowPage(
    input: CashFlowBreakdownRequest,
    accountType: CashAccountType,
    range: { from: string; to: string },
    reads: { pages: number }
  ): Promise<{ account_titles: string[]; rows: CashFlowDayRow[] }> {
    if (reads.pages >= MAX_CASH_FLOW_PAGES)
      throw new AltegioApiError(
        `The cash-flow breakdown for this period needs more than ${MAX_CASH_FLOW_PAGES} source pages. Narrow it: a shorter period, cash_account_type=cash or non_cash, cash_account_ids, or payment_item_id.`,
        413
      );
    reads.pages += 1;
    const response = await this.client.requestLegacyWebReport({
      locationId: input.location_id,
      path: `/finances_reports/account_period_search/${input.location_id}/`,
      query: {
        start_date: range.from,
        end_date: range.to,
        'accounts_ids[]': input.cash_account_ids,
        master_id: input.team_member_id ?? 0,
        supplier_id: input.supplier_id ?? 0,
        type: input.payment_item_id ?? 0,
        account_type:
          accountType === 'cash' ? 0 : accountType === 'non_cash' ? 1 : 2,
        'services_ids[]': input.service_ids,
        'goods_ids[]': input.product_ids,
        'groups_ids[]': input.service_category_ids,
        'goods_categories_ids[]': input.product_category_ids,
        // The source false filter checks only cash totals and drops nonzero
        // non-cash items. Read all permitted rows, then filter canonical amounts.
        movements_funds: 1,
      },
    });
    let envelope: { html: string; count: number };
    try {
      envelope = await readSearchEnvelope(
        response,
        'cash-flow breakdown',
        true
      );
    } catch (error) {
      // A page over the size bound is read again as two halves; one day that
      // does not fit is refused.
      if (
        !(error instanceof AltegioApiError) ||
        error.statusCode !== 413 ||
        range.from >= range.to
      )
        throw error;
      const middle = addDays(
        range.from,
        Math.floor(daysBetween(range.from, range.to) / 2) - 1
      );
      const first = await this.cashFlowPage(
        input,
        accountType,
        { from: range.from, to: middle },
        reads
      );
      const second = await this.cashFlowPage(
        input,
        accountType,
        { from: addDays(middle, 1), to: range.to },
        reads
      );
      if (!appendDays(first, second))
        throw new LegacyAnalyticsParseError(
          'cash-flow breakdown',
          'rows differ between periods'
        );
      return first;
    }
    const days = chunkToDays(
      parseCashFlowBreakdownHtml({
        ...envelope,
        currency: null,
        accountType,
        ...(input.payment_item_id
          ? { paymentItemId: input.payment_item_id }
          : {}),
      }),
      accountType,
      daysBetween(range.from, range.to)
    );
    if (!days)
      throw new LegacyAnalyticsParseError(
        'cash-flow breakdown',
        'day columns do not match the period'
      );
    return days;
  }

  /**
   * Cash movement per local day for the period, read in bounded pages.
   *
   * The source ends a period at 23:59:00 of its last day, so a payment in the
   * last minute fell out of every window (prod, 2026-10: five weekly reports
   * were 750 UAH short of the month's transactions). Each read runs one day
   * past the period and that day is dropped, so the last day is complete and
   * every total is summed from the days themselves.
   */
  async getCashFlowDays(
    input: CashFlowBreakdownRequest
  ): Promise<CashFlowDays> {
    const accountType = input.cash_account_type ?? 'all';
    const requestedDays = daysBetween(input.date_from, input.date_to);
    const readTo = addDays(input.date_to, 1);
    const chunk = CASH_FLOW_CHUNK_DAYS[accountType];
    const ranges: Array<{ from: string; to: string }> = [];
    for (let from = input.date_from; from <= readTo;) {
      const to = addDays(from, chunk - 1);
      ranges.push({ from, to: to < readTo ? to : readTo });
      from = addDays(to, 1);
    }
    const reads = { pages: 0 };
    const pages: Array<{ account_titles: string[]; rows: CashFlowDayRow[] }> =
      [];
    const currency = this.currency(input.location_id);
    for (let i = 0; i < ranges.length; i += CASH_FLOW_CONCURRENCY) {
      pages.push(
        ...(await Promise.all(
          ranges
            .slice(i, i + CASH_FLOW_CONCURRENCY)
            .map((range) => this.cashFlowPage(input, accountType, range, reads))
        ))
      );
    }
    const merged = pages[0]!;
    for (const page of pages.slice(1))
      if (!appendDays(merged, page))
        throw new LegacyAnalyticsParseError(
          'cash-flow breakdown',
          'rows differ between periods'
        );
    return {
      currency: await currency,
      account_type: accountType,
      days: Array.from({ length: requestedDays }, (_, i) =>
        addDays(input.date_from, i)
      ),
      account_titles: merged.account_titles,
      rows: merged.rows.map((row) => ({
        ...row,
        types: row.types.slice(0, requestedDays),
        accounts: row.accounts.slice(0, requestedDays),
      })),
    };
  }

  async getCashFlowBreakdown(
    input: CashFlowBreakdownRequest
  ): Promise<CashFlowBreakdownReport> {
    return buildCashFlowReport(await this.getCashFlowDays(input), {
      includeZeroMovementRows: input.include_zero_movement_rows !== false,
    });
  }

  /**
   * The posted-transaction ledger for exact local days, for a period that is
   * not whole calendar months.
   *
   * The P&L page rounds every period out to whole months (a day or a week
   * reads the month around it), so a shorter period is summed from the
   * cash-flow report of the same transactions instead, one account type at a
   * time to keep its pages small. That report does not link category ids:
   * categories carry their title only.
   */
  async getPeriodLedger(
    input: LegacyPeriodRequest
  ): Promise<ProfitAndLossReport> {
    const read = (type: 'cash' | 'non_cash') =>
      this.getCashFlowDays({ ...input, cash_account_type: type }).catch(
        (error: unknown) => {
          if (error instanceof AltegioApiError && error.statusCode === 403)
            throw new AltegioApiError(
              'A profit and loss ledger for a period that is not whole calendar months is read from the cash-flow report, which needs the finance period-report permission. Ask for whole months (date_from on the 1st, date_to on a month end), or ask a location owner to grant the permission.',
              403
            );
          throw error;
        }
      );
    const [cash, nonCash] = await Promise.all([read('cash'), read('non_cash')]);
    if (
      cash.rows.length !== nonCash.rows.length ||
      cash.rows.some(
        (row, i) =>
          row.payment_item_title !== nonCash.rows[i]!.payment_item_title ||
          row.kind !== nonCash.rows[i]!.kind
      )
    )
      throw new LegacyAnalyticsParseError(
        'profit and loss',
        'ledger rows differ between account types'
      );
    const total = (row: CashFlowDayRow): number =>
      row.types.reduce((sum, day) => sum + (day[0] ?? 0), 0);
    const totals = cash.rows.map(
      (row, i) => total(row) + total(nonCash.rows[i]!)
    );
    const aggregate = (kind: 'inflow' | 'outflow' | 'net_movement') => {
      const index = cash.rows.findIndex((row) => row.kind === kind);
      return index === -1 ? null : totals[index]!;
    };
    const income = aggregate('inflow');
    const expense = aggregate('outflow');
    const result = aggregate('net_movement');
    if (income === null || expense === null || result === null)
      throw new LegacyAnalyticsParseError(
        'profit and loss',
        'income, expense or result rows not found'
      );
    return {
      currency: cash.currency,
      income_total: income / 100,
      expense_total: Math.abs(expense) / 100,
      tracked_operating_result: result / 100,
      categories: cash.rows.flatMap((row, i) =>
        row.kind !== 'payment_item' || !row.direction || totals[i] === 0
          ? []
          : [
              {
                category_id: null,
                title: row.payment_item_title || null,
                direction:
                  row.direction === 'inflow'
                    ? ('income' as const)
                    : ('expense' as const),
                amount:
                  (row.direction === 'outflow'
                    ? Math.abs(totals[i]!)
                    : totals[i]!) / 100,
              },
            ]
      ),
    };
  }
}

/** Whether a period is whole local calendar months, as the P&L page reads. */
export function isWholeMonths(from: string, to: string): boolean {
  const end = new Date(`${to}T00:00:00Z`);
  const last = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)
  ).getUTCDate();
  return from.endsWith('-01') && end.getUTCDate() === last && from <= to;
}
