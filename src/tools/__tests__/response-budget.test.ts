import {
  fitPageToBudget,
  fitPrefixToBudget,
  resultBytes,
} from '../pagination.js';
import { getAppointmentsTool } from '../definitions/index.js';
import type { AltegioClient } from '../../providers/altegio-client.js';

const render = (page: {
  items: string[];
  pagination: unknown;
  notice?: string;
}) => ({
  text: [page.notice ?? '', ...page.items].join('\n'),
  structuredContent: { items: page.items, pagination: page.pagination },
});

describe('fitPageToBudget', () => {
  const items = Array.from({ length: 100 }, (_, i) => `item-${i}`.repeat(10));

  it('returns the page untouched when it fits', () => {
    const result = fitPageToBudget({
      input: { page: 1, page_size: 100 },
      items,
      render,
      budget: 1_000_000,
    });
    expect(result.structuredContent.items).toHaveLength(100);
  });

  it('cuts to a divisor of the page size that continues exactly', () => {
    const result = fitPageToBudget({
      input: { page: 2, page_size: 100 },
      items,
      total: 1000,
      render,
      budget: 9_000,
    });
    expect(resultBytes(result)).toBeLessThanOrEqual(9_000);
    const { pagination } = result.structuredContent as {
      pagination: { page: number; page_size: number; next_page: number };
    };
    const served = result.structuredContent.items.length;
    expect(100 % served).toBe(0);
    // Page 2 of size 100 starts at item 100: so does the page served.
    expect((pagination.page - 1) * pagination.page_size).toBe(100);
    expect(pagination.page_size).toBe(served);
    expect(pagination.next_page).toBe(pagination.page + 1);
    expect(result.text).toContain(
      `continue with page=${pagination.next_page}, page_size=${served}`
    );
  });
});

describe('fitPrefixToBudget', () => {
  it('keeps the longest prefix that fits and says where it stopped', () => {
    const items = Array.from({ length: 50 }, (_, i) => 'x'.repeat(100) + i);
    let cut: number | undefined;
    const result = fitPrefixToBudget({
      items,
      budget: 2_000,
      render: (served, cutAt) => {
        cut = cutAt;
        return { text: served.join('\n') };
      },
    });
    expect(resultBytes(result)).toBeLessThanOrEqual(2_000);
    expect(cut).toBe(result.text.split('\n').length);
  });
});

describe('appointments_list size budget', () => {
  it('keeps a full page of 100 large appointments under 40 KB', async () => {
    const appointments = Array.from({ length: 100 }, (_, i) => ({
      id: 1000 + i,
      company_id: 4564,
      staff_id: 7,
      staff: { id: 7, name: 'Team member' },
      client: { id: 500 + i, name: `Client ${i}`, phone: '420777000000' },
      services: [
        { id: 11, title: 'Service with a long title', cost: 790, amount: 1 },
        { id: 12, title: 'Another service', cost: 300, amount: 1 },
      ],
      datetime: '2026-10-31T17:25:00+02:00',
      date: '2026-10-31 17:25:00',
      attendance: 1,
      seance_length: 3600,
      comment: 'A comment the client typed at online booking. '.repeat(3),
      record_labels: [{ id: 3, title: 'Online', color: '2196f3' }],
      deleted: false,
    }));
    const client = {
      getBookings: jest.fn().mockResolvedValue(appointments),
    } as unknown as AltegioClient;

    const result = await getAppointmentsTool.createHandler(client)({
      location_id: 4564,
      page_size: 100,
    });
    const bytes =
      Buffer.byteLength(result.content[0]?.text ?? '') +
      Buffer.byteLength(JSON.stringify(result.structuredContent));
    expect(bytes).toBeLessThanOrEqual(40_000);
    const content = result.structuredContent as {
      items: Array<Record<string, unknown>>;
      pagination: { page: number; page_size: number; next_page: number };
    };
    expect(content.items.length).toBeLessThan(100);
    expect(content.pagination.page_size).toBe(content.items.length);
    expect(content.items[0]).not.toHaveProperty('date');
    // Each team member and service is named once, not per appointment.
    const text = result.content[0]?.text ?? '';
    expect(text.match(/team member 7: /g)).toHaveLength(1);
    expect(text.match(/service 11: /g)).toHaveLength(1);
  });

  it('refuses a page size above 100', async () => {
    const client = { getBookings: jest.fn() } as unknown as AltegioClient;
    const result = await getAppointmentsTool.createHandler(client)({
      location_id: 4564,
      page_size: 300,
    });
    expect(result.isError).toBe(true);
    expect(client.getBookings).not.toHaveBeenCalled();
  });
});
