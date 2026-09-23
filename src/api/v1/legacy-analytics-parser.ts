/** Structural parsers for the temporary ERP HTML/XLS analytics reports. */
import { load, type CheerioAPI } from 'cheerio';
import * as XLSX from '@e965/xlsx';
import type {
  CashAccountType,
  CashFlowBreakdownReport,
  CashFlowColumn,
  CashFlowRow,
  GroupEventPerformanceReport,
  ProductSalesGroup,
  ProductSalesReport,
  TeamMemberCapacityReport,
  ClientForecastReport,
  ClientForecastRow,
  ClientForecastWindow,
  ClientRetentionReport,
  ClientSalesReport,
  LegacyTeamMemberIdentity,
  PageMeta,
  PaymentBreakdown,
  ServiceProfitabilityGroup,
  ServiceProfitabilityReport,
  TeamMemberSalesReport,
  ProfitAndLossReport,
  InventoryTurnoverReport,
} from '../legacy-analytics-api.js';

const MISSING = /^(?:-|—|–|n\/a|null)?$/i;

export class LegacyAnalyticsParseError extends Error {
  constructor(report: string, detail: string) {
    super(
      `The temporary ${report} report returned an unexpected structure (${detail}). The ERP markup may have changed; retry later or use a neighboring analytics tool.`
    );
    this.name = 'LegacyAnalyticsParseError';
  }
}

