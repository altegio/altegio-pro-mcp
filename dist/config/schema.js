/**
 * Configuration schema and validation using Zod
 */
import { z } from 'zod';
import { ConfigurationError } from '../utils/errors.js';
// Environment variables schema
export const EnvSchema = z.object({
    // Required
    ALTEGIO_API_TOKEN: z.string().min(1, 'Partner API token is required'),
    // Optional
    ALTEGIO_USER_TOKEN: z.string().optional(),
    ALTEGIO_API_BASE: z.string().url().default('https://api.alteg.io/api/v1'),
    // Server config
    NODE_ENV: z
        .enum(['development', 'production', 'test'])
        .default('development'),
    LOG_LEVEL: z
        .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
        .default('info'),
    // Credentials storage
    CREDENTIALS_DIR: z.string().optional(),
    // Rate limiting
    RATE_LIMIT_REQUESTS: z.coerce.number().min(1).default(200),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().min(1000).default(60000), // 1 minute
    // Retry config
    MAX_RETRY_ATTEMPTS: z.coerce.number().min(0).default(3),
    INITIAL_RETRY_DELAY_MS: z.coerce.number().min(100).default(1000),
    MAX_RETRY_DELAY_MS: z.coerce.number().min(1000).default(30000),
});
// MCP Server configuration
export const ServerConfigSchema = z.object({
    name: z.string().default('altegio-mcp-server'),
    version: z.string().default('1.0.0'),
    description: z.string().optional(),
    protocolVersion: z.string().default('2024-11-05'),
    capabilities: z
        .object({
        tools: z
            .object({
            listChanged: z.boolean().default(true),
        })
            .optional(),
        prompts: z
            .object({
            listChanged: z.boolean().default(true),
        })
            .optional(),
        resources: z
            .object({
            listChanged: z.boolean().default(true),
        })
            .optional(),
    })
        .default({
        tools: { listChanged: true },
        prompts: { listChanged: true },
    }),
});
// Altegio client configuration
export const AltegioConfigSchema = z.object({
    apiBase: z.string().url(),
    partnerToken: z.string().min(1),
    userToken: z.string().optional(),
    timeout: z.number().min(1000).default(30000),
    retryConfig: z
        .object({
        maxAttempts: z.number().min(0).default(3),
        initialDelay: z.number().min(100).default(1000),
        maxDelay: z.number().min(1000).default(30000),
    })
        .default({}),
    rateLimit: z
        .object({
        requests: z.number().min(1).default(200),
        windowMs: z.number().min(1000).default(60000),
    })
        .default({}),
});
// Full application configuration
export const AppConfigSchema = z.object({
    env: EnvSchema,
    server: ServerConfigSchema,
    altegio: AltegioConfigSchema,
});
/**
 * Configuration loader and validator
 */
export class ConfigLoader {
    static instance;
    config = null;
    constructor() { }
    static getInstance() {
        if (!ConfigLoader.instance) {
            ConfigLoader.instance = new ConfigLoader();
        }
        return ConfigLoader.instance;
    }
    /**
     * Load and validate configuration
     */
    load(env = process.env) {
        if (this.config) {
            return this.config;
        }
        try {
            // Validate environment variables
            const envConfig = EnvSchema.parse({
                ALTEGIO_API_TOKEN: env.ALTEGIO_API_TOKEN,
                ALTEGIO_USER_TOKEN: env.ALTEGIO_USER_TOKEN,
                ALTEGIO_API_BASE: env.ALTEGIO_API_BASE,
                NODE_ENV: env.NODE_ENV,
                LOG_LEVEL: env.LOG_LEVEL,
                CREDENTIALS_DIR: env.CREDENTIALS_DIR,
                RATE_LIMIT_REQUESTS: env.RATE_LIMIT_REQUESTS,
                RATE_LIMIT_WINDOW_MS: env.RATE_LIMIT_WINDOW_MS,
                MAX_RETRY_ATTEMPTS: env.MAX_RETRY_ATTEMPTS,
                INITIAL_RETRY_DELAY_MS: env.INITIAL_RETRY_DELAY_MS,
                MAX_RETRY_DELAY_MS: env.MAX_RETRY_DELAY_MS,
            });
            // Build server config
            const serverConfig = ServerConfigSchema.parse({
                name: env.npm_package_name || 'altegio-mcp-server',
                version: env.npm_package_version || '1.0.0',
                description: env.npm_package_description,
            });
            // Build Altegio client config
            const altegioConfig = AltegioConfigSchema.parse({
                apiBase: envConfig.ALTEGIO_API_BASE,
                partnerToken: envConfig.ALTEGIO_API_TOKEN,
                userToken: envConfig.ALTEGIO_USER_TOKEN,
                retryConfig: {
                    maxAttempts: envConfig.MAX_RETRY_ATTEMPTS,
                    initialDelay: envConfig.INITIAL_RETRY_DELAY_MS,
                    maxDelay: envConfig.MAX_RETRY_DELAY_MS,
                },
                rateLimit: {
                    requests: envConfig.RATE_LIMIT_REQUESTS,
                    windowMs: envConfig.RATE_LIMIT_WINDOW_MS,
                },
            });
            // Combine all configs
            this.config = {
                env: envConfig,
                server: serverConfig,
                altegio: altegioConfig,
            };
            return this.config;
        }
        catch (error) {
            if (error instanceof z.ZodError) {
                const errors = error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
                throw new ConfigurationError(`Configuration validation failed:\n${errors.join('\n')}`);
            }
            throw error;
        }
    }
    /**
     * Get the current configuration
     */
    get() {
        if (!this.config) {
            this.load();
        }
        return this.config;
    }
    /**
     * Reset configuration (useful for testing)
     */
    reset() {
        this.config = null;
    }
}
// Export convenience functions
export const loadConfig = (env) => {
    return ConfigLoader.getInstance().load(env);
};
export const getConfig = () => {
    return ConfigLoader.getInstance().get();
};
//# sourceMappingURL=schema.js.map