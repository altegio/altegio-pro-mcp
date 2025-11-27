import { CredentialManager } from './credential-manager.js';
export class AltegioClient {
    apiUrl;
    partnerToken;
    userToken;
    credentials;
    constructor(config, credentialsDir) {
        this.apiUrl = config.apiBase || 'https://api.alteg.io/api/v1';
        this.partnerToken = config.partnerToken;
        this.userToken = config.userToken;
        this.credentials = new CredentialManager(credentialsDir);
        this.loadSavedCredentials();
    }
    loadSavedCredentials() {
        const savedCredentials = this.credentials.load();
        if (savedCredentials && savedCredentials.user_token) {
            this.userToken = savedCredentials.user_token;
        }
    }
    /**
     * Internal fetch wrapper with common headers
     */
    async apiRequest(endpoint, options = {}) {
        const authParts = [`Bearer ${this.partnerToken}`];
        if (this.userToken) {
            authParts.push(`User ${this.userToken}`);
        }
        const headers = {
            Accept: 'application/vnd.api.v2+json',
            Authorization: authParts.join(', '),
            ...(options.headers || {}),
        };
        return fetch(`${this.apiUrl}${endpoint}`, {
            ...options,
            headers,
        });
    }
    async login(email, password) {
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
            const result = (await response.json());
            if (result.success && result.data?.user_token) {
                this.userToken = result.data.user_token;
                const credentials = {
                    user_token: result.data.user_token,
                    user_id: result.data.id,
                    updated_at: new Date().toISOString(),
                };
                await this.credentials.save(credentials);
                return { success: true, user_token: result.data.user_token };
            }
            return {
                success: false,
                error: result.meta?.message || 'Login failed',
            };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }
    async logout() {
        this.userToken = undefined;
        await this.credentials.clear();
        return { success: true };
    }
    async getCompanies(params) {
        if (!this.userToken) {
            throw new Error('Not authenticated');
        }
        const queryParams = params
            ? `?${new URLSearchParams(params).toString()}`
            : '';
        const response = await this.apiRequest(`/companies${queryParams}`);
        if (!response.ok) {
            throw new Error(`Failed to fetch companies: ${response.statusText}`);
        }
        const result = (await response.json());
        if (result.success && result.data) {
            return result.data;
        }
        throw new Error(result.meta?.message || 'Failed to fetch companies');
    }
    async getBookings(companyId, params) {
        if (!this.userToken) {
            throw new Error('Not authenticated');
        }
        const queryParams = params
            ? `?${new URLSearchParams(params).toString()}`
            : '';
        const response = await this.apiRequest(`/records/${companyId}${queryParams}`);
        if (!response.ok) {
            throw new Error(`Failed to fetch bookings: ${response.statusText}`);
        }
        const result = (await response.json());
        if (result.success && result.data) {
            return result.data;
        }
        throw new Error(result.meta?.message || 'Failed to fetch bookings');
    }
    /**
     * Get staff for a company (B2B API, requires user auth)
     */
    async getStaff(companyId, params) {
        if (!this.userToken) {
            throw new Error('Not authenticated');
        }
        const queryParams = params
            ? `?${new URLSearchParams(params).toString()}`
            : '';
        const response = await this.apiRequest(`/staff/${companyId}${queryParams}`);
        if (!response.ok) {
            throw new Error(`Failed to fetch staff: ${response.statusText}`);
        }
        const result = (await response.json());
        if (result.success && result.data) {
            return result.data;
        }
        throw new Error(result.meta?.message || 'Failed to fetch staff');
    }
    /**
     * Get services for booking (B2B API, requires user auth)
     */
    async getServices(companyId, params) {
        if (!this.userToken) {
            throw new Error('Not authenticated');
        }
        const queryParams = params
            ? `?${new URLSearchParams(params).toString()}`
            : '';
        const response = await this.apiRequest(`/company/${companyId}/services${queryParams}`);
        if (!response.ok) {
            throw new Error(`Failed to fetch services: ${response.statusText}`);
        }
        const result = (await response.json());
        if (result.success && result.data) {
            return result.data;
        }
        throw new Error(result.meta?.message || 'Failed to fetch services');
    }
    /**
     * Get service categories (public API, no user auth required)
     */
    async getServiceCategories(companyId, params) {
        const queryParams = params
            ? `?${new URLSearchParams(params).toString()}`
            : '';
        const response = await this.apiRequest(`/service_categories/${companyId}${queryParams}`);
        if (!response.ok) {
            throw new Error(`Failed to fetch service categories: ${response.statusText}`);
        }
        const result = (await response.json());
        if (result.success && result.data) {
            return result.data;
        }
        throw new Error(result.meta?.message || 'Failed to fetch service categories');
    }
    /**
     * Get company positions (B2B API, requires user auth)
     */
    async getPositions(companyId) {
        if (!this.userToken) {
            throw new Error('Not authenticated');
        }
        const response = await this.apiRequest(`/positions/${companyId}`);
        if (!response.ok) {
            throw new Error(`Failed to fetch positions: ${response.statusText}`);
        }
        const result = (await response.json());
        if (result.success && result.data) {
            return result.data;
        }
        throw new Error(result.meta?.message || 'Failed to fetch positions');
    }
    /**
     * Get employee schedule for a date range (B2B API, requires user auth)
     */
    async getSchedule(companyId, staffId, startDate, endDate) {
        if (!this.userToken) {
            throw new Error('Not authenticated');
        }
        const response = await this.apiRequest(`/schedule/${companyId}/${staffId}/${startDate}/${endDate}`);
        if (!response.ok) {
            throw new Error(`Failed to fetch schedule: ${response.statusText}`);
        }
        const result = (await response.json());
        if (result.success && result.data) {
            return result.data;
        }
        throw new Error(result.meta?.message || 'Failed to fetch schedule');
    }
    // ========== Schedule CRUD Operations ==========
    /**
     * Create or update employee schedule (B2B API, requires user auth)
     * PUT /schedule/{company_id}
     */
    async createSchedule(companyId, data) {
        if (!this.userToken) {
            throw new Error('Not authenticated. Use login() first.');
        }
        const response = await this.apiRequest(`/schedule/${companyId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to create schedule: HTTP ${response.status} - ${errorText}`);
        }
        const result = (await response.json());
        if (!result.success || !result.data) {
            throw new Error(result.meta?.message || 'Failed to create schedule: Invalid response');
        }
        return result.data;
    }
    /**
     * Update employee schedule (B2B API, requires user auth)
     * PUT /schedule/{company_id}
     */
    async updateSchedule(companyId, data) {
        if (!this.userToken) {
            throw new Error('Not authenticated. Use login() first.');
        }
        const response = await this.apiRequest(`/schedule/${companyId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to update schedule: HTTP ${response.status} - ${errorText}`);
        }
        const result = (await response.json());
        if (!result.success || !result.data) {
            throw new Error(result.meta?.message || 'Failed to update schedule: Invalid response');
        }
        return result.data;
    }
    /**
     * Delete employee schedule for a specific date (B2B API, requires user auth)
     * DELETE /schedule/{company_id}/{staff_id}/{date}
     */
    async deleteSchedule(companyId, staffId, date) {
        if (!this.userToken) {
            throw new Error('Not authenticated. Use login() first.');
        }
        const response = await this.apiRequest(`/schedule/${companyId}/${staffId}/${date}`, {
            method: 'DELETE',
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to delete schedule: HTTP ${response.status} - ${errorText}`);
        }
    }
    // ========== Staff CRUD Operations ==========
    async createStaff(companyId, data) {
        if (!this.userToken) {
            throw new Error('Not authenticated. Use login() first.');
        }
        const response = await this.apiRequest(`/company/${companyId}/staff/quick`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to create staff: HTTP ${response.status} - ${errorText}`);
        }
        const result = (await response.json());
        if (!result.success || !result.data) {
            throw new Error('Failed to create staff: Invalid response');
        }
        return result.data;
    }
    async updateStaff(companyId, staffId, data) {
        if (!this.userToken) {
            throw new Error('Not authenticated. Use login() first.');
        }
        const response = await this.apiRequest(`/staff/${companyId}/${staffId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to update staff: HTTP ${response.status} - ${errorText}`);
        }
        const result = (await response.json());
        if (!result.success || !result.data) {
            throw new Error('Failed to update staff: Invalid response');
        }
        return result.data;
    }
    async deleteStaff(companyId, staffId) {
        if (!this.userToken) {
            throw new Error('Not authenticated. Use login() first.');
        }
        const response = await this.apiRequest(`/staff/${companyId}/${staffId}`, {
            method: 'DELETE',
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to delete staff: HTTP ${response.status} - ${errorText}`);
        }
    }
    // ========== Services CRUD Operations ==========
    async createService(companyId, data) {
        if (!this.userToken) {
            throw new Error('Not authenticated. Use login() first.');
        }
        const response = await this.apiRequest(`/services/${companyId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to create service: HTTP ${response.status} - ${errorText}`);
        }
        const result = (await response.json());
        if (!result.success || !result.data) {
            throw new Error('Failed to create service: Invalid response');
        }
        return result.data;
    }
    async updateService(companyId, serviceId, data) {
        if (!this.userToken) {
            throw new Error('Not authenticated. Use login() first.');
        }
        const response = await this.apiRequest(`/services/${companyId}/services/${serviceId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to update service: HTTP ${response.status} - ${errorText}`);
        }
        const result = (await response.json());
        if (!result.success || !result.data) {
            throw new Error('Failed to update service: Invalid response');
        }
        return result.data;
    }
    // ========== Positions CRUD Operations ==========
    async createPosition(companyId, data) {
        if (!this.userToken) {
            throw new Error('Not authenticated. Use login() first.');
        }
        const response = await this.apiRequest(`/positions/${companyId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to create position: HTTP ${response.status} - ${errorText}`);
        }
        const result = (await response.json());
        if (!result.success || !result.data) {
            throw new Error('Failed to create position: Invalid response');
        }
        return result.data;
    }
    async updatePosition(companyId, positionId, data) {
        if (!this.userToken) {
            throw new Error('Not authenticated. Use login() first.');
        }
        const response = await this.apiRequest(`/positions/${companyId}/${positionId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to update position: HTTP ${response.status} - ${errorText}`);
        }
        const result = (await response.json());
        if (!result.success || !result.data) {
            throw new Error('Failed to update position: Invalid response');
        }
        return result.data;
    }
    async deletePosition(companyId, positionId) {
        if (!this.userToken) {
            throw new Error('Not authenticated. Use login() first.');
        }
        const response = await this.apiRequest(`/positions/${companyId}/${positionId}`, {
            method: 'DELETE',
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to delete position: HTTP ${response.status} - ${errorText}`);
        }
    }
    // ========== Bookings CRUD Operations ==========
    async createBooking(companyId, data) {
        if (!this.userToken) {
            throw new Error('Not authenticated. Use login() first.');
        }
        const response = await this.apiRequest(`/records/${companyId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to create booking: HTTP ${response.status} - ${errorText}`);
        }
        const result = (await response.json());
        if (!result.success || !result.data) {
            throw new Error('Failed to create booking: Invalid response');
        }
        return result.data;
    }
    async updateBooking(companyId, recordId, data) {
        if (!this.userToken) {
            throw new Error('Not authenticated. Use login() first.');
        }
        const response = await this.apiRequest(`/record/${companyId}/${recordId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to update booking: HTTP ${response.status} - ${errorText}`);
        }
        const result = (await response.json());
        if (!result.success || !result.data) {
            throw new Error('Failed to update booking: Invalid response');
        }
        return result.data;
    }
    async deleteBooking(companyId, recordId) {
        if (!this.userToken) {
            throw new Error('Not authenticated. Use login() first.');
        }
        const response = await this.apiRequest(`/record/${companyId}/${recordId}`, {
            method: 'DELETE',
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to delete booking: HTTP ${response.status} - ${errorText}`);
        }
    }
    // ========== Clients CRUD Operations ==========
    async createClient(companyId, data) {
        if (!this.userToken) {
            throw new Error('Not authenticated. Use login() first.');
        }
        const response = await this.apiRequest(`/clients/${companyId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to create client: HTTP ${response.status} - ${errorText}`);
        }
        const result = (await response.json());
        if (!result.success || !result.data) {
            throw new Error('Failed to create client: Invalid response');
        }
        return result.data;
    }
    // ========== Service Categories CRUD Operations ==========
    async createServiceCategory(companyId, data) {
        if (!this.userToken) {
            throw new Error('Not authenticated. Use login() first.');
        }
        const response = await this.apiRequest(`/service_categories/${companyId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to create category: HTTP ${response.status} - ${errorText}`);
        }
        const result = (await response.json());
        if (!result.success || !result.data) {
            throw new Error('Failed to create category: Invalid response');
        }
        return result.data;
    }
    isAuthenticated() {
        return !!this.userToken;
    }
}
//# sourceMappingURL=altegio-client.js.map