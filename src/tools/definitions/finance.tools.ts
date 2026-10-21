/**
 * Finance tool packs — client accounts, accounts and cash registers, financial
 * transactions and payroll.
 *
 * - `client_accounts_*` — a client's money balance held by the chain, and the
 *   `deposit` operation that tops it up. Never called "deposit" as an object,
 *   never a login.
 * - `accounts_and_cash_registers_list` — the internal tills and payment
 *   accounts where a location records money (the canonical term; "accounts"
 *   alone reads as logins or bank accounts, and none of these is a fiscal
 *   device).
 * - `financial_transactions_*` — individual money movements in and out:
 *   cash operations, expenses, income outside a visit. Their Suppliers and
 *   Partners come from `suppliers_and_partners_list` (the inventory pack,
 *   also on finance).
 * - `payroll_get_calculation` — a team member's payroll for a period and the
 *   settlements with them.
 *
 * Wire names (`deposit`, `deposit_id`, `expense_id`, `master_id`, `salary`,
 * `kkm`) stop in `src/api/v1/finance-adapter.ts`.
 */
import { z } from 'zod';
import { defineTool } from '../factory.js';
import { pageArg, pageSizeArg, paginationOutput } from '../pagination.js';
import * as finance from '../../capabilities/finance/use-cases.js';
import { moneyAmount } from './visits.tools.js';

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

const int = { type: ['integer', 'null'] as const };
const num = { type: ['number', 'null'] as const };
const str = { type: ['string', 'null'] as const };

const locationId = z
  .number()
  .int()
  .positive()
  .describe('Location id, from locations_list.');

const clientId = z
  .number()
  .int()
  .positive()
  .describe('Client id, from clients_lookup or clients_search.');

const accountId = z
  .number()
  .int()
  .positive()
  .describe(
    'Account or cash register id, from accounts_and_cash_registers_list.'
  );

const day = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .describe(`${what} YYYY-MM-DD, inclusive.`);

const datetime = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/,
    'Use YYYY-MM-DDTHH:MM, or RFC 3339 with an offset'
  )
  .describe(
    'When the money moved: YYYY-MM-DDTHH:MM in the location’s time, or RFC 3339 with an offset.'
  );

const transactionId = z
  .number()
  .int()
  .positive()
  .describe('Financial transaction id, from financial_transactions_list.');

// ========== client accounts ==========

const clientAccountSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'integer' as const },
    chain_id: int,
    type_id: int,
    type_title: str,
    balance: num,
    reserved_balance: num,
    initial_balance: num,
    blocked: { type: 'boolean' as const },
    created_at: str,
  },
  required: ['id', 'balance', 'blocked'],
};

export const clientAccountsListForClientTool = defineTool({
  name: 'client_accounts_list_for_client',
  category: 'Finance',
  description:
    'A client’s client accounts — the money balance the chain holds for them, not a login: balance, the part held for advance payments, type, chain, blocked flag. Use an id for client_accounts_deposit, or to pay a visit with visits_add_payment (method client_account).',
  annotations: {
    title: 'Client accounts: a client’s balances',
    ...READ_ONLY,
  },
  input: z.object({
    location_id: locationId,
    client_id: clientId,
    page: pageArg,
    page_size: pageSizeArg(100),
  }),
  outputSchema: {
    type: 'object' as const,
    properties: {
      location_id: { type: 'integer' as const },
      client_id: { type: 'integer' as const },
      currency: str,
      items: { type: 'array' as const, items: clientAccountSchema },
      pagination: paginationOutput,
    },
    required: ['location_id', 'client_id', 'currency', 'items', 'pagination'],
  },
  handler: async ({ input, client }) =>
    finance.listClientAccounts(client, input),
});

