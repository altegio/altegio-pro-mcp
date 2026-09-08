/**
 * `ClientsApi` — the port the clients capability layer talks to (ADR-001 D5).
 *
 * Method names and DTOs use the canonical product vocabulary and the V3 object
 * model (client, team_member, appointment, membership, gift_card,
 * client_account). The v1 adapter in `./v1/clients-adapter.ts` implements it
 * today; a v3 adapter can replace it per method without touching a tool.
 *
 * Money is expressed in **major units** — the client endpoints return decimal
 * sums, not minor units — next to an ISO currency code where the API reports
 * one. `null` means "the API did not report this number", never `0`.
 */

// ========== segmentation (client-base search) ==========

/** How several filters combine: every filter, or any of them. */
export type FilterMatch = 'all' | 'any';

/** A closed or half-open numeric / date range. At least one bound is required. */
export interface Range {
  from?: number | string;
  to?: number | string;
}

/** Loyalty importance class of a client. */
export type Importance = 'none' | 'bronze' | 'silver' | 'gold';

/** Client gender as the client base records it. */
export type Gender = 'unknown' | 'male' | 'female';

/**
 * The outcome of a past appointment, as the appointment-history filter reads it.
 * This is the V3 appointment-status vocabulary; the v1 client-search filter uses
 * a different numeric code for each, which the adapter maps. `cancelled` is not
 * a value this particular filter accepts.
 */
export type AppointmentOutcome =
  'waiting' | 'confirmed' | 'arrived' | 'no_show';

/**
 * Filter on a client's appointment history. Every field is ANDed inside the
 * filter. `exclude` inverts the whole thing — the clients who did NOT have a
 * matching appointment — which is how a lapsed / win-back segment is expressed.
 */
export interface AppointmentHistoryFilter {
  team_member_ids?: number[];
  service_ids?: number[];
  service_category_ids?: number[];
  outcome?: AppointmentOutcome[];
  /** When the appointment was created. */
  created?: Range;
  /** How many matching appointments the client has. */
  count?: Range;
  /** Money sold across the matching appointments, in major units. */
  amount?: Range;
  /** Invert the match: clients without a matching appointment. */
  exclude?: boolean;
}

/**
 * The whole canonical filter model for a client-base search. Every field is
 * optional; the ones given are combined by `match`. The adapter translates each
 * to the v1 wire filter it corresponds to.
 */
export interface ClientSearchFilters {
  /** Free text over name, phone and email. */
  query?: string;
  client_ids?: number[];
  /** Lifetime money sold to the client, major units. */
  total_spent?: Range;
  importance?: Importance[];
  gender?: Gender[];
  /** Client tag (label) ids; see the clients_list_tags helper for the ids. */
  tag_ids?: number[];
  /** Birthday window; `MM-DD` or `YYYY-MM-DD`. */
  birthday?: Range;
  age?: Range;
  has_mobile_app?: boolean;
  /** Client-account (prepaid deposit) balance, major units. */
  client_account_balance?: Range;
  membership_balance?: Range;
  membership_type_ids?: number[];
  membership_is_frozen?: boolean;
  membership_is_used?: boolean;
  gift_card_balance?: Range;
  gift_card_type_ids?: number[];
  gift_card_is_used?: boolean;
  /** Client agreed to receive newsletters. */
  newsletter_allowed?: boolean;
  /** Client is included in mass notifications. */
  mass_notification_allowed?: boolean;
  /** Client has push notifications enabled. */
  push_enabled?: boolean;
  /** Client consented to personal-data processing. */
  personal_data_processing_allowed?: boolean;
  appointments?: AppointmentHistoryFilter;
}

/** Field a segment can be ordered by. */
export type ClientSortField =
  | 'id'
  | 'name'
  | 'phone'
  | 'email'
  | 'discount'
  | 'first_visit_date'
  | 'last_visit_date'
  | 'total_spent'
  | 'visit_count';

