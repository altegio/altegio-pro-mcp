/**
 * Vocabulary regression guard over the *live* report-builder registry.
 *
 * `constructor-columns-live.json` and `report-templates-live.json` are recorded
 * from the demo location (2026-09-07): one row per distinct column stem plus a
 * sample of the mechanically derived aggregates, and all 24 built-in templates.
 * They carry no personal data — a column registry and a template catalogue are
 * product metadata.
 *
 * This is the only test that sees the real legacy names, and it is the one that
 * matters most: 565 columns across four datasets are renamed by rule, and a
 * single missed rule leaks a word like `master` or `abonement` straight into a
 * tool result. The live suite re-records both files.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  canonicalizeLabel,
  datasetFromTable,
  datasetFromTemplateSlug,
  findForbiddenWords,
  REPORT_TEMPLATES,
  toFieldKey,
} from '../vocabulary.js';

const FIXTURES = path.join(__dirname, '../../../api/v1/__tests__/fixtures');

interface LiveColumn {
  table_name: string;
  column_name: string;
  column_name_alias: string | null;
  title: string;
  is_default: boolean;
  is_groupable: boolean;
  is_granularity: boolean;
}

interface LiveTemplate {
  id: string;
  name: string;
  slug: string;
  type: 'static' | 'dynamic';
}

const columns: LiveColumn[] = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'constructor-columns-live.json'), 'utf8')
).data;

const templates: LiveTemplate[] = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'report-templates-live.json'), 'utf8')
).data;

describe('live column registry', () => {
  it('covers every dataset and a broad slice of the naming space', () => {
    expect(columns.length).toBeGreaterThan(150);
    const datasets = new Set(columns.map((column) => column.table_name));
    expect([...datasets].sort()).toEqual([
      'olap_financial_transactions',
      'olap_loyalty',
      'olap_masters_schedules',
      'olap_services_goods',
    ]);
  });

  it('maps every table name to a canonical dataset', () => {
    const unknown = columns
      .map((column) => column.table_name)
      .filter((table) => datasetFromTable(table) === null);
    expect([...new Set(unknown)]).toEqual([]);
  });

  it('renames every column to a field key with no legacy word', () => {
    const violations = columns
      .map((column) => {
        const alias = column.column_name_alias ?? column.column_name;
        const key = toFieldKey(alias);
        return { alias, key, words: findForbiddenWords(key) };
      })
      .filter((entry) => entry.words.length > 0);
    expect(violations).toEqual([]);
  });

  it('produces a unique field key per dataset', () => {
    const perDataset = new Map<string, Set<string>>();
    const collisions: string[] = [];
    for (const column of columns) {
      const alias = column.column_name_alias ?? column.column_name;
      const key = toFieldKey(alias);
      const bucket = perDataset.get(column.table_name) ?? new Set<string>();
      if (bucket.has(key)) collisions.push(`${column.table_name}: ${key}`);
      bucket.add(key);
      perDataset.set(column.table_name, bucket);
    }
    expect(collisions).toEqual([]);
  });

  it('rewrites every column title into canonical vocabulary', () => {
    const violations = columns
      .map((column) => {
        const title = canonicalizeLabel(column.title ?? '');
        return {
          original: column.title,
          title,
          words: findForbiddenWords(title),
        };
      })
      .filter((entry) => entry.words.length > 0);
    expect(violations).toEqual([]);
  });

  it('keeps the curated metrics a business owner picks', () => {
    const curated = columns
      .filter((column) => column.is_default)
      .map((column) =>
        toFieldKey(column.column_name_alias ?? column.column_name)
      );
    for (const key of [
      'revenue_total',
      'revenue_services',
      'revenue_products',
      'average_check_per_visit',
      'attendance_rate_percent',
      'new_clients_count',
      'occupancy_percent',
      'income_total',
      'expenses_total',
      'memberships_and_gift_cards_sold_count',
    ]) {
      expect(curated).toContain(key);
    }
  });

  it('does not flag dimensions as curated, so `is_default` alone is not enough', () => {
    // The registry marks curated metrics with `is_default` but leaves every
    // dimension unmarked — `team_member_name` included. A default field list
    // built from `is_default` alone would offer nothing to group a report by,
    // which is why `analytics_list_report_fields` keeps groupable columns too.
    const dimension = columns.find(
      (column) =>
        toFieldKey(column.column_name_alias ?? column.column_name) ===
        'team_member_name'
    )!;
    expect(dimension.is_groupable).toBe(true);
    expect(dimension.is_default).toBe(false);
  });

  it('marks the four time granularities of every dataset', () => {
    const granularities = columns
      .filter((column) => column.is_granularity)
      .map((column) =>
        toFieldKey(column.column_name_alias ?? column.column_name)
      );
    for (const suffix of ['day', 'week', 'month', 'year']) {
      expect(granularities.some((key) => key.endsWith(`_${suffix}`))).toBe(
        true
      );
    }
  });
});

describe('live report templates', () => {
  it('records all 24 built-in templates, 17 flat and 7 over time', () => {
    expect(templates).toHaveLength(24);
    expect(templates.filter((one) => one.type === 'dynamic')).toHaveLength(7);
    expect(templates.filter((one) => one.type === 'static')).toHaveLength(17);
  });

  it('has a curated canonical name for every live slug', () => {
    const missing = templates.filter(
      (template) => !(template.slug in REPORT_TEMPLATES)
    );
    expect(missing.map((template) => template.slug)).toEqual([]);
  });

  it('names no template with a legacy word, curated or derived', () => {
    for (const template of templates) {
      const curated = REPORT_TEMPLATES[template.slug]!;
      expect(findForbiddenWords(curated.name)).toEqual([]);
      expect(findForbiddenWords(curated.answers)).toEqual([]);
      // The fallback path, used when a slug is unknown, must be clean too.
      expect(findForbiddenWords(canonicalizeLabel(template.name))).toEqual([]);
    }
  });

  it('assigns every template a dataset, curated or derived from the slug', () => {
    for (const template of templates) {
      const dataset =
        REPORT_TEMPLATES[template.slug]?.dataset ??
        datasetFromTemplateSlug(template.slug);
      expect(dataset).not.toBeNull();
    }
  });

  it('curates no template that the location does not offer', () => {
    const liveSlugs = new Set(templates.map((template) => template.slug));
    const stale = Object.keys(REPORT_TEMPLATES).filter(
      (slug) => !liveSlugs.has(slug)
    );
    expect(stale).toEqual([]);
  });
});
