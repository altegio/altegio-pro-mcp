/**
 * Opt-in live suite for visits_add_product and visits_remove_product: create
 * a waiting appointment, sell a product on it (marking it arrived), lower the
 * line, take it off, and check the stock and the bill come back — then delete
 * the appointment.
 *
 * Skipped unless `ALTEGIO_E2E=1`. Credentials come from the environment, as in
 * `src/__tests__/appointments-e2e-live.test.ts`; the fixture ids too, never a
 * file in this public repo:
 *
 * - `ALTEGIO_E2E_LOCATION_ID` — a disposable test location;
 * - `ALTEGIO_E2E_CLIENT_ID` — a client with no reachable phone or email, since
 *   an arrived appointment can message the client;
 * - `ALTEGIO_E2E_TEAM_MEMBER_ID`, `ALTEGIO_E2E_SERVICE_ID` — a team member who
 *   provides the service;
 * - `ALTEGIO_E2E_PRODUCT_ID`, `ALTEGIO_E2E_INVENTORY_ID` — a cheap plain
 *   product and an inventory that holds it (a large sale can raise the
 *   client's spend-based discount, which taking it off does not lower).
 *
 *   ALTEGIO_E2E=1 CREDENTIALS_DIR=/tmp/altegio-mcp-live \
 *     ALTEGIO_API_TOKEN=… ALTEGIO_USER_TOKEN=… ALTEGIO_E2E_LOCATION_ID=… \
 *     ALTEGIO_E2E_CLIENT_ID=… ALTEGIO_E2E_TEAM_MEMBER_ID=… \
 *     ALTEGIO_E2E_SERVICE_ID=… ALTEGIO_E2E_PRODUCT_ID=… \
 *     ALTEGIO_E2E_INVENTORY_ID=… npx jest visit-products-live
 */
import { AltegioClient } from '../../../providers/altegio-client.js';
import { httpFromClient } from '../../../api/altegio-http.js';
import { FinanceAdapter } from '../../../api/v1/finance-adapter.js';
import { VisitProductsV2Adapter } from '../../../api/v2/visit-products-adapter.js';
import {
  addProduct,
  describeRemoval,
  removeProduct,
} from '../visit-products.js';
import { FinanceInputError } from '../errors.js';

const LIVE = process.env.ALTEGIO_E2E === '1';
const CREDENTIALS_DIR = process.env.CREDENTIALS_DIR ?? '/tmp/altegio-mcp-live';
const env = (name: string) => Number(process.env[name]);

const describeLive = LIVE ? describe : describe.skip;

describeLive('visit products end-to-end against the test location', () => {
  const location = env('ALTEGIO_E2E_LOCATION_ID');
  const clientId = env('ALTEGIO_E2E_CLIENT_ID');
  const teamMember = env('ALTEGIO_E2E_TEAM_MEMBER_ID');
  const service = env('ALTEGIO_E2E_SERVICE_ID');
  const product = env('ALTEGIO_E2E_PRODUCT_ID');
  const inventory = env('ALTEGIO_E2E_INVENTORY_ID');
  let client: AltegioClient;

  beforeAll(() => {
    const partnerToken =
      process.env.ALTEGIO_API_TOKEN ??
      process.env.ALTEGIO_PARTNER_TOKEN ??
      process.env.ALTEGIO_LIVE_API_TOKEN;
    const userToken = process.env.ALTEGIO_USER_TOKEN;
    const ids = [location, clientId, teamMember, service, product, inventory];
    if (!partnerToken || !userToken || ids.some((v) => !(v > 0))) {
      throw new Error(
        'The live suite needs ALTEGIO_API_TOKEN, ALTEGIO_USER_TOKEN and every ALTEGIO_E2E_* id named in the header.'
      );
    }
    client = new AltegioClient({ partnerToken, userToken }, CREDENTIALS_DIR);
  });

  it('sells a product, lowers the line, takes it off, and the stock comes back', async () => {
    const http = httpFromClient(client);
    const api = VisitProductsV2Adapter.forClient(client);
    const stockNow = async () =>
      (await api.getProductForSale(location, product)).stock.find(
        (s) => s.inventory_id === inventory
      )?.sale_quantity ?? null;

    const day = new Date(Date.now() - 3 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const created = await http.request(`/locations/${location}/appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        staff_id: teamMember,
        services: [{ id: service }],
        client: { id: clientId },
        datetime: `${day}T07:00:00`,
        seance_length: 3600,
        send_sms: 0,
        sms_remain_hours: 0,
        email_remain_hours: 0,
        attendance: 0,
        save_if_busy: true,
        comment: 'visit-products-live: deleted by the suite',
      }),
    });
    const createdBody = (await created.json()) as { data?: { id?: number } };
    const appointment = createdBody.data?.id;
    expect(created.status).toBeLessThan(300);
    expect(appointment).toBeGreaterThan(0);

    try {
      const stockBefore = await stockNow();
      const discountBefore = (
        await api.getAppointmentSale(location, appointment!)
      ).client_discount_percent;

      const sold = await addProduct(client, {
        location_id: location,
        appointment_id: appointment!,
        product_id: product,
        quantity: 2,
        expected_current_quantity: 0,
        inventory_id: inventory,
        discount_percent: 0,
        mark_arrived: true,
      });
      expect(sold.isError).toBeUndefined();
      const line = (
        sold.structuredContent as { line: { id: number; quantity: number } }
      ).line;
      expect(line.quantity).toBe(2);
      if (stockBefore !== null) expect(await stockNow()).toBe(stockBefore - 2);

      // The id visits_get shows for the bill line is the product line's id.
      const bill = await FinanceAdapter.forClient(client).getVisitBill(
        location,
        appointment!
      );
      expect(
        bill.lines.filter((l) => l.kind === 'product').map((l) => l.id)
      ).toEqual([line.id]);

      const lower = {
        location_id: location,
        appointment_id: appointment!,
        line_id: line.id,
        quantity: 1,
        expected_current_quantity: 2,
      };
      expect(await describeRemoval(client, lower)).toContain(
        `Lowers line ${line.id} of product ${product} from 2 to 1`
      );
      const lowered = await removeProduct(client, lower);
      expect(lowered.isError).toBeUndefined();
      expect(lowered.structuredContent).toMatchObject({
        removed_line: false,
        line: { id: line.id, quantity: 1 },
        unexpected_changes: [],
      });
      if (stockBefore !== null) expect(await stockNow()).toBe(stockBefore - 1);

      // A repeated confirmed call is refused by the expected quantity.
      await expect(removeProduct(client, lower)).rejects.toBeInstanceOf(
        FinanceInputError
      );

      const removed = await removeProduct(client, {
        location_id: location,
        appointment_id: appointment!,
        line_id: line.id,
        expected_current_quantity: 1,
      });
      expect(removed.isError).toBeUndefined();
      expect(removed.structuredContent).toMatchObject({
        removed_line: true,
        line: null,
        product_lines: [],
        unexpected_changes: [],
        stock: { before: stockBefore === null ? null : stockBefore - 1 },
      });
      expect(await stockNow()).toBe(stockBefore);
      const after = await api.getAppointmentSale(location, appointment!);
      expect(after.product_lines).toEqual([]);
      expect(after.attendance).toBe('arrived');
      expect(after.client_discount_percent).toBe(discountBefore);
    } finally {
      await client.deleteBooking(location, appointment!);
    }
  }, 120_000);
});
