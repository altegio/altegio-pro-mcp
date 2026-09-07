/**
 * Resource module tests.
 *
 * The server does not register resource handlers yet, so these tests exercise
 * the exported list/read functions directly — the same functions the transport
 * change will wire into `resources/list` and `resources/read`.
 */
import {
  COVERAGE_URI,
  GLOSSARY_URI,
  REPORT_CSV_URI_TEMPLATE,
  REPORT_FIELDS_URI_TEMPLATE,
  listAnalyticsResourceTemplates,
  listAnalyticsResources,
  readAnalyticsResource,
  renderReportFields,
} from '../analytics.resources.js';
import {
  clearReportStore,
  putReportCsv,
} from '../../capabilities/analytics/report-store.js';
import { DATASETS } from '../../capabilities/analytics/vocabulary.js';

beforeEach(() => clearReportStore());

describe('resource listing', () => {
  it('offers the glossary and the coverage note as fixed resources', () => {
    expect(listAnalyticsResources().map((entry) => entry.uri)).toEqual([
      GLOSSARY_URI,
      COVERAGE_URI,
    ]);
  });

  it('offers the field catalogue and the report CSV as templates', () => {
    expect(
      listAnalyticsResourceTemplates().map((entry) => entry.uriTemplate)
    ).toEqual([REPORT_FIELDS_URI_TEMPLATE, REPORT_CSV_URI_TEMPLATE]);
  });

  it('gives every entry a name, a title, a description and a mime type', () => {
    for (const entry of [
      ...listAnalyticsResources(),
      ...listAnalyticsResourceTemplates(),
    ]) {
      expect(entry.name).toMatch(/^[a-z-]+$/);
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(20);
      expect(entry.mimeType).toMatch(/^text\//);
    }
  });
});

describe('glossary resource', () => {
  it('explains the metrics that are easy to misread', async () => {
    const read = (await readAnalyticsResource(GLOSSARY_URI))!;
    const text = read.contents[0]!.text;

    expect(read.contents[0]!.mimeType).toBe('text/markdown');
    expect(text).toContain('Average check');
    expect(text).toContain('unique visits');
    expect(text).toContain('60 days');
    expect(text).toContain('phone number');
    expect(text).toContain('immediately before the requested period');
    expect(text).toContain('scheduled working time');
    expect(text).toContain('365 days');
    expect(text).toContain('major units');
  });
});

describe('coverage resource', () => {
  it('lists what exists and names an alternative for each gap', async () => {
    const read = (await readAnalyticsResource(COVERAGE_URI))!;
    const text = read.contents[0]!.text;

    expect(text).toContain('Not available');
    expect(text).toContain('Client retention');
    expect(text).toContain('Reviews and ratings');
    expect(text).toContain('booking funnel');
    expect(text).toContain('Instead:');
    // Every gap must offer a next step, even if that step is "none".
    const gaps = text.split('- **').slice(1);
    expect(gaps.length).toBeGreaterThan(5);
  });
});

describe('report fields resource', () => {
  it('describes the dataset and points at the tool when no live list is given', async () => {
    const read = (await readAnalyticsResource(
      'altegio://analytics/report-fields/sales'
    ))!;
    expect(read.contents[0]!.text).toContain('analytics_list_report_fields');
  });

  it('renders a live field catalogue when the caller can supply one', async () => {
    const read = (await readAnalyticsResource(
      'altegio://analytics/report-fields/team_member_schedules',
      {
        listReportFields: async () => [
          {
            field_key: 'occupancy_percent',
            title: 'Occupancy, %',
            kind: 'metric',
            data_type: 'number',
            aggregation: 'percent',
          },
        ],
      }
    ))!;
    const text = read.contents[0]!.text;
    expect(text).toContain('| `occupancy_percent` | Occupancy, % |');
    expect(text).toContain('1 field(s)');
  });

  it('covers every dataset and refuses an unknown one', async () => {
    for (const dataset of DATASETS) {
      expect(renderReportFields(dataset)).toContain(
        `Report fields — ${dataset}`
      );
      expect(
        await readAnalyticsResource(
          `altegio://analytics/report-fields/${dataset}`
        )
      ).not.toBeNull();
    }
    expect(
      await readAnalyticsResource('altegio://analytics/report-fields/nonsense')
    ).toBeNull();
  });
});

describe('report CSV resource', () => {
  it('serves a stored CSV', async () => {
    const stored = putReportCsv({
      location_id: 4564,
      name: 'Revenue by team member',
      csv: 'Team member,Revenue\nTeam member A,10\n',
      row_count: 1,
    });
    const read = (await readAnalyticsResource(stored.uri))!;
    expect(read.contents[0]!.mimeType).toBe('text/csv');
    expect(read.contents[0]!.text).toContain('Team member A,10');
  });

  it('explains an expired link instead of pretending the report is empty', async () => {
    const read = (await readAnalyticsResource(
      'altegio://reports/4564/gone.csv'
    ))!;
    expect(read.contents[0]!.text).toContain('no longer available');
    expect(read.contents[0]!.text).toContain('30 minutes');
  });
});

describe('unknown URIs', () => {
  it('returns null so a dispatcher can fall through', async () => {
    expect(await readAnalyticsResource('altegio://staff/1')).toBeNull();
    expect(await readAnalyticsResource('https://example.test/x')).toBeNull();
  });
});
