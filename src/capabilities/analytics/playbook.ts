/**
 * Analytics playbook — the reasoning layer over the analytics pack.
 *
 * The metric registry says what each number *is*; this module says how to
 * *reason* with the numbers when analysing a location: how metrics decompose
 * into one another, which tool answers which question, what to slice by, and the
 * order to investigate a symptom in. It exists because a weak model can read a
 * revenue figure and still have no idea that revenue moved because traffic
 * moved, not because the average check did — the identities and decision trees
 * below make that decomposition explicit instead of leaving it to be guessed.
 *
 * It is data plus one renderer, exactly like the metric registry, so the
 * `altegio://analytics/playbook` resource and any tool description quote the
 * same wording, and the terminology test can scan it for legacy vocabulary.
 *
 * Canonical vocabulary only. Every metric key referenced here also appears in
 * `metrics-registry.ts`; the two are kept consistent by hand and by the
 * `playbook.test.ts` cross-check.
 */

/**
 * An identity or near-identity between metrics. The point is decomposition: when
 * one side moves, the analyst knows which parts to look at to explain it.
 */
export interface MetricRelationship {
  /** Short name of the relationship. */
  readonly title: string;
  /** The identity, written with canonical field keys. */
  readonly identity: string;
  /** What the decomposition tells an analyst to do. */
  readonly use: string;
}

export const METRIC_RELATIONSHIPS: readonly MetricRelationship[] = [
  {
    title: 'Revenue splits into traffic and spend',
    identity:
      'revenue_total ≈ clients_active × average_check  (money = how many came × how much each left)',
    use: 'When revenue moves, decide first whether it was traffic (clients_active, visits_count) or spend (average_check). They move independently, and the fix differs: traffic is a marketing and retention problem, average check is a pricing, up-sell and service-mix problem.',
  },
  {
    title: 'Revenue splits into what was sold',
    identity:
      'revenue_total = revenue_services + revenue_products + revenue_memberships + revenue_gift_cards + client_account_top_ups',
    use: 'A revenue change with a flat average check is usually a mix change. Run "Revenue by service" and "Product sales analysis" to see which line moved, and watch average_services_check next to average_check so product sales do not disguise a drop in service spend.',
  },
  {
    title: 'Appointments are not visits',
    identity:
      'appointments_total = visits (arrived) + no_show + cancelled + waiting  ·  attendance_rate_percent = visits_count / appointments_with_client_count × 100',
    use: 'Only arrived appointments become revenue. A healthy appointment count with weak revenue points at the attendance gap: check the no_show and cancelled shares in analytics_get_appointments_breakdown by visit_status before blaming price or traffic.',
  },
  {
    title: 'Occupancy is booked time over scheduled time',
    identity:
      'occupancy_percent = booked_hours / scheduled_hours × 100  ·  idle_hours = scheduled_hours − booked_hours',
    use: 'Low occupancy on a full schedule is a demand problem (fill it with marketing, online booking, promotions). Zero occupancy with no schedule is a data problem, not idleness — a team member with no work schedule contributes no scheduled time at all. Always read occupancy next to scheduled_hours.',
  },
  {
    title: 'Active clients split into new and returning',
    identity:
      'clients_active = new_clients_count + returning_clients_count  ·  new_clients_share_percent = new_clients_count / clients_active × 100',
    use: 'Growth from new clients and growth from returning clients need opposite actions. A high new share with flat revenue means poor retention — cross-check the returning trend and the "Client retention" template. lost_clients is measured against the whole client base, not against active clients, so it moves slowly.',
  },
  {
    title: 'The front desk drives next period’s returning clients',
    identity:
      'returning_clients (next period) ← rebooked_after_visit  ·  recovered clients ← rebooked_after_no_show',
    use: 'Rebooking is the lever between this period’s visits and next period’s traffic. Weak returning-client numbers with healthy visits usually trace back to a low rebooking rate at checkout — see analytics_get_receptionist_performance.',
  },
  {
    title: 'Money taken splits from money earned',
    identity:
      'takings_by_account (cash vs non-cash, per account) + write_offs (discounts, bonuses, memberships, gift cards) reconcile the day-end report against revenue_total',
    use: 'Revenue can be booked without cash arriving: discounts and loyalty write-offs, memberships and gift cards redeemed, or top-ups spent later. When "we sold a lot but the till is light", read analytics_get_day_end_report — takings_by_account is real money in, write_offs is value given away.',
  },
] as const;

/**
 * A symptom-driven investigation: the order of tool calls that explains a
 * business question, and what the result means once you have it.
 */
export interface DiagnosticPlay {
  /** The owner’s complaint or question, in their words. */
  readonly symptom: string;
  /** The ordered steps, each a tool call with the reason for it. */
  readonly steps: readonly string[];
  /** How to read the result — the conclusion the steps are meant to reach. */
  readonly read: string;
}

