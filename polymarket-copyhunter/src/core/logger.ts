/**
 * CopyHunter - Logger
 */

import chalk from 'chalk';
import { getLogsDir } from './config.js';
import { appendFileSync } from 'fs';
import { join } from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LoggerOptions {
  level: LogLevel;
  enableFile: boolean;
  enableConsole: boolean;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LOG_COLORS: Record<LogLevel, (text: string) => string> = {
  debug: chalk.gray,
  info: chalk.blue,
  warn: chalk.yellow,
  error: chalk.red,
};

const LOG_PREFIXES: Record<LogLevel, string> = {
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
};

class Logger {
  private options: LoggerOptions;
  private logFile: string;

  constructor(options: Partial<LoggerOptions> = {}) {
    this.options = {
      level: options.level ?? 'info',
      enableFile: options.enableFile ?? true,
      enableConsole: options.enableConsole ?? true,
    };
    this.logFile = join(getLogsDir(), 'copyhunter.log');
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.options.level];
  }

  private formatMessage(level: LogLevel, message: string, meta?: object): string {
    const timestamp = new Date().toISOString();
    const prefix = LOG_PREFIXES[level];
    let formatted = `[${timestamp}] ${prefix}: ${message}`;
    if (meta) {
      formatted += ` ${JSON.stringify(meta)}`;
    }
    return formatted;
  }

  private log(level: LogLevel, message: string, meta?: object): void {
    if (!this.shouldLog(level)) return;

    const formatted = this.formatMessage(level, message, meta);

    if (this.options.enableConsole) {
      const colorFn = LOG_COLORS[level];
      console.log(colorFn(formatted));
    }

    if (this.options.enableFile) {
      try {
        appendFileSync(this.logFile, formatted + '\n');
      } catch {
        // Ignore file write errors
      }
    }
  }

  debug(message: string, meta?: object): void {
    this.log('debug', message, meta);
  }

  info(message: string, meta?: object): void {
    this.log('info', message, meta);
  }

  warn(message: string, meta?: object): void {
    this.log('warn', message, meta);
  }

  error(message: string, meta?: object): void {
    this.log('error', message, meta);
  }

  setLevel(level: LogLevel): void {
    this.options.level = level;
  }

  enableConsole(enable: boolean): void {
    this.options.enableConsole = enable;
  }

  enableFile(enable: boolean): void {
    this.options.enableFile = enable;
  }
}

// Singleton logger instance
export const logger = new Logger();

// Convenience exports
export const debug = logger.debug.bind(logger);
export const info = logger.info.bind(logger);
export const warn = logger.warn.bind(logger);
export const error = logger.error.bind(logger);
