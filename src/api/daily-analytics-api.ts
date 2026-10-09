import type { PeriodQuery } from './analytics-api.js';

/** Selection is an aggregate of the visible active team, never rows per person. */
export interface TeamWorkloadQuery extends PeriodQuery {
  team_member_ids?: number[];
}

export interface TeamWorkload {
  points: Array<{ date: string; booked_share: number | null }>;
  excluded_outside_period_count: number;
}

export interface DailySummary {
  date: string;
  clients_with_appointments_count: number | null;
  booked_services_value: number | null;
  completed_sales_value: number | null;
  product_sales_value: number | null;
  cash_received: number | null;
  discounts_value: number | null;
  average_check: number | null;
  /** The contract does not establish a unit for this field. */
  average_workload_source_value: number | null;
}

export interface DailyAnalyticsApi {
  getTeamWorkload(query: TeamWorkloadQuery): Promise<TeamWorkload>;
  getWorkingDays(query: TeamWorkloadQuery): Promise<string[]>;
  getDailySummary(query: {
    location_id: number;
    date: string;
  }): Promise<DailySummary>;
}
