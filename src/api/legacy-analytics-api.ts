/**
 * Canonical contract for the temporary legacy-report analytics adapter.
 *
 * The ERP routes speak in salon/master/record/goods terminology and render
 * locale-formatted HTML/XLS. Those names and formats stop in the v1 adapter;
 * everything exported here follows the V3/MCP glossary.
 */

export interface PageMeta {
  page: number;
  page_size: number;
  total_count: number;
  returned: number;
  has_more: boolean;
}

export interface ClientSalesRow {
  client_id: number;
  client_name: string | null;
  revenue: number | null;
  revenue_share_percent: number | null;
  average_check: number | null;
  visits_count: number | null;
  phone?: string | null;
  email?: string | null;
}

export interface ClientSalesReport {
  currency: string | null;
  rows: ClientSalesRow[];
  totals: { revenue: number | null };
  page: PageMeta;
}

export interface ClientRetentionRow {
  team_member_id: number;
  team_member_name: string | null;
  position_title: string | null;
  clients_count: number;
  new_clients_count: number;
  new_clients_percent: number | null;
  returning_clients_count: number;
  returning_clients_percent: number | null;
  clients_eligible_for_return_count: number;
  clients_returned_count: number;
  retention_percent: number | null;
}

export interface ClientRetentionReport {
  rows: ClientRetentionRow[];
  totals: Omit<
    ClientRetentionRow,
    'team_member_id' | 'team_member_name' | 'position_title'
  >;
  lost_threshold_days: number | null;
}

export const CLIENT_FORECAST_WINDOWS = [
  'insufficient_data',
  'this_month',
  'next_month',
  'not_expected',
  'unknown',
] as const;
export type ClientForecastWindow = (typeof CLIENT_FORECAST_WINDOWS)[number];

export interface ClientForecastRow {
  /** The legacy workbook does not carry the client id; never guessed. */
  client_id: null;
  client_name: string | null;
  average_check: number | null;
  predicted_visits_count: number | null;
  predicted_visit_window: ClientForecastWindow;
  predicted_revenue: number | null;
  return_visits_count: number | null;
  last_visit_date: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface ClientForecastReport {
  currency: string | null;
  prediction_date: string | null;
  rows: ClientForecastRow[];
  page: PageMeta;
}

export type ServiceProfitabilityGroup = 'service' | 'service_category';

export interface PaymentBreakdown {
  discount: number | null;
  loyalty_points: number | null;
  memberships: number | null;
  gift_cards: number | null;
  client_accounts: number | null;
}

export interface ServiceProfitabilityRow {
  service_id: number | null;
  service_category_id: number | null;
  title: string | null;
  service_category_title: string | null;
  services_count: number;
  payments: PaymentBreakdown;
  cash_or_card_revenue: number | null;
  consumables_cost: number | null;
  team_member_compensation: number | null;
  profit: number | null;
  revenue_share_percent: number | null;
}

export interface ServiceProfitabilityReport {
  currency: string | null;
  group_by: ServiceProfitabilityGroup;
  rows: ServiceProfitabilityRow[];
  totals: Omit<
    ServiceProfitabilityRow,
    | 'service_id'
    | 'service_category_id'
    | 'title'
    | 'service_category_title'
    | 'revenue_share_percent'
  >;
  page: PageMeta;
}

export interface TeamMemberSalesRow {
  team_member_id: number;
  team_member_name: string | null;
  position_title: string | null;
  revenue: number | null;
  services_revenue: number | null;
  services_count: number | null;
  products_revenue: number | null;
  products_count: number | null;
  payments: PaymentBreakdown;
  upcoming_appointments_revenue: number | null;
  working_hours: number | null;
  revenue_per_working_hour: number | null;
  revenue_share_percent: number | null;
}

export interface TeamMemberSalesReport {
  currency: string | null;
  rows: TeamMemberSalesRow[];
  totals: Omit<
    TeamMemberSalesRow,
    | 'team_member_id'
    | 'team_member_name'
    | 'position_title'
    | 'revenue_per_working_hour'
    | 'revenue_share_percent'
  >;
}

export interface LegacyTeamMemberIdentity {
  id: number;
  name: string;
  position_title?: string | null;
}
