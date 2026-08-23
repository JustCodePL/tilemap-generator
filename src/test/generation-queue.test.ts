import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import type { GenerationEvent } from '../shared/domain';
import type { CodexService } from '../main/codex/codex-service';
import { ProjectDatabase } from '../main/db/project-database';
import { GenerationQueue } from '../main/services/generation-queue';

const temporaryDirectories: string[] = [];
const CHARACTER_FIXTURE_FRAMES = 4;
const PROJECT_CHARACTER_FRAMES = 8;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it('nie odłącza projektu, dopóki aktywne zadanie faktycznie nie zakończy anulowania', async () => {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-shutdown-')), 'project');
  temporaryDirectories.push(path.dirname(root));
  mkdirSync(root);
  const database = ProjectDatabase.create(root, {
    name: 'Bezpieczne zamykanie', artBrief: '', tileWidthPx: 64,
  });
  let releaseTurn: () => void = () => undefined;
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { markStarted = () => resolve(); });
  const blockedTurn = new Promise<void>((resolve) => { releaseTurn = () => resolve(); });
  const fakeCodex = {
    runExclusive: async <T>(operation: () => Promise<T>) => operation(),
    ensureAssetThread: async () => 'thread-blocked-shutdown',
    skillPath: () => '/tmp/imagegen/SKILL.md',
    interruptActiveTurn: async () => undefined,
    runTurn: async () => {
      markStarted();
      await blockedTurn;
      throw new Error('Testowe zadanie zakończone po zwolnieniu blokady.');
    },
  } as unknown as CodexService;
  const queue = new GenerationQueue(fakeCodex);
  queue.attach(database);
  const terminal = waitForGenerationTerminal(queue);
  queue.enqueue({
    name: 'Wolny asset', prompt: '', mode: 'generate', category: 'other', footprint: { x: 1, y: 1 },
  });
  await started;

  await expect(queue.shutdown(10)).rejects.toThrow('aktywne zadania nie zakończyły anulowania');
  expect(database.getProject().name).toBe('Bezpieczne zamykanie');

  releaseTurn();
  await expect(terminal).resolves.toMatchObject({ type: 'failed' });
  await queue.shutdown();
  database.close();
});

it('uruchamia najwyżej skonfigurowaną liczbę różnych assetów jednocześnie', async () => {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-concurrency-')), 'project');
  temporaryDirectories.push(path.dirname(root));
  mkdirSync(root);
  const database = ProjectDatabase.create(root, {
    name: 'Równoległa kolejka', artBrief: '', tileWidthPx: 64,
  });
  database.updateProjectSettings({
    name: 'Równoległa kolejka', artBrief: '', tileWidthPx: 64, pixelsPerUnit: 64,
    maxConcurrentJobs: 2, aiVerificationEnabled: true,
  });

  let activeTurns = 0;
  let maxActiveTurns = 0;
  let turnCounter = 0;
  const releases: Array<() => void> = [];
  const fakeCodex = {
    runExclusive: async <T>(operation: () => Promise<T>) => operation(),
    ensureAssetThread: async (assetId: string) => `thread-${assetId}`,
    skillPath: () => 'C:\\imagegen\\SKILL.md',
    interruptActiveTurn: async () => undefined,
    runTurn: async (_threadId: string, input: Array<Record<string, unknown>>) => {
      const turnId = `turn-${++turnCounter}`;
      activeTurns += 1;
      maxActiveTurns = Math.max(maxActiveTurns, activeTurns);
      const prompt = String(input[0].text);
      const outputPath = prompt.match(/exactly (.+?final\.png)/i)?.[1];
      if (!outputPath) throw new Error('Test nie znalazł ścieżki final.png w prompcie.');
      mkdirSync(path.dirname(outputPath), { recursive: true });
      const svg = '<svg width="16" height="16"><rect x="4" y="4" width="8" height="8" fill="#75a94c"/></svg>';
      await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: Buffer.from(svg) }]).png().toFile(outputPath);
      await new Promise<void>((resolve) => releases.push(resolve));
      activeTurns -= 1;
      return {
        turnId,
        items: [],
        finalMessage: JSON.stringify({
          status: 'completed', finalPath: outputPath, category: 'other', tags: ['test'],
          pivot: { x: 0.5, y: 0 }, description: 'Testowy asset', message: '',
        }),
      };
    },
  } as unknown as CodexService;
  const queue = new GenerationQueue(fakeCodex);
  queue.attach(database);

  const jobs = ['Pierwszy', 'Drugi', 'Trzeci'].map((name) => queue.enqueue({
    name, prompt: '', mode: 'generate', category: 'other', footprint: { x: 1, y: 1 },
  }));
  await waitUntil(() => releases.length === 2);
  expect(database.listJobs().filter((job) => job.status === 'generating')).toHaveLength(2);
  expect(database.listJobs().filter((job) => job.status === 'queued')).toHaveLength(1);
  expect(maxActiveTurns).toBe(2);

  releases[0]();
  await waitUntil(() => releases.length === 3);
  expect(maxActiveTurns).toBe(2);
  releases[1]();
  releases[2]();
  await waitUntil(() => jobs.every((job) => database.getJob(job.id)?.status === 'needs_review'));

  await queue.shutdown();
  database.close();
});

it('automatycznie poprawia teren po nieudanym deterministycznym teście szwów', async () => {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-queue-')), 'project');
  temporaryDirectories.push(path.dirname(root));
  mkdirSync(root);
  const database = ProjectDatabase.create(root, {
    name: 'Test szwów', artBrief: 'Malowany teren', tileWidthPx: 64,
  });
  const referenceSource = path.join(path.dirname(root), 'reference.png');
  await sharp({ create: { width: 80, height: 40, channels: 3, background: '#7ca84d' } }).png().toFile(referenceSource);
  const reference = await database.addProjectReference(referenceSource, 'Wzór miękkiej, malowanej faktury trawy');
  let turns = 0;
  let generationPrompt = '';
  let retryPrompt = '';
  let retryImages: Array<Record<string, unknown>> = [];
  const fakeCodex = {
    runExclusive: async <T>(operation: () => Promise<T>) => operation(),
    ensureAssetThread: async () => 'thread-terrain',
    skillPath: () => 'C:\\imagegen\\SKILL.md',
    interruptActiveTurn: async () => undefined,
    runTurn: async (
      _threadId: string,
      input: Array<Record<string, unknown>>,
      _outputSchema: Record<string, unknown>,
      onEvent?: (notification: { method: string; params: Record<string, unknown> }) => void,
    ) => {
      turns += 1;
      if (turns === 1) generationPrompt = String(input[0].text);
      if (turns === 2) {
        retryPrompt = String(input[0].text);
        retryImages = input.filter((item) => item.type === 'localImage');
      }
      if (turns === 1) {
        onEvent?.({
          method: 'item/started',
          params: { item: { type: 'dynamicToolCall', namespace: 'registry', tool: 'search_assets', arguments: { query: 'łąka', category: 'flat_tile', limit: 3 } } },
        });
        onEvent?.({
          method: 'item/started',
          params: { item: { type: 'dynamicToolCall', namespace: 'registry', tool: 'get_reference', arguments: { referenceId: reference.id } } },
        });
      }
      const prompt = String(input[0].text);
      const outputPath = prompt.match(/exactly (.+?final\.png)/i)?.[1];
      if (!outputPath) throw new Error('Test nie znalazł ścieżki final.png w prompcie.');
      mkdirSync(path.dirname(outputPath), { recursive: true });
      const svg = turns === 1
        ? '<svg width="56" height="26"><polygon points="28,0 56,13 28,26 0,13" fill="#75a842"/></svg>'
        : '<svg width="64" height="32"><polygon points="32,0 64,16 32,32 0,16" fill="#75a842"/></svg>';
      await sharp({ create: { width: 64, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: Buffer.from(svg), left: turns === 1 ? 4 : 0, top: turns === 1 ? 3 : 0 }])
        .png().toFile(outputPath);
      return {
        turnId: `turn-${turns}`,
        items: [],
        finalMessage: JSON.stringify({
          status: 'completed', finalPath: outputPath, category: 'flat_tile', tags: ['trawa'],
          pivot: { x: 0.5, y: 0.5 }, description: 'Trawiasty teren', message: '',
        }),
      };
    },
  } as unknown as CodexService;
  const queue = new GenerationQueue(fakeCodex);
  queue.attach(database);
  const terminal = new Promise<GenerationEvent>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Kolejka nie zakończyła testowego joba.')), 10_000);
    queue.on('event', (event: GenerationEvent) => {
      if (event.type === 'completed' || event.type === 'failed') {
        clearTimeout(timeout);
        resolve(event);
      }
    });
  });
  const job = queue.enqueue({
    name: 'Łąka', prompt: '', mode: 'generate', category: 'flat_tile', footprint: { x: 1, y: 1 },
  });

  const terminalEvent = await terminal;
  if (terminalEvent.type === 'failed') throw new Error(terminalEvent.message);
  expect(terminalEvent).toMatchObject({ type: 'completed', jobId: job.id });
  expect(turns).toBe(2);
  expect(generationPrompt).toContain('Asset title: Łąka');
  expect(generationPrompt).toContain('Generate the asset from its title and project context.');
  expect(retryPrompt).toContain('Asset title: Łąka');
  expect(generationPrompt).toContain(reference.id);
  expect(generationPrompt).toContain('Wzór miękkiej, malowanej faktury trawy');
  expect(generationPrompt).toContain('registry.get_reference');
  expect(generationPrompt).toContain('registry.propose_project_settings');
  expect(generationPrompt).toContain('return status needs_user_decision');
  expect(generationPrompt).toContain('read as one continuous surface with no visible grid');
  expect(generationPrompt).toContain('top-left edge must match the bottom-right edge pixel-for-pixel');
  expect(generationPrompt).toContain('Choose pivot only after the final PNG is complete and inspected');
  expect(retryPrompt).toContain('Ciągłość alfa/geometrii');
  expect(retryPrompt).toContain('Ciągłość koloru i materiału');
  expect(retryPrompt).toContain('Image 2 is the deterministic exact-offset 3x3 repeat');
  expect(retryPrompt).toContain('Do not hide a seam by overlapping copies');
  expect(retryPrompt).toContain('Choose pivot only after the repaired final PNG is complete and inspected');
  expect(retryImages).toHaveLength(2);
  expect(database.getJob(job.id)?.status).toBe('needs_review');
  expect(database.listGenerationLogs(job.assetId).map((entry) => entry.stage)).toEqual([
    'generation', 'generation', 'generation', 'generation', 'verification', 'verification', 'retry',
    'generation', 'generation', 'verification', 'verification', 'system',
  ]);
  expect(database.listGenerationLogs(job.assetId).find((entry) => entry.details)?.details).toEqual({
    tool: 'registry.search_assets', arguments: { query: 'łąka', category: 'flat_tile', limit: 3 },
  });
  const referenceLog = database.listGenerationLogs(job.assetId)
    .find((entry) => entry.details?.tool === 'registry.get_reference');
  expect(referenceLog?.message).toContain('Wzór miękkiej, malowanej faktury trawy');
  expect(referenceLog?.message).not.toContain(reference.id);
  await queue.shutdown();
  database.close();
});

