import { VisitsAdapter } from '../visits-adapter.js';
import type { VisitPaymentsApi, VisitProductLinesApi } from '../visits-api.js';

/** A backend whose every method answers with its own name. */
function backend<T extends object>(methods: readonly (keyof T)[]): T {
  return Object.fromEntries(
    methods.map((m) => [m, jest.fn(async () => `${String(m)} answered`)])
  ) as T;
}

describe('VisitsAdapter', () => {
  const payments = backend<VisitPaymentsApi>([
    'getVisit',
    'addPayment',
    'cancelPayment',
  ]);
  const productLines = backend<VisitProductLinesApi>([
    'getAppointmentSale',
    'getProductForSale',
    'addProductLine',
    'reduceProductLine',
  ]);
  const visits = new VisitsAdapter(payments, productLines);

  it.each([
    ['getVisit', payments],
    ['addPayment', payments],
    ['cancelPayment', payments],
    ['getAppointmentSale', productLines],
    ['getProductForSale', productLines],
    ['addProductLine', productLines],
    ['reduceProductLine', productLines],
  ] as const)(
    'runs %s on the backend that serves it',
    async (method, owner) => {
      const args = [4564, 1, { idempotency_key: 'k' }];
      const run = visits[method] as (...a: unknown[]) => Promise<unknown>;
      await expect(run(...args)).resolves.toBe(`${method} answered`);
      expect(
        (owner as unknown as Record<string, jest.Mock>)[method]
      ).toHaveBeenCalledWith(...args);
    }
  );
});
