/**
 * Clients vocabulary — the ONLY place in the clients pack where the legacy v1
 * client-search dialect is allowed to appear.
 *
 * The tools speak canonical product terms (client, team_member, appointment,
 * membership, gift_card, client_account, tag). The v1 `/clients/search` filter
 * protocol speaks its own dialect: `record`, `abonement`, `certificate`,
 * `category`, `sold_amount`, and two different numeric codes for the same visit
 * outcome depending on the endpoint. Every one of those mappings lives here and
 * is unit-tested, so the rest of the pack — and everything the agent reads —
 * stays in canonical vocabulary.
 *
 * The two visit-outcome tables are the subtle part and the reason this module
 * exists: the client-search *appointment history* filter and the *visit history*
 * search number the same four outcomes differently.
 */
import type {
  AppointmentOutcome,
  ClientSortField,
  Gender,
  Importance,
  VisitPaymentStatus,
} from '../../api/clients-api.js';

/** Legacy → canonical term table; documentation and the segmentation resource. */
export interface TermMapping {
  readonly legacy: string;
  readonly canonical: string;
  readonly note?: string;
}

export const TERM_MAPPINGS: readonly TermMapping[] = [
  { legacy: 'salon / company / salonId', canonical: 'location / location_id' },
  { legacy: 'record (in a client filter)', canonical: 'appointment history' },
  {
    legacy: 'category (a client label)',
    canonical: 'tag',
    note: 'client "categories" are the coloured labels on a client card, not service categories',
  },
  {
    legacy: 'sold_amount',
    canonical: 'total_spent',
    note: 'lifetime money sold to the client, major units',
  },
  { legacy: 'abonement', canonical: 'membership' },
  { legacy: 'certificate', canonical: 'gift_card' },
  { legacy: 'deposit_balance', canonical: 'client_account_balance' },
  { legacy: 'master / staff', canonical: 'team_member' },
  {
    legacy: 'attendance / record status',
    canonical: 'appointment outcome',
    note: 'waiting | confirmed | arrived | no_show — numbered differently by the search filter and by the visit-history endpoint',
  },
] as const;

// ========== importance (loyalty class) ==========

/** Importance class → the numeric code the client base stores. */
export const IMPORTANCE_TO_CODE: Readonly<Record<Importance, number>> = {
  none: 0,
  bronze: 1,
  silver: 2,
  gold: 3,
};

export const IMPORTANCE_FROM_CODE: Readonly<Record<number, Importance>> = {
  0: 'none',
  1: 'bronze',
  2: 'silver',
  3: 'gold',
};

// ========== gender ==========

export const GENDER_TO_CODE: Readonly<Record<Gender, number>> = {
  unknown: 0,
  male: 1,
  female: 2,
};

export const GENDER_FROM_CODE: Readonly<Record<number, Gender>> = {
  0: 'unknown',
  1: 'male',
  2: 'female',
};

// ========== appointment outcome — TWO different numberings ==========

/**
 * Outcome → the code the **client-search appointment-history filter** uses
 * (`ClientSearchCriteriaRecordFilter`): did-not-come 1, waiting 2, came 3,
 * confirmed 4. Note this is NOT the numbering the visit-history search uses.
 */
export const OUTCOME_TO_RECORD_CODE: Readonly<
  Record<AppointmentOutcome, number>
> = {
  no_show: 1,
  waiting: 2,
  arrived: 3,
  confirmed: 4,
};

/**
 * Outcome → the `attendance` code the **visit-history search** uses: did-not-come
 * -1, waiting 0, came 1, confirmed 2. Kept separate from the record-filter table
 * on purpose — collapsing them is the classic bug in this API.
 */
export const OUTCOME_TO_ATTENDANCE_CODE: Readonly<
  Record<AppointmentOutcome, number>
> = {
  no_show: -1,
  waiting: 0,
  arrived: 1,
  confirmed: 2,
};

/** Reverse of the visit-history `attendance` code, for reading a response back. */
export const OUTCOME_FROM_ATTENDANCE_CODE: Readonly<
  Record<number, AppointmentOutcome>
> = {
  '-1': 'no_show',
  0: 'waiting',
  1: 'arrived',
  2: 'confirmed',
};

// ========== visit payment status ==========

export const PAYMENT_STATUS_TO_WIRE: Readonly<
  Record<VisitPaymentStatus, string>
> = {
  unpaid: 'not_paid',
  partly_paid: 'paid_not_full',
  fully_paid: 'paid_full',
  overpaid: 'paid_over',
};

export const PAYMENT_STATUS_FROM_WIRE: Readonly<
  Record<string, VisitPaymentStatus>
> = {
  not_paid: 'unpaid',
  paid_not_full: 'partly_paid',
  paid_full: 'fully_paid',
  paid_over: 'overpaid',
};

// ========== sort field ==========

/** Canonical sort field → the wire `order_by` value. Only `total_spent` differs. */
export const SORT_FIELD_TO_WIRE: Readonly<Record<ClientSortField, string>> = {
  id: 'id',
  name: 'name',
  phone: 'phone',
  email: 'email',
  discount: 'discount',
  first_visit_date: 'first_visit_date',
  last_visit_date: 'last_visit_date',
  total_spent: 'sold_amount',
  visit_count: 'visit_count',
};