it('generuje pełny kwadrat top-down i ponawia go na prostokątnej siatce', async () => {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-top-down-')), 'project');
  temporaryDirectories.push(path.dirname(root));
  mkdirSync(root);
  const database = ProjectDatabase.create(root, {
    name: 'Top-down', artBrief: 'Czytelna trawa z góry', projection: 'top_down', tileWidthPx: 64,
  });
  let turns = 0;
  let generationPrompt = '';
  let retryPrompt = '';
  const fakeCodex = {
    runExclusive: async <T>(operation: () => Promise<T>) => operation(),
    ensureAssetThread: async () => 'thread-top-down',
    skillPath: () => '/Applications/ChatGPT.app/imagegen/SKILL.md',
    interruptActiveTurn: async () => undefined,
    runTurn: async (_threadId: string, input: Array<Record<string, unknown>>) => {
      turns += 1;
      const prompt = String(input[0].text);
      if (turns === 1) generationPrompt = prompt;
      else retryPrompt = prompt;
      const outputPath = prompt.match(/exactly (.+?final\.png)/i)?.[1];
      if (!outputPath) throw new Error('Test nie znalazł ścieżki final.png w prompcie.');
      mkdirSync(path.dirname(outputPath), { recursive: true });
      if (turns === 1) {
        await sharp({
          create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
        }).composite([{ input: Buffer.from('<svg width="60" height="60"><rect width="60" height="60" fill="#5b9249"/></svg>'), left: 2, top: 2 }])
          .png().toFile(outputPath);
      } else {
        await sharp({
          create: { width: 64, height: 64, channels: 3, background: { r: 91, g: 146, b: 73 } },
        }).png().toFile(outputPath);
      }
      return {
        turnId: `turn-top-down-${turns}`,
        items: [],
        finalMessage: JSON.stringify({
          status: 'completed', finalPath: outputPath, category: 'flat_tile', tags: ['trawa'],
          pivot: { x: 0.5, y: 0.5 }, description: 'Trawiasty teren top-down', message: '',
        }),
      };
    },
  } as unknown as CodexService;
  const queue = new GenerationQueue(fakeCodex);
  queue.attach(database);
  const terminal = new Promise<GenerationEvent>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Kolejka nie zakończyła top-down joba.')), 10_000);
    queue.on('event', (event: GenerationEvent) => {
      if (event.type === 'completed' || event.type === 'failed') {
        clearTimeout(timeout);
        resolve(event);
      }
    });
  });
  const job = queue.enqueue({
    name: 'Łąka z góry', prompt: '', mode: 'generate', category: 'flat_tile', footprint: { x: 1, y: 1 },
  });

  const terminalEvent = await terminal;
  if (terminalEvent.type === 'failed') throw new Error(terminalEvent.message);
  expect(terminalEvent).toMatchObject({ type: 'completed', jobId: job.id });
  expect(turns).toBe(2);
  expect(generationPrompt).toContain('orthographic top-down');
  expect(generationPrompt).toContain('fixed 1:1 orthogonal grid');
  expect(generationPrompt).toContain('left edge must match the right edge pixel-for-pixel');
  expect(generationPrompt).toContain('does not require transparency');
  expect(generationPrompt).not.toContain('isometric diamond');
  expect(retryPrompt).toContain('regular orthogonal grid');
  expect(retryPrompt).toContain('Match left to right and top to bottom');
  expect(database.getAsset(job.assetId)?.versions[0]).toMatchObject({
    width: 64, height: 64, status: 'needs_review',
  });

  await queue.shutdown();
  database.close();
});

it('pomija weryfikację i automatyczną korektę AI, zachowując kontrolę techniczną', async () => {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-no-ai-verification-')), 'project');
  temporaryDirectories.push(path.dirname(root));
  mkdirSync(root);
  const database = ProjectDatabase.create(root, {
    name: 'Bez weryfikacji AI', artBrief: '', tileWidthPx: 64,
  });
  database.updateProjectSettings({
    name: 'Bez weryfikacji AI', artBrief: '', tileWidthPx: 64, pixelsPerUnit: 64,
    maxConcurrentJobs: 1, aiVerificationEnabled: false,
  });
  let turns = 0;
  let generationPrompt = '';
  const fakeCodex = {
    runExclusive: async <T>(operation: () => Promise<T>) => operation(),
    ensureAssetThread: async () => 'thread-no-ai-verification',
    skillPath: () => 'C:\\imagegen\\SKILL.md',
    interruptActiveTurn: async () => undefined,
    runTurn: async (_threadId: string, input: Array<Record<string, unknown>>) => {
      turns += 1;
      generationPrompt = String(input[0].text);
      const outputPath = generationPrompt.match(/exactly (.+?final\.png)/i)?.[1];
      if (!outputPath) throw new Error('Test nie znalazł ścieżki final.png w prompcie.');
      mkdirSync(path.dirname(outputPath), { recursive: true });
      const svg = '<svg width="56" height="26"><polygon points="28,0 56,13 28,26 0,13" fill="#75a842"/></svg>';
      await sharp({ create: { width: 64, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: Buffer.from(svg), left: 4, top: 3 }]).png().toFile(outputPath);
      return {
        turnId: 'turn-no-ai-verification',
        items: [],
        finalMessage: JSON.stringify({
          status: 'completed', finalPath: outputPath, category: 'flat_tile', tags: ['trawa'],
          pivot: { x: 0.5, y: 0.5 }, description: 'Trawiasty teren', message: '',
        }),
      };
    },
  } as unknown as CodexService;
  const queue = new GenerationQueue(fakeCodex);
  queue.attach(database);
  const terminal = new Promise<GenerationEvent>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Kolejka nie zakończyła testowego joba.')), 10_000);
    queue.on('event', (event: GenerationEvent) => {
      if (event.type === 'completed' || event.type === 'failed') {
        clearTimeout(timeout);
        resolve(event);
      }
    });
  });
  const job = queue.enqueue({
    name: 'Łąka bez kontroli AI', prompt: '', mode: 'generate', category: 'flat_tile', footprint: { x: 1, y: 1 },
  });

  await expect(terminal).resolves.toMatchObject({ type: 'failed', jobId: job.id });
  expect(turns).toBe(1);
  expect(generationPrompt).toContain('AI verification is disabled by project settings');
  expect(generationPrompt).not.toContain('build an exact 3x3 repeat');
  expect(database.listGenerationLogs(job.assetId).some((entry) => entry.stage === 'retry')).toBe(false);
  expect(database.getJob(job.id)?.error).toContain('nie wypełnia komórki');
  expect(database.getJob(job.id)?.error).toContain('nie uruchomiono automatycznej korekty');

  await queue.shutdown();
  database.close();
});

