/** Structural parsers for the temporary ERP HTML/XLS analytics reports. */
import { load, type CheerioAPI } from 'cheerio';
import * as XLSX from '@e965/xlsx';
import type {
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

function resolveTeamMember(
  name: string,
  position: string,
  identities: readonly LegacyTeamMemberIdentity[],
  report: string
): number {
  const expectedName = normalizedIdentity(name);
  const expectedPosition = normalizedIdentity(position);
  const named = identities.filter(
    (item) => normalizedIdentity(item.name) === expectedName
  );
  const exact = named.filter(
    (item) => normalizedIdentity(item.position_title) === expectedPosition
  );
  // A position printed by the report is part of the join key. Falling back to
  // the only same-named person when that position disagrees would turn a
  // changed/stale report row into the wrong stable id.
  const candidates = expectedPosition ? exact : named;
  if (candidates.length !== 1) {
    throw new LegacyAnalyticsParseError(
      report,
      'a team-member row could not be matched to one stable id'
    );
  }
  return candidates[0]!.id;
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
      return {
        team_member_id: resolveTeamMember(
          name,
          position,
          args.teamMembers,
          'client retention'
        ),
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
        services_count: integer(values[1]) ?? 0,
        payments: paymentBreakdown(values, 2),
        cash_or_card_revenue: parseLocaleNumber(values[7]),
        consumables_cost: parseLocaleNumber(values[8]),
        team_member_compensation: parseLocaleNumber(values[9]),
        profit: parseLocaleNumber(values[10]),
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
      services_count: integer(totalValues[1]) ?? 0,
      payments: paymentBreakdown(totalValues, 2),
      cash_or_card_revenue: parseLocaleNumber(totalValues[7]),
      consumables_cost: parseLocaleNumber(totalValues[8]),
      team_member_compensation: parseLocaleNumber(totalValues[9]),
      profit: parseLocaleNumber(totalValues[10]),
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
      return {
        team_member_id: resolveTeamMember(
          name,
          position,
          args.teamMembers,
          'team-member sales'
        ),
        team_member_name: name || null,
        position_title: position || null,
        revenue: parseLocaleNumber(values[2]),
        services_revenue: parseLocaleNumber(values[3]),
        services_count: integer(values[4]),
        products_revenue: parseLocaleNumber(values[5]),
        products_count: integer(values[6]),
        payments: paymentBreakdown(values, 7),
        upcoming_appointments_revenue: parseLocaleNumber(values[12]),
        working_hours: parseLocaleNumber(values[13]),
        revenue_per_working_hour: parseLocaleNumber(values[14]),
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
      services_count: integer(totalValues[3]),
      products_revenue: parseLocaleNumber(totalValues[4]),
      products_count: integer(totalValues[5]),
      payments: paymentBreakdown(totalValues, 6),
      upcoming_appointments_revenue: parseLocaleNumber(totalValues[11]),
      working_hours: parseLocaleNumber(totalValues[12]),
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
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(args.bytes, {
      type: 'array',
      cellDates: true,
      dense: true,
    });
  } catch {
    throw new LegacyAnalyticsParseError(
      'client forecast',
      'malformed workbook'
    );
  }
  const firstName = workbook.SheetNames[0];
  const sheet = firstName ? workbook.Sheets[firstName] : undefined;
  if (!sheet) {
    throw new LegacyAnalyticsParseError(
      'client forecast',
      'workbook has no sheet'
    );
  }
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });
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
