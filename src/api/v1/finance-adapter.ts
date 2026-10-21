/**
 * Adapter for the `FinanceApi` port over V1.
 *
 * V2 has no finance operation, and the V3 ones (`listAccounts` and the
 * transaction and payroll operations) are still `planned` in the spec and not
 * served, so every call here is V1 (the product owner's rule of 2026-09-29: V2
 * first, V1 only where V2 has nothing). The port speaks the product glossary;
 * the wire names stop here: `deposit`, `expense`, `master`, `salary`, `kkm`.
 * The visit and its payments are the `VisitsApi` port (`./visits-adapter.ts`).
 *
 * Contract details verified live on the test location (2026-10-19):
 *
 * - A financial transaction's sign follows its payment item: an expense item
 *   stores a positive amount as negative, an income item stores any amount as
 *   positive. The tools therefore take a positive amount.
 * - `PUT /finance_transactions/{id}` replaces every field — an omitted team
 *   member, client, supplier or document is cleared — so an update reads the
 *   transaction first and sends every field back.
 * - Create stores `date` as server wall time and update converts it from the
 *   location's; see `./server-time.ts`.
 * - The payroll period read answers 416 when no payroll scheme applies to the
 *   team member; that is reported as "no calculation", not as a failure.
 * - V1 reads and writes money as decimal major units; a write's `Money` is sent
 *   as `majorOf(money)`.
 * - V1 has no idempotency header, so the write methods ignore the
 *   `idempotency_key` of their `WriteOptions` (`../write-options.ts`).
 */
import { httpFromClient, type AltegioHttp } from '../altegio-http.js';
import type { AltegioClient } from '../../providers/altegio-client.js';
import { majorOf } from '../money.js';
import {
  FinanceInputError,
  mapFinanceHttpError,
  type FinanceErrorHints,
} from '../../capabilities/finance/errors.js';
import { knownLocationTimezone } from '../../capabilities/analytics/location-timezone.js';
import {
  V1_SERVER_TIMEZONE,
  instantOfWallTime,
  v1DateForLocation,
  wallTime,
} from './server-time.js';
import {
  asRow,
  flag,
  id,
  num,
  rows,
  text,
  v1Call,
  v1Read,
  type Row,
  type V1CallOptions,
  type V1Envelope,
} from './envelope.js';
import type {
  CashRegisterOrAccount,
  ClientAccount,
  ClientAccountDepositRequest,
  ClientAccountDepositResult,
  FinanceApi,
  FinancialTransaction,
  FinancialTransactionFields,
  FinancialTransactionQuery,
  IncomeExpenseCategory,
  PaymentItem,
  PayrollCalculation,
  PayrollReport,
  PayrollSettlements,
  SavedPayrollCalculation,
} from '../finance-api.js';

/** Saved payroll calculations listed next to the period's payroll. */
const SAVED_CALCULATIONS_SHOWN = 20;

// ========== client accounts, accounts and cash registers ==========

function clientAccountFromWire(row: Row): ClientAccount {
  const account = asRow(row.deposit);
  const type = asRow(row.deposit_type);
  return {
    id: id(account.id) ?? 0,
    chain_id: id(account.salon_group_id) ?? id(type.salon_group_id),
    type_id: id(account.deposit_type_id) ?? id(type.id),
    type_title: text(type.title),
    balance: num(account.balance),
    reserved_balance: num(account.reserved_balance),
    initial_balance: num(account.initial_balance),
    blocked: flag(account.blocked) === true,
    created_at: text(account.date_create),
  };
}

function cashRegisterFromWire(row: Row): CashRegisterOrAccount {
  const slug = text(row.type_slug);
  const cash = slug ? slug === 'cash' : num(row.type) === 0;
  return {
    id: id(row.id) ?? 0,
    title: text(row.title),
    settlement: cash ? 'cash' : 'non_cash',
    acquiring: flag(row.is_acquiring) === true,
    comment: text(row.comment),
  };
}

// ========== financial transactions ==========

const CATEGORY_FROM_WIRE: Record<number, IncomeExpenseCategory> = {
  1: 'prime_cost',
  2: 'commercial',
  3: 'personnel',
  4: 'operational',
  5: 'taxes_and_fees',
  6: 'other_expenses',
  7: 'revenue',
};

