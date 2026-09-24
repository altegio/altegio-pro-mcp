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
import { prepareClientFile } from './client-file-upload.js';
import { AuthenticationError, AltegioApiError } from '../utils/errors.js';
import { upstreamDetail } from '../tools/tool-result.js';
import {
  assertCompanyAllowed,
  getRequestCompanyIds,
  getRequestIdentity,
  getRequestPartnerToken,
  getRequestUserToken,
  identityKey,
  isCompanyAllowed,
  type RequestIdentity,
} from '../request-context.js';

/**
 * The company (location) ID an Altegio request path targets, if any.
 *
 * Curated location-scoped methods supported by this client carry the
 * company/location ID as the first purely-numeric path segment:
 * `/records/{id}`, `/staff/{id}/{staffId}`, `/company/{id}/analytics/…`,
 * `/client/{id}/{clientId}`, even the v2 `/../v2/locations/{id}/clients/{cid}/…`
 * bridge. Company-less curated paths such as `/companies` and `/auth` carry no
 * numeric segment and return `undefined`.
 *
 * The universal executor does not rely on this heuristic: its catalog metadata
 * supplies the explicit company override, including routes whose first numeric
 * segment is an entity id. The query string is dropped first so a numeric query
 * value (e.g. `page=2`) is never mistaken for the id.
 */
function companyIdFromPath(endpoint: string): number | undefined {
  const path = endpoint.split('?')[0] ?? endpoint;
  for (const segment of path.split('/')) {
    if (/^\d+$/.test(segment)) {
      const id = Number(segment);
      if (Number.isInteger(id) && id > 0) return id;
    }
  }
  return undefined;
}

/**
 * Flatten an Altegio `meta.errors` payload into a short, human-readable string.
 *
 * The API returns validation problems as `meta.errors`, either an object keyed
 * by field (`{seance_length: ["is required"]}`) or a plain array/string. The
 * curated tools used to drop this entirely and surface only a bare status code,
 * which made a missing `seance_length` (422) indistinguishable from a
 * permission problem. Passing it through gives the caller the real cause.
 */
function formatApiErrorDetails(errors: unknown): string | undefined {
  if (!errors) return undefined;
  if (typeof errors === 'string') return errors;
  if (Array.isArray(errors)) {
    const flat = errors.map((e) => String(e)).filter(Boolean);
    return flat.length > 0 ? flat.join('; ') : undefined;
  }
  if (typeof errors === 'object') {
    const parts: string[] = [];
    for (const [field, value] of Object.entries(
      errors as Record<string, unknown>
    )) {
      const messages = Array.isArray(value)
        ? value.map((v) => String(v)).join(', ')
        : String(value);
      parts.push(field ? `${field}: ${messages}` : messages);
    }
    return parts.length > 0 ? parts.join('; ') : undefined;
  }
  return undefined;
}

/**
 * A 2xx response whose envelope says the call did not succeed. The sentence is
 * ours; the API's own message is quoted after it as third-party text rather
 * than becoming the whole error the model reads.
 */
function unexpectedResponseMessage(context: string, raw: unknown): string {
  const detail = upstreamDetail(raw);
  const base = `Unexpected response for ${context}.`;
  return detail ? `${base} ${detail}` : base;
}

export interface AltegioClientOptions {
  /**
   * When true (set in the HTTP deployment), anonymous requests — HTTP requests
   * without a proxy-verified identity — get no user token and cannot login.
   * Local stdio usage is unaffected.
   */
  requireDelegatedIdentity?: boolean;
}

export type LegacyWebQueryValue =
  string | number | readonly string[] | readonly number[] | undefined;

export interface LegacyWebRequest {
  /** Location boundary enforced before any request leaves this process. */
  locationId: number;
  /** Absolute path on the configured ERP web origin. Never include a query. */
  path: string;
  query?: Readonly<Record<string, LegacyWebQueryValue>>;
}

