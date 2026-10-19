/**
 * `FinanceApi` — the port the finance capability layer talks to (ADR-001 D5).
 *
 * It covers the money side of a location: the bill of a visit and the payments
 * recorded against it, client accounts and the `deposit` operation that tops
 * one up, accounts and cash registers, financial transactions, and a team
 * member's payroll for a period.
 *
 * Method names and DTOs use the product glossary — visit, payment, amount due,
 * client account, accounts and cash registers, payment item, payroll,
 * settlements, team member, products. The wire names (`document`, `sale`,
 * `deposit`, `loyalty_certificate`, `loyalty_abonement`, `prepay_hold`,
 * `expense`, `master`, `salary`, `record`, `good`, `kkm`) stop inside
 * `./v1/finance-adapter.ts`.
 *
 * Money is in major units, exactly as the API reports and accepts it, and is
 * always read next to the location's ISO currency code. Datetimes are RFC 3339
 * in the location's own offset.
 */

// ========== visit bill ==========

/** What one bill line sells. */
export type BillLineKind = 'service' | 'product' | 'other';

/** One line of a visit's bill. */
export interface BillLine {
  id: number;
  appointment_id: number | null;
  kind: BillLineKind;
  service_id: number | null;
  product_id: number | null;
  title: string | null;
  quantity: number | null;
  /** Catalog price of one unit, before discounts. */
  unit_price: number | null;
  /** Line total before the client's discount. */
  amount_before_discount: number | null;
  client_discount_percent: number | null;
  /** What the client pays for the line: the line total after discounts. */
  amount: number | null;
}

/**
 * How a payment is made, or can be made.
 *
 * `account` — money into one of the accounts and cash registers (cash or
 * non-cash); `client_account` — from the client's balance; `loyalty_card` —
 * from the balance of a loyalty card; `loyalty_program` — a loyalty program
 * applied to the visit; `gift_card`; `membership` — the visit is covered by a
 * membership; `referral_program`; `advance_payment_hold` — an advance payment
 * held for this visit is applied; `other` — a kind this build does not know.
 */
export type PaymentMethod =
  | 'account'
  | 'client_account'
  | 'loyalty_card'
  | 'loyalty_program'
  | 'gift_card'
  | 'membership'
  | 'referral_program'
  | 'advance_payment_hold'
  | 'other';

/** One payment recorded against the bill. */
export interface VisitPayment {
  /**
   * Stable payment id: `t<number>` for money into an account or cash
   * register, `l<number>` for a payment from a client account or a loyalty
   * instrument.
   */
  id: string;
  method: PaymentMethod;
  amount: number;
  /** The bill line it pays, when the API attributes it to one. */
  bill_line_id: number | null;
  account_id: number | null;
  account_title: string | null;
  /** Payment method configured for the location, e.g. "Cash", "Card". */
  payment_method_name: string | null;
  client_account_id: number | null;
  loyalty_card_id: number | null;
  loyalty_program_id: number | null;
  gift_card_id: number | null;
  membership_id: number | null;
}

/** An advance payment held on a client account for this visit. */
export interface AdvancePaymentHold {
  id: number;
  client_account_id: number | null;
  amount: number | null;
  /** `active`, `completed`, … as the API reports it. */
  status: string | null;
}

/** One way the bill can be paid right now, with what it would accept. */
export interface PaymentOption {
  method: PaymentMethod;
  applicable: boolean;
  /** The most this method can pay now. */
  applicable_amount: number | null;
  /** false — the method must pay `applicable_amount` in one payment. */
  partial_allowed: boolean;
  account_id: number | null;
  account_title: string | null;
  /** For an account: cash (true) or non-cash settlement (false). */
  cash: boolean | null;
  client_account_id: number | null;
  loyalty_card_id: number | null;
  loyalty_card_number: string | null;
  loyalty_program_id: number | null;
  loyalty_program_title: string | null;
  gift_card_id: number | null;
  membership_id: number | null;
  /** Gift card or membership: its number must be sent with the payment. */
  number_required: boolean | null;
  /** Visits a membership can still cover. */
  applicable_visits: number | null;
  advance_payment_hold_id: number | null;
  /** Balance of the client account, loyalty card or gift card. */
  balance: number | null;
  /** The chain the instrument belongs to. */
  chain_id: number | null;
}