function paymentItemFromWire(row: Row): PaymentItem {
  const category = CATEGORY_FROM_WIRE[num(row.type) ?? 0] ?? 'unknown';
  return {
    id: id(row.id) ?? 0,
    title: text(row.title),
    category,
    direction: category === 'revenue' ? 'income' : 'expense',
  };
}

function transactionFromWire(
  row: Row,
  zone: string | null
): FinancialTransaction {
  const amount = num(row.amount) ?? 0;
  const item = asRow(row.expense);
  const account = asRow(row.account);
  const team = row.master;
  const teamId = Array.isArray(team) ? null : id(asRow(team).id);
  return {
    id: id(row.id) ?? 0,
    date: v1DateForLocation(row.date, zone),
    amount,
    direction:
      amount < 0 || (amount === 0 && num(item.type) !== 7)
        ? 'expense'
        : 'income',
    payment_item_id: id(row.expense_id) ?? id(item.id),
    payment_item_title: text(item.title),
    account_id: id(row.account_id) ?? id(account.id),
    account_title: text(account.title),
    client_id: id(row.client_id) ?? id(asRow(row.client).id),
    team_member_id: id(row.master_id) ?? teamId,
    supplier_id: id(row.supplier_id) ?? id(asRow(row.supplier).id),
    document_id: id(row.document_id),
    appointment_id: id(row.record_id),
    visit_id: id(row.visit_id),
    comment: text(row.comment),
    changed_at: v1DateForLocation(row.last_change_date, zone),
  };
}

function transactionBody(
  fields: FinancialTransactionFields,
  date: string
): Row {
  return {
    expense_id: fields.payment_item_id,
    account_id: fields.account_id,
    amount: majorOf(fields.amount),
    date,
    comment: fields.comment,
    client_id: fields.client_id ?? 0,
    team_member_id: fields.team_member_id ?? 0,
    supplier_id: fields.supplier_id ?? 0,
    ...(fields.document_id ? { document_id: fields.document_id } : {}),
  };
}

// ========== payroll ==========

function payrollFromWire(row: Row): PayrollCalculation {
  return {
    working_days: num(row.working_days_count),
    working_hours: num(row.working_hours_count),
    services_count: num(row.services_count),
    group_services_count: num(row.group_services_count),
    services_amount: num(row.services_sum),
    product_sales_count: num(row.goods_sales_count),
    product_sales_amount: num(row.goods_sales_sum),
    revenue_amount: num(row.total_sum),
    payroll_amount: num(row.salary),
    guaranteed_minimum_amount: num(row.guaranteed_minimum_sum),
    bonus_count: num(row.bonus_count),
    bonus_amount: num(row.bonus_sum),
    penalty_count: num(row.penalty_count),
    penalty_amount: num(row.penalty_sum),
  };
}

function settlementsFromWire(row: Row): PayrollSettlements {
  const total = asRow(row.total_sum);
  const paid = num(total.expense);
  return {
    accrued_amount: num(total.income),
    paid_amount: paid === null ? null : Math.abs(paid),
    balance: num(total.balance),
  };
}

function savedCalculationFromWire(row: Row): SavedPayrollCalculation {
  return {
    id: id(row.id) ?? 0,
    date_from: text(row.date_from),
    date_to: text(row.date_to),
    amount: num(row.amount),
    status: text(row.status),
  };
}

// ========== the adapter ==========

export type ZoneResolver = (locationId: number) => Promise<string | null>;

export class FinanceAdapter implements FinanceApi {
  constructor(
    private readonly http: AltegioHttp,
    private readonly zoneOf: ZoneResolver = async () => null,
    private readonly now: () => number = Date.now
  ) {}

  static forClient(client: AltegioClient): FinanceAdapter {
    return new FinanceAdapter(httpFromClient(client), (locationId) =>
      knownLocationTimezone(client, locationId)
    );
  }

  private async call(
    path: string,
    context: string,
    options: V1CallOptions<FinanceErrorHints> = {}
  ): Promise<V1Envelope | null> {
    return v1Call(this.http, path, context, mapFinanceHttpError, options);
  }

