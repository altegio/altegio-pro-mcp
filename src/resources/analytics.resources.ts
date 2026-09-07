/**
 * MCP resources of the analytics pack — data and handlers, no transport.
 *
 * The server does not register resource handlers yet (the transport work is in
 * flight in a parallel change), so this module deliberately exports plain data
 * and pure-ish handlers that any `resources/list`, `resources/templates/list`
 * and `resources/read` implementation can call:
 *
 *   listAnalyticsResources()          → resources/list entries
 *   listAnalyticsResourceTemplates()  → resources/templates/list entries
 *   readAnalyticsResource(uri, deps)  → resources/read contents, or null
 *
 * Four resources:
 *  - `altegio://analytics/glossary` — what every metric means, in plain language.
 *  - `altegio://analytics/report-fields/{dataset}` — the field catalogue of one
 *    report-builder dataset, for hosts that would rather read it once than call
 *    a tool per question.
 *  - `altegio://analytics/coverage` — what analytics this server can and cannot
 *    produce, so an agent never promises a report that does not exist.
 *  - `altegio://reports/{location_id}/{run_id}.csv` — the full output of a
 *    report run whose table was truncated in the tool result.
 */
import {
  ANALYTICS_RULES,
  COVERAGE_GAPS,
  METRIC_DEFINITIONS,
} from '../capabilities/analytics/metrics-registry.js';
import {
  DATASETS,
  DATASET_DESCRIPTIONS,
  type Dataset,
} from '../capabilities/analytics/vocabulary.js';
import {
  getReportCsv,
  parseReportUri,
} from '../capabilities/analytics/report-store.js';

export const GLOSSARY_URI = 'altegio://analytics/glossary';
export const COVERAGE_URI = 'altegio://analytics/coverage';
export const REPORT_FIELDS_URI_TEMPLATE =
  'altegio://analytics/report-fields/{dataset}';
export const REPORT_CSV_URI_TEMPLATE =
  'altegio://reports/{location_id}/{run_id}.csv';

export interface ResourceEntry {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}

export interface ResourceTemplateEntry {
  uriTemplate: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}

export interface ResourceContents {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}

/** One field of a report-builder dataset, as the resource renders it. */
export interface ReportFieldEntry {
  field_key: string;
  title: string;
  kind: string;
  data_type: string;
  aggregation: string | null;
}

export interface ResourceDeps {
  /** Live field catalogue for one dataset, when the caller can reach the API. */
  listReportFields?: (dataset: Dataset) => Promise<readonly ReportFieldEntry[]>;
}

// ========== glossary ==========

export function renderGlossary(): string {
  const metrics = METRIC_DEFINITIONS.map((metric) => {
    const formula = metric.formula ? `\n  - Formula: ${metric.formula}` : '';
    return `- **${metric.name}** (\`${metric.key}\`, from \`${metric.tool}\`)\n  - ${metric.definition}${formula}`;
  }).join('\n');

  const rules = ANALYTICS_RULES.map(
    (rule) => `- **${rule.title}.** ${rule.text}`
  ).join('\n');

  return [
    '# Analytics glossary',
    '',
    'What each number in the analytics tools means, and the rules that apply to all of them.',
    '',
    '## Metrics',
    '',
    metrics,
    '',
    '## Rules that apply everywhere',
    '',
    rules,
    '',
    '## Report builder datasets',
    '',
    DATASETS.map(
      (dataset) => `- **${dataset}** — ${DATASET_DESCRIPTIONS[dataset]}`
    ).join('\n'),
    '',
  ].join('\n');
}

// ========== coverage ==========

export function renderCoverage(): string {
  const gaps = COVERAGE_GAPS.map(
    (gap) =>
      `- **${gap.topic}** — not available: ${gap.reason}\n  - Instead: ${gap.alternative}`
  ).join('\n');

  return [
    '# What the analytics tools can and cannot answer',
    '',
    '## Available through this server',
    '',
    '- Key metrics for a period with a comparison to the previous period, filtered by team member, position or receptionist.',
    '- Day-by-day revenue, appointments, occupancy and client series.',
    '- Appointments split by source and by visit status.',
    '- Front-desk performance: clients booked, appointments closed, revenue attributed, rebooking rate after a visit and after a no-show.',
    '- Loyalty program results per period and per team member.',
    '- Revenue and visits forecast versus actuals, where the module is switched on.',
    '- The day-end report: takings per account, discounts and write-offs, sales totals.',
    '- Occupancy per team member per day.',
    '- Visit history figures of one client.',
    '- The report builder: built-in templates, four datasets, and ad-hoc tables grouped by any dimension with an optional day, week, month or year bucket.',
    '',
    '## Not available, and what to use instead',
    '',
    gaps,
    '',
    '## Hard limits',
    '',
    '- At most 365 days per call.',
    '- Report tables are capped in the tool result; the full table arrives as a CSV resource link that lives for 30 minutes in the server process.',
    '- Everything is scoped to one location; there is no chain-wide roll-up.',
    '',
  ].join('\n');
}

