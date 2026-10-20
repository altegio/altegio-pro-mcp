/**
 * Opt-in live suite for the finance tools, through the real `tools/call` path
 * of a host without elicitation: the reads (accounts and cash registers,
 * payment items, Suppliers and Partners); a financial transaction recorded,
 * changed and deleted, with its repeat and a stale change refused; and a
 * payment recorded on a fresh appointment, its repeat refused, then cancelled.
 *
 * Skipped unless `ALTEGIO_E2E=1`. Credentials and fixture ids come from the
 * environment, never a file in this public repo:
 *
 * - `ALTEGIO_E2E_LOCATION_ID` — a disposable test location;
 * - `ALTEGIO_E2E_ACCOUNT_ID` — a cash register there that is only for tests;
 * - `ALTEGIO_E2E_CLIENT_ID` — a client with no reachable phone or email, since
 *   an arrived appointment can message the client;
 * - `ALTEGIO_E2E_TEAM_MEMBER_ID`, `ALTEGIO_E2E_SERVICE_ID` — a team member who
 *   provides a service with a price.
 *
 * Everything the suite records it deletes: the transaction, the payments and
 * the appointments. A client account deposit is not tested: there is no
 * route that takes one back.
 *
 *   ALTEGIO_E2E=1 CREDENTIALS_DIR=/tmp/altegio-mcp-live \
 *     ALTEGIO_API_TOKEN=… ALTEGIO_USER_TOKEN=… ALTEGIO_E2E_LOCATION_ID=… … \
 *     npx jest finance-live
 */
import type { AltegioClient } from '../providers/altegio-client.js';
import {
  createAppointment,
  describeLive,
  isDeleted,
  isoDay,
  liveClient,
  liveHost,
  liveIds,
  textOf,
  type LiveHost,
} from './helpers/live.js';

interface Page<T> {
  items: T[];
  pagination: { page: number; has_more: boolean };
}
interface Transaction {
  id: number;
  amount: number;
  direction: 'income' | 'expense';
  date: string | null;
  payment_item_id: number | null;
  account_id: number | null;
  supplier_id: number | null;
  comment: string | null;
}
interface Visit {
  amount_due: number;
  payments: Array<{ id: string; amount: number; method: string }>;
  payment_options: Array<{
    method: string;
    applicable: boolean;
    account_id: number | null;
  }>;
  added_payment_ids?: string[];
  cancelled_payment_id?: string | null;
}

