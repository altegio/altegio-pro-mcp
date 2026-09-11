/**
 * Terminology guard — the non-negotiable rule of the analytics pack.
 *
 * Nothing the agent can read may contain a legacy API word. This test walks
 * every analytics tool name, every input and output schema property, every
 * description, the resource texts and the prompt texts, and fails on the first
 * forbidden word. The legacy dialect is allowed in exactly two places: the
 * vocabulary module that maps it, and the v1 adapter that consumes it.
 */
import * as definitions from '../../../tools/definitions/index.js';
import type { DefinedTool } from '../../../tools/factory.js';
import {
  FORBIDDEN_WORDS,
  canonicalizeLabel,
  findForbiddenWords,
  visitStatusFromLabel,
  appointmentSourceFromLabel,
  toFieldKey,
  VISIT_STATUSES,
} from '../vocabulary.js';
import {
  GLOSSARY_URI,
  COVERAGE_URI,
  PLAYBOOK_URI,
  DATA_MODEL_URI,
  listAnalyticsResourceTemplates,
  listAnalyticsResources,
  renderCoverage,
  renderDataModel,
  renderGlossary,
  renderPlaybook,
  renderReportFields,
} from '../../../resources/analytics.resources.js';
import {
  getAnalyticsPrompt,
  listAnalyticsPrompts,
} from '../../../prompts/analytics.prompts.js';
import { DATASETS } from '../vocabulary.js';

const analyticsTools = (Object.values(definitions) as unknown[])
  .filter(
    (value): value is DefinedTool =>
      !!value &&
      typeof value === 'object' &&
      'toMcpTool' in value &&
      'meta' in value
  )
  .filter((tool) => tool.meta.name.startsWith('analytics_'));

/** Every string in a JSON Schema that an agent can read. */
function schemaStrings(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) schemaStrings(item, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'properties' && value && typeof value === 'object') {
      out.push(...Object.keys(value as object));
    }
    if (typeof value === 'string') out.push(value);
    else schemaStrings(value, out);
  }
  return out;
}

describe('analytics terminology', () => {
  it('finds all 15 analytics tools', () => {
    expect(analyticsTools).toHaveLength(15);
  });

  it.each(analyticsTools.map((tool) => [tool.meta.name, tool] as const))(
    '%s uses no legacy vocabulary anywhere in its contract',
    (_name, tool) => {
      const spec = tool.toMcpTool();
      const texts = [
        spec.name,
        spec.description,
        spec.annotations?.title ?? '',
        ...schemaStrings(spec.inputSchema),
        ...schemaStrings(spec.outputSchema ?? {}),
      ];
      const offenders = texts
        .map((text) => [text, findForbiddenWords(text)] as const)
        .filter(([, words]) => words.length > 0);
      expect(offenders).toEqual([]);
    }
  );

  it('every analytics tool is named with the analytics_ prefix', () => {
    for (const tool of analyticsTools) {
      expect(tool.meta.name).toMatch(/^analytics_[a-z_]+$/);
    }
  });

  it('resource texts use no legacy vocabulary', () => {
    const texts = [
      renderGlossary(),
      renderCoverage(),
      renderPlaybook(),
      renderDataModel(),
      ...DATASETS.map((dataset) => renderReportFields(dataset)),
      ...listAnalyticsResources().flatMap((entry) => [
        entry.name,
        entry.title,
        entry.description,
        entry.uri,
      ]),
      ...listAnalyticsResourceTemplates().flatMap((entry) => [
        entry.name,
        entry.title,
        entry.description,
        entry.uriTemplate,
      ]),
    ];
    for (const text of texts) {
      expect(findForbiddenWords(text)).toEqual([]);
    }
  });

  it('prompt definitions and rendered prompts use no legacy vocabulary', () => {
    for (const prompt of listAnalyticsPrompts()) {
      const texts = [
        prompt.name,
        prompt.title,
        prompt.description,
        ...prompt.arguments.flatMap((argument) => [
          argument.name,
          argument.description,
        ]),
      ];
      for (const text of texts) {
        expect(findForbiddenWords(text)).toEqual([]);
      }

      const rendered = getAnalyticsPrompt(prompt.name, {
        location_id: '4564',
        period: 'last_month',
        date_from: '2026-08-01',
        date_to: '2026-08-31',
        team_member_ids: '9001,9002',
      })!;
      expect(findForbiddenWords(rendered.description)).toEqual([]);
      expect(findForbiddenWords(rendered.messages[0]!.content.text)).toEqual(
        []
      );
    }
  });

  it('resource URIs stay stable', () => {
    expect(GLOSSARY_URI).toBe('altegio://analytics/glossary');
    expect(COVERAGE_URI).toBe('altegio://analytics/coverage');
    expect(PLAYBOOK_URI).toBe('altegio://analytics/playbook');
    expect(DATA_MODEL_URI).toBe('altegio://analytics/data-model');
  });
});

