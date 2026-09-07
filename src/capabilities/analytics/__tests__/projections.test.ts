/**
 * Result shaping: summaries, share percentages, CSV rendering, column renaming
 * and the row cap that keeps a report inside the context budget.
 */
import type { ReportField, ReportTable } from '../../../api/analytics-api.js';
import {
  csvCell,
  dropEmptyDays,
  formatChange,
  formatMoney,
  overviewSummary,
  projectReportTable,
  seriesSummary,
  tableSummary,
  toCsv,
  withShares,
} from '../projections.js';
import { findForbiddenWords } from '../vocabulary.js';
import { resolvePeriod, previousPeriod } from '../periods.js';
import {
  REPORT_CSV_TTL_MS,
  REPORT_ROW_CAP,
  clearReportStore,
  getReportCsv,
  parseReportUri,
  putReportCsv,
  reportUri,
} from '../report-store.js';

const period = resolvePeriod({
  date_from: '2026-08-01',
  date_to: '2026-08-03',
});

function field(
  columnId: string,
  key: string,
  title: string,
  dataType: ReportField['data_type'] = 'number'
): ReportField {
  return {
    field_key: key,
    title,
    kind: dataType === 'date' ? 'granularity' : 'metric',
    dataset: 'sales',
    data_type: dataType,
    aggregation: 'sum',
    filterable: true,
    is_curated: true,
    column_id: columnId,
  };
}

describe('formatting helpers', () => {
  it('formats money with a currency and handles missing values', () => {
    expect(formatMoney(12480.5, 'EUR')).toBe('12,480.5 EUR');
    expect(formatMoney(12480.5, null)).toBe('12,480.5');
    expect(formatMoney(null, 'EUR')).toBe('n/a');
  });

  it('signs a positive change and passes through a missing one', () => {
    expect(formatChange(12.5)).toBe('+12.5%');
    expect(formatChange(-4)).toBe('-4%');
    expect(formatChange(null)).toBe('n/a');
  });
});

describe('overviewSummary', () => {
  const overview = {
    currency: 'EUR',
    revenue: {
      total: { current: 12480.5, previous: 10900, change_percent: 14 },
      services: { current: 10230.5, previous: 9100, change_percent: 12 },
      products: { current: 2250, previous: 1800, change_percent: 25 },
    },
    average_check: { current: 48.75, previous: 44.2, change_percent: 10 },
    average_services_check: {
      current: 39.95,
      previous: 37.1,
      change_percent: 7,
    },
    occupancy_percent: { current: 63.4, previous: 58.1, change_percent: 9 },
    appointments: {
      total_count: 296,
      previous_total_count: 268,
      change_percent: 10,
      completed_count: 231,
      completed_percent: 78,
      pending_count: 41,
      pending_percent: 14,
      cancelled_count: 24,
      cancelled_percent: 8,
    },
    clients: {
      total_in_base: 1842,
      new_count: 63,
      new_percent: 26,
      returning_count: 178,
      returning_percent: 74,
      active_count: 241,
      lost_count: 54,
      lost_percent: 3,
    },
  };

  it('names the period, the comparison window and every headline number', () => {
    const text = overviewSummary(overview, period, previousPeriod(period));
    expect(text).toContain('2026-08-01…2026-08-03');
    expect(text).toContain('compared with 2026-07-29…2026-07-31');
    expect(text).toContain(
      'Total revenue: 12,480.5 EUR (+14% vs previous period)'
    );
    expect(text).toContain('Average check');
    expect(text).toContain('Occupancy: 63.4%');
    expect(text).toContain('63 new, 178 returning');
    expect(findForbiddenWords(text)).toEqual([]);
  });

  it('stays well inside the size budget', () => {
    const text = overviewSummary(overview, period, previousPeriod(period));
    // ~4 characters per token: a headline summary must not approach 4k tokens.
    expect(text.length).toBeLessThan(1500);
  });
});

