import { AltegioClient } from '../altegio-client';

describe('AltegioClient - Onboarding Methods', () => {
  let client: AltegioClient;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch;

    client = new AltegioClient({
      partnerToken: 'test-token',
      apiBase: 'https://api.test.com/api/v1'
    });

    // Simulate login
    (client as any).userToken = 'test-user-token';
  });

  describe('createClient', () => {
    it('should create a client', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: { id: 100, name: 'Test Client', phone: '1234567890' }
        })
      });

      const result = await client.createClient(123, {
        name: 'Test Client',
        phone: '1234567890'
      });

      expect(result.id).toBe(100);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/api/v1/clients/123',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'Test Client', phone: '1234567890' })
        })
      );
    });
  });

  describe('createServiceCategory', () => {
    it('should create a service category', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: { id: 10, title: 'Hair Services', weight: 1 }
        })
      });

      const result = await client.createServiceCategory(123, {
        title: 'Hair Services'
      });

      expect(result.id).toBe(10);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/api/v1/service_categories/123',
        expect.objectContaining({
          method: 'POST'
        })
      );
    });
  });
});