export const clientAccountsDepositTool = defineTool({
  name: 'client_accounts_deposit',
  category: 'Finance',
  description:
    'Deposit money to a client account (top it up): money received from the client into an account or cash register (account_id) is added to the balance. Pass the balance from client_accounts_list_for_client as expected_balance; the call is refused if it changed. This server cannot reverse a deposit. Asks for confirmation first.',
  annotations: {
    title: 'Client accounts: deposit money',
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    client_id: clientId,
    client_account_id: z
      .number()
      .int()
      .positive()
      .describe('Client account id, from client_accounts_list_for_client.'),
    amount: moneyAmount('Money received from the client.'),
    account_id: accountId.describe(
      'Account or cash register that receives the money, from accounts_and_cash_registers_list.'
    ),
    team_member_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Team member who accepted the money (team_members_list).'),
    expected_balance: z
      .number()
      .describe(
        'Balance of the client account from the client_accounts_list_for_client read this deposit is based on.'
      ),
  }),
  confirm: {
    action: 'Deposit money to a client account',
    target: (input) =>
      `client account ${input.client_account_id} of client ${input.client_id}`,
    resolve: (input, client) => finance.describeClientAccount(client, input),
    detail: (input, client) => finance.checkMoneyArg(client, input),
    consequence: (input) =>
      `Records ${input.amount ?? '?'} (location currency) received from the client into account or cash register ${input.account_id ?? '?'} and adds it to the client account balance. This server has no tool to reverse a deposit; a correction is made by a person in Altegio.`,
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      location_id: { type: 'integer' as const },
      client_id: { type: 'integer' as const },
      currency: str,
      client_account_id: { type: 'integer' as const },
      amount: { type: 'number' as const },
      balance_after: num,
      reserved_balance_after: num,
      financial_transaction_id: int,
    },
    required: ['client_account_id', 'amount', 'currency'],
  },
  handler: async ({ input, client, confirmation }) =>
    finance.deposit(client, input, confirmation),
});

// ========== accounts and cash registers ==========

export const accountsAndCashRegistersListTool = defineTool({
  name: 'accounts_and_cash_registers_list',
  category: 'Finance',
  description:
    'The location’s accounts and cash registers — internal tills and payment accounts where money is recorded, each a cash or non-cash settlement, some for online acquiring. Not fiscal devices or card terminals. The id is the account_id for visits_add_payment, client_accounts_deposit and financial_transactions_*.',
  annotations: {
    title: 'Finance: accounts and cash registers',
    ...READ_ONLY,
  },
  input: z.object({
    location_id: locationId,
    page: pageArg,
    page_size: pageSizeArg(100),
  }),
  outputSchema: {
    type: 'object' as const,
    properties: {
      location_id: { type: 'integer' as const },
      items: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            id: { type: 'integer' as const },
            title: str,
            settlement: { type: 'string' as const, enum: ['cash', 'non_cash'] },
            acquiring: { type: 'boolean' as const },
            comment: str,
          },
          required: ['id', 'settlement', 'acquiring'],
        },
      },
      pagination: paginationOutput,
    },
    required: ['location_id', 'items', 'pagination'],
  },
  handler: async ({ input, client }) =>
    finance.listCashRegistersAndAccounts(client, input),
});

// ========== financial transactions ==========

const transactionSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'integer' as const },
    date: str,
    amount: { type: 'number' as const },
    direction: { type: 'string' as const, enum: ['income', 'expense'] },
    payment_item_id: int,
    payment_item_title: str,
    account_id: int,
    account_title: str,
    client_id: int,
    team_member_id: int,
    supplier_id: int,
    document_id: int,
    appointment_id: int,
    visit_id: int,
    comment: str,
    changed_at: str,
  },
  required: ['id', 'amount', 'direction'],
};

const transactionResultSchema = {
  type: 'object' as const,
  properties: {
    location_id: { type: 'integer' as const },
    currency: str,
    ...transactionSchema.properties,
    previous: transactionSchema,
  },
  required: ['location_id', 'currency', 'id', 'amount', 'direction'],
};

const transactionFieldInputs = {
  payment_item_id: z
    .number()
    .int()
    .positive()
    .describe(
      'Payment item (what the money is for), from financial_transactions_list_payment_items; its category decides income or expense.'
    ),
  amount: moneyAmount('Amount, above zero; the payment item sets the sign.'),
  client_id: clientId.optional().describe('Client the money is from or for.'),
  team_member_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Team member the money is from or for (team_members_list).'),
  supplier_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Supplier or partner the money is paid to or received from, from suppliers_and_partners_list.'
    ),
  comment: z
    .string()
    .max(255)
    .optional()
    .describe('Comment, up to 255 characters.'),
};

