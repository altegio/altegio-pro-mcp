/**
 * Tool-selection tasks for `npm run eval` (see `evals/README.md`).
 *
 * Each task is one realistic request from an owner or an administrator, and
 * the tools (any of `expect`) a good agent reaches to answer it. Reads run
 * against the test location; writes are refused by the read-only grant the
 * runner sends, after the agent has chosen and called the tool, which is what
 * is scored. `{location}` and `{team_member}` are filled from the environment.
 *
 * The runner derives each task's group from the views themselves:
 * - core: the tool is listed on `/mcp` and on `/mcp/compact`;
 * - dispatched: listed on `/mcp`, run through the dispatcher on `/mcp/compact`;
 * - beyond: not on `/mcp` at all, run through the dispatcher on `/mcp/compact`.
 */
export interface EvalTask {
  readonly id: string;
  readonly prompt: string;
  readonly expect: readonly string[];
}

export const TASKS: readonly EvalTask[] = [
  {
    id: 'journal-today',
    prompt: 'What appointments are there today at location {location}?',
    expect: ['appointments_list'],
  },
  {
    id: 'sales-last-month',
    prompt:
      'How did location {location} do last month — revenue, number of visits and the average check?',
    expect: ['analytics_get_overview'],
  },
  {
    id: 'team',
    prompt:
      'Who works at location {location}? List the team members with their specializations.',
    expect: ['team_members_list'],
  },
  {
    id: 'client-find',
    prompt: 'Find the clients called Anna at location {location}.',
    expect: ['clients_search', 'clients_lookup'],
  },
  {
    id: 'schedule-week',
    prompt:
      'Show the work schedule of team member {team_member} at location {location} for next week.',
    expect: ['schedules_get'],
  },
  {
    id: 'services-prices',
    prompt: 'List the services of location {location} with their prices.',
    expect: ['services_list'],
  },
  {
    id: 'free-slot',
    prompt:
      'When is the earliest free time tomorrow with team member {team_member} at location {location}, for any service they provide?',
    expect: ['appointments_find_free_slots'],
  },
  {
    id: 'book',
    prompt:
      'Book team member {team_member} at location {location} tomorrow at their first free time, for the first service they provide, for a new client named Eval Test with phone +420700000001.',
    expect: ['appointments_create'],
  },
  {
    id: 'lapsed-clients',
    prompt:
      'How many clients of location {location} have not visited for more than 90 days?',
    expect: ['clients_get_segment_report', 'clients_search'],
  },
  {
    id: 'expense',
    prompt:
      'Record an expense of 150 at location {location} from its first cash register, under the payment item for other expenses, with the comment "eval".',
    expect: ['financial_transactions_create'],
  },
  {
    id: 'payout',
    prompt:
      'Record a salary payout of 500 to team member {team_member} at location {location} from its first cash register.',
    expect: ['payroll_record_payout'],
  },
  {
    id: 'payroll-owed',
    prompt:
      'How much has team member {team_member} at location {location} earned this month, and how much is still owed to them?',
    expect: ['payroll_get_calculation'],
  },
  {
    id: 'transactions-yesterday',
    prompt: "List yesterday's financial transactions at location {location}.",
    expect: ['financial_transactions_list'],
  },
  {
    id: 'positions',
    prompt: 'Which positions exist at location {location}?',
    expect: ['positions_list'],
  },
  {
    id: 'membership-types',
    prompt: 'Which membership types does location {location} sell?',
    expect: ['memberships_list_types'],
  },
  {
    id: 'product-stock',
    prompt: 'How much shampoo is in stock at location {location}?',
    expect: ['products_search', 'inventory_list'],
  },
  {
    id: 'group-events',
    prompt:
      'Which group events are scheduled at location {location} next week?',
    expect: ['events_list'],
  },
  {
    id: 'categories',
    prompt: 'Which service categories does location {location} have?',
    expect: ['service_categories_list'],
  },
  {
    id: 'online-booking',
    prompt:
      'Is online booking turned on at location {location}? Show its settings.',
    expect: ['settings_get_online_booking'],
  },
  {
    id: 'tags',
    prompt: 'Which appointment tags are defined at location {location}?',
    expect: ['appointments_list_tags'],
  },
  {
    id: 'create-service',
    prompt:
      'Create a service called "Eval haircut" at location {location}, 30 minutes long, price 500.',
    expect: ['services_create'],
  },
  {
    id: 'rename-specialization',
    prompt:
      'Change the specialization of team member {team_member} at location {location} to "Senior stylist".',
    expect: ['team_members_update'],
  },
  {
    id: 'cash-registers',
    prompt: 'Which accounts and cash registers does location {location} have?',
    expect: ['accounts_and_cash_registers_list'],
  },
  {
    id: 'daily-revenue',
    prompt:
      'Show the day-by-day revenue of location {location} for the last 14 days.',
    expect: ['analytics_get_daily_series', 'analytics_get_daily_summary'],
  },
  {
    id: 'retention',
    prompt:
      'What share of clients came back to location {location} over the last quarter?',
    expect: ['analytics_get_client_retention'],
  },
  {
    id: 'occupancy',
    prompt: 'How loaded was each team member at location {location} last week?',
    expect: [
      'analytics_get_team_member_occupancy',
      'analytics_get_team_workload',
      'analytics_get_team_member_capacity',
    ],
  },
  {
    id: 'membership-freeze-rights',
    prompt:
      'Which chains can I manage memberships in, and do I have the right to freeze memberships there?',
    expect: ['memberships_list_chains'],
  },
  {
    id: 'onboarding-status',
    prompt: 'Where did the setup wizard stop for location {location}?',
    expect: ['onboarding_status', 'onboarding_resume'],
  },
];
