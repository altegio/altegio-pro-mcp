import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  loadConfig,
  ConfigLoader,
  EnvSchema,
  ServerConfigSchema,
  AltegioConfigSchema,
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
        LOG_LEVEL: 'debug',
        RATE_LIMIT_REQUESTS: 100,
        MAX_RETRY_ATTEMPTS: 5,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ALTEGIO_API_BASE).toBe('https://custom.api.com');
        expect(result.data.LOG_LEVEL).toBe('debug');
        expect(result.data.RATE_LIMIT_REQUESTS).toBe(100);
        expect(result.data.MAX_RETRY_ATTEMPTS).toBe(5);
      }
    });
  });

  describe('ServerConfigSchema', () => {
    it('should provide default values', () => {
      const result = ServerConfigSchema.parse({});

      expect(result.name).toBe('altegio-mcp-server');
      expect(result.version).toBe('1.0.0');
      expect(result.protocolVersion).toBe('2024-11-05');
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
      expect(config.server.name).toBe('altegio-mcp-server');
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
