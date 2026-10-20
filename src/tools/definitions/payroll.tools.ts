/**
 * Payroll writes — `payroll_record_payout`.
 *
 * The payroll read, `payroll_get_calculation`, lives with the finance pack in
 * `./finance.tools.ts`. A payout is a financial transaction under the
 * personnel payment item that names the team member, which is what Altegio
 * counts as paid in the settlements with them. Wire names (`expense_id`,
 * `master_id`, `salary`) stop in `src/api/v1/finance-adapter.ts`.
 */
import { z } from 'zod';
import { defineTool } from '../factory.js';
import * as payroll from '../../capabilities/payroll/use-cases.js';
import { moneyAmount } from './visits.tools.js';

const int = { type: ['integer', 'null'] as const };
const num = { type: ['number', 'null'] as const };
const str = { type: ['string', 'null'] as const };

const settlementsSchema = {
  type: ['object', 'null'] as const,
  properties: {
    accrued_amount: num,
    paid_amount: num,
    balance: num,
  },
};

export const payrollRecordPayoutTool = defineTool({
  name: 'payroll_record_payout',
  category: 'Payroll',
  description:
    'Record a payout to a team member: money paid from an account or cash register as an expense under the personnel payment item, so their settlements count it as paid (payroll_get_calculation). Uses the location’s personnel payment item unless payment_item_id names another one. Optional date (default now) and comment. Refused when an identical payout was just recorded. Undo with financial_transactions_delete. Asks for confirmation first.',
  annotations: {
    title: 'Payroll: record a payout',
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('From locations_list.'),
    team_member_id: z
      .number()
      .int()
      .positive()
      .describe('The team member paid (team_members_list).'),
    amount: moneyAmount('Amount paid, above zero.'),
    account_id: z
      .number()
      .int()
      .positive()
      .describe(
        'Account or cash register the money is paid from (accounts_and_cash_registers_list).'
      ),
    payment_item_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'A personnel payment item, needed only when the location has several (financial_transactions_list_payment_items).'
      ),
    date: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/,
        'Use YYYY-MM-DDTHH:MM, or RFC 3339 with an offset'
      )
      .optional()
      .describe(
        'When it was paid: YYYY-MM-DDTHH:MM in the location’s time, or RFC 3339 with an offset.'
      ),
    comment: z
      .string()
      .max(255)
      .optional()
      .describe('Comment, up to 255 characters.'),
  }),
  confirm: {
    action: 'Record a payroll payout',
    target: (input) =>
      `team member ${input.team_member_id} at location ${input.location_id}`,
    resolve: async (input, client) => {
      const member = (await client.getStaff(input.location_id)).find(
        (candidate) => candidate.id === input.team_member_id
      );
      return member
        ? `team member ${member.name}, id ${member.id}, at location ${input.location_id}`
        : undefined;
    },
    consequence: (input) =>
      `Records ${input.amount ?? '?'} (location currency) paid to the team member from account or cash register ${input.account_id ?? '?'}${input.date ? `, dated ${input.date}` : ', dated now'}. The account balance, the finance reports and the team member’s settlements change. It can be undone with financial_transactions_delete.`,
    detail: (input, client) => payroll.describePayout(client, input),
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      location_id: { type: 'integer' as const },
      team_member_id: { type: 'integer' as const },
      currency: str,
      transaction: {
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
      },
      payment_item: {
        type: 'object' as const,
        properties: { id: { type: 'integer' as const }, title: str },
        required: ['id'],
      },
      settlements_period: {
        type: ['object', 'null'] as const,
        properties: {
          date_from: { type: 'string' as const },
          date_to: { type: 'string' as const },
        },
      },
      settlements: settlementsSchema,
    },
    required: [
      'location_id',
      'team_member_id',
      'currency',
      'transaction',
      'payment_item',
      'settlements_period',
      'settlements',
    ],
  },
  handler: async ({ input, client, confirmation }) =>
    payroll.recordPayout(client, input, undefined, confirmation),
});