export class AltegioClient {
  private apiUrl: string;
  private legacyWebUrl: string;
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
    this.legacyWebUrl = (
      config.legacyWebBase || 'https://app.alteg.io'
    ).replace(/\/+$/, '');
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
   * - Direct token (`X-Altegio-User-Token`): used as-is, ahead of everything
   *   below. This is the multi-client path — the request names the exact
   *   Altegio client it acts for, so no login or per-identity storage applies.
   * - No HTTP context (stdio): legacy single-user token / credentials.json.
   * - HTTP but anonymous (`null`): no token when delegated identity is
   *   required; otherwise legacy behavior (transition mode).
   * - Identity present: only that identity's token — never another identity's
   *   token and never the legacy file.
   */
  private resolveUserToken(): string | undefined {
    const direct = getRequestUserToken();
    if (direct) {
      return direct;
    }

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
    options: RequestInit = {},
    scopedCompanyOverride?: number | null
  ): Promise<Response> {
    // Confine the request to the caller's declared company scope, if any. This
    // is the one choke point every upstream call funnels through — curated
    // tools, the analytics/clients ports, and the executor — so an out-of-scope
    // company is rejected here regardless of which tool asked (a no-op when no
    // scope was declared).
    const targetCompany =
      scopedCompanyOverride === undefined
        ? companyIdFromPath(endpoint)
        : (scopedCompanyOverride ?? undefined);
    if (targetCompany !== undefined) {
      assertCompanyAllowed(targetCompany);
    }

    // UC2 (application agent) supplies its own partner token per request; UC1
    // (human via a generic agent) signs with the server's own partner token.
    const partnerToken = getRequestPartnerToken() ?? this.partnerToken;
    const userToken = this.resolveUserToken();
    const authParts = [`Bearer ${partnerToken}`];
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
   * Fetch one temporary legacy ERP web report without creating a browser
   * session. The current request's Altegio user token is injected here, and
   * nowhere else, as the accepted `user_hash` query parameter. Callers receive
   * only the response body; URL construction, the secret and redirect handling
   * stay inside this boundary so diagnostics can never echo the query string.
   */
  async requestLegacyWebReport(request: LegacyWebRequest): Promise<Response> {
    assertCompanyAllowed(request.locationId);
    this.requireAuth();

    const userToken = this.resolveUserToken();
    // `requireAuth` resolved the same request-scoped credential immediately
    // above. Keep this defensive branch explicit for future resolver changes.
    if (!userToken) {
      throw new AuthenticationError('Not authenticated.');
    }

    if (!request.path.startsWith('/') || request.path.includes('?')) {
      throw new AltegioApiError(
        'The legacy analytics adapter built an invalid report path.',
        500
      );
    }

    const url = new URL(`${this.legacyWebUrl}${request.path}`);
    for (const [name, raw] of Object.entries(request.query ?? {})) {
      if (raw === undefined) continue;
      const values = Array.isArray(raw) ? raw : [raw];
      for (const value of values) url.searchParams.append(name, String(value));
    }
    url.searchParams.set('user_hash', userToken);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json, text/html, application/vnd.ms-excel',
          'X-Requested-With': 'XMLHttpRequest',
        },
        redirect: 'manual',
        credentials: 'omit',
      });
    } catch {
      // Deliberately discard the native fetch error: it may include the URL,
      // whose query carries the user token.
      throw new AltegioApiError(
        'The legacy analytics report could not be reached. Retry once; if it persists, the temporary ERP report endpoint is unavailable.',
        503
      );
    }

    if (response.status >= 300 && response.status < 400) {
      throw new AltegioApiError(
        'The legacy analytics report redirected instead of returning data. Refresh the delegated Altegio authentication and retry.',
        401
      );
    }
    if (response.status === 401) {
      throw new AltegioApiError(
        'The delegated Altegio authentication was not accepted by the legacy analytics report. Refresh it and retry.',
        401
      );
    }
    if (response.status === 403) {
      throw new AltegioApiError(
        'Access to this analytics report is denied for the current Altegio user. Ask a location owner to grant the matching report permission.',
        403
      );
    }
    if (response.status === 404) {
      throw new AltegioApiError(
        'This temporary legacy analytics report is not enabled for the location.',
        404
      );
    }
    if (!response.ok) {
      throw new AltegioApiError(
        `The legacy analytics report failed with HTTP ${response.status}. Retry later or use a neighboring analytics tool.`,
        response.status
      );
    }

    return response;
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
    const rawMessage =
      (meta?.message as string) || response.statusText || 'Unknown error';
    // Surface the API's own validation details (meta.errors) alongside the
    // message so the caller sees the real cause, not just an HTTP status.
    const details = formatApiErrorDetails(meta?.errors);
    const raw = details ? `${rawMessage} (${details})` : rawMessage;
    // What to do next is ours to say (ADR-001 D8). The API's own wording is
    // third-party text: it is quoted after our sentence, never spliced into it,
    // so it cannot read as the instruction the caller should follow.
    const detail = upstreamDetail(raw);
    const suffix = detail ? ` ${detail}` : '';

    switch (response.status) {
      case 401:
        throw new AuthenticationError(
          `Session expired while trying to ${context}. Call altegio_login to re-authenticate.`
        );
      case 403:
        // A permission problem and a plain validation refusal both arrive as
        // 4xx, so the upstream wording is kept — quoted — rather than collapsed
        // into one opaque "Access denied" string.
        throw new AltegioApiError(
          `Access denied while trying to ${context} (HTTP 403). Check location permissions or the user's role.${suffix}`,
          403,
          body
        );
      case 404:
        throw new AltegioApiError(
          `Not found while trying to ${context} (HTTP 404). Verify the ID is correct.${suffix}`,
          404,
          body
        );
      default:
        throw new AltegioApiError(
          `Failed to ${context} (HTTP ${response.status}).${suffix}`,
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
        unexpectedResponseMessage(context, result.meta?.message),
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

    const declaredCompanyIds = getRequestCompanyIds();
    if (params?.my === 1 && declaredCompanyIds) {
      // A UC2 application's technical user can successfully access a declared
      // location directly while `/companies?my=1` still returns an empty list.
      // The trusted proxy has already bound this request to the declared
      // location set. Resolve only those exact IDs through the documented
      // single-location read instead of trusting an unrelated account listing.
      const ids = [...declaredCompanyIds];
      const page = params.page ?? 1;
      const count = params.count ?? ids.length;
      const pageIds = ids.slice((page - 1) * count, page * count);
      return Promise.all(pageIds.map((id) => this.getLocation(id, { my: 1 })));
    }

    const queryParams = params
      ? `?${new URLSearchParams(params as Record<string, string>).toString()}`
      : '';
    const response = await this.apiRequest(`/companies${queryParams}`);

    const locations = await this.handleResponse<AltegioCompany[]>(
      response,
      'fetch locations'
    );
    // Confine `list_locations` to the declared company scope: a request scoped
    // via `X-Altegio-Company-Id` only ever sees its own locations, so a shared
    // user token cannot enumerate the other salons it happens to reach. Unscoped
    // requests see everything (no-op).
    return locations.filter((location) => isCompanyAllowed(location.id));
  }

  /** Get one location through the documented V1 location endpoint. */
  async getLocation(
    companyId: number,
    params?: { my?: number }
  ): Promise<AltegioCompany> {
    this.requireAuth();

    const queryParams = params
      ? `?${new URLSearchParams(params as Record<string, string>).toString()}`
      : '';
    const response = await this.apiRequest(
      `/company/${companyId}${queryParams}`
    );

    return this.handleResponse<AltegioCompany>(response, 'fetch location');
  }

  /**
   * Update a location's data (B2B API, requires user auth).
   * PUT /company/{location_id}
   */
  async updateLocation(
    companyId: number,
    data: import('../types/altegio.types.js').UpdateLocationRequest
  ): Promise<AltegioCompany> {
    this.requireAuth();

    const response = await this.apiRequest(`/company/${companyId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    return this.handleResponse<AltegioCompany>(response, 'update location');
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

    return this.handleResponse<AltegioBooking[]>(
      response,
      'fetch appointments'
    );
  }

  /**
   * Get staff for a location (B2B API, requires user auth)
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
   * Get services for a location (B2B API, requires user auth)
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

  /** Get one service, including its current team-member links. */
  async getService(
    companyId: number,
    serviceId: number
  ): Promise<AltegioService> {
    this.requireAuth();

    const response = await this.apiRequest(
      `/services/${companyId}/${serviceId}`
    );
    const result = await this.handleResponse<AltegioService | AltegioService[]>(
      response,
      'fetch service'
    );
    const service = Array.isArray(result)
      ? (result.find((item) => item.id === serviceId) ?? result[0])
      : result;
    if (!service) {
      throw new AltegioApiError(
        `Service ${serviceId} was not present in the fetch service response`,
        404,
        result
      );
    }
    return service;
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
   * Get location positions (B2B API, requires user auth)
   */
  async getPositions(companyId: number): Promise<AltegioPosition[]> {
    this.requireAuth();

    const response = await this.apiRequest(
      `/company/${companyId}/staff/positions`
    );

    return this.handleResponse<AltegioPosition[]>(response, 'fetch positions');
  }

  /**
   * Get staff member schedule for a date range (B2B API, requires user auth)
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

  /**
   * Get several team-member schedules in one documented request, optionally
   * with the backend's busy intervals. Analytics uses this instead of one
   * request per person so capacity calculations stay bounded.
   */
  async getTeamMemberSchedules(
    companyId: number,
    params: {
      start_date: string;
      end_date: string;
      team_member_ids?: number[];
      include_busy_intervals?: boolean;
    }
  ): Promise<AltegioScheduleEntry[]> {
    this.requireAuth();

    const query = new URLSearchParams({
      start_date: params.start_date,
      end_date: params.end_date,
    });
    for (const id of params.team_member_ids ?? []) {
      query.append('staff_ids[]', String(id));
    }
    if (params.include_busy_intervals) {
      query.append('include[]', 'busy_intervals');
    }

    const response = await this.apiRequest(
      `/company/${companyId}/staff/schedule?${query.toString()}`
    );
    return this.handleResponse<AltegioScheduleEntry[]>(
      response,
      'fetch team member schedules'
    );
  }

  // ========== Schedule CRUD Operations ==========

  /**
   * Set team member schedules (B2B API, requires user auth).
   * PUT /company/{location_id}/staff/schedule
   *
   * Supports setting and clearing schedules for multiple team members in one
   * request.
   *
   * IMPORTANT — the backend expects the per-entry key `staff_id`, NOT the
   * `team_member_id` the public OpenAPI documents. The controller validates the
   * body with a strict Symfony `Collection` (no missing, no extra keys), so a
   * `team_member_id` key is rejected as unknown AND `staff_id` is reported
   * missing — the request fails with HTTP 422 even though it matches the spec.
   * The MCP keeps the canonical `team_member_id` at its own boundary and maps it
   * to `staff_id` here, confining the wire-dialect mismatch to this one place.
   * (Backend: More\Master\Validation\SingleStaffScheduleDto.)
   */
  async setSchedule(
    companyId: number,
    data: import('../types/altegio.types.js').SetScheduleRequest
  ): Promise<AltegioScheduleEntry[]> {
    this.requireAuth();

    const body: Record<string, unknown> = {};
    if (data.schedules_to_set) {
      body.schedules_to_set = data.schedules_to_set.map((s) => ({
        staff_id: s.team_member_id,
        dates: s.dates,
        slots: s.slots.map((slot) => ({ from: slot.from, to: slot.to })),
      }));
    }
    if (data.schedules_to_delete) {
      body.schedules_to_delete = data.schedules_to_delete.map((d) => ({
        staff_id: d.team_member_id,
        dates: d.dates,
      }));
    }

    const response = await this.apiRequest(
      `/company/${companyId}/staff/schedule`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
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
      // The upstream default creates an inactive row. Default to active while
      // retaining an explicit `active: 0` for callers intentionally creating a
      // draft or hidden service.
      body: JSON.stringify({ ...data, active: data.active ?? 1 }),
    });

    return this.handleResponse<AltegioService>(response, 'create service');
  }

  async updateService(
    companyId: number,
    serviceId: number,
    data: import('../types/altegio.types.js').UpdateServiceRequest
  ): Promise<AltegioService> {
    this.requireAuth();

    // V1 PUT is replacement-shaped. Read the current service first and carry
    // every documented writable field — especially `staff` — into the update.
    // A partial PUT without the staff array silently removes the service links
    // and makes existing appointment creation fail.
    const current = await this.getService(companyId, serviceId);
    if (!Array.isArray(current.staff)) {
      throw new AltegioApiError(
        `Cannot safely update service ${serviceId}: the service read did not include its team-member links`,
        502,
        current
      );
    }

    const merged: Record<string, unknown> = {};
    const writableFields = [
      'title',
      'category_id',
      'price_min',
      'price_max',
      'duration',
      'technical_break_duration',
      'discount',
      'comment',
      'weight',
      'active',
      'api_id',
    ] as const;
    for (const field of writableFields) {
      const value = current[field];
      if (value !== undefined) merged[field] = value;
    }
    Object.assign(merged, data);
    merged.staff = current.staff.map((link) => ({
      id: link.id,
      seance_length: link.seance_length,
      ...(link.technological_card_id !== undefined
        ? { technological_card_id: link.technological_card_id }
        : {}),
    }));

    const response = await this.apiRequest(
      `/services/${companyId}/${serviceId}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(merged),
      }
    );

    return this.handleResponse<AltegioService>(response, 'update service');
  }

  /**
   * Delete a service (B2B API, requires user auth).
   * DELETE /services/{location_id}/{service_id} — 204 No Content.
   */
  async deleteService(companyId: number, serviceId: number): Promise<void> {
    this.requireAuth();

    const response = await this.apiRequest(
      `/services/${companyId}/${serviceId}`,
      {
        method: 'DELETE',
      }
    );

    await this.handleVoidResponse(response, 'delete service');
  }

  // ========== Service ↔ Team Member Links ==========

  /**
   * Link a team member to a service (B2B API, requires user auth).
   * POST /company/{location_id}/services/{service_id}/staff
   *
   * Without this link, creating an appointment fails with HTTP 400
   * "team member does not provide the selected services".
   */
  async assignServiceToStaff(
    companyId: number,
    serviceId: number,
    data: import('../types/altegio.types.js').AssignServiceStaffRequest
  ): Promise<import('../types/altegio.types.js').MasterServiceLink> {
    this.requireAuth();

    const response = await this.apiRequest(
      `/company/${companyId}/services/${serviceId}/staff`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          technological_card_id: null,
          ...data,
        }),
      }
    );

    return this.handleResponse<
      import('../types/altegio.types.js').MasterServiceLink
    >(response, 'link team member to service');
  }

  /**
   * Update an existing team member ↔ service link (duration, tech card).
   * PUT /company/{location_id}/services/{service_id}/staff/{team_member_id}
   */
  async updateServiceStaffAssignment(
    companyId: number,
    serviceId: number,
    teamMemberId: number,
    data: import('../types/altegio.types.js').UpdateServiceStaffRequest
  ): Promise<import('../types/altegio.types.js').MasterServiceLink> {
    this.requireAuth();

    const response = await this.apiRequest(
      `/company/${companyId}/services/${serviceId}/staff/${teamMemberId}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          technological_card_id: null,
          ...data,
        }),
      }
    );

    return this.handleResponse<
      import('../types/altegio.types.js').MasterServiceLink
    >(response, 'update team member service link');
  }

  /**
   * Remove a team member ↔ service link (B2B API, requires user auth).
   * DELETE /company/{location_id}/services/{service_id}/staff/{team_member_id}
   */
  async removeServiceFromStaff(
    companyId: number,
    serviceId: number,
    teamMemberId: number
  ): Promise<void> {
    this.requireAuth();

    const response = await this.apiRequest(
      `/company/${companyId}/services/${serviceId}/staff/${teamMemberId}`,
      {
        method: 'DELETE',
      }
    );

    await this.handleVoidResponse(response, 'unlink team member from service');
  }

  // ========== Supported public V1 Position Operations ==========

  async createPosition(
    companyId: number,
    data: import('../types/altegio.types.js').CreatePositionRequest
  ): Promise<AltegioPosition> {
    this.requireAuth();

    const response = await this.apiRequest(
      `/company/${companyId}/positions/quick`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: data.title }),
      }
    );

    return this.handleResponse<AltegioPosition>(response, 'create position');
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

  /** Delete one specifically identified booking form. */
  async deleteBookingForm(companyId: number, formId: number): Promise<void> {
    this.requireAuth();

    const response = await this.apiRequest(
      `/company/${companyId}/booking_forms/${formId}`,
      { method: 'DELETE' }
    );
    await this.handleVoidResponse(response, 'delete booking form');
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

    return this.handleResponse<AltegioBooking>(response, 'create appointment');
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

    return this.handleResponse<AltegioBooking>(response, 'update appointment');
  }

  async deleteBooking(companyId: number, recordId: number): Promise<void> {
    this.requireAuth();

    const response = await this.apiRequest(`/record/${companyId}/${recordId}`, {
      method: 'DELETE',
    });

    await this.handleVoidResponse(response, 'delete appointment');
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

  /** Delete one specifically identified client. */
  async deleteClient(companyId: number, clientId: number): Promise<void> {
    this.requireAuth();

    const response = await this.apiRequest(`/client/${companyId}/${clientId}`, {
      method: 'DELETE',
    });
    await this.handleVoidResponse(response, 'delete client');
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

  /** Delete one specifically identified location-owned service category. */
  async deleteServiceCategory(
    companyId: number,
    categoryId: number
  ): Promise<void> {
    this.requireAuth();

    const response = await this.apiRequest(
      `/service_category/${companyId}/${categoryId}`,
      { method: 'DELETE' }
    );
    await this.handleVoidResponse(response, 'delete service category');
  }

  /** Remove one specifically identified user from one location. */
  async removeLocationUser(companyId: number, userId: number): Promise<void> {
    this.requireAuth();

    const response = await this.apiRequest(
      `/company/${companyId}/users/${userId}`,
      { method: 'DELETE' }
    );
    await this.handleVoidResponse(response, 'remove location user');
  }

  /**
   * Generic catalog-driven request for the universal executor (ADR-001 D2).
   *
   * `method` is typed as `'GET'` on purpose: until the executor write allowlist
   * lands, only documented reads may be executed, and pinning the literal here
   * makes that policy a compile-time guarantee instead of a runtime check that
   * a future caller could forget. Everything else reuses the existing plumbing
   * — partner + user auth headers, the `application/vnd.api.v2+json` Accept
   * header, and the typed error mapping.
   *
   * Returns the unwrapped payload plus `meta` (page and total counts) when the
   * V1 `{success, data, meta}` envelope is present.
   */
  async request<T = unknown>(
    method: 'GET',
    path: string,
    query?: Record<string, string | number | boolean>,
    scopedCompanyOverride?: number | null
  ): Promise<{ data: T; meta?: Record<string, unknown> }> {
    this.requireAuth();

    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      search.append(key, String(value));
    }
    const queryString = search.toString();
    const endpoint =
      (path.startsWith('/') ? path : `/${path}`) +
      (queryString ? `?${queryString}` : '');
    const context = `call ${method} ${path}`;

    const response = await this.apiRequest(
      endpoint,
      { method },
      scopedCompanyOverride
    );
    if (!response.ok) {
      await this.throwApiError(response, context);
    }

    const body = (await response.json()) as unknown;

    // V1 wraps payloads in `{success, data, meta}`; a few endpoints and the V3
    // contract return the payload directly.
    if (
      typeof body === 'object' &&
      body !== null &&
      'success' in body &&
      'data' in body
    ) {
      const envelope = body as AltegioApiResponse<T>;
      if (!envelope.success) {
        throw new AltegioApiError(
          unexpectedResponseMessage(context, envelope.meta?.message),
          response.status,
          envelope
        );
      }
      return {
        data: envelope.data,
        ...(envelope.meta
          ? { meta: envelope.meta as Record<string, unknown> }
          : {}),
      };
    }

    return { data: body as T };
  }

  /** Upload one client-card file through the documented multipart V1 operation. */
  async uploadClientFile(
    locationId: number,
    clientId: number,
    filename: string,
    fileBase64: string
  ): Promise<unknown[]> {
    assertCompanyAllowed(locationId);
    this.requireAuth();
    const { bytes, mime } = prepareClientFile(filename, fileBase64);
    const form = new FormData();
    form.set(
      'file',
      new Blob([new Uint8Array(bytes)], { type: mime }),
      filename
    );
    const path = `/company/${locationId}/clients/files/${clientId}`;
    const response = await this.apiRequest(path, {
      method: 'POST',
      body: form,
    });
    const files = await this.handleResponse<unknown>(
      response,
      'upload client file'
    );
    if (!Array.isArray(files)) {
      throw new AltegioApiError(
        'The client-file upload returned an invalid file list.',
        502
      );
    }
    return files;
  }

  /** Curated documented JSON writes. The universal executor remains GET only. */
  async postJson<T = unknown>(path: string, body: object): Promise<T> {
    this.requireAuth();
    const response = await this.apiRequest(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return this.handleResponse<T>(response, `call POST ${path}`);
  }

  isAuthenticated(): boolean {
    return !!this.resolveUserToken();
  }
}
