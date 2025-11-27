import { AltegioClient } from '../providers/altegio-client.js';
export declare class ToolHandlers {
    private client;
    constructor(client: AltegioClient);
    login(args: unknown): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    logout(): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    listCompanies(args?: unknown): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    getBookings(args: unknown): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    getStaff(args: unknown): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    getServices(args: unknown): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    getServiceCategories(args: unknown): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    getSchedule(args: unknown): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    createSchedule(args: unknown): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
        isError?: undefined;
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        isError: boolean;
    }>;
    updateSchedule(args: unknown): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
        isError?: undefined;
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        isError: boolean;
    }>;
    deleteSchedule(args: unknown): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
        isError?: undefined;
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        isError: boolean;
    }>;
    createStaff(args: unknown): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    updateStaff(args: unknown): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    deleteStaff(args: unknown): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    createService(args: unknown): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    updateService(args: unknown): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    getPositions(args: unknown): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
        isError?: undefined;
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        isError: boolean;
    }>;
    createPosition(args: unknown): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
        isError?: undefined;
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        isError: boolean;
    }>;
    updatePosition(args: unknown): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
        isError?: undefined;
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        isError: boolean;
    }>;
    deletePosition(args: unknown): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
        isError?: undefined;
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        isError: boolean;
    }>;
    createBooking(args: unknown): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    updateBooking(args: unknown): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    deleteBooking(args: unknown): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
}
//# sourceMappingURL=handlers.d.ts.map