export const financialTransactionsListPaymentItemsTool = defineTool({
  name: 'financial_transactions_list_payment_items',
  category: 'Finance',
  description:
    'The location’s payment items — what a financial transaction is for (rent, product purchase, team payroll, services rendered, custom items) — each with its income or expense category (prime_cost, commercial, personnel, operational, taxes_and_fees, other_expenses, revenue). The id is the payment_item_id for financial_transactions_create. Filter by direction.',
  annotations: { title: 'Finance: payment items', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    direction: z
      .enum(['income', 'expense'])
      .optional()
      .describe('Only income items or only expense items.'),
    page: pageArg,
    page_size: pageSizeArg(100),
  }),
  outputSchema: {
    type: 'object' as const,
    properties: {
      location_id: { type: 'integer' as const },
      items: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            id: { type: 'integer' as const },
            title: str,
            category: {
              type: 'string' as const,
              enum: [
                'prime_cost',
                'commercial',
                'personnel',
                'operational',
                'taxes_and_fees',
                'other_expenses',
                'revenue',
                'unknown',
              ],
            },
            direction: { type: 'string' as const, enum: ['income', 'expense'] },
          },
          required: ['id', 'category', 'direction'],
        },
      },
      pagination: paginationOutput,
    },
    required: ['location_id', 'items', 'pagination'],
  },
  handler: async ({ input, client }) => finance.listPaymentItems(client, input),
});

export const financialTransactionsListTool = defineTool({
  name: 'financial_transactions_list',
  category: 'Finance',
  description:
    'Financial transactions of a location for a period — money in and out: visit payments, product sales, client account deposits, cash operations, expenses. Each with signed amount (+ income, − expense), date, payment item, account or cash register, and the appointment, client, team member or supplier. Filter by account, client, team member or supplier. Paged: follow pagination.next_page.',
  annotations: { title: 'Finance: list financial transactions', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    date_from: day('First day.'),
    date_to: day('Last day.'),
    account_id: accountId.optional(),
    client_id: clientId.optional(),
    team_member_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Team member id (team_members_list).'),
    supplier_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Supplier or partner id (suppliers_and_partners_list).'),
    page: pageArg,
    page_size: pageSizeArg(100),
  }),
  outputSchema: {
    type: 'object' as const,
    properties: {
      location_id: { type: 'integer' as const },
      date_from: { type: 'string' as const },
      date_to: { type: 'string' as const },
      currency: str,
      items: { type: 'array' as const, items: transactionSchema },
      pagination: paginationOutput,
    },
    required: ['location_id', 'currency', 'items', 'pagination'],
  },
  handler: async ({ input, client }) =>
    finance.listFinancialTransactions(client, input),
});

export const financialTransactionsCreateTool = defineTool({
  name: 'financial_transactions_create',
  category: 'Finance',
  description:
    'Record a financial transaction outside a visit — a cash operation, an expense (rent, purchases, a payout) or other income — in an account or cash register under a payment item, which decides income or expense. Optional date (default now), client, team member, supplier, comment. Visit payments: visits_add_payment; client account top-ups: client_accounts_deposit. Asks for confirmation first.',
  annotations: {
    title: 'Finance: record a financial transaction',
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    payment_item_id: transactionFieldInputs.payment_item_id,
    account_id: accountId,
    amount: transactionFieldInputs.amount,
    date: datetime.optional(),
    client_id: transactionFieldInputs.client_id,
    team_member_id: transactionFieldInputs.team_member_id,
    supplier_id: transactionFieldInputs.supplier_id,
    comment: transactionFieldInputs.comment,
  }),
  confirm: {
    action: 'Record a financial transaction',
    target: (input) =>
      `account or cash register ${input.account_id} at location ${input.location_id}`,
    resolve: (input, client) => finance.describeNewTransaction(client, input),
    detail: (input, client) => finance.checkMoneyArg(client, input),
    consequence: (input) =>
      `Records ${input.amount ?? '?'} (location currency) under payment item ${input.payment_item_id ?? '?'} — income or expense as the payment item says — in account or cash register ${input.account_id ?? '?'}${input.date ? ` dated ${input.date}` : ', dated now'}. The account balance and the finance reports change. It can be undone with financial_transactions_delete.`,
  },
  outputSchema: transactionResultSchema,
  handler: async ({ input, client, confirmation }) =>
    finance.createFinancialTransaction(client, input, undefined, confirmation),
});

