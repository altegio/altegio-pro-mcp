/**
 * Configuration schema and validation using Zod
 */
import { z } from 'zod';
export declare const EnvSchema: z.ZodObject<{
    ALTEGIO_API_TOKEN: z.ZodString;
    ALTEGIO_USER_TOKEN: z.ZodOptional<z.ZodString>;
    ALTEGIO_API_BASE: z.ZodDefault<z.ZodString>;
    NODE_ENV: z.ZodDefault<z.ZodEnum<["development", "production", "test"]>>;
    LOG_LEVEL: z.ZodDefault<z.ZodEnum<["fatal", "error", "warn", "info", "debug", "trace"]>>;
    CREDENTIALS_DIR: z.ZodOptional<z.ZodString>;
    RATE_LIMIT_REQUESTS: z.ZodDefault<z.ZodNumber>;
    RATE_LIMIT_WINDOW_MS: z.ZodDefault<z.ZodNumber>;
    MAX_RETRY_ATTEMPTS: z.ZodDefault<z.ZodNumber>;
    INITIAL_RETRY_DELAY_MS: z.ZodDefault<z.ZodNumber>;
    MAX_RETRY_DELAY_MS: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    LOG_LEVEL: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
    NODE_ENV: "production" | "development" | "test";
    ALTEGIO_API_TOKEN: string;
    ALTEGIO_API_BASE: string;
    RATE_LIMIT_REQUESTS: number;
    RATE_LIMIT_WINDOW_MS: number;
    MAX_RETRY_ATTEMPTS: number;
    INITIAL_RETRY_DELAY_MS: number;
    MAX_RETRY_DELAY_MS: number;
    ALTEGIO_USER_TOKEN?: string | undefined;
    CREDENTIALS_DIR?: string | undefined;
}, {
    ALTEGIO_API_TOKEN: string;
    LOG_LEVEL?: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | undefined;
    NODE_ENV?: "production" | "development" | "test" | undefined;
    ALTEGIO_USER_TOKEN?: string | undefined;
    ALTEGIO_API_BASE?: string | undefined;
    CREDENTIALS_DIR?: string | undefined;
    RATE_LIMIT_REQUESTS?: number | undefined;
    RATE_LIMIT_WINDOW_MS?: number | undefined;
    MAX_RETRY_ATTEMPTS?: number | undefined;
    INITIAL_RETRY_DELAY_MS?: number | undefined;
    MAX_RETRY_DELAY_MS?: number | undefined;
}>;
export type EnvConfig = z.infer<typeof EnvSchema>;
export declare const ServerConfigSchema: z.ZodObject<{
    name: z.ZodDefault<z.ZodString>;
    version: z.ZodDefault<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    protocolVersion: z.ZodDefault<z.ZodString>;
    capabilities: z.ZodDefault<z.ZodObject<{
        tools: z.ZodOptional<z.ZodObject<{
            listChanged: z.ZodDefault<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            listChanged: boolean;
        }, {
            listChanged?: boolean | undefined;
        }>>;
        prompts: z.ZodOptional<z.ZodObject<{
            listChanged: z.ZodDefault<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            listChanged: boolean;
        }, {
            listChanged?: boolean | undefined;
        }>>;
        resources: z.ZodOptional<z.ZodObject<{
            listChanged: z.ZodDefault<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            listChanged: boolean;
        }, {
            listChanged?: boolean | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        prompts?: {
            listChanged: boolean;
        } | undefined;
        resources?: {
            listChanged: boolean;
        } | undefined;
        tools?: {
            listChanged: boolean;
        } | undefined;
    }, {
        prompts?: {
            listChanged?: boolean | undefined;
        } | undefined;
        resources?: {
            listChanged?: boolean | undefined;
        } | undefined;
        tools?: {
            listChanged?: boolean | undefined;
        } | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    name: string;
    version: string;
    protocolVersion: string;
    capabilities: {
        prompts?: {
            listChanged: boolean;
        } | undefined;
        resources?: {
            listChanged: boolean;
        } | undefined;
        tools?: {
            listChanged: boolean;
        } | undefined;
    };
    description?: string | undefined;
}, {
    name?: string | undefined;
    version?: string | undefined;
    protocolVersion?: string | undefined;
    capabilities?: {
        prompts?: {
            listChanged?: boolean | undefined;
        } | undefined;
        resources?: {
            listChanged?: boolean | undefined;
        } | undefined;
        tools?: {
            listChanged?: boolean | undefined;
        } | undefined;
    } | undefined;
    description?: string | undefined;
}>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export declare const AltegioConfigSchema: z.ZodObject<{
    apiBase: z.ZodString;
    partnerToken: z.ZodString;
    userToken: z.ZodOptional<z.ZodString>;
    timeout: z.ZodDefault<z.ZodNumber>;
    retryConfig: z.ZodDefault<z.ZodObject<{
        maxAttempts: z.ZodDefault<z.ZodNumber>;
        initialDelay: z.ZodDefault<z.ZodNumber>;
        maxDelay: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        maxAttempts: number;
        initialDelay: number;
        maxDelay: number;
    }, {
        maxAttempts?: number | undefined;
        initialDelay?: number | undefined;
        maxDelay?: number | undefined;
    }>>;
    rateLimit: z.ZodDefault<z.ZodObject<{
        requests: z.ZodDefault<z.ZodNumber>;
        windowMs: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        requests: number;
        windowMs: number;
    }, {
        requests?: number | undefined;
        windowMs?: number | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    apiBase: string;
    partnerToken: string;
    timeout: number;
    retryConfig: {
        maxAttempts: number;
        initialDelay: number;
        maxDelay: number;
    };
    rateLimit: {
        requests: number;
        windowMs: number;
    };
    userToken?: string | undefined;
}, {
    apiBase: string;
    partnerToken: string;
    userToken?: string | undefined;
    timeout?: number | undefined;
    retryConfig?: {
        maxAttempts?: number | undefined;
        initialDelay?: number | undefined;
        maxDelay?: number | undefined;
    } | undefined;
    rateLimit?: {
        requests?: number | undefined;
        windowMs?: number | undefined;
    } | undefined;
}>;
export type AltegioConfig = z.infer<typeof AltegioConfigSchema>;
export declare const AppConfigSchema: z.ZodObject<{
    env: z.ZodObject<{
        ALTEGIO_API_TOKEN: z.ZodString;
        ALTEGIO_USER_TOKEN: z.ZodOptional<z.ZodString>;
        ALTEGIO_API_BASE: z.ZodDefault<z.ZodString>;
        NODE_ENV: z.ZodDefault<z.ZodEnum<["development", "production", "test"]>>;
        LOG_LEVEL: z.ZodDefault<z.ZodEnum<["fatal", "error", "warn", "info", "debug", "trace"]>>;
        CREDENTIALS_DIR: z.ZodOptional<z.ZodString>;
        RATE_LIMIT_REQUESTS: z.ZodDefault<z.ZodNumber>;
        RATE_LIMIT_WINDOW_MS: z.ZodDefault<z.ZodNumber>;
        MAX_RETRY_ATTEMPTS: z.ZodDefault<z.ZodNumber>;
        INITIAL_RETRY_DELAY_MS: z.ZodDefault<z.ZodNumber>;
        MAX_RETRY_DELAY_MS: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        LOG_LEVEL: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
        NODE_ENV: "production" | "development" | "test";
        ALTEGIO_API_TOKEN: string;
        ALTEGIO_API_BASE: string;
        RATE_LIMIT_REQUESTS: number;
        RATE_LIMIT_WINDOW_MS: number;
        MAX_RETRY_ATTEMPTS: number;
        INITIAL_RETRY_DELAY_MS: number;
        MAX_RETRY_DELAY_MS: number;
        ALTEGIO_USER_TOKEN?: string | undefined;
        CREDENTIALS_DIR?: string | undefined;
    }, {
        ALTEGIO_API_TOKEN: string;
        LOG_LEVEL?: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | undefined;
        NODE_ENV?: "production" | "development" | "test" | undefined;
        ALTEGIO_USER_TOKEN?: string | undefined;
        ALTEGIO_API_BASE?: string | undefined;
        CREDENTIALS_DIR?: string | undefined;
        RATE_LIMIT_REQUESTS?: number | undefined;
        RATE_LIMIT_WINDOW_MS?: number | undefined;
        MAX_RETRY_ATTEMPTS?: number | undefined;
        INITIAL_RETRY_DELAY_MS?: number | undefined;
        MAX_RETRY_DELAY_MS?: number | undefined;
    }>;
    server: z.ZodObject<{
        name: z.ZodDefault<z.ZodString>;
        version: z.ZodDefault<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        protocolVersion: z.ZodDefault<z.ZodString>;
        capabilities: z.ZodDefault<z.ZodObject<{
            tools: z.ZodOptional<z.ZodObject<{
                listChanged: z.ZodDefault<z.ZodBoolean>;
            }, "strip", z.ZodTypeAny, {
                listChanged: boolean;
            }, {
                listChanged?: boolean | undefined;
            }>>;
            prompts: z.ZodOptional<z.ZodObject<{
                listChanged: z.ZodDefault<z.ZodBoolean>;
            }, "strip", z.ZodTypeAny, {
                listChanged: boolean;
            }, {
                listChanged?: boolean | undefined;
            }>>;
            resources: z.ZodOptional<z.ZodObject<{
                listChanged: z.ZodDefault<z.ZodBoolean>;
            }, "strip", z.ZodTypeAny, {
                listChanged: boolean;
            }, {
                listChanged?: boolean | undefined;
            }>>;
        }, "strip", z.ZodTypeAny, {
            prompts?: {
                listChanged: boolean;
            } | undefined;
            resources?: {
                listChanged: boolean;
            } | undefined;
            tools?: {
                listChanged: boolean;
            } | undefined;
        }, {
            prompts?: {
                listChanged?: boolean | undefined;
            } | undefined;
            resources?: {
                listChanged?: boolean | undefined;
            } | undefined;
            tools?: {
                listChanged?: boolean | undefined;
            } | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        name: string;
        version: string;
        protocolVersion: string;
        capabilities: {
            prompts?: {
                listChanged: boolean;
            } | undefined;
            resources?: {
                listChanged: boolean;
            } | undefined;
            tools?: {
                listChanged: boolean;
            } | undefined;
        };
        description?: string | undefined;
    }, {
        name?: string | undefined;
        version?: string | undefined;
        protocolVersion?: string | undefined;
        capabilities?: {
            prompts?: {
                listChanged?: boolean | undefined;
            } | undefined;
            resources?: {
                listChanged?: boolean | undefined;
            } | undefined;
            tools?: {
                listChanged?: boolean | undefined;
            } | undefined;
        } | undefined;
        description?: string | undefined;
    }>;
    altegio: z.ZodObject<{
        apiBase: z.ZodString;
        partnerToken: z.ZodString;
        userToken: z.ZodOptional<z.ZodString>;
        timeout: z.ZodDefault<z.ZodNumber>;
        retryConfig: z.ZodDefault<z.ZodObject<{
            maxAttempts: z.ZodDefault<z.ZodNumber>;
            initialDelay: z.ZodDefault<z.ZodNumber>;
            maxDelay: z.ZodDefault<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            maxAttempts: number;
            initialDelay: number;
            maxDelay: number;
        }, {
            maxAttempts?: number | undefined;
            initialDelay?: number | undefined;
            maxDelay?: number | undefined;
        }>>;
        rateLimit: z.ZodDefault<z.ZodObject<{
            requests: z.ZodDefault<z.ZodNumber>;
            windowMs: z.ZodDefault<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            requests: number;
            windowMs: number;
        }, {
            requests?: number | undefined;
            windowMs?: number | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        apiBase: string;
        partnerToken: string;
        timeout: number;
        retryConfig: {
            maxAttempts: number;
            initialDelay: number;
            maxDelay: number;
        };
        rateLimit: {
            requests: number;
            windowMs: number;
        };
        userToken?: string | undefined;
    }, {
        apiBase: string;
        partnerToken: string;
        userToken?: string | undefined;
        timeout?: number | undefined;
        retryConfig?: {
            maxAttempts?: number | undefined;
            initialDelay?: number | undefined;
            maxDelay?: number | undefined;
        } | undefined;
        rateLimit?: {
            requests?: number | undefined;
            windowMs?: number | undefined;
        } | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    env: {
        LOG_LEVEL: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
        NODE_ENV: "production" | "development" | "test";
        ALTEGIO_API_TOKEN: string;
        ALTEGIO_API_BASE: string;
        RATE_LIMIT_REQUESTS: number;
        RATE_LIMIT_WINDOW_MS: number;
        MAX_RETRY_ATTEMPTS: number;
        INITIAL_RETRY_DELAY_MS: number;
        MAX_RETRY_DELAY_MS: number;
        ALTEGIO_USER_TOKEN?: string | undefined;
        CREDENTIALS_DIR?: string | undefined;
    };
    server: {
        name: string;
        version: string;
        protocolVersion: string;
        capabilities: {
            prompts?: {
                listChanged: boolean;
            } | undefined;
            resources?: {
                listChanged: boolean;
            } | undefined;
            tools?: {
                listChanged: boolean;
            } | undefined;
        };
        description?: string | undefined;
    };
    altegio: {
        apiBase: string;
        partnerToken: string;
        timeout: number;
        retryConfig: {
            maxAttempts: number;
            initialDelay: number;
            maxDelay: number;
        };
        rateLimit: {
            requests: number;
            windowMs: number;
        };
        userToken?: string | undefined;
    };
}, {
    env: {
        ALTEGIO_API_TOKEN: string;
        LOG_LEVEL?: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | undefined;
        NODE_ENV?: "production" | "development" | "test" | undefined;
        ALTEGIO_USER_TOKEN?: string | undefined;
        ALTEGIO_API_BASE?: string | undefined;
        CREDENTIALS_DIR?: string | undefined;
        RATE_LIMIT_REQUESTS?: number | undefined;
        RATE_LIMIT_WINDOW_MS?: number | undefined;
        MAX_RETRY_ATTEMPTS?: number | undefined;
        INITIAL_RETRY_DELAY_MS?: number | undefined;
        MAX_RETRY_DELAY_MS?: number | undefined;
    };
    server: {
        name?: string | undefined;
        version?: string | undefined;
        protocolVersion?: string | undefined;
        capabilities?: {
            prompts?: {
                listChanged?: boolean | undefined;
            } | undefined;
            resources?: {
                listChanged?: boolean | undefined;
            } | undefined;
            tools?: {
                listChanged?: boolean | undefined;
            } | undefined;
        } | undefined;
        description?: string | undefined;
    };
    altegio: {
        apiBase: string;
        partnerToken: string;
        userToken?: string | undefined;
        timeout?: number | undefined;
        retryConfig?: {
            maxAttempts?: number | undefined;
            initialDelay?: number | undefined;
            maxDelay?: number | undefined;
        } | undefined;
        rateLimit?: {
            requests?: number | undefined;
            windowMs?: number | undefined;
        } | undefined;
    };
}>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
/**
 * Configuration loader and validator
 */
export declare class ConfigLoader {
    private static instance;
    private config;
    private constructor();
    static getInstance(): ConfigLoader;
    /**
     * Load and validate configuration
     */
    load(env?: NodeJS.ProcessEnv): AppConfig;
    /**
     * Get the current configuration
     */
    get(): AppConfig;
    /**
     * Reset configuration (useful for testing)
     */
    reset(): void;
}
export declare const loadConfig: (env?: NodeJS.ProcessEnv) => AppConfig;
export declare const getConfig: () => AppConfig;
//# sourceMappingURL=schema.d.ts.map