/**
 * `FinanceApi` — the port the finance capability layer talks to (ADR-001 D5).
 *
 * It covers the back-office money of a location: client accounts and the
 * `deposit` operation that tops one up, accounts and cash registers,
 * financial transactions, and a team member's payroll for a period. A visit —
 * its items, amount due and payments — is the `VisitsApi` port
 * (`./visits-api.ts`).
 *
 * Method names and DTOs use the product glossary — client account, accounts
 * and cash registers, payment item, payroll, settlements, team member. The
 * wire names (`deposit`, `expense`, `master`, `salary`, `kkm`) stop inside
 * `./v1/finance-adapter.ts`.
 *
 * Money read back is in major units, exactly as the API reports it, and is
 * always read next to the location's ISO currency code. Money written is a
 * `Money` (`./money.ts`): exact minor units with their exponent, which an
 * adapter turns into its wire form. Datetimes are RFC 3339 in the location's
 * own offset.
 *
 * Every write takes `WriteOptions`: the idempotency key a V3 adapter sends as
 * `Idempotency-Key` (see `./write-options.ts`).
 */

import type { Money } from './money.js';
import type { WriteOptions } from './write-options.js';

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
  /** Money received; above zero. */
  amount: Money;
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
  /** Above zero; the payment item decides income or expense. */
  amount: Money;
  /** Location-local wall time, `YYYY-MM-DD HH:MM:SS`. */
  local_date: string;
  client_id: number | null;
  team_member_id: number | null;
  supplier_id: number | null;
  comment: string;
}

/**
 * The income or expense category a payment item belongs to — the section of
 * the finance reports it is counted in, named as the Altegio UI labels it.
 * `revenue` is the only income category.
 */
export type IncomeExpenseCategory =
  | 'prime_cost'
  | 'commercial'
  | 'personnel'
  | 'operational'
  | 'taxes_and_fees'
  | 'other_expenses'
  | 'revenue'
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
  listClientAccounts(
    locationId: number,
    clientId: number
  ): Promise<ClientAccount[]>;
  deposit(
    locationId: number,
    request: ClientAccountDepositRequest,
    options?: WriteOptions
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
    fields: FinancialTransactionFields,
    options?: WriteOptions
  ): Promise<FinancialTransaction>;
  /**
   * Replace every field of the transaction; the caller merges the changes.
   * Only for a transaction no document recorded: the body carries no document,
   * so the update leaves it unlinked.
   */
  updateFinancialTransaction(
    locationId: number,
    transactionId: number,
    fields: FinancialTransactionFields,
    options?: WriteOptions
  ): Promise<FinancialTransaction>;
  deleteFinancialTransaction(
    locationId: number,
    transactionId: number,
    options?: WriteOptions
  ): Promise<void>;

  getPayroll(
    locationId: number,
    teamMemberId: number,
    period: { date_from: string; date_to: string }
  ): Promise<PayrollReport>;
}