it('zapisuje pominiętą kontrolę AI i pozwala uruchomić ją ręcznie dla gotowego obrazu', async () => {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-manual-ai-verification-')), 'project');
  temporaryDirectories.push(path.dirname(root));
  mkdirSync(root);
  const database = ProjectDatabase.create(root, {
    name: 'Ręczna weryfikacja AI', artBrief: 'Miękkie malarskie krawędzie',
    projection: 'top_down', tileWidthPx: 64,
  });
  database.updateProjectSettings({
    name: 'Ręczna weryfikacja AI', artBrief: 'Miękkie malarskie krawędzie', tileWidthPx: 64,
    pixelsPerUnit: 64, maxConcurrentJobs: 1, aiVerificationEnabled: false,
  });
  let turns = 0;
  let verificationInput: Array<Record<string, unknown>> = [];
  const fakeCodex = {
    runExclusive: async <T>(operation: () => Promise<T>) => operation(),
    ensureAssetThread: async () => 'thread-manual-ai-verification',
    skillPath: () => 'C:\\imagegen\\SKILL.md',
    interruptActiveTurn: async () => undefined,
    runTurn: async (_threadId: string, input: Array<Record<string, unknown>>) => {
      turns += 1;
      if (turns === 2) {
        verificationInput = input;
        return {
          turnId: 'turn-verification', items: [],
          finalMessage: JSON.stringify({ status: 'passed', message: 'Asset jest zgodny z briefem i stylem.' }),
        };
      }
      const prompt = String(input[0].text);
      const outputPath = prompt.match(/exactly (.+?final\.png)/i)?.[1];
      if (!outputPath) throw new Error('Test nie znalazł ścieżki final.png w prompcie.');
      mkdirSync(path.dirname(outputPath), { recursive: true });
      const svg = '<svg width="16" height="16"><rect x="3" y="3" width="10" height="10" fill="#5a8c46"/></svg>';
      await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: Buffer.from(svg) }]).png().toFile(outputPath);
      return {
        turnId: 'turn-generation', items: [],
        finalMessage: JSON.stringify({
          status: 'completed', finalPath: outputPath, category: 'other', tags: ['test'],
          pivot: { x: 0.5, y: 0.5 }, description: 'Testowy asset', message: '',
        }),
      };
    },
  } as unknown as CodexService;
  const queue = new GenerationQueue(fakeCodex);
  queue.attach(database);
  const terminal = new Promise<GenerationEvent>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Kolejka nie zakończyła testowego joba.')), 10_000);
    queue.on('event', (event: GenerationEvent) => {
      if (event.type === 'completed' || event.type === 'failed') {
        clearTimeout(timeout);
        resolve(event);
      }
    });
  });
  const job = queue.enqueue({
    name: 'Kamień', prompt: 'Zielony kamień', mode: 'generate', category: 'other', footprint: { x: 1, y: 1 },
  });

  await expect(terminal).resolves.toMatchObject({ type: 'completed', jobId: job.id });
  expect(database.getAsset(job.assetId)?.versions[0]).toMatchObject({ aiVerificationStatus: 'pending' });

  const verified = await queue.verify(job.versionId);
  expect(verified.versions[0]).toMatchObject({
    aiVerificationStatus: 'passed', aiVerificationMessage: 'Asset jest zgodny z briefem i stylem.',
  });
  expect(turns).toBe(2);
  expect(verificationInput.some((item) => item.type === 'localImage')).toBe(true);
  expect(verificationInput.some((item) => item.type === 'skill')).toBe(false);
  expect(String(verificationInput[0].text)).toContain('Nie generuj ani nie edytuj obrazu');
  expect(String(verificationInput[0].text)).toContain('Oczekiwana projekcja: top-down 1:1');
  expect(String(verificationInput[0].text)).toContain('Odrzuć perspektywę izometryczną');
  expect(database.listGenerationLogs(job.assetId).at(-1)).toMatchObject({
    stage: 'verification', level: 'success', attempt: 0,
  });

  await queue.shutdown();
  database.close();
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Przekroczono czas oczekiwania na stan testu.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it('generuje i waliduje elevated terrain na canvasie wyższym od komórki siatki', async () => {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-elevated-')), 'project');
  temporaryDirectories.push(path.dirname(root));
  mkdirSync(root);
  const database = ProjectDatabase.create(root, {
    name: 'Elevated',
    artBrief: 'Malowane wyspy',
    tileWidthPx: 64,
  });
  let generationPrompt = '';
  const fakeCodex = {
    runExclusive: async <T>(operation: () => Promise<T>) => operation(),
    ensureAssetThread: async () => 'thread-elevated',
    skillPath: () => 'C:\\imagegen\\SKILL.md',
    interruptActiveTurn: async () => undefined,
    runTurn: async (_threadId: string, input: Array<Record<string, unknown>>) => {
      generationPrompt = String(input[0].text);
      const outputPath = generationPrompt.match(/exactly (.+?final\.png)/i)?.[1];
      if (!outputPath) throw new Error('Test nie znalazł ścieżki final.png w prompcie.');
      mkdirSync(path.dirname(outputPath), { recursive: true });
      const svg = '<svg width="64" height="96">'
        + '<polygon points="32,0 64,16 32,32 0,16" fill="#75a842"/>'
        + '<polygon points="0,16 32,32 32,96 0,80" fill="#6d4b2c"/>'
        + '<polygon points="32,32 64,16 64,80 32,96" fill="#523823"/>'
        + '</svg>';
      await sharp({ create: { width: 64, height: 96, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: Buffer.from(svg) }])
        .png().toFile(outputPath);
      return {
        turnId: 'turn-elevated',
        items: [],
        finalMessage: JSON.stringify({
          status: 'completed', finalPath: outputPath, category: 'elevated_tile', tags: ['wyspa'],
          pivot: { x: 0.5, y: 0.833333 }, description: 'Podniesiony blok terenu', message: '',
        }),
      };
    },
  } as unknown as CodexService;
  const queue = new GenerationQueue(fakeCodex);
  queue.attach(database);
  const terminal = new Promise<GenerationEvent>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Kolejka nie zakończyła elevated joba.')), 10_000);
    queue.on('event', (event: GenerationEvent) => {
      if (event.type === 'completed' || event.type === 'failed') {
        clearTimeout(timeout);
        resolve(event);
      }
    });
  });
  const job = queue.enqueue({
    name: 'Wyspa', prompt: '', mode: 'generate', category: 'elevated_tile', elevationLevels: 2, footprint: { x: 1, y: 1 },
  });

  await expect(terminal).resolves.toMatchObject({ type: 'completed', jobId: job.id });
  expect(generationPrompt).toContain('ELEVATED TILE with elevation height 2');
  expect(generationPrompt).toContain('64x96px');
  expect(generationPrompt).toContain('walls descending 64px');
  expect(generationPrompt).toContain('without overlap, gaps, steps, bulges, or exposed wall pixels');
  expect(generationPrompt).toContain('no visible grid');
  expect(database.getAsset(job.assetId)?.versions[0]).toMatchObject({
    width: 64, height: 96, elevationLevels: 2, pivot: { x: 0.5, y: 0.833333 }, status: 'needs_review',
  });
  await queue.shutdown();
  database.close();
});

it('automatycznie poprawia i zapisuje kompletny zestaw 16 road tile', async () => {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-road-')), 'project');
  temporaryDirectories.push(path.dirname(root));
  mkdirSync(root);
  const database = ProjectDatabase.create(root, {
    name: 'Drogi', artBrief: 'Ciepłe malarskie materiały', tileWidthPx: 64,
  });
  let turns = 0;
  let generationPrompt = '';
  let retryPrompt = '';
  let roadTimeoutMs = 0;
  const fakeCodex = {
    runExclusive: async <T>(operation: () => Promise<T>) => operation(),
    ensureAssetThread: async () => 'thread-road',
    skillPath: () => 'C:\\imagegen\\SKILL.md',
    interruptActiveTurn: async () => undefined,
    runTurn: async (
      _threadId: string,
      input: Array<Record<string, unknown>>,
      _outputSchema: Record<string, unknown>,
      _onEvent?: unknown,
      timeoutMs?: number,
    ) => {
      turns += 1;
      roadTimeoutMs = timeoutMs ?? 0;
      const prompt = String(input[0].text);
      if (turns === 1) generationPrompt = prompt;
      else retryPrompt = prompt;
      const roadMaterialPath = [...prompt.matchAll(/(?:exactly|use) ((?:[A-Za-z]:\\|\/)[^\r\n]*?road-material\.png)/gi)].at(-1)?.[1];
      if (!roadMaterialPath) throw new Error('Test nie znalazł ścieżki road-material.png w prompcie.');
      const outputDirectory = path.dirname(roadMaterialPath);
      mkdirSync(outputDirectory, { recursive: true });
      if (turns === 1) {
        await sharp({ create: { width: 384, height: 192, channels: 3, background: { r: 0, g: 255, b: 0 } } })
          .png().toFile(roadMaterialPath);
      } else {
        await sharp({ create: { width: 384, height: 192, channels: 3, background: { r: 199, g: 143, b: 72 } } })
          .composite([{ input: Buffer.from(
            '<svg width="384" height="192"><g fill="#e7b66c" opacity=".65"><circle cx="70" cy="45" r="18"/><circle cx="270" cy="130" r="25"/><path d="M0 155 Q105 115 205 170 T384 145 V192 H0Z"/></g></svg>',
          ) }])
          .png().toFile(roadMaterialPath);
      }
      return {
        turnId: `turn-road-${turns}`,
        items: [],
        finalMessage: JSON.stringify({
          status: 'completed', finalPath: roadMaterialPath, category: 'road_tile', tags: ['droga', 'piasek'],
          pivot: { x: 0.5, y: 0.5 }, description: 'Kompletny zestaw piaskowej drogi', message: '',
        }),
      };
    },
  } as unknown as CodexService;
  const queue = new GenerationQueue(fakeCodex);
  queue.attach(database);
  const terminal = new Promise<GenerationEvent>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Kolejka nie zakończyła road joba.')), 10_000);
    queue.on('event', (event: GenerationEvent) => {
      if (event.type === 'completed' || event.type === 'failed') {
        clearTimeout(timeout);
        resolve(event);
      }
    });
  });
  const job = queue.enqueue({
    name: 'Piaskowa droga', prompt: '', mode: 'generate', category: 'road_tile',
    footprint: { x: 1, y: 1 },
  });

  await expect(terminal).resolves.toMatchObject({ type: 'completed', jobId: job.id });
  expect(turns).toBe(2);
  expect(generationPrompt).toContain('ROAD SURFACE MATERIAL SOURCE');
  expect(generationPrompt).toContain('must not design any road layout');
  expect(generationPrompt).toContain('opaque, full-frame material swatch');
  expect(generationPrompt).toContain('do not build an atlas or any road variants');
  expect(generationPrompt).toContain('do not enter the imagegen transparent-output workflow');
  expect(generationPrompt).toContain('A request such as "without background" applies to the final derived road overlays');
  expect(roadTimeoutMs).toBe(25 * 60_000);
  expect(retryPrompt).toContain('generate a replacement opaque road-surface material swatch');
  expect(retryPrompt).toContain('Do not run transparent-output, chroma-key or alpha-helper workflows');
  expect(database.getAsset(job.assetId)).toMatchObject({
    category: 'road_tile', roadConnections: 15,
    versions: [expect.objectContaining({
      width: 64, height: 32, roadConnections: 15, status: 'needs_review',
      roadVariants: expect.arrayContaining([
        expect.objectContaining({ connectionMask: 0 }),
        expect.objectContaining({ connectionMask: 7 }),
        expect.objectContaining({ connectionMask: 15 }),
      ]),
    })],
  });
  expect(database.getAsset(job.assetId)?.versions[0].roadVariants).toHaveLength(16);
  await queue.shutdown();
  database.close();
});

