/**
 * Metric registry — one definition per metric the analytics pack reports.
 *
 * It is the single source for the plain-language explanations that appear in
 * the `altegio://analytics/glossary` resource and in tool descriptions, so a
 * metric is explained the same way everywhere. Definitions describe what the
 * backend actually computes (formula, comparison window, thresholds), because
 * "revenue" and "average check" mean slightly different things in every
 * business tool and an agent that guesses will mislead the owner.
 */

export interface MetricDefinition {
  /** Canonical field key as it appears in tool results. */
  readonly key: string;
  /** Short human name. */
  readonly name: string;
  /** What it measures, in the owner's words. */
  readonly definition: string;
  /** How it is computed, when the formula is not obvious. */
  readonly formula?: string;
  /** Which tool returns it. */
  readonly tool: string;
}

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    key: 'team_capacity_hours',
    name: 'Team capacity hours',
    definition:
      'Scheduled working hours, booked hours and idle hours with source totals; occupancy is booked hours divided by working hours.',
    tool: 'analytics_get_team_member_capacity',
  },
  {
    key: 'reactivation_lifetime_paid',
    name: 'Reactivation lifetime paid',
    definition:
      'Lifetime paid amount for loyalty-program clients who did not return in the requested period; not period revenue. Client ids are unavailable.',
    tool: 'analytics_get_client_reactivation_candidates',
  },
  {
    key: 'group_event_appointment_value',
    name: 'Group event appointment value',
    definition:
      'Full appointment value for event participants; not collected revenue. Booked, attended and fully paid participant counts are separate.',
    tool: 'analytics_get_group_event_performance',
  },
  {
    key: 'product_sales_cost',
    name: 'Product sales cost',
    definition:
      'Current product cost multiplied by sold quantity; not unit cost. Revenue includes client-account payments. Category costs are withheld and hierarchical rows must not be summed.',
    tool: 'analytics_get_product_sales',
  },
  {
    key: 'cash_flow_net_movement',
    name: 'Cash flow net movement',
    definition:
      'Signed inflow plus outflow over the period, not a closing account balance. Account and account-type columns overlap; do not sum both dimensions.',
    tool: 'analytics_get_cash_flow_breakdown',
  },

  {
    key: 'revenue_total',
    name: 'Total revenue',
    definition:
      'All money taken in the period: services, products, memberships, gift cards and client account top-ups.',
    formula: 'services revenue + products revenue + client account top-ups',
    tool: 'analytics_get_overview',
  },
  {
    key: 'revenue_services',
    name: 'Services revenue',
    definition: 'Money taken for services rendered in the period.',
    tool: 'analytics_get_overview',
  },
  {
    key: 'revenue_products',
    name: 'Products revenue',
    definition: 'Money taken for products sold in the period.',
    tool: 'analytics_get_overview',
  },
  {
    key: 'average_check',
    name: 'Average check',
    definition:
      'Average amount one client leaves per visit — the canonical name for this metric across the product.',
    formula:
      '(revenue + client account top-ups) / (unique visits + appointments without a visit + product-sale documents)',
    tool: 'analytics_get_overview',
  },
  {
    key: 'average_services_check',
    name: 'Average services check',
    definition:
      'Average amount one client leaves per visit counting services only, so product sales do not inflate it.',
    tool: 'analytics_get_overview',
  },
  {
    key: 'occupancy_percent',
    name: 'Occupancy',
    definition:
      'Share of the team’s scheduled working time that is booked. 100 % means every scheduled hour is filled.',
    formula: 'booked time / scheduled working time × 100',
    tool: 'analytics_get_overview',
  },
  {
    key: 'occupancy_no_show_percent',
    name: 'No-show share of working time',
    definition:
      'Share of scheduled working time that was booked but the client did not attend.',
    tool: 'analytics_get_daily_series',
  },
  {
    key: 'appointments_total',
    name: 'Appointments',
    definition: 'Number of appointments in the period, in any visit status.',
    tool: 'analytics_get_overview',
  },
  {
    key: 'appointments_online',
    name: 'Online bookings',
    definition:
      'Appointments the client created themselves through online booking or the client app, rather than a receptionist.',
    tool: 'analytics_get_daily_series',
  },
  {
    key: 'clients_total_in_base',
    name: 'Clients in the base',
    definition:
      'Every client card in this location, not only the clients who came in the period.',
    tool: 'analytics_get_overview',
  },
  {
    key: 'clients_active',
    name: 'Active clients',
    definition: 'Clients who came in the period: new plus returning.',
    formula: 'new clients + returning clients',
    tool: 'analytics_get_overview',
  },
  {
    key: 'clients_new',
    name: 'New clients',
    definition:
      'Clients whose first visit falls in the period. Counted by phone number, so one person with two client cards counts once.',
    tool: 'analytics_get_overview',
  },
  {
    key: 'clients_returning',
    name: 'Returning clients',
    definition:
      'Clients who had visited before and came again in the period. Also deduplicated by phone number.',
    tool: 'analytics_get_overview',
  },
  {
    key: 'clients_lost',
    name: 'Lost clients',
    definition:
      'Clients who have not come back for longer than the location’s lost-client threshold (60 days unless the location changed it). Reported as a share of the whole client base, not of active clients.',
    tool: 'analytics_get_overview',
  },
  {
    key: 'change_percent',
    name: 'Change vs previous period',
    definition:
      'Relative change against the previous period — the same number of days immediately before the requested one. A 7-day period compares with the 7 days before it. `null` means the previous value was zero, so a percentage would be meaningless.',
    tool: 'analytics_get_overview',
  },
  {
    key: 'clients_booked',
    name: 'Clients booked by receptionists',
    definition:
      'Distinct clients whose appointments were created by a receptionist of this location in the period.',
    tool: 'analytics_get_receptionist_performance',
  },
  {
    key: 'appointments_closed',
    name: 'Appointments closed',
    definition:
      'Appointments a receptionist checked out and settled in the period.',
    tool: 'analytics_get_receptionist_performance',
  },
  {
    key: 'rebooked_after_visit',
    name: 'Rebooking rate after a visit',
    definition:
      'Of the clients a receptionist served who arrived, the share that left with a new future appointment.',
    formula: 'clients rebooked / clients served × 100',
    tool: 'analytics_get_receptionist_performance',
  },
  {
    key: 'rebooked_after_no_show',
    name: 'Rebooking rate after a no-show',
    definition:
      'Of the clients who did not attend, the share a receptionist got back into the calendar.',
    tool: 'analytics_get_receptionist_performance',
  },
  {
    key: 'takings_by_account',
    name: 'Takings per account',
    definition:
      'Money actually received per account (till, card terminal, transfer) on the report day — the cash-versus-card split.',
    tool: 'analytics_get_day_end_report',
  },
  {
    key: 'write_offs',
    name: 'Write-offs',
    definition:
      'Value settled without money arriving: discounts, loyalty bonuses, memberships and gift cards.',
    tool: 'analytics_get_day_end_report',
  },
  {
    key: 'forecast',
    name: 'Revenue and visits forecast',
    definition:
      'A model prediction of revenue and visit count for the period, next to the actuals, so the owner sees whether the location is running ahead of or behind expectation. It is a forecast comparison, not client segmentation.',
    tool: 'analytics_get_forecast',
  },
  {
    key: 'attendance_rate_percent',
    name: 'Attendance rate',
    definition:
      'Share of appointments the client actually attended, the inverse of the no-show share.',
    tool: 'analytics_get_appointments_breakdown',
  },
  {
    key: 'tracked_operating_result',
    name: 'Tracked operating result',
    definition:
      'Posted finance income less posted finance expenses for the period. It is deliberately not called net profit because external and unposted costs may be missing.',
    formula: 'posted income total - posted expense total',
    tool: 'analytics_get_profit_and_loss_statement',
  },
  {
    key: 'contribution_result',
    name: 'Service contribution result',
    definition:
      'Service revenue after source-attributed consumables and team-member compensation. It describes service economics, not whole-location profit.',
    formula:
      'cash-or-card service revenue + client-account payments - consumables cost - team-member compensation',
    tool: 'analytics_get_profit_and_loss_statement',
  },
  {
    key: 'scheduled_hours',
    name: 'Scheduled hours',
    definition:
      'Work-schedule time available for booking. Time outside a schedule is never treated as idle capacity.',
    tool: 'analytics_get_capacity_heatmap',
  },
  {
    key: 'booked_hours',
    name: 'Booked hours',
    definition:
      'The union of non-cancelled appointment intervals inside scheduled time, so overlapping appointments count once.',
    tool: 'analytics_get_capacity_heatmap',
  },
  {
    key: 'days_of_cover',
    name: 'Inventory days of cover',
    definition:
      'How many days current stock would last at the observed period sales velocity. It is blank when velocity is zero.',
    formula: 'current stock / (units sold / period days)',
    tool: 'analytics_get_inventory_reorder_risks',
  },
  {
    key: 'recommended_reorder_quantity',
    name: 'Recommended reorder quantity',
    definition:
      'Units needed to cover the stated supplier lead time plus safety-stock days at the observed sales velocity.',
    formula:
      'max(0, average daily sales × (lead-time days + safety-stock days) - current stock)',
    tool: 'analytics_get_inventory_reorder_risks',
  },
] as const;

