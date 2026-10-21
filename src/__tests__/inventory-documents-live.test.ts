/**
 * Opt-in live suite for changing an inventory document and paying a product
 * receipt, through the real `tools/call` path of a host without elicitation:
 * a receipt is recorded, its line changed, a line added and removed again,
 * its date and comment changed, then paid; a second payment is refused, the
 * payment is deleted and the document with it, and the stock is back where
 * it was.
 *
 * Skipped unless `ALTEGIO_E2E=1`. Credentials and fixture ids come from the
 * environment, never a file in this public repo:
 *
 * - `ALTEGIO_E2E_LOCATION_ID` — a disposable test location;
 * - `ALTEGIO_E2E_PRODUCT_ID` — a cheap plain product;
 * - `ALTEGIO_E2E_INVENTORY_ID` — a sale inventory that holds it;
 * - `ALTEGIO_E2E_OPERATION_TEAM_MEMBER_ID` — a team member who may record
 *   inventory operations there;
 * - `ALTEGIO_E2E_ACCOUNT_ID` — a cash register or account to pay from.
 *
 *   ALTEGIO_E2E=1 CREDENTIALS_DIR=/tmp/altegio-mcp-live \
 *     ALTEGIO_API_TOKEN=… ALTEGIO_USER_TOKEN=… ALTEGIO_E2E_LOCATION_ID=… … \
 *     npx jest inventory-documents-live
 */
import type { AltegioClient } from '../providers/altegio-client.js';
import { httpFromClient } from '../api/altegio-http.js';
import {
  describeLive,
  isoDay,
  liveClient,
  liveHost,
  liveIds,
  textOf,
  type LiveHost,
} from './helpers/live.js';

interface Movement {
  id: number;
  document_id: number | null;
  date: string | null;
  product_id: number | null;
  quantity: number | null;
  unit_price: number | null;
  total: number | null;
  comment: string | null;
}

describeLive('inventory document changes against the test location', () => {
  let ids: Record<
    | 'LOCATION_ID'
    | 'PRODUCT_ID'
    | 'INVENTORY_ID'
    | 'OPERATION_TEAM_MEMBER_ID'
    | 'ACCOUNT_ID',
    number
  >;
  let altegio: AltegioClient;
  let host: LiveHost;
  const made = { document: 0, payment: 0 };

  beforeAll(async () => {
    ids = liveIds([
      'LOCATION_ID',
      'PRODUCT_ID',
      'INVENTORY_ID',
      'OPERATION_TEAM_MEMBER_ID',
      'ACCOUNT_ID',
    ]);
    altegio = liveClient();
    host = await liveHost(altegio, 'inventory-documents-live');
  });

  // Whatever a failed run left behind goes, straight through the API.
  afterAll(async () => {
    const http = httpFromClient(altegio);
    if (made.payment) {
      await http
        .request(`/finance_transactions/${ids.LOCATION_ID}/${made.payment}`, {
          method: 'DELETE',
        })
        .catch(() => undefined);
    }
    if (made.document) {
      await http
        .request(
          `/storage_operations/documents/${ids.LOCATION_ID}/${made.document}`,
          { method: 'DELETE' }
        )
        .catch(() => undefined);
    }
    await host?.close();
  });

  const at = () => ({ location_id: ids.LOCATION_ID });

  const confirmedRun = async (tool: string, args: Record<string, unknown>) => {
    const asked = await host.confirmed(tool, args);
    const result = await asked.run();
    if (result.isError) {
      throw new Error(`${tool} failed: ${textOf(result).slice(0, 400)}`);
    }
    return { result, asked };
  };

  const stock = async () => {
    const found = await host.read<{
      items: Array<{
        stock: Array<{
          inventory_id: number;
          sale_quantity: number | null;
        }> | null;
      }>;
    }>('products_search', { ...at(), product_ids: [ids.PRODUCT_ID] });
    return (
      found.items[0]?.stock?.find((s) => s.inventory_id === ids.INVENTORY_ID)
        ?.sale_quantity ?? 0
    );
  };

  const linesOf = async (document: number) =>
    (
      await host.read<{ items: Movement[] }>('inventory_list_operations', {
        ...at(),
        document_id: document,
      })
    ).items.sort((a, b) => a.id - b.id);

  it('changes, pays and deletes a product receipt; the stock comes back', async () => {
    const before = await stock();
    const stamp = Date.now();

    // --- a receipt of 2 at 10 ---
    const receipt = await confirmedRun('inventory_create_operation', {
      ...at(),
      kind: 'receipt',
      team_member_id: ids.OPERATION_TEAM_MEMBER_ID,
      inventory_id: ids.INVENTORY_ID,
      lines: [{ product_id: ids.PRODUCT_ID, quantity: 2, unit_price: 10 }],
      comment: `documents-live ${stamp}: deleted by the suite`,
    });
    made.document = (
      receipt.result.structuredContent as { document: { id: number } }
    ).document.id;
    const [first] = await linesOf(made.document);
    expect(first).toMatchObject({ quantity: 2, unit_price: 10, total: 20 });
    expect(await stock()).toBeCloseTo(before + 2, 6);

    // --- the line to 3, a second line of 1, a new date and comment ---
    const date = `${isoDay(-1)}T09:30`;
    await confirmedRun('inventory_update_document', {
      ...at(),
      document_id: made.document,
      date,
      comment: `documents-live ${stamp}: corrected`,
      lines: [{ line_id: first!.id, quantity: 3 }],
      add_lines: [{ product_id: ids.PRODUCT_ID, quantity: 1, unit_price: 10 }],
    });
    const changed = await linesOf(made.document);
    expect(changed.map((l) => [l.quantity, l.total])).toEqual([
      [3, 30],
      [1, 10],
    ]);
    // Every line moved to the new date.
    for (const line of changed) {
      expect(line.date?.slice(0, 16)).toBe(date);
    }
    expect(await stock()).toBeCloseTo(before + 4, 6);

    // --- the added line removed again ---
    await confirmedRun('inventory_update_document', {
      ...at(),
      document_id: made.document,
      lines: [{ line_id: changed[1]!.id, remove: true }],
    });
    expect((await linesOf(made.document)).map((l) => l.quantity)).toEqual([3]);
    expect(await stock()).toBeCloseTo(before + 3, 6);

    // --- paid in full; the same confirmed call again pays nothing ---
    const pay = await confirmedRun('inventory_pay_document', {
      ...at(),
      document_id: made.document,
      account_id: ids.ACCOUNT_ID,
    });
    made.payment = (
      pay.result.structuredContent as { transaction: { id: number } }
    ).transaction.id;
    expect(textOf(pay.result)).toContain('Amount due now 0');
    const repeat = await pay.asked.run();
    expect(repeat.isError).toBe(true);
    expect(textOf(repeat)).toMatch(/Nothing was paid/);
    const again = await host.call('inventory_pay_document', {
      ...at(),
      document_id: made.document,
      account_id: ids.ACCOUNT_ID,
    });
    expect(textOf(again)).toMatch(/paid in full/);

    // --- the payment deleted, then the document; the stock is back ---
    const removal = await confirmedRun('financial_transactions_delete', {
      ...at(),
      transaction_id: made.payment,
    });
    expect(removal.result.structuredContent).toMatchObject({ deleted: true });
    made.payment = 0;
    await confirmedRun('inventory_delete_document', {
      ...at(),
      document_id: made.document,
    });
    made.document = 0;
    expect(await stock()).toBeCloseTo(before, 6);
  }, 180_000);
});
