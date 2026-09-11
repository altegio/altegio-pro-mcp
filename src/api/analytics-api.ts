/**
 * `AnalyticsApi` — the port the analytics capability layer talks to (ADR-001 D5).
 *
 * Method names and DTOs use the canonical product vocabulary and the V3 object
 * model. The v1 adapter in `./v1/analytics-adapter.ts` implements it today; a v3
 * adapter can replace it per method without touching a single tool.
 *
 * Money is expressed in **major units** (the analytics endpoints return decimal
 * sums, not minor units) together with an ISO currency code. Percentages are
 * plain numbers. `null` means "the API did not report this number", which is
 * different from `0`.
 */
import type {
  AppointmentSource,
  Dataset,
  VisitStatus,
} from '../capabilities/analytics/vocabulary.js';

// ========== Shared shapes ==========

/** A metric with its previous-period value and the relative change. */
export interface ComparedValue {
  current: number | null;
  previous: number | null;
  /** Percent change against the previous period; `null` when undefined. */
  change_percent: number | null;
}

/** One day of a series: `[YYYY-MM-DD, value]`. */
export type DailyPoint = readonly [string, number];

export interface DailySeries {
  /** Canonical series key, e.g. `revenue_services`. */
  key: string;
  /** Human-readable label, canonicalized. */
  label: string;
  points: DailyPoint[];
}

export interface PeriodQuery {
  location_id: number;
  /** Inclusive, `YYYY-MM-DD`. */
  date_from: string;
  /** Inclusive, `YYYY-MM-DD`. */
  date_to: string;
}

export interface AnalyticsFilterQuery extends PeriodQuery {
  team_member_id?: number;
  position_id?: number;
  /** Location user (usually a receptionist) who created the appointments. */
  created_by_user_id?: number;
}

// ========== Key metrics ==========

export interface AppointmentStats {
  total_count: number | null;
  previous_total_count: number | null;
  change_percent: number | null;
  completed_count: number | null;
  completed_percent: number | null;
  /** Booked but not yet resolved: waiting or confirmed. */
  pending_count: number | null;
  pending_percent: number | null;
  cancelled_count: number | null;
  cancelled_percent: number | null;
}

export interface ClientStats {
  /** Every client in the location's client base, not only this period. */
  total_in_base: number | null;
  new_count: number | null;
  new_percent: number | null;
  returning_count: number | null;
  returning_percent: number | null;
  /** Clients who came in the period: new + returning. */
  active_count: number | null;
  lost_count: number | null;
  lost_percent: number | null;
}

export interface AnalyticsOverview {
  currency: string | null;
  revenue: {
    total: ComparedValue;
    services: ComparedValue;
    products: ComparedValue;
  };
  average_check: ComparedValue;
  average_services_check: ComparedValue;
  occupancy_percent: ComparedValue;
  appointments: AppointmentStats;
  clients: ClientStats;
}

// ========== Breakdowns ==========

export interface AppointmentSourceSlice {
  key: AppointmentSource;
  label: string;
  count: number;
}

export interface VisitStatusSlice {
  key: VisitStatus | 'other';
  label: string;
  count: number;
}

// ========== Receptionist performance ==========

export interface RebookingRate {
  /** Clients the receptionists served with this visit outcome. */
  clients_count: number | null;
  /** How many of them left with a new future appointment. */
  rebooked_count: number | null;
  rate_percent: number | null;
}

export interface ReceptionistPerformance {
  currency: string | null;
  clients_booked: ComparedValue;
  appointments_closed: ComparedValue;
  revenue: ComparedValue;
  rebooked_after_visit: RebookingRate;
  rebooked_after_no_show: RebookingRate;
  daily?: {
    clients_booked?: DailyPoint[];
    appointments_closed?: DailyPoint[];
    revenue?: DailyPoint[];
  };
}

export interface ReceptionistQuery extends PeriodQuery {
  /** Restrict to one location user; required for a receptionist self-view. */
  created_by_user_id?: number;
  include_daily?: boolean;
}

// ========== Loyalty programs ==========

export interface LoyaltyClientSegment {
  all_count: number | null;
  lost_count: number | null;
  returned_count: number | null;
  returned_percent: number | null;
}

export interface LoyaltyRevenueSegment {
  all_total: number | null;
  returned_total: number | null;
}

export interface LoyaltyTeamMemberResult {
  team_member_id: number | null;
  team_member_name: string | null;
  clients: {
    new: LoyaltyClientSegment;
    returning: LoyaltyClientSegment;
    total: LoyaltyClientSegment;
  };
}

