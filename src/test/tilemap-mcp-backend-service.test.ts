import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectDatabase } from '../main/db/project-database';
import {
  TilemapMcpBackendService,
  tilemapMcpMethods,
  type TilemapMcpGenerationQueue,
  type TilemapMcpProjectDescriptor,
  type TilemapMcpProjectGateway,
  type TilemapMcpProjectRuntime,
} from '../main/mcp/tilemap-mcp-backend-service';
import { tilemapMcpScopes, type TilemapMcpScope } from '../shared/mcp';
import type { EnqueueGenerationInput, GenerationJob } from '../shared/domain';

const temporaryDirectories: string[] = [];
const databases: ProjectDatabase[] = [];
const allScopes = [...tilemapMcpScopes];

afterEach(() => {
  for (const database of databases.splice(0)) {
    try { database.close(); } catch { /* already closed by a failed test */ }
  }
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it('listuje deskryptory bez otwierania DB i wymaga jawnego, sesyjnego bind', async () => {
  const first = createRuntime('Alfa');
  const second = createRuntime('Beta');
  const harness = createGateway([first, second]);
  const service = new TilemapMcpBackendService(harness.gateway, allScopes);
  const firstGetProject = vi.spyOn(first.database, 'getProject');
  const secondGetProject = vi.spyOn(second.database, 'getProject');

  const listed = await service.listProjects();
  expect(listed).toEqual([
    expect.objectContaining({ projectId: first.projectId, name: 'Alfa', active: false, bound: false }),
    expect.objectContaining({ projectId: second.projectId, name: 'Beta', active: false, bound: false }),
  ]);
  expect(firstGetProject).not.toHaveBeenCalled();
  expect(secondGetProject).not.toHaveBeenCalled();
  expect(JSON.stringify(listed)).not.toContain(first.database.rootPath);
  await expect(service.getProjectContext()).rejects.toThrow(/jawnie przypnij/);

  const context = await service.bindProject({ projectId: second.projectId });
  expect(context.project).toMatchObject({ projectId: second.projectId, name: 'Beta' });
  expect(harness.gateway.activateProject).toHaveBeenCalledWith(second.projectId);
  expect((await service.listProjects()).find((project) => project.projectId === second.projectId)?.bound).toBe(true);

  harness.setActive(first.runtime);
  await expect(service.getProjectContext()).rejects.toThrow(/nie jest już aktywny/);
  await expect(service.getProjectContext()).rejects.toThrow(/jawnie przypnij/);
});

it('failuje przy duplikacie projectId oraz przy runtime innym niż aktywowany', async () => {
  const first = createRuntime('Oryginał');
  const second = createRuntime('Kopia');
  const duplicateHarness = createGateway([first, second]);
  duplicateHarness.descriptors[1] = { ...duplicateHarness.descriptors[1], projectId: first.projectId };
  const duplicateService = new TilemapMcpBackendService(duplicateHarness.gateway, allScopes);
  await expect(duplicateService.listProjects()).rejects.toThrow(/niejednoznaczny projectId/);

  const mismatchHarness = createGateway([first, second]);
  vi.mocked(mismatchHarness.gateway.activateProject).mockImplementationOnce(async () => {
    mismatchHarness.setActive(second.runtime);
    return first.runtime;
  });
  const mismatchService = new TilemapMcpBackendService(mismatchHarness.gateway, allScopes);
  await expect(mismatchService.bindProject({ projectId: first.projectId }))
    .rejects.toThrow(/runtime nie odpowiada/);
  await expect(mismatchService.getProjectContext()).rejects.toThrow(/jawnie przypnij/);
});

it('egzekwuje osobne scope dla odczytu, aktywacji i każdej mutacji', async () => {
  const runtime = createRuntime('Scope');
  const readOnlyHarness = createGateway([runtime]);
  const readOnly = new TilemapMcpBackendService(readOnlyHarness.gateway, ['read']);
  expect(await readOnly.listProjects()).toHaveLength(1);
  await expect(readOnly.bindProject({ projectId: runtime.projectId })).rejects.toThrow(/project:activate/);
  expect(readOnlyHarness.gateway.activateProject).not.toHaveBeenCalled();

  const harness = createGateway([runtime]);
  const noWrites = new TilemapMcpBackendService(harness.gateway, ['read', 'project:activate']);
  await noWrites.bindProject({ projectId: runtime.projectId });
  await expect(noWrites.updateStyle({ summary: 'Nowy styl' })).rejects.toThrow(/style:write/);
  await expect(noWrites.addReference({ sourcePath: '/tmp/a.png', description: 'Opis' }))
    .rejects.toThrow(/references:write/);
  await expect(noWrites.generateAsset({ request: { name: 'Drzewo' } }))
    .rejects.toThrow(/generation:enqueue/);
  expect(runtime.database.getStyleHistory()).toEqual([]);
  expect(runtime.generationQueue.enqueueEnabled).not.toHaveBeenCalled();

  const noRead = new TilemapMcpBackendService(harness.gateway, ['project:activate']);
  await expect(noRead.listProjects()).rejects.toThrow(/read/);
});

it('zwraca ograniczony kontekst i walidowaną historię stylu bez ścieżek', async () => {
  const runtime = createRuntime('Top-down', 'top_down');
  runtime.database.setNewAssetGeneratorProviders(['comfyui']);
  runtime.database.enqueueGeneration({
    name: 'Skrzynia', prompt: '', mode: 'generate', category: 'prop',
    footprint: { x: 1, y: 1 }, generatorProvider: 'comfyui',
  });
  const { service } = await boundService(runtime);

  const context = await service.getProjectContext();
  expect(context.project).toMatchObject({
    projectId: runtime.projectId, name: 'Top-down', projection: 'top_down',
    tileWidthPx: 64, tileHeightPx: 64,
  });
  expect(context.project.supportedAssetCategories).not.toContain('elevated_tile');
  expect(context.project.characterDirections.map((direction) => direction.id)).toEqual([
    'north', 'east', 'south', 'west',
  ]);
  expect(context.generation).toMatchObject({
    selectedGeneratorProviders: ['comfyui'], queueAttached: true,
    statusCounts: expect.objectContaining({ queued: 1 }),
  });
  expect(JSON.stringify(context)).not.toContain(runtime.database.rootPath);

  await expect(service.updateStyle({ summary: '   ' })).rejects.toThrow();
  expect(runtime.database.getStyleHistory()).toEqual([]);
  await service.updateStyle({ summary: '  Ciepły, ręcznie malowany pixel art.  ' });
  await service.updateStyle({ summary: 'Chłodniejsze cienie.' });
  expect(await service.getStyle({ historyLimit: 1 })).toMatchObject({
    activeSummary: 'Chłodniejsze cienie.', stale: false,
    history: [expect.objectContaining({ summary: 'Chłodniejsze cienie.', source: 'manual' })],
  });
  await expect(service.updateStyle({ summary: 'Styl', extra: true })).rejects.toThrow();
});

it('dodaje, listuje i zwraca referencję jako base64 bez ujawniania ścieżek', async () => {
  const runtime = createRuntime('Referencje');
  const sourcePath = path.join(path.dirname(runtime.database.rootPath), 'reference-source.png');
  await writePng(sourcePath, 8, 8);
  const { service } = await boundService(runtime);

  const added = await service.addReference({ sourcePath, description: 'Kamienna faktura' });
  expect(added.reference).toMatchObject({ name: 'reference-source', description: 'Kamienna faktura' });
  expect(JSON.stringify(added)).not.toContain(sourcePath);
  const listed = await service.listReferences();
  expect(listed.references).toEqual([expect.objectContaining({
    referenceId: added.reference.referenceId, description: 'Kamienna faktura',
  })]);
  expect(JSON.stringify(listed)).not.toContain('relativePath');

  const loaded = await service.getReference({ referenceId: added.reference.referenceId });
  expect(loaded).toMatchObject({
    projectId: runtime.projectId, mimeType: 'image/png',
    metadata: expect.objectContaining({ referenceId: added.reference.referenceId }),
  });
  expect(Buffer.from(loaded.dataBase64, 'base64').subarray(1, 4).toString()).toBe('PNG');
  expect(JSON.stringify(loaded)).not.toContain(runtime.database.rootPath);
  await expect(service.getReference({ referenceId: randomUUID() })).rejects.toThrow(/Nie znaleziono/);

  await expect(service.addReference({
    sourcePath: path.dirname(sourcePath), description: 'To jest katalog',
  })).rejects.toThrow(/nie jest zwykłym plikiem/);
  const oversizedPath = path.join(path.dirname(runtime.database.rootPath), 'oversized.png');
  writeFileSync(oversizedPath, '');
  truncateSync(oversizedPath, 50 * 1024 * 1024 + 1);
  await expect(service.addReference({
    sourcePath: oversizedPath, description: 'Za duża referencja',
  })).rejects.toThrow(/limit 50 MB/);
});

it('odrzuca symlink obrazu wychodzący poza aktywny projekt', async () => {
  const runtime = createRuntime('Symlink');
  const outsidePath = path.join(path.dirname(runtime.database.rootPath), 'outside.png');
  writeFileSync(outsidePath, 'not-an-image');
  const referenceId = randomUUID();
  const linkPath = path.join(runtime.database.rootPath, 'references', `${referenceId}.png`);
  symlinkSync(outsidePath, linkPath);
  const now = new Date().toISOString();
  runtime.database.sqlite.prepare(`
    INSERT INTO project_references (
      id, name, description, relative_path, mime_type, width, height, created_at, updated_at
    ) VALUES (?, 'Symlink', 'Poza projektem', ?, 'image/png', 1, 1, ?, ?)
  `).run(referenceId, `references/${referenceId}.png`, now, now);
  const { service } = await boundService(runtime);

  await expect(service.getReference({ referenceId })).rejects.toThrow(/poza przypięty projekt/);
});

it('generuje wyłącznie przez kolejkę i utrwala wybrane referencje oraz kierunek stylu w prompt', async () => {
  const runtime = createRuntime('Generacja');
  const sourcePath = path.join(path.dirname(runtime.database.rootPath), 'mood.png');
  await writePng(sourcePath, 8, 8);
  const reference = await runtime.database.addProjectReference(sourcePath, 'Mech na szarym kamieniu');
  const { service } = await boundService(runtime);

  const generated = await service.generateAsset({
    request: {
      name: 'Kamienna droga', prompt: 'Stara droga', category: 'road_tile',
      generatorProviders: ['stable_diffusion_cpp', 'codex'],
    },
    referenceIds: [reference.id],
    styleDirection: 'Mniej kontrastu i chłodne cienie.',
  });
  expect(generated.jobs).toHaveLength(1);
  expect(runtime.generationQueue.enqueueEnabled).toHaveBeenCalledTimes(1);
  const request = vi.mocked(runtime.generationQueue.enqueueEnabled).mock.calls[0][0];
  expect(request).toMatchObject({
    name: 'Kamienna droga', mode: 'generate', footprint: { x: 1, y: 1 },
    generatorProviders: ['codex', 'stable_diffusion_cpp'],
  });
  expect(request.prompt).toContain('Stara droga');
  expect(request.prompt).toContain('Mniej kontrastu i chłodne cienie.');
  expect(request.prompt).toContain(reference.id);
  expect(request.prompt).toContain('Mech na szarym kamieniu');

  await expect(service.generateAsset({
    request: { name: 'Drzewo' }, referenceIds: [randomUUID()],
  })).rejects.toThrow(/nie należy do przypiętego projektu/);
  expect(runtime.generationQueue.enqueueEnabled).toHaveBeenCalledTimes(1);

  await expect(service.generateAsset({
    request: { name: 'Drzewo', generatorProviders: [] },
  })).rejects.toThrow(/co najmniej jeden generator/);
  expect(runtime.generationQueue.enqueueEnabled).toHaveBeenCalledTimes(1);

  vi.mocked(runtime.generationQueue.isAttachedTo).mockReturnValue(false);
  await expect(service.generateAsset({ request: { name: 'Drzewo' } })).rejects.toThrow(/nie jest przypięta/);
  expect(runtime.generationQueue.enqueueEnabled).toHaveBeenCalledTimes(1);
});

it('udostępnia gotowy asset jako base64 bez ścieżki', async () => {
  const runtime = createRuntime('Asset context');
  const job = runtime.database.enqueueGeneration({
    name: 'Kamień', prompt: '', mode: 'generate', category: 'prop',
    footprint: { x: 1, y: 1 }, generatorProvider: 'codex',
  });
  const relativePath = `assets/${job.assetId}/${job.versionId}/final.png`;
  const finalPath = runtime.database.resolveRelative(relativePath);
  mkdirSync(path.dirname(finalPath), { recursive: true });
  await writePng(finalPath, 16, 16);
  runtime.database.sqlite.prepare(`
    UPDATE asset_versions SET final_path = ?, width = 16, height = 16, status = 'needs_review'
    WHERE id = ?
  `).run(relativePath, job.versionId);
  const { service } = await boundService(runtime);

  const asset = await service.getAsset({ assetId: job.assetId, versionId: job.versionId });
  expect(asset).toMatchObject({
    projectId: runtime.projectId,
    mimeType: 'image/png',
    metadata: expect.objectContaining({ assetId: job.assetId, versionId: job.versionId }),
  });
  expect(Buffer.from(asset.dataBase64, 'base64').subarray(1, 4).toString()).toBe('PNG');
  expect(JSON.stringify(asset)).not.toContain(runtime.database.rootPath);
});

it('zwraca status tylko z bound projektu i atomowo odrzuca obce jobIds', async () => {
  const runtime = createRuntime('Status');
  const foreign = createRuntime('Obcy');
  const first = enqueueDirect(runtime.database, 'Pierwszy', 'codex');
  const second = enqueueDirect(runtime.database, 'Drugi', 'comfyui');
  const foreignJob = enqueueDirect(foreign.database, 'Obcy', 'codex');
  const privatePosixPath = '/Users/artur/Game Assets/sekretny-projekt/staging/final.png';
  const privateWindowsPath = 'C:\\Users\\Artur\\Game Assets\\sekretny-projekt\\staging\\input.png';
  runtime.database.updateJob(
    first.id,
    'failed',
    'Generacja nie powiodła się',
    `ENOENT podczas odczytu '${privatePosixPath}'.`,
  );
  runtime.database.addGenerationLog(first.id, 'generation', 'info', 1, 'Start');
  runtime.database.addGenerationLog(
    first.id,
    'system',
    'error',
    1,
    `Nie można otworzyć "${privateWindowsPath}" podczas weryfikacji.`,
  );
  const { service } = await boundService(runtime);

  expect((await service.getGenerationStatus({
    jobIds: [second.id, first.id], includeLogs: false,
  })).jobs).toEqual([
    expect.objectContaining({ id: second.id }), expect.objectContaining({ id: first.id }),
  ]);
  const publicStatus = (await service.getGenerationStatus({ jobIds: [first.id] })).jobs[0];
  expect(publicStatus).toMatchObject({
    id: first.id,
    error: "ENOENT podczas odczytu '[ścieżka ukryta]'.",
    logs: [
      expect.objectContaining({ message: 'Start', stage: 'generation' }),
      expect.objectContaining({
        message: 'Nie można otworzyć "[ścieżka ukryta]" podczas weryfikacji.',
        stage: 'system',
      }),
    ],
  });
  expect(JSON.stringify(publicStatus)).not.toContain(privatePosixPath);
  expect(JSON.stringify(publicStatus)).not.toContain(privateWindowsPath);
  expect(runtime.database.getJob(first.id)?.error).toContain(privatePosixPath);
  expect(runtime.database.listGenerationLogs(first.assetId)[1]?.message).toContain(privateWindowsPath);
  await expect(service.getGenerationStatus({ jobIds: [first.id, foreignJob.id] }))
    .rejects.toThrow(/nie należy do przypiętego projektu/);
  await expect(service.getGenerationStatus({ jobIds: [first.id, first.id] })).rejects.toThrow(/tylko raz/);
});

it('dispatcher ma ścisłą allowlistę nazw i parametrów RPC', async () => {
  expect(tilemapMcpMethods).toEqual([
    'list_projects', 'bind_project', 'get_project_context', 'get_style', 'update_style',
    'list_references', 'add_reference', 'get_reference', 'get_asset', 'generate_asset',
    'get_generation_status',
  ]);
  const runtime = createRuntime('Dispatcher');
  const harness = createGateway([runtime]);
  const service = new TilemapMcpBackendService(harness.gateway, allScopes);
  expect(await service.call('list_projects', {})).toEqual([
    expect.objectContaining({ projectId: runtime.projectId }),
  ]);
  await expect(service.call('list_projects', { extra: true })).rejects.toThrow();
  await expect(service.call('delete_project', {})).rejects.toThrow(/Nieznana metoda/);
  await service.call('bind_project', { projectId: runtime.projectId });
  expect(await service.call('get_project_context', {})).toMatchObject({
    project: { projectId: runtime.projectId },
  });
});

type TestRuntime = {
  projectId: string;
  runtime: TilemapMcpProjectRuntime;
  database: ProjectDatabase;
  generationQueue: TilemapMcpGenerationQueue & {
    enqueueEnabled: ReturnType<typeof vi.fn<(input: EnqueueGenerationInput) => GenerationJob[]>>;
    isAttachedTo: ReturnType<typeof vi.fn<(database: ProjectDatabase) => boolean>>;
  };
};

function createRuntime(
  name: string,
  projection: 'isometric' | 'top_down' = 'isometric',
): TestRuntime {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-mcp-'));
  temporaryDirectories.push(parent);
  const root = path.join(parent, 'project');
  mkdirSync(root);
  const database = ProjectDatabase.create(root, {
    name, artBrief: '', projection, tileWidthPx: 64,
  });
  databases.push(database);
  const generationQueue = {
    isAttachedTo: vi.fn((candidate: ProjectDatabase) => candidate === database),
    enqueueEnabled: vi.fn((_input: EnqueueGenerationInput) => [fakeJob()]),
  };
  const runtime = { database, generationQueue };
  return { projectId: database.getProject().id, runtime, database, generationQueue };
}

function createGateway(runtimes: TestRuntime[]) {
  let active: TilemapMcpProjectRuntime | null = null;
  const descriptors: TilemapMcpProjectDescriptor[] = runtimes.map((runtime, index) => ({
    projectId: runtime.projectId,
    name: runtime.database.getProject().name,
    openedAt: new Date(Date.UTC(2026, 7, 23, 12, index)).toISOString(),
    active: false,
  }));
  const gateway: TilemapMcpProjectGateway = {
    listProjectDescriptors: vi.fn(async () => descriptors),
    activateProject: vi.fn(async (projectId: string) => {
      const selected = runtimes.find((runtime) => runtime.projectId === projectId);
      if (!selected) throw new Error('Nie znaleziono runtime.');
      active = selected.runtime;
      for (const descriptor of descriptors) descriptor.active = descriptor.projectId === projectId;
      return selected.runtime;
    }),
    getActiveRuntime: vi.fn(async () => active),
  };
  return {
    gateway,
    descriptors,
    setActive(runtime: TilemapMcpProjectRuntime | null) { active = runtime; },
  };
}

async function boundService(runtime: TestRuntime, scopes: TilemapMcpScope[] = allScopes) {
  const harness = createGateway([runtime]);
  const service = new TilemapMcpBackendService(harness.gateway, scopes);
  await service.bindProject({ projectId: runtime.projectId });
  return { service, harness };
}

function enqueueDirect(database: ProjectDatabase, name: string, generatorProvider: 'codex' | 'comfyui') {
  return database.enqueueGeneration({
    name, prompt: '', mode: 'generate', category: 'prop',
    footprint: { x: 1, y: 1 }, generatorProvider,
  });
}

async function writePng(filePath: string, width: number, height: number): Promise<void> {
  await sharp({
    create: { width, height, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
  }).png().toFile(filePath);
}

function fakeJob(): GenerationJob {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), assetId: randomUUID(), versionId: randomUUID(), generatorProvider: 'codex',
    status: 'queued', progress: 'Oczekuje w kolejce', error: '', createdAt: now, updatedAt: now,
  };
}