  private async read(
    path: string,
    context: string,
    options: V1CallOptions<FinanceErrorHints> = {}
  ): Promise<V1Envelope> {
    return v1Read(this.http, path, context, mapFinanceHttpError, options);
  }

  // ----- client accounts -----

  async listClientAccounts(
    locationId: number,
    clientId: number
  ): Promise<ClientAccount[]> {
    const { data } = await this.read(
      `/deposits/company/${locationId}/client/${clientId}`,
      `list the client accounts of client ${clientId}`,
      {
        hints: {
          notFound:
            'Check the client id with clients_lookup or clients_search for this location.',
        },
      }
    );
    return rows(data)
      .map(clientAccountFromWire)
      .filter((account) => account.id > 0);
  }

  async deposit(
    locationId: number,
    request: ClientAccountDepositRequest
  ): Promise<ClientAccountDepositResult> {
    const { data } = await this.read(
      `/deposits_operations/${locationId}`,
      `deposit money to client account ${request.client_account_id}`,
      {
        method: 'POST',
        body: {
          client_id: request.client_id,
          deposit_id: request.client_account_id,
          amount: majorOf(request.amount),
          account_id: request.account_id,
          ...(request.team_member_id !== undefined
            ? { team_member_id: request.team_member_id }
            : {}),
        },
        hints: {
          invalid:
            'Take client_account_id from client_accounts_list_for_client for this client and account_id from accounts_and_cash_registers_list; the amount must be above zero.',
        },
      }
    );
    const body = asRow(data);
    const movement =
      rows(body.deposits_transactions).find(
        (row) => id(row.deposit_id) === request.client_account_id
      ) ?? rows(body.deposits_transactions)[0];
    const money = rows(body.payment_transactions)[0];
    return {
      client_account_id: request.client_account_id,
      amount: num(movement?.amount) ?? majorOf(request.amount),
      balance_after: num(movement?.balance_after),
      reserved_balance_after: num(movement?.reserved_balance_after),
      financial_transaction_id: money ? id(money.id) : null,
    };
  }

  // ----- accounts and cash registers -----

  async listCashRegistersAndAccounts(
    locationId: number
  ): Promise<CashRegisterOrAccount[]> {
    const { data } = await this.read(
      `/accounts/${locationId}`,
      'list the accounts and cash registers of this location'
    );
    return rows(data)
      .map(cashRegisterFromWire)
      .filter((account) => account.id > 0);
  }

  // ----- financial transactions -----

  async listPaymentItems(locationId: number): Promise<PaymentItem[]> {
    const { data } = await this.read(
      `/references/expenses/${locationId}`,
      'list the payment items of this location'
    );
    return rows(data)
      .map(paymentItemFromWire)
      .filter((item) => item.id > 0);
  }

  async listFinancialTransactions(
    locationId: number,
    query: FinancialTransactionQuery
  ): Promise<FinancialTransaction[]> {
    const [{ data }, zone] = await Promise.all([
      this.read(
        `/transactions/${locationId}`,
        'list the financial transactions of this location',
        {
          query: {
            start_date: query.date_from,
            end_date: query.date_to,
            account_id: query.account_id,
            client_id: query.client_id,
            team_member_id: query.team_member_id,
            supplier_id: query.supplier_id,
            page: query.page,
            count: query.page_size,
          },
        }
      ),
      this.zoneOf(locationId),
    ]);
    return rows(data).map((row) => transactionFromWire(row, zone));
  }

  async getFinancialTransaction(
    locationId: number,
    transactionId: number
  ): Promise<FinancialTransaction> {
    const [{ data }, zone] = await Promise.all([
      this.read(
        `/finance_transactions/${locationId}/${transactionId}`,
        `read financial transaction ${transactionId}`,
        {
          hints: {
            notFound:
              'Check the id with financial_transactions_list; a deleted transaction is not found.',
          },
        }
      ),
      this.zoneOf(locationId),
    ]);
    return transactionFromWire(asRow(data), zone);
  }

