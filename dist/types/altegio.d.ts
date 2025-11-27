export interface AltegioConfig {
    apiUrl?: string;
    apiBase?: string;
    partnerToken: string;
    userToken?: string;
    timeout?: number;
    retryConfig?: {
        maxAttempts: number;
        initialDelay: number;
        maxDelay: number;
    };
    rateLimit?: {
        requests: number;
        windowMs: number;
    };
}
export interface AltegioResponse<T> {
    success: boolean;
    data: T;
    meta?: {
        message?: string;
        [key: string]: any;
    };
}
export interface LoginData {
    user_token: string;
}
export interface LoginResponse {
    success: boolean;
    user_token?: string;
    error?: string;
}
export interface Company {
    id: number;
    title: string;
    address?: string;
    phone?: string;
}
export interface Booking {
    id: number;
    datetime: string;
    client: {
        name: string;
        phone?: string;
    };
    services: Array<{
        id: number;
        title: string;
        cost: number;
    }>;
    staff?: {
        id: number;
        name: string;
    };
}
//# sourceMappingURL=altegio.d.ts.map