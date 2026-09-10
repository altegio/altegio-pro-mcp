import { getScheduleTool } from '../definitions/schedule.tools.js';
import type { AltegioClient } from '../../providers/altegio-client.js';

describe('get_schedule handler', () => {
  it('normalizes legacy 0/1 working flags to booleans in structured output', async () => {
    const client = {
      getSchedule: jest.fn().mockResolvedValue([
        {
          date: '2026-09-10',
          is_working: 1,
          slots: [{ from: '09:00', to: '18:00' }],
        },
        { date: '2026-09-11', is_working: 0, slots: [] },
      ]),
    } as unknown as AltegioClient;

    const result = await getScheduleTool.createHandler(client)({
      location_id: 4564,
      team_member_id: 447367,
      start_date: '2026-09-10',
      end_date: '2026-09-11',
    });

    expect(result.structuredContent).toMatchObject({
      items: [{ is_working: true }, { is_working: false }],
      count: 2,
    });
    expect(result.content[0]?.text).toContain('day off');
  });
});
