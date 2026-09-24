import { describe, expect, it, jest, afterEach } from '@jest/globals';
import type { AltegioClient } from '../../../providers/altegio-client.js';
import { V1LegacyAnalyticsAdapter } from '../../../api/v1/legacy-analytics-adapter.js';
import { getClientPayerCohorts } from '../payer-cohorts.js';
import { AltegioApiError } from '../../../utils/errors.js';

const input = {
  location_id: 4564,
  date_from: '2026-08-01',
  date_to: '2026-08-31',
  page_size: 2,
};

function fakeClient(amounts: number[], clientIds?: number[]): AltegioClient {
  return {
    request: jest.fn(async (_method: string, path: string) => {
      if (path.includes('/user/permissions/')) {
        return {
          data: {
            finances: {
              finances_year_report_access: true,
              finances_transactions_access: true,
              finances_access: true,
              finances_last_days_count: -1,
              finances_accounts_limited_access: false,
            },
          },
        };
      }
      const id = Number(path.split('/').at(-1));
      return {
        data: {
          id,
          type_id: 5,
          account_id: 10,
          client_id: clientIds?.[id - 1] ?? id,
          amount: amounts[id - 1],
          date: '2026-08-31 19:30:00',
        },
      };
    }),
  } as unknown as AltegioClient;
}

afterEach(() => {
  jest.restoreAllMocks();
});

function source(amount: number) {
  jest
    .spyOn(V1LegacyAnalyticsAdapter.prototype, 'getPostedIncomeMonths')
    .mockResolvedValue({
      currency: 'CZK',
      timezone: 'Europe/Prague',
      months: [
        {
          month: '2026-08',
          income_total: amount,
          categories: [{ category_id: 5, amount }],
        },
      ],
    });
}

function pages(count: number, changeSecondPass = false) {
  let reads = 0;
  jest
    .spyOn(V1LegacyAnalyticsAdapter.prototype, 'getFinanceTransactionIdsPage')
    .mockImplementation(async (request) => {
      if (request.type_id !== 5) return { rows: [], count: 0 };
      reads += 1;
      const ids = Array.from({ length: count }, (_, i) => i + 1);
      if (changeSecondPass && reads === 2) ids[0] = 999;
      return {
        count,
        rows: ids.map((id) => ({ id, local_date: '2026-08-31' })),
      };
    });
}

describe('cash-basis payer cohorts', () => {
  it('ranks positive-net clients, pages IDs, and keeps unattributed cash separate', async () => {
    const amounts = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, -5, 25];
    const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0];
    source(570);
    pages(amounts.length);
    const result = await getClientPayerCohorts(fakeClient(amounts, ids), input);
    const output = result.structuredContent;
    expect(output.payer_count).toBe(10);
    expect(output.clients_with_zero_or_negative_net).toBe(1);
    expect(output.unattributed_cash_net).toBe(25);
    expect(output.cohorts.map((row) => row.payer_count)).toEqual([1, 1, 8]);
    expect(output.target_client_ids).toEqual([1]);
    expect(output.cohorts.reduce((sum, row) => sum + row.net_cash, 0)).toBe(
      550
    );
  });

  it('refuses a changed source instead of a partial cohort', async () => {
    source(10);
    pages(1, true);
    await expect(
      getClientPayerCohorts(fakeClient([10]), input)
    ).rejects.toThrow('finance list changed');
  });

  it('refuses amounts that do not reconcile with the finance report', async () => {
    source(11);
    pages(1);
    await expect(
      getClientPayerCohorts(fakeClient([10]), input)
    ).rejects.toThrow('did not reconcile');
  });

  it('refuses a finite finance history window before scanning', async () => {
    const client = fakeClient([]);
    const original = client.request.bind(client);
    client.request = jest.fn(
      async (...args: Parameters<typeof client.request>) => {
        const result = await original(...args);
        if (args[1].includes('/user/permissions/'))
          (
            result.data as { finances: { finances_last_days_count: number } }
          ).finances.finances_last_days_count = 30;
        return result;
      }
    ) as typeof client.request;
    await expect(getClientPayerCohorts(client, input)).rejects.toThrow(
      'last-days limit'
    );
  });

  it('stops reading details after the first refused transaction', async () => {
    source(200);
    pages(200);
    const client = fakeClient(Array.from({ length: 200 }, () => 1));
    const original = client.request.bind(client);
    let detailReads = 0;
    client.request = jest.fn(
      async (...args: Parameters<typeof client.request>) => {
        if (args[1].startsWith('/finance_transactions/')) {
          detailReads += 1;
          if (args[1].endsWith('/1'))
            throw new AltegioApiError('forbidden', 403);
        }
        return original(...args);
      }
    ) as typeof client.request;
    await expect(getClientPayerCohorts(client, input)).rejects.toThrow(
      'forbidden'
    );
    // One wave of concurrent reads may finish; the remaining ids are skipped.
    expect(detailReads).toBeLessThan(50);
  });

  it('refuses a period above the transaction cap with an input error', async () => {
    source(10);
    pages(4001);
    await expect(
      getClientPayerCohorts(fakeClient([10]), input)
    ).rejects.toThrow('Narrow the period');
  });

  it('refuses a detail outside the account allowlist', async () => {
    source(10);
    pages(1);
    const client = fakeClient([10]);
    const original = client.request.bind(client);
    client.request = jest.fn(
      async (...args: Parameters<typeof client.request>) => {
        const result = await original(...args);
        if (args[1].includes('/user/permissions/')) {
          const rights = (
            result.data as {
              finances: {
                finances_accounts_limited_access: boolean;
                finances_accounts_ids?: number[];
              };
            }
          ).finances;
          rights.finances_accounts_limited_access = true;
          rights.finances_accounts_ids = [11];
        }
        return result;
      }
    ) as typeof client.request;
    await expect(getClientPayerCohorts(client, input)).rejects.toThrow(
      'outside the authorized source'
    );
  });
});