export interface ClientSearchQuery {
  location_id: number;
  filters: ClientSearchFilters;
  match: FilterMatch;
  page: number;
  page_size: number;
  order_by?: ClientSortField;
  order_direction?: 'asc' | 'desc';
  /** Extra client fields to return per row, beyond id and name. */
  fields?: string[];
}

/** One row of a segment. `id` and `name` are always present; the rest are opt-in via `fields`. */
export interface ClientSegmentRow {
  id: number;
  name: string;
  [field: string]: unknown;
}

export interface ClientSegment {
  /** How many clients match the filter across all pages. */
  total_count: number;
  page: number;
  page_size: number;
  rows: ClientSegmentRow[];
}

// ========== client card ==========

export interface ClientTag {
  id: number | null;
  title: string | null;
  color: string | null;
}

export interface ClientCard {
  id: number;
  name: string | null;
  surname: string | null;
  patronymic: string | null;
  phone: string | null;
  email: string | null;
  gender: Gender | null;
  importance: Importance | null;
  discount: number | null;
  loyalty_card_number: string | null;
  birth_date: string | null;
  comment: string | null;
  /** Lifetime money sold to the client, major units. */
  total_spent: number | null;
  /** Client-account balance, major units. */
  client_account_balance: number | null;
  /** Successful visit count as the client base counts it. */
  visit_count: number | null;
  /** Birthday-greeting flag: the client is congratulated by SMS. */
  sms_birthday_greeting: boolean | null;
  /** The client is excluded from SMS campaigns. */
  sms_excluded_from_campaigns: boolean | null;
  tags: ClientTag[];
  custom_fields: Record<string, unknown>;
  last_changed_at: string | null;
}

// ========== per-client visit history ==========

/**
 * Payment status of one visit.
 *  - `unpaid` — nothing was paid;
 *  - `partly_paid` — a part was paid;
 *  - `fully_paid` — paid in full, no overpayment;
 *  - `overpaid` — the client overpaid.
 */
export type VisitPaymentStatus =
  'unpaid' | 'partly_paid' | 'fully_paid' | 'overpaid';

export interface VisitHistoryQuery {
  location_id: number;
  client_id?: number;
  client_phone?: string;
  date_from?: string;
  date_to?: string;
  payment_statuses?: VisitPaymentStatus[];
  /**
   * Visit outcome: `arrived`, `no_show`, `waiting`, `confirmed`. Only one value,
   * because the underlying endpoint filters on a single attendance code.
   */
  outcome?: AppointmentOutcome;
}

export interface VisitHistoryItem {
  visit_id: number | null;
  date: string | null;
  outcome: AppointmentOutcome | 'other' | null;
  payment_status: VisitPaymentStatus | null;
  team_member_name: string | null;
  services: Array<{ title: string | null; cost: number | null }>;
  products: Array<{ title: string | null; cost: number | null }>;
  /** Total sold on the visit, major units. */
  total_cost: number | null;
  /** Total paid on the visit, major units. */
  total_paid: number | null;
}

export interface VisitHistory {
  items: VisitHistoryItem[];
  /** Cursor for the next page: pass back as date_from/date_to (endpoint paging). */
  next_from: string | null;
  next_to: string | null;
  has_more: boolean;
}

// ========== fast lookup (typeahead) ==========

export interface ClientLookupQuery {
  location_id: number;
  query: string;
  limit?: number;
}

export interface ClientLookupRow {
  id: number;
  name: string | null;
  phone: string | null;
}

// ========== the port ==========

export interface ClientsApi {
  searchClients(query: ClientSearchQuery): Promise<ClientSegment>;
  getClientCard(query: {
    location_id: number;
    client_id: number;
  }): Promise<ClientCard>;
  getVisitHistory(query: VisitHistoryQuery): Promise<VisitHistory>;
  lookupClients(query: ClientLookupQuery): Promise<ClientLookupRow[]>;
}
