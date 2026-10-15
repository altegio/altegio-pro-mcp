/**
 * Analytics data model — where each number comes from, for an analyst.
 *
 * The product-logic resource (`altegio://docs/product-logic`) describes the
 * platform for someone building against it; this module describes the same
 * objects for someone *reading the numbers*: which object a metric is computed
 * from, how appointments become money, what the report-builder datasets
 * aggregate, the coded values an analytics answer carries, and the ids and row
 * meanings that let code combine the results of several tools. It is the bridge
 * between "what a location is" and "what a figure means".
 *
 * Canonical vocabulary only — the legacy field names the API puts on the wire
 * (the `record`/`staff`/`company` dialect) are deliberately absent; the model an
 * agent reasons about is the V3 object model, and the mapping to the legacy
 * spelling lives once in `vocabulary.ts`. Data plus one renderer, like the
 * metric registry and the playbook, so the terminology test can scan it.
 */

/** One object in the chain from a booking to a paid, attributed visit. */
export interface EntityNode {
  /** Canonical object name. */
  readonly name: string;
  /** What it is, in one line. */
  readonly is: string;
  /** The analytics-relevant facts it carries. */
  readonly carries: string;
}

/**
 * The spine an analyst has to hold in mind: an appointment is scheduled time,
 * a visit is the money, a client is who it is attributed to.
 */
export const ENTITY_MODEL: readonly EntityNode[] = [
  {
    name: 'Location',
    is: 'One business unit — the scope of every analytics answer.',
    carries:
      'Its own timezone (period presets resolve in it), currency (an owner’s locations can differ), team, schedule and settings such as the lost-client threshold. There is no chain-wide roll-up: analyse one location at a time.',
  },
  {
    name: 'Appointment',
    is: 'One scheduled slot for one team member: who, what service, when.',
    carries:
      'A visit status (waiting, confirmed, arrived, no_show, cancelled), a source (online booking, client app, receptionist, API), the team member, the client (or none), the service list and the scheduled duration. It is scheduled time, not money — only an arrived appointment becomes revenue.',
  },
  {
    name: 'Visit',
    is: 'The billing unit: the appointment as delivered and paid for.',
    carries:
      'The items actually sold (services, products, memberships, gift cards), the payments that settled them, discounts and loyalty write-offs, and the link back to the client. Revenue, average check and the paid/unpaid state all come from the visit, not the appointment. One visit can group several appointments.',
  },
  {
    name: 'Client',
    is: 'The person a visit is attributed to.',
    carries:
      'Lifetime spent and visit count, first and last visit dates (these drive new / returning / lost), a personal discount, a priority class, categories, and a client-account balance. Clients are deduplicated by phone number, so two cards for one person count once in new / returning figures.',
  },
  {
    name: 'Payment',
    is: 'One settlement of a visit — real money or a loyalty instrument.',
    carries:
      'An amount, the account it landed in (which gives the cash-versus-non-cash split), and its kind: money on an account, a client-account top-up spent, a loyalty-card or program redemption, a membership or gift card. Real money reaches the day-end report as takings; loyalty and membership settlements are write-offs, value given away without cash arriving.',
  },
] as const;

/** A metric family mapped to the object it is computed from. */
export interface MetricSource {
  readonly family: string;
  readonly from: string;
  readonly note: string;
}

