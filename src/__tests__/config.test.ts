import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  loadConfig,
  ConfigLoader,
  DEFAULT_PUBLIC_BASE_URL,
  EnvSchema,
  ServerConfigSchema,
  AltegioConfigSchema,
  readOnlyViewInstructions,
} from '../config/schema.js';
import { ConfigurationError } from '../utils/errors.js';

describe('Configuration Schema', () => {
  beforeEach(() => {
    // Reset config singleton before each test
    ConfigLoader.getInstance().reset();
  });

  describe('EnvSchema', () => {
    it('should validate required fields', () => {
      const result = EnvSchema.safeParse({
        ALTEGIO_API_TOKEN: 'test-token-123',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ALTEGIO_API_TOKEN).toBe('test-token-123');
        expect(result.data.ALTEGIO_API_BASE).toBe(
          'https://api.alteg.io/api/v1'
        );
        expect(result.data.ALTEGIO_LEGACY_WEB_BASE).toBe(
          'https://app.alteg.io'
        );
        expect(result.data.LOG_LEVEL).toBe('info');
      }
    });

    it('should fail without API token', () => {
      const result = EnvSchema.safeParse({});

      expect(result.success).toBe(false);
    });

    it('should validate custom values', () => {
      const result = EnvSchema.safeParse({
        ALTEGIO_API_TOKEN: 'test-token',
        ALTEGIO_API_BASE: 'https://custom.api.com',
        ALTEGIO_LEGACY_WEB_BASE: 'https://erp.example.test/',
        LOG_LEVEL: 'debug',
        RATE_LIMIT_REQUESTS: 100,
        MAX_RETRY_ATTEMPTS: 5,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ALTEGIO_API_BASE).toBe('https://custom.api.com');
        expect(result.data.ALTEGIO_LEGACY_WEB_BASE).toBe(
          'https://erp.example.test'
        );
        expect(result.data.LOG_LEVEL).toBe('debug');
        expect(result.data.RATE_LIMIT_REQUESTS).toBe(100);
        expect(result.data.MAX_RETRY_ATTEMPTS).toBe(5);
      }
    });

    it('keeps the YCLIENTS legacy origin available as an explicit override', () => {
      const result = EnvSchema.parse({
        ALTEGIO_API_TOKEN: 'test-token',
        ALTEGIO_LEGACY_WEB_BASE: 'https://yclients.com/',
      });
      expect(result.ALTEGIO_LEGACY_WEB_BASE).toBe('https://yclients.com');
    });
  });

  describe('ALTEGIO_EXPOSE_PASSWORD_LOGIN', () => {
    // The default decides whether a public HTTP deployment hands a model a
    // tool that asks the user for a password, so pin it and pin the spellings
    // a shell or .env file actually produces.
    it('is off when unset', () => {
      const result = EnvSchema.parse({ ALTEGIO_API_TOKEN: 'test-token' });
      expect(result.ALTEGIO_EXPOSE_PASSWORD_LOGIN).toBe(false);
    });

    it('reads the flag spellings, including the falsy ones', () => {
      const parse = (value: unknown) =>
        EnvSchema.parse({
          ALTEGIO_API_TOKEN: 'test-token',
          ALTEGIO_EXPOSE_PASSWORD_LOGIN: value,
        }).ALTEGIO_EXPOSE_PASSWORD_LOGIN;

      expect(parse('true')).toBe(true);
      expect(parse('1')).toBe(true);
      expect(parse(true)).toBe(true);
      expect(parse('false')).toBe(false);
      expect(parse('0')).toBe(false);
      expect(parse('')).toBe(false);
    });

    it('reaches the loaded config', () => {
      const config = loadConfig({
        ALTEGIO_API_TOKEN: 'test-token',
        ALTEGIO_EXPOSE_PASSWORD_LOGIN: 'true',
      } as NodeJS.ProcessEnv);
      expect(config.env.ALTEGIO_EXPOSE_PASSWORD_LOGIN).toBe(true);
    });
  });

  describe('REQUIRE_DELEGATED_IDENTITY', () => {
    it('uses the same explicit boolean spellings as the other HTTP flags', () => {
      const parse = (value: unknown) =>
        EnvSchema.parse({
          ALTEGIO_API_TOKEN: 'test-token',
          REQUIRE_DELEGATED_IDENTITY: value,
        }).REQUIRE_DELEGATED_IDENTITY;

      expect(parse('true')).toBe(true);
      expect(parse('1')).toBe(true);
      expect(parse(true)).toBe(true);
      expect(parse('false')).toBe(false);
      expect(parse('0')).toBe(false);
      expect(parse('')).toBe(false);
    });
  });

  describe('MCP_PUBLIC_BASE_URL', () => {
    // It only ever appears in text a model reads — the read-only view's
    // refusal and its instructions — so a wrong value misdirects a user.
    it('defaults to the published public endpoint', () => {
      const result = EnvSchema.parse({ ALTEGIO_API_TOKEN: 'test-token' });
      expect(result.MCP_PUBLIC_BASE_URL).toBe(DEFAULT_PUBLIC_BASE_URL);
      expect(DEFAULT_PUBLIC_BASE_URL).toBe('https://mcp.alteg.io/pro');
    });

    it('accepts an override and strips a trailing slash', () => {
      const result = EnvSchema.parse({
        ALTEGIO_API_TOKEN: 'test-token',
        MCP_PUBLIC_BASE_URL: 'https://mcp.alteg.io/pro/',
      });
      expect(result.MCP_PUBLIC_BASE_URL).toBe('https://mcp.alteg.io/pro');
    });

    it('rejects a value that is not a URL', () => {
      expect(
        EnvSchema.safeParse({
          ALTEGIO_API_TOKEN: 'test-token',
          MCP_PUBLIC_BASE_URL: 'mcp.alteg.io/pro',
        }).success
      ).toBe(false);
    });

    it('is what the read-only instructions name', () => {
      const text = readOnlyViewInstructions('https://mcp.alteg.io/pro');
      expect(text).toContain('https://mcp.alteg.io/pro/readonly');
      expect(text).toContain('https://mcp.alteg.io/pro,');
    });
  });

  describe('ServerConfigSchema', () => {
    it('should provide default values', () => {
      const result = ServerConfigSchema.parse({});

      expect(result.name).toBe('@altegio/mcp-server-pro');
      expect(result.version).toBe('0.3.0-alpha.0');
      expect(result.protocolVersion).toBe('2025-11-25');
      expect(result.capabilities.tools?.listChanged).toBe(true);
    });

    it('should accept custom values', () => {
      const result = ServerConfigSchema.parse({
        name: 'custom-server',
        version: '2.0.0',
        description: 'Custom description',
      });

      expect(result.name).toBe('custom-server');
      expect(result.version).toBe('2.0.0');
      expect(result.description).toBe('Custom description');
    });
  });

  describe('AltegioConfigSchema', () => {
    it('should validate required Altegio config', () => {
      const result = AltegioConfigSchema.parse({
        apiBase: 'https://api.alteg.io/api/v1',
        partnerToken: 'test-token',
      });

      expect(result.apiBase).toBe('https://api.alteg.io/api/v1');
      expect(result.legacyWebBase).toBe('https://app.alteg.io');
      expect(result.partnerToken).toBe('test-token');
      expect(result.timeout).toBe(30000);
      expect(result.retryConfig.maxAttempts).toBe(3);
    });

    it('should fail without partner token', () => {
      const result = AltegioConfigSchema.safeParse({
        apiBase: 'https://api.alteg.io/api/v1',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('loadConfig', () => {
    it('should load configuration from environment', () => {
      const config = loadConfig({
        ALTEGIO_API_TOKEN: 'test-token-123',
        NODE_ENV: 'test',
        LOG_LEVEL: 'debug',
      });

      expect(config.env.ALTEGIO_API_TOKEN).toBe('test-token-123');
      expect(config.env.NODE_ENV).toBe('test');
      expect(config.env.LOG_LEVEL).toBe('debug');
      expect(config.server.name).toBe('@altegio/mcp-server-pro');
      expect(config.altegio.partnerToken).toBe('test-token-123');
    });

    it('should use npm package metadata when available', () => {
      const config = loadConfig({
        ALTEGIO_API_TOKEN: 'test-token',
        npm_package_name: '@altegio/mcp-server',
        npm_package_version: '2.5.0',
        npm_package_description: 'Test description',
      });

      expect(config.server.name).toBe('@altegio/mcp-server');
      expect(config.server.version).toBe('2.5.0');
      expect(config.server.description).toBe('Test description');
    });

    it('should throw ConfigurationError on validation failure', () => {
      expect(() => {
        loadConfig({});
      }).toThrow(ConfigurationError);
    });

    it('should throw ConfigurationError with detailed message', () => {
      expect(() => {
        loadConfig({});
      }).toThrow(/ALTEGIO_API_TOKEN/);
    });

    it('should cache configuration on subsequent calls', () => {
      const config1 = loadConfig({
        ALTEGIO_API_TOKEN: 'test-token',
      });

      const config2 = loadConfig({
        ALTEGIO_API_TOKEN: 'different-token',
      });

      // Should return cached config, not new one
      expect(config2).toBe(config1);
      expect(config2.env.ALTEGIO_API_TOKEN).toBe('test-token');
    });

    it('should support user token', () => {
      const config = loadConfig({
        ALTEGIO_API_TOKEN: 'partner-token',
        ALTEGIO_USER_TOKEN: 'user-token-123',
      });

      expect(config.env.ALTEGIO_USER_TOKEN).toBe('user-token-123');
      expect(config.altegio.userToken).toBe('user-token-123');
    });

    it('should support a legacy web report base override', () => {
      const config = loadConfig({
        ALTEGIO_API_TOKEN: 'partner-token',
        ALTEGIO_LEGACY_WEB_BASE: 'https://erp.example.test/',
      });

      expect(config.env.ALTEGIO_LEGACY_WEB_BASE).toBe(
        'https://erp.example.test'
      );
      expect(config.altegio.legacyWebBase).toBe('https://erp.example.test');
    });

    it('should support custom rate limiting', () => {
      const config = loadConfig({
        ALTEGIO_API_TOKEN: 'test-token',
        RATE_LIMIT_REQUESTS: '500',
        RATE_LIMIT_WINDOW_MS: '120000',
      });

      expect(config.env.RATE_LIMIT_REQUESTS).toBe(500);
      expect(config.env.RATE_LIMIT_WINDOW_MS).toBe(120000);
      expect(config.altegio.rateLimit.requests).toBe(500);
      expect(config.altegio.rateLimit.windowMs).toBe(120000);
    });

    it('should support custom retry configuration', () => {
      const config = loadConfig({
        ALTEGIO_API_TOKEN: 'test-token',
        MAX_RETRY_ATTEMPTS: '5',
        INITIAL_RETRY_DELAY_MS: '2000',
        MAX_RETRY_DELAY_MS: '60000',
      });

      expect(config.env.MAX_RETRY_ATTEMPTS).toBe(5);
      expect(config.env.INITIAL_RETRY_DELAY_MS).toBe(2000);
      expect(config.env.MAX_RETRY_DELAY_MS).toBe(60000);
      expect(config.altegio.retryConfig.maxAttempts).toBe(5);
      expect(config.altegio.retryConfig.initialDelay).toBe(2000);
      expect(config.altegio.retryConfig.maxDelay).toBe(60000);
    });
  });

  describe('ConfigLoader singleton', () => {
    it('should return same instance', () => {
      const instance1 = ConfigLoader.getInstance();
      const instance2 = ConfigLoader.getInstance();

      expect(instance1).toBe(instance2);
    });

    it('should reset configuration', () => {
      const loader = ConfigLoader.getInstance();

      loader.load({
        ALTEGIO_API_TOKEN: 'test-token-1',
      });

      const config1 = loader.get();
      expect(config1.env.ALTEGIO_API_TOKEN).toBe('test-token-1');

      loader.reset();

      // After reset, should load new config from current process.env
      const config2 = loader.load({
        ALTEGIO_API_TOKEN: 'test-token-2',
      });

      expect(config2.env.ALTEGIO_API_TOKEN).toBe('test-token-2');
      expect(config1).not.toBe(config2);
    });
  });
});
