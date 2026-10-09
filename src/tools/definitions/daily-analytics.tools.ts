import { z } from 'zod';
import { defineTool } from '../factory.js';
import { PERIOD_PRESETS } from '../../capabilities/analytics/periods.js';
import {
  getDailySummary,
  getTeamWorkload,
} from '../../capabilities/analytics/daily-use-cases.js';

const period = {
  location_id: z.number().int().positive(),
  period: z
    .enum(PERIOD_PRESETS)
    .optional()
    .describe('Preset in the location timezone. Give a preset or both dates.'),
  date_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  date_to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
};
const nullableNumber = { type: ['number', 'null'] as const };
const day = { type: 'string' as const };
const days = { type: 'array' as const, items: day };
const periodOutput = {
  type: 'object' as const,
  properties: {
    date_from: day,
    date_to: day,
    timezone: day,
    days: { type: 'integer' as const },
  },
  required: ['date_from', 'date_to', 'timezone', 'days'],
};
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const analyticsGetTeamWorkloadTool = defineTool({
  name: 'analytics_get_team_workload',
  category: 'Analytics',
  description:
    'Daily booked share and working dates for all visible active team members, or a selected group of up to 50 IDs. Find quiet working days for promotions and distinguish a closed day from free booked capacity. Returns fractions 0…1, not percent, plus coverage for missing working days. Aggregate of the selected team, never rows per person; use analytics_get_team_member_occupancy for individual percentages and analytics_get_team_member_capacity for idle hours. Maximum 93 days. Needs Digital schedule access.',
  annotations: {
    title: 'Analytics: selected team daily workload',
    ...annotations,
  },
  input: z.object({
    ...period,
    team_member_ids: z
      .array(z.number().int().positive())
      .min(1)
      .max(50)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        'Use distinct team member IDs.'
      )
      .optional(),
  }),
  outputSchema: {
    type: 'object',
    properties: {
      location_id: { type: 'integer' },
      period: periodOutput,
      team_member_ids: { type: 'array', items: { type: 'integer' } },
      selection: { type: 'string' },
      points: {
        type: 'array',
        items: {
          type: 'object',
          properties: { date: day, booked_share: nullableNumber },
          required: ['date', 'booked_share'],
        },
      },
      working_days: days,
      coverage: {
        type: 'object',
        properties: {
          missing_working_days: days,
          excluded_outside_period_count: { type: 'integer' },
        },
        required: ['missing_working_days', 'excluded_outside_period_count'],
      },
    },
    required: [
      'location_id',
      'period',
      'team_member_ids',
      'selection',
      'points',
      'working_days',
      'coverage',
    ],
  },
  handler: async ({ input, client }) => getTeamWorkload(client, input),
});

export const analyticsGetDailySummaryTool = defineTool({
  name: 'analytics_get_daily_summary',
  category: 'Analytics',
  description:
    'One day’s compact summary: distinct clients with appointments, booked service value, completed service and product value, product sales, money received, discounts and average check. Use today/yesterday or equal date_from/date_to. Completed value already includes products. Currency is unknown unless a separate source proves it; the average-workload unit is unspecified. A returned day mismatch fails explicitly. Use analytics_get_day_end_report for payment-account detail. Requires location management and basic report metrics.',
  annotations: { title: 'Analytics: daily summary', ...annotations },
  input: z.object(period),
  outputSchema: {
    type: 'object',
    properties: {
      location_id: { type: 'integer' },
      period: periodOutput,
      date: day,
      currency: { type: 'null' },
      money_unit: { const: 'major' },
      clients_with_appointments_count: nullableNumber,
      booked_services_value: nullableNumber,
      completed_sales_value: nullableNumber,
      product_sales_value: nullableNumber,
      cash_received: nullableNumber,
      discounts_value: nullableNumber,
      average_check: nullableNumber,
      average_workload_source_value: nullableNumber,
      average_workload_unit: { const: 'unspecified' },
      definitions: { type: 'object' },
    },
    required: [
      'location_id',
      'period',
      'date',
      'currency',
      'money_unit',
      'clients_with_appointments_count',
      'booked_services_value',
      'completed_sales_value',
      'product_sales_value',
      'cash_received',
      'discounts_value',
      'average_check',
      'average_workload_source_value',
      'average_workload_unit',
      'definitions',
    ],
  },
  handler: async ({ input, client }) => getDailySummary(client, input),
});
