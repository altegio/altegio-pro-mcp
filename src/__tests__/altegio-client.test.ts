import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';
import { AltegioClient } from '../providers/altegio-client.js';
import { AuthenticationError, AltegioApiError } from '../utils/errors.js';
import { CredentialManager } from '../providers/credential-manager.js';
import { runWithIdentity, type RequestIdentity } from '../request-context.js';
import { ToolHandlers } from '../tools/handlers.js';
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

  describe('error handling', () => {
    describe('authentication errors', () => {
      it('should throw AuthenticationError when not authenticated', async () => {
        await expect(client.getCompanies()).rejects.toThrow(
          AuthenticationError
        );
        await expect(client.getCompanies()).rejects.toThrow(
          'Not authenticated. Call altegio_login first.'
        );
      });

      it('should throw AuthenticationError on 401 response', async () => {
        // Login first
        (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            success: true,
            data: { user_token: 'test-token' },
          }),
        } as Response);
        await client.login('test@example.com', 'password123');

        // Mock 401 response
        (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: async () => ({ meta: { message: 'Token expired' } }),
        } as unknown as Response);

        await expect(client.getCompanies()).rejects.toThrow(
          AuthenticationError
        );
        // Re-mock for second assertion
        (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: async () => ({ meta: { message: 'Token expired' } }),
        } as unknown as Response);
        await expect(client.getCompanies()).rejects.toThrow(/altegio_login/);
      });

      it('should throw AltegioApiError on 404 response', async () => {
        // Login first
        (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            success: true,
            data: { user_token: 'test-token' },
          }),
        } as Response);
        await client.login('test@example.com', 'password123');

        // Mock 404 response
        (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          json: async () => ({ meta: { message: 'Not found' } }),
        } as unknown as Response);

        await expect(client.getCompanies()).rejects.toThrow(AltegioApiError);
        // Re-mock
        (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          json: async () => ({ meta: { message: 'Not found' } }),
        } as unknown as Response);
        await expect(client.getCompanies()).rejects.toThrow(/Verify the ID/);
      });

      it('should throw AltegioApiError on 500 response with meta.message', async () => {
        // Login first
        (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            success: true,
            data: { user_token: 'test-token' },
          }),
        } as Response);
        await client.login('test@example.com', 'password123');

        // Mock 500 with JSON body
        (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          json: async () => ({
            meta: { message: 'Database connection failed' },
          }),
        } as unknown as Response);

        await expect(client.getCompanies()).rejects.toThrow(AltegioApiError);
        // Re-mock
        (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          json: async () => ({
            meta: { message: 'Database connection failed' },
          }),
        } as unknown as Response);
        await expect(client.getCompanies()).rejects.toThrow(
          /Database connection failed/
        );
      });

      it('should handle non-JSON error responses gracefully', async () => {
        // Login first
        (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            success: true,
            data: { user_token: 'test-token' },
          }),
        } as Response);
        await client.login('test@example.com', 'password123');

        // Mock 500 with non-JSON body
        (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          json: async () => {
            throw new Error('not json');
          },
          text: async () => 'nginx gateway timeout',
        } as unknown as Response);

        await expect(client.getCompanies()).rejects.toThrow(
          /nginx gateway timeout/
        );
      });

      it('should throw AltegioApiError when success is false', async () => {
        // Login first
        (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            success: true,
            data: { user_token: 'test-token' },
          }),
        } as Response);
        await client.login('test@example.com', 'password123');

        // Mock 200 but success: false
        (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            success: false,
            meta: { message: 'Invalid filter parameter' },
          }),
        } as unknown as Response);

        await expect(client.getCompanies()).rejects.toThrow(AltegioApiError);
        // Re-mock
        (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            success: false,
            meta: { message: 'Invalid filter parameter' },
          }),
        } as unknown as Response);
        await expect(client.getCompanies()).rejects.toThrow(
          'Invalid filter parameter'
        );
      });
    });

    describe('void response methods', () => {
      it('should throw AuthenticationError on delete when not authenticated', async () => {
        const unauthClient = new AltegioClient(
          { partnerToken: 'test', userToken: undefined },
          testDir
        );
        await expect(unauthClient.deleteStaff(1, 1)).rejects.toThrow(
          AuthenticationError
        );
      });

      it('should throw AltegioApiError on delete 404', async () => {
        const authClient = new AltegioClient(
          {
            apiBase: 'https://api.alteg.io/api/v1',
            partnerToken: 'test',
            userToken: 'token',
          },
          testDir
        );

        (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          json: async () => ({ meta: { message: 'Staff not found' } }),
        } as unknown as Response);

        await expect(authClient.deleteStaff(1, 999)).rejects.toThrow(
          AltegioApiError
        );
      });
    });
  });

  describe('getCompanies', () => {
    it('should throw AuthenticationError when not authenticated', async () => {
      await expect(client.getCompanies()).rejects.toThrow(
        'Not authenticated. Call altegio_login first.'
      );
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

    it('should throw AltegioApiError on API errors', async () => {
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
        json: async () => ({
          meta: { message: 'Internal Server Error' },
        }),
      } as unknown as Response);

      await expect(client.getCompanies()).rejects.toThrow(AltegioApiError);
      // Re-mock
      (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({
          meta: { message: 'Internal Server Error' },
        }),
      } as unknown as Response);
      await expect(client.getCompanies()).rejects.toThrow(/HTTP 500/);
    });
  });

  describe('getBookings', () => {
    it('should throw AuthenticationError when not authenticated', async () => {
      await expect(client.getBookings(1)).rejects.toThrow(
        'Not authenticated. Call altegio_login first.'
      );
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

    it('should throw AltegioApiError on API errors', async () => {
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
        json: async () => ({ meta: { message: 'Not found' } }),
      } as unknown as Response);

      await expect(client.getBookings(999)).rejects.toThrow(AltegioApiError);
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
          'Not authenticated. Call altegio_login first.'
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
          'https://api.alteg.io/api/v1/services/4564',
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
          'Not authenticated. Call altegio_login first.'
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
          'https://api.alteg.io/api/v1/services/4564',
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
          'https://api.alteg.io/api/v1/service_categories/4564/0',
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

  describe('request-scoped delegated identity', () => {
    const idA: RequestIdentity = { kind: 'user', email: 'a@example.com' };
    const idB: RequestIdentity = { kind: 'user', email: 'b@example.com' };

    const mockOnce = (body: unknown, ok = true): void => {
      (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok,
        json: async () => body,
      } as Response);
    };
    const mockLogin = (token: string): void =>
      mockOnce({ success: true, data: { user_token: token, id: 1 } });
    const mockEmptyCompanies = (): void =>
      mockOnce({ success: true, data: [] });

    it('never lets identity B act with identity A token, even right after A login', async () => {
      mockLogin('token-A');
      const login = await runWithIdentity(idA, () =>
        client.login('a@example.com', 'password123')
      );
      expect(login.success).toBe(true);

      // Identity B has never logged in — it must not inherit A's token.
      await expect(
        runWithIdentity(idB, () => client.getCompanies())
      ).rejects.toThrow(AuthenticationError);
      expect(runWithIdentity(idB, () => client.isAuthenticated())).toBe(false);

      // Identity A is still authorized and its request carries A's token.
      mockEmptyCompanies();
      await runWithIdentity(idA, () => client.getCompanies());
      expect(fetch).toHaveBeenLastCalledWith(
        'https://api.alteg.io/api/v1/companies',
        {
          headers: {
            Accept: 'application/vnd.api.v2+json',
            Authorization: 'Bearer test-partner-token, User token-A',
          },
        }
      );
    });

    it('logout clears only the caller identity token', async () => {
      mockLogin('token-A');
      await runWithIdentity(idA, () => client.login('a@example.com', 'pw'));
      mockLogin('token-B');
      await runWithIdentity(idB, () => client.login('b@example.com', 'pw'));

      await runWithIdentity(idA, () => client.logout());

      expect(runWithIdentity(idA, () => client.isAuthenticated())).toBe(false);
      expect(runWithIdentity(idB, () => client.isAuthenticated())).toBe(true);
    });

    it('does not leak the token value in login/logout tool responses', async () => {
      const secret = 'super-secret-user-token';
      const handlers = new ToolHandlers(client);

      mockLogin(secret);
      const loginRes = await runWithIdentity(idA, () =>
        handlers.login({ email: 'a@example.com', password: 'pw' })
      );
      expect(JSON.stringify(loginRes)).toContain('Successfully logged in');
      expect(JSON.stringify(loginRes)).not.toContain(secret);

      const logoutRes = await runWithIdentity(idA, () => handlers.logout());
      expect(JSON.stringify(logoutRes)).not.toContain(secret);
    });

    it('stdio (no request context) still loads the legacy credentials.json', async () => {
      // Simulate a token persisted by a previous stdio session.
      const legacyStore = new CredentialManager(testDir);
      await legacyStore.save({
        user_token: 'legacy-token',
        user_id: 7,
        updated_at: new Date().toISOString(),
      });

      const stdioClient = new AltegioClient(
        {
          apiBase: 'https://api.alteg.io/api/v1',
          partnerToken: 'test-partner-token',
        },
        testDir
      );

      expect(stdioClient.isAuthenticated()).toBe(true);

      mockEmptyCompanies();
      await stdioClient.getCompanies();
      expect(fetch).toHaveBeenLastCalledWith(
        'https://api.alteg.io/api/v1/companies',
        {
          headers: {
            Accept: 'application/vnd.api.v2+json',
            Authorization: 'Bearer test-partner-token, User legacy-token',
          },
        }
      );
    });

    it('REQUIRE_DELEGATED_IDENTITY + anonymous request: no token, login refused', async () => {
      const secured = new AltegioClient(
        {
          apiBase: 'https://api.alteg.io/api/v1',
          partnerToken: 'test-partner-token',
        },
        testDir,
        { requireDelegatedIdentity: true }
      );

      // Anonymous HTTP request (null identity) is unauthenticated.
      expect(runWithIdentity(null, () => secured.isAuthenticated())).toBe(
        false
      );
      await expect(
        runWithIdentity(null, () => secured.getCompanies())
      ).rejects.toThrow(AuthenticationError);

      // ...and login is refused without ever calling the upstream /auth endpoint.
      const res = await runWithIdentity(null, () =>
        secured.login('a@example.com', 'pw')
      );
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/proxy-verified identity/);
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