/** The bill of one appointment's visit. */
export interface VisitBill {
  location_id: number;
  appointment_id: number;
  visit_id: number | null;
  client_id: number | null;
  lines: BillLine[];
  payments: VisitPayment[];
  advance_payment_holds: AdvancePaymentHold[];
  payment_options: PaymentOption[];
  /** Sum of the line amounts. */
  total_amount: number;
  /** Sum of the recorded payments. */
  paid_amount: number;
  /** What the client still has to pay. */
  amount_due: number;
}

/** A payment to record, by method; every id comes from `payment_options`. */
export type PaymentRequest =
  | { method: 'account'; account_id: number; amount: number }
  | { method: 'client_account'; client_account_id: number; amount: number }
  | { method: 'loyalty_card'; loyalty_card_id: number; amount: number }
  | {
      method: 'loyalty_program';
      loyalty_card_id: number;
      loyalty_program_id: number;
    }
  | {
      method: 'gift_card';
      gift_card_id: number;
      amount: number;
      number?: string;
    }
  | { method: 'membership'; membership_id: number; number?: string }
  | {
      method: 'advance_payment_hold';
      advance_payment_hold_id: number;
      amount: number;
    };

// ========== client accounts ==========

/** A client's money balance held by the chain the location belongs to. */
export interface ClientAccount {
  id: number;
  chain_id: number | null;
  type_id: number | null;
  type_title: string | null;
  balance: number | null;
  /** Part of the balance held for advance payments. */
  reserved_balance: number | null;
  initial_balance: number | null;
  blocked: boolean;
  created_at: string | null;
}

export interface ClientAccountDepositRequest {
  client_id: number;
  client_account_id: number;
  /** Money received, in major units; above zero. */
  amount: number;
  /** Where the money is received: one of the accounts and cash registers. */
  account_id: number;
  team_member_id?: number;
}

export interface ClientAccountDepositResult {
  client_account_id: number;
  amount: number;
  balance_after: number | null;
  reserved_balance_after: number | null;
  /** The financial transaction that records the money received. */
  financial_transaction_id: number | null;
}

// ========== accounts and cash registers ==========

/**
 * One of the location's accounts and cash registers: an internal till or a
 * payment account where money is recorded. Not a fiscal device.
 */
export interface CashRegisterOrAccount {
  id: number;
  title: string | null;
  /** `cash` — cash settlement; `non_cash` — non-cash settlement. */
  settlement: 'cash' | 'non_cash';
  /** Belongs to online acquiring. */
  acquiring: boolean;
  comment: string | null;
}

// ========== financial transactions ==========

export interface FinancialTransaction {
  id: number;
  /** RFC 3339 in the location's offset. */
  date: string | null;
  /** Above zero for income, below zero for an expense. */
  amount: number;
  direction: 'income' | 'expense';
  payment_item_id: number | null;
  payment_item_title: string | null;
  account_id: number | null;
  account_title: string | null;
  client_id: number | null;
  team_member_id: number | null;
  supplier_id: number | null;
  /** Set when a visit, a product sale or a client account deposit recorded it. */
  document_id: number | null;
  appointment_id: number | null;
  visit_id: number | null;
  comment: string | null;
  /** RFC 3339 in the location's offset. */
  changed_at: string | null;
}

export interface FinancialTransactionQuery {
  date_from: string;
  date_to: string;
  account_id?: number;
  client_id?: number;
  team_member_id?: number;
  supplier_id?: number;
  page: number;
  page_size: number;
}

/** Every field a financial transaction is written with. */
export interface FinancialTransactionFields {
  payment_item_id: number;
  account_id: number;
  /** Major units, above zero; the payment item decides income or expense. */
  amount: number;
  /** Location-local wall time, `YYYY-MM-DD HH:MM:SS`. */
  local_date: string;
  client_id: number | null;
  team_member_id: number | null;
  supplier_id: number | null;
  comment: string;
}

