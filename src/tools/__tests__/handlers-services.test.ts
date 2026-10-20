import { ToolHandlers } from '../handlers.js';
import { AltegioClient } from '../../providers/altegio-client.js';
import { AuthenticationError } from '../../utils/errors.js';
import { clearCurrencyCache } from '../../api/v1/location-currency.js';

jest.mock('../../providers/altegio-client.js');

describe('ToolHandlers - Services CRUD', () => {
  let handlers: ToolHandlers;
  let mockClient: jest.Mocked<AltegioClient>;

  beforeEach(() => {
    mockClient = {
      getServices: jest.fn(),
      createService: jest.fn(),
      updateService: jest.fn(),
    } as unknown as jest.Mocked<AltegioClient>;
    handlers = new ToolHandlers(mockClient);
  });

  describe('getServices', () => {
    it('projects V1 prices, active state, duration and team-member links without undefined text', async () => {
      mockClient.getServices.mockResolvedValue([
        {
          id: 789,
          title: 'Haircut',
          category_id: 10,
          price_min: 100,
          price_max: 150,
          duration: 3600,
          active: 1,
          staff: [{ id: 123, seance_length: 3600 }],
        },
      ] as Awaited<ReturnType<AltegioClient['getServices']>>);

      const result = await handlers.getServices({ location_id: 456, page: 1 });

      const text = result.content[0]?.text ?? '';
      expect(text).toContain('price 100–150');
      expect(text).toContain('60 min');
      expect(text).toContain('active');
      expect(text).toContain('team members 123');
      expect(text).not.toContain('undefined');
      // The title is free input typed at the location: fenced, not in our row.
      const [ours, theirs] = text.split('\n\n');
      expect(ours).toContain('- 789');
      expect(ours).not.toContain('Haircut');
      expect(theirs).toContain('service 789: Haircut');
      expect(result.structuredContent).toMatchObject({
        items: [
          {
            id: 789,
            price_min: 100,
            price_max: 150,
            duration_seconds: 3600,
            active: true,
            team_members: [
              { team_member_id: 123, session_length_seconds: 3600 },
            ],
          },
        ],
      });
      expect(mockClient.getServices).toHaveBeenCalledWith(456);
    });

    it('reads a zero price_max as a fixed price and takes duration from the links', async () => {
      mockClient.getServices.mockResolvedValue([
        {
          id: 1,
          title: 'Highlights',
          price_min: 1700,
          price_max: 0,
          staff: [
            { id: 5, seance_length: 2700 },
            { id: 6, seance_length: 3600 },
          ],
        },
        { id: 2, title: 'Unlinked', price_min: 300, price_max: 300 },
      ] as Awaited<ReturnType<AltegioClient['getServices']>>);

      const result = await handlers.getServices({ location_id: 456, page: 1 });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('- 1 · price 1700 · 45 min–60 min by team member');
      expect(text).not.toContain('1700–0');
      expect(text).not.toContain('not reported');
      expect(text).toContain('- 2 · price 300 · no team members linked');
      expect(result.structuredContent).toMatchObject({
        items: [
          { id: 1, price_min: 1700, price_max: 1700, duration_seconds: null },
          { id: 2, price_min: 300, price_max: 300, duration_seconds: null },
        ],
      });
    });
  });

  describe('createService', () => {
    it('should create service successfully', async () => {
      const mockService = { id: 789, title: 'Haircut', category_id: 10 };
      mockClient.createService.mockResolvedValue(
        mockService as Awaited<ReturnType<AltegioClient['createService']>>
      );

      const result = await handlers.createService({
        location_id: 456,
        title: 'Haircut',
        category_id: 10,
      });

      expect(result.content[0]?.text).toContain('Created service');
      expect(result.content[0]?.text).toContain('Haircut');
      expect(mockClient.createService).toHaveBeenCalledWith(456, {
        title: 'Haircut',
        category_id: 10,
        active: 1,
      });
    });

    it('should handle errors', async () => {
      mockClient.createService.mockRejectedValue(
        new AuthenticationError('Not authenticated. Call auth_login first.')
      );

      const result = await handlers.createService({
        location_id: 456,
        title: 'Test',
        category_id: 1,
      });

      expect(result.content[0]?.text).toContain('Authentication required');
    });
  });

  describe('prices with decimals', () => {
    const currency = (iso: string) =>
      jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: { income_total_stats: { currency: { iso } } },
            }),
            { status: 200 }
          )
      );
    beforeEach(() => clearCurrencyCache());

    it('refuses a price the location currency cannot carry', async () => {
      Object.assign(mockClient, {
        apiRequest: currency('JPY'),
        isAuthenticated: () => true,
      });
      const result = await handlers.createService({
        location_id: 456,
        title: 'Haircut',
        category_id: 10,
        price_min: 1500.5,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain(
        'price_min 1500.5 has 1 decimal, but JPY amounts are written in whole numbers; round it.'
      );
      expect(mockClient.createService).not.toHaveBeenCalled();
    });

    it('writes it when the currency carries it, and reads no currency for whole prices', async () => {
      const apiRequest = currency('CZK');
      Object.assign(mockClient, { apiRequest, isAuthenticated: () => true });
      mockClient.updateService.mockResolvedValue({ id: 789 } as Awaited<
        ReturnType<AltegioClient['updateService']>
      >);
      await handlers.updateService({
        location_id: 456,
        service_id: 789,
        price_min: 99.5,
      });
      expect(mockClient.updateService).toHaveBeenCalledWith(456, 789, {
        price_min: 99.5,
      });
      expect(apiRequest).toHaveBeenCalledTimes(1);
      await handlers.updateService({
        location_id: 456,
        service_id: 789,
        price_max: 120,
      });
      expect(apiRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateService', () => {
    it('should update service successfully', async () => {
      const mockService = { id: 789, title: 'New Haircut' };
      mockClient.updateService.mockResolvedValue(
        mockService as Awaited<ReturnType<AltegioClient['updateService']>>
      );

      const result = await handlers.updateService({
        location_id: 456,
        service_id: 789,
        title: 'New Haircut',
      });

      expect(result.content[0]?.text).toContain('Successfully updated service');
      expect(mockClient.updateService).toHaveBeenCalledWith(456, 789, {
        title: 'New Haircut',
      });
    });
  });
});
