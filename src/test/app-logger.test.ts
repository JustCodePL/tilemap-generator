import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AppLogger } from '../main/services/app-logger';

const directories: string[] = [];

afterEach(() => {
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

it('zapisuje trwały log JSONL w katalogu danych aplikacji', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-logger-'));
  directories.push(directory);
  const logger = new AppLogger(directory);

  logger.error('generation.failed', { jobId: 'job-1', message: 'Pełny komunikat błędu' });

  const entry = JSON.parse(readFileSync(logger.filePath, 'utf8').trim()) as Record<string, unknown>;
  expect(logger.filePath).toBe(path.join(directory, 'logs', 'main.jsonl'));
  expect(entry).toMatchObject({
    level: 'error',
    event: 'generation.failed',
    jobId: 'job-1',
    message: 'Pełny komunikat błędu',
  });
});
