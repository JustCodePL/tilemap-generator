import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it } from 'vitest';
import type { GenerationEvent } from '../shared/domain';
import type { CodexService } from '../main/codex/codex-service';
import { ProjectDatabase } from '../main/db/project-database';
import { GenerationQueue } from '../main/services/generation-queue';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
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

  await expect(terminal).resolves.toMatchObject({ type: 'completed', jobId: job.id });
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

  await expect(terminal).resolves.toMatchObject({ type: 'completed', jobId: job.id });
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

it('tworzy osobny wariant Codex, ComfyUI i stable-diffusion.cpp dla jednego żądania', async () => {
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
  });

  expect(jobs).toHaveLength(3);
  expect(jobs.map((job) => job.generatorProvider)).toEqual(['codex', 'comfyui', 'stable_diffusion_cpp']);
  expect(new Set(jobs.map((job) => job.assetId))).toEqual(new Set([jobs[0].assetId]));
  expect(database.getAsset(jobs[0].assetId)?.versions.map((version) => version.generatorProvider).sort())
    .toEqual(['codex', 'comfyui', 'stable_diffusion_cpp'].sort());
  expect(database.getAsset(jobs[0].assetId)?.versions.map((version) => version.footprint))
    .toEqual([{ x: 2, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 2 }]);
  await queue.shutdown();
  database.close();
});
