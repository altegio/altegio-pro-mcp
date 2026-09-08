/**
 * Configuration schema and validation using Zod
 */

import { z } from 'zod';
import { ConfigurationError } from '../utils/errors.js';

/**
 * Server `instructions` returned in the MCP `initialize` result (ADR-001 §5.6).
 * One paragraph: what the product is, which domains exist today, where the
 * static facets live, and what is still being added — so a host with tool
 * search knows what to look for. Override with `MCP_SERVER_INSTRUCTIONS`.
 */
export const DEFAULT_SERVER_INSTRUCTIONS = [
  'Altegio Pro is the management surface for a local service business — its',
  'owners, receptionists and team members. Today’s tools cover locations,',
  'team members and positions, services and categories, work schedules,',
  'appointments, the client base (segment, cards, visit history, lookup), analytics',
  'with a report builder, location settings, resources, and a guided onboarding',
  'walkthrough. Call altegio_login first, then list_locations for a location_id.',
  'The default /mcp endpoint serves the whole surface; narrower static views live',
  'on /mcp/ops, /mcp/catalog, /mcp/finance, /mcp/marketing, /mcp/analytics and',
  '/mcp/onboarding for hosts that cap active tools. A universal operation executor',
  'and more packs are being added. Resources under altegio://docs/ carry the',
  'product model, the canonical vocabulary and the client-segmentation reference;',
  'the onboarding_walkthrough prompt drives a first-time setup.',
].join(' ');

/**
 * An environment flag that accepts the spellings a shell or `.env` file
 * produces. Unlike `z.coerce.boolean()` this reads `"false"` and `"0"` as
 * false instead of "any non-empty string is true".
 */
const BooleanFlagSchema = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', ''])])
  .default(false)
  .transform((value) => value === true || value === 'true' || value === '1');

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

  // Override the `initialize` instructions paragraph without a rebuild.
  MCP_SERVER_INSTRUCTIONS: z.string().min(1).optional(),

  // Serve the onboarding walkthrough only on /mcp/onboarding, keeping the
  // default /mcp view under a host's active-tool cap. Off by default: turning
  // it on is a visible change for current users of the default endpoint.
  MCP_DEFAULT_FACET_EXCLUDE_ONBOARDING: BooleanFlagSchema,

  // Where the markdown documents served as `altegio://docs/*` resources live.
  // Defaults to the `docs/` folder of the installed package (see
  // src/resources/doc-loader.ts).
  ALTEGIO_DOCS_DIR: z.string().optional(),

  // HTTP deployment: require a proxy-verified delegated identity for every
  // request. Anonymous requests get no user token and cannot login.
  REQUIRE_DELEGATED_IDENTITY: z.coerce.boolean().default(false),

  // Rate limiting
  RATE_LIMIT_REQUESTS: z.coerce.number().min(1).default(200),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().min(1000).default(60000), // 1 minute

  // Retry config
  MAX_RETRY_ATTEMPTS: z.coerce.number().min(0).default(3),
  INITIAL_RETRY_DELAY_MS: z.coerce.number().min(100).default(1000),
  MAX_RETRY_DELAY_MS: z.coerce.number().min(1000).default(30000),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

// MCP Server configuration
export const ServerConfigSchema = z.object({
  name: z.string().default('altegio-mcp-server'),
  version: z.string().default('1.0.0'),
  description: z.string().optional(),
  instructions: z.string().min(1).default(DEFAULT_SERVER_INSTRUCTIONS),
  protocolVersion: z.string().default('2025-11-25'),
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
          // `resources/subscribe` is not implemented, so it is not advertised.
          subscribe: z.boolean().default(false),
          listChanged: z.boolean().default(true),
        })
        .optional(),
    })
    .default({
      tools: { listChanged: true },
      prompts: { listChanged: true },
      resources: { subscribe: false, listChanged: true },
    }),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

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
    .prefault({}),
  rateLimit: z
    .object({
      requests: z.number().min(1).default(200),
      windowMs: z.number().min(1000).default(60000),
    })
    .prefault({}),
});

export type AltegioConfig = z.infer<typeof AltegioConfigSchema>;

// Full application configuration
export const AppConfigSchema = z.object({
  env: EnvSchema,
  server: ServerConfigSchema,
  altegio: AltegioConfigSchema,
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

/**
 * Configuration loader and validator
 */
export class ConfigLoader {
  private static instance: ConfigLoader;
  private config: AppConfig | null = null;

  private constructor() {}

  public static getInstance(): ConfigLoader {
    if (!ConfigLoader.instance) {
      ConfigLoader.instance = new ConfigLoader();
    }
    return ConfigLoader.instance;
  }

  /**
   * Load and validate configuration
   */
  public load(env: NodeJS.ProcessEnv = process.env): AppConfig {
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
        MCP_SERVER_INSTRUCTIONS: env.MCP_SERVER_INSTRUCTIONS,
        MCP_DEFAULT_FACET_EXCLUDE_ONBOARDING:
          env.MCP_DEFAULT_FACET_EXCLUDE_ONBOARDING,
        ALTEGIO_DOCS_DIR: env.ALTEGIO_DOCS_DIR,
        REQUIRE_DELEGATED_IDENTITY: env.REQUIRE_DELEGATED_IDENTITY,
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
        instructions: envConfig.MCP_SERVER_INSTRUCTIONS,
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
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errors = error.issues.map(
          (e) => `${e.path.join('.')}: ${e.message}`
        );
        throw new ConfigurationError(
          `Configuration validation failed:\n${errors.join('\n')}`
        );
      }
      throw error;
    }
  }

  /**
   * Get the current configuration
   */
  public get(): AppConfig {
    if (!this.config) {
      this.load();
    }
    return this.config!;
  }

  /**
   * Reset configuration (useful for testing)
   */
  public reset(): void {
    this.config = null;
  }
}

// Export convenience functions
export const loadConfig = (env?: NodeJS.ProcessEnv): AppConfig => {
  return ConfigLoader.getInstance().load(env);
};

export const getConfig = (): AppConfig => {
  return ConfigLoader.getInstance().get();
};