export interface LoyaltyProgramResults {
  currency: string | null;
  clients: {
    new: LoyaltyClientSegment;
    returning: LoyaltyClientSegment;
    total: LoyaltyClientSegment;
  };
  revenue: {
    new: LoyaltyRevenueSegment;
    returning: LoyaltyRevenueSegment;
    total: LoyaltyRevenueSegment;
  };
  visits_by_day: Array<{
    date: string;
    new_count: number | null;
    returning_count: number | null;
  }>;
  revenue_by_day: Array<{
    date: string;
    new_total: number | null;
    returning_total: number | null;
  }>;
  by_team_member: LoyaltyTeamMemberResult[];
}

export interface LoyaltyQuery extends PeriodQuery {
  loyalty_program_id: number;
}

// ========== Forecast ==========

export interface ForecastPair {
  forecast: number | null;
  actual: number | null;
}

export interface Forecast {
  /** The date the model produced its prediction for, `null` when none exists. */
  prediction_date: string | null;
  currency: string | null;
  revenue: ForecastPair;
  visits: ForecastPair;
  /** Granularity label the model reports the series in, when it does. */
  granularity: string | null;
  by_period: Array<{
    date: string;
    revenue_forecast: number | null;
    revenue_actual: number | null;
    visits_forecast: number | null;
    visits_actual: number | null;
  }>;
  /** True when the model has no prediction for the requested range. */
  is_empty: boolean;
}

export interface ForecastQuery {
  location_id: number;
  date_from?: string;
  date_to?: string;
}

// ========== Day-end report ==========

export interface DayEndTotals {
  clients_count: number | null;
  average_per_client: number | null;
  appointments_count: number | null;
  average_per_appointment: number | null;
  appointments_with_client_count: number | null;
  average_per_appointment_with_client: number | null;
  appointments_without_client_count: number | null;
  average_per_appointment_without_client: number | null;
  services_count: number | null;
  services_revenue: number | null;
  products_count: number | null;
  products_revenue: number | null;
  gift_cards_count: number | null;
  gift_cards_revenue: number | null;
  memberships_count: number | null;
  memberships_revenue: number | null;
}

export interface NamedAmount {
  title: string;
  amount: number | null;
}

export interface DayEndReportItem {
  title: string;
  first_cost: number | null;
  discount: number | null;
  result_cost: number | null;
}

export interface DayEndReportDetailRow {
  date: string;
  client_id: number | null;
  team_member_id: number | null;
  services: DayEndReportItem[];
  products: DayEndReportItem[];
  other: DayEndReportItem[];
}

export interface DayEndReport {
  date_from: string;
  date_to: string;
  currency: string | null;
  totals: DayEndTotals;
  takings_by_account: NamedAmount[];
  /** Non-cash write-offs: discounts, bonuses, memberships, gift cards. */
  write_offs: NamedAmount[];
  takings_total: number | null;
  write_offs_total: number | null;
  /** Per-client detail; only present when explicitly requested. */
  details?: DayEndReportDetailRow[];
}

export interface DayEndReportQuery {
  location_id: number;
  date_from: string;
  date_to: string;
  team_member_id?: number;
  visit_status?: VisitStatus;
  include_details?: boolean;
}

// ========== Occupancy and client visits ==========

export interface TeamMemberOccupancy {
  team_member_id: number;
  points: DailyPoint[];
}

export interface ClientVisitStats {
  client_id: number;
  successful_visits_count: number | null;
  failed_visits_count: number | null;
  spent_total: number | null;
  paid_total: number | null;
  client_account_balance: number | null;
  last_visit_at: string | null;
}

// ========== Report builder ==========

export interface ReportTemplateColumn {
  column_id: string;
  title: string | null;
}

export interface ReportTemplateFilter {
  column_id: string;
  operator: string;
  value: string;
}

export interface ReportTemplate {
  template_id: string;
  slug: string;
  /** Canonical name; falls back to the canonicalized API name. */
  name: string;
  description: string;
  kind: 'static' | 'dynamic';
  dataset: Dataset | null;
  answers?: string;
  columns?: ReportTemplateColumn[];
  filters?: ReportTemplateFilter[];
  groupings?: string[];
}

