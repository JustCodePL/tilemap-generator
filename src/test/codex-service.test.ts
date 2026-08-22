import { expect, it, vi } from 'vitest';
import {
  CodexService,
  generationResponseSchema,
  resolveCodexExecutable,
} from '../main/codex/codex-service';

it('preferuje jawnie wskazane binarium Codexa', () => {
  expect(resolveCodexExecutable({
    platform: 'darwin',
    environment: { TILEMAP_CODEX_EXE: '/custom/bin/codex' },
    fileExists: (candidate) => candidate === '/custom/bin/codex',
  })).toBe('/custom/bin/codex');

  expect(() => resolveCodexExecutable({
    platform: 'darwin',
    environment: { TILEMAP_CODEX_EXE: '/missing/codex' },
    fileExists: () => false,
  })).toThrow('TILEMAP_CODEX_EXE wskazuje nieistniejący plik');
});

it('znajduje Codexa dołączonego do ChatGPT przy ograniczonym PATH Findera', () => {
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex';
  expect(resolveCodexExecutable({
    platform: 'darwin',
    environment: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    homeDirectory: '/Users/tester',
    fileExists: (candidate) => candidate === bundled,
  })).toBe(bundled);
});

it('replaces a persisted asset thread so newly registered dynamic tools are available', async () => {
  const setAssetThread = vi.fn();
  const database = { rootPath: 'C:\\project', setAssetThread };

  const request = vi.fn(async (method: string, _params: unknown) => {
    expect(method).toBe('thread/start');
    return { thread: { id: 'thread-current' } };
  });
  const service = new CodexService();
  Object.assign(service as unknown as Record<string, unknown>, {
    client: { request },
    database,
    imagegenSkillPath: 'C:\\imagegen\\SKILL.md',
    healthValue: {
      state: 'ready', version: '0.147.0', appServer: true, imageGeneration: true,
      imagegenSkill: true, skillPath: 'C:\\imagegen\\SKILL.md', logPath: null, message: 'ready',
    },
  });

  await expect(service.ensureAssetThread('asset-1', 'thread-stale')).resolves.toBe('thread-current');
  expect(request).toHaveBeenCalledTimes(1);
  const params = request.mock.calls[0][1] as {
    dynamicTools: Array<{ tools: Array<{ name: string }> }>;
  };
  expect(params.dynamicTools[0].tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
    'list_references', 'get_reference',
  ]));
  expect(setAssetThread).toHaveBeenCalledWith('asset-1', 'thread-current');

  await expect(service.ensureAssetThread('asset-1', 'thread-current')).resolves.toBe('thread-current');
  expect(request).toHaveBeenCalledTimes(1);
});

it('requires a normalized AI pivot in the final generation response', () => {
  expect(generationResponseSchema.parse({
    status: 'completed', finalPath: 'C:\\project\\staging\\job\\final.png', category: 'vegetation',
    tags: ['drzewo'], pivot: { x: 0.48, y: 0.12 }, description: 'Stary dąb', message: '',
  }).pivot).toEqual({ x: 0.48, y: 0.12 });

  expect(() => generationResponseSchema.parse({
    status: 'completed', finalPath: 'final.png', category: 'vegetation', tags: ['drzewo'],
    description: 'Stary dąb', message: '',
  })).toThrow();
  expect(() => generationResponseSchema.parse({
    status: 'completed', finalPath: 'final.png', category: 'vegetation', tags: ['drzewo'],
    pivot: { x: 0.5, y: -0.1 }, description: 'Stary dąb', message: '',
  })).toThrow();
});

it('prowadzi równoległe turny na różnych wątkach', async () => {
  const request = vi.fn(async (method: string, params: unknown) => {
    expect(method).toBe('turn/start');
    const threadId = (params as { threadId: string }).threadId;
    return { turn: { id: `turn-${threadId}` } };
  });
  const service = new CodexService();
  Object.assign(service as unknown as Record<string, unknown>, {
    client: { request },
    database: {},
    imagegenSkillPath: 'C:\\imagegen\\SKILL.md',
    healthValue: {
      state: 'ready', version: '0.147.0', appServer: true, imageGeneration: true,
      imagegenSkill: true, skillPath: 'C:\\imagegen\\SKILL.md', logPath: null, message: 'ready',
    },
  });
  const first = service.runTurn('thread-a', [], {});
  const second = service.runTurn('thread-b', [], {});
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  await Promise.resolve();

  const notify = (service as unknown as {
    handleNotification(notification: { method: string; params: Record<string, unknown> }): void;
  }).handleNotification.bind(service);
  for (const threadId of ['thread-a', 'thread-b']) {
    const turnId = `turn-${threadId}`;
    notify({ method: 'item/completed', params: { turnId, item: { type: 'agentMessage', text: threadId } } });
    notify({ method: 'turn/completed', params: { turnId, turn: { id: turnId, status: 'completed' } } });
  }

  await expect(Promise.all([first, second])).resolves.toEqual([
    expect.objectContaining({ turnId: 'turn-thread-a', finalMessage: 'thread-a' }),
    expect.objectContaining({ turnId: 'turn-thread-b', finalMessage: 'thread-b' }),
  ]);
});

it('anuluje wyłącznie turn wskazany przez sygnał zadania', async () => {
  const request = vi.fn(async (method: string, params: unknown) => {
    const values = params as { threadId: string; turnId?: string };
    if (method === 'turn/start') return { turn: { id: `turn-${values.threadId}` } };
    if (method === 'turn/interrupt') return {};
    throw new Error(`Nieoczekiwana metoda ${method}`);
  });
  const service = new CodexService();
  Object.assign(service as unknown as Record<string, unknown>, {
    client: { request },
    database: {},
    imagegenSkillPath: 'C:\\imagegen\\SKILL.md',
    healthValue: {
      state: 'ready', version: '0.147.0', appServer: true, imageGeneration: true,
      imagegenSkill: true, skillPath: 'C:\\imagegen\\SKILL.md', logPath: null, message: 'ready',
    },
  });
  const firstController = new AbortController();
  const first = service.runTurn('thread-a', [], {}, undefined, 5_000, firstController.signal);
  const second = service.runTurn('thread-b', [], {}, undefined, 5_000);
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  await Promise.resolve();

  firstController.abort();
  await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  expect(request).toHaveBeenCalledWith('turn/interrupt', {
    threadId: 'thread-a', turnId: 'turn-thread-a',
  }, 20_000);
  expect(request).not.toHaveBeenCalledWith('turn/interrupt', expect.objectContaining({
    threadId: 'thread-b',
  }), 20_000);

  const notify = (service as unknown as {
    handleNotification(notification: { method: string; params: Record<string, unknown> }): void;
  }).handleNotification.bind(service);
  notify({
    method: 'turn/completed',
    params: { turnId: 'turn-thread-b', turn: { id: 'turn-thread-b', status: 'completed' } },
  });
  await expect(second).resolves.toMatchObject({ turnId: 'turn-thread-b' });
});
