/**
 * Analytics vocabulary — the ONLY place in the analytics pack where legacy API
 * words are allowed to appear.
 *
 * Everything the agent sees (tool names, parameters, result fields, texts,
 * resources, prompts) uses the canonical product vocabulary. The v1 API and the
 * report-builder column registry speak a legacy dialect (`master`, `goods`,
 * `abonement`, `fullness`, `income`, `record`, …); this module maps that dialect
 * to canonical terms once, on the way out.
 *
 * Sources of truth, in precedence order:
 *  1. `product-glossary.md` in the backend repository — canonical English terms
 *     and forbidden synonyms.
 *  2. `translations/glossary/terminology.md` — localized forms and metric names.
 *  3. The V3 OpenAPI contract — object model and enums (`AppointmentStatus`).
 *  4. ADR-001 §5 tool design rules.
 *
 * Two terminology decisions worth calling out, both taken from source 1/2
 * against an earlier draft that proposed different words:
 *  - the average-sale metric is **average check** (`average_bill` is listed as a
 *    forbidden synonym), and
 *  - the visit-status enum is the V3 `AppointmentStatus` set, whose "booked but
 *    unresolved" case is `waiting` (not `pending`).
 */

/**
 * Legacy → canonical term table. Documentation for humans, and the data behind
 * the `altegio://analytics/glossary` resource's terminology section.
 */
export interface TermMapping {
  /** How the API or the column registry spells it. */
  readonly legacy: string;
  /** The only spelling allowed outside this module. */
  readonly canonical: string;
  readonly note?: string;
}

export const TERM_MAPPINGS: readonly TermMapping[] = [
  { legacy: 'company / salon / salonId', canonical: 'location / location_id' },
  {
    legacy: 'staff / master / employee',
    canonical: 'team_member / team_member_id',
    note: 'v1 accepts team_member_id as a query alias, so no legacy name goes on the wire',
  },
  {
    legacy: 'user_id (the ERP user who created the appointment)',
    canonical: 'created_by_user_id',
    note: 'a location user, usually a receptionist',
  },
  {
    legacy: 'administrator analytics',
    canonical: 'receptionist performance',
  },
  { legacy: 'record / records', canonical: 'appointment / appointments' },
  {
    legacy: 'attendance / record_status',
    canonical: 'visit_status',
    note: 'waiting | confirmed | arrived | no_show | cancelled',
  },
  {
    legacy: 'fullness / workload',
    canonical: 'occupancy_percent',
  },
  {
    legacy: 'income_*',
    canonical: 'revenue_*',
    note: 'money from services, products, memberships, gift cards and client account top-ups',
  },
  {
    legacy: 'income_average / AOV / average bill',
    canonical: 'average_check',
    note: 'the product glossary lists "average bill" as a forbidden synonym',
  },
  { legacy: 'goods / good', canonical: 'products / product' },
  { legacy: 'abonement / abon', canonical: 'membership' },
  { legacy: 'certificate', canonical: 'gift_card' },
  {
    legacy: 'deposit / refill',
    canonical: 'client_account / client_account_top_up',
  },
  { legacy: 'z_report', canonical: 'day_end_report' },
  { legacy: 'statistics', canonical: 'analytics' },
  { legacy: 'activity', canonical: 'group_event' },
  { legacy: 'fired', canonical: 'dismissed' },
  { legacy: 'cashless', canonical: 'non_cash' },
  { legacy: 'cash register (as a money store)', canonical: 'account' },
  {
    legacy: 'RFM overall',
    canonical: 'forecast',
    note: 'the endpoint compares a revenue and visits forecast with the actuals; it is not RFM segmentation',
  },
] as const;

/**
 * Words that must never appear in an outward-facing identifier or text.
 * The terminology test scans every tool name, schema property, description,
 * resource and prompt string for them.
 */
export const FORBIDDEN_WORDS: readonly string[] = [
  'staff',
  'master',
  'employee',
  'company',
  'salon',
  'record',
  'goods',
  'abonement',
  'certificate',
  'deposit',
  'fullness',
  'administrator',
  'statistics',
  'z_report',
  'z-report',
  'average bill',
  'average_bill',
  'cashless',
  'fired',
] as const;