describeLive('finance tools against the test location', () => {
  let ids: Record<
    | 'LOCATION_ID'
    | 'ACCOUNT_ID'
    | 'CLIENT_ID'
    | 'TEAM_MEMBER_ID'
    | 'SERVICE_ID',
    number
  >;
  let altegio: AltegioClient;
  let host: LiveHost;

  beforeAll(async () => {
    ids = liveIds([
      'LOCATION_ID',
      'ACCOUNT_ID',
      'CLIENT_ID',
      'TEAM_MEMBER_ID',
      'SERVICE_ID',
    ]);
    altegio = liveClient();
    host = await liveHost(altegio, 'finance-live');
  });

  afterAll(async () => host?.close());

  const at = () => ({ location_id: ids.LOCATION_ID });
  const fixture = () => ({
    location: ids.LOCATION_ID,
    team_member: ids.TEAM_MEMBER_ID,
    service: ids.SERVICE_ID,
    client: ids.CLIENT_ID,
  });

  it('lists accounts and cash registers, payment items and Suppliers and Partners', async () => {
    const accounts = await host.read<
      Page<{ id: number; settlement: string; acquiring: boolean }>
    >('accounts_and_cash_registers_list', { ...at(), page_size: 100 });
    const account = accounts.items.find((a) => a.id === ids.ACCOUNT_ID);
    expect(account).toBeDefined();
    expect(['cash', 'non_cash']).toContain(account!.settlement);

    const all = await host.read<
      Page<{ id: number; direction: string; category: string }>
    >('financial_transactions_list_payment_items', { ...at(), page_size: 100 });
    expect(new Set(all.items.map((i) => i.direction))).toEqual(
      new Set(['income', 'expense'])
    );
    expect(all.items.every((i) => i.category !== 'unknown')).toBe(true);
    const expenses = await host.read<Page<{ direction: string }>>(
      'financial_transactions_list_payment_items',
      { ...at(), direction: 'expense', page_size: 100 }
    );
    expect(expenses.items.length).toBeGreaterThan(0);
    expect(expenses.items.every((i) => i.direction === 'expense')).toBe(true);

    const suppliers = await host.read<
      Page<{ id: number; title: string | null; type: string }>
    >('suppliers_and_partners_list', { ...at(), page_size: 5 });
    expect(suppliers.items.length).toBeGreaterThan(0);
    const first = suppliers.items[0]!;
    expect(first.type).not.toBe('unknown');
    const named = await host.read<Page<{ id: number }>>(
      'suppliers_and_partners_list',
      { ...at(), query: first.title!.slice(0, 6) }
    );
    expect(named.items.map((s) => s.id)).toContain(first.id);
  }, 60_000);

  it('records, changes and deletes a financial transaction, refusing a repeat and a stale change', async () => {
    const itemOf = async (direction: 'income' | 'expense') =>
      (
        await host.read<Page<{ id: number }>>(
          'financial_transactions_list_payment_items',
          { ...at(), direction, page_size: 100 }
        )
      ).items[0]!.id;
    const expense = await itemOf('expense');
    const income = await itemOf('income');
    const supplier = (
      await host.read<Page<{ id: number }>>('suppliers_and_partners_list', {
        ...at(),
        page_size: 1,
      })
    ).items[0]!.id;

    // A past day, so nothing else lands in the account that day by chance.
    const day = isoDay(-5);
    const onDay = async () =>
      (
        await host.read<Page<Transaction>>('financial_transactions_list', {
          ...at(),
          date_from: day,
          date_to: day,
          account_id: ids.ACCOUNT_ID,
          page_size: 100,
        })
      ).items;
    const before = (await onDay()).map((t) => t.id);
    const comment = `finance-live ${Date.now()}: deleted by the suite`;

    const create = await host.confirmed('financial_transactions_create', {
      ...at(),
      payment_item_id: expense,
      account_id: ids.ACCOUNT_ID,
      amount: 1.5,
      date: `${day}T10:15`,
      comment,
    });
    expect(textOf(create.asked)).toContain(`dated ${day}T10:15`);
    const created = await create.run();
    expect(created.isError).toBeFalsy();
    const recorded = created.structuredContent as unknown as Transaction;
    const transaction = recorded.id;
    expect(recorded).toMatchObject({
      amount: -1.5,
      direction: 'expense',
      payment_item_id: expense,
      account_id: ids.ACCOUNT_ID,
      comment,
    });
    // The location's wall time reads back as given, whatever the server's.
    expect(recorded.date).toMatch(new RegExp(`^${day}T10:15`));

    try {
      expect((await onDay()).map((t) => t.id)).toContain(transaction);

      // The same token, the same arguments: refused, nothing recorded twice.
      const repeated = await create.run();
      expect(repeated.isError).toBe(true);
      expect(textOf(repeated)).toContain(
        `financial transaction ${transaction}`
      );
      expect((await onDay()).filter((t) => t.comment === comment)).toHaveLength(
        1
      );

      const change = await host.confirmed('financial_transactions_update', {
        ...at(),
        transaction_id: transaction,
        payment_item_id: income,
        amount: 2.25,
        supplier_id: supplier,
        comment: `${comment} (changed)`,
      });
      expect(textOf(change.asked)).toContain('amount 1.5');
      const changed = await change.run();
      expect(changed.isError).toBeFalsy();
      expect(changed.structuredContent).toMatchObject({
        id: transaction,
        amount: 2.25,
        direction: 'income',
        payment_item_id: income,
        supplier_id: supplier,
        previous: { amount: -1.5, direction: 'expense' },
      });
      // An update stores another clock than a create; the date must not move.
      expect((changed.structuredContent as unknown as Transaction).date).toBe(
        recorded.date
      );

      // The person is shown 2.25 → 3 …
      const stale = await host.confirmed('financial_transactions_update', {
        ...at(),
        transaction_id: transaction,
        amount: 3,
      });
      // … someone else changes the transaction before the confirmed call …
      const other = await host.confirmed('financial_transactions_update', {
        ...at(),
        transaction_id: transaction,
        comment: `${comment} (changed again)`,
      });
      expect((await other.run()).isError).toBeFalsy();
      // … so the confirmed call no longer makes the change approved.
      const refused = await stale.run();
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain(
        'changed after the confirmation was shown'
      );
      expect(
        (await onDay()).find((t) => t.id === transaction)?.amount
      ).toBeCloseTo(2.25, 2);
    } finally {
      const removal = await host.confirmed('financial_transactions_delete', {
        ...at(),
        transaction_id: transaction,
      });
      const deleted = await removal.run();
      expect(deleted.structuredContent).toMatchObject({ deleted: true });
      // The same token again finds nothing to delete.
      const again = await removal.run();
      expect(again.isError).toBe(true);
      expect(textOf(again)).toContain('Not found');
    }
    expect((await onDay()).map((t) => t.id)).toEqual(before);
  }, 120_000);

  /** Payments recorded since `before`, cancelled; then the appointment goes. */
  async function cleanUp(appointment: number, before: Set<string>) {
    const visit = await host.read<Visit>('visits_get', {
      ...at(),
      appointment_id: appointment,
    });
    for (const payment of visit.payments.filter((p) => !before.has(p.id))) {
      const cancel = await host.confirmed('visits_cancel_payment', {
        ...at(),
        appointment_id: appointment,
        payment_id: payment.id,
      });
      await cancel.run();
    }
    await altegio.deleteBooking(ids.LOCATION_ID, appointment);
  }

  it('records a payment on an arrived appointment, refuses its repeat and cancels it', async () => {
    // Payments stay only on an arrived visit (see the waiting case below).
    const appointment = await createAppointment(altegio, fixture(), {
      day: isoDay(-8),
      time: '11:00',
      comment: 'finance-live: deleted by the suite',
      attendance: 1,
    });
    const visitNow = () =>
      host.read<Visit>('visits_get', { ...at(), appointment_id: appointment });
    let before = new Set<string>();

    try {
      const start = await visitNow();
      before = new Set(start.payments.map((p) => p.id));
      expect(start.amount_due).toBeGreaterThanOrEqual(1);
      expect(
        start.payment_options.some(
          (o) =>
            o.method === 'account' &&
            o.applicable &&
            o.account_id === ids.ACCOUNT_ID
        )
      ).toBe(true);

      const pay = await host.confirmed('visits_add_payment', {
        ...at(),
        appointment_id: appointment,
        method: 'account',
        account_id: ids.ACCOUNT_ID,
        amount: 1,
        expected_amount_due: start.amount_due,
      });
      const paid = await pay.run();
      expect(paid.isError).toBeFalsy();
      const added = (paid.structuredContent as unknown as Visit)
        .added_payment_ids!;
      expect(added).toHaveLength(1);

      // A fresh read, not the answer to the write, must show the payment.
      const after = await visitNow();
      expect(after.payments.map((p) => p.id)).toContain(added[0]);
      expect(after.amount_due).toBeCloseTo(start.amount_due - 1, 2);

      // The same token again: the amount due moved, so nothing is recorded.
      const repeated = await pay.run();
      expect(repeated.isError).toBe(true);
      expect(textOf(repeated)).toContain('Nothing was recorded');
      expect((await visitNow()).payments).toHaveLength(after.payments.length);

      const cancel = await host.confirmed('visits_cancel_payment', {
        ...at(),
        appointment_id: appointment,
        payment_id: added[0],
      });
      const cancelled = await cancel.run();
      expect(cancelled.isError).toBeFalsy();
      expect(cancelled.structuredContent).toMatchObject({
        cancelled_payment_id: added[0],
      });
      const end = await visitNow();
      expect(new Set(end.payments.map((p) => p.id))).toEqual(before);
      expect(end.amount_due).toBeCloseTo(start.amount_due, 2);
    } finally {
      await cleanUp(appointment, before);
    }
    expect(await isDeleted(altegio, ids.LOCATION_ID, appointment)).toBe(true);
  }, 120_000);

  // On a waiting appointment Altegio answers a payment as recorded and then
  // does not keep it, so the tool refuses before anyone is asked.
  it('refuses a payment on a waiting appointment before anything is asked', async () => {
    const appointment = await createAppointment(altegio, fixture(), {
      day: isoDay(-9),
      time: '12:00',
      comment: 'finance-live: deleted by the suite',
    });
    try {
      const start = await host.read<Visit>('visits_get', {
        ...at(),
        appointment_id: appointment,
      });
      const asked = await host.call('visits_add_payment', {
        ...at(),
        appointment_id: appointment,
        method: 'account',
        account_id: ids.ACCOUNT_ID,
        amount: 1,
        expected_amount_due: start.amount_due,
      });
      expect(asked.isError).toBe(true);
      expect(textOf(asked)).toContain(
        `appointment ${appointment} is still waiting for the client`
      );
      const after = await host.read<Visit>('visits_get', {
        ...at(),
        appointment_id: appointment,
      });
      expect(after.payments).toEqual(start.payments);
      expect(after.amount_due).toBe(start.amount_due);
    } finally {
      await cleanUp(appointment, new Set());
    }
    expect(await isDeleted(altegio, ids.LOCATION_ID, appointment)).toBe(true);
  }, 120_000);

  // A payment on a confirmed appointment whose time has passed is kept, and
  // Altegio marks the appointment arrived; the confirmation says so.
  it('says a payment marks a past confirmed appointment arrived, and records it', async () => {
    const appointment = await createAppointment(altegio, fixture(), {
      day: isoDay(-10),
      time: '13:00',
      comment: 'finance-live: deleted by the suite',
      attendance: 2,
    });
    let before = new Set<string>();
    try {
      const start = await host.read<Visit>('visits_get', {
        ...at(),
        appointment_id: appointment,
      });
      before = new Set(start.payments.map((p) => p.id));
      const pay = await host.confirmed('visits_add_payment', {
        ...at(),
        appointment_id: appointment,
        method: 'account',
        account_id: ids.ACCOUNT_ID,
        amount: 1,
        expected_amount_due: start.amount_due,
      });
      expect(JSON.stringify(pay.asked.content)).toContain(
        'Altegio marks it arrived when the payment is recorded'
      );
      const paid = await pay.run();
      expect(paid.isError).toBeFalsy();
      expect(textOf(paid)).toContain(
        `Altegio marked appointment ${appointment} arrived with the payment.`
      );
      const added = (paid.structuredContent as unknown as Visit)
        .added_payment_ids!;
      expect(added).toHaveLength(1);
      const after = await host.read<Visit>('visits_get', {
        ...at(),
        appointment_id: appointment,
      });
      expect(after.payments.map((p) => p.id)).toContain(added[0]);
    } finally {
      await cleanUp(appointment, before);
    }
    expect(await isDeleted(altegio, ids.LOCATION_ID, appointment)).toBe(true);
  }, 120_000);
});