describe('seriesSummary', () => {
  const series = [
    {
      key: 'revenue_total',
      label: 'Revenue',
      points: [
        ['2026-08-01', 430.5],
        ['2026-08-02', 512],
        ['2026-08-03', 388.25],
      ] as Array<readonly [string, number]>,
    },
  ];

  it('reports a total and the best day for a money series', () => {
    const text = seriesSummary('revenue', series, period, 'money', 'EUR');
    expect(text).toContain('total 1,330.75 EUR');
    expect(text).toContain('best day 2026-08-02');
  });

  it('averages a percent series instead of summing it', () => {
    const text = seriesSummary(
      'occupancy',
      [
        {
          key: 'occupancy_percent',
          label: 'Occupancy',
          points: series[0]!.points,
        },
      ],
      period,
      'percent',
      null
    );
    expect(text).toContain('average 443.6%');
  });

  it('says so when there is nothing to report', () => {
    expect(seriesSummary('clients', [], period, 'count', null)).toContain(
      'No clients data'
    );
  });
});

describe('withShares', () => {
  it('adds a share and sorts biggest first', () => {
    expect(withShares([{ count: 20 }, { count: 80 }])).toEqual([
      { count: 80, share_percent: 80 },
      { count: 20, share_percent: 20 },
    ]);
  });

  it('does not divide by zero', () => {
    expect(withShares([{ count: 0 }])).toEqual([
      { count: 0, share_percent: 0 },
    ]);
  });
});

describe('CSV rendering', () => {
  it('escapes quotes, commas and newlines', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe('');
  });

  it('renders header, rows and a totals line', () => {
    const csv = toCsv({
      columns: [
        { key: 'team_member_name', title: 'Team member' },
        { key: 'revenue_total', title: 'Revenue' },
      ],
      rows: [
        { team_member_name: 'Team member A', revenue_total: 6120.5 },
        { team_member_name: 'Team member C, junior', revenue_total: 2050 },
      ],
      totals: { revenue_total: 8170.5 },
    });
    expect(csv.split('\n')).toEqual([
      'Team member,Revenue',
      'Team member A,6120.5',
      '"Team member C, junior",2050',
      ',8170.5',
      '',
    ]);
  });
});

describe('projectReportTable', () => {
  const fields = [
    field('c-master', 'team_member_name', 'Team member', 'text'),
    field('c-revenue', 'revenue_total', 'Revenue'),
    field('c-visits', 'visits_count', 'Visits'),
  ];

  const table: ReportTable = {
    columns: [
      { key: 'g_1', title: 'g_1' },
      { key: 'c_1', title: 'c_1' },
      { key: 'c_2', title: 'c_2' },
    ],
    rows: [
      { g_1: 'Team member A', c_1: 6120.5, c_2: 128 },
      { g_1: 'Team member B', c_1: 4310, c_2: 96 },
    ],
    totals: { c_1: 10430.5, c_2: 224 },
    row_count: 2,
    column_ids: {
      g_1: 'c-master',
      c_1: 'c-revenue',
      c_2: 'c-visits',
    },
  };

  it('renames opaque response keys to canonical field keys', () => {
    const projected = projectReportTable(table, fields);
    expect(projected.columns).toEqual([
      { key: 'team_member_name', title: 'Team member' },
      { key: 'revenue_total', title: 'Revenue' },
      { key: 'visits_count', title: 'Visits' },
    ]);
    expect(projected.rows[0]).toEqual({
      team_member_name: 'Team member A',
      revenue_total: 6120.5,
      visits_count: 128,
    });
    expect(projected.totals).toEqual({
      revenue_total: 10430.5,
      visits_count: 224,
    });
    expect(projected.truncated).toBe(false);
  });

  it('keeps unknown columns under their own key rather than dropping data', () => {
    const projected = projectReportTable({ ...table, column_ids: {} }, fields);
    expect(projected.columns.map((c) => c.key)).toEqual(['g_1', 'c_1', 'c_2']);
  });

  it('keeps repeated metric columns of a dynamic report distinct', () => {
    const dynamic: ReportTable = {
      columns: [
        { key: 'c_1', title: 'c_1 2026-08-01' },
        { key: 'c_2', title: 'c_2 2026-08-02' },
      ],
      rows: [{ c_1: 10, c_2: 20 }],
      totals: {},
      row_count: 1,
      column_ids: { c_1: 'c-revenue', c_2: 'c-revenue' },
    };
    const projected = projectReportTable(dynamic, fields);
    expect(projected.columns.map((c) => c.key)).toEqual([
      'revenue_total',
      'revenue_total_2026-08-02',
    ]);
    expect(projected.rows[0]!['revenue_total_2026-08-02']).toBe(20);
  });

  it('caps the rows and flags the truncation', () => {
    const many: ReportTable = {
      ...table,
      rows: Array.from({ length: REPORT_ROW_CAP + 5 }, (_, i) => ({
        g_1: `Team member ${i}`,
        c_1: i,
        c_2: i,
      })),
      row_count: REPORT_ROW_CAP + 5,
    };
    const projected = projectReportTable(many, fields);
    expect(projected.rows).toHaveLength(REPORT_ROW_CAP);
    expect(projected.row_count).toBe(REPORT_ROW_CAP + 5);
    expect(projected.truncated).toBe(true);
  });
});

