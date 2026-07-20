import type {
  AltegioConfig,
  AltegioCredentials,
  AltegioLoginResponse,
  AltegioApiResponse,
  AltegioCompany,
  AltegioBooking,
  AltegioStaff,
  AltegioService,
  AltegioServiceCategory,
  AltegioPosition,
  AltegioScheduleEntry,
  AltegioBookingParams,
  AltegioCompaniesParams,
  AltegioListParams,
  AppointmentSettings,
  OnlineBookingSettings,
  BookingForm,
  AltegioResource,
} from '../types/altegio.types.js';
import { CredentialManager } from './credential-manager.js';
import { AuthenticationError, AltegioApiError } from '../utils/errors.js';
import {
  getRequestIdentity,
  identityKey,
  type RequestIdentity,
} from '../request-context.js';

export interface AltegioClientOptions {
  /**
   * When true (set in the HTTP deployment), anonymous requests — HTTP requests
   * without a proxy-verified identity — get no user token and cannot login.
   * Local stdio usage is unaffected.
   */
  requireDelegatedIdentity?: boolean;
}

export class AltegioClient {
  private apiUrl: string;
  private partnerToken: string;
  /** Legacy single-user token (stdio / transition mode only). */
  private userToken?: string;
  private credentials: CredentialManager;
  private requireDelegatedIdentity: boolean;
  /** Per-identity token cache backing the credential files (HTTP mode). */
  private tokenCache = new Map<string, string>();

  constructor(
    config: AltegioConfig,
    credentialsDir?: string,
    options?: AltegioClientOptions
  ) {
    this.apiUrl = config.apiBase || 'https://api.alteg.io/api/v1';
    this.partnerToken = config.partnerToken;
    this.userToken = config.userToken;
    this.credentials = new CredentialManager(credentialsDir);
    this.requireDelegatedIdentity = options?.requireDelegatedIdentity ?? false;
    // NOTE: credentials are resolved per request (see resolveUserToken), never
    // loaded into shared global state at construction time.
  }

  /**
   * Resolve the Altegio user token for the CURRENT request.
   *
   * - No HTTP context (stdio): legacy single-user token / credentials.json.
   * - HTTP but anonymous (`null`): no token when delegated identity is
   *   required; otherwise legacy behavior (transition mode).
   * - Identity present: only that identity's token — never another identity's
   *   token and never the legacy file.
   */
  private resolveUserToken(): string | undefined {
    const identity = getRequestIdentity();

    // stdio, or HTTP transition mode (anonymous + not enforcing delegation).
    if (
      identity === undefined ||
      (identity === null && !this.requireDelegatedIdentity)
    ) {
      return this.resolveLegacyToken();
    }

    // HTTP, anonymous, delegation enforced: no user token.
    if (identity === null) {
      return undefined;
    }

    // Proxy-verified identity: strictly scoped to this identity.
    const key = identityKey(identity);
    const cached = this.tokenCache.get(key);
    if (cached) {
      return cached;
    }
    const saved = this.credentials.load(key);
    if (saved?.user_token) {
      this.tokenCache.set(key, saved.user_token);
      return saved.user_token;
    }
    return undefined;
  }

  /**
   * Legacy single-user token resolution (stdio / transition mode). Lazily
   * loads credentials.json once, mirroring the previous constructor behavior.
   */
  private resolveLegacyToken(): string | undefined {
    if (this.userToken) {
      return this.userToken;
    }
    const saved = this.credentials.load();
    if (saved?.user_token) {
      this.userToken = saved.user_token;
      return this.userToken;
    }
    return undefined;
  }

  /**
   * Internal fetch wrapper with common headers
   */
  private async apiRequest(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const userToken = this.resolveUserToken();
    const authParts = [`Bearer ${this.partnerToken}`];
    if (userToken) {
      authParts.push(`User ${userToken}`);
    }

    const headers: Record<string, string> = {
      Accept: 'application/vnd.api.v2+json',
      Authorization: authParts.join(', '),
      ...((options.headers as Record<string, string>) || {}),
    };

    return fetch(`${this.apiUrl}${endpoint}`, {
      ...options,
      headers,
    });
  }

