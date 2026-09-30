/**
 * `MembershipsApi` — the port the memberships capability layer talks to
 * (ADR-001 D5).
 *
 * A membership is a prepaid pass for a number of visits or a period. A
 * membership type is its template: price, the services and service categories
 * it covers, how its balance counts, how long it is valid and whether it can be
 * frozen. Types and the memberships sold from them belong to a chain, so every
 * chain call takes the chain id; one client's memberships are found through a
 * location.
 *
 * Method names and DTOs use the canonical product vocabulary (chain, location,
 * membership, membership type, service, service category, visit, freeze); the
 * wire names (`abonement`, `salon_group`, `salon`, `cost`,
 * `is_united_balance`, `is_allow_empty_code`, `expiration_type_id`,
 * `balance_container`, `service_price_correction`) stop inside
 * `./v1/memberships-adapter.ts`.
 *
 * Dates from the API pass through as RFC 3339 with the offset the API reports.
 * Money is in major units, as the API reports it.
 */

export type PeriodUnit = 'day' | 'week' | 'month' | 'year';

/** A length of time: `{ length: 3, unit: 'month' }`. */
export interface Duration {
  length: number;
  unit: PeriodUnit;
}

/** When a sold membership starts to count its validity. */
export type MembershipActivation = 'first_visit' | 'sale';

/** Where staff may correct the balance of a sold membership by hand. */
export type BalanceEditPolicy =
  'not_allowed' | 'sale_location' | 'any_location';

/**
 * `shared` — one pool of visits spent on any covered service;
 * `per_service` — a separate number of visits for each covered service or
 * service category.
 */
export type MembershipBalanceType = 'shared' | 'per_service';

/**
 * `issued` — sold, not activated yet; `active` — in use; `expired` — past its
 * validity; `used_up` — no visits left; `unknown` — a status this build does
 * not know.
 */
export type MembershipStatus =
  'issued' | 'active' | 'expired' | 'used_up' | 'unknown';

/** One service or service category a membership type or membership covers. */
export interface MembershipAllowance {
  /** Set for a service, null for a service category. */
  service_id: number | null;
  /** Set for a service category, null for a service. */
  service_category_id: number | null;
  title: string | null;
  /**
   * Visits of this service under a per-service balance: included in a type,
   * left on a membership. Null under a shared balance or when unlimited.
   */
  visits: number | null;
  unlimited: boolean;
}

/** What the signed-in user may do with memberships in one chain. */
export interface ChainMembershipRights {
  /** The chain's loyalty section at all. */
  loyalty: boolean | null;
  /** Create, change, archive and delete membership types. */
  manage_membership_types: boolean | null;
  /** Freeze, unfreeze and change the validity or balance of sold memberships. */
  change_memberships: boolean | null;
  /** Correct the balance of sold memberships. */
  edit_membership_balance: boolean | null;
  read_membership_history: boolean | null;
}

export interface ChainAccess {
  id: number;
  title: string | null;
  location_ids: number[];
  location_titles: string[];
  rights: ChainMembershipRights;
}

export interface MembershipType {
  id: number;
  chain_id: number | null;
  title: string | null;
  price: number | null;
  archived: boolean;
  archived_at: string | null;
  /** How long a membership stays valid once activated; null — no expiry. */
  validity: Duration | null;
  activation: MembershipActivation | null;
  /** An unused membership activates by itself this long after the sale. */
  auto_activation_after: Duration | null;
  /**
   * true — only the client who bought it (or the one it was given to) uses it,
   * without a code; false — whoever presents its number can use it.
   */
  personal: boolean | null;
  balance_type: MembershipBalanceType;
  /** Visits in the shared pool; null for a per-service balance or unlimited. */
  shared_visits: number | null;
  shared_unlimited: boolean;
  services: MembershipAllowance[];
  freeze_allowed: boolean;
  /** Longest total freeze per membership; null — no limit. */
  freeze_limit: Duration | null;
  booking_while_frozen: boolean;
  /** Recalculate the service price when the visit is paid with a membership. */
  recalculate_service_price: boolean;
  balance_edit: BalanceEditPolicy | null;
  /** Whether time-of-week usage rules restrict the type. */
  time_restricted: boolean;
  online_sale_enabled: boolean;
  online_sale_title: string | null;
  online_sale_price: number | null;
  online_sale_description: string | null;
  /** Locations that sell the type; null when the source did not report them. */
  location_ids: number[] | null;
  /** Memberships sold of this type; null when the source did not report it. */
  sold_count: number | null;
  /** The chain's grouping of membership types, not a service category. */
  type_category_id: number | null;
}

