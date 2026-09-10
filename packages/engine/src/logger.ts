import { pino, type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

export function createLogger(level = process.env.ORCA_LOG_LEVEL ?? 'info'): Logger {
  return pino({ level, base: undefined, timestamp: pino.stdTimeFunctions.isoTime });
}