export const financialTransactionsUpdateTool = defineTool({
  name: 'financial_transactions_update',
  category: 'Finance',
  description:
    'Change a financial transaction recorded outside a visit: payment item, account or cash register, amount, date, client, team member, supplier, comment. Pass only what changes; clear removes a client, team member, supplier or comment. Transactions a visit payment, product sale or client account deposit recorded are refused — change them there. Asks for confirmation first, showing the change; refused if the transaction changes after that.',
  annotations: {
    title: 'Finance: change a financial transaction',
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    transaction_id: transactionId,
    payment_item_id: transactionFieldInputs.payment_item_id.optional(),
    account_id: accountId.optional(),
    amount: transactionFieldInputs.amount.optional(),
    date: datetime.optional(),
    client_id: transactionFieldInputs.client_id,
    team_member_id: transactionFieldInputs.team_member_id,
    supplier_id: transactionFieldInputs.supplier_id,
    comment: transactionFieldInputs.comment,
    clear: z
      .array(z.enum(['client', 'team_member', 'supplier', 'comment']))
      .min(1)
      .max(4)
      .optional()
      .describe('Fields to empty.'),
  }),
  confirm: {
    action: 'Change a financial transaction',
    target: (input) =>
      `financial transaction ${input.transaction_id} at location ${input.location_id}`,
    resolve: (input, client) => finance.describeTransaction(client, input),
    consequence:
      'The transaction’s fields are overwritten with the new values and the previous values are not kept; account balances and finance reports change with it.',
    detail: (input, client) => finance.describeTransactionChange(client, input),
  },
  outputSchema: transactionResultSchema,
  handler: async ({ input, client, confirmation }) =>
    finance.updateFinancialTransaction(client, input, confirmation),
});

export const financialTransactionsDeleteTool = defineTool({
  name: 'financial_transactions_delete',
  category: 'Finance',
  description:
    'Delete a financial transaction recorded outside a visit, or the payment of a product receipt (inventory_pay_document). Transactions a visit payment, product sale or client account deposit recorded are refused — cancel a visit payment with visits_cancel_payment. Asks for confirmation first.',
  annotations: {
    title: 'Finance: delete a financial transaction',
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({ location_id: locationId, transaction_id: transactionId }),
  confirm: {
    action: 'Delete a financial transaction',
    target: (input) =>
      `financial transaction ${input.transaction_id} at location ${input.location_id}`,
    resolve: (input, client) => finance.describeTransaction(client, input),
    detail: (input, client) =>
      finance.describeTransactionDeletion(client, input),
    consequence:
      'The transaction is removed from the account or cash register and from every finance report; this server cannot restore it.',
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      location_id: { type: 'integer' as const },
      currency: str,
      deleted: { type: 'boolean' as const },
      transaction: transactionSchema,
    },
    required: ['location_id', 'deleted', 'transaction'],
  },
  handler: async ({ input, client, confirmation }) =>
    finance.deleteFinancialTransaction(client, input, confirmation),
});

// ========== payroll ==========

export const payrollGetCalculationTool = defineTool({
  name: 'payroll_get_calculation',
  category: 'Payroll',
  description:
    'A team member’s payroll for a period: the amount computed by their payroll rules, the revenue it is computed from (services, product sales), working days and hours, guaranteed minimum, bonuses and penalties; the settlements with them (accrued, paid, balance owed); and the payroll calculations saved for the period.',
  annotations: { title: 'Payroll: a team member’s payroll', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    team_member_id: z
      .number()
      .int()
      .positive()
      .describe('Team member id, from team_members_list.'),
    date_from: day('First day.'),
    date_to: day('Last day.'),
  }),
  outputSchema: {
    type: 'object' as const,
    properties: {
      location_id: { type: 'integer' as const },
      team_member_id: { type: 'integer' as const },
      date_from: { type: 'string' as const },
      date_to: { type: 'string' as const },
      currency: str,
      calculation: {
        type: ['object', 'null'] as const,
        properties: {
          working_days: num,
          working_hours: num,
          services_count: num,
          group_services_count: num,
          services_amount: num,
          product_sales_count: num,
          product_sales_amount: num,
          revenue_amount: num,
          payroll_amount: num,
          guaranteed_minimum_amount: num,
          bonus_count: num,
          bonus_amount: num,
          penalty_count: num,
          penalty_amount: num,
        },
      },
      settlements: {
        type: ['object', 'null'] as const,
        properties: { accrued_amount: num, paid_amount: num, balance: num },
      },
      saved_calculations: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            id: { type: 'integer' as const },
            date_from: str,
            date_to: str,
            amount: num,
            status: str,
          },
          required: ['id'],
        },
      },
      saved_calculations_total: int,
    },
    required: [
      'location_id',
      'team_member_id',
      'currency',
      'calculation',
      'settlements',
      'saved_calculations',
    ],
  },
  handler: async ({ input, client }) => finance.getPayroll(client, input),
});