export interface MembershipTypePage {
  items: MembershipType[];
  total: number | null;
}

/** A service or service category a membership type should cover. */
export interface AllowanceInput {
  service_id?: number;
  service_category_id?: number;
  /** Visits included under a per-service balance. */
  visits?: number;
  unlimited?: boolean;
}

/** Every field of a membership type the API accepts on create and update. */
export interface MembershipTypeFields {
  title: string;
  price: number;
  location_ids: number[];
  validity: Duration | null;
  activation: MembershipActivation;
  auto_activation_after: Duration | null;
  personal: boolean;
  balance_type: MembershipBalanceType;
  shared_visits: number | null;
  shared_unlimited: boolean;
  services: AllowanceInput[];
  freeze_allowed: boolean;
  freeze_limit: Duration | null;
  booking_while_frozen: boolean;
  recalculate_service_price: boolean;
  balance_edit: BalanceEditPolicy;
  online_sale_enabled: boolean;
  online_sale_title: string;
  online_sale_price: number;
  online_sale_description: string;
  type_category_id: number | null;
}

/** A membership sold to a client. */
export interface Membership {
  id: number;
  /** The membership's number (its code). */
  number: string | null;
  chain_id: number | null;
  type_id: number | null;
  type_title: string | null;
  status: MembershipStatus;
  created_at: string | null;
  activated_at: string | null;
  expires_at: string | null;
  frozen: boolean;
  /** Days the membership has spent frozen so far. */
  frozen_days: number | null;
  validity: Duration | null;
  balance_type: MembershipBalanceType;
  /** Visits left in the shared pool; null for a per-service balance or unlimited. */
  shared_visits_left: number | null;
  shared_unlimited: boolean;
  /** Covered services; `visits` is what is left of each. */
  services: MembershipAllowance[];
  /** The product sale the membership came from, when linked. */
  sale_transaction_id: number | null;
}

export interface MembershipListQuery {
  /** Either the ids… */
  ids?: number[];
  /** …or a creation period, `YYYY-MM-DD` inclusive on both ends. */
  created_from?: string;
  created_to?: string;
  page: number;
  page_size: number;
}

/** New visit counts for a sold membership. */
export interface BalanceChange {
  /** The shared pool. */
  shared_visits?: number;
  /** Per covered service or service category, by its id. */
  services?: { id: number; visits: number }[];
}

export interface MembershipsApi {
  /** Chains the signed-in user belongs to, with their membership rights. */
  listChains(): Promise<ChainAccess[]>;

  listTypes(
    chainId: number,
    query: {
      title?: string;
      archived?: boolean;
      page: number;
      page_size: number;
    }
  ): Promise<MembershipTypePage>;
  getType(chainId: number, typeId: number): Promise<MembershipType>;
  createType(
    chainId: number,
    fields: MembershipTypeFields
  ): Promise<MembershipType>;
  /** Replace every field of the type; the caller merges the changes. */
  updateType(
    chainId: number,
    typeId: number,
    fields: MembershipTypeFields
  ): Promise<MembershipType>;
  setTypeArchived(
    chainId: number,
    typeId: number,
    archived: boolean
  ): Promise<void>;
  deleteType(chainId: number, typeId: number): Promise<void>;

  listMemberships(
    chainId: number,
    query: MembershipListQuery
  ): Promise<Membership[]>;
  getMembership(chainId: number, membershipId: number): Promise<Membership>;
  /** A client's current memberships, found by the phone on the client card. */
  listClientMemberships(
    locationId: number,
    clientId: number,
    chainId?: number
  ): Promise<Membership[]>;
  /** Freeze until a date (`YYYY-MM-DD`), or until unfrozen. */
  freeze(
    chainId: number,
    membershipId: number,
    until?: string
  ): Promise<Membership>;
  unfreeze(chainId: number, membershipId: number): Promise<Membership>;
  setBalance(
    chainId: number,
    membershipId: number,
    change: BalanceChange
  ): Promise<void>;
  setValidity(
    chainId: number,
    membershipId: number,
    validity: Duration
  ): Promise<Membership>;
}