it('tworzy warianty tylko dla generatorów wybranych przy nowym assecie i zapamiętuje wybór', async () => {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-provider-fanout-')), 'project');
  temporaryDirectories.push(path.dirname(root));
  mkdirSync(root);
  const database = ProjectDatabase.create(root, {
    name: 'Warianty providerów', artBrief: '', tileWidthPx: 64,
  });
  database.updateProjectSettings({
    name: 'Warianty providerów', artBrief: '', tileWidthPx: 64, pixelsPerUnit: 64,
    maxConcurrentJobs: 1, aiVerificationEnabled: true,
    codexGenerationEnabled: true, comfyUiEnabled: true, comfyUiProfile: 'z_image_turbo',
    stableDiffusionCppEnabled: true,
  });
  const fakeCodex = {
    health: () => ({ state: 'unavailable', message: 'Test zatrzymuje wykonanie po enqueue.' }),
  } as unknown as CodexService;
  const fakeComfy = {
    health: () => ({ state: 'unavailable', message: 'Test zatrzymuje wykonanie po enqueue.' }),
  };
  const fakeStableDiffusionCpp = {
    health: () => ({ state: 'unavailable', message: 'Test zatrzymuje wykonanie po enqueue.' }),
  };
  const queue = new GenerationQueue(fakeCodex, undefined, fakeComfy as never, fakeStableDiffusionCpp as never);
  queue.attach(database);

  const jobs = queue.enqueueEnabled({
    name: 'Trzy chaty', prompt: 'Drewniana chata', mode: 'generate', category: 'building',
    relativeWidth: 2, relativeHeight: 2, footprint: { x: 2, y: 2 },
    generatorProviders: ['codex', 'stable_diffusion_cpp'],
  });

  expect(jobs).toHaveLength(2);
  expect(jobs.map((job) => job.generatorProvider)).toEqual(['codex', 'stable_diffusion_cpp']);
  expect(new Set(jobs.map((job) => job.assetId))).toEqual(new Set([jobs[0].assetId]));
  expect(database.getAsset(jobs[0].assetId)?.versions.map((version) => version.generatorProvider).sort())
    .toEqual(['codex', 'stable_diffusion_cpp'].sort());
  expect(database.getAsset(jobs[0].assetId)?.versions.map((version) => version.footprint))
    .toEqual([{ x: 2, y: 2 }, { x: 2, y: 2 }]);
  expect(database.getProject()).toMatchObject({
    codexGenerationEnabled: true,
    comfyUiEnabled: false,
    stableDiffusionCppEnabled: true,
  });
  await queue.shutdown();
  database.close();
});

it('używa zapamiętanego zestawu dla kolejnego assetu, lecz iterację ogranicza do providera parenta', async () => {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-provider-memory-')), 'project');
  temporaryDirectories.push(path.dirname(root));
  mkdirSync(root);
  const database = ProjectDatabase.create(root, {
    name: 'Pamięć providerów', artBrief: '', tileWidthPx: 64,
  });
  database.setNewAssetGeneratorProviders(['comfyui', 'stable_diffusion_cpp']);
  const unavailable = { health: () => ({ state: 'unavailable', message: 'Test enqueue.' }) };
  const queue = new GenerationQueue(
    unavailable as unknown as CodexService,
    undefined,
    unavailable as never,
    unavailable as never,
  );
  queue.attach(database);

  const initialJobs = queue.enqueueEnabled({
    name: 'Kuźnia', prompt: '', mode: 'generate', category: 'building',
    footprint: { x: 2, y: 2 },
  });
  expect(initialJobs.map((job) => job.generatorProvider)).toEqual(['comfyui', 'stable_diffusion_cpp']);
  const comfyParent = initialJobs.find((job) => job.generatorProvider === 'comfyui')!;

  const iterationJobs = queue.enqueueEnabled({
    assetId: comfyParent.assetId,
    parentVersionId: comfyParent.versionId,
    name: 'Kuźnia', prompt: '', feedback: 'Więcej sadzy', mode: 'edit', category: 'building',
    footprint: { x: 2, y: 2 },
  });
  expect(iterationJobs).toHaveLength(1);
  expect(iterationJobs[0].generatorProvider).toBe('comfyui');
  expect(database.getProject()).toMatchObject({
    codexGenerationEnabled: false,
    comfyUiEnabled: true,
    stableDiffusionCppEnabled: true,
  });

  await queue.shutdown();
  database.close();
});

it('wycofuje cały fan-out i preferencje bez zdarzeń, gdy zawiedzie wersja lub zapis wyboru', async () => {
  for (const failure of ['second-version', 'preferences'] as const) {
    const root = path.join(mkdtempSync(path.join(os.tmpdir(), `tilemap-generator-atomic-${failure}-`)), 'project');
    temporaryDirectories.push(path.dirname(root));
    mkdirSync(root);
    const database = ProjectDatabase.create(root, {
      name: 'Atomowy fan-out', artBrief: '', tileWidthPx: 64,
    });
    if (failure === 'second-version') {
      database.sqlite.exec(`
        CREATE TRIGGER inject_second_version_failure
        BEFORE INSERT ON asset_versions
        WHEN NEW.generator_provider = 'stable_diffusion_cpp'
        BEGIN
          SELECT RAISE(ABORT, 'injected second enqueue failure');
        END;
      `);
    } else {
      database.sqlite.exec(`
        CREATE TRIGGER inject_preference_failure
        BEFORE UPDATE OF codex_generation_enabled, comfyui_enabled, stable_diffusion_cpp_enabled ON projects
        BEGIN
          SELECT RAISE(ABORT, 'injected preference failure');
        END;
      `);
    }
    const unavailable = { health: () => ({ state: 'unavailable', message: 'Test enqueue.' }) };
    const queue = new GenerationQueue(
      unavailable as unknown as CodexService,
      undefined,
      unavailable as never,
      unavailable as never,
    );
    const pump = vi.spyOn(queue as unknown as { pump(): Promise<void> }, 'pump');
    queue.attach(database);
    pump.mockClear();
    const events: GenerationEvent[] = [];
    queue.on('event', (event: GenerationEvent) => events.push(event));

    expect(() => queue.enqueueEnabled({
      name: 'Kuźnia', prompt: '', mode: 'generate', category: 'building',
      footprint: { x: 2, y: 2 },
      generatorProviders: ['comfyui', 'stable_diffusion_cpp'],
    })).toThrow(failure === 'second-version' ? /second enqueue failure/ : /preference failure/);

    for (const table of ['assets', 'asset_versions', 'generation_jobs']) {
      expect(database.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get())
        .toMatchObject({ count: 0 });
    }
    expect(database.getProject()).toMatchObject({
      codexGenerationEnabled: true,
      comfyUiEnabled: false,
      stableDiffusionCppEnabled: false,
    });
    expect(events).toEqual([]);
    expect(pump).not.toHaveBeenCalled();

    await queue.shutdown();
    database.close();
  }
});

