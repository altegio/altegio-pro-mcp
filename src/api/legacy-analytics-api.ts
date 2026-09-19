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
  services_rendered_count: number;
  payments: PaymentBreakdown;
  cash_or_card_revenue: number | null;
  consumables_cost: number | null;
  team_member_compensation: number | null;
  contribution_result: number | null;
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
  services_rendered_count: number | null;
  products_revenue: number | null;
  products_count: number | null;
  payments: PaymentBreakdown;
  upcoming_appointments_revenue: number | null;
  worked_hours: number | null;
  revenue_per_worked_hour: number | null;
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
    | 'revenue_per_worked_hour'
    | 'revenue_share_percent'
  >;
}

export interface LegacyTeamMemberIdentity {
  id: number;
  name: string;
  position_title?: string | null;
}

export interface TeamMemberCapacityMetrics {
  worked_days: number | null;
  scheduled_hours: number | null;
  booked_hours: number | null;
  idle_hours: number | null;
  occupancy_percent: number | null;
  upcoming_appointments_count: number | null;
}
export interface TeamMemberCapacityReport {
  rows: Array<
    TeamMemberCapacityMetrics & {
      team_member_id: number;
      team_member_name: string | null;
      position_title: string | null;
    }
  >;
  totals: TeamMemberCapacityMetrics;
}
export interface ReactivationCandidate {
  client_id: null;
  client_name: string | null;
  registration_date: string | null;
  last_visit_date: string | null;
  lifetime_paid_amount: number | null;
  client_account_balance: number | null;
  last_visits: Array<{ date: string; description: string }>;
  last_visits_parse_status: 'parsed' | 'empty' | 'unavailable';
  phone?: string | null;
  email?: string | null;
  contacts_status?: 'source_values_may_be_masked';
}
export interface ClientReactivationReport {
  currency: string | null;
  rows: ReactivationCandidate[];
  page: PageMeta;
}
export interface GroupEventMetric {
  participants: number | null;
  capacity: number | null;
  percent: number | null;
}
export interface GroupEventPerformanceReport {
  currency: string | null;
  rows: Array<{
    group_event_id: number;
    team_member_id: number | null;
    /** Stable-id resolution is explicit; stale/deleted rows are never guessed. */
    team_member_identity_status: 'matched' | 'unavailable' | 'ambiguous';
    team_member_name: string | null;
    position_title: string | null;
    service_id: null;
    service_title: string | null;
    date_display: string | null;
    capacity: number | null;
    booked_participants: number | null;
    attended_clients: number | null;
    fully_paid_clients: number | null;
    appointment_value: number | null;
    creator_display: string | null;
    created_at_display: string | null;
    duration_minutes: number | null;
    is_deleted: boolean;
  }>;
  metrics: {
    booked: GroupEventMetric;
    attended: GroupEventMetric;
    paid: GroupEventMetric;
    average_occupancy: GroupEventMetric;
  } | null;
  page: PageMeta;
}
export type ProductSalesGroup = 'product' | 'product_category';
export interface ProductSalesAmounts {
  quantity: number | null;
  /** Total cost for the sold quantity, never a unit cost. */
  total_cost: number | null;
  total_markup: number | null;
  markup_percent: number | null;
  /** Money plus client-account payments. */
  revenue: number | null;
}
export interface ProductSalesReport {
  currency: string | null;
  group_by: ProductSalesGroup;
  cost_fields_status: 'available' | 'withheld';
  rows: Array<
    ProductSalesAmounts & {
      product_id: number | null;
      product_category_id: number | null;
      title: string | null;
      sku: string | null;
      barcode: string | null;
      unit: string | null;
    }
  >;
  totals: ProductSalesAmounts;
  page: PageMeta;
  pagination_source: 'upstream' | 'local';
}
export type CashAccountType = 'all' | 'cash' | 'non_cash';
export interface CashFlowColumn {
  period_label: string;
  period_kind: 'day' | 'period_total';
  dimension: 'cash_account_type' | 'cash_account' | 'total';
  cash_account_type: CashAccountType | null;
  cash_account_id: null;
  cash_account_title: string | null;
}
export interface CashFlowRow {
  payment_item_id: number | null;
  payment_item_title: string;
  kind: 'inflow' | 'outflow' | 'net_movement' | 'payment_item';
  direction: 'inflow' | 'outflow' | null;
  amounts: Array<number | null>;
  total: number | null;
}
export interface CashFlowBreakdownReport {
  currency: string | null;
  columns: CashFlowColumn[];
  rows: CashFlowRow[];
  totals: {
    inflow: number | null;
    outflow: number | null;
    net_movement: number | null;
  };
}

export interface LegacyPeriodRequest {
  location_id: number;
  date_from: string;
  date_to: string;
}
export interface LegacyPageRequest {
  page: number;
  page_size: number;
}
export interface ClientReactivationRequest
  extends LegacyPeriodRequest, LegacyPageRequest {
  loyalty_program_id: number;
  include_contacts: boolean;
}
export interface GroupEventPerformanceRequest
  extends LegacyPeriodRequest, LegacyPageRequest {
  team_member_id?: number;
  service_id?: number;
  service_category_id?: number;
  label_id?: number;
  status?: 'all' | 'active' | 'deleted';
}
export interface ProductSalesRequest
  extends LegacyPeriodRequest, LegacyPageRequest {
  group_by: ProductSalesGroup;
  product_category_id?: number;
  team_member_id?: number;
  supplier_id?: number;
}
export interface CashFlowBreakdownRequest extends LegacyPeriodRequest {
  cash_account_ids?: number[];
  team_member_id?: number;
  supplier_id?: number;
  payment_item_id?: number;
  cash_account_type?: CashAccountType;
  service_ids?: number[];
  product_ids?: number[];
  service_category_ids?: number[];
  product_category_ids?: number[];
  include_zero_movement_rows?: boolean;
}

export interface ProfitAndLossCategory {
  category_id: number | null;
  title: string | null;
  direction: 'income' | 'expense';
  amount: number | null;
}

export interface ProfitAndLossReport {
  currency: string | null;
  income_total: number | null;
  expense_total: number | null;
  tracked_operating_result: number | null;
  categories: ProfitAndLossCategory[];
}

export interface InventoryTurnoverRow {
  product_id: number;
  product_title: string | null;
  supplier_title: string | null;
  unit: string | null;
  units_received: number | null;
  opening_stock: number | null;
  current_stock: number | null;
  units_sold: number | null;
  average_stock: number | null;
  source_turnover_days: number | null;
  source_turnover_count: number | null;
  source_stock_level_days: number | null;
}

export interface InventoryTurnoverReport {
  rows: InventoryTurnoverRow[];
  page: PageMeta;
}