/**
 * The income or expense category a payment item belongs to — the section of
 * the finance reports it is counted in. `income` is the only income category.
 */
export type IncomeExpenseCategory =
  | 'prime_cost'
  | 'commercial'
  | 'personnel'
  | 'administrative'
  | 'taxes_and_fees'
  | 'miscellaneous'
  | 'income'
  | 'unknown';

/** What a financial transaction is for: rent, product purchase, services. */
export interface PaymentItem {
  id: number;
  title: string | null;
  category: IncomeExpenseCategory;
  direction: 'income' | 'expense';
}

// ========== payroll ==========

/** Payroll computed for a team member over a period. */
export interface PayrollCalculation {
  working_days: number | null;
  working_hours: number | null;
  services_count: number | null;
  group_services_count: number | null;
  services_amount: number | null;
  product_sales_count: number | null;
  product_sales_amount: number | null;
  /** Services plus product sales the payroll is computed from. */
  revenue_amount: number | null;
  /** What the team member is paid for the period. */
  payroll_amount: number | null;
  guaranteed_minimum_amount: number | null;
  bonus_count: number | null;
  bonus_amount: number | null;
  penalty_count: number | null;
  penalty_amount: number | null;
}

/** Settlements with the team member: accrued, paid out, balance. */
export interface PayrollSettlements {
  accrued_amount: number | null;
  paid_amount: number | null;
  /** Accrued minus paid; above zero means the team member is still owed. */
  balance: number | null;
}

/** A payroll calculation saved for the team member. */
export interface SavedPayrollCalculation {
  id: number;
  date_from: string | null;
  date_to: string | null;
  amount: number | null;
  status: string | null;
}

export interface PayrollReport {
  /** null — no payroll scheme applies to the team member in the period. */
  calculation: PayrollCalculation | null;
  settlements: PayrollSettlements | null;
  saved_calculations: SavedPayrollCalculation[];
  saved_calculations_total: number | null;
}

// ========== the port ==========

export interface FinanceApi {
  /** The bill of the visit an appointment belongs to. */
  getVisitBill(locationId: number, appointmentId: number): Promise<VisitBill>;
  /** Record a payment and return the bill after it. */
  addPayment(
    locationId: number,
    appointmentId: number,
    payment: PaymentRequest
  ): Promise<VisitBill>;
  /** Cancel one recorded payment and return the bill after it. */
  cancelPayment(
    locationId: number,
    appointmentId: number,
    paymentId: string
  ): Promise<VisitBill>;

  listClientAccounts(
    locationId: number,
    clientId: number
  ): Promise<ClientAccount[]>;
  deposit(
    locationId: number,
    request: ClientAccountDepositRequest
  ): Promise<ClientAccountDepositResult>;

  listCashRegistersAndAccounts(
    locationId: number
  ): Promise<CashRegisterOrAccount[]>;

  listPaymentItems(locationId: number): Promise<PaymentItem[]>;
  listFinancialTransactions(
    locationId: number,
    query: FinancialTransactionQuery
  ): Promise<FinancialTransaction[]>;
  getFinancialTransaction(
    locationId: number,
    transactionId: number
  ): Promise<FinancialTransaction>;
  createFinancialTransaction(
    locationId: number,
    fields: FinancialTransactionFields
  ): Promise<FinancialTransaction>;
  /**
   * Replace every field of the transaction; the caller merges the changes.
   * Only for a transaction no document recorded: the body carries no document,
   * so the update leaves it unlinked.
   */
  updateFinancialTransaction(
    locationId: number,
    transactionId: number,
    fields: FinancialTransactionFields
  ): Promise<FinancialTransaction>;
  deleteFinancialTransaction(
    locationId: number,
    transactionId: number
  ): Promise<void>;

  getPayroll(
    locationId: number,
    teamMemberId: number,
    period: { date_from: string; date_to: string }
  ): Promise<PayrollReport>;
}