// ========== report fields ==========

export function renderReportFields(
  dataset: Dataset,
  fields?: readonly ReportFieldEntry[]
): string {
  const header = [
    `# Report fields — ${dataset}`,
    '',
    DATASET_DESCRIPTIONS[dataset],
    '',
  ];

  if (!fields) {
    return [
      ...header,
      'The field catalogue is per location: which fields exist depends on the modules the location uses.',
      'Call `analytics_list_report_fields` with this dataset to get the live list, then pass the `field_key` values to `analytics_run_report`.',
      '',
      'Field keys are canonical product terms — `team_member_name`, `revenue_total`, `average_check_per_visit`, `occupancy_percent`, `new_clients_count` — and each one is a metric, a dimension you can group by, or a time granularity (day, week, month, year).',
      '',
    ].join('\n');
  }

  const rows = fields.map(
    (field) =>
      `| \`${field.field_key}\` | ${field.title} | ${field.kind} | ${field.data_type} | ${field.aggregation ?? ''} |`
  );

  return [
    ...header,
    `${fields.length} field(s).`,
    '',
    '| Field key | Title | Kind | Type | Aggregation |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

// ========== list / read ==========

export function listAnalyticsResources(): ResourceEntry[] {
  return [
    {
      uri: GLOSSARY_URI,
      name: 'analytics-glossary',
      title: 'Analytics glossary',
      description:
        'What each analytics number means: average check (average ticket) formula, lost-client threshold, previous-period rule, phone-based client deduplication, how occupancy is measured, what front-desk performance counts.',
      mimeType: 'text/markdown',
    },
    {
      uri: COVERAGE_URI,
      name: 'analytics-coverage',
      title: 'Analytics coverage',
      description:
        'Which analytics this server can produce and which reports exist only in the web interface, with the closest available alternative for each gap.',
      mimeType: 'text/markdown',
    },
  ];
}

export function listAnalyticsResourceTemplates(): ResourceTemplateEntry[] {
  return [
    {
      uriTemplate: REPORT_FIELDS_URI_TEMPLATE,
      name: 'analytics-report-fields',
      title: 'Report fields of one dataset',
      description: `Canonical field keys of one report-builder dataset (${DATASETS.join(', ')}), ready to pass to analytics_run_report.`,
      mimeType: 'text/markdown',
    },
    {
      uriTemplate: REPORT_CSV_URI_TEMPLATE,
      name: 'analytics-report-csv',
      title: 'Full report output as CSV',
      description:
        'Complete output of a report run whose table was truncated in the tool result. Kept in the server process for 30 minutes after the run.',
      mimeType: 'text/csv',
    },
  ];
}

function datasetFromUri(uri: string): Dataset | null {
  const match = /^altegio:\/\/analytics\/report-fields\/([a-z_]+)$/.exec(uri);
  if (!match) return null;
  const candidate = match[1] as Dataset;
  return DATASETS.includes(candidate) ? candidate : null;
}

/**
 * Read one analytics resource. Returns `null` when the URI belongs to another
 * pack, so a dispatcher can fall through to the next handler.
 */
export async function readAnalyticsResource(
  uri: string,
  deps: ResourceDeps = {}
): Promise<ResourceContents | null> {
  if (uri === GLOSSARY_URI) {
    return {
      contents: [{ uri, mimeType: 'text/markdown', text: renderGlossary() }],
    };
  }

  if (uri === COVERAGE_URI) {
    return {
      contents: [{ uri, mimeType: 'text/markdown', text: renderCoverage() }],
    };
  }

  const dataset = datasetFromUri(uri);
  if (dataset) {
    const fields = deps.listReportFields
      ? await deps.listReportFields(dataset)
      : undefined;
    return {
      contents: [
        {
          uri,
          mimeType: 'text/markdown',
          text: renderReportFields(dataset, fields),
        },
      ],
    };
  }

  const report = parseReportUri(uri);
  if (report) {
    const stored = getReportCsv(report.location_id, report.run_id);
    if (!stored) {
      return {
        contents: [
          {
            uri,
            mimeType: 'text/plain',
            text: 'This report output is no longer available: full tables are kept for 30 minutes after the run. Run the report again to get a fresh link.',
          },
        ],
      };
    }
    return {
      contents: [{ uri, mimeType: 'text/csv', text: stored.csv }],
    };
  }

  return null;
}
