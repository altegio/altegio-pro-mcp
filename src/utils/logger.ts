/**
 * Logger utility using Pino for structured logging
 */

import pino from 'pino';
import type { Logger as PinoLogger } from 'pino';

interface LoggerConfig {
  level?: string;
  pretty?: boolean;
  name?: string;
}

class LoggerFactory {
  private static instance: LoggerFactory;
  private loggers: Map<string, PinoLogger> = new Map();
  private defaultConfig: LoggerConfig;

  private constructor() {
    this.defaultConfig = {
      level: process.env.LOG_LEVEL || 'info',
      pretty: process.env.NODE_ENV !== 'production',
      name: 'altegio-mcp',
    };
  }

  public static getInstance(): LoggerFactory {
    if (!LoggerFactory.instance) {
      LoggerFactory.instance = new LoggerFactory();
    }
    return LoggerFactory.instance;
  }

  public createLogger(name: string, config?: LoggerConfig): PinoLogger {
    const cacheKey = name;

    if (this.loggers.has(cacheKey)) {
      return this.loggers.get(cacheKey)!;
    }

    const mergedConfig = { ...this.defaultConfig, ...config, name };

    const logger = pino(
      {
        name: mergedConfig.name,
        level: mergedConfig.level!,
        ...(mergedConfig.pretty && process.env.NODE_ENV !== 'production'
          ? {
              transport: {
                target: 'pino-pretty',
                options: {
                  colorize: true,
                  translateTime: 'SYS:standard',
                  ignore: 'pid,hostname',
                },
              },
            }
          : {}),
        serializers: {
          err: pino.stdSerializers.err,
          error: pino.stdSerializers.err,
          request: (req) => ({
            method: req.method,
            params: req.params,
            id: req.id,
          }),
          response: (res) => ({
            id: res.id,
            result: res.result ? 'success' : 'error',
            error: res.error,
          }),
        },
        formatters: {
          level: (label) => {
            return { level: label.toUpperCase() };
          },
        },
        base: {
          env: process.env.NODE_ENV || 'development',
          version: process.env.npm_package_version,
        },
        redact: {
          paths: [
            'password',
            'token',
            'user_token',
            'authorization',
            'api_key',
            'apiKey',
            '*.password',
            '*.token',
            '*.user_token',
          ],
          censor: '[REDACTED]',
        },
      },
      pino.destination({ dest: 2, sync: false }) // Write to stderr (fd 2) instead of stdout
    );

    this.loggers.set(cacheKey, logger);
    return logger;
  }

  public getLogger(name: string): PinoLogger {
    return this.loggers.get(name) || this.createLogger(name);
  }
}

// Export convenience functions
export const createLogger = (
  name: string,
  config?: LoggerConfig
): PinoLogger => {
  return LoggerFactory.getInstance().createLogger(name, config);
};

export const getLogger = (name: string): PinoLogger => {
  return LoggerFactory.getInstance().getLogger(name);
};

// Default logger instance
export const logger = createLogger('altegio-mcp');

// Export types
export type { Logger } from 'pino';
export type { LoggerConfig };
