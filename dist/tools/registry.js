import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode, } from '@modelcontextprotocol/sdk/types.js';
import { ToolHandlers } from './handlers.js';
import { OnboardingHandlers } from './onboarding-handlers.js';
import { OnboardingStateManager } from '../providers/onboarding-state-manager.js';
import { onboardingTools } from './onboarding-registry.js';
const tools = [
    {
        name: 'altegio_login',
        description: '[Auth] Login to Altegio with email and password. REQUIRED for administrative operations: getting user companies (list_companies with my=1), viewing bookings, and other business management tasks. Ask user for credentials when they request administrative data.',
        inputSchema: {
            type: 'object',
            properties: {
                email: { type: 'string', format: 'email' },
                password: { type: 'string' },
            },
            required: ['email', 'password'],
        },
    },
    {
        name: 'altegio_logout',
        description: '[Auth] Logout from Altegio and clear stored credentials.',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
    {
        name: 'list_companies',
        description: '[Company] Get list of companies. AUTHENTICATION REQUIRED when my=1 (to get companies user manages). PUBLIC when my=0 or omitted (all companies). If user asks about "their" or "my" companies, use my=1 and ensure user is logged in first. After getting user companies, ask which company they want to work with if not specified. PAGINATION STRATEGY: Default returns 200 companies (can overwhelm context). RECOMMENDED: Start with count=20-50 for initial results. Show user first batch, ask if they need more or can identify their company. Only increase count if user explicitly needs full list. Maximum count=300. Use page parameter to fetch next batches. This approach saves context and computation.',
        inputSchema: {
            type: 'object',
            properties: {
                my: {
                    type: 'number',
                    description: 'Set to 1 to get only companies user has admin access to (REQUIRES LOGIN). Omit or set to 0 for public list of all companies (no login needed).',
                    enum: [0, 1],
                },
                page: {
                    type: 'number',
                    description: 'Page number for pagination (starts at 0). Use to fetch subsequent pages when user needs more results.',
                },
                count: {
                    type: 'number',
                    description: 'Results per page. Default 200 (overwhelming). RECOMMENDED: Use 20-50 for user companies (my=1), 50-100 for public searches. Only use 200+ if user explicitly requests complete list. Max 300.',
                },
            },
        },
    },
    {
        name: 'get_bookings',
        description: '[Bookings] Get bookings for a company. AUTHENTICATION REQUIRED - this is administrative data. User must be logged in and have access to the company. If company_id not known, first call list_companies with my=1 to get user companies, then ask user to choose one. PAGINATION STRATEGY: Default may return many bookings. RECOMMENDED: Start with count=20-50 for recent bookings. Use start_date/end_date to filter by date range. Show first batch to user, fetch more only if needed. This saves context and computation.',
        inputSchema: {
            type: 'object',
            properties: {
                company_id: {
                    type: 'number',
                    description: 'ID of the company to get bookings for',
                },
                page: {
                    type: 'number',
                    description: 'Page number for pagination (starts at 0). Use to fetch subsequent pages when user needs more results.',
                },
                count: {
                    type: 'number',
                    description: 'Results per page. Default may be large. RECOMMENDED: Use 20-50 for initial requests. Only increase if user explicitly requests more. Max 300.',
                },
                start_date: {
                    type: 'string',
                    description: 'Filter bookings from this date (YYYY-MM-DD format). Use to reduce result set.',
                },
                end_date: {
                    type: 'string',
                    description: 'Filter bookings until this date (YYYY-MM-DD format). Use to reduce result set.',
                },
            },
            required: ['company_id'],
        },
    },
    {
        name: 'get_staff',
        description: '[Staff] Get list of staff members for a company. AUTHENTICATION REQUIRED - administrative access to view all staff with full details (not just public booking info). User must be logged in and have access to the company. PAGINATION STRATEGY: May return many staff (100+). RECOMMENDED: Start with count=30-50 to show initial options. User can browse and request more if needed. This saves context for large salons.',
        inputSchema: {
            type: 'object',
            properties: {
                company_id: {
                    type: 'number',
                    description: 'ID of the company to get staff list for',
                },
                page: {
                    type: 'number',
                    description: 'Page number for pagination (starts at 0). Use to fetch subsequent pages when user needs more results.',
                },
                count: {
                    type: 'number',
                    description: 'Results per page. Default may be large. RECOMMENDED: Use 30-50 for initial display. Max 300.',
                },
            },
            required: ['company_id'],
        },
    },
    {
        name: 'get_services',
        description: '[Services] Get list of services available at a company. AUTHENTICATION REQUIRED - administrative access to view all services with full pricing, settings, and configuration (not just public booking info). User must be logged in and have access to the company. PAGINATION STRATEGY: May return many services (50+). RECOMMENDED: Start with count=30-50 to show main services. User can request more or use categories for better organization.',
        inputSchema: {
            type: 'object',
            properties: {
                company_id: {
                    type: 'number',
                    description: 'ID of the company to get services for',
                },
                page: {
                    type: 'number',
                    description: 'Page number for pagination (starts at 0). Use to fetch subsequent pages when user needs more results.',
                },
                count: {
                    type: 'number',
                    description: 'Results per page. Default may be large. RECOMMENDED: Use 30-50 for initial display. Max 300.',
                },
            },
            required: ['company_id'],
        },
    },
    {
        name: 'get_service_categories',
        description: '[Categories] Get list of service categories at a company. PUBLIC API - NO AUTHENTICATION REQUIRED. Use this for online booking - shows how services are organized. PAGINATION STRATEGY: May return many categories (20+). RECOMMENDED: Start with count=20-30. Categories help organize services, so showing initial set is usually sufficient.',
        inputSchema: {
            type: 'object',
            properties: {
                company_id: {
                    type: 'number',
                    description: 'ID of the company to get service categories for',
                },
                page: {
                    type: 'number',
                    description: 'Page number for pagination (starts at 0). Use to fetch subsequent pages when user needs more results.',
                },
                count: {
                    type: 'number',
                    description: 'Results per page. Default may be large. RECOMMENDED: Use 20-30 for initial display. Max 300.',
                },
            },
            required: ['company_id'],
        },
    },
    {
        name: 'get_schedule',
        description: '[Schedule] Get employee schedule for a date range. AUTHENTICATION REQUIRED - administrative access to view staff working schedule. User must be logged in and have access to the company. Returns schedule entries with dates, times, and session lengths.',
        inputSchema: {
            type: 'object',
            properties: {
                company_id: { type: 'number', description: 'ID of the company' },
                staff_id: { type: 'number', description: 'ID of the staff member' },
                start_date: {
                    type: 'string',
                    description: 'Start date (YYYY-MM-DD format)',
                },
                end_date: {
                    type: 'string',
                    description: 'End date (YYYY-MM-DD format)',
                },
            },
            required: ['company_id', 'staff_id', 'start_date', 'end_date'],
        },
    },
    {
        name: 'create_schedule',
        description: '[Schedule] Create employee work schedule. AUTHENTICATION REQUIRED - administrative access to create staff working schedule. Defines when an employee is available to work (e.g., "Monday 9:00-18:00"). Use this to set up or modify work hours.',
        inputSchema: {
            type: 'object',
            properties: {
                company_id: { type: 'number', description: 'ID of the company' },
                staff_id: { type: 'number', description: 'ID of the staff member' },
                date: {
                    type: 'string',
                    description: 'Date for the schedule (YYYY-MM-DD format)',
                },
                time_from: {
                    type: 'string',
                    description: 'Start time (HH:MM format, e.g., "09:00")',
                },
                time_to: {
                    type: 'string',
                    description: 'End time (HH:MM format, e.g., "18:00")',
                },
                seance_length: {
                    type: 'number',
                    description: 'Session length in minutes (optional)',
                },
            },
            required: ['company_id', 'staff_id', 'date', 'time_from', 'time_to'],
        },
    },
    {
        name: 'update_schedule',
        description: '[Schedule] Update employee work schedule. AUTHENTICATION REQUIRED - administrative access to modify staff working schedule. Updates existing work hours for a specific date.',
        inputSchema: {
            type: 'object',
            properties: {
                company_id: { type: 'number', description: 'ID of the company' },
                staff_id: { type: 'number', description: 'ID of the staff member' },
                date: {
                    type: 'string',
                    description: 'Date for the schedule (YYYY-MM-DD format)',
                },
                time_from: {
                    type: 'string',
                    description: 'New start time (HH:MM format, e.g., "09:00")',
                },
                time_to: {
                    type: 'string',
                    description: 'New end time (HH:MM format, e.g., "18:00")',
                },
                seance_length: {
                    type: 'number',
                    description: 'Session length in minutes (optional)',
                },
            },
            required: ['company_id', 'staff_id', 'date'],
        },
    },
    {
        name: 'delete_schedule',
        description: '[Schedule] Delete employee work schedule for a specific date. AUTHENTICATION REQUIRED - administrative access to remove staff working schedule. Removes work hours for the specified date.',
        inputSchema: {
            type: 'object',
            properties: {
                company_id: { type: 'number', description: 'ID of the company' },
                staff_id: { type: 'number', description: 'ID of the staff member' },
                date: {
                    type: 'string',
                    description: 'Date to delete schedule (YYYY-MM-DD format)',
                },
            },
            required: ['company_id', 'staff_id', 'date'],
        },
    },
    {
        name: 'get_positions',
        description: '[Positions] Get list of positions in company. AUTHENTICATION REQUIRED. Returns all available positions that can be assigned to staff members.',
        inputSchema: {
            type: 'object',
            properties: {
                company_id: { type: 'number', description: 'Company ID' },
            },
            required: ['company_id'],
        },
    },
    {
        name: 'create_position',
        description: '[Positions] Create a new position. AUTHENTICATION REQUIRED. Positions are used to categorize staff roles (e.g., "Manager", "Stylist", "Receptionist").',
        inputSchema: {
            type: 'object',
            properties: {
                company_id: { type: 'number', description: 'Company ID' },
                title: { type: 'string', description: 'Position title' },
                api_id: { type: 'string', description: 'External API ID (optional)' },
            },
            required: ['company_id', 'title'],
        },
    },
    {
        name: 'update_position',
        description: '[Positions] Update existing position. AUTHENTICATION REQUIRED. Modify position title or external ID.',
        inputSchema: {
            type: 'object',
            properties: {
                company_id: { type: 'number', description: 'Company ID' },
                position_id: { type: 'number', description: 'Position ID' },
                title: { type: 'string', description: 'New position title' },
                api_id: { type: 'string', description: 'External API ID (optional)' },
            },
            required: ['company_id', 'position_id'],
        },
    },
    {
        name: 'delete_position',
        description: '[Positions] Delete position. AUTHENTICATION REQUIRED. Note: Cannot delete positions that are assigned to staff members.',
        inputSchema: {
            type: 'object',
            properties: {
                company_id: { type: 'number', description: 'Company ID' },
                position_id: { type: 'number', description: 'Position ID to delete' },
            },
            required: ['company_id', 'position_id'],
        },
    },
    {
        name: 'create_staff',
        description: '[Staff] Create a new employee/staff member. AUTHENTICATION REQUIRED. Required fields: name, specialization, position_id, phone_number, user_email, user_phone, is_user_invite.',
        inputSchema: {
            type: 'object',
            properties: {
                company_id: { type: 'number', description: 'Company ID' },
                name: { type: 'string', description: 'Employee name' },
                specialization: { type: 'string', description: 'Employee specialization' },
                position_id: {
                    type: 'number',
                    description: 'Position ID',
                    nullable: true,
                },
                phone_number: {
                    type: 'string',
                    description: 'Phone number (without +, 9-15 digits)',
                    nullable: true,
                },
                user_email: {
                    type: 'string',
                    description: 'User email address',
                },
                user_phone: {
                    type: 'string',
                    description: 'User phone number',
                },
                is_user_invite: {
                    type: 'boolean',
                    description: 'User invitation flag',
                },
            },
            required: ['company_id', 'name', 'specialization', 'position_id', 'phone_number', 'user_email', 'user_phone', 'is_user_invite'],
        },
    },
    {
        name: 'update_staff',
        description: '[Staff] Update existing employee/staff member. AUTHENTICATION REQUIRED. Provide only fields to update.',
        inputSchema: {
            type: 'object',
            properties: {
                company_id: { type: 'number', description: 'Company ID' },
                staff_id: { type: 'number', description: 'Staff member ID' },
                name: { type: 'string', description: 'Employee name' },
                specialization: { type: 'string', description: 'Employee specialization' },
                position_id: { type: 'number', description: 'Position ID', nullable: true },
                phone_number: { type: 'string', description: 'Phone number', nullable: true },
                hidden: { type: 'number', description: '0 or 1' },
                fired: { type: 'number', description: '0 or 1' },
            },
            required: ['company_id', 'staff_id'],
        },
    },
    {
        name: 'delete_staff',
        description: '[Staff] Delete/remove employee/staff member. AUTHENTICATION REQUIRED.',
        inputSchema: {
            type: 'object',
            properties: {
                company_id: { type: 'number', description: 'Company ID' },
                staff_id: { type: 'number', description: 'Staff member ID to delete' },
            },
            required: ['company_id', 'staff_id'],
        },
    },
    {
        name: 'create_service',
        description: '[Services] Create a new service. AUTHENTICATION REQUIRED. Required fields: title, category_id.',
        inputSchema: {
            type: 'object',
            properties: {
                company_id: { type: 'number', description: 'Company ID' },
                title: { type: 'string', description: 'Service title' },
                category_id: { type: 'number', description: 'Service category ID' },
                price_min: { type: 'number', description: 'Minimum price' },
                price_max: { type: 'number', description: 'Maximum price' },
                discount: { type: 'number', description: 'Discount percentage' },
                comment: { type: 'string', description: 'Service description' },
                duration: { type: 'number', description: 'Duration in seconds' },
                prepaid: { type: 'string', description: 'Prepaid option' },
            },
            required: ['company_id', 'title', 'category_id'],
        },
    },
    {
        name: 'update_service',
        description: '[Services] Update existing service. AUTHENTICATION REQUIRED. Provide only fields to update.',
        inputSchema: {
            type: 'object',
            properties: {
                company_id: { type: 'number', description: 'Company ID' },
                service_id: { type: 'number', description: 'Service ID' },
                title: { type: 'string', description: 'Service title' },
                category_id: { type: 'number', description: 'Service category ID' },
                price_min: { type: 'number', description: 'Minimum price' },
                price_max: { type: 'number', description: 'Maximum price' },
                discount: { type: 'number', description: 'Discount percentage' },
                comment: { type: 'string', description: 'Service description' },
                duration: { type: 'number', description: 'Duration in seconds' },
                active: { type: 'number', description: '0 or 1' },
            },
            required: ['company_id', 'service_id'],
        },
    },
    {
        name: 'create_booking',
        description: '[Bookings] Create a new client booking/appointment. AUTHENTICATION REQUIRED. Required fields: staff_id, services, datetime, client info.',
        inputSchema: {
            type: 'object',
            properties: {
                company_id: { type: 'number', description: 'Company ID' },
                staff_id: { type: 'number', description: 'Staff member ID' },
                services: {
                    type: 'array',
                    description: 'Array of service objects',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'number', description: 'Service ID' },
                            amount: { type: 'number', description: 'Amount/quantity' },
                        },
                        required: ['id'],
                    },
                },
                datetime: {
                    type: 'string',
                    description: 'Booking datetime (ISO format: YYYY-MM-DDTHH:MM:SS)',
                },
                seance_length: { type: 'number', description: 'Session length in seconds' },
                client: {
                    type: 'object',
                    description: 'Client information',
                    properties: {
                        name: { type: 'string', description: 'Client name' },
                        phone: { type: 'string', description: 'Client phone' },
                        email: { type: 'string', description: 'Client email' },
                    },
                    required: ['name', 'phone'],
                },
                comment: { type: 'string', description: 'Booking comment' },
                send_sms: { type: 'number', description: 'Send SMS reminder (0 or 1)' },
                attendance: { type: 'number', description: 'Attendance status' },
            },
            required: ['company_id', 'staff_id', 'services', 'datetime', 'client'],
        },
    },
    {
        name: 'update_booking',
        description: '[Bookings] Update existing booking/appointment. AUTHENTICATION REQUIRED. Provide only fields to update.',
        inputSchema: {
            type: 'object',
            properties: {
                company_id: { type: 'number', description: 'Company ID' },
                record_id: { type: 'number', description: 'Booking/record ID' },
                staff_id: { type: 'number', description: 'Staff member ID' },
                services: {
                    type: 'array',
                    description: 'Array of service objects',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'number', description: 'Service ID' },
                            amount: { type: 'number', description: 'Amount/quantity' },
                        },
                    },
                },
                datetime: { type: 'string', description: 'New booking datetime' },
                seance_length: { type: 'number', description: 'Session length in seconds' },
                client: {
                    type: 'object',
                    description: 'Client information',
                    properties: {
                        name: { type: 'string', description: 'Client name' },
                        phone: { type: 'string', description: 'Client phone' },
                        email: { type: 'string', description: 'Client email' },
                    },
                },
                comment: { type: 'string', description: 'Booking comment' },
                attendance: { type: 'number', description: 'Attendance status' },
            },
            required: ['company_id', 'record_id'],
        },
    },
    {
        name: 'delete_booking',
        description: '[Bookings] Delete/cancel booking/appointment. AUTHENTICATION REQUIRED.',
        inputSchema: {
            type: 'object',
            properties: {
                company_id: { type: 'number', description: 'Company ID' },
                record_id: { type: 'number', description: 'Booking/record ID to delete' },
            },
            required: ['company_id', 'record_id'],
        },
    },
];
export function registerTools(server, client) {
    const handlers = new ToolHandlers(client);
    const stateManager = new OnboardingStateManager();
    const onboardingHandlers = new OnboardingHandlers(client, stateManager);
    // Combine all tools
    const allTools = [...tools, ...onboardingTools];
    // Register list handler
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: allTools.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
            })),
        };
    });
    // Register call handler
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        try {
            switch (name) {
                case 'altegio_login':
                    return await handlers.login(args);
                case 'altegio_logout':
                    return await handlers.logout();
                case 'list_companies':
                    return await handlers.listCompanies(args);
                case 'get_bookings':
                    return await handlers.getBookings(args);
                case 'get_staff':
                    return await handlers.getStaff(args);
                case 'get_services':
                    return await handlers.getServices(args);
                case 'get_service_categories':
                    return await handlers.getServiceCategories(args);
                case 'get_schedule':
                    return await handlers.getSchedule(args);
                case 'create_schedule':
                    return await handlers.createSchedule(args);
                case 'update_schedule':
                    return await handlers.updateSchedule(args);
                case 'delete_schedule':
                    return await handlers.deleteSchedule(args);
                case 'get_positions':
                    return await handlers.getPositions(args);
                case 'create_position':
                    return await handlers.createPosition(args);
                case 'update_position':
                    return await handlers.updatePosition(args);
                case 'delete_position':
                    return await handlers.deletePosition(args);
                case 'create_staff':
                    return await handlers.createStaff(args);
                case 'update_staff':
                    return await handlers.updateStaff(args);
                case 'delete_staff':
                    return await handlers.deleteStaff(args);
                case 'create_service':
                    return await handlers.createService(args);
                case 'update_service':
                    return await handlers.updateService(args);
                case 'create_booking':
                    return await handlers.createBooking(args);
                case 'update_booking':
                    return await handlers.updateBooking(args);
                case 'delete_booking':
                    return await handlers.deleteBooking(args);
                // Onboarding tools
                case 'onboarding_start':
                    return await onboardingHandlers.start(args);
                case 'onboarding_resume':
                    return await onboardingHandlers.resume(args);
                case 'onboarding_status':
                    return await onboardingHandlers.status(args);
                case 'onboarding_add_staff_batch':
                    return await onboardingHandlers.addStaffBatch(args);
                case 'onboarding_add_services_batch':
                    return await onboardingHandlers.addServicesBatch(args);
                case 'onboarding_add_categories':
                    return await onboardingHandlers.addCategories(args);
                case 'onboarding_import_clients':
                    return await onboardingHandlers.importClients(args);
                case 'onboarding_create_test_bookings':
                    return await onboardingHandlers.createTestBookings(args);
                case 'onboarding_preview_data':
                    return await onboardingHandlers.previewData(args);
                case 'onboarding_rollback_phase':
                    return await onboardingHandlers.rollbackPhase(args);
                default:
                    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
            }
        }
        catch (error) {
            if (error instanceof McpError) {
                throw error;
            }
            throw new McpError(ErrorCode.InternalError, error instanceof Error ? error.message : 'Unknown error');
        }
    });
    return allTools.map((t) => t.name);
}
//# sourceMappingURL=registry.js.map