  async createFinancialTransaction(
    locationId: number,
    fields: FinancialTransactionFields
  ): Promise<FinancialTransaction> {
    const zone = await this.zoneOf(locationId);
    if (zone === null) {
      throw new FinanceInputError(
        `The time zone of location ${locationId} is unknown, so the transaction date cannot be placed. Check the location with locations_list.`
      );
    }
    const instant = instantOfWallTime(fields.local_date, zone) ?? this.now();
    const { data } = await this.read(
      `/finance_transactions/${locationId}`,
      'create a financial transaction',
      {
        method: 'POST',
        body: transactionBody(fields, wallTime(instant, V1_SERVER_TIMEZONE)),
        hints: TRANSACTION_WRITE_HINTS,
      }
    );
    return transactionFromWire(asRow(data), zone);
  }

  async updateFinancialTransaction(
    locationId: number,
    transactionId: number,
    fields: FinancialTransactionFields
  ): Promise<FinancialTransaction> {
    const zone = await this.zoneOf(locationId);
    const { data } = await this.read(
      `/finance_transactions/${locationId}/${transactionId}`,
      `update financial transaction ${transactionId}`,
      {
        method: 'PUT',
        // The update converts `date` from location time itself.
        body: transactionBody(fields, fields.local_date),
        hints: TRANSACTION_WRITE_HINTS,
      }
    );
    return transactionFromWire(asRow(data), zone);
  }

  async deleteFinancialTransaction(
    locationId: number,
    transactionId: number
  ): Promise<void> {
    await this.read(
      `/finance_transactions/${locationId}/${transactionId}`,
      `delete financial transaction ${transactionId}`,
      {
        method: 'DELETE',
        hints: {
          notFound:
            'Check the id with financial_transactions_list; it may already be deleted.',
        },
      }
    );
  }

  /**
   * The route carries no location: the caller reads the document at its
   * location first, so a document of another location never gets here.
   */
  async listDocumentTransactions(
    locationId: number,
    documentId: number
  ): Promise<FinancialTransaction[]> {
    const [{ data }, zone] = await Promise.all([
      this.read(
        `/storage_operations/documents/finance_transactions/${documentId}`,
        `read the financial transactions of document ${documentId}`,
        {
          hints: {
            forbidden:
              'Reading the payments of a document needs the Finances access rights at the location; ask the location owner for them.',
          },
        }
      ),
      this.zoneOf(locationId),
    ]);
    return rows(data).map((row) => transactionFromWire(row, zone));
  }

  // ----- payroll -----

  async getPayroll(
    locationId: number,
    teamMemberId: number,
    period: { date_from: string; date_to: string }
  ): Promise<PayrollReport> {
    const base = `/locations/${locationId}/salary`;
    const query = { date_from: period.date_from, date_to: period.date_to };
    const hints: FinanceErrorHints = {
      notFound:
        'Check the team member id with team_members_list for this location.',
      forbidden:
        'Payroll needs the Payroll right at this location (or the right to see this team member’s own payroll); ask the location owner for it.',
    };
    const [calculation, settlements, saved] = await Promise.all([
      this.call(
        `${base}/period/team_members/${teamMemberId}`,
        `read the payroll of team member ${teamMemberId}`,
        { query, hints, tolerate: [416] }
      ),
      this.read(
        `${base}/calculation/team_members/${teamMemberId}`,
        `read the settlements with team member ${teamMemberId}`,
        { query, hints }
      ),
      this.read(
        `${base}/payroll/team_members/${teamMemberId}/calculation`,
        `list the saved payroll calculations of team member ${teamMemberId}`,
        { query, hints }
      ),
    ]);
    const savedRows = rows(saved.data);
    return {
      calculation: calculation
        ? payrollFromWire(asRow(calculation.data))
        : null,
      settlements: settlementsFromWire(asRow(settlements.data)),
      saved_calculations: savedRows
        .slice(0, SAVED_CALCULATIONS_SHOWN)
        .map(savedCalculationFromWire),
      saved_calculations_total: num(saved.meta.count) ?? savedRows.length,
    };
  }
}

const TRANSACTION_WRITE_HINTS: FinanceErrorHints = {
  invalid:
    'Take account_id from accounts_and_cash_registers_list, payment_item_id from financial_transactions_list_payment_items and supplier_id from suppliers_and_partners_list; the amount must be above zero, and a user may be limited to some accounts, payment items or recent days.',
};
