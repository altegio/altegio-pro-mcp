/**
 * MCP Prompts Registration
 */
/**
 * Register all Altegio prompts with the MCP server
 */
export function registerPrompts(server, client) {
    const prompts = [
        {
            name: 'altegio_setup',
            description: 'Guide user through initial setup: authentication and company selection',
            arguments: [],
        },
        {
            name: 'altegio_get_bookings',
            description: 'Guide user through retrieving bookings for a specific company and date range',
            arguments: [
                {
                    name: 'company_id',
                    description: 'Company ID (optional - will prompt user if not provided)',
                    required: false,
                },
            ],
        },
    ];
    // Register each prompt with its handler
    for (const prompt of prompts) {
        server.registerPrompt(prompt, async (args) => {
            return await handlePrompt(prompt.name, args, client);
        });
    }
}
/**
 * Central prompt handler that routes to appropriate handlers
 */
async function handlePrompt(promptName, args, client) {
    switch (promptName) {
        case 'altegio_setup':
            return await handleSetupPrompt(client);
        case 'altegio_get_bookings':
            return await handleGetBookingsPrompt(args, client);
        default:
            throw new Error(`Unknown prompt: ${promptName}`);
    }
}
/**
 * Setup prompt handler - guides user through authentication and company selection
 */
async function handleSetupPrompt(client) {
    const isAuthenticated = client.isAuthenticated();
    if (!isAuthenticated) {
        return [
            {
                role: 'user',
                content: {
                    type: 'text',
                    text: 'I need to set up Altegio integration for my business.',
                },
            },
            {
                role: 'assistant',
                content: {
                    type: 'text',
                    text: `I'll help you set up Altegio integration! Let's start by authenticating your account.

**Step 1: Authentication**

I need your Altegio account credentials to access your data:
- Your Altegio email address
- Your Altegio password

Once authenticated, your credentials will be securely saved locally, and you won't need to provide them again.

Please provide your credentials using the \`altegio_login\` tool, or I can ask you for them now.`,
                },
            },
        ];
    }
    // User is authenticated, help select company
    try {
        const companiesData = await client.getCompanies();
        const companies = Array.isArray(companiesData.data)
            ? companiesData.data
            : [];
        if (companies.length === 0) {
            return [
                {
                    role: 'assistant',
                    content: {
                        type: 'text',
                        text: "✅ You are already authenticated!\n\nHowever, I couldn't find any companies associated with your account. Please check with Altegio support.",
                    },
                },
            ];
        }
        const activeCompanies = companies.filter((c) => c.active === 1);
        const companyList = activeCompanies
            .slice(0, 10)
            .map((c, i) => `${i + 1}. **${c.title}** (ID: ${c.id}) - ${c.city}, ${c.country}`)
            .join('\n');
        return [
            {
                role: 'assistant',
                content: {
                    type: 'text',
                    text: `✅ You are already authenticated!

**Step 2: Select Your Company**

I found ${activeCompanies.length} active compan${activeCompanies.length === 1 ? 'y' : 'ies'} in your account:

${companyList}
${activeCompanies.length > 10 ? `\n... and ${activeCompanies.length - 10} more companies` : ''}

Which company would you like to work with? Please tell me the company name or ID, and I'll help you:
- View bookings and appointments
- Manage client records
- Access company information
- And more!`,
                },
            },
        ];
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return [
            {
                role: 'assistant',
                content: {
                    type: 'text',
                    text: `✅ You are authenticated, but I encountered an error loading your companies: ${errorMessage}

Please try again or check your connection.`,
                },
            },
        ];
    }
}
/**
 * Get bookings prompt handler - guides user through retrieving bookings
 */
async function handleGetBookingsPrompt(args, client) {
    if (!client.isAuthenticated()) {
        return [
            {
                role: 'assistant',
                content: {
                    type: 'text',
                    text: '❌ You need to authenticate first. Please use the `altegio_setup` prompt or `altegio_login` tool to get started.',
                },
            },
        ];
    }
    const companyId = args.company_id;
    if (companyId) {
        return [
            {
                role: 'assistant',
                content: {
                    type: 'text',
                    text: `I'll help you retrieve bookings for company ID ${companyId}.

What date range would you like to see?
- Today's bookings
- This week
- Specific date range (please provide start and end dates in YYYY-MM-DD format)

I'll use the \`list_bookings\` tool to fetch the data.`,
                },
            },
        ];
    }
    // No company_id provided, help user select one
    try {
        const companiesData = await client.getCompanies();
        const companies = Array.isArray(companiesData.data)
            ? companiesData.data
            : [];
        const activeCompanies = companies.filter((c) => c.active === 1);
        const companyList = activeCompanies
            .slice(0, 10)
            .map((c, i) => `${i + 1}. **${c.title}** (ID: ${c.id}) - ${c.city}, ${c.country}`)
            .join('\n');
        return [
            {
                role: 'assistant',
                content: {
                    type: 'text',
                    text: `I'll help you retrieve bookings. First, which company?

${companyList}
${activeCompanies.length > 10 ? `\n... and ${activeCompanies.length - 10} more companies` : ''}

Please tell me the company ID or name, and then specify the date range you'd like to see.`,
                },
            },
        ];
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return [
            {
                role: 'assistant',
                content: {
                    type: 'text',
                    text: `Error loading companies: ${errorMessage}\n\nIf you know your company ID, you can provide it directly and I'll fetch the bookings.`,
                },
            },
        ];
    }
}
//# sourceMappingURL=index.js.map