/** Business rules that apply to every analytics answer. */
export const ANALYTICS_RULES: readonly {
  readonly title: string;
  readonly text: string;
}[] = [
  {
    title: 'Previous period',
    text: 'Comparisons always use the window of identical length immediately before the requested period, never the same period last year.',
  },
  {
    title: 'Money',
    text: 'Amounts are in major units (whole currency, two decimals) with an ISO currency code next to them. They are not minor units.',
  },
  {
    title: 'Client deduplication',
    text: 'New and returning clients are counted by phone number, so duplicate client cards for the same person do not double-count.',
  },
  {
    title: 'Lost-client threshold',
    text: 'A client counts as lost after the location’s inactivity threshold, 60 days by default. It is a per-location setting.',
  },
  {
    title: 'Occupancy source',
    text: 'Occupancy is measured against scheduled working time, so a team member with no schedule contributes no occupancy at all.',
  },
  {
    title: 'Period length',
    text: 'Analytics accepts at most 365 days per call. Longer questions have to be asked one year at a time.',
  },
  {
    title: 'Timezone',
    text: 'Period presets such as "yesterday" or "last_month" are resolved in the location’s own timezone.',
  },
  {
    title: 'Day-end report clamping',
    text: 'Without the right to widen the day-end report past today, the location silently gets today’s numbers instead of the requested date; the tool says so when it happens.',
  },
] as const;

