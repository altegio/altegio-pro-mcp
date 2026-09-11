/**
 * MCP prompts of the analytics pack — definitions and renderers, no transport.
 *
 * Like the resources module this exports plain data plus a pure renderer; the
 * shared server wires it into `prompts/list` and `prompts/get` on every facet:
 *
 *   listAnalyticsPrompts()          → prompts/list entries
 *   getAnalyticsPrompt(name, args)  → prompts/get result, or null
 *
 * Each prompt is a short plan the model follows with the `analytics_*` tools,
 * written in canonical product vocabulary.
 */

export interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface PromptEntry {
  name: string;
  title: string;
  description: string;
  arguments: PromptArgument[];
}

export interface PromptResult {
  description: string;
  messages: Array<{
    role: 'user';
    content: { type: 'text'; text: string };
  }>;
}

const locationArgument: PromptArgument = {
  name: 'location_id',
  description: 'Location to report on. Use list_locations if it is unknown.',
  required: true,
};

const periodArgument: PromptArgument = {
  name: 'period',
  description:
    'Period preset such as last_month, this_month, last_quarter or this_year. Defaults to last_month.',
  required: false,
};

export const ANALYTICS_PROMPTS: readonly PromptEntry[] = [
  {
    name: 'analytics_location_health_check',
    title: 'Location health check',
    description:
      'Diagnose a location end to end when there is no specific complaint: pull the headline, split every movement into traffic versus spend, find where demand leaks (no-shows, cancellations, idle time), and finish with the single change with the largest expected effect. Follows the analytics playbook.',
    arguments: [locationArgument, periodArgument],
  },
  {
    name: 'analytics_monthly_review',
    title: 'Monthly business review',
    description:
      'Walk through a period the way an owner reviews the month: key metrics against the previous period, the revenue trend, where bookings came from, and the two tables that explain the result.',
    arguments: [locationArgument, periodArgument],
  },
  {
    name: 'analytics_team_member_review',
    title: 'Team member review',
    description:
      'Review the team for a period: revenue per team member, occupancy and idle hours, and who has capacity left.',
    arguments: [
      locationArgument,
      periodArgument,
      {
        name: 'team_member_ids',
        description:
          'Comma-separated team member ids to look at in detail. Leave out to review the whole team from the report table first.',
        required: false,
      },
    ],
  },
  {
    name: 'analytics_compare_periods',
    title: 'Compare two periods',
    description:
      'Compare two explicit periods metric by metric and explain what moved, rather than trusting a single change percentage.',
    arguments: [
      locationArgument,
      {
        name: 'date_from',
        description: 'First day of the period under review, YYYY-MM-DD.',
        required: true,
      },
      {
        name: 'date_to',
        description: 'Last day of the period under review, YYYY-MM-DD.',
        required: true,
      },
      {
        name: 'baseline_date_from',
        description:
          'First day of the baseline period, YYYY-MM-DD. Leave out to use the period of equal length immediately before.',
        required: false,
      },
      {
        name: 'baseline_date_to',
        description: 'Last day of the baseline period, YYYY-MM-DD.',
        required: false,
      },
    ],
  },
] as const;

export function listAnalyticsPrompts(): readonly PromptEntry[] {
  return ANALYTICS_PROMPTS;
}

function argument(
  args: Record<string, string> | undefined,
  name: string,
  fallback = ''
): string {
  const value = args?.[name];
  return value === undefined || value === '' ? fallback : value;
}