it('publikuje postać dopiero po obowiązkowej analizie ruchu we wszystkich kierunkach', async () => {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-character-')), 'project');
  temporaryDirectories.push(path.dirname(root));
  mkdirSync(root);
  const database = ProjectDatabase.create(root, {
    name: 'Postać izometryczna', artBrief: 'Czytelna bohaterka', tileWidthPx: 32,
    characterFramesPerDirection: PROJECT_CHARACTER_FRAMES,
  });
  database.updateProjectSettings({
    name: 'Postać izometryczna', artBrief: 'Czytelna bohaterka', tileWidthPx: 32,
    pixelsPerUnit: 32, characterFramesPerDirection: PROJECT_CHARACTER_FRAMES,
    maxConcurrentJobs: 1, aiVerificationEnabled: false,
  });
  const turnKinds: string[] = [];
  let generationPrompt = '';
  let analysisPrompt = '';
  let analysisImages: Array<Record<string, unknown>> = [];
  let analysisSawFinalOutput = true;
  const fakeCodex = {
    health: () => ({ state: 'ready', message: 'Gotowy' }),
    runExclusive: async <T>(operation: () => Promise<T>) => operation(),
    ensureAssetThread: async () => 'thread-character-generation',
    startUtilityThread: async () => 'thread-character-analysis',
    skillPath: () => '/Applications/ChatGPT.app/imagegen/SKILL.md',
    interruptActiveTurn: async () => undefined,
    runTurn: async (_threadId: string, input: Array<Record<string, unknown>>) => {
      const isGeneration = input.some((item) => item.type === 'skill');
      turnKinds.push(isGeneration ? 'generation' : 'analysis');
      if (isGeneration) {
        generationPrompt = String(input[0].text);
        const outputPath = generationPrompt.match(/exactly (.+?final\.png)/i)?.[1];
        if (!outputPath) throw new Error('Test nie znalazł final.png w prompcie postaci.');
        await writeCharacterSheet(outputPath, 32, 32, PROJECT_CHARACTER_FRAMES);
        return {
          turnId: 'turn-character-generation', items: [],
          finalMessage: JSON.stringify({
            status: 'completed', finalPath: outputPath, category: 'character', tags: ['bohaterka'],
            pivot: { x: 0.5, y: 0 }, description: 'Bohaterka z pełnym chodem', message: '',
          }),
        };
      }
      analysisPrompt = String(input[0].text);
      analysisImages = input.filter((item) => item.type === 'localImage');
      analysisSawFinalOutput = database.listAssets()[0]?.latestVersion?.finalPath !== null;
      return {
        turnId: 'turn-character-analysis', items: [],
        finalMessage: JSON.stringify(passedMovementAnalysis([
          'north_west', 'north_east', 'south_east', 'south_west',
        ])),
      };
    },
  } as unknown as CodexService;
  const queue = new GenerationQueue(fakeCodex);
  queue.attach(database);
  const terminal = waitForGenerationTerminal(queue);
  const job = queue.enqueue({
    name: 'Bohaterka', prompt: 'Czerwona peleryna', mode: 'generate', category: 'character',
    relativeWidth: 1, relativeHeight: 2, footprint: { x: 1, y: 1 },
    characterAnimation: { action: 'walk', framesPerDirection: PROJECT_CHARACTER_FRAMES, framesPerSecond: 8 },
  });

  const terminalEvent = await terminal;
  if (terminalEvent.type === 'failed') throw new Error(terminalEvent.message);
  expect(terminalEvent).toMatchObject({ type: 'completed', jobId: job.id });
  expect(turnKinds).toEqual(['generation', 'analysis']);
  expect(analysisSawFinalOutput).toBe(false);
  expect(generationPrompt).toContain('exactly 288x128px with 9 columns and 4 rows');
  expect(generationPrompt).toContain('exactly 8 walk-frame columns per direction');
  expect(generationPrompt).toContain('overrides any additional request for a one-off action pose');
  expect(generationPrompt).toContain('Held or worn equipment explicitly belonging to the character is allowed');
  expect(generationPrompt).toContain('Imagegen may return a supported native canvas size');
  expect(generationPrompt).toContain('Use exactly one built-in image generation call');
  expect(generationPrompt).toContain('never from the preview or from RGB values hidden under alpha=0');
  expect(generationPrompt).toContain('Do not make a second image-generation/edit call');
  expect(generationPrompt).toContain('NW (north_west), NE (north_east), SE (south_east), SW (south_west)');
  expect(generationPrompt).toContain('separate mandatory read-only motion-analysis turn');
  expect(analysisPrompt).toContain('wyłącznie odczytową analizę animacji ruchu postaci');
  expect(analysisPrompt).toContain('W8→W1');
  expect(analysisPrompt).toContain('wszystkie 8 klatek chodu');
  expect(analysisPrompt).toContain('NW (north_west), NE (north_east), SE (south_east), SW (south_west)');
  expect(analysisImages).toHaveLength(6);
  expect(database.getAsset(job.assetId)?.versions[0]).toMatchObject({
    status: 'needs_review', width: 288, height: 128, aiVerificationStatus: 'passed',
    pivot: { x: 0.5, y: 0.125 },
    characterAnimation: {
      settings: { action: 'walk', framesPerDirection: PROJECT_CHARACTER_FRAMES, framesPerSecond: 8 },
      frameSize: { width: 32, height: 32 },
      sheetSize: { width: 288, height: 128 },
      movementAnalysis: {
        status: 'passed', turnId: 'turn-character-analysis',
        directions: [
          { direction: 'north_west', status: 'passed' },
          { direction: 'north_east', status: 'passed' },
          { direction: 'south_east', status: 'passed' },
          { direction: 'south_west', status: 'passed' },
        ],
      },
    },
  });
  await queue.shutdown();
  database.close();
});

it('ponawia samą analizę ruchu po błędzie technicznym bez ponownego generowania arkusza', async () => {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-character-analysis-retry-')), 'project');
  temporaryDirectories.push(path.dirname(root));
  mkdirSync(root);
  const database = ProjectDatabase.create(root, {
    name: 'Retry analizatora postaci', artBrief: '', projection: 'top_down', tileWidthPx: 32,
    characterFramesPerDirection: CHARACTER_FIXTURE_FRAMES,
  });
  let generationTurns = 0;
  let analysisTurns = 0;
  const fakeCodex = {
    health: () => ({ state: 'ready', message: 'Gotowy' }),
    runExclusive: async <T>(operation: () => Promise<T>) => operation(),
    ensureAssetThread: async () => 'thread-character-analysis-retry',
    startUtilityThread: async () => `thread-character-analysis-retry-${analysisTurns + 1}`,
    skillPath: () => '/Applications/ChatGPT.app/imagegen/SKILL.md',
    interruptActiveTurn: async () => undefined,
    runTurn: async (_threadId: string, input: Array<Record<string, unknown>>) => {
      if (input.some((item) => item.type === 'skill')) {
        generationTurns += 1;
        const prompt = String(input[0].text);
        const outputPath = prompt.match(/exactly (.+?final\.png)/i)?.[1];
        if (!outputPath) throw new Error('Test nie znalazł final.png w prompcie postaci.');
        await writeCharacterSheet(outputPath, 32, 32);
        return {
          turnId: 'turn-character-analysis-retry-generation', items: [],
          finalMessage: JSON.stringify({
            status: 'completed', finalPath: outputPath, category: 'character', tags: [],
            pivot: { x: 0.5, y: 0 }, description: 'Postać', message: '',
          }),
        };
      }
      analysisTurns += 1;
      return {
        turnId: `turn-character-analysis-retry-${analysisTurns}`, items: [],
        finalMessage: analysisTurns === 1
          ? '{"status":"passed","summary":"niepełny raport"}'
          : JSON.stringify(passedMovementAnalysis(['north', 'east', 'south', 'west'])),
      };
    },
  } as unknown as CodexService;
  const queue = new GenerationQueue(fakeCodex);
  queue.attach(database);
  const terminal = waitForGenerationTerminal(queue);
  const job = queue.enqueue({
    name: 'Zwiadowca', prompt: '', mode: 'generate', category: 'character',
    relativeWidth: 1, relativeHeight: 1, footprint: { x: 1, y: 1 },
    characterAnimation: { action: 'walk', framesPerDirection: CHARACTER_FIXTURE_FRAMES, framesPerSecond: 8 },
  });

  await expect(terminal).resolves.toMatchObject({ type: 'completed', jobId: job.id });
  expect(generationTurns).toBe(1);
  expect(analysisTurns).toBe(2);
  expect(database.listGenerationLogs(job.assetId).some((entry) => (
    entry.stage === 'retry' && entry.message.includes('Ponawiam samą analizę')
  ))).toBe(true);
  expect(database.getJob(job.id)?.status).toBe('needs_review');
  await queue.shutdown();
  database.close();
});