function cleanText(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function unitFromQuantity(value: unknown): string | null {
  const text = cleanText(value);
  const unit = text.replace(/[()\d\s.,'+\-\u00a0\u202f]/g, '').trim();
  return unit || null;
}

/** Parse locale-formatted numbers from English, Russian and pt-BR reports. */
export function parseLocaleNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = cleanText(value);
  if (MISSING.test(text)) return null;

  const negative = /^\(.*\)$/.test(text) || /^-/.test(text);
  text = text
    .replace(/[()]/g, '')
    .replace(/[^0-9,.'+-]/g, '')
    .replace(/'/g, '')
    .replace(/^\+/, '');
  if (!/[0-9]/.test(text)) return null;

  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  let decimal: ',' | '.' | null = null;
  if (lastComma >= 0 && lastDot >= 0) {
    decimal = lastComma > lastDot ? ',' : '.';
  } else {
    const separator = lastComma >= 0 ? ',' : lastDot >= 0 ? '.' : null;
    if (separator) {
      const occurrences = text.split(separator).length - 1;
      const fractionLength = text.length - text.lastIndexOf(separator) - 1;
      if (fractionLength > 0 && fractionLength <= 2) decimal = separator;
      else if (occurrences > 1 && fractionLength > 0 && fractionLength !== 3)
        decimal = separator;
    }
  }

  let normalized: string;
  if (decimal) {
    const grouping = decimal === ',' ? /\./g : /,/g;
    normalized = text.replace(grouping, '').replace(decimal, '.');
  } else {
    normalized = text.replace(/[,.]/g, '');
  }
  normalized = normalized.replace(/(?!^)-/g, '');
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return negative && parsed > 0 ? -parsed : parsed;
}

function integer(value: unknown): number | null {
  const parsed = parseLocaleNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function percent(value: unknown): number | null {
  return parseLocaleNumber(cleanText(value).replace(/%/g, ''));
}

function countAndPercent(value: unknown): [number, number | null] {
  const text = cleanText(value);
  const count = integer(text.match(/^-?\d[\d\s.,]*/)?.[0]) ?? 0;
  const pct = text.match(/\(([^)]+)%\)/)?.[1];
  return [count, pct === undefined ? null : parseLocaleNumber(pct)];
}

function paymentBreakdown(cells: string[], offset: number): PaymentBreakdown {
  return {
    discount: parseLocaleNumber(cells[offset]),
    loyalty_points: parseLocaleNumber(cells[offset + 1]),
    memberships: parseLocaleNumber(cells[offset + 2]),
    gift_cards: parseLocaleNumber(cells[offset + 3]),
    client_accounts: parseLocaleNumber(cells[offset + 4]),
  };
}

export interface SearchEnvelope {
  html: string;
  count: number;
}

/**
 * The ERP answers a refused legacy report with HTTP 200 and
 * `{success: false, data: null, meta: {message, status_code}}` — e.g. an
 * application system user without the report right gets
 * `{"message": "Insufficient rights", "status_code": 403}`. Returns the
 * refusal status (401 or 403) so the transport can surface an access error
 * instead of a structural one; `null` for anything else. The message is never
 * read: it is source diagnostics, not a contract.
 */
export function legacyEnvelopeDenial(value: unknown): 401 | 403 | null {
  if (!value || typeof value !== 'object') return null;
  const envelope = value as { success?: unknown; meta?: unknown };
  if (envelope.success !== false) return null;
  if (!envelope.meta || typeof envelope.meta !== 'object') return null;
  const status = Number(
    (envelope.meta as { status_code?: unknown }).status_code
  );
  return status === 401 || status === 403 ? status : null;
}

export function parseSearchEnvelope(
  body: string,
  report: string
): SearchEnvelope {
  if (body.trim() === 'Need Auth') {
    throw new LegacyAnalyticsParseError(report, 'authentication was required');
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new LegacyAnalyticsParseError(
      report,
      'expected a JSON search envelope'
    );
  }
  if (!value || typeof value !== 'object') {
    throw new LegacyAnalyticsParseError(report, 'empty search envelope');
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.success !== true) {
    throw new LegacyAnalyticsParseError(
      report,
      'the report rejected its filters'
    );
  }
  if (typeof envelope.content !== 'string') {
    throw new LegacyAnalyticsParseError(report, 'missing HTML content');
  }
  const count = integer(envelope.count);
  if (count === null || count < 0) {
    throw new LegacyAnalyticsParseError(report, 'invalid result count');
  }
  return { html: envelope.content, count };
}

/**
 * Parse the authenticated ERP P&L page. Category direction is structural:
 * the backend emits the income aggregate, then income categories, then the
 * expense aggregate and its categories. Position/person breakdown rows are
 * excluded because they are children of compensation and would double count.
 */
export function parseProfitAndLossHtml(args: {
  html: string;
  currency: string | null;
}): ProfitAndLossReport {
  const $ = load(args.html);
  const rows = $('table.table-report tbody tr').toArray();
  let direction: 'income' | 'expense' | null = null;
  let incomeTotal: number | null = null;
  let expenseTotal: number | null = null;
  let trackedResult: number | null = null;
  const categories: ProfitAndLossReport['categories'] = [];
  let aggregateIndex = 0;

  for (const row of rows) {
    const $row = $(row);
    const values = cells($, row);
    if (values.length < 2) continue;
    const amount = parseLocaleNumber(values.at(-1));
    if ($row.hasClass('row-aggregated')) {
      aggregateIndex += 1;
      if (aggregateIndex === 1) {
        direction = 'income';
        incomeTotal = amount;
      } else if (aggregateIndex === 2) {
        direction = 'expense';
        expenseTotal = amount === null ? null : Math.abs(amount);
      } else if (aggregateIndex === 3) {
        trackedResult = amount;
      }
      continue;
    }
    if ($row.hasClass('row-position') || $row.hasClass('row-master')) continue;
    if (!direction || aggregateIndex > 2) continue;
    const href = $row.find('a[href*="type="]').first().attr('href') ?? '';
    const categoryId = integer(href.match(/[?&]type=(\d+)/)?.[1]);
    if (categoryId === null) continue;
    categories.push({
      category_id: categoryId,
      title: cleanText(values[0]) || null,
      direction,
      amount:
        amount === null
          ? null
          : direction === 'expense'
            ? Math.abs(amount)
            : amount,
    });
  }

  if (aggregateIndex < 3) {
    throw new LegacyAnalyticsParseError(
      'profit and loss',
      'income, expense or result rows not found'
    );
  }
  return {
    currency: args.currency,
    income_total: incomeTotal,
    expense_total: expenseTotal,
    tracked_operating_result: trackedResult,
    categories,
  };
}

export function parseInventoryTurnoverHtml(args: {
  html: string;
  count: number;
  page: number;
  pageSize: number;
}): InventoryTurnoverReport {
  const $ = load(args.html);
  const rows = $('a.table-turnover__good-link')
    .map((_index, link) => {
      const row = $(link).closest('tr');
      const values = cells($, row);
      const productId = integer($(link).attr('data-id'));
      if (!productId || productId <= 0 || values.length < 10) {
        throw new LegacyAnalyticsParseError(
          'inventory turnover',
          'partial product row'
        );
      }
      return {
        product_id: productId,
        product_title: cleanText($(link).text()) || null,
        supplier_title: values[1] || null,
        unit: unitFromQuantity(values[4]),
        units_received: parseLocaleNumber(values[2]),
        opening_stock: parseLocaleNumber(values[3]),
        current_stock: parseLocaleNumber(values[4]),
        units_sold: parseLocaleNumber(values[5]),
        average_stock: parseLocaleNumber(values[6]),
        source_turnover_days: parseLocaleNumber(values[7]),
        source_turnover_count: parseLocaleNumber(values[8]),
        source_stock_level_days: parseLocaleNumber(values[9]),
      };
    })
    .get();
  if (args.count > 0 && rows.length === 0) {
    throw new LegacyAnalyticsParseError(
      'inventory turnover',
      'product rows not found'
    );
  }
  return {
    rows,
    page: pageMeta(args.page, args.pageSize, args.count, rows.length),
  };
}

function cells($: CheerioAPI, row: unknown): string[] {
  return $(row as never)
    .children('th,td')
    .map((_index, cell) => cleanText($(cell).text()))
    .get();
}

function pageMeta(
  page: number,
  pageSize: number,
  total: number,
  returned: number
): PageMeta {
  return {
    page,
    page_size: pageSize,
    total_count: total,
    returned,
    has_more: page * pageSize < total,
  };
}

export function parseClientSalesHtml(args: {
  html: string;
  count: number;
  page: number;
  pageSize: number;
  currency: string | null;
  includeContacts: boolean;
}): ClientSalesReport {
  const $ = load(args.html);
  const rows = $('tr.analytics-client-row')
    .map((_index, row) => {
      const values = cells($, row);
      const id = integer($(row).find('a[client_id]').attr('client_id'));
      if (values.length < 7 || !id || id <= 0) {
        throw new LegacyAnalyticsParseError(
          'client sales',
          'partial client row'
        );
      }
      return {
        client_id: id,
        client_name: cleanText($(row).find('a[client_id]').text()) || null,
        revenue: parseLocaleNumber(values[3]),
        revenue_share_percent: percent(values[4]),
        average_check: parseLocaleNumber(values[5]),
        visits_count: integer(values[6]),
        ...(args.includeContacts
          ? { phone: values[1] || null, email: values[2] || null }
          : {}),
      };
    })
    .get();
  if (args.count > 0 && rows.length === 0) {
    throw new LegacyAnalyticsParseError(
      'client sales',
      'client rows not found'
    );
  }
  const totalRow = $('tbody tr')
    .filter((_index, row) => $(row).children('th').length > 0)
    .first();
  const totalValues = totalRow.length ? cells($, totalRow) : [];
  if (args.count > 0 && totalValues.length < 4) {
    throw new LegacyAnalyticsParseError('client sales', 'totals row not found');
  }
  return {
    currency: args.currency,
    rows,
    totals: { revenue: parseLocaleNumber(totalValues[3]) },
    page: pageMeta(args.page, args.pageSize, args.count, rows.length),
  };
}

function normalizedIdentity(value: string | null | undefined): string {
  return cleanText(value).normalize('NFKC').toLocaleLowerCase('en-US');
}

function resolveOptionalTeamMember(
  name: string,
  position: string,
  identities: readonly LegacyTeamMemberIdentity[]
): {
  id: number | null;
  status: 'matched' | 'unavailable' | 'ambiguous';
} {
  const expectedName = normalizedIdentity(name);
  if (!expectedName) return { id: null, status: 'unavailable' };
  const expectedPosition = normalizedIdentity(position);
  const named = identities.filter(
    (item) => normalizedIdentity(item.name) === expectedName
  );
  const exact = named.filter(
    (item) => normalizedIdentity(item.position_title) === expectedPosition
  );
  const candidates = expectedPosition ? exact : named;
  if (candidates.length === 1)
    return { id: candidates[0]!.id, status: 'matched' };
  return {
    id: null,
    status: candidates.length > 1 ? 'ambiguous' : 'unavailable',
  };
}

export function parseClientRetentionHtml(args: {
  html: string;
  count: number;
  teamMembers: readonly LegacyTeamMemberIdentity[];
}): ClientRetentionReport {
  const $ = load(args.html);
  const sourceRows = $('tbody tr').filter(
    (_index, row) => $(row).children('td').length > 0
  );
  if (
    args.count > 0 &&
    sourceRows.toArray().some((row) => $(row).children('td').length < 8)
  ) {
    throw new LegacyAnalyticsParseError(
      'client retention',
      'partial team-member row'
    );
  }
  const rows = sourceRows
    .map((_index, row) => {
      const values = cells($, row);
      const name = cleanText($(row).find('td').eq(1).find('b').text());
      const position = cleanText($(row).find('td').eq(1).find('small').text());
      const [newCount, newPercent] = countAndPercent(values[3]);
      const [returningCount, returningPercent] = countAndPercent(values[4]);
      const identity = resolveOptionalTeamMember(
        name,
        position,
        args.teamMembers
      );
      return {
        team_member_id: identity.id,
        team_member_identity_status: identity.status,
        team_member_name: name || null,
        position_title: position || null,
        clients_count: integer(values[2]) ?? 0,
        new_clients_count: newCount,
        new_clients_percent: newPercent,
        returning_clients_count: returningCount,
        returning_clients_percent: returningPercent,
        clients_eligible_for_return_count: integer(values[5]) ?? 0,
        clients_returned_count: integer(values[6]) ?? 0,
        retention_percent: percent(values[7]),
      };
    })
    .get();
  if (args.count > 0 && rows.length === 0) {
    throw new LegacyAnalyticsParseError('client retention', 'rows not found');
  }
  const totalValues = cells($, $('tfoot tr').first());
  if (args.count > 0 && totalValues.length < 8) {
    throw new LegacyAnalyticsParseError(
      'client retention',
      'totals row not found'
    );
  }
  const [newCount, newPercent] = countAndPercent(totalValues[3]);
  const [returningCount, returningPercent] = countAndPercent(totalValues[4]);
  const thresholdText = cleanText(
    $('thead tr')
      .eq(1)
      .children('th')
      .eq(3)
      .clone()
      .children('br')
      .remove()
      .end()
      .text()
  );
  return {
    rows,
    totals: {
      clients_count: integer(totalValues[2]) ?? 0,
      new_clients_count: newCount,
      new_clients_percent: newPercent,
      returning_clients_count: returningCount,
      returning_clients_percent: returningPercent,
      clients_eligible_for_return_count: integer(totalValues[5]) ?? 0,
      clients_returned_count: integer(totalValues[6]) ?? 0,
      retention_percent: percent(totalValues[7]),
    },
    lost_threshold_days: integer(thresholdText.match(/\d+/)?.[0]),
  };
}

function idFromGraphRow($: CheerioAPI, row: unknown): number | null {
  const graph =
    $(row as never)
      .next('tr.graph-row')
      .attr('id') ?? '';
  return integer(graph.match(/^graph-row-(\d+)$/)?.[1]);
}

export function parseServiceProfitabilityHtml(args: {
  html: string;
  count: number;
  page: number;
  pageSize: number;
  currency: string | null;
  groupBy: ServiceProfitabilityGroup;
}): ServiceProfitabilityReport {
  const $ = load(args.html);
  const rows = $('[data-locator="analytics_services_row_service_name"]')
    .map((_index, nameCell) => {
      const row = $(nameCell).parent('tr');
      const values = cells($, row);
      const id = idFromGraphRow($, row.get(0));
      if (values.length < 12 || !id || id <= 0) {
        throw new LegacyAnalyticsParseError(
          'service profitability',
          'partial service row'
        );
      }
      const titleCell = $(nameCell).clone();
      const category = cleanText(titleCell.find('small').text());
      titleCell.find('small,br').remove();
      const title = cleanText(titleCell.text());
      return {
        service_id: args.groupBy === 'service' ? id : null,
        service_category_id: args.groupBy === 'service_category' ? id : null,
        title: title || null,
        service_category_title:
          args.groupBy === 'service' ? category || null : null,
        services_rendered_count: integer(values[1]) ?? 0,
        payments: paymentBreakdown(values, 2),
        cash_or_card_revenue: parseLocaleNumber(values[7]),
        consumables_cost: parseLocaleNumber(values[8]),
        team_member_compensation: parseLocaleNumber(values[9]),
        contribution_result: parseLocaleNumber(values[10]),
        revenue_share_percent: percent(values[11]),
      };
    })
    .get();
  if (args.count > 0 && rows.length === 0) {
    throw new LegacyAnalyticsParseError(
      'service profitability',
      'service rows not found'
    );
  }
  const totalRow = $('tbody tr')
    .filter((_index, row) => $(row).children('th').length >= 10)
    .first();
  const totalValues = totalRow.length ? cells($, totalRow) : [];
  if (args.count > 0 && totalValues.length < 11) {
    throw new LegacyAnalyticsParseError(
      'service profitability',
      'totals row not found'
    );
  }
  return {
    currency: args.currency,
    group_by: args.groupBy,
    rows,
    totals: {
      services_rendered_count: integer(totalValues[1]) ?? 0,
      payments: paymentBreakdown(totalValues, 2),
      cash_or_card_revenue: parseLocaleNumber(totalValues[7]),
      consumables_cost: parseLocaleNumber(totalValues[8]),
      team_member_compensation: parseLocaleNumber(totalValues[9]),
      contribution_result: parseLocaleNumber(totalValues[10]),
    },
    page: pageMeta(args.page, args.pageSize, args.count, rows.length),
  };
}

export function parseTeamMemberSalesHtml(args: {
  html: string;
  count: number;
  currency: string | null;
  teamMembers: readonly LegacyTeamMemberIdentity[];
}): TeamMemberSalesReport {
  const $ = load(args.html);
  const sourceRows = $('tbody tr.white-space-nowrap').filter(
    (_index, row) => $(row).children('td').length > 0
  );
  if (
    args.count > 0 &&
    sourceRows.toArray().some((row) => $(row).children('td').length < 16)
  ) {
    throw new LegacyAnalyticsParseError(
      'team-member sales',
      'partial team-member row'
    );
  }
  const rows = sourceRows
    .map((_index, row) => {
      const values = cells($, row);
      const name = cleanText($(row).find('td').eq(1).find('b').text());
      const position = cleanText($(row).find('td').eq(1).find('small').text());
      const identity = resolveOptionalTeamMember(
        name,
        position,
        args.teamMembers
      );
      return {
        team_member_id: identity.id,
        team_member_identity_status: identity.status,
        team_member_name: name || null,
        position_title: position || null,
        revenue: parseLocaleNumber(values[2]),
        services_revenue: parseLocaleNumber(values[3]),
        services_rendered_count: integer(values[4]),
        products_revenue: parseLocaleNumber(values[5]),
        products_count: integer(values[6]),
        payments: paymentBreakdown(values, 7),
        upcoming_appointments_revenue: parseLocaleNumber(values[12]),
        worked_hours: parseLocaleNumber(values[13]),
        revenue_per_worked_hour: parseLocaleNumber(values[14]),
        revenue_share_percent: percent(values[15]),
      };
    })
    .get();
  if (args.count > 0 && rows.length === 0) {
    throw new LegacyAnalyticsParseError('team-member sales', 'rows not found');
  }
  const totalRow = $('tbody tr.white-space-nowrap')
    .filter((_index, row) => $(row).children('th').length >= 10)
    .first();
  const totalValues = totalRow.length ? cells($, totalRow) : [];
  if (args.count > 0 && totalValues.length < 14) {
    throw new LegacyAnalyticsParseError(
      'team-member sales',
      'totals row not found'
    );
  }
  return {
    currency: args.currency,
    rows,
    totals: {
      revenue: parseLocaleNumber(totalValues[1]),
      services_revenue: parseLocaleNumber(totalValues[2]),
      services_rendered_count: integer(totalValues[3]),
      products_revenue: parseLocaleNumber(totalValues[4]),
      products_count: integer(totalValues[5]),
      payments: paymentBreakdown(totalValues, 6),
      upcoming_appointments_revenue: parseLocaleNumber(totalValues[11]),
      worked_hours: parseLocaleNumber(totalValues[12]),
    },
  };
}

const FORECAST_WINDOWS: ReadonlyArray<
  [ClientForecastWindow, readonly string[]]
> = [
  ['this_month', ['this month', 'в этом месяце', 'este mês', 'este mes']],
  [
    'next_month',
    ['next month', 'в следующем месяце', 'próximo mês', 'proximo mes'],
  ],
  ['not_expected', ['never', 'не ждать', 'nunca']],
  [
    'insufficient_data',
    [
      'insufficient data to display statistics',
      'not enough data',
      'недостаточно данных для отображения статистики',
      'dados insuficientes',
    ],
  ],
];

function forecastWindow(value: unknown): ClientForecastWindow {
  const normalized = normalizedIdentity(cleanText(value));
  for (const [key, labels] of FORECAST_WINDOWS) {
    if (labels.some((label) => normalized === normalizedIdentity(label)))
      return key;
  }
  return 'unknown';
}

function dateValue(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = cleanText(value);
  if (!text) return null;
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const local = text.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/);
  if (!local) return null;
  return `${local[3]}-${local[2]!.padStart(2, '0')}-${local[1]!.padStart(2, '0')}`;
}

export function parseClientForecastWorkbook(args: {
  bytes: Uint8Array;
  currency: string | null;
  predictionDate: string | null;
  page: number;
  pageSize: number;
  includeContacts: boolean;
}): ClientForecastReport {
  const matrix = workbookMatrix(args.bytes, 'client forecast');
  const headerIndex = matrix.findIndex(
    (row) =>
      Array.isArray(row) && row.filter((cell) => cleanText(cell)).length >= 8
  );
  if (headerIndex < 0) {
    throw new LegacyAnalyticsParseError(
      'client forecast',
      'header row not found'
    );
  }
  const sourceRows = matrix
    .slice(headerIndex + 1)
    .filter((row) => Array.isArray(row) && row.some((cell) => cleanText(cell)));
  const parsed: ClientForecastRow[] = sourceRows.map((row) => {
    if (!Array.isArray(row) || row.length < 10) {
      throw new LegacyAnalyticsParseError(
        'client forecast',
        'partial workbook row'
      );
    }
    return {
      client_id: null,
      client_name: cleanText(row[0]) || null,
      average_check: parseLocaleNumber(row[3]),
      predicted_visits_count: integer(row[4]),
      predicted_visit_window: forecastWindow(row[5]),
      predicted_revenue: parseLocaleNumber(row[6]),
      return_visits_count: integer(row[7]),
      last_visit_date: dateValue(row[8]),
      ...(args.includeContacts
        ? {
            phone: cleanText(row[1]) || null,
            email: cleanText(row[2]) || null,
          }
        : {}),
    };
  });
  const start = (args.page - 1) * args.pageSize;
  const rows = parsed.slice(start, start + args.pageSize);
  return {
    currency: args.currency,
    prediction_date: args.predictionDate,
    rows,
    page: pageMeta(args.page, args.pageSize, parsed.length, rows.length),
  };
}

/** Strip decorative pie ratios before reading the displayed percentage. */
export function parseTeamMemberCapacityHtml(args: {
  html: string;
  count: number;
}): TeamMemberCapacityReport {
  const $ = load(args.html);
  const table = $('table.graphics-table');
  if (table.length !== 1)
    throw new LegacyAnalyticsParseError(
      'team-member capacity',
      'table missing'
    );
  table.find('.pie').remove();
  const metrics = (row: unknown) => {
    const v = cells($, row);
    if (v.length !== 9)
      throw new LegacyAnalyticsParseError(
        'team-member capacity',
        'partial row'
      );
    return {
      worked_days: integer(v[2]),
      scheduled_hours: parseLocaleNumber(v[3]),
      booked_hours: parseLocaleNumber(v[4]),
      idle_hours: parseLocaleNumber(v[5]),
      occupancy_percent: percent(v[6]),
      upcoming_appointments_count: integer(v[7]),
    };
  };
  const sourceRows = table
    .find('tbody tr')
    .filter(
      (_i, r) => $(r).children('td').length > 1 && !$(r).hasClass('graph-row')
    );
  const rows = sourceRows.toArray().map((row) => {
    const id = idFromGraphRow($, row);
    if (!id || id <= 0)
      throw new LegacyAnalyticsParseError(
        'team-member capacity',
        'stable id missing'
      );
    return {
      ...metrics(row),
      team_member_id: id,
      team_member_name: cleanText($(row).find('b').text()) || null,
      position_title: cleanText($(row).find('small').text()) || null,
    };
  });
  if (rows.length !== args.count)
    throw new LegacyAnalyticsParseError(
      'team-member capacity',
      'row count mismatch'
    );
  const total = table
    .find('tbody tr')
    .filter((_i, r) => $(r).children('th').length > 0);
  return {
    rows,
    totals:
      total.length === 1
        ? metrics(total)
        : args.count === 0
          ? {
              worked_days: null,
              scheduled_hours: null,
              booked_hours: null,
              idle_hours: null,
              occupancy_percent: null,
              upcoming_appointments_count: null,
            }
          : (() => {
              throw new LegacyAnalyticsParseError(
                'team-member capacity',
                'totals missing'
              );
            })(),
  };
}

export function parseProductSalesHtml(args: {
  html: string;
  count: number;
  page: number;
  pageSize: number;
  currency: string | null;
  groupBy: ProductSalesGroup;
}): ProductSalesReport {
  const $ = load(args.html);
  const table = $('table.table-report');
  const category = args.groupBy === 'product_category';
  const width = table.find('thead tr').first().children('th').length;
  if (table.length !== 1 || (category ? width !== 6 : ![5, 8].includes(width)))
    throw new LegacyAnalyticsParseError('product sales', 'unexpected columns');
  // Category HTML lacks the product route's cost permission gate. Never expose it.
  const showCost = !category && width === 8;
  const sourceRows = table
    .find('tbody tr')
    .filter(
      (_i, r) =>
        $(r).children('td').length > 1 && $(r).children('th').length === 0
    );
  const rows = sourceRows.toArray().map((row) => {
    const v = cells($, row);
    if (v.length !== width)
      throw new LegacyAnalyticsParseError('product sales', 'partial row');
    const link = $(row).find(
      category ? 'a[href]' : 'a.table-sales-analysis__item-link'
    );
    const id = category
      ? integer(
          (link.attr('href') ?? '').match(
            /storages\/goods\/list\/\d+\/(\d+)\/?$/
          )?.[1]
        )
      : integer(link.attr('data-id'));
    if (!id || id <= 0)
      throw new LegacyAnalyticsParseError('product sales', 'stable id missing');
    const quantityCell = v[category ? 1 : 3] ?? '';
    const quantityMatch = quantityCell.match(/^([+-]?[\d\s.,]+)(.*)$/);
    if (!quantityMatch)
      throw new LegacyAnalyticsParseError('product sales', 'quantity missing');
    return {
      product_id: category ? null : id,
      product_category_id: category ? id : null,
      title: cleanText(link.text()) || null,
      sku: category ? null : v[0] || null,
      barcode: category ? null : v[1] || null,
      quantity: parseLocaleNumber(quantityMatch[1]),
      unit: category ? null : cleanText(quantityMatch[2]) || null,
      total_cost: showCost ? parseLocaleNumber(v[4]) : null,
      total_markup: showCost ? parseLocaleNumber(v[5]) : null,
      markup_percent: showCost ? percent(v[6]) : null,
      revenue: parseLocaleNumber(v[width - 1]),
    };
  });
  const totalRows = table
    .find('tbody tr')
    .filter((_i, r) => $(r).children('th').length === 1);
  const v = cells($, totalRows.first());
  if (
    args.count > 0 &&
    (category || (args.page - 1) * args.pageSize < args.count) &&
    (!rows.length ||
      totalRows.length !== 1 ||
      v.length !== (category ? 6 : showCost ? 6 : 3))
  )
    throw new LegacyAnalyticsParseError(
      'product sales',
      'rows or totals missing'
    );
  if (
    rows.length !==
    (category
      ? args.count
      : Math.max(
          0,
          Math.min(args.pageSize, args.count - (args.page - 1) * args.pageSize)
        ))
  )
    throw new LegacyAnalyticsParseError(
      'product sales',
      'category count mismatch'
    );
  const selected = category
    ? rows.slice((args.page - 1) * args.pageSize, args.page * args.pageSize)
    : rows;
  return {
    currency: args.currency,
    group_by: args.groupBy,
    cost_fields_status: showCost ? 'available' : 'withheld',
    rows: selected,
    totals: {
      quantity: parseLocaleNumber(v[1]),
      total_cost: showCost ? parseLocaleNumber(v[2]) : null,
      total_markup: showCost ? parseLocaleNumber(v[3]) : null,
      markup_percent: null,
      revenue: parseLocaleNumber(v.at(-1)),
    },
    page: pageMeta(args.page, args.pageSize, args.count, selected.length),
    pagination_source: category ? 'local' : 'upstream',
  };
}

function workbookMatrix(bytes: Uint8Array, report: string): unknown[][] {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, {
      type: 'array',
      cellDates: true,
      dense: true,
    });
  } catch {
    throw new LegacyAnalyticsParseError(report, 'malformed workbook');
  }
  const firstName = workbook.SheetNames[0];
  const sheet = firstName ? workbook.Sheets[firstName] : undefined;
  if (!sheet) {
    throw new LegacyAnalyticsParseError(report, 'workbook has no sheet');
  }
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });
  return matrix;
}