export interface ReportField {
  /** Canonical slug. The registry UUID stays internal. */
  field_key: string;
  title: string;
  kind: 'metric' | 'dimension' | 'granularity';
  dataset: Dataset;
  data_type: 'number' | 'date' | 'text' | 'boolean';
  /** How the metric aggregates: sum, count, average, percent, … */
  aggregation: string | null;
  filterable: boolean;
  /** Only curated fields are shown by default. */
  is_curated: boolean;
  /** Internal registry id — never exposed in a tool result. */
  column_id: string;
}

export interface SavedReport {
  report_id: string;
  name: string;
  description: string;
  kind: 'static' | 'dynamic';
  template_id: string | null;
  created_at: string | null;
  /**
   * Build status of the report's data mart. The builder prepares a report
   * asynchronously after create/update; `/data` answers only once it is
   * `success`.
   */
  status?: 'pending' | 'success' | 'error' | 'deleted' | null;
  /** Filters of the stored report, needed to override the period at run time. */
  filters?: Array<{
    filter_id: string;
    column_id: string;
    operator: string;
    value?: string | null;
  }>;
  columns?: Array<{
    report_column_id: string;
    column_id: string;
    title: string | null;
  }>;
  groupings?: Array<{ report_grouping_id: string; column_id: string }>;
}

export interface ReportDefinition {
  name: string;
  description?: string;
  template_id?: string;
  kind: 'static' | 'dynamic';
  columns: Array<{ column_id: string; title?: string }>;
  filters: Array<{ column_id: string; operator: string; value: string }>;
  groupings: string[];
}

export interface ReportDataFilterOverride {
  filter_id: string;
  operator: string;
  value: string | string[] | { from: string; to: string };
}

export interface ReportTable {
  columns: Array<{ key: string; title: string }>;
  rows: Array<Record<string, string | number | null>>;
  totals: Record<string, string | number | null>;
  row_count: number;
  /**
   * Response column key → report-builder registry id. Internal: the capability
   * layer uses it to rename columns to canonical field keys, then drops it.
   */
  column_ids?: Record<string, string>;
}

// ========== The port ==========

export interface AnalyticsApi {
  getOverview(query: AnalyticsFilterQuery): Promise<AnalyticsOverview>;
  getRevenueDaily(query: AnalyticsFilterQuery): Promise<DailySeries[]>;
  getAppointmentsDaily(query: AnalyticsFilterQuery): Promise<DailySeries[]>;
  getOccupancyDaily(query: AnalyticsFilterQuery): Promise<DailySeries[]>;
  getClientsDaily(query: AnalyticsFilterQuery): Promise<DailySeries[]>;
  getAppointmentSourceBreakdown(
    query: AnalyticsFilterQuery
  ): Promise<AppointmentSourceSlice[]>;
  getVisitStatusBreakdown(
    query: AnalyticsFilterQuery
  ): Promise<VisitStatusSlice[]>;
  getReceptionistPerformance(
    query: ReceptionistQuery
  ): Promise<ReceptionistPerformance>;
  getLoyaltyProgramResults(query: LoyaltyQuery): Promise<LoyaltyProgramResults>;
  getForecast(query: ForecastQuery): Promise<Forecast>;
  getDayEndReport(query: DayEndReportQuery): Promise<DayEndReport>;
  getTeamMemberOccupancy(
    query: PeriodQuery & { team_member_id: number }
  ): Promise<TeamMemberOccupancy>;
  getClientVisitStats(query: {
    location_id: number;
    client_id: number;
  }): Promise<ClientVisitStats>;
  listReportTemplates(query: {
    location_id: number;
    with_definition?: boolean;
  }): Promise<ReportTemplate[]>;
  listReportFields(query: { location_id: number }): Promise<ReportField[]>;
  listSavedReports(query: { location_id: number }): Promise<SavedReport[]>;
  getSavedReport(query: {
    location_id: number;
    report_id: string;
  }): Promise<SavedReport>;
  createReport(query: {
    location_id: number;
    definition: ReportDefinition;
  }): Promise<SavedReport>;
  updateReport(query: {
    location_id: number;
    report_id: string;
    definition: ReportDefinition;
  }): Promise<SavedReport>;
  deleteReport(query: {
    location_id: number;
    report_id: string;
  }): Promise<void>;
  runReport(query: {
    location_id: number;
    report_id: string;
    filters: ReportDataFilterOverride[];
    /** Use the legacy rows endpoint only for the report's stored period. */
    allow_stored_period_fallback?: boolean;
  }): Promise<ReportTable>;
}
