import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export type LogDetails = Record<string, unknown>;

export interface Logger {
  readonly filePath: string | null;
  info(event: string, details?: LogDetails): void;
  warn(event: string, details?: LogDetails): void;
  error(event: string, details?: LogDetails): void;
}

export class AppLogger implements Logger {
  readonly filePath: string;

  constructor(userDataPath: string) {
    const directory = path.join(userDataPath, 'logs');
    mkdirSync(directory, { recursive: true });
    this.filePath = path.join(directory, 'main.jsonl');
  }

  info(event: string, details: LogDetails = {}): void {
    this.write('info', event, details);
  }

  warn(event: string, details: LogDetails = {}): void {
    this.write('warn', event, details);
  }

  error(event: string, details: LogDetails = {}): void {
    this.write('error', event, details);
  }

  private write(level: 'info' | 'warn' | 'error', event: string, details: LogDetails): void {
    try {
      appendFileSync(this.filePath, `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event,
        ...details,
      })}\n`, 'utf8');
    } catch (error) {
      // Logging must never take the application down, including when the disk is full.
      console.error('Nie udało się zapisać logu aplikacji.', error);
    }
  }
}

export const nullLogger: Logger = {
  filePath: null,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