  /**
   * Throw a typed API error based on HTTP status code
   */
  private async throwApiError(
    response: Response,
    context: string
  ): Promise<never> {
    let body: Record<string, unknown> | undefined;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      const text = await response.text().catch(() => response.statusText);
      body = { meta: { message: text } };
    }
    const meta = body?.meta as Record<string, unknown> | undefined;
    const message =
      (meta?.message as string) || response.statusText || 'Unknown error';

    switch (response.status) {
      case 401:
        throw new AuthenticationError(
          `Session expired while trying to ${context}. Call altegio_login to re-authenticate.`
        );
      case 403:
        throw new AltegioApiError(
          `Access denied for ${context}. Check company permissions.`,
          403,
          body
        );
      case 404:
        throw new AltegioApiError(
          `Not found: ${context}. Verify the ID is correct.`,
          404,
          body
        );
      default:
        throw new AltegioApiError(
          `Failed to ${context}: ${message} (HTTP ${response.status})`,
          response.status,
          body
        );
    }
  }

  /**
   * Centralized response handler for methods that return data
   */
  private async handleResponse<T>(
    response: Response,
    context: string
  ): Promise<T> {
    if (!response.ok) {
      await this.throwApiError(response, context);
    }

    const result = (await response.json()) as AltegioApiResponse<T>;
    if (!result.success || result.data === undefined || result.data === null) {
      throw new AltegioApiError(
        result.meta?.message || `Unexpected response for ${context}`,
        response.status,
        result
      );
    }
    return result.data;
  }

  /**
   * Centralized response handler for void-returning methods (DELETE)
   */
  private async handleVoidResponse(
    response: Response,
    context: string
  ): Promise<void> {
    if (!response.ok) {
      await this.throwApiError(response, context);
    }
  }

  /**
   * Require authentication, throwing AuthenticationError if not logged in
   */
  private requireAuth(): void {
    if (!this.resolveUserToken()) {
      throw new AuthenticationError(
        'Not authenticated. Call altegio_login first.'
      );
    }
  }

  async login(
    email: string,
    password: string
  ): Promise<{ success: boolean; user_token?: string; error?: string }> {
    const identity = getRequestIdentity();

    // In the HTTP deployment an anonymous request has no identity to key a
    // token by; refuse rather than silently writing a shared token.
    if (identity === null && this.requireDelegatedIdentity) {
      return {
        success: false,
        error:
          'This deployment requires a proxy-verified identity; login is unavailable for anonymous sessions.',
      };
    }

    try {
      const response = await this.apiRequest('/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ login: email, password }),
      });

      if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const result = (await response.json()) as AltegioLoginResponse;

      if (result.success && result.data?.user_token) {
        const token = result.data.user_token;
        const credentials: AltegioCredentials = {
          user_token: token,
          user_id: result.data.id,
          updated_at: new Date().toISOString(),
        };

        await this.persistToken(token, credentials, identity);

        return { success: true, user_token: token };
      }

      return {
        success: false,
        error: result.meta?.message || 'Login failed',
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Store a freshly obtained token under the current request's identity
   * (HTTP mode) or the legacy single-user file (stdio / transition mode).
   */
  private async persistToken(
    token: string,
    credentials: AltegioCredentials,
    identity: RequestIdentity | null | undefined
  ): Promise<void> {
    if (identity) {
      const key = identityKey(identity);
      this.tokenCache.set(key, token);
      await this.credentials.save(credentials, key);
      return;
    }
    this.userToken = token;
    await this.credentials.save(credentials);
  }

  async logout(): Promise<{ success: boolean }> {
    const identity = getRequestIdentity();
    if (identity) {
      const key = identityKey(identity);
      this.tokenCache.delete(key);
      await this.credentials.clear(key);
    } else {
      this.userToken = undefined;
      await this.credentials.clear();
    }
    return { success: true };
  }

  async getCompanies(
    params?: AltegioCompaniesParams
  ): Promise<AltegioCompany[]> {
    this.requireAuth();

    const queryParams = params
      ? `?${new URLSearchParams(params as Record<string, string>).toString()}`
      : '';
    const response = await this.apiRequest(`/companies${queryParams}`);

    return this.handleResponse<AltegioCompany[]>(response, 'fetch companies');
  }

  async getBookings(
    companyId: number,
    params?: AltegioListParams
  ): Promise<AltegioBooking[]> {
    this.requireAuth();

    const queryParams = params
      ? `?${new URLSearchParams(params as Record<string, string>).toString()}`
      : '';
    const response = await this.apiRequest(
      `/records/${companyId}${queryParams}`
    );

    return this.handleResponse<AltegioBooking[]>(response, 'fetch bookings');
  }

  /**
   * Get staff for a company (B2B API, requires user auth)
   */
  async getStaff(
    companyId: number,
    params?: AltegioBookingParams
  ): Promise<AltegioStaff[]> {
    this.requireAuth();

    const queryParams = params
      ? `?${new URLSearchParams(params as Record<string, string>).toString()}`
      : '';
    const response = await this.apiRequest(`/staff/${companyId}${queryParams}`);

    return this.handleResponse<AltegioStaff[]>(response, 'fetch staff');
  }

  /**
   * Get services for booking (B2B API, requires user auth)
   */
  async getServices(
    companyId: number,
    params?: AltegioBookingParams
  ): Promise<AltegioService[]> {
    this.requireAuth();

    const queryParams = params
      ? `?${new URLSearchParams(params as Record<string, string>).toString()}`
      : '';
    const response = await this.apiRequest(
      `/services/${companyId}${queryParams}`
    );

    return this.handleResponse<AltegioService[]>(response, 'fetch services');
  }

  /**
   * Get service categories (public API, no user auth required)
   */
  async getServiceCategories(
    companyId: number,
    categoryId: number = 0,
    params?: AltegioBookingParams
  ): Promise<AltegioServiceCategory[]> {
    const queryParams = params
      ? `?${new URLSearchParams(params as Record<string, string>).toString()}`
      : '';
    const response = await this.apiRequest(
      `/service_categories/${companyId}/${categoryId}${queryParams}`
    );

    return this.handleResponse<AltegioServiceCategory[]>(
      response,
      'fetch service categories'
    );
  }

  /**
   * Get company positions (B2B API, requires user auth)
   */
  async getPositions(companyId: number): Promise<AltegioPosition[]> {
    this.requireAuth();

    const response = await this.apiRequest(`/positions/${companyId}`);

    return this.handleResponse<AltegioPosition[]>(response, 'fetch positions');
  }

  /**
   * Get employee schedule for a date range (B2B API, requires user auth)
   */
  async getSchedule(
    companyId: number,
    staffId: number,
    startDate: string,
    endDate: string
  ): Promise<AltegioScheduleEntry[]> {
    this.requireAuth();

    const response = await this.apiRequest(
      `/schedule/${companyId}/${staffId}/${startDate}/${endDate}`
    );

    return this.handleResponse<AltegioScheduleEntry[]>(
      response,
      'fetch schedule'
    );
  }

  // ========== Schedule CRUD Operations ==========

  /**
   * Set team member schedules (B2B API, requires user auth)
   * PUT /company/{location_id}/staff/schedule
   *
   * Supports both setting and deleting schedules in a single request.
   */
  async setSchedule(
    companyId: number,
    data: import('../types/altegio.types.js').SetScheduleRequest
  ): Promise<AltegioScheduleEntry[]> {
    this.requireAuth();

    const response = await this.apiRequest(
      `/company/${companyId}/staff/schedule`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      }
    );

    return this.handleResponse<AltegioScheduleEntry[]>(
      response,
      'set schedule'
    );
  }

  // ========== Staff CRUD Operations ==========

  async createStaff(
    companyId: number,
    data: import('../types/altegio.types.js').CreateStaffRequest
  ): Promise<AltegioStaff> {
    this.requireAuth();

    const response = await this.apiRequest(
      `/company/${companyId}/staff/quick`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      }
    );

    return this.handleResponse<AltegioStaff>(response, 'create staff');
  }

  async updateStaff(
    companyId: number,
    staffId: number,
    data: import('../types/altegio.types.js').UpdateStaffRequest
  ): Promise<AltegioStaff> {
    this.requireAuth();

    const response = await this.apiRequest(`/staff/${companyId}/${staffId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    return this.handleResponse<AltegioStaff>(response, 'update staff');
  }

  async deleteStaff(companyId: number, staffId: number): Promise<void> {
    this.requireAuth();

    const response = await this.apiRequest(`/staff/${companyId}/${staffId}`, {
      method: 'DELETE',
    });

    await this.handleVoidResponse(response, 'delete staff');
  }

  // ========== Services CRUD Operations ==========

  async createService(
    companyId: number,
    data: import('../types/altegio.types.js').CreateServiceRequest
  ): Promise<AltegioService> {
    this.requireAuth();

    const response = await this.apiRequest(`/services/${companyId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    return this.handleResponse<AltegioService>(response, 'create service');
  }

  async updateService(
    companyId: number,
    serviceId: number,
    data: import('../types/altegio.types.js').UpdateServiceRequest
  ): Promise<AltegioService> {
    this.requireAuth();

    const response = await this.apiRequest(
      `/services/${companyId}/${serviceId}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      }
    );

    return this.handleResponse<AltegioService>(response, 'update service');
  }

  // ========== Positions CRUD Operations ==========

  async createPosition(
    companyId: number,
    data: import('../types/altegio.types.js').CreatePositionRequest
  ): Promise<AltegioPosition> {
    this.requireAuth();

    const response = await this.apiRequest(`/positions/${companyId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    return this.handleResponse<AltegioPosition>(response, 'create position');
  }

  async updatePosition(
    companyId: number,
    positionId: number,
    data: import('../types/altegio.types.js').UpdatePositionRequest
  ): Promise<AltegioPosition> {
    this.requireAuth();

    const response = await this.apiRequest(
      `/positions/${companyId}/${positionId}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      }
    );

    return this.handleResponse<AltegioPosition>(response, 'update position');
  }

  async deletePosition(companyId: number, positionId: number): Promise<void> {
    this.requireAuth();

    const response = await this.apiRequest(
      `/positions/${companyId}/${positionId}`,
      {
        method: 'DELETE',
      }
    );

    await this.handleVoidResponse(response, 'delete position');
  }

  // ========== Location Settings & Resources ==========

  /**
   * Get appointment calendar settings (B2B API, requires user auth)
   * GET /company/{location_id}/settings/timetable
   */
  async getAppointmentSettings(
    companyId: number
  ): Promise<AppointmentSettings> {
    this.requireAuth();

    const response = await this.apiRequest(
      `/company/${companyId}/settings/timetable`
    );

    return this.handleResponse<AppointmentSettings>(
      response,
      'fetch appointment settings'
    );
  }

  /**
   * Update appointment calendar settings (B2B API, requires user auth)
   * PATCH /company/{location_id}/settings/timetable
   */
  async updateAppointmentSettings(
    companyId: number,
    data: import('../types/altegio.types.js').UpdateAppointmentSettingsRequest
  ): Promise<AppointmentSettings> {
    this.requireAuth();

    const response = await this.apiRequest(
      `/company/${companyId}/settings/timetable`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      }
    );

    return this.handleResponse<AppointmentSettings>(
      response,
      'update appointment settings'
    );
  }

  /**
   * Get online booking settings (B2B API, requires user auth)
   * GET /company/{location_id}/settings/online
   */
  async getOnlineBookingSettings(
    companyId: number
  ): Promise<OnlineBookingSettings> {
    this.requireAuth();

    const response = await this.apiRequest(
      `/company/${companyId}/settings/online`
    );

    return this.handleResponse<OnlineBookingSettings>(
      response,
      'fetch online booking settings'
    );
  }

  /**
   * Update online booking settings (B2B API, requires user auth)
   * PATCH /company/{location_id}/settings/online
   */
  async updateOnlineBookingSettings(
    companyId: number,
    data: import('../types/altegio.types.js').UpdateOnlineBookingSettingsRequest
  ): Promise<OnlineBookingSettings> {
    this.requireAuth();

    const response = await this.apiRequest(
      `/company/${companyId}/settings/online`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      }
    );

    return this.handleResponse<OnlineBookingSettings>(
      response,
      'update online booking settings'
    );
  }

  /**
   * Get booking (appointment) forms (B2B API, requires user auth)
   * GET /company/{location_id}/booking_forms
   */
  async getBookingForms(companyId: number): Promise<BookingForm[]> {
    this.requireAuth();

    const response = await this.apiRequest(
      `/company/${companyId}/booking_forms`
    );

    return this.handleResponse<BookingForm[]>(response, 'fetch booking forms');
  }

  /**
   * Create a booking (appointment) form (B2B API, requires user auth)
   * POST /company/{location_id}/booking_forms
   */
  async createBookingForm(
    companyId: number,
    data: import('../types/altegio.types.js').CreateBookingFormRequest
  ): Promise<BookingForm> {
    this.requireAuth();

    const response = await this.apiRequest(
      `/company/${companyId}/booking_forms`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      }
    );

    return this.handleResponse<BookingForm>(response, 'create booking form');
  }

  /**
   * Get resources at a location (B2B API, requires user auth).
   * Read-only: the API does not expose resource creation.
   * GET /resources/{location_id}
   */
  async getResources(companyId: number): Promise<AltegioResource[]> {
    this.requireAuth();

    const response = await this.apiRequest(`/resources/${companyId}`);

    return this.handleResponse<AltegioResource[]>(response, 'fetch resources');
  }

  // ========== Bookings CRUD Operations ==========

  async createBooking(
    companyId: number,
    data: import('../types/altegio.types.js').CreateBookingRequest
  ): Promise<AltegioBooking> {
    this.requireAuth();

    const response = await this.apiRequest(`/records/${companyId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    return this.handleResponse<AltegioBooking>(response, 'create booking');
  }

  async updateBooking(
    companyId: number,
    recordId: number,
    data: import('../types/altegio.types.js').UpdateBookingRequest
  ): Promise<AltegioBooking> {
    this.requireAuth();

    const response = await this.apiRequest(`/record/${companyId}/${recordId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    return this.handleResponse<AltegioBooking>(response, 'update booking');
  }

  async deleteBooking(companyId: number, recordId: number): Promise<void> {
    this.requireAuth();

    const response = await this.apiRequest(`/record/${companyId}/${recordId}`, {
      method: 'DELETE',
    });

    await this.handleVoidResponse(response, 'delete booking');
  }

  // ========== Clients CRUD Operations ==========

  async createClient(
    companyId: number,
    data: import('../types/altegio.types.js').CreateClientRequest
  ): Promise<import('../types/altegio.types.js').AltegioClientEntity> {
    this.requireAuth();

    const response = await this.apiRequest(`/clients/${companyId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    return this.handleResponse<
      import('../types/altegio.types.js').AltegioClientEntity
    >(response, 'create client');
  }

  // ========== Service Categories CRUD Operations ==========

  async createServiceCategory(
    companyId: number,
    data: import('../types/altegio.types.js').CreateCategoryRequest
  ): Promise<AltegioServiceCategory> {
    this.requireAuth();

    const response = await this.apiRequest(`/service_categories/${companyId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    return this.handleResponse<AltegioServiceCategory>(
      response,
      'create category'
    );
  }

  isAuthenticated(): boolean {
    return !!this.resolveUserToken();
  }
}