it('ponawia arkusz postaci po odrzuceniu jednego kierunku przez analizatora', async () => {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-character-retry-')), 'project');
  temporaryDirectories.push(path.dirname(root));
  mkdirSync(root);
  const database = ProjectDatabase.create(root, {
    name: 'Postać top-down', artBrief: '', projection: 'top_down', tileWidthPx: 32,
    characterFramesPerDirection: CHARACTER_FIXTURE_FRAMES,
  });
  let generationTurns = 0;
  let analysisTurns = 0;
  let retryPrompt = '';
  let sawPersistedRejectionBeforeRetry = false;
  const fakeCodex = {
    health: () => ({ state: 'ready', message: 'Gotowy' }),
    runExclusive: async <T>(operation: () => Promise<T>) => operation(),
    ensureAssetThread: async () => 'thread-character-top-down',
    startUtilityThread: async () => `thread-character-analysis-${analysisTurns + 1}`,
    skillPath: () => '/Applications/ChatGPT.app/imagegen/SKILL.md',
    interruptActiveTurn: async () => undefined,
    runTurn: async (_threadId: string, input: Array<Record<string, unknown>>) => {
      if (input.some((item) => item.type === 'skill')) {
        generationTurns += 1;
        const prompt = String(input[0].text);
        if (generationTurns === 2) {
          retryPrompt = prompt;
          sawPersistedRejectionBeforeRetry = database.getAsset(database.listAssets()[0].id)
            ?.versions[0].characterAnimation?.movementAnalysis.status === 'failed';
        }
        const outputPath = prompt.match(/exactly (.+?final\.png)/i)?.[1];
        if (!outputPath) throw new Error('Test nie znalazł final.png w prompcie retry postaci.');
        await writeCharacterSheet(outputPath, 32, 32);
        return {
          turnId: `turn-character-generation-${generationTurns}`, items: [],
          finalMessage: JSON.stringify({
            status: 'completed', finalPath: outputPath, category: 'character', tags: [],
            pivot: { x: 0.5, y: 0 }, description: 'Postać top-down', message: '',
          }),
        };
      }
      analysisTurns += 1;
      const result = passedMovementAnalysis(['north', 'east', 'south', 'west']);
      if (analysisTurns === 1) {
        result.status = 'failed';
        result.summary = 'Kierunek zachodni ma ślizg stóp.';
        result.directions[3] = {
          direction: 'west', status: 'failed', message: 'Stopa przesuwa się po podłożu między W2 i W3.',
        };
      }
      return {
        turnId: `turn-character-analysis-${analysisTurns}`, items: [], finalMessage: JSON.stringify(result),
      };
    },
  } as unknown as CodexService;
  const queue = new GenerationQueue(fakeCodex);
  queue.attach(database);
  const terminal = waitForGenerationTerminal(queue);
  const job = queue.enqueue({
    name: 'Łowca', prompt: '', mode: 'generate', category: 'character',
    relativeWidth: 1, relativeHeight: 1, footprint: { x: 1, y: 1 },
    characterAnimation: { action: 'walk', framesPerDirection: CHARACTER_FIXTURE_FRAMES, framesPerSecond: 10 },
  });

  const terminalEvent = await terminal;
  if (terminalEvent.type === 'failed') throw new Error(terminalEvent.message);
  expect(terminalEvent).toMatchObject({ type: 'completed', jobId: job.id });
  expect(generationTurns).toBe(2);
  expect(analysisTurns).toBe(2);
  expect(sawPersistedRejectionBeforeRetry).toBe(true);
  expect(retryPrompt).toContain('Kierunek zachodni ma ślizg stóp.');
  expect(retryPrompt).toContain('west: Stopa przesuwa się po podłożu');
  expect(retryPrompt).toContain('N (north), E (east), S (south), W (west)');
  expect(database.getAsset(job.assetId)?.versions[0].characterAnimation?.movementAnalysis.status).toBe('passed');
  expect(database.listGenerationLogs(job.assetId).some((entry) => entry.stage === 'retry')).toBe(true);
  await queue.shutdown();
  database.close();
});

it('samodzielnie ponawia postać po needs_user_decision i odrzuceniu źródła bez alfa', async () => {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-character-contract-retry-')), 'project');
  temporaryDirectories.push(path.dirname(root));
  mkdirSync(root);
  const database = ProjectDatabase.create(root, {
    name: 'Retry kontraktu postaci', artBrief: '', projection: 'top_down', tileWidthPx: 32,
    characterFramesPerDirection: CHARACTER_FIXTURE_FRAMES,
  });
  database.createProjectSettingsProposal({
    reason: 'Stara, niezwiązana propozycja pozostaje do późniejszego rozpatrzenia.',
    settings: { pixelsPerUnit: 16 },
    referenceIds: [],
  });
  let generationTurns = 0;
  let analysisTurns = 0;
  let retryPrompt = '';
  let retryImages: Array<Record<string, unknown>> = [];
  const fakeCodex = {
    health: () => ({ state: 'ready', message: 'Gotowy' }),
    runExclusive: async <T>(operation: () => Promise<T>) => operation(),
    ensureAssetThread: async () => 'thread-character-contract-retry',
    startUtilityThread: async () => 'thread-character-contract-analysis',
    skillPath: () => '/Applications/ChatGPT.app/imagegen/SKILL.md',
    interruptActiveTurn: async () => undefined,
    runTurn: async (_threadId: string, input: Array<Record<string, unknown>>) => {
      if (!input.some((item) => item.type === 'skill')) {
        analysisTurns += 1;
        return {
          turnId: 'turn-character-contract-analysis', items: [],
          finalMessage: JSON.stringify(passedMovementAnalysis(['north', 'east', 'south', 'west'])),
        };
      }
      generationTurns += 1;
      const prompt = String(input[0].text);
      const outputPath = prompt.match(/exactly (.+?final\.png)/i)?.[1];
      if (!outputPath) throw new Error('Test nie znalazł final.png w prompcie retry kontraktu postaci.');
      if (generationTurns === 1) {
        const sourcePath = path.join(path.dirname(outputPath), 'source.png');
        const bakedCheckerboardPath = path.join(path.dirname(outputPath), 'baked-checkerboard.png');
        const secondBakedCheckerboardPath = path.join(path.dirname(outputPath), 'baked-checkerboard-2.png');
        mkdirSync(path.dirname(sourcePath), { recursive: true });
        await sharp({
          create: { width: 192, height: 128, channels: 3, background: '#cccccc' },
        }).png().toFile(sourcePath);
        await sharp({
          create: { width: 160, height: 128, channels: 3, background: '#d9d9d9' },
        }).png().toFile(bakedCheckerboardPath);
        await sharp({
          create: { width: 160, height: 128, channels: 3, background: '#f0f0f0' },
        }).png().toFile(secondBakedCheckerboardPath);
        return {
          turnId: 'turn-character-contract-source',
          items: [
            { type: 'imageGeneration', savedPath: sourcePath },
            { type: 'imageGeneration', savedPath: bakedCheckerboardPath },
            { type: 'imageGeneration', savedPath: secondBakedCheckerboardPath },
          ],
          finalMessage: JSON.stringify({
            status: 'needs_user_decision', finalPath: '', category: 'character', tags: ['łowca'],
            pivot: { x: 0.5, y: 0 }, description: 'Kandydat o złym rozmiarze',
            message: 'Wbudowany generator nie zachował dokładnego rozmiaru arkusza.',
          }),
        };
      }
      retryPrompt = prompt;
      retryImages = input.filter((item) => item.type === 'localImage');
      await writeCharacterSheet(outputPath, 32, 32);
      return {
        turnId: 'turn-character-contract-repaired', items: [],
        finalMessage: JSON.stringify({
          status: 'completed', finalPath: outputPath, category: 'character', tags: ['łowca'],
          pivot: { x: 0.5, y: 0 }, description: 'Poprawiony łowca', message: '',
        }),
      };
    },
  } as unknown as CodexService;
  const queue = new GenerationQueue(fakeCodex);
  queue.attach(database);
  const terminal = waitForGenerationTerminal(queue);
  const job = queue.enqueue({
    name: 'Łowca kontraktowy', prompt: '', mode: 'generate', category: 'character',
    relativeWidth: 1, relativeHeight: 1, footprint: { x: 1, y: 1 },
    characterAnimation: { action: 'walk', framesPerDirection: CHARACTER_FIXTURE_FRAMES, framesPerSecond: 8 },
  });

  await expect(terminal).resolves.toMatchObject({ type: 'completed', jobId: job.id });
  expect(generationTurns).toBe(2);
  expect(analysisTurns).toBe(1);
  expect(retryImages).toHaveLength(1);
  expect(retryImages[0].path).toContain(`${path.sep}attempt-1${path.sep}selected-source.png`);
  expect(retryPrompt).toContain('Wbudowany generator nie zachował dokładnego rozmiaru arkusza.');
  expect(retryPrompt).toContain('nie ma kanału alfa');
  expect(database.listProjectSettingsProposals()).toHaveLength(1);
  expect(database.listGenerationLogs(job.assetId).some((entry) => entry.stage === 'retry')).toBe(true);
  expect(database.getJob(job.id)?.status).toBe('needs_review');
  await queue.shutdown();
  database.close();
});

it('odzyskuje alfę z nieprzezroczystego arkusza postaci bez kosztownego retry', async () => {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-character-alpha-recovery-')), 'project');
  temporaryDirectories.push(path.dirname(root));
  mkdirSync(root);
  const database = ProjectDatabase.create(root, {
    name: 'Odzyskanie alfa postaci', artBrief: '', projection: 'top_down', tileWidthPx: 32,
    characterFramesPerDirection: CHARACTER_FIXTURE_FRAMES,
  });
  let generationTurns = 0;
  let analysisTurns = 0;
  const fakeCodex = {
    health: () => ({ state: 'ready', message: 'Gotowy' }),
    runExclusive: async <T>(operation: () => Promise<T>) => operation(),
    ensureAssetThread: async () => 'thread-character-alpha-recovery',
    startUtilityThread: async () => 'thread-character-alpha-analysis',
    skillPath: () => '/Applications/ChatGPT.app/imagegen/SKILL.md',
    interruptActiveTurn: async () => undefined,
    runTurn: async (_threadId: string, input: Array<Record<string, unknown>>) => {
      if (!input.some((item) => item.type === 'skill')) {
        analysisTurns += 1;
        return {
          turnId: 'turn-character-alpha-analysis', items: [],
          finalMessage: JSON.stringify(passedMovementAnalysis(['north', 'east', 'south', 'west'])),
        };
      }
      generationTurns += 1;
      const prompt = String(input[0].text);
      const outputPath = prompt.match(/exactly (.+?final\.png)/i)?.[1];
      if (!outputPath) throw new Error('Test nie znalazł final.png w prompcie odzyskania alfa.');
      await writeOpaqueCharacterSheet(outputPath, 32, 32);
      return {
        turnId: 'turn-character-alpha-generation', items: [],
        finalMessage: JSON.stringify({
          status: 'completed', finalPath: outputPath, category: 'character', tags: ['goblin'],
          pivot: { x: 0.5, y: 0 }, description: 'Goblin na wypalonym tle', message: '',
        }),
      };
    },
  } as unknown as CodexService;
  const queue = new GenerationQueue(fakeCodex);
  queue.attach(database);
  const terminal = waitForGenerationTerminal(queue);
  const job = queue.enqueue({
    name: 'Goblin bez alfa', prompt: '', mode: 'generate', category: 'character',
    relativeWidth: 1, relativeHeight: 1, footprint: { x: 1, y: 1 },
    characterAnimation: { action: 'walk', framesPerDirection: CHARACTER_FIXTURE_FRAMES, framesPerSecond: 8 },
  });

  await expect(terminal).resolves.toMatchObject({ type: 'completed', jobId: job.id });
  expect(generationTurns).toBe(1);
  expect(analysisTurns).toBe(1);
  expect(database.listGenerationLogs(job.assetId).some((entry) => (
    entry.message.includes('Bezpiecznie odzyskano kanał alfa')
  ))).toBe(true);
  expect(database.listGenerationLogs(job.assetId).some((entry) => entry.stage === 'retry')).toBe(false);
  expect(database.getAsset(job.assetId)?.versions[0].generationMetadata).toMatchObject({
    characterTransparencyRecovery: {
      method: 'light-neutral-border',
      borderConfidence: expect.any(Number),
      backgroundPixels: expect.any(Number),
      foregroundPixels: expect.any(Number),
    },
  });
  expect(await sharp(path.join(root, 'assets', job.assetId, job.versionId, 'final.png')).metadata())
    .toMatchObject({ hasAlpha: true });
  await queue.shutdown();
  database.close();
});

