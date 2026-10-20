/**
 * Opt-in live suite for payroll_record_payout, through the real `tools/call`
 * path of a host without elicitation (the confirmation-token path): record a
 * payout of 1 in the location currency, see it counted as paid in the team
 * member's settlements, repeat the confirmed call and see it refused, then
 * delete the transaction and see the settlements come back.
 *
 * Skipped unless `ALTEGIO_E2E=1`. Credentials and fixture ids come from the
 * environment, never a file in this public repo:
 *
 * - `ALTEGIO_E2E_LOCATION_ID` — a disposable test location with exactly one
 *   personnel payment item;
 * - `ALTEGIO_E2E_TEAM_MEMBER_ID` — a team member of that location;
 * - `ALTEGIO_E2E_ACCOUNT_ID` — a cash register or account the user may
 *   record expenses in.
 *
 *   ALTEGIO_E2E=1 CREDENTIALS_DIR=/tmp/altegio-mcp-live \
 *     ALTEGIO_API_TOKEN=… ALTEGIO_USER_TOKEN=… ALTEGIO_E2E_LOCATION_ID=… \
 *     ALTEGIO_E2E_TEAM_MEMBER_ID=… ALTEGIO_E2E_ACCOUNT_ID=… \
 *     npx jest payout-live
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AltegioClient } from '../../../providers/altegio-client.js';
import { registerTools } from '../../../tools/registry.js';
import { CONFIRMATION_TOKEN_ARG } from '../../../tools/confirmation.js';

const LIVE = process.env.ALTEGIO_E2E === '1';
const CREDENTIALS_DIR = process.env.CREDENTIALS_DIR ?? '/tmp/altegio-mcp-live';
const env = (name: string) => Number(process.env[name]);

const describeLive = LIVE ? describe : describe.skip;

function textOf(result: CallToolResult): string {
  const block = result.content[0];
  return block && block.type === 'text' ? block.text : '';
}

interface Settlements {
  accrued_amount: number | null;
  paid_amount: number | null;
  balance: number | null;
}

describeLive('payroll payouts against the test location', () => {
  const location = env('ALTEGIO_E2E_LOCATION_ID');
  const teamMember = env('ALTEGIO_E2E_TEAM_MEMBER_ID');
  const account = env('ALTEGIO_E2E_ACCOUNT_ID');
  let host: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const partnerToken =
      process.env.ALTEGIO_API_TOKEN ??
      process.env.ALTEGIO_PARTNER_TOKEN ??
      process.env.ALTEGIO_LIVE_API_TOKEN;
    const userToken = process.env.ALTEGIO_USER_TOKEN;
    if (
      !partnerToken ||
      !userToken ||
      [location, teamMember, account].some((v) => !(v > 0))
    ) {
      throw new Error(
        'The live suite needs ALTEGIO_API_TOKEN, ALTEGIO_USER_TOKEN and every ALTEGIO_E2E_* id named in the header.'
      );
    }
    const altegio = new AltegioClient(
      { partnerToken, userToken },
      CREDENTIALS_DIR
    );
    const server = new Server(
      { name: 'payout-live', version: '0.0.0' },
      { capabilities: { tools: {} } }
    );
    registerTools(server, altegio);
    // No elicitation: every write goes through the confirmation token.
    host = new Client({ name: 'token-host', version: '0.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([host.connect(a), server.connect(b)]);
    close = async () => {
      await host.close();
      await server.close();
    };
  });

  afterAll(async () => close?.());

  const call = async (name: string, args: Record<string, unknown>) =>
    (await host.callTool({ name, arguments: args })) as CallToolResult;

  /** Ask, take the token, and repeat with it: what a host without forms does. */
  async function confirmed(name: string, args: Record<string, unknown>) {
    const asked = await call(name, args);
    expect(asked.structuredContent).toMatchObject({
      status: 'confirmation_required',
    });
    const token = (asked.structuredContent as Record<string, string>)[
      CONFIRMATION_TOKEN_ARG
    ]!;
    return {
      asked,
      run: () => call(name, { ...args, [CONFIRMATION_TOKEN_ARG]: token }),
    };
  }

  it('counts a payout in the settlements, refuses a repeat, and the delete restores them', async () => {
    const payout = {
      location_id: location,
      team_member_id: teamMember,
      amount: 1,
      account_id: account,
      comment: `payout-live ${Date.now()}: deleted by the suite`,
    };
    const { asked, run } = await confirmed('payroll_record_payout', payout);
    expect(textOf(asked)).toContain('under personnel payment item');

    const recorded = await run();
    expect(recorded.isError).toBeFalsy();
    const result = recorded.structuredContent as {
      transaction: { id: number; amount: number; team_member_id: number };
      settlements_period: { date_from: string; date_to: string } | null;
      settlements: Settlements | null;
    };
    const transaction = result.transaction.id;
    expect(transaction).toBeGreaterThan(0);

    try {
      expect(result.transaction).toMatchObject({
        amount: -1,
        team_member_id: teamMember,
      });
      expect(result.settlements_period).not.toBeNull();
      expect(result.settlements?.paid_amount).toBeGreaterThanOrEqual(1);

      // The same token, the same arguments: the replay guard finds it.
      const repeated = await run();
      expect(repeated.isError).toBe(true);
      expect(textOf(repeated)).toContain(
        `financial transaction ${transaction} with the same`
      );
    } finally {
      const removal = await confirmed('financial_transactions_delete', {
        location_id: location,
        transaction_id: transaction,
      });
      const deleted = await removal.run();
      expect(deleted.isError).toBeFalsy();
    }

    // Without the payout, the same period reads 1 less paid.
    const after = await call('payroll_get_calculation', {
      location_id: location,
      team_member_id: teamMember,
      ...result.settlements_period!,
    });
    const settlements = (
      after.structuredContent as { settlements: Settlements }
    ).settlements;
    expect(settlements.paid_amount).toBeCloseTo(
      result.settlements!.paid_amount! - 1,
      2
    );
    expect(settlements.balance).toBeCloseTo(
      result.settlements!.balance! + 1,
      2
    );
  }, 120_000);
});