/** Render one prompt, or `null` when the name belongs to another pack. */
export function getAnalyticsPrompt(
  name: string,
  args?: Record<string, string>
): PromptResult | null {
  const entry = ANALYTICS_PROMPTS.find((prompt) => prompt.name === name);
  if (!entry) return null;

  const locationId = argument(args, 'location_id', '<location_id>');
  const period = argument(args, 'period', 'last_month');

  let text: string;
  switch (name) {
    case 'analytics_location_health_check':
      text = [
        `Run a full health check on location ${locationId} for the period "${period}".`,
        '',
        'First read the `altegio://analytics/playbook` resource — it has the metric identities and the diagnostic order this check follows. Then work through the numbers, not the raw payloads:',
        `1. analytics_get_overview for location_id=${locationId}, period=${period}. This is the headline: revenue and its services/products split, average check, occupancy, appointments by outcome, and the new/returning/active/lost client mix, each against the previous period.`,
        '2. For every headline metric that moved by more than ten percent, decompose it before concluding: was revenue traffic (clients_active, visits) or spend (average_check)? Is the appointment count healthy but the attendance rate weak?',
        `3. analytics_get_daily_series with metric=revenue — the shape of the period, the best and worst days, any weekly rhythm.`,
        '4. analytics_get_appointments_breakdown by source, then by visit_status — where demand comes from and how much of it leaks to no-shows and cancellations. Call out the no-show share explicitly.',
        '5. analytics_run_report on "Revenue by team member" and "Revenue by service" — the two tables that explain the headline, and the "Occupancy" template if capacity looks off.',
        '',
        'Finish with three to five sentences an owner can act on: what grew, what shrank, what is leaking (no-shows, cancellations, idle time), and the single change with the largest expected effect. Report absolute money next to every percentage. If a tool reports a missing access right or a switched-off module, say so plainly instead of guessing the number — missing is not zero.',
      ].join('\n');
      break;

    case 'analytics_monthly_review':
      text = [
        `Review location ${locationId} for the period "${period}".`,
        '',
        'Work in this order and keep the numbers, not the raw payloads:',
        `1. analytics_get_overview for location_id=${locationId}, period=${period}. Report revenue, average check, occupancy, appointments and the client mix, each against the previous period.`,
        `2. analytics_get_daily_series with metric=revenue for the same period. Name the best and worst days and any obvious weekly rhythm.`,
        `3. analytics_get_appointments_breakdown with group_by=source, then again with group_by=visit_status. Call out the no-show share explicitly.`,
        `4. analytics_list_report_templates, then analytics_run_report on the "Revenue by team member" and "Revenue by service" templates for the same period.`,
        '',
        'Finish with three to five sentences an owner can act on: what grew, what shrank, what is leaking (no-shows, cancellations, idle time), and the single change with the largest expected effect. If a tool reports a missing access right or a switched-off module, say so plainly instead of guessing the number.',
      ].join('\n');
      break;

    case 'analytics_team_member_review': {
      const ids = argument(args, 'team_member_ids');
      text = [
        `Review the team of location ${locationId} for the period "${period}".`,
        '',
        `1. analytics_run_report with the "Revenue by team member" template for location_id=${locationId}, period=${period}. Rank the team by revenue and note the average check of each.`,
        `2. analytics_run_report with the "Occupancy" template for the same period: scheduled, booked and idle hours per team member.`,
        ids
          ? `3. analytics_get_team_member_occupancy for team_member_ids=[${ids}] to see the day-by-day pattern of the people in question.`
          : '3. Pick the two or three team members whose occupancy looks unusual and call analytics_get_team_member_occupancy for them to see the day-by-day pattern.',
        '',
        'Conclude with who is at capacity, who has room for more bookings, and whether the schedule or the price list is the constraint. Remember that a team member with no work schedule shows no occupancy at all — say that rather than reporting zero as poor performance.',
      ].join('\n');
      break;
    }

    default: {
      const from = argument(args, 'date_from', '<date_from>');
      const to = argument(args, 'date_to', '<date_to>');
      const baselineFrom = argument(args, 'baseline_date_from');
      const baselineTo = argument(args, 'baseline_date_to');
      text = [
        `Compare two periods for location ${locationId}.`,
        '',
        `1. analytics_get_overview for date_from=${from}, date_to=${to}.`,
        baselineFrom && baselineTo
          ? `2. analytics_get_overview for date_from=${baselineFrom}, date_to=${baselineTo}.`
          : '2. The result already carries the previous period of equal length; use its comparison values rather than a second call.',
        '3. For every metric that moved by more than ten percent, look for the cause: analytics_get_daily_series to see whether it was one bad week or a trend, analytics_get_appointments_breakdown to check whether cancellations or no-shows changed, and analytics_run_report on "Revenue by team member" or "Revenue by service" to see which part of the business moved.',
        '',
        'Keep both periods the same length, or say clearly that they are not. Report absolute values next to the percentage change: a 50 % rise on a small base is not the same story as a 5 % rise on the main revenue line.',
      ].join('\n');
      break;
    }
  }

  return {
    description: entry.description,
    messages: [{ role: 'user', content: { type: 'text', text } }],
  };
}
