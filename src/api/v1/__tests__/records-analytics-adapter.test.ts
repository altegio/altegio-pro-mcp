import type { AltegioClient } from '../../../providers/altegio-client.js';
import { scanRecords } from '../records-analytics-adapter.js';

const appointment = {
  id: 1,
  company_id: 7,
  staff_id: 9,
  attendance: 1,
  deleted: false,
  datetime: '2026-05-10T12:00:00+04:00',
  client: { id: 1, name: 'private', phone: 'secret' },
  resource_instance_ids: [501],
  services: [{ id: 10, title: 'A', amount: 2, manual_cost: 300, cost: 0 }],
};

/** A client whose appointment list answers every page with `respond(page)`. */
function client(respond: (page: number) => Response): {
  client: AltegioClient;
  pages: number[];
} {
  const pages: number[] = [];
  return {
    pages,
    client: {
      isAuthenticated: () => true,
      apiRequest: async (path: string) => {
        const page = Number(
          new URL(`https://example.test${path}`).searchParams.get('page')
        );
        pages.push(page);
        return respond(page);
      },
    } as unknown as AltegioClient,
  };
}

const envelope = (data: unknown[], total: number) =>
  Response.json({ success: true, data, meta: { total_count: total } });

const scan = (target: AltegioClient) =>
  scanRecords(target, 7, '2026-05-01', '2026-05-31');

describe('appointment scan for service analytics', () => {
  it('reads every page before claiming a complete result, without contacts', async () => {
    const all = Array.from({ length: 1001 }, (_, index) => ({
      ...appointment,
      id: index + 1,
    }));
    const source = client((page) =>
      envelope(all.slice((page - 1) * 1000, page * 1000), all.length)
    );
    const result = await scan(source.client);
    expect(source.pages).toEqual([1, 2]);
    expect(result.records).toHaveLength(1001);
    expect(result.records[0]?.client).toEqual({ id: 1 });
    expect(JSON.stringify(result.records)).not.toContain('secret');
  });

  it('refuses a source total above the hard scan limit', async () => {
    await expect(
      scan(client(() => envelope([], 30001)).client)
    ).rejects.toThrow('safe scan limit');
  });

  it('refuses missing pages rather than returning partial figures', async () => {
    await expect(scan(client(() => envelope([], 1)).client)).rejects.toThrow(
      'ended before'
    );
  });

  it('refuses a missing resource-instance field instead of treating it as no device', async () => {
    const incomplete: Record<string, unknown> = { ...appointment };
    delete incomplete.resource_instance_ids;
    await expect(
      scan(client(() => envelope([incomplete], 1)).client)
    ).rejects.toThrow('resource-instance fields');
  });

  it('turns a refused appointment list into an actionable access error', async () => {
    await expect(
      scan(
        client(() =>
          Response.json(
            { success: false, meta: { message: 'No access' } },
            { status: 403 }
          )
        ).client
      )
    ).rejects.toThrow('cannot read the appointment calendar');
  });
});