export const DIAGNOSTIC_PLAYS: readonly DiagnosticPlay[] = [
  {
    symptom: 'Revenue is down versus the previous period',
    steps: [
      'analytics_get_overview — read revenue_total, average_check and clients_active together, each against the previous period, to split the drop into traffic versus spend.',
      'analytics_get_daily_series with metric=revenue — was it one bad week or a steady decline? Name the worst days.',
      'analytics_get_appointments_breakdown by visit_status — did the no_show or cancelled share rise and eat the revenue that was booked?',
      'analytics_run_report on "Revenue by service" and "Revenue by team member" — which part of the business actually moved.',
    ],
    read: 'Attribute the change to one of: fewer clients (traffic), lower average check (spend), a worse attendance rate (leakage), or a shift in service mix. Report the absolute money next to the percentage — a 5% fall on the main service line matters more than a 40% fall on a tiny one.',
  },
  {
    symptom: 'The team looks busy but occupancy is low, or capacity is wasted',
    steps: [
      'analytics_run_report on the "Occupancy" template — scheduled, booked and idle hours per team member, with occupancy_percent.',
      'analytics_get_team_member_occupancy for the two or three people who look unusual — the day-by-day pattern.',
      'analytics_get_daily_series with metric=occupancy — the location-wide booked share and the no-show share of working time.',
    ],
    read: 'Separate three causes: no schedule (occupancy is blank, fix the schedule, not the marketing), a full schedule with empty slots (demand — fill it), and time lost to no-shows (occupancy_no_show_percent — a front-desk and reminder problem). Idle hours are the size of the opportunity.',
  },
  {
    symptom: 'We are losing clients / retention feels weak',
    steps: [
      'analytics_get_overview — new_count, returning_count, active_count and lost_count together; is growth leaning on new clients while returning stalls?',
      'analytics_run_report on the "Client retention" template — new versus returning and the share that comes back.',
      'analytics_get_receptionist_performance — the rebooking rate after a visit and after a no-show, the lever that turns a visit into a return.',
    ],
    read: 'Low returning numbers with healthy new numbers is a retention leak, and the cheapest fix is usually rebooking at checkout, not more acquisition. Remember lost_clients is a share of the whole base and lags by the location’s inactivity threshold (60 days by default).',
  },
  {
    symptom: 'High no-show or cancellation rate',
    steps: [
      'analytics_get_appointments_breakdown by visit_status — the no_show and cancelled shares of all appointments.',
      'analytics_get_daily_series with metric=occupancy — occupancy_no_show_percent shows how much scheduled time the no-shows burn.',
      'analytics_get_receptionist_performance — rebooked_after_no_show, whether the front desk wins those clients back.',
    ],
    read: 'Quantify the leak as lost working time and lost revenue (no_show share × average_check × visits). No-shows are a reminder-and-prepayment problem; cancellations that get rebooked are far less costly than ones that do not.',
  },
  {
    symptom: 'Where do bookings come from / is online booking growing',
    steps: [
      'analytics_get_appointments_breakdown by source — online booking, the client app, a receptionist, the API.',
      'analytics_get_daily_series with metric=appointments — the online-booking series against the total over time.',
    ],
    read: 'A rising receptionist share and flat online share means self-service is not catching on — a booking-channel problem, not a demand problem. There is no online-booking funnel anywhere in the product, so this split by source is the closest proxy for it.',
  },
  {
    symptom: 'Full location health check (no specific complaint)',
    steps: [
      'analytics_get_overview for the period — the headline: revenue, average check, occupancy, appointment outcomes, client mix, each versus the previous period.',
      'analytics_get_daily_series with metric=revenue — the shape of the period and its weekly rhythm.',
      'analytics_get_appointments_breakdown by source, then by visit_status — where demand comes from and how much of it leaks.',
      'analytics_run_report on "Revenue by team member" and "Revenue by service" — the two tables that explain the headline.',
    ],
    read: 'Close with three to five sentences an owner can act on: what grew, what shrank, what is leaking (no-shows, cancellations, idle time), and the single change with the largest expected effect. Say plainly when a module is off or an access right is missing rather than guessing a number.',
  },
] as const;

/**
 * A common owner question mapped to the tool that answers it directly, so the
 * model reaches for the curated tool instead of the executor or a guess.
 */
export interface QuestionRoute {
  readonly question: string;
  readonly tool: string;
}

