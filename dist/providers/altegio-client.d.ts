import type { AltegioConfig, AltegioCompany, AltegioBooking, AltegioStaff, AltegioService, AltegioServiceCategory, AltegioPosition, AltegioScheduleEntry, AltegioBookingParams, AltegioCompaniesParams, AltegioListParams } from '../types/altegio.types.js';
export declare class AltegioClient {
    private apiUrl;
    private partnerToken;
    private userToken?;
    private credentials;
    constructor(config: AltegioConfig, credentialsDir?: string);
    private loadSavedCredentials;
    /**
     * Internal fetch wrapper with common headers
     */
    private apiRequest;
    login(email: string, password: string): Promise<{
        success: boolean;
        user_token?: string;
        error?: string;
    }>;
    logout(): Promise<{
        success: boolean;
    }>;
    getCompanies(params?: AltegioCompaniesParams): Promise<AltegioCompany[]>;
    getBookings(companyId: number, params?: AltegioListParams): Promise<AltegioBooking[]>;
    /**
     * Get staff for a company (B2B API, requires user auth)
     */
    getStaff(companyId: number, params?: AltegioBookingParams): Promise<AltegioStaff[]>;
    /**
     * Get services for booking (B2B API, requires user auth)
     */
    getServices(companyId: number, params?: AltegioBookingParams): Promise<AltegioService[]>;
    /**
     * Get service categories (public API, no user auth required)
     */
    getServiceCategories(companyId: number, params?: AltegioBookingParams): Promise<AltegioServiceCategory[]>;
    /**
     * Get company positions (B2B API, requires user auth)
     */
    getPositions(companyId: number): Promise<AltegioPosition[]>;
    /**
     * Get employee schedule for a date range (B2B API, requires user auth)
     */
    getSchedule(companyId: number, staffId: number, startDate: string, endDate: string): Promise<AltegioScheduleEntry[]>;
    /**
     * Create or update employee schedule (B2B API, requires user auth)
     * PUT /schedule/{company_id}
     */
    createSchedule(companyId: number, data: import('../types/altegio.types.js').CreateScheduleRequest): Promise<AltegioScheduleEntry[]>;
    /**
     * Update employee schedule (B2B API, requires user auth)
     * PUT /schedule/{company_id}
     */
    updateSchedule(companyId: number, data: import('../types/altegio.types.js').UpdateScheduleRequest): Promise<AltegioScheduleEntry[]>;
    /**
     * Delete employee schedule for a specific date (B2B API, requires user auth)
     * DELETE /schedule/{company_id}/{staff_id}/{date}
     */
    deleteSchedule(companyId: number, staffId: number, date: string): Promise<void>;
    createStaff(companyId: number, data: import('../types/altegio.types.js').CreateStaffRequest): Promise<AltegioStaff>;
    updateStaff(companyId: number, staffId: number, data: import('../types/altegio.types.js').UpdateStaffRequest): Promise<AltegioStaff>;
    deleteStaff(companyId: number, staffId: number): Promise<void>;
    createService(companyId: number, data: import('../types/altegio.types.js').CreateServiceRequest): Promise<AltegioService>;
    updateService(companyId: number, serviceId: number, data: import('../types/altegio.types.js').UpdateServiceRequest): Promise<AltegioService>;
    createPosition(companyId: number, data: import('../types/altegio.types.js').CreatePositionRequest): Promise<AltegioPosition>;
    updatePosition(companyId: number, positionId: number, data: import('../types/altegio.types.js').UpdatePositionRequest): Promise<AltegioPosition>;
    deletePosition(companyId: number, positionId: number): Promise<void>;
    createBooking(companyId: number, data: import('../types/altegio.types.js').CreateBookingRequest): Promise<AltegioBooking>;
    updateBooking(companyId: number, recordId: number, data: import('../types/altegio.types.js').UpdateBookingRequest): Promise<AltegioBooking>;
    deleteBooking(companyId: number, recordId: number): Promise<void>;
    createClient(companyId: number, data: import('../types/altegio.types.js').CreateClientRequest): Promise<import('../types/altegio.types.js').AltegioClientEntity>;
    createServiceCategory(companyId: number, data: import('../types/altegio.types.js').CreateCategoryRequest): Promise<AltegioServiceCategory>;
    isAuthenticated(): boolean;
}
//# sourceMappingURL=altegio-client.d.ts.map