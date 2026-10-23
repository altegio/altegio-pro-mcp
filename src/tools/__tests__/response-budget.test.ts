import { fitPrefixToBudget, renderPage, resultBytes } from '../pagination.js';
import { getAppointmentsTool } from '../definitions/index.js';
import type { AltegioClient } from '../../providers/altegio-client.js';

describe('renderPage', () => {
  it('never serves fewer items than the page size on a page that continues', () => {
    const items = Array.from({ length: 100 }, (_, i) =>
      `item-${i}`.repeat(100)
    );
    const result = renderPage({
      input: { page: 2, page_size: 100 },
      items,
      render: (page) => ({ items: page.items, pagination: page.pagination }),
    });
    expect(result.items).toHaveLength(100);
    expect(result.pagination).toEqual({
      page: 2,
      page_size: 100,
      returned: 100,
      total: null,
      has_more: true,
      next_page: 3,
    });
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

describe('appointments_list pages', () => {
  const appointment = (i: number) => ({
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
  });

  it('serves every requested appointment, however large the page renders', async () => {
    const client = {
      getBookings: jest
        .fn()
        .mockResolvedValue(
          Array.from({ length: 100 }, (_, i) => appointment(i))
        ),
    } as unknown as AltegioClient;

    const result = await getAppointmentsTool.createHandler(client)({
      location_id: 4564,
      page_size: 100,
    });
    const content = result.structuredContent as {
      items: Array<Record<string, unknown>>;
      pagination: { page: number; page_size: number; next_page: number };
    };
    expect(content.items).toHaveLength(100);
    expect(content.pagination).toMatchObject({
      page: 1,
      page_size: 100,
      next_page: 2,
    });
    expect(content.items[0]).not.toHaveProperty('date');
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('next: page=2, page_size=100.');
    // Each team member and service is named once, not per appointment.
    expect(text.match(/team member 7: /g)).toHaveLength(1);
    expect(text.match(/service 11: /g)).toHaveLength(1);
    expect(
      resultBytes({
        text,
        structuredContent: result.structuredContent,
      })
    ).toBeGreaterThan(40_000);
  });

  it('reads every appointment once when the caller keeps its page size', async () => {
    // 2026-10-12: with pages cut to 50, this loop read 200 of 797 appointments.
    const all = Array.from({ length: 797 }, (_, i) => appointment(i));
    const client = {
      getBookings: jest.fn(
        (_location: number, query: { page: number; count: number }) =>
          Promise.resolve(
            all.slice((query.page - 1) * query.count, query.page * query.count)
          )
      ),
    } as unknown as AltegioClient;
    const ids: unknown[] = [];
    let page: number | null = 1;
    while (page !== null) {
      const result = await getAppointmentsTool.createHandler(client)({
        location_id: 4564,
        page,
        page_size: 100,
      });
      const content = result.structuredContent as {
        items: Array<{ id: unknown }>;
        pagination: { next_page: number | null };
      };
      ids.push(...content.items.map((item) => item.id));
      page = content.pagination.next_page;
    }
    expect(ids).toHaveLength(797);
    expect(new Set(ids).size).toBe(797);
  });

  it('serves a first page asked above 100 at 100, and says so', async () => {
    const all = Array.from({ length: 150 }, (_, i) => appointment(i));
    const client = {
      getBookings: jest.fn(
        (_location: number, query: { page: number; count: number }) =>
          Promise.resolve(
            all.slice((query.page - 1) * query.count, query.page * query.count)
          )
      ),
    } as unknown as AltegioClient;
    const result = await getAppointmentsTool.createHandler(client)({
      location_id: 4564,
      page_size: 300,
    });
    expect(result.isError).toBeUndefined();
    expect(client.getBookings).toHaveBeenCalledWith(
      4564,
      expect.objectContaining({ page: 1, count: 100 })
    );
    const content = result.structuredContent as {
      items: unknown[];
      pagination: { page_size: number; next_page: number | null };
    };
    expect(content.items).toHaveLength(100);
    expect(content.pagination).toMatchObject({ page_size: 100, next_page: 2 });
    expect(result.content.map((block) => block.text).join('\n')).toContain(
      "page_size 300 is above this tool's maximum of 100"
    );
  });

  it('refuses a later page asked above 100: its offset would be wrong', async () => {
    const client = { getBookings: jest.fn() } as unknown as AltegioClient;
    const result = await getAppointmentsTool.createHandler(client)({
      location_id: 4564,
      page: 2,
      page_size: 300,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('page_size: at most 100');
    expect(client.getBookings).not.toHaveBeenCalled();
  });
});