describe('findForbiddenWords', () => {
  it('flags every forbidden word on its own', () => {
    for (const word of FORBIDDEN_WORDS) {
      expect(findForbiddenWords(`text ${word} text`)).toContain(word);
    }
  });

  it('flags snake_case and plural forms', () => {
    expect(findForbiddenWords('staff_id')).toContain('staff');
    expect(findForbiddenWords('the records list')).toContain('record');
    expect(findForbiddenWords('company_id')).toContain('company');
  });

  it('does not flag legitimate words that merely contain one', () => {
    expect(findForbiddenWords('recorded and recording')).toEqual([]);
    expect(findForbiddenWords('products, memberships, gift cards')).toEqual([]);
    expect(findForbiddenWords('arrived, no_show, cancelled')).toEqual([]);
    expect(findForbiddenWords('average check per visit')).toEqual([]);
  });

  it('keeps average check canonical and average bill forbidden', () => {
    expect(findForbiddenWords('average check')).toEqual([]);
    expect(findForbiddenWords('average bill')).toContain('average bill');
    expect(findForbiddenWords('average_bill')).toContain('average_bill');
  });
});

describe('canonicalizeLabel', () => {
  it.each([
    ['Employee sales', 'Team member sales'],
    ['Goods and services', 'Services and products'],
    ['Record sources', 'Appointment sources'],
    ['Cash register report', 'Daily sales report'],
    ['Revenue by cash registers', 'Revenue by account'],
    ['Fullness, %', 'Occupancy, %'],
    ['Subscriptions and certificates sold', 'Memberships and gift cards sold'],
    ['Administrators', 'Receptionists'],
    ['Income', 'Revenue'],
    ['Deposits', 'Client account top-ups'],
    ['Cashless expenses', 'Non-cash expenses'],
  ])('rewrites %s to %s', (input, expected) => {
    expect(canonicalizeLabel(input)).toBe(expected);
    expect(findForbiddenWords(canonicalizeLabel(input))).toEqual([]);
  });
});

describe('visit status and appointment source mapping', () => {
  it('maps the English status labels to the canonical enum', () => {
    expect(visitStatusFromLabel('Came')).toBe('arrived');
    expect(visitStatusFromLabel('Did not come')).toBe('no_show');
    expect(visitStatusFromLabel('Confirmed')).toBe('confirmed');
    expect(visitStatusFromLabel('Expectation')).toBe('waiting');
    expect(visitStatusFromLabel('Deleted')).toBe('cancelled');
    expect(visitStatusFromLabel('Something new')).toBeNull();
  });

  it('uses the V3 appointment status enum', () => {
    expect([...VISIT_STATUSES]).toEqual([
      'waiting',
      'confirmed',
      'arrived',
      'no_show',
      'cancelled',
    ]);
  });

  it('falls back to other for a free-text source', () => {
    expect(appointmentSourceFromLabel('Administrator')).toBe('receptionist');
    expect(appointmentSourceFromLabel('Booking form "Main site"')).toBe(
      'online_booking_widget'
    );
    expect(appointmentSourceFromLabel('Some partner integration')).toBe(
      'other'
    );
  });
});

describe('toFieldKey', () => {
  it.each([
    ['sales_revenue', 'revenue_total'],
    ['master_name', 'team_member_name'],
    ['fullness', 'occupancy_percent'],
    ['abonement_sales_revenue', 'revenue_memberships'],
    ['certificate_sales_revenue', 'revenue_gift_cards'],
    ['money_profit_cashless', 'income_non_cash'],
    ['record_success_pct', 'attendance_rate_percent'],
    ['deposit_paid_sum', 'paid_from_client_account'],
    ['master_fired', 'team_member_dismissed'],
  ])('renames %s to %s', (input, expected) => {
    expect(toFieldKey(input)).toBe(expected);
  });

  it('keeps a mechanical aggregate suffix on a curated stem', () => {
    expect(toFieldKey('sales_revenue_avg')).toBe('revenue_total_avg');
    expect(toFieldKey('master_name_count_distinct')).toBe(
      'team_member_name_count_distinct'
    );
  });

  it('produces no forbidden word for any known column name', () => {
    const columns = [
      'sales_revenue',
      'goods_sales_revenue',
      'records_cnt',
      'abonements_sold_cnt',
      'certificates_sold_cnt',
      'master_position',
      'record_source_title',
      'money_expenses_cashless',
      'num_records',
      'schedule_length',
      'client_first_record_date',
      'has_operative_record',
    ];
    for (const column of columns) {
      expect(findForbiddenWords(toFieldKey(column))).toEqual([]);
    }
  });
});