export function parseGroupEventPerformanceHtml(args: {
  html: string;
  count: number;
  page: number;
  pageSize: number;
  currency: string | null;
  teamMembers: readonly LegacyTeamMemberIdentity[];
}): GroupEventPerformanceReport {
  const $ = load(args.html);
  const table = $('table.activities-table');
  if (
    !table.length &&
    (args.page - 1) * args.pageSize >= args.count &&
    !cleanText(args.html)
  )
    return {
      currency: args.currency,
      rows: [],
      metrics: null,
      page: pageMeta(args.page, args.pageSize, args.count, 0),
    };
  if (table.length !== 1 || table.find('thead th').length !== 11)
    throw new LegacyAnalyticsParseError(
      'group-event performance',
      'table missing or changed'
    );
  const rows = table
    .find('tbody tr')
    .toArray()
    .map((row) => {
      const v = cells($, row);
      const id = integer(
        $(row).find('[data-activity-id]').attr('data-activity-id')
      );
      if (v.length !== 11 || !id || id <= 0)
        throw new LegacyAnalyticsParseError(
          'group-event performance',
          'partial event row'
        );
      const name = cleanText($(row).children('td').eq(1).find('b').text());
      const position = cleanText(
        $(row).children('td').eq(1).find('small').text()
      );
      const creatorCell = $(row).children('td').eq(9).clone();
      const created = cleanText(creatorCell.find('small').text());
      creatorCell.find('small,br').remove();
      const identity = resolveOptionalTeamMember(
        name,
        position,
        args.teamMembers
      );
      return {
        group_event_id: id,
        team_member_id: identity.id,
        team_member_identity_status: identity.status,
        team_member_name: name || null,
        position_title: position || null,
        service_id: null,
        service_title:
          cleanText($(row).find('[data-activity-id]').text()) || null,
        date_display: v[3] || null,
        capacity: integer(v[4]),
        booked_participants: integer(v[5]),
        attended_clients: integer(v[6]),
        fully_paid_clients: integer(v[7]),
        appointment_value: parseLocaleNumber(v[8]),
        creator_display: cleanText(creatorCell.text()) || null,
        created_at_display: created || null,
        duration_minutes: parseLocaleNumber(v[10]),
        is_deleted: $(row).hasClass('danger'),
      };
    });
  if (
    rows.length !==
    Math.max(
      0,
      Math.min(args.pageSize, args.count - (args.page - 1) * args.pageSize)
    )
  )
    throw new LegacyAnalyticsParseError(
      'group-event performance',
      'event row count mismatch'
    );
  const metric = (id: string) => {
    const card = $(`[data-title-id="activity-stat-${id}"]`).closest(
      '.activity-statistic-card'
    );
    const values = cleanText(
      card.find('.activity-statistic-card-content__statistic').text()
    ).split('/');
    if (card.length !== 1 || values.length !== 2)
      throw new LegacyAnalyticsParseError(
        'group-event performance',
        'dashboard metric missing'
      );
    return {
      participants: parseLocaleNumber(values[0]),
      capacity: parseLocaleNumber(values[1]),
      percent: percent(
        card.find('.activity-statistic-card-content-percentage__value').text()
      ),
    };
  };
  return {
    currency: args.currency,
    rows,
    metrics: {
      booked: metric('records-period'),
      attended: metric('visits-period'),
      paid: metric('paid-period'),
      average_occupancy: metric('avg-filling'),
    },
    page: pageMeta(args.page, args.pageSize, args.count, rows.length),
  };
}

