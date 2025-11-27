/**
 * MCP Tools Registration
 */
/**
 * Register all Altegio tools with the MCP server
 */
export function registerTools(server, client) {
    const tools = [
        // Authentication
        {
            name: 'altegio_login',
            description: 'Login to Altegio with email and password to get user token. Use this first if not authenticated.',
            inputSchema: {
                type: 'object',
                properties: {
                    email: {
                        type: 'string',
                        description: 'Altegio account email',
                    },
                    password: {
                        type: 'string',
                        description: 'Altegio account password',
                    },
                },
                required: ['email', 'password'],
            },
        },
        {
            name: 'altegio_logout',
            description: 'Logout from Altegio and clear saved credentials',
            inputSchema: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
        // Companies
        {
            name: 'list_companies',
            description: 'Get list of companies available to the authenticated user. Use this first to get company IDs.',
            inputSchema: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
        {
            name: 'get_company',
            description: 'Get detailed information about a specific company',
            inputSchema: {
                type: 'object',
                properties: {
                    company_id: {
                        type: 'number',
                        description: 'Company ID',
                    },
                },
                required: ['company_id'],
            },
        },
        // Bookings
        {
            name: 'list_bookings',
            description: 'List bookings/records for a company. Returns appointments with client, service, staff details.',
            inputSchema: {
                type: 'object',
                properties: {
                    company_id: {
                        type: 'number',
                        description: 'Company ID',
                    },
                    start_date: {
                        type: 'string',
                        description: 'Start date in YYYY-MM-DD format (optional)',
                    },
                    end_date: {
                        type: 'string',
                        description: 'End date in YYYY-MM-DD format (optional)',
                    },
                    page: {
                        type: 'number',
                        description: 'Page number for pagination (default: 1)',
                    },
                    count: {
                        type: 'number',
                        description: 'Number of records per page (default: 50, max: 300)',
                    },
                },
                required: ['company_id'],
            },
        },
        {
            name: 'get_booking',
            description: 'Get detailed information about a specific booking by ID',
            inputSchema: {
                type: 'object',
                properties: {
                    company_id: {
                        type: 'number',
                        description: 'Company ID',
                    },
                    record_id: {
                        type: 'number',
                        description: 'Record/booking ID',
                    },
                },
                required: ['company_id', 'record_id'],
            },
        },
    ];
    // Register each tool with its handler
    for (const tool of tools) {
        server.registerTool(tool, async (args) => {
            return await handleTool(tool.name, args, client);
        });
    }
}
/**
 * Central tool handler that routes to appropriate client methods
 */
async function handleTool(toolName, args, client) {
    switch (toolName) {
        // Authentication
        case 'altegio_login': {
            const { email, password } = args;
            return await client.login(email, password);
        }
        case 'altegio_logout': {
            return await client.logout();
        }
        // Companies
        case 'list_companies': {
            return await client.getCompanies();
        }
        case 'get_company': {
            const { company_id } = args;
            return await client.getCompany(company_id);
        }
        // Bookings
        case 'list_bookings': {
            const { company_id, start_date, end_date, page, count } = args;
            const params = {};
            if (start_date)
                params.start_date = start_date;
            if (end_date)
                params.end_date = end_date;
            if (page)
                params.page = page;
            if (count)
                params.count = count;
            return await client.getBookings(company_id, params);
        }
        case 'get_booking': {
            const { company_id, record_id } = args;
            return await client.getBooking(company_id, record_id);
        }
        default:
            throw new Error(`Unknown tool: ${toolName}`);
    }
}
//# sourceMappingURL=index.js.map