export const QUESTION_ROUTES: readonly QuestionRoute[] = [
  {
    question: 'How did we do last month / is revenue up',
    tool: 'analytics_get_overview',
  },
  {
    question: 'What is our average check (average ticket)',
    tool: 'analytics_get_overview',
  },
  {
    question: 'How many new clients did we get',
    tool: 'analytics_get_overview',
  },
  {
    question: 'Which day was busiest / how did sales move through the month',
    tool: 'analytics_get_daily_series',
  },
  {
    question: 'How much of our time do no-shows burn',
    tool: 'analytics_get_daily_series (metric=occupancy)',
  },
  {
    question: 'What is our no-show or cancellation rate',
    tool: 'analytics_get_appointments_breakdown (group_by=visit_status)',
  },
  {
    question: 'How many bookings came from the website',
    tool: 'analytics_get_appointments_breakdown (group_by=source)',
  },
  {
    question: 'Who at the front desk books the most / do we rebook clients',
    tool: 'analytics_get_receptionist_performance',
  },
  {
    question: 'Is the loyalty program bringing people back',
    tool: 'analytics_get_loyalty_program_results',
  },
  {
    question: 'Are we on track this month / what should we expect',
    tool: 'analytics_get_forecast',
  },
  {
    question: 'What did we take today / how much cash is in the till',
    tool: 'analytics_get_day_end_report',
  },
  {
    question: 'Who has free capacity this week / is anyone overloaded',
    tool: 'analytics_get_team_member_occupancy',
  },
  {
    question: 'Is this client reliable / how much have they spent',
    tool: 'analytics_get_client_visit_stats',
  },
  {
    question: 'Revenue by team member / by service / by client',
    tool: 'analytics_run_report (template)',
  },
  {
    question: 'Income and expenses / P&L / cash flow',
    tool: 'analytics_run_report (financial_transactions templates)',
  },
  {
    question: 'Something none of the above covers',
    tool: 'analytics_list_report_templates, then analytics_run_report',
  },
] as const;

/**
 * What an analytics answer can be sliced by, and the constraints on the slice.
 * These are the filters the analytics tools accept, gathered in one place so the
 * model does not have to reconstruct them from individual tool schemas.
 */
export interface SlicingNote {
  readonly dimension: string;
  readonly how: string;
}

export const SLICING_NOTES: readonly SlicingNote[] = [
  {
    dimension: 'Period',
    how: 'Every tool takes either a preset (today, yesterday, this_week, last_week, this_month, last_month, last_30_days, this_quarter, last_quarter, this_year) or an explicit date_from + date_to in YYYY-MM-DD. Presets resolve in the location’s own timezone. At most 365 days per call. Prefer a preset over hand-computed dates.',
  },
  {
    dimension: 'Comparison',
    how: 'Every period result carries the previous period of equal length immediately before it — a 7-day period compares with the 7 days before, never the same week last year. For a year-on-year or seasonal comparison, call analytics_get_overview twice with explicit date_from/date_to (this year and last year) and compare them yourself.',
  },
  {
    dimension: 'Team member',
    how: 'team_member_id narrows most tools to one person; position_id narrows to everyone holding a position (every stylist, say). analytics_get_team_member_occupancy takes up to ten ids at once.',
  },
  {
    dimension: 'Receptionist / creator',
    how: 'created_by_user_id restricts to appointments a single location user created — the way front-desk performance is attributed, and the way a receptionist without the Analytics right reads only their own numbers.',
  },
  {
    dimension: 'Group-by (report builder)',
    how: 'analytics_run_report groups a dataset by any dimension field key (team_member_name, service_or_product, client_name, account, appointment_source, …) and can add a day/week/month/year time bucket via granularity. Get the field keys from analytics_list_report_fields.',
  },
  {
    dimension: 'Dataset (report builder)',
    how: 'Four datasets scope what can be reported: sales (services and products, visits, clients, occupancy, group events, margin), financial_transactions (income and expenses, cash vs non-cash, accounts), loyalty (memberships and gift cards), team_member_schedules (scheduled, booked and idle hours).',
  },
  {
    dimension: 'Scope',
    how: 'Everything is one location. There is no chain-wide roll-up — call the tools once per location and add the numbers up.',
  },
] as const;

/**
 * Analysis technique and traps that are specific to *reasoning*, beyond the
 * per-metric rules in the glossary (previous period, money units, phone
 * deduplication, the lost-client threshold, occupancy source, timezone, day-end
 * clamping — all in `altegio://analytics/glossary`).
 */
export interface AnalysisNote {
  readonly title: string;
  readonly text: string;
}

export const ANALYSIS_NOTES: readonly AnalysisNote[] = [
  {
    title: 'Decompose before you conclude',
    text: 'Never report a headline movement without splitting it with the identities above. "Revenue is down 12%" is not an insight; "revenue is down 12% because visits fell 15% while the average check held" is.',
  },
  {
    title: 'Absolute next to relative',
    text: 'A big percentage on a small base is not the same story as a small percentage on the main revenue line. Always report the money next to the percent, and a change_percent of null means the previous value was zero, so no percentage exists.',
  },
  {
    title: 'A change is not a cause',
    text: 'The tools show what moved, not why. When two metrics move together, name the likely mechanism from the relationships above and, where you can, confirm it with a second tool rather than asserting causation.',
  },
  {
    title: 'Missing is not zero',
    text: 'A switched-off module (forecast), a missing access right (day-end report, Analytics), or an absent work schedule (occupancy) returns nothing or a clamped value, not a true zero. Say so plainly instead of reporting the empty result as a bad number.',
  },
  {
    title: 'Running a report leaves a footprint',
    text: 'analytics_run_report keeps exactly one assistant-owned report per shape in the location’s report builder (named "[Altegio Assistant] …"), reused across runs; the period travels per run. It never touches a report the owner made.',
  },
] as const;