export function parseCashFlowBreakdownHtml(args: {
  html: string;
  currency: string | null;
  accountType: CashAccountType;
  paymentItemId?: number;
}): CashFlowBreakdownReport {
  const $ = load(args.html);
  const table = $('table.table-report');
  const headers = table.find('thead tr').first().children('th.by-type');
  if (table.length !== 1 || headers.length < 4)
    throw new LegacyAnalyticsParseError(
      'cash-flow breakdown',
      'headers missing'
    );
  const periods = headers
    .slice(1, -1)
    .toArray()
    .map((h) => cleanText($(h).text()));
  const columns: CashFlowColumn[] = [];
  const all = args.accountType === 'all';
  const accountHeaders = table.find('thead tr.by-account td');
  const accountCount = all ? accountHeaders.length / periods.length : 0;
  if (!Number.isInteger(accountCount))
    throw new LegacyAnalyticsParseError(
      'cash-flow breakdown',
      'inconsistent account columns'
    );
  if (
    all &&
    (table.find('thead tr.by-type td').length !== periods.length * 3 ||
      headers
        .slice(1, -1)
        .toArray()
        .some((h) => $(h).attr('colspan') !== '3'))
  )
    throw new LegacyAnalyticsParseError(
      'cash-flow breakdown',
      'account-type columns changed'
    );
  periods.forEach((label, i) => {
    for (const type of all
      ? (['cash', 'non_cash'] as const)
      : [args.accountType])
      columns.push({
        period_label: label,
        period_kind: i === periods.length - 1 ? 'period_total' : 'day',
        dimension: 'cash_account_type',
        cash_account_type: type,
        cash_account_id: null,
        cash_account_title: null,
      });
  });
  if (all)
    periods.forEach((label, i) => {
      for (let j = 0; j < accountCount; j++) {
        const title = cleanText(accountHeaders.eq(i * accountCount + j).text());
        if (title !== cleanText(accountHeaders.eq(j).text()))
          throw new LegacyAnalyticsParseError(
            'cash-flow breakdown',
            'account ordering changed'
          );
        columns.push({
          period_label: label,
          period_kind: i === periods.length - 1 ? 'period_total' : 'day',
          dimension: 'cash_account',
          cash_account_type: null,
          cash_account_id: null,
          cash_account_title: title,
        });
      }
    });
  const bodyRows = table.find('tbody tr');
  const continuations = bodyRows.filter(
    (_i, r) => $(r).children('.report-title-cell').length === 0
  );
  if (
    continuations.length > 1 ||
    continuations.toArray().some(
      (r) =>
        !all ||
        !$(r).hasClass('row-aggregated') ||
        $(r).prev().children('.report-title-cell').attr('rowspan') !== '2' ||
        $(r).children('td.by-type').length !== periods.length ||
        $(r).children('td.by-account').length !== periods.length ||
        $(r)
          .children('td.by-type')
          .toArray()
          .some((c) => $(c).attr('colspan') !== '3')
    )
  )
    throw new LegacyAnalyticsParseError(
      'cash-flow breakdown',
      'unexpected or partial continuation row'
    );
  const sourceRows = table
    .find('tbody tr')
    .filter((_i, r) => $(r).children('.report-title-cell').length === 1);
  if (sourceRows.length * columns.length > 6000)
    throw new LegacyAnalyticsParseError(
      'cash-flow breakdown',
      'result too wide; narrow the period or account filters'
    );
  let aggregateIndex = 0;
  let direction: 'inflow' | 'outflow' | null = null;
  const rows: CashFlowRow[] = sourceRows.toArray().map((row) => {
    const aggregate = $(row).hasClass('row-aggregated');
    const kind = aggregate
      ? (['inflow', 'outflow', 'net_movement'] as const)[aggregateIndex++]
      : 'payment_item';
    if (!kind)
      throw new LegacyAnalyticsParseError(
        'cash-flow breakdown',
        'unexpected aggregate'
      );
    if (kind === 'inflow' || kind === 'outflow') direction = kind;
    const amounts: Array<number | null> = [];
    if (all) {
      const typeCells = $(row).children('td.by-type');
      const accountCells = $(row).children('td.by-account');
      if (
        typeCells.length !== periods.length * 3 ||
        accountCells.length !== periods.length * accountCount
      )
        throw new LegacyAnalyticsParseError(
          'cash-flow breakdown',
          'partial data row'
        );
      typeCells.each((i, c) => {
        if (i % 3 !== 2) amounts.push(parseLocaleNumber($(c).text()));
      });
      accountCells.each((_i, c) => {
        amounts.push(parseLocaleNumber($(c).text()));
      });
    } else {
      const dataCells = $(row)
        .children('td')
        .not('.report-title-cell,.report-all-cell');
      if (dataCells.length !== periods.length)
        throw new LegacyAnalyticsParseError(
          'cash-flow breakdown',
          'partial single-type row'
        );
      dataCells.each((_i, c) => {
        amounts.push(parseLocaleNumber($(c).text()));
      });
    }
    const totalCell = $(row).children('.report-all-cell');
    if (totalCell.length !== 1)
      throw new LegacyAnalyticsParseError(
        'cash-flow breakdown',
        'total missing'
      );
    return {
      payment_item_id: args.paymentItemId ?? null,
      payment_item_title: cleanText(
        $(row).children('.report-title-cell').text()
      ),
      kind,
      direction: kind === 'net_movement' ? null : direction,
      amounts,
      total: parseLocaleNumber(totalCell.text()),
    };
  });
  if (!args.paymentItemId && aggregateIndex !== 3)
    throw new LegacyAnalyticsParseError(
      'cash-flow breakdown',
      'aggregates missing'
    );
  return {
    currency: args.currency,
    columns,
    rows,
    totals: {
      inflow: rows.find((r) => r.kind === 'inflow')?.total ?? null,
      outflow: rows.find((r) => r.kind === 'outflow')?.total ?? null,
      net_movement: rows.find((r) => r.kind === 'net_movement')?.total ?? null,
    },
  };
}
