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
export declare const createLogger: (name: string, config?: LoggerConfig) => PinoLogger;
export declare const getLogger: (name: string) => PinoLogger;
export declare const logger: pino.Logger;
export type { Logger } from 'pino';
export type { LoggerConfig };
//# sourceMappingURL=logger.d.ts.map