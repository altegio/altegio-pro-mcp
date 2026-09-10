import { updateLocationTool } from '../definitions/company.tools.js';
import type { AltegioClient } from '../../providers/altegio-client.js';

describe('update_location verification', () => {
  it('does not claim a phone update that the location read-back contradicts', async () => {
    const client = {
      updateLocation: jest.fn().mockResolvedValue({
        id: 4564,
        title: 'Ateliér Vltava',
      }),
      getLocation: jest.fn().mockResolvedValue({
        id: 4564,
        title: 'Ateliér Vltava',
        phones: ['420111111111'],
        city: 'Praha',
        address: 'Old address',
      }),
    } as unknown as AltegioClient;

    const result = await updateLocationTool.createHandler(client)({
      location_id: 4564,
      title: 'Ateliér Vltava',
      phones: ['420222222222'],
    });

    expect(result.content[0]?.text).toContain('Not confirmed by read back');
    expect(result.content[0]?.text).toContain('phones');
    expect(result.content[0]?.text).not.toContain(
      'Successfully updated location'
    );
    expect(result.structuredContent).toMatchObject({
      verification_source: 'read_back',
      verified_fields: ['title'],
      unconfirmed_fields: ['phones'],
      phones: ['420111111111'],
    });
  });

  it('reports when verification had to rely on the update response', async () => {
    const client = {
      updateLocation: jest.fn().mockResolvedValue({
        id: 4564,
        title: 'Renamed',
      }),
      getLocation: jest.fn().mockRejectedValue(new Error('read failed')),
    } as unknown as AltegioClient;

    const result = await updateLocationTool.createHandler(client)({
      location_id: 4564,
      title: 'Renamed',
      phones: ['420222222222'],
    });

    expect(result.content[0]?.text).toContain('Read-back unavailable');
    expect(result.structuredContent).toMatchObject({
      verification_source: 'update_response',
      verified_fields: ['title'],
      unconfirmed_fields: ['phones'],
      verification_error: 'read failed',
    });
  });
});