describe('tableSummary', () => {
  it('previews the first rows and says how many were held back', () => {
    const projected = projectReportTable(
      {
        columns: [{ key: 'c_1', title: 'c_1' }],
        rows: Array.from({ length: 30 }, (_, i) => ({ c_1: i })),
        totals: {},
        row_count: 30,
        column_ids: { c_1: 'c-revenue' },
      },
      [field('c-revenue', 'revenue_total', 'Revenue')]
    );
    const text = tableSummary('Revenue by team member', projected);
    expect(text).toContain('30 rows');
    expect(text).toContain('20 more rows in the structured result');
  });

  it('explains an empty table', () => {
    const text = tableSummary('Revenue by team member', {
      columns: [],
      rows: [],
      totals: {},
      row_count: 0,
      truncated: false,
    });
    expect(text).toContain('no rows');
    expect(text).toContain('Widen the period');
  });
});

describe('dropEmptyDays', () => {
  it('removes zero days but keeps the series', () => {
    expect(
      dropEmptyDays([
        {
          key: 'revenue_total',
          label: 'Revenue',
          points: [
            ['2026-08-01', 0],
            ['2026-08-02', 12],
          ],
        },
      ])
    ).toEqual([
      { key: 'revenue_total', label: 'Revenue', points: [['2026-08-02', 12]] },
    ]);
  });
});

describe('report CSV store', () => {
  beforeEach(() => clearReportStore());

  it('stores a CSV under a resource URI and reads it back', () => {
    const stored = putReportCsv({
      location_id: 4564,
      name: 'Revenue by team member',
      csv: 'a,b\n1,2\n',
      row_count: 1,
    });
    expect(stored.uri).toBe(reportUri(4564, stored.run_id));
    expect(getReportCsv(4564, stored.run_id)?.csv).toBe('a,b\n1,2\n');
  });

  it('expires an entry after the TTL', () => {
    const now = 1_000_000;
    const stored = putReportCsv({
      location_id: 4564,
      name: 'x',
      csv: 'a\n',
      row_count: 0,
      now,
    });
    expect(getReportCsv(4564, stored.run_id, now + 1)).toBeDefined();
    expect(
      getReportCsv(4564, stored.run_id, now + REPORT_CSV_TTL_MS + 1)
    ).toBeUndefined();
  });

  it('keeps runs of different locations apart', () => {
    const stored = putReportCsv({
      location_id: 4564,
      name: 'x',
      csv: 'a\n',
      row_count: 0,
    });
    expect(getReportCsv(9999, stored.run_id)).toBeUndefined();
  });

  it('parses its own URIs and rejects anything else', () => {
    expect(parseReportUri('altegio://reports/4564/abc123.csv')).toEqual({
      location_id: 4564,
      run_id: 'abc123',
    });
    expect(parseReportUri('altegio://analytics/glossary')).toBeNull();
    expect(
      parseReportUri('altegio://reports/4564/../etc/passwd.csv')
    ).toBeNull();
  });
});