export const METRIC_SOURCES: readonly MetricSource[] = [
  {
    family: 'Revenue and average check',
    from: 'Visit items and payments, pre-aggregated by the key-metrics endpoint.',
    note: 'Total revenue is services + products + memberships + gift cards + client-account top-ups. Average check divides it by unique visits plus product-only sales, so a product-heavy day and a service-heavy day are not compared blindly — watch average_services_check next to it.',
  },
  {
    family: 'Appointments by outcome',
    from: 'Appointment visit status.',
    note: 'completed = arrived, pending = waiting or confirmed, cancelled = cancelled or no_show. The attendance rate is arrived over booked; the gap is the leak. Marking is a manual step: roughly one past appointment in eight is never moved off waiting or confirmed, so no-show and attendance rates undercount — treat them as a floor and cross-check revenue and visit counts, which do not depend on marking.',
  },
  {
    family: 'New / returning / active / lost clients',
    from: 'Client cards: first and last visit dates, deduplicated by phone.',
    note: 'New = first visit in the period; returning = visited before and again in the period; active = new + returning; lost = no visit for longer than the location’s threshold (60 days by default), measured against the whole base, so it lags.',
  },
  {
    family: 'Occupancy',
    from: 'Team-member schedules: booked hours over scheduled hours.',
    note: 'A team member with no schedule contributes no scheduled time, so their occupancy is blank, not zero. Idle hours = scheduled − booked is the size of the spare capacity.',
  },
  {
    family: 'Takings and write-offs (day-end report)',
    from: 'Payments grouped by account, and loyalty / membership / discount settlements.',
    note: 'Takings by account is real money in, split cash versus non-cash. Write-offs are discounts, loyalty bonuses, memberships and gift cards — value settled without money arriving. They reconcile revenue against the till.',
  },
  {
    family: 'Loyalty program results',
    from: 'Loyalty transactions tied to visits and a program.',
    note: 'Clients touched, split new versus known, how many returned, and the revenue attributed to the program — the read on whether the program brings people back.',
  },
] as const;

/**
 * The two parallel ledgers: a single sale writes to both, which is why a
 * finance figure and an inventory figure can be reconciled against each other.
 */
export const LEDGER_NOTE =
  'A sale moves two ledgers at once: the money ledger (a payment in or out of an account) and the product ledger (a unit leaving or entering inventory). Selling one product for its price writes +price to the money ledger and −1 unit to the product ledger, so product revenue and stock movement always reconcile. analytics_get_cash_flow_breakdown, analytics_get_client_cash_receipts and analytics_get_profit_and_loss_statement read the money ledger; analytics_get_product_sales and analytics_get_inventory_reorder_risks read the product ledger.';

/** Where an id appears: a tool and the exact path of the field in its result. */
export interface KeyField {
  readonly tool: string;
  /** Path in the tool's structured result, `items[]` for each item. */
  readonly field: string;
}

/**
 * An id several tools return: the same value names the same object in each,
 * so their rows join on it in code. Each field is checked against the tool's
 * output schema by `data-model.test.ts`.
 */
export interface JoinKey {
  readonly object: string;
  readonly fields: readonly KeyField[];
  /** What the join adds, beyond matching the rows. */
  readonly note?: string;
}

export const JOIN_KEYS: readonly JoinKey[] = [
  {
    object: 'Client',
    fields: [
      { tool: 'appointments_list', field: 'items[].client_id' },
      { tool: 'analytics_get_client_sales', field: 'items[].client_id' },
      {
        tool: 'analytics_get_client_reactivation_candidates',
        field: 'items[].client_id',
      },
      { tool: 'clients_get_segment_report', field: 'items[].id' },
      { tool: 'clients_search', field: 'items[].id' },
      { tool: 'clients_list_profiles', field: 'items[].id' },
      { tool: 'clients_lookup', field: 'items[].id' },
    ],
    note: 'clients_get_segment_report adds each client’s first_visit_date and last_visit_date, so appointment rows and client sales split by when their clients first or last came.',
  },
  {
    object: 'Team member',
    fields: [
      { tool: 'appointments_list', field: 'items[].team_member_id' },
      { tool: 'team_members_list', field: 'items[].id' },
      {
        tool: 'analytics_get_team_member_sales',
        field: 'items[].team_member_id',
      },
      {
        tool: 'analytics_get_team_member_capacity',
        field: 'items[].team_member_id',
      },
      {
        tool: 'analytics_get_client_retention',
        field: 'items[].team_member_id',
      },
      {
        tool: 'analytics_get_team_member_service_matrix',
        field: 'items[].team_member_id',
      },
    ],
  },
  {
    object: 'Service',
    fields: [
      { tool: 'appointments_list', field: 'items[].services[].id' },
      { tool: 'services_list', field: 'items[].id' },
      {
        tool: 'analytics_get_service_profitability',
        field: 'items[].service_id',
      },
      {
        tool: 'analytics_get_team_member_service_matrix',
        field: 'items[].service_id',
      },
    ],
  },
  {
    object: 'Location',
    fields: [{ tool: 'locations_list', field: 'items[].id' }],
    note: 'Every tool takes it as location_id. Money is in the location’s own currency, the currency field of analytics results.',
  },
] as const;

/** What one item of a widely joined result means, field by field. */
export interface SourceFact {
  readonly tool: string;
  readonly text: string;
}