it('wybiera także wynik dotykający granic komórek, normalizuje go i kończy bez zbędnego retry', async () => {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-character-source-selection-')), 'project');
  temporaryDirectories.push(path.dirname(root));
  mkdirSync(root);
  const database = ProjectDatabase.create(root, {
    name: 'Wybór źródła postaci', artBrief: '', projection: 'top_down', tileWidthPx: 32,
    characterFramesPerDirection: CHARACTER_FIXTURE_FRAMES,
  });
  let generationTurns = 0;
  let analysisTurns = 0;
  const fakeCodex = {
    health: () => ({ state: 'ready', message: 'Gotowy' }),
    runExclusive: async <T>(operation: () => Promise<T>) => operation(),
    ensureAssetThread: async () => 'thread-character-source-selection',
    startUtilityThread: async () => 'thread-character-source-analysis',
    skillPath: () => '/Applications/ChatGPT.app/imagegen/SKILL.md',
    interruptActiveTurn: async () => undefined,
    runTurn: async (_threadId: string, input: Array<Record<string, unknown>>) => {
      if (!input.some((item) => item.type === 'skill')) {
        analysisTurns += 1;
        return {
          turnId: 'turn-character-source-analysis', items: [],
          finalMessage: JSON.stringify(passedMovementAnalysis(['north', 'east', 'south', 'west'])),
        };
      }
      generationTurns += 1;
      const prompt = String(input[0].text);
      const finalPath = prompt.match(/exactly (.+?final\.png)/i)?.[1];
      if (!finalPath) throw new Error('Test nie znalazł final.png w prompcie wyboru źródła postaci.');
      const sourcePath = path.join(path.dirname(finalPath), 'first-rgba-source.png');
      const staticExactPath = path.join(path.dirname(finalPath), 'static-exact-rgba.png');
      const bakedPath = path.join(path.dirname(finalPath), 'second-baked.png');
      const secondBakedPath = path.join(path.dirname(finalPath), 'third-baked.png');
      await writeStaticCharacterSheet(staticExactPath, 32, 32);
      await writeCharacterSheet(sourcePath, 40, 32, CHARACTER_FIXTURE_FRAMES, true);
      await sharp({ create: { width: 160, height: 128, channels: 3, background: '#cccccc' } })
        .png().toFile(bakedPath);
      await sharp({ create: { width: 160, height: 128, channels: 3, background: '#f0f0f0' } })
        .png().toFile(secondBakedPath);
      return {
        turnId: 'turn-character-source-generation',
        items: [
          { type: 'imageGeneration', savedPath: staticExactPath },
          { type: 'imageGeneration', savedPath: sourcePath },
          { type: 'imageGeneration', savedPath: bakedPath },
          { type: 'imageGeneration', savedPath: secondBakedPath },
        ],
        finalMessage: JSON.stringify({
          status: 'completed', finalPath: '', category: 'character', tags: ['drwal'],
          pivot: { x: 0.2, y: 0.8 }, description: 'Pierwszy użyteczny arkusz RGBA',
          message: 'Generator zgłosił problem z docelowym canvasem.',
        }),
      };
    },
  } as unknown as CodexService;
  const queue = new GenerationQueue(fakeCodex);
  queue.attach(database);
  const terminal = waitForGenerationTerminal(queue);
  const job = queue.enqueue({
    name: 'Drwal testowy', prompt: '', mode: 'generate', category: 'character',
    relativeWidth: 1, relativeHeight: 1, footprint: { x: 1, y: 1 },
    characterAnimation: { action: 'walk', framesPerDirection: CHARACTER_FIXTURE_FRAMES, framesPerSecond: 8 },
  });

  await expect(terminal).resolves.toMatchObject({ type: 'completed', jobId: job.id });
  expect(generationTurns).toBe(1);
  expect(analysisTurns).toBe(1);
  expect(database.listGenerationLogs(job.assetId).some((entry) => entry.stage === 'retry')).toBe(false);
  expect(database.listGenerationLogs(job.assetId).some((entry) => (
    entry.message.includes('Przepakowano źródłowy arkusz 200×128px')
  ))).toBe(true);
  const completedVersion = database.getAsset(job.assetId)?.versions[0];
  expect(completedVersion).toMatchObject({
    status: 'needs_review', width: 160, height: 128, pivot: { x: 0.5, y: 0.09375 },
    generationMetadata: {
      characterSourceNormalization: {
        normalized: true, sourceWidth: 200, sourceHeight: 128, outputWidth: 160, outputHeight: 128,
      },
    },
  });
  const persistedSourcePath = path.join(root, 'assets', job.assetId, job.versionId, 'source.png');
  expect(existsSync(persistedSourcePath)).toBe(true);
  expect(await sharp(persistedSourcePath).metadata()).toMatchObject({
    width: 200, height: 128, hasAlpha: true,
  });
  await queue.shutdown();
  database.close();
});

it('nie publikuje postaci, gdy ten sam turn utworzył propozycję ustawień mimo statusu completed', async () => {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-character-settings-proposal-')), 'project');
  temporaryDirectories.push(path.dirname(root));
  mkdirSync(root);
  const database = ProjectDatabase.create(root, {
    name: 'Propozycja ustawień postaci', artBrief: '', projection: 'top_down', tileWidthPx: 32,
    characterFramesPerDirection: CHARACTER_FIXTURE_FRAMES,
  });
  let generationTurns = 0;
  const fakeCodex = {
    health: () => ({ state: 'ready', message: 'Gotowy' }),
    runExclusive: async <T>(operation: () => Promise<T>) => operation(),
    ensureAssetThread: async () => 'thread-character-settings-proposal',
    skillPath: () => '/Applications/ChatGPT.app/imagegen/SKILL.md',
    interruptActiveTurn: async () => undefined,
    runTurn: async (
      _threadId: string,
      _input: Array<Record<string, unknown>>,
      _outputSchema: Record<string, unknown>,
      onEvent?: (notification: { method: string; params: Record<string, unknown> }) => void,
    ) => {
      generationTurns += 1;
      database.createProjectSettingsProposal({
        reason: 'Referencja wymaga zmiany bazowej skali projektu przed dalszą generacją.',
        settings: { pixelsPerUnit: 16 },
        referenceIds: [],
      });
      onEvent?.({
        method: 'item/started',
        params: {
          item: {
            type: 'dynamicToolCall', namespace: 'registry', tool: 'propose_project_settings',
            arguments: { settings: { pixelsPerUnit: 16 } },
          },
        },
      });
      return {
        turnId: 'turn-character-settings-proposal', items: [],
        finalMessage: JSON.stringify({
          status: 'completed', finalPath: '', category: 'character', tags: [],
          pivot: { x: 0.5, y: 0 }, description: '',
          message: 'Najpierw zatwierdź propozycję zmiany skali projektu.',
        }),
      };
    },
  } as unknown as CodexService;
  const queue = new GenerationQueue(fakeCodex);
  queue.attach(database);
  const terminal = waitForGenerationTerminal(queue);
  const job = queue.enqueue({
    name: 'Postać wymagająca skali', prompt: '', mode: 'generate', category: 'character',
    relativeWidth: 1, relativeHeight: 1, footprint: { x: 1, y: 1 },
    characterAnimation: { action: 'walk', framesPerDirection: CHARACTER_FIXTURE_FRAMES, framesPerSecond: 8 },
  });

  await expect(terminal).resolves.toMatchObject({
    type: 'failed', jobId: job.id,
    message: 'Najpierw zatwierdź propozycję zmiany skali projektu.',
  });
  expect(generationTurns).toBe(1);
  expect(database.listProjectSettingsProposals()).toHaveLength(1);
  expect(database.listGenerationLogs(job.assetId).some((entry) => entry.stage === 'retry')).toBe(false);
  await queue.shutdown();
  database.close();
});

