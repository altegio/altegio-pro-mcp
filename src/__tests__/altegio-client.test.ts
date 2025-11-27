import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';
import { AltegioClient } from '../providers/altegio-client.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { promises as fs } from 'fs';

// Mock fetch globally
global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>;

describe('AltegioClient', () => {
  let client: AltegioClient;
  let testDir: string;
  const mockConfig = {
    apiUrl: 'https://api.altegio.com',
    partnerToken: 'test-partner-token',
  };

  beforeEach(() => {
    testDir = join(tmpdir(), `altegio-client-test-${Date.now()}`);
    client = new AltegioClient(mockConfig, testDir);
    (fetch as jest.MockedFunction<typeof fetch>).mockClear();
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('constructor', () => {
    it('should create client instance with config', () => {
      expect(client).toBeInstanceOf(AltegioClient);
    });
  });

  describe('login', () => {
    it('should login successfully with correct credentials', async () => {
      const mockResponse = {
        success: true,
        data: { user_token: 'test-user-token' },
      };

      (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await client.login('test@example.com', 'password123');

      expect(fetch).toHaveBeenCalledWith('https://api.alteg.io/api/v1/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/vnd.api.v2+json',
          Authorization: 'Bearer test-partner-token',
        },
        body: JSON.stringify({
          login: 'test@example.com',
          password: 'password123',
        }),
      });

      expect(result).toEqual({
        success: true,
        user_token: 'test-user-token',
      });
    });

    it('should handle HTTP errors', async () => {
      (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      } as Response);

      const result = await client.login('test@example.com', 'wrong-password');

      expect(result).toEqual({
        success: false,
        error: 'HTTP 401: Unauthorized',
      });
    });

    it('should handle API error responses', async () => {
      const mockResponse = {
        success: false,
        data: {},
        meta: { message: 'Invalid credentials' },
      };

      (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await client.login('test@example.com', 'wrong-password');

      expect(result).toEqual({
        success: false,
        error: 'Invalid credentials',
      });
    });

    it('should handle network errors', async () => {
      (fetch as jest.MockedFunction<typeof fetch>).mockRejectedValueOnce(
        new Error('Network error')
      );

      const result = await client.login('test@example.com', 'password123');

      expect(result).toEqual({
        success: false,
        error: 'Network error',
      });
    });
  });

  describe('logout', () => {
    it('should logout successfully', async () => {
      const result = await client.logout();
      expect(result).toEqual({ success: true });
    });
  });

  describe('getCompanies', () => {
    it('should throw error when not authenticated', async () => {
      await expect(client.getCompanies()).rejects.toThrow('Not authenticated');
    });

    it('should fetch companies successfully when authenticated', async () => {
      // First login
      const loginResponse = {
        success: true,
        data: { user_token: 'test-user-token' },
      };

      (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => loginResponse,
      } as Response);

      await client.login('test@example.com', 'password123');

      // Then fetch companies
      const mockCompanies = [
        {
          id: 1,
          title: 'Company 1',
          address: '123 Main St',
          phone: '555-0001',
        },
        {
          id: 2,
          title: 'Company 2',
          address: '456 Oak Ave',
          phone: '555-0002',
        },
      ];

      const companiesResponse = {
        success: true,
        data: mockCompanies,
      };

      (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => companiesResponse,
      } as Response);

      const companies = await client.getCompanies();

      expect(fetch).toHaveBeenLastCalledWith(
        'https://api.alteg.io/api/v1/companies',
        {
          headers: {
            Accept: 'application/vnd.api.v2+json',
            Authorization: 'Bearer test-partner-token, User test-user-token',
          },
        }
      );

      expect(companies).toEqual(mockCompanies);
    });

    it('should fetch only user companies when my=1', async () => {
      // Login first
      const loginResponse = {
        success: true,
        data: { user_token: 'test-user-token', id: 123 },
      };

      (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => loginResponse,
      } as Response);

      await client.login('test@example.com', 'password123');

      // Fetch companies with my=1
      const mockCompanies = [
        {
          id: 1,
          title: 'My Company 1',
          address: '123 Main St',
          phone: '555-0001',
        },
      ];

      const companiesResponse = {
        success: true,
        data: mockCompanies,
      };

      (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => companiesResponse,
      } as Response);

      const companies = await client.getCompanies({ my: 1 });

      expect(fetch).toHaveBeenLastCalledWith(
        'https://api.alteg.io/api/v1/companies?my=1',
        {
          headers: {
            Accept: 'application/vnd.api.v2+json',
            Authorization: 'Bearer test-partner-token, User test-user-token',
          },
        }
      );

      expect(companies).toEqual(mockCompanies);
    });

    it('should fetch companies with pagination parameters', async () => {
      // Login first
      const loginResponse = {
        success: true,
        data: { user_token: 'test-user-token', id: 123 },
      };

      (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => loginResponse,
      } as Response);

      await client.login('test@example.com', 'password123');

      // Fetch companies with pagination
      const mockCompanies = [
        {
          id: 1,
          title: 'Company 1',
          address: '123 Main St',
          phone: '555-0001',
        },
      ];

      const companiesResponse = {
        success: true,
        data: mockCompanies,
      };

      (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => companiesResponse,
      } as Response);

      const companies = await client.getCompanies({ page: 1, count: 10 });

      expect(fetch).toHaveBeenLastCalledWith(
        'https://api.alteg.io/api/v1/companies?page=1&count=10',
        {
          headers: {
            Accept: 'application/vnd.api.v2+json',
            Authorization: 'Bearer test-partner-token, User test-user-token',
          },
        }
      );

      expect(companies).toEqual(mockCompanies);
    });

    it('should handle API errors', async () => {
      // Login first
      const loginResponse = {
        success: true,
        data: { user_token: 'test-user-token' },
      };

      (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => loginResponse,
      } as Response);

      await client.login('test@example.com', 'password123');

      // Mock failed response
      (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response);

      await expect(client.getCompanies()).rejects.toThrow(
        'Failed to fetch companies: Internal Server Error'
      );
    });
  });

  describe('getBookings', () => {
    it('should throw error when not authenticated', async () => {
      await expect(client.getBookings(1)).rejects.toThrow('Not authenticated');
    });

    it('should fetch bookings successfully when authenticated', async () => {
      // First login
      const loginResponse = {
        success: true,
        data: { user_token: 'test-user-token' },
      };

      (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => loginResponse,
      } as Response);

      await client.login('test@example.com', 'password123');

      // Then fetch bookings
      const mockBookings = [
        {
          id: 1,
          datetime: '2025-10-25T10:00:00Z',
          client: { name: 'John Doe', phone: '555-1234' },
          services: [{ id: 1, title: 'Haircut', cost: 50 }],
          staff: { id: 1, name: 'Jane Smith' },
        },
      ];

      const bookingsResponse = {
        success: true,
        data: mockBookings,
      };

      (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => bookingsResponse,
      } as Response);

      const bookings = await client.getBookings(1);

      expect(fetch).toHaveBeenLastCalledWith(
        'https://api.alteg.io/api/v1/records/1',
        {
          headers: {
            Accept: 'application/vnd.api.v2+json',
            Authorization: 'Bearer test-partner-token, User test-user-token',
          },
        }
      );

      expect(bookings).toEqual(mockBookings);
    });

    it('should handle API errors', async () => {
      // Login first
      const loginResponse = {
        success: true,
        data: { user_token: 'test-user-token' },
      };

      (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => loginResponse,
      } as Response);

      await client.login('test@example.com', 'password123');

      // Mock failed response
      (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as Response);

      await expect(client.getBookings(999)).rejects.toThrow(
        'Failed to fetch bookings: Not Found'
      );
    });
  });

  describe('Public API methods (no user auth)', () => {
    describe('getStaff', () => {
      it('should fetch staff list with user token', async () => {
        const mockStaff = [
          {
            id: 1,
            name: 'John Doe',
            specialization: 'Hair Stylist',
            rating: 4.8,
            avatar: 'https://example.com/avatar1.jpg',
            position: {
              id: 10,
              title: 'Senior Stylist',
            },
          },
          {
            id: 2,
            name: 'Jane Smith',
            specialization: 'Makeup Artist',
            rating: 4.9,
          },
        ];

        const staffResponse = {
          success: true,
          data: mockStaff,
        };

        (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
          ok: true,
          json: async () => staffResponse,
        } as Response);

        const authenticatedClient = new AltegioClient(
          {
            apiBase: 'https://api.alteg.io/api/v1',
            partnerToken: 'test-partner-token',
            userToken: 'test-user-token',
          },
          testDir
        );

        const staff = await authenticatedClient.getStaff(4564);

        expect(fetch).toHaveBeenLastCalledWith(
          'https://api.alteg.io/api/v1/staff/4564',
          {
            headers: {
              Accept: 'application/vnd.api.v2+json',
              Authorization: 'Bearer test-partner-token, User test-user-token',
            },
          }
        );

        expect(staff).toEqual(mockStaff);
      });
    });

    describe('getStaff B2B', () => {
      it('should require user token', async () => {
        const client = new AltegioClient(
          {
            apiBase: 'https://api.altegio.com',
            partnerToken: 'partner123',
            userToken: undefined,
          },
          testDir
        );

        await expect(client.getStaff(4564)).rejects.toThrow(
          'Not authenticated'
        );
      });

      it('should include user token in auth header', async () => {
        const mockStaff = [
          {
            id: 1,
            name: 'John Doe',
            specialization: 'Hair Stylist',
          },
        ];

        const staffResponse = {
          success: true,
          data: mockStaff,
        };

        (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
          ok: true,
          json: async () => staffResponse,
        } as Response);

        const authenticatedClient = new AltegioClient(
          {
            apiBase: 'https://api.alteg.io/api/v1',
            partnerToken: 'partner123',
            userToken: 'user456',
          },
          testDir
        );

        await authenticatedClient.getStaff(4564);

        expect(fetch).toHaveBeenLastCalledWith(
          'https://api.alteg.io/api/v1/staff/4564',
          {
            headers: {
              Accept: 'application/vnd.api.v2+json',
              Authorization: 'Bearer partner123, User user456',
            },
          }
        );
      });
    });

    describe('getServices', () => {
      it('should fetch services list with user authentication', async () => {
        const mockServices = [
          {
            id: 100,
            title: 'Haircut',
            cost: 1500,
            duration: 60,
            category_id: 5,
          },
          {
            id: 101,
            title: 'Hair Coloring',
            cost: 3000,
            duration: 120,
            category_id: 5,
          },
        ];

        const servicesResponse = {
          success: true,
          data: mockServices,
        };

        (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
          ok: true,
          json: async () => servicesResponse,
        } as Response);

        const authenticatedClient = new AltegioClient(
          {
            apiBase: 'https://api.alteg.io/api/v1',
            partnerToken: 'test-partner-token',
            userToken: 'test-token-123',
          },
          testDir
        );

        const services = await authenticatedClient.getServices(4564);

        expect(fetch).toHaveBeenLastCalledWith(
          'https://api.alteg.io/api/v1/company/4564/services',
          {
            headers: {
              Accept: 'application/vnd.api.v2+json',
              Authorization: 'Bearer test-partner-token, User test-token-123',
            },
          }
        );

        expect(services).toEqual(mockServices);
      });
    });

    describe('getServices B2B', () => {
      it('should require user token', async () => {
        const client = new AltegioClient(
          {
            apiBase: 'https://api.altegio.com',
            partnerToken: 'partner123',
            userToken: undefined,
          },
          testDir
        );

        await expect(client.getServices(4564)).rejects.toThrow(
          'Not authenticated'
        );
      });

      it('should use company admin endpoint', async () => {
        (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, data: [] }),
        } as Response);

        const client = new AltegioClient({
          apiBase: 'https://api.alteg.io/api/v1',
          partnerToken: 'partner123',
          userToken: 'user456',
        });

        await client.getServices(4564);

        expect(fetch).toHaveBeenLastCalledWith(
          'https://api.alteg.io/api/v1/company/4564/services',
          expect.any(Object)
        );
      });
    });

    describe('getServiceCategories', () => {
      it('should fetch service categories with only partner token', async () => {
        const mockCategories = [
          {
            id: 5,
            title: 'Hair Services',
            services: [{ id: 100, title: 'Haircut', cost: 1500 }],
          },
          {
            id: 6,
            title: 'Nail Services',
          },
        ];

        const categoriesResponse = {
          success: true,
          data: mockCategories,
        };

        (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
          ok: true,
          json: async () => categoriesResponse,
        } as Response);

        const categories = await client.getServiceCategories(4564);

        expect(fetch).toHaveBeenLastCalledWith(
          'https://api.alteg.io/api/v1/service_categories/4564',
          {
            headers: {
              Accept: 'application/vnd.api.v2+json',
              Authorization: 'Bearer test-partner-token',
            },
          }
        );

        expect(categories).toEqual(mockCategories);
      });
    });
  });
});