export const SOURCE_FACTS: readonly SourceFact[] = [
  {
    tool: 'appointments_list',
    text: 'One item per appointment. datetime is local time with the location’s UTC offset: read weekday and hour from it as written. status arrived is a visit, no_show a client who did not come; waiting and confirmed are unmarked. Cancelled appointments come only with include_deleted (status cancelled, deleted true). An arrived item’s service revenue is the sum of services[].cost, each line’s total after discount and quantity; total_cost is that sum. client_id null is a walk-in, who belongs to no client. Over one period the arrived items’ services[].cost add up to revenue.services.current of analytics_get_overview, and per team_member_id to services_revenue of analytics_get_team_member_sales.',
  },
  {
    tool: 'analytics_get_client_sales',
    text: 'One item per client with a sale in the period. revenue counts services and products, so a client who only bought products has visits_count 0; visits_count counts days with an arrived visit, and average_check is revenue / visits_count. totals.revenue is the location’s revenue for the period including sales to no client, so the items can add up to less.',
  },
  {
    tool: 'clients_get_segment_report',
    text: 'One item per client card of the location, lifetime rather than per period. first_visit_date and last_visit_date (YYYY-MM-DD) are the client’s first and last arrived visits, null for a client who never came. A deleted client card is missing, while its past appointments keep its client_id.',
  },
  {
    tool: 'analytics_get_team_member_sales',
    text: 'One item per current team member. A deleted team member is missing, while their past appointments keep their team_member_id.',
  },
] as const;

/** How to read a paged result to its end. */
export const PAGING_NOTE =
  'A paged result carries pagination.next_page: repeat the call with page=next_page and the same page_size until it is null, at the largest page_size the tool’s description allows.';

/** One coded value family an analytics answer carries, in canonical form. */
export interface CodedValue {
  readonly field: string;
  readonly values: string;
  readonly meaning: string;
}

export const CODED_VALUES: readonly CodedValue[] = [
  {
    field: 'visit_status',
    values: 'waiting · confirmed · arrived · no_show · cancelled',
    meaning:
      'The lifecycle of an appointment. Only arrived produces a visit and revenue; no_show and cancelled are the leak; waiting and confirmed are still ahead.',
  },
  {
    field: 'payment_status',
    values: 'not_paid · paid_not_full · paid_over · fully paid',
    meaning:
      'How much of a visit is settled. paid_over means the client overpaid (money sits on their client account); not_paid and partial visits are receivables, not lost revenue.',
  },
  {
    field: 'appointment source',
    values: 'online booking · client app · receptionist · API · other',
    meaning:
      'Who created the appointment. A rising receptionist share with a flat online share means self-service is not catching on. This is the closest proxy to a booking funnel, which the product does not have.',
  },
  {
    field: 'client priority',
    values: 'none · bronze · silver · gold',
    meaning:
      'The client’s importance class, set by the location. Segment by it with the importance filter of clients_search or clients_get_segment_report.',
  },
  {
    field: 'money units',
    values: 'major units + ISO currency code',
    meaning:
      'Analytics results are whole-currency amounts (two decimals) next to a currency code, never minor units.',
  },
] as const;

/**
 * The four report-builder datasets, in analyst terms: what real-world objects
 * each one aggregates. The one-line descriptions live in `vocabulary.ts`
 * (`DATASET_DESCRIPTIONS`); this adds what to reach for each one for.
 */
export interface DatasetUse {
  readonly dataset: string;
  readonly reachFor: string;
}

export const DATASET_USES: readonly DatasetUse[] = [
  {
    dataset: 'sales',
    reachFor:
      'Anything about what was sold and to whom: revenue by team member, service or client, visits, new-versus-returning clients, occupancy, group-event attendance, product margin.',
  },
  {
    dataset: 'financial_transactions',
    reachFor:
      'Cash flow: income and expense items, cash versus non-cash, takings by account, P&L over time.',
  },
  {
    dataset: 'loyalty',
    reachFor:
      'Memberships and gift cards: units sold, revenue, value remaining, used versus remaining services, expiry buckets.',
  },
  {
    dataset: 'team_member_schedules',
    reachFor:
      'Time, not money: scheduled, booked and idle hours per team member, occupancy, working days, future appointments.',
  },
] as const;