/** What the API cannot answer — the `coverage` resource and error hints. */
export const COVERAGE_GAPS: readonly {
  readonly topic: string;
  readonly reason: string;
  readonly alternative: string;
}[] = [
  {
    topic: 'The report builder (custom and template report tables)',
    reason:
      'The Analytics Constructor is not switched on for Altegio: its report-data API fails for every report, and the one endpoint that answers ignores the requested period, so any table it produced would be all-time data under the wrong label.',
    alternative:
      'Use the stable curated reports, including the profit-and-loss statement, capacity heatmap, leakage analysis, team-member × service matrix and inventory reorder risks; use the metric tools for other supported questions.',
  },
  {
    topic: 'Custom report dimensions outside the curated stable reports',
    reason:
      'The ad-hoc Analytics Constructor is switched off and its available data route ignores requested periods.',
    alternative:
      'Use analytics_get_client_sales, analytics_get_service_profitability, analytics_get_team_member_sales or analytics_get_team_member_service_matrix when their fixed dimensions fit; otherwise name the gap.',
  },
  {
    topic: 'Team member dynamics over time',
    reason: 'The dedicated page is web-only.',
    alternative:
      'analytics_get_daily_series for the location trend, plus analytics_get_overview per team member across the two periods.',
  },
  {
    topic: 'Custom client retention cohorts',
    reason: 'Only the fixed team-member retention report is available.',
    alternative:
      'analytics_get_client_retention reports new, returning and eligible clients by team member, optionally for one service.',
  },
  {
    topic: 'Reviews and ratings analytics',
    reason: 'No owner-side endpoint exists.',
    alternative: 'None through this server.',
  },
  {
    topic: 'Stable identity in the per-client forecast export',
    reason:
      'The source workbook contains names and optional contacts but no client id; the server never guesses one.',
    alternative:
      'analytics_get_client_forecast returns the factors with client_id=null; analytics_get_forecast gives aggregate forecast versus actuals.',
  },
  {
    topic: 'Finance dashboard and account balances',
    reason: 'Balances have no endpoint.',
    alternative:
      'analytics_get_day_end_report shows takings per account, analytics_get_cash_flow_breakdown shows signed period movements, and analytics_get_profit_and_loss_statement shows the posted operating ledger and service contribution; none is an account-balance statement.',
  },
  {
    topic: 'Complete statutory profit, tax and cash-flow statements',
    reason:
      'The sources cannot prove that taxes, rent, external payroll, retail product cost and unposted expenses are complete.',
    alternative:
      'analytics_get_profit_and_loss_statement labels the available result as tracked operating result, exposes included and missing cost classes, and never mislabels it as net profit.',
  },
  {
    topic: 'Inventory valuation, reservations and last-sale dates',
    reason:
      'The turnover source exposes stock and sales movement but not authorized unit cost, reserved stock, available stock or last-sale date.',
    alternative:
      'analytics_get_inventory_reorder_risks provides velocity, days of cover and reorder recommendations while marking unavailable turnover fields explicitly; analytics_get_product_sales provides authorized product-sale cost and code fields where available.',
  },
  {
    topic: 'Payroll period sheets',
    reason: 'Only per-team-member payroll is exposed, and not by this pack.',
    alternative: 'None through this server.',
  },
  {
    topic: 'Online booking funnel',
    reason: 'No funnel data exists anywhere in the product.',
    alternative:
      'analytics_get_appointments_breakdown by source, and the online-booking series of analytics_get_daily_series, are the closest proxies.',
  },
  {
    topic: 'Client segments',
    reason: 'Reserved for Altegio internal use.',
    alternative: 'None.',
  },
  {
    topic: 'Chain-level analytics across locations',
    reason: 'Out of scope for this pack.',
    alternative: 'Call the tools once per location and add the numbers up.',
  },
] as const;
