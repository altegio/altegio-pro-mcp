/**
 * Logger utility using Pino for structured logging
 */

import pino from 'pino';
import { COMMIT_SHA, PACKAGE_VERSION } from '../package-metadata.js';
import type { Logger as PinoLogger } from 'pino';
import { CloudLoggingDestination } from './cloud-logging.js';

const cloudDestination =
  process.env.GCP_STRUCTURED_LOGGING === 'true'
    ? new CloudLoggingDestination()
    : undefined;

export const flushLogs = async (): Promise<void> => {
  await cloudDestination?.flush();
};

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
        ...(mergedConfig.pretty &&
        process.env.NODE_ENV !== 'production' &&
        !cloudDestination
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
            id: req.id,
          }),
          response: (res) => ({
            id: res.id,
            result: res.result ? 'success' : 'error',
            error: Boolean(res.error),
          }),
        },
        formatters: {
          level: (label) => {
            return {
              severity:
                label === 'trace'
                  ? 'DEBUG'
                  : label === 'warn'
                    ? 'WARNING'
                    : label === 'fatal'
                      ? 'CRITICAL'
                      : label.toUpperCase(),
            };
          },
        },
        base: {
          env: process.env.NODE_ENV || 'development',
          service: 'altegio-pro-mcp',
          version: PACKAGE_VERSION,
          commit: COMMIT_SHA,
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
      cloudDestination || pino.destination({ dest: 2, sync: false })
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
