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
  description: 'Location to report on. Use locations_list if it is unknown.',
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
    name: 'analytics_daily_review',
    title: 'Daily business review',
    description:
      'Review one day’s booked service value, completed sales and cash without double counting products or treating a cash difference as receivables.',
    arguments: [
      locationArgument,
      {
        name: 'date',
        description:
          'One report day, YYYY-MM-DD. Defaults to yesterday in the location timezone.',
        required: false,
      },
    ],
  },
  {
    name: 'analytics_quiet_working_days',
    title: 'Quiet working days',
    description:
      'Find quiet working days for the visible active team, exclude closed days and use measured booked share to choose promotion candidates.',
    arguments: [
      locationArgument,
      periodArgument,
      {
        name: 'team_member_ids',
        description:
          'Optional comma-separated IDs of the selected team; an aggregate, not individual rows.',
        required: false,
      },
    ],
  },
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
          'Comma-separated team member ids to look at day by day. Leave out to start from the whole-team sales and capacity tables.',
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
    case 'analytics_daily_review': {
      const date = argument(args, 'date');
      const scope = date
        ? `date_from=${date}, date_to=${date}`
        : 'period=yesterday';
      text = [
        `Review one day at location ${locationId}, ${scope}.`,
        `1. analytics_get_daily_summary with location_id=${locationId}, ${scope}. Verify its returned local date. Keep booked_services_value, completed_sales_value and cash_received in separate columns; completed sales already includes product_sales_value.`,
        `2. analytics_get_overview with the same location and day for currency and the standard headline. Do not silently reconcile different populations; clients in the daily summary are distinct clients with appointments, not attended clients.`,
        '3. If payment-account reconciliation is requested, read analytics_get_day_end_report for that same day, respect its effective-period coverage and keep its ledger separate.',
        'Calculate any cash-minus-completed-value difference in code; label it a difference with an undetermined cause. It does not prove unpaid appointments. Null stays unknown. The daily summary does not prove the unit of average workload; do not label that field a percentage.',
      ].join('\n');
      break;
    }
    case 'analytics_quiet_working_days': {
      const ids = argument(args, 'team_member_ids');
      text = [
        `Find up to three quiet working days at location ${locationId} for period=${period}. Choose and disclose a booked-share threshold, such as 0.5.`,
        `1. analytics_get_team_workload with location_id=${locationId}, period=${period}${ids ? `, team_member_ids=[${ids}]` : ''}. The result aggregates the selected visible active team; it is not a per-person table.`,
        '2. In CodeMode intersect points with working_days, exclude null measurements, verify shares are between 0 and 1 and rank days below the threshold by booked_share then date. Convert a fraction to a displayed percentage by multiplying by 100 exactly once.',
        '3. Check coverage.missing_working_days before claiming a complete ranking. Missing means unknown, and a closed day is not free capacity. Use analytics_get_team_member_capacity for scheduled/booked/idle hours and analytics_get_team_member_occupancy when an individual ranking is requested.',
        'Return dates, the measured booked share, selection, threshold, denominators and missing coverage. Propose a promotion as a hypothesis, not a guaranteed effect or a claim that specific appointment slots are available.',
      ].join('\n');
      break;
    }
    case 'analytics_location_health_check':
      text = [
        `Run a full health check on location ${locationId} for the period "${period}".`,
        '',
        'First read the `altegio://analytics/playbook` resource — it has the metric identities and the diagnostic order this check follows. Then work through the numbers, not the raw payloads:',
        `1. analytics_get_overview for location_id=${locationId}, period=${period}. This is the headline: revenue and its services/products split, average check, occupancy, appointments by outcome, and the new/returning/active/lost client mix, each against the previous period.`,
        '2. For every headline metric that moved by more than ten percent, decompose it before concluding: was revenue traffic (clients_active, visits) or spend (average_check)? Is the appointment count healthy but the attendance rate weak?',
        `3. analytics_get_daily_series with metric=revenue — the shape of the period, the best and worst days, any weekly rhythm.`,
        '4. analytics_get_appointments_breakdown by source, then by visit_status — where demand comes from and how much of it leaks to no-shows and cancellations. Call out the no-show share explicitly.',
        '5. analytics_get_profit_and_loss_statement for the posted operating result and service contribution, analytics_get_cash_flow_breakdown for cash movements (once with cash_account_type=cash and once with non_cash when the full table is too wide), analytics_get_revenue_leakage for avoidable signals, analytics_get_team_member_service_matrix for the exact team × service mix, analytics_get_product_sales for product mix, and analytics_get_capacity_heatmap if capacity looks off. Keep the statement’s missing cost classes explicit and never rename tracked operating result to net profit.',
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
        `4. analytics_get_profit_and_loss_statement for the posted operating result and analytics_get_revenue_leakage for no-show/cancellation/discount signals. Use analytics_get_team_member_sales for the team split, analytics_get_service_profitability for service detail, and analytics_get_team_member_service_matrix for the exact cross-dimension cells. Use analytics_get_client_retention when the client mix points to a retention issue.`,
        '',
        'Finish with three to five sentences an owner can act on: what grew, what shrank, what is leaking (no-shows, cancellations, idle time), and the single change with the largest expected effect. If a tool reports a missing access right or a switched-off module, say so plainly instead of guessing the number.',
      ].join('\n');
      break;

    case 'analytics_team_member_review': {
      const ids = argument(args, 'team_member_ids');
      text = [
        `Review the team of location ${locationId} for the period "${period}".`,
        '',
        `1. Call analytics_get_team_member_sales for period=${period}, then analytics_get_team_member_service_matrix. Rank the team by revenue and contribution while excluding cells below the matrix minimum sample. Use analytics_get_client_retention for the same period when repeat business matters.`,
        `2. analytics_get_team_member_capacity for period=${period} — scheduled, booked and idle hours and the period occupancy of every team member in one call — then analytics_get_capacity_heatmap for the peak and underused time.`,
        ids
          ? `3. analytics_get_team_member_occupancy for team_member_ids=[${ids}] — their day-by-day booked share.`
          : '3. Call analytics_get_team_member_occupancy for up to ten team members who stand out — their day-by-day booked share.',
        '4. For quiet days across the visible active team, analytics_get_team_workload reads the aggregate booked share and working dates in one tool call. Fractions 0…1 differ from individual occupancy percentages. Before concluding about anyone with no occupancy at all, check their scheduled hours in the capacity table: no schedule means no occupancy, not poor performance.',
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
        '3. For every metric that moved by more than ten percent, look for the cause: analytics_get_daily_series to see whether it was one bad week or a trend, analytics_get_appointments_breakdown to check whether cancellations or no-shows changed, and the same key-metrics call narrowed by position_id or team_member_id to see which part of the team moved.',
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