/**
 * Words that are legitimate despite containing a forbidden substring
 * (`recording` contains `record`, `mastercard` contains `master`, …).
 */
const FORBIDDEN_WORD_EXCEPTIONS: readonly string[] = [
  'recorded',
  'recording',
] as const;

/**
 * Find forbidden words in a piece of outward-facing text.
 * Matching is case-insensitive and respects word boundaries, so `arrived`
 * does not match `rive` and `products` does not match `duct`.
 */
export function findForbiddenWords(text: string): string[] {
  const haystack = text.toLowerCase();
  const found = new Set<string>();
  for (const word of FORBIDDEN_WORDS) {
    // Treat snake_case, kebab-case and spaces as word separators.
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[^a-z])${escaped}(s|es)?($|[^a-z])`, 'g');
    for (const match of haystack.matchAll(pattern)) {
      const hit = match[0] ?? '';
      if (FORBIDDEN_WORD_EXCEPTIONS.some((ok) => hit.includes(ok))) continue;
      found.add(word);
    }
  }
  return [...found];
}

/**
 * Ordered word replacements applied to human-readable labels that arrive from
 * the API (report template names, column titles, account titles, …).
 *
 * Longest / most specific first: `Cash register report` must be rewritten
 * before the bare `Cash register`.
 */
const LABEL_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\brevenue by cash registers\b/gi, 'Revenue by account'],
  [/\bcash register report\b/gi, 'Daily sales report'],
  [/\bcash register operations\b/gi, 'Account operations'],
  [/\bcash registers\b/gi, 'accounts'],
  [/\bcash register\b/gi, 'account'],
  [/\bemployee schedules\b/gi, 'Team member schedules'],
  [/\bemployee dynamics\b/gi, 'Team member dynamics'],
  [/\bemployees\b/gi, 'team members'],
  [/\bemployee\b/gi, 'team member'],
  [/\bmasters\b/gi, 'team members'],
  [/\bmaster\b/gi, 'team member'],
  [/\bstaff\b/gi, 'team'],
  [/\bgoods and services\b/gi, 'Services and products'],
  [/\bgoods\b/gi, 'products'],
  [/\babonements\b/gi, 'memberships'],
  [/\babonement\b/gi, 'membership'],
  [/\bsubscriptions\b/gi, 'memberships'],
  [/\bsubscription\b/gi, 'membership'],
  [/\bcertificates\b/gi, 'gift cards'],
  [/\bcertificate\b/gi, 'gift card'],
  [/\brecord sources\b/gi, 'Appointment sources'],
  [/\brecords\b/gi, 'appointments'],
  [/\brecord\b/gi, 'appointment'],
  [/\bdeposits\b/gi, 'client account top-ups'],
  [/\bdeposit\b/gi, 'client account top-up'],
  [/\bfullness\b/gi, 'occupancy'],
  [/\bworkload\b/gi, 'occupancy'],
  [/\badministrators\b/gi, 'receptionists'],
  [/\badministrator\b/gi, 'receptionist'],
  [/\bstatistics\b/gi, 'analytics'],
  [/\bsalons\b/gi, 'locations'],
  [/\bsalon\b/gi, 'location'],
  [/\bcompanies\b/gi, 'locations'],
  [/\bcompany\b/gi, 'location'],
  [/\bcashless\b/gi, 'non-cash'],
  [/\bfired\b/gi, 'dismissed'],
  [/\bactivity\b/gi, 'group event'],
  [/\bactivities\b/gi, 'group events'],
  [/\bincome\b/gi, 'revenue'],
];

function capitalize(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

function startsUpperCase(text: string): boolean {
  const first = text.charAt(0);
  return first !== '' && first === first.toUpperCase();
}

/**
 * Rewrite an API-sourced label into canonical vocabulary.
 * Keeps the original capitalization style of the first character.
 */
export function canonicalizeLabel(label: string): string {
  let out = label;
  for (const [pattern, replacement] of LABEL_REPLACEMENTS) {
    out = out.replace(pattern, (match) =>
      startsUpperCase(match)
        ? capitalize(replacement)
        : replacement.toLowerCase()
    );
  }
  return out;
}

// ========== Visit status ==========

/** Canonical visit statuses (V3 `AppointmentStatus`). */
export const VISIT_STATUSES = [
  'waiting',
  'confirmed',
  'arrived',
  'no_show',
  'cancelled',
] as const;

export type VisitStatus = (typeof VISIT_STATUSES)[number];

/** v1 `attendance` integer codes → canonical visit status. */
const VISIT_STATUS_BY_LEGACY_CODE: Readonly<Record<number, VisitStatus>> = {
  [-1]: 'no_show',
  0: 'waiting',
  1: 'arrived',
  2: 'confirmed',
};

export function visitStatusFromLegacyCode(code: number): VisitStatus | null {
  return VISIT_STATUS_BY_LEGACY_CODE[code] ?? null;
}

/** Canonical visit status → the v1 `attendance` code the API filters on. */
export function visitStatusToLegacyCode(status: VisitStatus): number | null {
  for (const [code, mapped] of Object.entries(VISIT_STATUS_BY_LEGACY_CODE)) {
    if (mapped === status) return Number(code);
  }
  return null;
}

/**
 * The visit-status pie chart is label-only: the API returns localized status
 * names with no slug. Match the English labels (the adapter always asks for
 * `Accept-Language: en`) on keywords, so wording changes do not break the map.
 */
export function visitStatusFromLabel(label: string): VisitStatus | null {
  const text = label.toLowerCase();
  if (/(did ?n[o']?t come|no[ -]?show|absent)/.test(text)) return 'no_show';
  if (/(cancel|delet)/.test(text)) return 'cancelled';
  if (/(came|arriv|attend)/.test(text)) return 'arrived';
  if (/confirm/.test(text)) return 'confirmed';
  if (/(expectation|waiting|pending|expect)/.test(text)) return 'waiting';
  return null;
}

// ========== Appointment source ==========

export const APPOINTMENT_SOURCES = [
  'receptionist',
  'receptionist_mobile_app',
  'admin_api',
  'online_booking_widget',
  'client_app',
  'api',
  'other',
] as const;

export type AppointmentSource = (typeof APPOINTMENT_SOURCES)[number];

/**
 * Appointment-source labels are partly free text (booking-form titles, partner
 * names), so only the well-known ones map to a canonical key; the rest stay
 * `other` and keep their original label.
 */
export function appointmentSourceFromLabel(label: string): AppointmentSource {
  const text = label.toLowerCase();
  if (/mobile app/.test(text) && /(receptionist|administrator|admin)/.test(text))
    return 'receptionist_mobile_app';
  if (/(admin api|administrator api)/.test(text)) return 'admin_api';
  if (/^(receptionist|administrator)$/.test(text.trim())) return 'receptionist';
  if (/(widget|booking form|website)/.test(text)) return 'online_booking_widget';
  if (/(client app|mobile app)/.test(text)) return 'client_app';
  if (/^api$/.test(text.trim())) return 'api';
  return 'other';
}

// ========== Report-builder datasets ==========

export const DATASETS = [
  'sales',
  'financial_transactions',
  'loyalty',
  'team_member_schedules',
] as const;

export type Dataset = (typeof DATASETS)[number];

/** Canonical dataset → the legacy `table_name` of the column registry. */
export const DATASET_TABLE: Readonly<Record<Dataset, string>> = {
  sales: 'olap_services_goods',
  financial_transactions: 'olap_financial_transactions',
  loyalty: 'olap_loyalty',
  team_member_schedules: 'olap_masters_schedules',
};

export const DATASET_DESCRIPTIONS: Readonly<Record<Dataset, string>> = {
  sales: 'Services and products sold: revenue, appointments, visits, clients, occupancy, group events, product margin.',
  financial_transactions:
    'Income and expenses cash flow: revenue and expense items, cash and non-cash settlement, accounts, suppliers.',
  loyalty:
    'Memberships and gift cards: units sold, revenue, remaining value, used and remaining services, expiry buckets.',
  team_member_schedules:
    'Team member schedules: scheduled, booked and idle hours, occupancy, working days, future appointments.',
};

export function datasetFromTable(tableName: string): Dataset | null {
  for (const dataset of DATASETS) {
    if (DATASET_TABLE[dataset] === tableName) return dataset;
  }
  return null;
}

// ========== Column name → canonical field key ==========

/**
 * Explicit field keys for the curated metrics and dimensions a business owner
 * actually picks. Anything not listed here falls back to the mechanical
 * renaming below, so a new column added to the registry still gets a canonical
 * key without a code change.
 */
const FIELD_KEY_OVERRIDES: Readonly<Record<string, string>> = {
  // sales — revenue
  sales_revenue: 'revenue_total',
  services_sales_revenue: 'revenue_services',
  goods_sales_revenue: 'revenue_products',
  abonement_sales_revenue: 'revenue_memberships',
  certificate_sales_revenue: 'revenue_gift_cards',
  activity_paid_sum: 'revenue_group_events',
  future_records_service_revenue: 'revenue_future_appointments',
  paid_sum: 'paid_in_money',
  percent_of_cost: 'share_of_total_revenue_percent',
  // sales — payment split
  discount_paid_sum: 'paid_by_discount',
  bonus_paid_sum: 'paid_by_bonus',
  abonement_paid_sum: 'paid_by_membership',
  certificate_paid_sum: 'paid_by_gift_card',
  deposit_paid_sum: 'paid_from_client_account',
  loyalty_paid_sum: 'paid_by_loyalty',
  // sales — averages
  record_aov: 'average_check_per_appointment',
  visit_aov: 'average_check_per_visit',
  goods_aov: 'average_check_products',
  service_aov: 'average_check_services',
  service_avg_sales_price: 'average_service_price',
  goods_avg_sales_price: 'average_product_price',
  client_avg_value: 'average_revenue_per_client',
  days_avg_value: 'average_revenue_per_day',
  record_avg_length: 'average_appointment_duration',
  service_avg_length: 'average_service_duration',
  // sales — counts and rates
  records_cnt: 'appointments_count',
  records_with_clients_cnt: 'appointments_with_client_count',
  records_without_clients_cnt: 'appointments_without_client_count',
  records_activity_cnt: 'group_event_appointments_count',
  visits_cnt: 'visits_count',
  visits_loyalty_paid_cnt: 'visits_paid_by_loyalty_count',
  record_success_pct: 'attendance_rate_percent',
  clients_cnt: 'clients_count',
  unique_clients_cnt: 'unique_clients_count',
  unique_new_clients_cnt: 'new_clients_count',
  new_clients_share: 'new_clients_share_percent',
  unique_repeat_clients_cnt: 'returning_clients_count',
  services_provided_cnt: 'services_rendered_count',
  services_provided_percent: 'services_rendered_percent',
  goods_sold_cnt: 'products_sold_count',
  abonements_sold_cnt: 'memberships_sold_count',
  certificates_sold_cnt: 'gift_cards_sold_count',
  indiv_services_paid_loyalty_cnt: 'services_paid_by_loyalty_count',
  goods_loyalty_paid_sales_cnt: 'products_paid_by_loyalty_count',
  clients_came: 'clients_arrived_count',
  // sales — group events
  activity_capacity: 'group_event_capacity',
  activity_capacity_total: 'group_event_capacity_total',
  activity_fill_share: 'group_event_fill_percent',
  activity_success_fill_share: 'group_event_attended_fill_percent',
  activity_paid_fill_share: 'group_event_paid_fill_percent',
  activity_success_record_cnt: 'group_event_attended_appointments_count',
  activity_paid_record_cnt: 'group_event_paid_appointments_count',
  activity_cash_record_cnt: 'group_event_cash_appointments_count',
  group_services_paid_loyalty_cnt: 'group_services_paid_by_loyalty_count',
  // sales — product margin and labour
  goods_actual_cost: 'products_cost_price',
  goods_margin_sum: 'products_margin',
  goods_margin_pct: 'products_margin_percent',
  record_work_hours: 'worked_hours',
  master_hour_revenue: 'revenue_per_worked_hour',
  // financial transactions
  money_profit_total: 'income_total',
  money_profit_services: 'income_services',
  money_profit_products: 'income_products',
  money_profit_memberships: 'income_memberships',
  money_profit_gift_cards: 'income_gift_cards',
  money_profit_refill: 'income_client_account_top_ups',
  money_profit_other_income: 'income_other',
  money_profit_cash: 'income_cash',
  money_profit_cashless: 'income_non_cash',
  money_expenses_total: 'expenses_total',
  money_expenses_salary: 'expenses_payroll',
  money_expenses_products: 'expenses_products',
  money_expenses_consumables: 'expenses_consumables',
  money_expenses_taxes: 'expenses_taxes',
  money_expenses_acquiring: 'expenses_acquiring_fee',
  money_expenses_other: 'expenses_other',
  money_expenses_cash: 'expenses_cash',
  money_expenses_cashless: 'expenses_non_cash',
  money_total: 'transactions_total',
  money_total_cash: 'transactions_total_cash',
  money_total_cashless: 'transactions_total_non_cash',
  expenses_title: 'expense_item',
  account_title: 'account',
  sales_type_title: 'sales_type',
  supplier_title: 'supplier',
  user_role_name: 'user_role',
  is_acquiring: 'is_acquiring',
  is_cashless: 'is_non_cash',
  // loyalty
  ab_ce_cnt: 'memberships_and_gift_cards_sold_count',
  ab_cnt: 'memberships_sold_count',
  ce_cnt: 'gift_cards_sold_count',
  total_cost_ab_ce: 'memberships_and_gift_cards_revenue',
  total_cost_of_active_ab_ce: 'active_memberships_and_gift_cards_value',
  money_remain_ab_ce: 'memberships_and_gift_cards_remaining_value',
  money_remain_active_ab_ce: 'active_memberships_remaining_value',
  money_remain_end_ab_ce: 'expired_memberships_remaining_value',
  money_remain_freezed_ab_ce: 'frozen_memberships_remaining_value',
  money_paid_ab_ce: 'memberships_and_gift_cards_paid',
  money_paid_active_ab_ce: 'active_memberships_paid',
  used_services_cnt_ab: 'membership_services_used_count',
  used_services_cnt_active_ab: 'active_membership_services_used_count',
  remain_services_cnt_ab: 'membership_services_remaining_count',
  remain_services_cnt_active_ab: 'active_membership_services_remaining_count',
  default_services_cnt_ab: 'membership_services_included_count',
  default_active_abon_services_cnt: 'active_membership_services_included_count',
  loyalty_type_value: 'loyalty_type',
  abon_cert_title: 'membership_or_gift_card_title',
  status_value: 'status',
  expiration_date: 'expiration_date',
  // team member schedules
  record_activity_work_hours: 'booked_hours',
  schedule_work_hours: 'scheduled_hours',
  free_work_hours: 'idle_hours',
  fullness: 'occupancy_percent',
  work_days: 'working_days',
  future_record_cnt: 'future_appointments_count',
  future_activity_cnt: 'future_group_events_count',
  num_records: 'appointments',
  num_activities: 'group_events',
  num_services_provided: 'services_rendered',
  record_length: 'appointment_duration',
  activity_length: 'group_event_duration',
  schedule_length: 'scheduled_duration',
  // shared dimensions
  master_id: 'team_member_id',
  master_name: 'team_member_name',
  master_position: 'position',
  master_specialization: 'specialization',
  master_deleted: 'team_member_deleted',
  master_fired: 'team_member_dismissed',
  service_goods_title: 'service_or_product',
  service_goods_category_title: 'service_or_product_category',
  visit_attendance_value: 'visit_status',
  record_label: 'appointment_label',
  record_source_title: 'appointment_source',
  record_deleted: 'appointment_deleted',
  record_date: 'appointment_date',
  record_cdate: 'appointment_created_at',
  has_operative_record: 'has_operative_appointment',
  client_first_record_date: 'client_first_appointment_date',
  cdate: 'created_at',
  created: 'created_at',
};

/** Mechanical token rewrites for columns without an explicit override. */
const FIELD_KEY_TOKEN_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^masters_/, 'team_members_'],
  [/^master_/, 'team_member_'],
  [/_master_/g, '_team_member_'],
  [/_master$/, '_team_member'],
  [/^records_/, 'appointments_'],
  [/^record_/, 'appointment_'],
  [/_records_/g, '_appointments_'],
  [/_record_/g, '_appointment_'],
  [/_records$/, '_appointments'],
  [/_record$/, '_appointment'],
  [/^goods_/, 'products_'],
  [/_goods_/g, '_products_'],
  [/_goods$/, '_products'],
  [/^good_/, 'product_'],
  [/^abonements?_/, 'memberships_'],
  [/_abonements?_/g, '_memberships_'],
  [/_abonements?$/, '_memberships'],
  [/^abon_/, 'membership_'],
  [/^certificates?_/, 'gift_cards_'],
  [/_certificates?_/g, '_gift_cards_'],
  [/_certificates?$/, '_gift_cards'],
  [/^income_/, 'revenue_'],
  [/_income_/g, '_revenue_'],
  [/_income$/, '_revenue'],
  [/^deposit_/, 'client_account_'],
  [/_deposit$/, '_client_account'],
  [/^fullness/, 'occupancy'],
  [/_fullness/g, '_occupancy'],
  [/cashless/g, 'non_cash'],
  [/_fired$/, '_dismissed'],
  [/^activity_/, 'group_event_'],
  [/_activity_/g, '_group_event_'],
  [/_activity$/, '_group_event'],
  [/^salon_/, 'location_'],
  [/^company_/, 'location_'],
  [/_cnt$/, '_count'],
  [/_pct$/, '_percent'],
  [/_sum$/, '_total'],
];

/**
 * Canonical `field_key` for one report-builder column.
 *
 * The registry identifies a column by `column_name_alias` (or `column_name`);
 * the UUID stays internal. Mechanical aggregate variants keep their suffix, so
 * `master_name_count_distinct` becomes `team_member_name_count_distinct`.
 */
export function toFieldKey(alias: string): string {
  const base = alias.trim();
  const override = FIELD_KEY_OVERRIDES[base];
  if (override) return override;

  // Split a mechanical aggregate suffix off the stem and rename the stem, so
  // `<curated stem>_avg` inherits the curated name.
  const aggregateSuffixes = [
    '_count_distinct',
    '_count',
    '_sum',
    '_avg',
    '_min',
    '_max',
  ];
  for (const suffix of aggregateSuffixes) {
    if (!base.endsWith(suffix)) continue;
    const stem = base.slice(0, -suffix.length);
    const stemOverride = FIELD_KEY_OVERRIDES[stem];
    if (stemOverride) return `${stemOverride}${suffix}`;
  }

  let key = base;
  for (const [pattern, replacement] of FIELD_KEY_TOKEN_RULES) {
    key = key.replace(pattern, replacement);
  }
  return key;
}

// ========== Chart series ==========

/** `income_daily` slug → canonical series key. */
export const REVENUE_SERIES_KEYS: Readonly<Record<string, string>> = {
  income_total: 'revenue_total',
  income_services: 'revenue_services',
  income_goods: 'revenue_products',
};

/** `fullness_daily` slug → canonical series key. */
export const OCCUPANCY_SERIES_KEYS: Readonly<Record<string, string>> = {
  fullness_spent: 'occupancy_percent',
  fullness_no_show: 'occupancy_no_show_percent',
};

/** `clients_daily` slug → canonical series key. */
export const CLIENTS_SERIES_KEYS: Readonly<Record<string, string>> = {
  clients_total: 'clients_total',
  clients_new: 'clients_new',
  clients_returned: 'clients_returning',
};

/**
 * `records_daily` carries no slugs — only localized labels — so the positional
 * order of the three series is the only stable contract.
 */
export const APPOINTMENT_SERIES_KEYS: readonly string[] = [
  'appointments_total',
  'appointments_online',
  'appointments_from_new_clients',
];

// ========== Report templates ==========

export interface ReportTemplateInfo {
  /** Canonical, agent-facing name. */
  readonly name: string;
  /** What business question the template answers. */
  readonly answers: string;
  readonly dataset: Dataset;
}

/**
 * Canonical names for the 24 built-in templates, keyed by their stable slug.
 * The API returns legacy names ("By employees", "Record sources"); the slug is
 * the join key because it does not change with the interface language.
 */
export const REPORT_TEMPLATES: Readonly<Record<string, ReportTemplateInfo>> = {
  template_services_goods_master_sales: {
    name: 'Revenue by team member',
    answers: 'Which team members bring the most revenue in a period.',
    dataset: 'sales',
  },
  template_services_goods_master_sales_extended: {
    name: 'Team member sales (detailed)',
    answers:
      'Full sales breakdown per team member: services, products, averages, occupancy.',
    dataset: 'sales',
  },
  template_services_goods_services_sales: {
    name: 'Revenue by service',
    answers: 'Which services sell and how much each brings in.',
    dataset: 'sales',
  },
  template_service_goods_client_sales: {
    name: 'Revenue and visits by client',
    answers: 'Which clients spend the most and how often they visit.',
    dataset: 'sales',
  },
  template_services_goods_client_sales_extended: {
    name: 'Client sales (detailed)',
    answers: 'Per-client revenue with payment split and visit counts.',
    dataset: 'sales',
  },
  template_service_goods_daily_sales: {
    name: 'Daily sales',
    answers: 'Sales totals per day, the way a day-end till report reads.',
    dataset: 'sales',
  },
  template_service_goods_goods_sales: {
    name: 'Product sales analysis',
    answers: 'Product revenue, cost price and margin.',
    dataset: 'sales',
  },
  template_services_goods_sales: {
    name: 'Services and products sales',
    answers: 'Everything sold in a period, services and products together.',
    dataset: 'sales',
  },
  template_service_goods_client_retention: {
    name: 'Client retention',
    answers:
      'New versus returning clients and the share that comes back — the closest thing to a retention cohort available through the API.',
    dataset: 'sales',
  },
  template_services_goods_activity_fill: {
    name: 'Group event attendance',
    answers: 'How full group events are and how many clients attend.',
    dataset: 'sales',
  },
  template_services_goods_record_sources: {
    name: 'Appointment sources',
    answers: 'Where appointments come from: online booking, receptionist, API.',
    dataset: 'sales',
  },
  template_master_schedules_fill: {
    name: 'Occupancy',
    answers:
      'Scheduled, booked and idle hours per team member, with occupancy percent.',
    dataset: 'team_member_schedules',
  },
  template_financial_expenses_report: {
    name: 'Income and expenses',
    answers: 'Cash-flow report: income and expense items for a period.',
    dataset: 'financial_transactions',
  },
  template_financial_daily_report: {
    name: 'Account operations',
    answers: 'Every money movement per account for a period.',
    dataset: 'financial_transactions',
  },
  template_financial_accounts_report: {
    name: 'Revenue by account',
    answers: 'How much money each account (till, card, transfer) took in.',
    dataset: 'financial_transactions',
  },
  template_loyalty_abonements: {
    name: 'Memberships',
    answers: 'Memberships sold, used, remaining and expiring.',
    dataset: 'loyalty',
  },
  template_loyalty_certificates: {
    name: 'Gift cards',
    answers: 'Gift cards sold, redeemed, remaining and expiring.',
    dataset: 'loyalty',
  },
  template_services_goods_master_sales_services_dynamic: {
    name: 'Team member dynamics — services',
    answers: 'Service revenue per team member over time.',
    dataset: 'sales',
  },
  template_services_goods_master_sales_goods_dynamic: {
    name: 'Team member dynamics — products',
    answers: 'Product revenue per team member over time.',
    dataset: 'sales',
  },
  template_services_goods_master_records_dynamic: {
    name: 'Team member dynamics — appointments',
    answers: 'Appointment counts per team member over time.',
    dataset: 'sales',
  },
  template_services_goods_services_sales_dynamic: {
    name: 'Service dynamics',
    answers: 'Revenue per service over time.',
    dataset: 'sales',
  },
  template_services_goods_client_sales_dynamic: {
    name: 'Client dynamics',
    answers: 'Client counts and revenue over time.',
    dataset: 'sales',
  },
  template_financial_expenses_report_dynamic: {
    name: 'Income and expenses over time',
    answers: 'Income and expense items per day, week, month or year.',
    dataset: 'financial_transactions',
  },
  template_financial_profits_and_loss: {
    name: 'P&L (profit and loss)',
    answers: 'Profit and loss over time: income minus expenses per period.',
    dataset: 'financial_transactions',
  },
};

/** Derive the dataset from a template slug when the slug is unknown to us. */
export function datasetFromTemplateSlug(slug: string): Dataset | null {
  if (slug.startsWith('template_financial_')) return 'financial_transactions';
  if (slug.startsWith('template_loyalty_')) return 'loyalty';
  if (slug.startsWith('template_master_schedules_'))
    return 'team_member_schedules';
  if (slug.startsWith('template_service_goods_')) return 'sales';
  if (slug.startsWith('template_services_goods_')) return 'sales';
  return null;
}