it('blokuje lokalny generator postaci, gdy obowiązkowy analizator Codex jest niedostępny', async () => {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-character-no-agent-')), 'project');
  temporaryDirectories.push(path.dirname(root));
  mkdirSync(root);
  const database = ProjectDatabase.create(root, {
    name: 'Brak analizatora', artBrief: '', projection: 'top_down', tileWidthPx: 32,
    characterFramesPerDirection: CHARACTER_FIXTURE_FRAMES,
  });
  let providerCalls = 0;
  const fakeCodex = {
    health: () => ({ state: 'unavailable', message: 'Codex App Server jest wyłączony.' }),
  } as unknown as CodexService;
  const fakeComfy = {
    health: () => ({ state: 'ready', message: 'Gotowy' }),
    generate: async () => {
      providerCalls += 1;
      throw new Error('Nie powinno zostać wywołane.');
    },
  };
  const queue = new GenerationQueue(fakeCodex, undefined, fakeComfy as never);
  queue.attach(database);
  const terminal = waitForGenerationTerminal(queue);
  const job = queue.enqueue({
    name: 'Wojownik', prompt: '', mode: 'generate', category: 'character', generatorProvider: 'comfyui',
    footprint: { x: 1, y: 1 },
    characterAnimation: { action: 'walk', framesPerDirection: CHARACTER_FIXTURE_FRAMES, framesPerSecond: 8 },
  });

  await expect(terminal).resolves.toMatchObject({
    type: 'failed', jobId: job.id, message: 'Codex App Server jest wyłączony.',
  });
  expect(providerCalls).toBe(0);
  expect(database.getAsset(job.assetId)?.versions[0]).toMatchObject({
    status: 'failed', finalPath: null,
    characterAnimation: { movementAnalysis: { status: 'pending' } },
  });
  await queue.shutdown();
  database.close();
});

it('nie publikuje postaci, gdy raport analizatora pomija kanoniczny kierunek', async () => {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-character-bad-report-')), 'project');
  temporaryDirectories.push(path.dirname(root));
  mkdirSync(root);
  const database = ProjectDatabase.create(root, {
    name: 'Błędny raport', artBrief: '', projection: 'top_down', tileWidthPx: 32,
    characterFramesPerDirection: CHARACTER_FIXTURE_FRAMES,
  });
  let generationTurns = 0;
  const fakeCodex = {
    health: () => ({ state: 'ready', message: 'Gotowy' }),
    runExclusive: async <T>(operation: () => Promise<T>) => operation(),
    ensureAssetThread: async () => 'thread-character-invalid-report',
    startUtilityThread: async () => 'thread-character-invalid-analysis',
    skillPath: () => '/Applications/ChatGPT.app/imagegen/SKILL.md',
    interruptActiveTurn: async () => undefined,
    runTurn: async (_threadId: string, input: Array<Record<string, unknown>>) => {
      if (input.some((item) => item.type === 'skill')) {
        generationTurns += 1;
        const prompt = String(input[0].text);
        const outputPath = prompt.match(/exactly (.+?final\.png)/i)?.[1];
        if (!outputPath) throw new Error('Test nie znalazł final.png w prompcie postaci.');
        await writeCharacterSheet(outputPath, 32, 32);
        return {
          turnId: 'turn-character-invalid-generation', items: [],
          finalMessage: JSON.stringify({
            status: 'completed', finalPath: outputPath, category: 'character', tags: [],
            pivot: { x: 0.5, y: 0 }, description: 'Postać', message: '',
          }),
        };
      }
      return {
        turnId: 'turn-character-invalid-analysis', items: [],
        finalMessage: JSON.stringify(passedMovementAnalysis(['north', 'east', 'south', 'south'])),
      };
    },
  } as unknown as CodexService;
  const queue = new GenerationQueue(fakeCodex);
  queue.attach(database);
  const terminal = waitForGenerationTerminal(queue);
  const job = queue.enqueue({
    name: 'Łuczniczka', prompt: '', mode: 'generate', category: 'character',
    relativeWidth: 1, relativeHeight: 1, footprint: { x: 1, y: 1 },
    characterAnimation: { action: 'walk', framesPerDirection: CHARACTER_FIXTURE_FRAMES, framesPerSecond: 8 },
  });

  await expect(terminal).resolves.toMatchObject({
    type: 'failed',
    jobId: job.id,
    message: expect.stringContaining('Raport ruchu musi zawierać dokładnie kierunki north, east, south, west'),
  });
  expect(generationTurns).toBe(1);
  expect(database.getAsset(job.assetId)?.versions[0]).toMatchObject({
    status: 'failed', finalPath: null,
    characterAnimation: { movementAnalysis: { status: 'pending', turnId: null } },
  });
  await queue.shutdown();
  database.close();
});

function waitForGenerationTerminal(queue: GenerationQueue): Promise<GenerationEvent> {
  return new Promise<GenerationEvent>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Kolejka nie zakończyła testowego zadania.')), 15_000);
    queue.on('event', (event: GenerationEvent) => {
      if (event.type === 'completed' || event.type === 'failed') {
        clearTimeout(timeout);
        resolve(event);
      }
    });
  });
}

function passedMovementAnalysis(directions: string[]) {
  return {
    status: 'passed' as 'passed' | 'failed',
    summary: 'Postać zachowuje tożsamość, kontakt z podłożem i płynny cykl w każdym kierunku.',
    directions: directions.map((direction) => ({
      direction,
      status: 'passed' as 'passed' | 'failed',
      message: 'Kierunek, fazy kroku i pętla są czytelne i stabilne.',
    })),
  };
}

async function writeCharacterSheet(
  filePath: string,
  frameWidth: number,
  frameHeight: number,
  framesPerDirection = CHARACTER_FIXTURE_FRAMES,
  touchCellEdge = false,
): Promise<void> {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const columns = framesPerDirection + 1;
  const phaseLegs = Array.from({ length: columns }, (_, column) => {
    if (column === 0) return [[14, 27], [17, 27]];
    const offset = ((column * 5) % 9) - 4;
    return [[14 + offset, 26 + (column % 2)], [17 - offset, 26 + ((column + 1) % 2)]];
  });
  const colors = ['#7f5bd5', '#3e8cde', '#d4773b', '#4ca56b'];
  const shadedLegColors = ['#6042ae', '#286cae', '#a95929', '#347a4b'];
  const composites: OverlayOptions[] = [];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const [[leftLegX, leftLegBottom], [rightLegX, rightLegBottom]] = phaseLegs[column];
      const svg = [
        `<svg width="${frameWidth}" height="${frameHeight}" xmlns="http://www.w3.org/2000/svg">`,
        `<g fill="${colors[row]}">`,
        touchCellEdge ? '<rect x="0" y="14" width="13" height="2"/>' : '',
        '<circle cx="16" cy="6" r="3"/>',
        '<rect x="12" y="9" width="8" height="11" rx="2"/>',
        `<rect x="${leftLegX}" y="19" width="3" height="${leftLegBottom - 19 + 1}"/>`,
        `<rect x="${rightLegX}" y="19" width="3" height="${rightLegBottom - 19 + 1}" fill="${shadedLegColors[row]}"/>`,
        '</g></svg>',
      ].join('');
      composites.push({ input: Buffer.from(svg), left: column * frameWidth, top: row * frameHeight });
    }
  }
  await sharp({
    create: {
      width: frameWidth * columns,
      height: frameHeight * 4,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite(composites).png().toFile(filePath);
}

async function writeOpaqueCharacterSheet(
  filePath: string,
  frameWidth: number,
  frameHeight: number,
): Promise<void> {
  const transparentPath = path.join(path.dirname(filePath), 'transparent-character-source.png');
  await writeCharacterSheet(transparentPath, frameWidth, frameHeight);
  const width = frameWidth * (CHARACTER_FIXTURE_FRAMES + 1);
  const height = frameHeight * 4;
  const tile = 12;
  const background = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`
    + Array.from({ length: Math.ceil(height / tile) }, (_, row) => (
      Array.from({ length: Math.ceil(width / tile) }, (_, column) => (
        `<rect x="${column * tile}" y="${row * tile}" width="${tile}" height="${tile}" fill="${(row + column) % 2 ? '#ffffff' : '#d8d8d8'}"/>`
      )).join('')
    )).join('')
    + '</svg>';
  await sharp(Buffer.from(background))
    .composite([{ input: transparentPath }])
    .removeAlpha()
    .png()
    .toFile(filePath);
  rmSync(transparentPath, { force: true });
}

async function writeStaticCharacterSheet(
  filePath: string,
  frameWidth: number,
  frameHeight: number,
  framesPerDirection = CHARACTER_FIXTURE_FRAMES,
): Promise<void> {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const columns = framesPerDirection + 1;
  const composites: OverlayOptions[] = [];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const svg = [
        `<svg width="${frameWidth}" height="${frameHeight}" xmlns="http://www.w3.org/2000/svg">`,
        '<g fill="#536d9b"><circle cx="16" cy="6" r="3"/><rect x="12" y="9" width="8" height="11" rx="2"/>',
        '<rect x="12" y="19" width="3" height="9"/><rect x="18" y="19" width="3" height="9"/></g></svg>',
      ].join('');
      composites.push({ input: Buffer.from(svg), left: column * frameWidth, top: row * frameHeight });
    }
  }
  await sharp({
    create: {
      width: frameWidth * columns,
      height: frameHeight * 4,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite(composites).png().toFile(filePath);
}
