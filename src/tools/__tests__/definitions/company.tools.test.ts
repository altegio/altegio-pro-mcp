import { listCompaniesTool } from '../../definitions/company.tools.js';

describe('Company Tools', () => {
  const mockClient = {
    isAuthenticated: jest.fn(),
    getCompanies: jest.fn(),
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.isAuthenticated.mockReturnValue(true);
  });

  describe('listCompaniesTool', () => {
    it('requires auth', () => {
      expect(listCompaniesTool.meta.requiresAuth).toBe(true);
    });

    it('fetches and formats companies list', async () => {
      mockClient.getCompanies.mockResolvedValue([
        {
          id: 1,
          title: 'Salon ABC',
          public_title: 'Salon ABC',
          address: '123 Main St',
          phone: '+123456789',
        },
      ]);

      const handler = listCompaniesTool.createHandler(mockClient);
      const result = await handler({});

      expect(result.content[0]?.text).toContain('Salon ABC');
      expect(result.content[0]?.text).toContain('123 Main St');
      expect(mockClient.getCompanies).toHaveBeenCalledWith({});
    });

    it('handles my=1 parameter', async () => {
      mockClient.getCompanies.mockResolvedValue([
        {
          id: 2,
          title: 'My Company',
          public_title: 'My Company',
          address: '456 Oak Ave',
          phone: '+987654321',
        },
      ]);

      const handler = listCompaniesTool.createHandler(mockClient);
      const result = await handler({ my: 1 });

      expect(result.content[0]?.text).toContain('user companies');
      expect(mockClient.getCompanies).toHaveBeenCalledWith({ my: 1 });
    });
  });
});
