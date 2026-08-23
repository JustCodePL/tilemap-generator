// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { TilemapGeneratorApi } from '../shared/bridge';
import type { AssetDetail, AssetSummary, AssetVersion, CharacterMovementAnalysisStatus, ProjectInfo, ProjectProjection } from '../shared/domain';
import { characterDirectionsForProjection } from '../shared/domain';
import { App, CharacterAnimationPreview, GenerationLogPanel, MovementAnalysisPanel, PreviewZoomControls, ProjectReferencesPanel, ProjectSettingsProposalsPanel, ReviewControls, TerrainSeamPreview } from '../renderer/ui/App';

const projectFixture: ProjectInfo = {
  id: '11111111-1111-4111-8111-111111111111', rootPath: 'C:\\project', name: 'Test', artBrief: '',
  projection: 'isometric', tileWidthPx: 256, tileHeightPx: 128, pixelsPerUnit: 256,
  maxConcurrentJobs: 1,
  aiVerificationEnabled: true,
  styleSummary: '', styleSummaryStale: false, exportTargets: {},
  createdAt: '2026-08-07T10:00:00.000Z', updatedAt: '2026-08-07T10:00:00.000Z',
};

function terrainVersionFixture(overrides: Partial<AssetVersion> = {}): AssetVersion {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    assetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    parentVersionId: null,
    mode: 'generate',
    status: 'needs_review',
    prompt: 'Zielona łąka',
    feedback: '',
    category: 'flat_tile',
    characterAnimation: null,
    elevationLevels: 0,
    relativeWidth: 1,
    relativeHeight: 1,
    tags: ['łąka'],
    finalPath: 'assets/meadow/final.png',
    imageUrl: 'tilemap-asset://asset/meadow.png',
    width: 256,
    height: 128,
    footprint: { x: 1, y: 1 },
    pivot: { x: 0.5, y: 0.5 },
    aiDescription: '',
    aiVerificationStatus: 'passed',
    aiVerificationMessage: '',
    rejectionReason: '',
    error: '',
    createdAt: projectFixture.createdAt,
    updatedAt: projectFixture.updatedAt,
    ...overrides,
  };
}

function characterVersionFixture(
  analysisStatus: CharacterMovementAnalysisStatus = 'passed',
  projection: ProjectProjection = 'isometric',
): AssetVersion {
  const directions = [...characterDirectionsForProjection(projection)];
  return {
    id: '12121212-1212-4212-8212-121212121212',
    assetId: '34343434-3434-4434-8434-343434343434',
    parentVersionId: null,
    mode: 'generate',
    status: 'needs_review',
    prompt: 'Leśna strażniczka',
    feedback: '',
    category: 'character',
    elevationLevels: 0,
    relativeWidth: 0.5,
    relativeHeight: 1.5,
    characterAnimation: {
      settings: { action: 'walk', framesPerDirection: 4, framesPerSecond: 8 },
      directions,
      frameSize: { width: 128, height: projection === 'isometric' ? 192 : 384 },
      sheetSize: { width: 640, height: projection === 'isometric' ? 768 : 1_536 },
      movementAnalysis: {
        status: analysisStatus,
        summary: analysisStatus === 'passed' ? 'Sylwetka porusza się płynnie we wszystkich kierunkach.' : analysisStatus === 'failed' ? 'Kierunek NE przeskakuje między klatkami.' : '',
        directions: analysisStatus === 'pending' ? [] : directions.map((direction) => ({
          direction: direction.id,
          status: analysisStatus === 'passed' || direction.id !== 'north_east' ? 'passed' : 'failed',
          message: analysisStatus === 'passed' || direction.id !== 'north_east' ? 'Pętla jest płynna.' : 'Sylwetka przeskakuje.',
        })),
        turnId: analysisStatus === 'pending' ? null : 'turn-character-analysis',
        analyzedAt: analysisStatus === 'pending' ? null : '2026-08-07T10:05:00.000Z',
      },
    },
    tags: ['postać', 'strażniczka'],
    finalPath: 'assets/character/final.png',
    imageUrl: 'tilemap-asset://project/assets/character/final.png',
    width: 640,
    height: projection === 'isometric' ? 768 : 1_536,
    footprint: { x: 1, y: 1 },
    pivot: { x: 0.5, y: 0.08 },
    aiDescription: 'Leśna strażniczka w pełnym zestawie ruchu.',
    aiVerificationStatus: 'passed',
    aiVerificationMessage: '',
    generatorProvider: 'codex',
    generatorModel: 'imagegen',
    rejectionReason: '',
    error: '',
    createdAt: projectFixture.createdAt,
    updatedAt: projectFixture.updatedAt,
  };
}

function characterAssetFixture(version = characterVersionFixture()): AssetDetail {
  return {
    id: version.assetId,
    name: 'Leśna strażniczka',
    description: version.aiDescription,
    category: 'character',
    elevationLevels: 0,
    relativeWidth: version.relativeWidth,
    relativeHeight: version.relativeHeight,
    currentApprovedVersionId: version.status === 'approved' ? version.id : null,
    latestVersion: version,
    versionCount: 1,
    codexThreadId: null,
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
    versions: [version],
  };
}

beforeEach(() => {
  cleanup();
  window.tilemap = {
    projects: {
      current: vi.fn(async () => null), recents: vi.fn(async () => []),
      chooseStorageDirectory: vi.fn(), create: vi.fn(), open: vi.fn(), openRecent: vi.fn(), update: vi.fn(), close: vi.fn(), removeRecent: vi.fn(),
      settingsProposals: vi.fn(async () => []), reviewSettingsProposal: vi.fn(),
      onChanged: vi.fn(() => () => undefined),
    },
    assets: { list: vi.fn(), get: vi.fn(), review: vi.fn(), undoApproval: vi.fn(), undoRejection: vi.fn() },
    references: { list: vi.fn(async () => []), add: vi.fn(), update: vi.fn(), remove: vi.fn() },
    generation: { enqueue: vi.fn(), cancel: vi.fn(), retry: vi.fn(), verify: vi.fn(), jobs: vi.fn(), logs: vi.fn(async () => []), onEvent: vi.fn(() => () => undefined) },
    style: { history: vi.fn(), update: vi.fn(), restore: vi.fn(), rebuild: vi.fn() },
    export: {
      listIntegrations: vi.fn(async () => [{
        id: 'unity', label: 'Unity', description: 'PNG, manifest i narzędzia edytora Unity.',
        targetLabel: 'Katalog docelowy',
      }]),
      chooseTarget: vi.fn(), preview: vi.fn(), run: vi.fn(),
    },
    codex: { health: vi.fn(), refresh: vi.fn() },
    comfy: {
      health: vi.fn(async () => ({
        state: 'unavailable', installed: false, server: false, endpoint: 'http://127.0.0.1:8188',
        version: null, profile: 'z_image_turbo', model: 'z_image_turbo_bf16.safetensors',
        missingNodes: [], missingModels: [], message: 'ComfyUI wyłączone',
      })),
      refresh: vi.fn(() => window.tilemap.comfy.health()),
    },
    stableDiffusionCpp: {
      health: vi.fn(async () => ({
        state: 'unavailable', installed: false, executablePath: null, profile: 'z_image_turbo',
        model: 'z_image_turbo_bf16.safetensors', llm: 'qwen_3_4b.safetensors', vae: 'ae.safetensors',
        missingFiles: ['sd-cli.exe'], message: 'stable-diffusion.cpp wyłączone',
      })),
      refresh: vi.fn(),
      setup: vi.fn(async () => ({
        runtime: { installed: false, version: null, backend: 'vulkan', executablePath: null },
        hardware: {
          gpuName: 'NVIDIA GeForce GTX 1660', vramMb: 6144,
          recommendedModelId: 'z_image_turbo_q4_k',
          recommendation: 'NVIDIA GeForce GTX 1660 · 6,0 GB VRAM: polecam Q4_K.',
        },
        models: [
          {
            id: 'z_image_turbo_q4_k', name: 'Z-Image Turbo Q4_K', quantization: 'Q4_K',
            description: 'Profil polecany.', recommendedVramGb: 6, totalSizeBytes: 6_361_531_424,
            downloadBytesRemaining: 6_026_227_036, installed: false, selected: false,
            recommended: true, usesExistingComfyModels: false,
          },
          {
            id: 'z_image_turbo_bf16', name: 'Z-Image Turbo BF16 (ComfyUI)', quantization: 'BF16',
            description: 'Istniejące modele.', recommendedVramGb: 16, totalSizeBytes: 20_690_152_836,
            downloadBytesRemaining: 0, installed: true, selected: true,
            recommended: false, usesExistingComfyModels: true,
          },
        ],
        selectedModelId: 'z_image_turbo_bf16',
        installRoot: 'C:\\Users\\test\\stable-diffusion.cpp',
      })),
      install: vi.fn(),
      selectModel: vi.fn(),
      cancelInstall: vi.fn(async () => undefined),
      onInstallEvent: vi.fn(() => () => undefined),
    },
  } as unknown as TilemapGeneratorApi;
});

function mockOpenedProject(project: ProjectInfo, assets: AssetSummary[] = []) {
  vi.mocked(window.tilemap.projects.current).mockResolvedValue(project);
  vi.mocked(window.tilemap.assets.list).mockResolvedValue(assets);
  vi.mocked(window.tilemap.generation.jobs).mockResolvedValue([]);
  vi.mocked(window.tilemap.style.history).mockResolvedValue([]);
  vi.mocked(window.tilemap.codex.health).mockResolvedValue({
    state: 'ready', version: '0.142.5', appServer: true, imageGeneration: true,
    imagegenSkill: true, skillPath: 'C:\\imagegen\\SKILL.md', logPath: null, message: 'Gotowe',
  });
}

it('pokazuje ekran tworzenia projektu bez otwartego registry', async () => {
  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  expect(await screen.findByRole('heading', { name: /Spójny świat/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Utwórz projekt/i })).toBeInTheDocument();
  expect(screen.getByText('Eksport przez integracje')).toBeInTheDocument();
  expect(screen.queryByText('Eksport gotowy dla Unity')).not.toBeInTheDocument();
});

it('tworzy projekt top-down z bazowym tile 1:1', async () => {
  vi.mocked(window.tilemap.projects.chooseStorageDirectory).mockResolvedValue('C:\\biblioteka');
  vi.mocked(window.tilemap.projects.create).mockResolvedValue(projectFixture);
  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);

  expect(await screen.findByRole('button', { name: /Utwórz projekt/i })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Wybierz katalog biblioteki' }));
  expect(await screen.findByText('C:\\biblioteka')).toBeInTheDocument();
  fireEvent.change(await screen.findByLabelText('Projekcja'), { target: { value: 'top_down' } });
  fireEvent.change(screen.getByLabelText('Bazowa szerokość tile (px)'), { target: { value: '255' } });
  expect(screen.getByLabelText('Wysokość 1:1')).toHaveValue('255px');
  fireEvent.click(screen.getByRole('button', { name: /Utwórz projekt/i }));

  await waitFor(() => expect(window.tilemap.projects.create).toHaveBeenCalledWith({
    name: 'Nowy świat', artBrief: '', projection: 'top_down', tileWidthPx: 255,
  }, 'C:\\biblioteka'));
});

it('sprawdza ostatni projekt przed otwarciem i pozwala usunąć go z listy', async () => {
  const recent = {
    name: 'Nieistniejący świat', rootPath: 'C:\\missing\\tilemap', openedAt: '2026-08-07T10:00:00.000Z',
  };
  vi.mocked(window.tilemap.projects.recents).mockResolvedValue([recent]);
  vi.mocked(window.tilemap.projects.openRecent).mockRejectedValue(new Error(`Projekt nie istnieje: ${recent.rootPath}`));
  vi.mocked(window.tilemap.projects.removeRecent).mockResolvedValue();

  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Otwórz projekt Nieistniejący świat' }));
  expect(await screen.findByText(`Projekt nie istnieje: ${recent.rootPath}`)).toBeInTheDocument();
  expect(window.tilemap.projects.openRecent).toHaveBeenCalledWith(recent.rootPath);

  fireEvent.click(screen.getByRole('button', { name: 'Usuń projekt Nieistniejący świat z listy' }));
  await waitFor(() => expect(window.tilemap.projects.removeRecent).toHaveBeenCalledWith(recent.rootPath));
  expect(screen.queryByText('Nieistniejący świat')).not.toBeInTheDocument();
});

it('oddziela katalog biblioteki od neutralnego ekranu integracji eksportu', async () => {
  mockOpenedProject(projectFixture);

  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Strona główna projektu Test' }));

  expect(await screen.findByText('C:\\project')).toBeInTheDocument();
  expect(screen.getByText('Registry, historia i wszystkie wersje assetów.')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Eksport' }));
  expect(await screen.findByRole('heading', { name: 'Integracje eksportu' })).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: /Unity.*PNG, manifest/i })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByLabelText('Ustawienia integracji Unity')).toHaveTextContent('Narzędzia Unity są instalowane raz, osobno w Assets/TilemapGeneratorIntegration.');
  expect(screen.queryByText('UNITY DELIVERY')).not.toBeInTheDocument();
  expect(screen.queryByText('KATALOG ASSETS')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Przygotuj podgląd' })).toBeDisabled();
});

it('pozwala przygotować plan usunięcia bez zatwierdzonych assetów', async () => {
  const targetDirectory = 'C:\\gra\\Assets\\Generated\\Tilemap';
  const project = { ...projectFixture, exportTargets: { unity: targetDirectory } };
  mockOpenedProject(project);
  vi.mocked(window.tilemap.export.preview).mockResolvedValue({
    token: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    integration: 'unity',
    targetDirectory,
    manifestPath: `${targetDirectory}\\tilemap-assets.json`,
    assetCount: 0,
    files: [{
      assetId: null,
      versionId: null,
      sourcePath: null,
      destinationPath: `${targetDirectory}\\flat_tile\\obsolete.png`,
      role: 'asset',
      action: 'delete',
    }],
  });

  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Eksport' }));

  const prepare = await screen.findByRole('button', { name: 'Przygotuj podgląd' });
  expect(prepare).toBeEnabled();
  fireEvent.click(prepare);

  await waitFor(() => expect(window.tilemap.export.preview).toHaveBeenCalledWith({
    integration: 'unity',
    targetDirectory,
  }));
  expect(await screen.findByText('0 assetów · 1 plik')).toBeInTheDocument();
  expect(screen.getByText('USUNIĘCIE')).toHaveClass('delete');
});

it('wybiera cel i wykonuje eksport przez integrację Unity', async () => {
  const approvedAsset: AssetSummary = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Łąka',
    description: 'Zatwierdzona łąka',
    category: 'flat_tile',
    elevationLevels: 0,
    relativeWidth: 1,
    relativeHeight: 1,
    currentApprovedVersionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    latestVersion: null,
    versionCount: 1,
    codexThreadId: null,
    createdAt: projectFixture.createdAt,
    updatedAt: projectFixture.updatedAt,
  };
  const targetDirectory = 'C:\\gra\\Assets\\Generated\\Tilemap';
  const manifestPath = `${targetDirectory}\\tilemap-assets.json`;
  const refreshedProject = { ...projectFixture, exportTargets: { unity: targetDirectory } };
  mockOpenedProject(projectFixture, [approvedAsset]);
  vi.mocked(window.tilemap.projects.current).mockResolvedValueOnce(projectFixture).mockResolvedValue(refreshedProject);
  vi.mocked(window.tilemap.export.chooseTarget).mockResolvedValue(targetDirectory);
  vi.mocked(window.tilemap.export.preview).mockResolvedValue({
    token: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    integration: 'unity',
    targetDirectory,
    manifestPath,
    assetCount: 1,
    files: [
      {
        assetId: approvedAsset.id,
        versionId: approvedAsset.currentApprovedVersionId,
        sourcePath: 'C:\\project\\assets\\meadow.png',
        destinationPath: `${targetDirectory}\\flat_tile\\meadow.png`,
        role: 'asset',
        action: 'create',
      },
      {
        assetId: null,
        versionId: null,
        sourcePath: null,
        destinationPath: `${targetDirectory}\\obsolete.png`,
        role: 'integration_support',
        action: 'delete',
      },
    ],
  });
  vi.mocked(window.tilemap.export.run).mockResolvedValue({
    assetCount: 1,
    fileCount: 2,
    writtenFileCount: 2,
    manifestPath,
  });
  const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
  const queryClient = new QueryClient();

  render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Eksport' }));
  expect(await screen.findByRole('heading', { name: 'Integracje eksportu' })).toBeInTheDocument();

  fireEvent.click(await screen.findByRole('button', { name: 'Wybierz miejsce eksportu' }));
  expect(await screen.findByText(targetDirectory)).toBeInTheDocument();
  expect(window.tilemap.export.chooseTarget).toHaveBeenCalledWith('unity');

  fireEvent.click(screen.getByRole('button', { name: 'Przygotuj podgląd' }));
  await waitFor(() => expect(window.tilemap.export.preview).toHaveBeenCalledWith({
    integration: 'unity',
    targetDirectory,
  }));
  expect(await screen.findByRole('heading', { name: 'Plan eksportu' })).toBeInTheDocument();
  expect(screen.getByText('1 asset · 2 pliki')).toBeInTheDocument();
  expect(screen.getByText('USUNIĘCIE')).toHaveClass('delete');

  fireEvent.click(screen.getByRole('button', { name: 'Eksportuj przez Unity' }));
  await waitFor(() => expect(window.tilemap.export.run).toHaveBeenCalledWith('cccccccc-cccc-4ccc-8ccc-cccccccccccc'));
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'Plan eksportu' })).not.toBeInTheDocument());
  expect(screen.queryByRole('button', { name: 'Eksportuj przez Unity' })).not.toBeInTheDocument();
  await waitFor(() => expect(window.tilemap.projects.current).toHaveBeenCalledTimes(2));
  expect(queryClient.getQueryData<ProjectInfo>(['project'])?.exportTargets.unity).toBe(targetDirectory);
  expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('Unity: wyeksportowano 1 zatwierdzony asset.'));
  expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('Zmienione pliki: 2/2.'));
  alertSpy.mockRestore();
});

it('pozwala generować asset z samej nazwy bez opcjonalnego opisu', async () => {
  vi.mocked(window.tilemap.projects.current).mockResolvedValue({
    id: '11111111-1111-4111-8111-111111111111', rootPath: 'C:\\project', name: 'Test', artBrief: '',
    projection: 'isometric', tileWidthPx: 256, tileHeightPx: 128, pixelsPerUnit: 256,
    maxConcurrentJobs: 1,
    aiVerificationEnabled: true,
    codexGenerationEnabled: true,
    comfyUiEnabled: false,
    comfyUiProfile: 'z_image_turbo',
    styleSummary: '', styleSummaryStale: false, exportTargets: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  vi.mocked(window.tilemap.assets.list).mockResolvedValue([]);
  vi.mocked(window.tilemap.generation.jobs).mockResolvedValue([]);
  vi.mocked(window.tilemap.style.history).mockResolvedValue([]);
  vi.mocked(window.tilemap.codex.health).mockResolvedValue({
    state: 'ready', version: '0.142.5', appServer: true, imageGeneration: true,
    imagegenSkill: true, skillPath: 'C:\\imagegen\\SKILL.md', logPath: null, message: 'Gotowe',
  });
  vi.mocked(window.tilemap.generation.enqueue).mockResolvedValue([{
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', assetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    versionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'queued', progress: 'Oczekuje w kolejce',
    error: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }]);

  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  fireEvent.change(await screen.findByLabelText('Nazwa assetu'), { target: { value: 'Kamienna droga' } });
  fireEvent.change(screen.getByLabelText('Typ assetu'), { target: { value: 'elevated_tile' } });
  fireEvent.change(screen.getByLabelText('Elevation height (poziomy)'), { target: { value: '2' } });
  expect(screen.getByLabelText('Footprint X — zajęte komórki')).toBeDisabled();
  expect(screen.getByLabelText('Footprint Y — zajęte komórki')).toBeDisabled();
  expect(screen.getByText('1 pole łącznie')).toBeInTheDocument();
  const generate = screen.getByRole('button', { name: /Generuj asset/i });
  expect(screen.getByLabelText('Opis dla agenta (opcjonalnie)')).toHaveValue('');
  await waitFor(() => expect(generate).toBeEnabled());
  fireEvent.click(generate);

  await waitFor(() => expect(window.tilemap.generation.enqueue).toHaveBeenCalledWith(expect.objectContaining({
    name: 'Kamienna droga', prompt: '', category: 'elevated_tile', elevationLevels: 2,
    footprint: { x: 1, y: 1 },
    generatorProviders: ['codex'],
  })));
  expect(vi.mocked(window.tilemap.generation.enqueue).mock.calls[0][0]).not.toHaveProperty('pivot');
});

it('pozwala wybrać generatory nowego assetu i odtwarza zapisany wybór w sekcji postaci', async () => {
  const initialProject = {
    ...projectFixture,
    codexGenerationEnabled: true,
    comfyUiEnabled: false,
    stableDiffusionCppEnabled: false,
  };
  const savedProject = { ...initialProject, comfyUiEnabled: true };
  vi.mocked(window.tilemap.projects.current)
    .mockResolvedValueOnce(initialProject)
    .mockResolvedValue(savedProject);
  vi.mocked(window.tilemap.assets.list).mockResolvedValue([]);
  vi.mocked(window.tilemap.generation.jobs).mockResolvedValue([]);
  vi.mocked(window.tilemap.style.history).mockResolvedValue([]);
  vi.mocked(window.tilemap.codex.health).mockResolvedValue({
    state: 'ready', version: '0.142.5', appServer: true, imageGeneration: true,
    imagegenSkill: true, skillPath: 'C:\\imagegen\\SKILL.md', logPath: null, message: 'Gotowe',
  });
  vi.mocked(window.tilemap.comfy.health).mockResolvedValue({
    state: 'ready', installed: true, server: true, endpoint: 'http://127.0.0.1:8188',
    version: '1.0.39', profile: 'z_image_turbo', model: 'z_image_turbo_bf16.safetensors',
    missingNodes: [], missingModels: [], message: 'Gotowe',
  });
  vi.mocked(window.tilemap.generation.enqueue).mockResolvedValue([{
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', assetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    versionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'queued', progress: 'Oczekuje', error: '',
    createdAt: projectFixture.createdAt, updatedAt: projectFixture.updatedAt,
  }]);

  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  const codex = await screen.findByRole('checkbox', { name: /Codex imagegen/ });
  const comfy = screen.getByRole('checkbox', { name: /ComfyUI/ });
  expect(codex).toBeChecked();
  expect(codex).toBeDisabled();
  expect(comfy).not.toBeChecked();

  fireEvent.click(comfy);
  expect(comfy).toBeChecked();
  expect(codex).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Nazwa assetu'), { target: { value: 'Kamienny mur' } });
  const generate = screen.getByRole('button', { name: 'Generuj 2 warianty' });
  await waitFor(() => expect(generate).toBeEnabled());
  fireEvent.click(generate);

  await waitFor(() => expect(window.tilemap.generation.enqueue).toHaveBeenCalledWith(expect.objectContaining({
    name: 'Kamienny mur',
    generatorProviders: ['codex', 'comfyui'],
  })));
  await waitFor(() => expect(window.tilemap.projects.current).toHaveBeenCalledTimes(2));

  fireEvent.click(screen.getByRole('button', { name: 'Postacie' }));
  expect(await screen.findByRole('checkbox', { name: /Codex imagegen/ })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /ComfyUI/ })).toBeChecked();
  expect(screen.getByRole('button', { name: 'Generuj 2 warianty postaci' })).toBeInTheDocument();
});

it('rozróżnia wykrytą aplikację Comfy Desktop od nieaktywnego API i blokuje tylko wybrany provider', async () => {
  mockOpenedProject({
    ...projectFixture,
    codexGenerationEnabled: false,
    comfyUiEnabled: true,
    stableDiffusionCppEnabled: false,
  });
  vi.mocked(window.tilemap.comfy.health).mockResolvedValue({
    state: 'detected', installed: true, server: false, endpoint: 'http://127.0.0.1:8188',
    version: '1.0.39', profile: 'z_image_turbo', model: 'z_image_turbo_bf16.safetensors',
    missingNodes: [], missingModels: [], message: 'Wykryto Comfy Desktop, ale lokalny serwer nie odpowiada.',
  });

  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  expect((await screen.findAllByText('Comfy Desktop wykryty · API offline')).length).toBeGreaterThanOrEqual(1);
  const comfy = screen.getByRole('checkbox', { name: /ComfyUI/ });
  expect(comfy).toBeChecked();
  expect(comfy).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Nazwa assetu'), { target: { value: 'Kamienna ściana' } });
  expect(screen.getByRole('button', { name: 'Generuj asset' })).toBeDisabled();
});

it('odświeża stan ComfyUI bez otwierania diagnostyki i odblokowuje wybrany provider po starcie API', async () => {
  mockOpenedProject({
    ...projectFixture,
    codexGenerationEnabled: false,
    comfyUiEnabled: true,
    stableDiffusionCppEnabled: false,
  });
  const offline = {
    state: 'detected' as const, installed: true, server: false, endpoint: 'http://127.0.0.1:8188',
    version: '1.0.39', profile: 'z_image_turbo' as const, model: 'z_image_turbo_bf16.safetensors',
    missingNodes: [], missingModels: [], message: 'Wykryto Comfy Desktop, ale lokalny serwer nie odpowiada.',
  };
  const ready = {
    ...offline,
    state: 'ready' as const,
    server: true,
    message: 'ComfyUI i profil Z-Image Turbo są gotowe.',
  };
  vi.mocked(window.tilemap.comfy.refresh).mockResolvedValueOnce(offline).mockResolvedValue(ready);
  const queryClient = new QueryClient();

  render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
  fireEvent.change(await screen.findByLabelText('Nazwa assetu'), { target: { value: 'Kamienna ściana' } });
  expect(screen.getByRole('button', { name: 'Generuj asset' })).toBeDisabled();

  await queryClient.refetchQueries({ queryKey: ['comfy-health'] });

  expect(await screen.findByText('API gotowe')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Generuj asset' })).toBeEnabled());
  expect(window.tilemap.comfy.refresh).toHaveBeenCalledTimes(2);
});

it('pokazuje osobną sekcję Postacie i generuje pełny zestaw kierunków izometrycznych', async () => {
  mockOpenedProject({ ...projectFixture, codexGenerationEnabled: true });
  vi.mocked(window.tilemap.generation.enqueue).mockResolvedValue([{
    id: '56565656-5656-4656-8656-565656565656',
    assetId: '34343434-3434-4434-8434-343434343434',
    versionId: '12121212-1212-4212-8212-121212121212',
    status: 'queued', progress: 'Oczekuje', error: '',
    createdAt: projectFixture.createdAt, updatedAt: projectFixture.updatedAt,
  }]);

  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  const genericCategory = await screen.findByLabelText('Typ assetu');
  expect(within(genericCategory).queryByRole('option', { name: 'Postać' })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Postacie' }));
  expect(await screen.findByRole('heading', { name: 'Postać gotowa do ruchu' })).toBeInTheDocument();
  const directions = screen.getByRole('region', { name: 'Kierunki animacji postaci' });
  for (const label of ['NW', 'NE', 'SE', 'SW']) expect(within(directions).getByText(label)).toBeInTheDocument();
  expect(screen.getByText(/Kolumna 1: idle · kolumny 2–5: chód/)).toBeInTheDocument();
  expect(screen.getByText(/Analiza ruchu jest obowiązkowa/)).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Nazwa postaci'), { target: { value: 'Leśna strażniczka' } });
  fireEvent.change(screen.getByLabelText('Klatki na sekundę (FPS)'), { target: { value: '12' } });
  fireEvent.change(screen.getByLabelText('Footprint X postaci — zajęte komórki'), { target: { value: '2' } });
  const generate = screen.getByRole('button', { name: 'Generuj postać' });
  await waitFor(() => expect(generate).toBeEnabled());
  fireEvent.click(generate);

  await waitFor(() => expect(window.tilemap.generation.enqueue).toHaveBeenCalledWith({
    name: 'Leśna strażniczka',
    prompt: '',
    mode: 'generate',
    category: 'character',
    relativeWidth: 0.5,
    relativeHeight: 1.5,
    footprint: { x: 2, y: 1 },
    characterAnimation: { action: 'walk', framesPerDirection: 4, framesPerSecond: 12 },
    generatorProviders: ['codex'],
  }));

  fireEvent.click(screen.getByRole('button', { name: 'Strona główna projektu Test' }));
  expect(await screen.findByText(/obowiązkowa analiza ruchu postaci pozostają aktywne/i)).toBeInTheDocument();
});

it('pokazuje postaci top-down wyłącznie w kierunkach N/E/S/W', async () => {
  mockOpenedProject({
    ...projectFixture,
    projection: 'top_down',
    tileHeightPx: projectFixture.tileWidthPx,
    codexGenerationEnabled: true,
  });

  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Postacie' }));
  const directions = await screen.findByRole('region', { name: 'Kierunki animacji postaci' });
  for (const label of ['N', 'E', 'S', 'W']) expect(within(directions).getByText(label)).toBeInTheDocument();
  for (const label of ['NW', 'NE', 'SE', 'SW']) expect(within(directions).queryByText(label)).not.toBeInTheDocument();
  expect(screen.getByText('Top-down, osie świata')).toBeInTheDocument();
});

it('blokuje generowanie postaci, gdy provider jest gotowy, ale analizator Codex nie działa', async () => {
  mockOpenedProject({
    ...projectFixture,
    codexGenerationEnabled: false,
    comfyUiEnabled: true,
  });
  vi.mocked(window.tilemap.codex.health).mockResolvedValue({
    state: 'unavailable', version: null, appServer: false, imageGeneration: false,
    imagegenSkill: false, skillPath: null, logPath: null, message: 'Codex jest niedostępny.',
  });
  vi.mocked(window.tilemap.comfy.health).mockResolvedValue({
    state: 'ready', installed: true, server: true, endpoint: 'http://127.0.0.1:8188',
    version: '1.0', profile: 'z_image_turbo', model: 'z_image_turbo_bf16.safetensors',
    missingNodes: [], missingModels: [], message: 'Gotowe',
  });

  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Postacie' }));
  expect(await screen.findByText(/Obowiązkowy analizator ruchu Codex nie jest gotowy/i)).toHaveTextContent('Codex jest niedostępny.');
  fireEvent.change(screen.getByLabelText('Nazwa postaci'), { target: { value: 'Strażniczka' } });
  expect(screen.getByRole('button', { name: 'Generuj postać' })).toBeDisabled();
});

it('generuje postać tylko przez ComfyUI, zachowując Codex jako obowiązkowy analizator ruchu', async () => {
  mockOpenedProject({
    ...projectFixture,
    codexGenerationEnabled: false,
    comfyUiEnabled: true,
    stableDiffusionCppEnabled: false,
  });
  vi.mocked(window.tilemap.comfy.health).mockResolvedValue({
    state: 'ready', installed: true, server: true, endpoint: 'http://127.0.0.1:8188',
    version: '1.0.39', profile: 'z_image_turbo', model: 'z_image_turbo_bf16.safetensors',
    missingNodes: [], missingModels: [], message: 'Gotowe',
  });
  vi.mocked(window.tilemap.generation.enqueue).mockResolvedValue([{
    id: '56565656-5656-4656-8656-565656565656',
    assetId: '34343434-3434-4434-8434-343434343434',
    versionId: '12121212-1212-4212-8212-121212121212',
    status: 'queued', progress: 'Oczekuje', error: '',
    createdAt: projectFixture.createdAt, updatedAt: projectFixture.updatedAt,
  }]);

  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Postacie' }));
  expect(await screen.findByRole('checkbox', { name: /ComfyUI/ })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /Codex imagegen/ })).not.toBeChecked();
  fireEvent.change(screen.getByLabelText('Nazwa postaci'), { target: { value: 'Leśna strażniczka' } });
  const generate = screen.getByRole('button', { name: 'Generuj postać' });
  await waitFor(() => expect(generate).toBeEnabled());
  fireEvent.click(generate);

  await waitFor(() => expect(window.tilemap.generation.enqueue).toHaveBeenCalledWith(expect.objectContaining({
    category: 'character',
    generatorProviders: ['comfyui'],
  })));
});

it('odtwarza, zatrzymuje i przełącza kierunek arkusza animacji postaci', () => {
  vi.useFakeTimers();
  const version = characterVersionFixture();
  render(<CharacterAnimationPreview version={version} assetName="Leśna strażniczka" />);

  const frame = screen.getByRole('img', { name: /Leśna strażniczka: chód, kierunek Północny zachód/i });
  expect(frame).toHaveAttribute('data-column', '1');
  expect(frame).toHaveAttribute('data-row', '0');
  act(() => vi.advanceTimersByTime(125));
  expect(frame).toHaveAttribute('data-column', '2');

  fireEvent.click(screen.getByRole('button', { name: 'Wstrzymaj animację' }));
  act(() => vi.advanceTimersByTime(500));
  expect(frame).toHaveAttribute('data-column', '2');

  fireEvent.click(screen.getByRole('tab', { name: /NE.*Północny wschód/i }));
  expect(screen.getByRole('img', { name: /kierunek Północny wschód/i })).toHaveAttribute('data-row', '1');
  fireEvent.click(screen.getByRole('tab', { name: 'Idle' }));
  expect(screen.getByRole('img', { name: /idle, kierunek Północny wschód/i })).toHaveAttribute('data-column', '0');
  expect(screen.getByRole('button', { name: 'Odtwórz animację' })).toBeDisabled();
  vi.useRealTimers();
});

it('pokazuje raport agenta per kierunek i blokuje review, dopóki ruch nie jest zaliczony', async () => {
  const failedVersion = characterVersionFixture('failed');
  const failedAsset = characterAssetFixture(failedVersion);
  const view = render(<QueryClientProvider client={new QueryClient()}><>
    <MovementAnalysisPanel animation={failedVersion.characterAnimation!} />
    <ReviewControls asset={failedAsset} version={failedVersion} project={projectFixture} onChanged={() => undefined} />
  </></QueryClientProvider>);

  expect(screen.getByRole('alert', { name: 'Analiza ruchu postaci' })).toHaveTextContent('Niezaliczona');
  expect(screen.getByText('Kierunek NE przeskakuje między klatkami.')).toBeInTheDocument();
  expect(screen.getByText('Sylwetka przeskakuje.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Zatwierdź$/i })).toBeDisabled();
  expect(screen.getByText(/Tej kontroli nie można pominąć/i)).toBeInTheDocument();

  view.unmount();
  const passedVersion = characterVersionFixture('passed');
  const passedAsset = characterAssetFixture(passedVersion);
  vi.mocked(window.tilemap.assets.review).mockResolvedValue({
    ...passedAsset,
    currentApprovedVersionId: passedVersion.id,
    versions: [{ ...passedVersion, status: 'approved' }],
  });
  vi.mocked(window.tilemap.generation.enqueue).mockResolvedValue([{
    id: '78787878-7878-4878-8878-787878787878', assetId: passedAsset.id,
    versionId: '90909090-9090-4090-8090-909090909090', status: 'queued', progress: 'Oczekuje', error: '',
    createdAt: projectFixture.createdAt, updatedAt: projectFixture.updatedAt,
  }]);
  render(<QueryClientProvider client={new QueryClient()}><ReviewControls
    asset={passedAsset} version={passedVersion} project={projectFixture} onChanged={() => undefined}
  /></QueryClientProvider>);

  const approve = screen.getByRole('button', { name: /^Zatwierdź$/i });
  expect(approve).toBeEnabled();
  fireEvent.change(screen.getByLabelText('FPS'), { target: { value: '14' } });
  fireEvent.click(screen.getByRole('button', { name: 'Przegeneruj' }));
  await waitFor(() => expect(window.tilemap.generation.enqueue).toHaveBeenCalledWith(expect.objectContaining({
    category: 'character',
    characterAnimation: { action: 'walk', framesPerDirection: 4, framesPerSecond: 14 },
  })));
  fireEvent.click(approve);
  await waitFor(() => expect(window.tilemap.assets.review).toHaveBeenCalledWith(expect.objectContaining({
    versionId: passedVersion.id, decision: 'approved',
  })));
});

it('otwiera asset postaci w sekcji Postacie z animacją i zaliczoną analizą', async () => {
  const version = characterVersionFixture('passed');
  const asset = characterAssetFixture(version);
  mockOpenedProject({ ...projectFixture, codexGenerationEnabled: true }, [asset]);
  vi.mocked(window.tilemap.assets.get).mockResolvedValue(asset);

  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: /Leśna strażniczka/i }));

  expect(await screen.findByRole('region', { name: 'Podgląd animacji postaci' })).toBeInTheDocument();
  expect(screen.getByRole('status', { name: 'Analiza ruchu postaci' })).toHaveTextContent('Zaliczona');
  expect(screen.getByRole('button', { name: 'Postacie' })).toHaveClass('active');
  expect(screen.getByText('4 / 4 kierunki')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Studio' }));
  expect(await screen.findByRole('heading', { name: 'Co budujemy?' })).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Podgląd animacji postaci' })).not.toBeInTheDocument();
  expect(within(screen.getByLabelText('Typ assetu')).queryByRole('option', { name: 'Postać' })).not.toBeInTheDocument();
});

it('rozróżnia rozmiar obrazu budynku od footprintu siatki', async () => {
  const version: AssetVersion = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', assetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    parentVersionId: null, mode: 'generate', status: 'generating', prompt: '', feedback: '',
    category: 'building', elevationLevels: 0, relativeWidth: 2, relativeHeight: 2, characterAnimation: null, tags: [],
    finalPath: null, imageUrl: null, width: null, height: null,
    footprint: { x: 1, y: 1 }, pivot: { x: 0.5, y: 0.5 }, aiDescription: '',
    aiVerificationStatus: 'pending', aiVerificationMessage: '', rejectionReason: '', error: '',
    createdAt: projectFixture.createdAt, updatedAt: projectFixture.updatedAt,
  };
  const asset: AssetDetail = {
    id: version.assetId, name: 'Tartak', description: '', category: 'building', elevationLevels: 0,
    relativeWidth: 2, relativeHeight: 2, currentApprovedVersionId: null, latestVersion: version,
    versionCount: 3, codexThreadId: null, createdAt: version.createdAt, updatedAt: version.updatedAt,
    versions: [version],
  };
  vi.mocked(window.tilemap.projects.current).mockResolvedValue(projectFixture);
  vi.mocked(window.tilemap.assets.list).mockResolvedValue([asset]);
  vi.mocked(window.tilemap.assets.get).mockResolvedValue(asset);
  vi.mocked(window.tilemap.generation.jobs).mockResolvedValue([]);
  vi.mocked(window.tilemap.style.history).mockResolvedValue([]);
  vi.mocked(window.tilemap.codex.health).mockResolvedValue({
    state: 'ready', version: '0.142.5', appServer: true, imageGeneration: true,
    imagegenSkill: true, skillPath: 'C:\\imagegen\\SKILL.md', logPath: null, message: 'Gotowe',
  });

  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  const row = await screen.findByRole('button', { name: /Tartak/i });
  expect(row).toHaveTextContent('Budynek · obraz 2×2 · siatka 1×1 · 3 wer.');
  fireEvent.click(row);

  expect(await screen.findByRole('note')).toHaveTextContent('Canvas obrazu: 2×2 tile');
  expect(screen.getByLabelText('Footprint X — zajęte komórki')).toHaveValue(1);
  expect(screen.getByLabelText('Footprint Y — zajęte komórki')).toHaveValue(1);
});

it('oferuje dedykowany road tile jako komplet 16 wariantów', async () => {
  vi.mocked(window.tilemap.projects.current).mockResolvedValue(projectFixture);
  vi.mocked(window.tilemap.assets.list).mockResolvedValue([]);
  vi.mocked(window.tilemap.generation.jobs).mockResolvedValue([]);
  vi.mocked(window.tilemap.style.history).mockResolvedValue([]);
  vi.mocked(window.tilemap.codex.health).mockResolvedValue({
    state: 'ready', version: '0.142.5', appServer: true, imageGeneration: true,
    imagegenSkill: true, skillPath: 'C:\\imagegen\\SKILL.md', logPath: null, message: 'Gotowe',
  });
  vi.mocked(window.tilemap.generation.enqueue).mockResolvedValue([{
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', assetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    versionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'queued', progress: 'Oczekuje',
    error: '', createdAt: projectFixture.createdAt, updatedAt: projectFixture.updatedAt,
  }]);

  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  fireEvent.change(await screen.findByLabelText('Nazwa assetu'), { target: { value: 'Piaskowa droga' } });
  fireEvent.change(screen.getByLabelText('Typ assetu'), { target: { value: 'road_tile' } });
  expect(screen.getByText('Komplet 16 wariantów')).toBeInTheDocument();
  expect(screen.getByText(/4 warianty T/)).toBeInTheDocument();
  const generate = screen.getByRole('button', { name: /Generuj asset/i });
  await waitFor(() => expect(generate).toBeEnabled());
  fireEvent.click(generate);

  await waitFor(() => expect(window.tilemap.generation.enqueue).toHaveBeenCalledWith(expect.objectContaining({
    name: 'Piaskowa droga', category: 'road_tile', footprint: { x: 1, y: 1 },
  })));
  expect(vi.mocked(window.tilemap.generation.enqueue).mock.calls[0][0]).not.toHaveProperty('roadConnections');
});

it('ukrywa elevated tile i pokazuje kierunki dróg N/E/S/W w projekcie top-down', async () => {
  vi.mocked(window.tilemap.projects.current).mockResolvedValue({
    ...projectFixture, projection: 'top_down', tileHeightPx: 256,
  });
  vi.mocked(window.tilemap.assets.list).mockResolvedValue([]);
  vi.mocked(window.tilemap.generation.jobs).mockResolvedValue([]);
  vi.mocked(window.tilemap.style.history).mockResolvedValue([]);
  vi.mocked(window.tilemap.codex.health).mockResolvedValue({
    state: 'ready', version: '0.142.5', appServer: true, imageGeneration: true,
    imagegenSkill: true, skillPath: 'C:\\imagegen\\SKILL.md', logPath: null, message: 'Gotowe',
  });

  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  const category = await screen.findByLabelText('Typ assetu');
  expect(screen.queryByRole('option', { name: 'Elevated terrain' })).not.toBeInTheDocument();
  expect(screen.getByText('Bazowy kwadrat 1:1')).toBeInTheDocument();
  expect(screen.getByText('256×256px')).toBeInTheDocument();
  expect(screen.getByLabelText('Footprint X — zajęte komórki')).toBeDisabled();
  expect(screen.getByLabelText('Footprint Y — zajęte komórki')).toBeDisabled();

  fireEvent.change(category, { target: { value: 'road_tile' } });
  expect(screen.getByText(/kierunki N\/E\/S\/W/)).toBeInTheDocument();
});

it('pokazuje komplet road tile jako siatkę 4×4 bez zielonych markerów', async () => {
  const roadVersion: AssetVersion = {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', assetId: '33333333-3333-4333-8333-333333333333',
    parentVersionId: null, mode: 'generate', status: 'needs_review', prompt: '', feedback: '',
    category: 'road_tile', elevationLevels: 0, relativeWidth: 1, relativeHeight: 1, roadConnections: 15, characterAnimation: null,
    roadVariants: Array.from({ length: 16 }, (_, connectionMask) => ({
      connectionMask,
      finalPath: `assets/road-${connectionMask.toString().padStart(2, '0')}.png`,
      imageUrl: `tilemap-asset://project/assets/road-${connectionMask.toString().padStart(2, '0')}.png`,
      width: 256,
      height: 128,
    })),
    tags: ['droga'], finalPath: 'assets/road-grid.png', imageUrl: 'tilemap-asset://project/assets/road-grid.png',
    width: 256, height: 128, footprint: { x: 1, y: 1 }, pivot: { x: 0.5, y: 0.5 },
    aiDescription: 'Piaskowa droga', aiVerificationStatus: 'passed', aiVerificationMessage: '', rejectionReason: '', error: '',
    createdAt: projectFixture.createdAt, updatedAt: projectFixture.updatedAt,
  };
  const roadAsset: AssetDetail = {
    id: roadVersion.assetId, name: 'Piaskowa droga', description: roadVersion.aiDescription,
    category: 'road_tile', elevationLevels: 0, relativeWidth: 1, relativeHeight: 1, roadConnections: 15,
    currentApprovedVersionId: null, latestVersion: roadVersion, versionCount: 1, codexThreadId: null,
    createdAt: roadVersion.createdAt, updatedAt: roadVersion.updatedAt, versions: [roadVersion],
  };
  vi.mocked(window.tilemap.projects.current).mockResolvedValue(projectFixture);
  vi.mocked(window.tilemap.assets.list).mockResolvedValue([roadAsset]);
  vi.mocked(window.tilemap.assets.get).mockResolvedValue(roadAsset);
  vi.mocked(window.tilemap.generation.jobs).mockResolvedValue([]);
  vi.mocked(window.tilemap.style.history).mockResolvedValue([]);
  vi.mocked(window.tilemap.codex.health).mockResolvedValue({
    state: 'ready', version: '0.142.5', appServer: true, imageGeneration: true,
    imagegenSkill: true, skillPath: 'C:\\imagegen\\SKILL.md', logPath: null, message: 'Gotowe',
  });

  const view = render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: /Piaskowa droga/i }));

  await screen.findByAltText('Piaskowa droga: T · NW–NE–SE');
  expect(view.container.querySelectorAll('.road-variant-card')).toHaveLength(16);
  expect(view.container.querySelectorAll('.road-anchor')).toHaveLength(0);
  expect(screen.getByDisplayValue('16 / 16')).toBeInTheDocument();
});

it('pokazuje retry po nieudanej generacji także bez aktywnego joba', async () => {
  const retry = vi.fn(async () => ({
    id: '22222222-2222-4222-8222-222222222222',
    assetId: '33333333-3333-4333-8333-333333333333',
    versionId: '44444444-4444-4444-8444-444444444444',
    status: 'queued' as const,
    progress: 'Oczekuje w kolejce',
    error: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  vi.mocked(window.tilemap.projects.current).mockResolvedValue({
    id: '11111111-1111-4111-8111-111111111111',
    rootPath: 'C:\\project',
    name: 'Test',
    artBrief: '',
    projection: 'isometric',
    tileWidthPx: 256,
    tileHeightPx: 128,
    pixelsPerUnit: 256,
    maxConcurrentJobs: 1,
    aiVerificationEnabled: true,
    styleSummary: '',
    styleSummaryStale: false,
    exportTargets: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  vi.mocked(window.tilemap.assets.list).mockResolvedValue([]);
  vi.mocked(window.tilemap.generation.jobs).mockResolvedValue([{
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    assetId: '33333333-3333-4333-8333-333333333333',
    versionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    status: 'failed',
    progress: 'Generacja nie powiodła się',
    error: "The 'gpt-5.6-sol' model requires a newer version of Codex.",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }]);
  vi.mocked(window.tilemap.generation.retry).mockImplementation(retry);
  vi.mocked(window.tilemap.style.history).mockResolvedValue([]);
  vi.mocked(window.tilemap.codex.health).mockResolvedValue({
    state: 'ready', version: '0.142.5', appServer: true, imageGeneration: true,
    imagegenSkill: true, skillPath: 'C:\\imagegen\\SKILL.md', logPath: 'C:\\logs\\main.jsonl',
    message: 'Gotowe',
  });

  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  const button = await screen.findByRole('button', { name: /Ponów generację/i });
  expect(screen.getByText(/requires a newer version of Codex/i)).toBeInTheDocument();
  fireEvent.click(button);
  await waitFor(() => expect(retry).toHaveBeenCalledWith('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
});

it('pokazuje szczegóły błędu w modalu i krótką akcję Ponów obok statusu', async () => {
  const failedVersion: AssetVersion = {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', assetId: '33333333-3333-4333-8333-333333333333',
    parentVersionId: null, mode: 'generate', status: 'failed', prompt: 'Zielona łąka', feedback: '',
    category: 'flat_tile', elevationLevels: 0, relativeWidth: 1, relativeHeight: 1, characterAnimation: null, tags: ['łąka'], finalPath: null, imageUrl: null, width: null, height: null,
    footprint: { x: 1, y: 1 }, pivot: { x: 0.5, y: 0.5 }, aiDescription: 'Łąka', aiVerificationStatus: 'passed', aiVerificationMessage: '', rejectionReason: '',
    error: 'Pełny komunikat błędu generacji.', createdAt: '2026-08-07T10:00:00.000Z', updatedAt: '2026-08-07T10:00:00.000Z',
  };
  const failedAsset: AssetDetail = {
    id: failedVersion.assetId, name: 'Łąka', description: 'Łąka', category: 'flat_tile', elevationLevels: 0, relativeWidth: 1, relativeHeight: 1, currentApprovedVersionId: null,
    latestVersion: failedVersion, versionCount: 1, codexThreadId: null, createdAt: failedVersion.createdAt,
    updatedAt: failedVersion.updatedAt, versions: [failedVersion],
  };
  vi.mocked(window.tilemap.projects.current).mockResolvedValue({
    id: '11111111-1111-4111-8111-111111111111', rootPath: 'C:\\project', name: 'Test', artBrief: '',
    projection: 'isometric', tileWidthPx: 256, tileHeightPx: 128, pixelsPerUnit: 256,
    maxConcurrentJobs: 1,
    aiVerificationEnabled: true,
    styleSummary: '',
    styleSummaryStale: false, exportTargets: {}, createdAt: failedVersion.createdAt, updatedAt: failedVersion.updatedAt,
  });
  vi.mocked(window.tilemap.assets.list).mockResolvedValue([failedAsset]);
  vi.mocked(window.tilemap.assets.get).mockResolvedValue(failedAsset);
  vi.mocked(window.tilemap.generation.jobs).mockResolvedValue([{
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', assetId: failedAsset.id, versionId: failedVersion.id,
    status: 'failed', progress: 'Generacja nie powiodła się', error: failedVersion.error,
    createdAt: failedVersion.createdAt, updatedAt: failedVersion.updatedAt,
  }]);
  vi.mocked(window.tilemap.generation.retry).mockResolvedValue({
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', assetId: failedAsset.id,
    versionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', status: 'queued', progress: 'Oczekuje', error: '',
    createdAt: failedVersion.createdAt, updatedAt: failedVersion.updatedAt,
  });
  vi.mocked(window.tilemap.style.history).mockResolvedValue([]);
  vi.mocked(window.tilemap.codex.health).mockResolvedValue({
    state: 'ready', version: '0.142.5', appServer: true, imageGeneration: true, imagegenSkill: true,
    skillPath: 'C:\\imagegen\\SKILL.md', logPath: 'C:\\logs\\main.jsonl', message: 'Gotowe',
  });

  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: /Łąka/i }));

  const errorStatus = await screen.findByRole('button', { name: 'Błąd — pokaż szczegóły' });
  const failedPreview = screen.getByText('Błąd', { selector: '.failed-preview span' });
  expect(failedPreview.closest('.image-stage')).toHaveClass('failed-stage');
  expect(failedPreview.parentElement?.querySelector('svg')).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(errorStatus);
  expect(screen.getByRole('dialog')).toHaveTextContent('Pełny komunikat błędu generacji.');
  fireEvent.click(screen.getByRole('button', { name: 'Zamknij szczegóły błędu' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Ponów' }));
  await waitFor(() => expect(window.tilemap.generation.retry).toHaveBeenCalledWith('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
});

it('pokazuje przycisk Weryfikacja w miejscu akcji statusu, gdy kontrola AI została pominięta', async () => {
  const unverifiedVersion: AssetVersion = {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', assetId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    parentVersionId: null, mode: 'generate', status: 'needs_review', prompt: 'Omszały kamień', feedback: '',
    category: 'other', elevationLevels: 0, relativeWidth: 1, relativeHeight: 1, characterAnimation: null, tags: ['kamień'],
    finalPath: 'assets/stone/final.png', imageUrl: 'tilemap-asset://project/assets/stone/final.png',
    width: 128, height: 128, footprint: { x: 1, y: 1 }, pivot: { x: 0.5, y: 0.5 },
    aiDescription: 'Omszały kamień', aiVerificationStatus: 'pending', aiVerificationMessage: '',
    rejectionReason: '', error: '', createdAt: projectFixture.createdAt, updatedAt: projectFixture.updatedAt,
  };
  const unverifiedAsset: AssetDetail = {
    id: unverifiedVersion.assetId, name: 'Omszały kamień', description: unverifiedVersion.aiDescription,
    category: 'other', elevationLevels: 0, relativeWidth: 1, relativeHeight: 1,
    currentApprovedVersionId: null, latestVersion: unverifiedVersion, versionCount: 1, codexThreadId: null,
    createdAt: unverifiedVersion.createdAt, updatedAt: unverifiedVersion.updatedAt, versions: [unverifiedVersion],
  };
  const verifiedVersion: AssetVersion = {
    ...unverifiedVersion,
    aiVerificationStatus: 'passed',
    aiVerificationMessage: 'Asset jest zgodny z briefem.',
  };
  const verifiedAsset: AssetDetail = {
    ...unverifiedAsset,
    latestVersion: verifiedVersion,
    versions: [verifiedVersion],
  };
  vi.mocked(window.tilemap.projects.current).mockResolvedValue({ ...projectFixture, aiVerificationEnabled: false });
  vi.mocked(window.tilemap.assets.list).mockResolvedValue([unverifiedAsset]);
  vi.mocked(window.tilemap.assets.get).mockResolvedValueOnce(unverifiedAsset).mockResolvedValue(verifiedAsset);
  vi.mocked(window.tilemap.generation.jobs).mockResolvedValue([]);
  vi.mocked(window.tilemap.generation.verify).mockResolvedValue(verifiedAsset);
  vi.mocked(window.tilemap.style.history).mockResolvedValue([]);
  vi.mocked(window.tilemap.codex.health).mockResolvedValue({
    state: 'ready', version: '0.142.5', appServer: true, imageGeneration: true, imagegenSkill: true,
    skillPath: 'C:\\imagegen\\SKILL.md', logPath: null, message: 'Gotowe',
  });

  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: /Omszały kamień/i }));

  const verifyButton = await screen.findByRole('button', { name: 'Weryfikacja' });
  expect(verifyButton.closest('.status-actions')).toBeInTheDocument();
  fireEvent.click(verifyButton);
  await waitFor(() => expect(window.tilemap.generation.verify).toHaveBeenCalledWith(unverifiedVersion.id));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Weryfikacja' })).not.toBeInTheDocument());
});

it('układa dziewięć kopii terenu w podglądzie szwów', () => {
  const onZoom = vi.fn();
  const view = render(<TerrainSeamPreview
    assetName="Łąka"
    tileWidth={256}
    tileHeight={128}
    zoom={175}
    onZoom={onZoom}
    version={{
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      assetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      parentVersionId: null,
      mode: 'generate',
      status: 'needs_review',
      prompt: 'Zielona łąka',
      feedback: '',
      category: 'flat_tile',
      characterAnimation: null,
      elevationLevels: 0,
      relativeWidth: 1,
      relativeHeight: 1,
      tags: ['łąka'],
      finalPath: 'assets/meadow/final.png',
      imageUrl: 'tilemap-asset://asset/meadow.png',
      width: 256,
      height: 128,
      footprint: { x: 1, y: 1 },
      pivot: { x: 0.5, y: 0.5 },
      aiDescription: '',
      aiVerificationStatus: 'passed',
      aiVerificationMessage: '',
      rejectionReason: '',
      error: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }}
  />);

  expect(screen.getByRole('region', { name: /Podgląd powtarzania terenu Łąka/i })).toBeInTheDocument();
  expect(view.container.querySelectorAll('.seam-tile')).toHaveLength(9);
  expect(view.container.querySelector('.seam-grid')).toHaveStyle({ width: '1344px', height: '672px' });
  expect(view.container.querySelector('.seam-tile[data-column="3"][data-row="2"]')).toHaveStyle({ left: '896px', top: '448px' });

  const stage = screen.getByRole('region', { name: /Podgląd powtarzania terenu Łąka/i });
  fireEvent.wheel(stage, { deltaY: -100, clientX: 100, clientY: 80 });
  expect(onZoom).toHaveBeenCalledWith(200);

  fireEvent.doubleClick(stage);
  fireEvent.pointerDown(stage, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(stage, { pointerId: 1, clientX: 132, clientY: 116 });
  expect(view.container.querySelector('.seam-grid')).toHaveStyle({
    '--preview-pan-x': '32px',
    '--preview-pan-y': '16px',
  });
});

it('układa konfigurowalny podgląd szwów top-down na prostokątnej siatce 5×2', () => {
  const version: AssetVersion = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    assetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    parentVersionId: null,
    mode: 'generate',
    status: 'needs_review',
    prompt: '',
    feedback: '',
    category: 'flat_tile',
    characterAnimation: null,
    elevationLevels: 0,
    relativeWidth: 1,
    relativeHeight: 1,
    tags: ['łąka'],
    finalPath: 'assets/meadow/final.png',
    imageUrl: 'tilemap-asset://asset/meadow.png',
    width: 256,
    height: 256,
    footprint: { x: 1, y: 1 },
    pivot: { x: 0.5, y: 0.5 },
    aiDescription: '',
    aiVerificationStatus: 'passed',
    aiVerificationMessage: '',
    rejectionReason: '',
    error: '',
    createdAt: projectFixture.createdAt,
    updatedAt: projectFixture.updatedAt,
  };
  const view = render(<TerrainSeamPreview
    assetName="Łąka"
    tileWidth={256}
    tileHeight={256}
    projection="top_down"
    columns={5}
    rows={2}
    zoom={100}
    onZoom={vi.fn()}
    version={version}
  />);

  expect(view.container.querySelectorAll('.seam-tile')).toHaveLength(10);
  expect(view.container.querySelector('.seam-grid')).toHaveStyle({ width: '1280px', height: '512px' });
  expect(view.container.querySelector('.seam-tile[data-column="5"][data-row="2"]')).toHaveStyle({ left: '1152px', top: '384px' });
});

it('mieści izometryczną siatkę 4×2 w pełnym bounding boxie', () => {
  const view = render(<TerrainSeamPreview
    assetName="Łąka"
    tileWidth={256}
    tileHeight={128}
    projection="isometric"
    columns={4}
    rows={2}
    zoom={100}
    onZoom={vi.fn()}
    version={terrainVersionFixture()}
  />);

  const tiles = view.container.querySelectorAll('.seam-tile');
  expect(tiles).toHaveLength(8);
  expect(Array.from(tiles).map((tile) => `${tile.getAttribute('data-column')}:${tile.getAttribute('data-row')}`)).toEqual([
    '1:1', '1:2', '2:1', '2:2', '3:1', '3:2', '4:1', '4:2',
  ]);
  expect(view.container.querySelector('.seam-grid')).toHaveStyle({ width: '768px', height: '384px' });
  expect(view.container.querySelector('.seam-tile[data-column="1"][data-row="2"]')).toHaveStyle({ left: '128px', top: '128px' });
  expect(view.container.querySelector('.seam-tile[data-column="4"][data-row="1"]')).toHaveStyle({ left: '640px', top: '256px' });
  expect(view.container.querySelector('.seam-tile[data-column="4"][data-row="2"]')).toHaveStyle({ left: '512px', top: '320px' });
});

it('dodaje wysokość podniesionego sprite’a do izometrycznego bounding boxu', () => {
  const view = render(<TerrainSeamPreview
    assetName="Urwisko"
    tileWidth={256}
    tileHeight={128}
    projection="isometric"
    spriteHeight={384}
    columns={2}
    rows={2}
    zoom={100}
    onZoom={vi.fn()}
    version={terrainVersionFixture({ category: 'elevated_tile', elevationLevels: 2, height: 384 })}
  />);

  expect(view.container.querySelector('.seam-grid')).toHaveStyle({ width: '512px', height: '512px' });
  expect(view.container.querySelector('.seam-tile[data-column="2"][data-row="2"]')).toHaveStyle({ top: '192px', height: '384px' });
});

it('steruje zoomem podglądu krokami i pozwala go zresetować', () => {
  const onZoom = vi.fn();
  render(<PreviewZoomControls zoom={100} onZoom={onZoom} />);
  fireEvent.click(screen.getByRole('button', { name: 'Powiększ podgląd' }));
  expect(onZoom).toHaveBeenCalledWith(125);
  fireEvent.click(screen.getByRole('button', { name: 'Pomniejsz podgląd' }));
  expect(onZoom).toHaveBeenCalledWith(75);
  fireEvent.click(screen.getByRole('button', { name: 'Resetuj zoom' }));
  expect(onZoom).toHaveBeenCalledWith(100);
});

it('dodaje obraz referencyjny z opisem i pozwala edytować opis', async () => {
  const reference = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'pustynia', description: 'Ciepła paleta piasku',
    relativePath: 'references/a.png', imageUrl: 'tilemap-asset://project/references/a.png', width: 1_024, height: 512,
    createdAt: '2026-08-07T10:00:00.000Z', updatedAt: '2026-08-07T10:00:00.000Z',
  };
  vi.mocked(window.tilemap.references.list).mockResolvedValue([reference]);
  vi.mocked(window.tilemap.references.add).mockResolvedValue(reference);
  vi.mocked(window.tilemap.references.update).mockResolvedValue({ ...reference, description: 'Nowy opis referencji' });

  render(<QueryClientProvider client={new QueryClient()}><ProjectReferencesPanel /></QueryClientProvider>);
  expect(await screen.findByRole('img', { name: 'pustynia' })).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: 'Opis nowej referencji' }), { target: { value: 'Inspiracja dla palety i faktury' } });
  fireEvent.click(screen.getByRole('button', { name: /Dodaj obraz/i }));
  await waitFor(() => expect(window.tilemap.references.add).toHaveBeenCalledWith({ description: 'Inspiracja dla palety i faktury' }));

  fireEvent.change(screen.getByRole('textbox', { name: 'Opis referencji pustynia' }), { target: { value: 'Nowy opis referencji' } });
  fireEvent.click(screen.getByRole('button', { name: /Zapisz opis/i }));
  await waitFor(() => expect(window.tilemap.references.update).toHaveBeenCalledWith({
    referenceId: reference.id, description: 'Nowy opis referencji',
  }));
});

it('wyjaśnia rozjazd wersji renderera i procesu głównego', async () => {
  vi.mocked(window.tilemap.references.list).mockRejectedValue(new Error("Error invoking remote method 'references:list': Error: No handler registered for 'references:list'"));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(<QueryClientProvider client={queryClient}><ProjectReferencesPanel /></QueryClientProvider>);

  expect(await screen.findByText(/Proces główny aplikacji jest w starszej wersji/i)).toBeInTheDocument();
  expect(screen.queryByText('Brak referencji projektu')).not.toBeInTheDocument();
});

it('pokazuje propozycję ustawień agenta i wymaga jawnego zastosowania', async () => {
  const proposal = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'pending' as const,
    reason: 'Referencja wymaga większej komórki 2:1.',
    before: { artBrief: '', tileWidthPx: 256, pixelsPerUnit: 256 },
    proposed: { tileWidthPx: 512, tileHeightPx: 256, pixelsPerUnit: 512 },
    referenceIds: [], createdAt: '2026-08-07T10:00:00.000Z', decidedAt: null,
  };
  vi.mocked(window.tilemap.projects.settingsProposals).mockResolvedValue([proposal]);
  vi.mocked(window.tilemap.projects.reviewSettingsProposal).mockResolvedValue({ ...proposal, status: 'approved' });

  render(<QueryClientProvider client={new QueryClient()}><ProjectSettingsProposalsPanel /></QueryClientProvider>);

  expect(await screen.findByText('Referencja wymaga większej komórki 2:1.')).toBeInTheDocument();
  expect(screen.getByText('256px')).toBeInTheDocument();
  expect(screen.getByText('512px')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Zastosuj/i }));
  await waitFor(() => expect(window.tilemap.projects.reviewSettingsProposal).toHaveBeenCalledWith({
    proposalId: proposal.id, decision: 'approved',
  }));
});

it('pokazuje cykl generowania, weryfikacji i auto-retry pod wersjami', async () => {
  const assetId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  vi.mocked(window.tilemap.generation.logs).mockResolvedValue([
    {
      id: '11111111-1111-4111-8111-111111111111', jobId: '22222222-2222-4222-8222-222222222222',
      assetId, versionId: '33333333-3333-4333-8333-333333333333', stage: 'generation', level: 'info',
      attempt: 1, message: 'Rozpoczęto generowanie obrazu.', details: null, previewUrl: null, createdAt: '2026-08-07T10:00:00.000Z',
    },
    {
      id: '44444444-4444-4444-8444-444444444444', jobId: '22222222-2222-4222-8222-222222222222',
      assetId, versionId: '33333333-3333-4333-8333-333333333333', stage: 'verification', level: 'warning',
      attempt: 1, message: 'Wykryto szczeliny.', details: null,
      previewUrl: 'tilemap-asset://project/staging/job/attempt-1/final.png', createdAt: '2026-08-07T10:01:00.000Z',
    },
    {
      id: '55555555-5555-4555-8555-555555555555', jobId: '22222222-2222-4222-8222-222222222222',
      assetId, versionId: '33333333-3333-4333-8333-333333333333', stage: 'retry', level: 'warning',
      attempt: 1, message: 'Zaplanowano automatyczną próbę 2/3.', details: null, previewUrl: null, createdAt: '2026-08-07T10:01:01.000Z',
    },
    {
      id: '66666666-6666-4666-8666-666666666666', jobId: '22222222-2222-4222-8222-222222222222',
      assetId, versionId: '33333333-3333-4333-8333-333333333333', stage: 'review', level: 'warning',
      attempt: 0, message: 'Odrzucono wersję. Powód: widoczne szwy.', details: null, previewUrl: null, createdAt: '2026-08-07T10:02:00.000Z',
    },
    {
      id: '77777777-7777-4777-8777-777777777777', jobId: '22222222-2222-4222-8222-222222222222',
      assetId, versionId: '33333333-3333-4333-8333-333333333333', stage: 'generation', level: 'info',
      attempt: 2, message: 'Codex szuka assetów w registry — fraza „kamienna droga” · kategoria flat_tile.',
      details: { tool: 'registry.search_assets', arguments: { query: 'kamienna droga', category: 'flat_tile', limit: 5 } },
      previewUrl: null,
      createdAt: '2026-08-07T10:02:01.000Z',
    },
  ]);

  render(<QueryClientProvider client={new QueryClient()}><GenerationLogPanel assetId={assetId} active /></QueryClientProvider>);
  expect(await screen.findByText('Rozpoczęto generowanie obrazu.')).toBeInTheDocument();
  expect(screen.getByText('Wykryto szczeliny.')).toBeInTheDocument();
  expect(screen.getByText('Auto-retry')).toBeInTheDocument();
  expect(screen.getByText('Review')).toBeInTheDocument();
  expect(screen.getByText('Odrzucono wersję. Powód: widoczne szwy.')).toBeInTheDocument();
  expect(screen.queryByText('Szczegóły wywołania')).not.toBeInTheDocument();
  expect(screen.queryByText('registry.search_assets')).not.toBeInTheDocument();
  const detailsToggle = screen.getByRole('button', { name: 'Pokaż szczegóły wywołania' });
  expect(detailsToggle).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(detailsToggle);
  expect(screen.getByText('registry.search_assets')).toBeInTheDocument();
  expect(detailsToggle).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Pokaż podgląd nieudanej próby 1' }));
  expect(screen.getByRole('dialog', { name: 'Próba 1' })).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Asset odrzucony w próbie 1' })).toHaveAttribute(
    'src',
    'tilemap-asset://project/staging/job/attempt-1/final.png',
  );
  expect(screen.getByText('AKTYWNA')).toBeInTheDocument();
});

it('zastępuje identyfikator referencji jej opisem i pokazuje obraz w tym samym wpisie logu', async () => {
  const assetId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const reference = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'painted-forest',
    description: 'Miękka malowana faktura lasu i chłodna zielona paleta',
    relativePath: 'references/forest.png',
    imageUrl: 'tilemap-asset://project/references/forest.png',
    width: 1_024,
    height: 512,
    createdAt: '2026-08-07T10:00:00.000Z',
    updatedAt: '2026-08-07T10:00:00.000Z',
  };
  vi.mocked(window.tilemap.references.list).mockResolvedValue([reference]);
  vi.mocked(window.tilemap.generation.logs).mockResolvedValue([{
    id: '11111111-1111-4111-8111-111111111111',
    jobId: '22222222-2222-4222-8222-222222222222',
    assetId,
    versionId: '33333333-3333-4333-8333-333333333333',
    stage: 'generation',
    level: 'info',
    attempt: 1,
    message: `Codex pobiera projektowy obraz referencyjny: ${reference.id}.`,
    details: { tool: 'registry.get_reference', arguments: { referenceId: reference.id } },
    previewUrl: null,
    createdAt: '2026-08-07T10:01:00.000Z',
  }]);

  render(<QueryClientProvider client={new QueryClient()}><GenerationLogPanel assetId={assetId} active={false} /></QueryClientProvider>);

  expect(await screen.findByText(`Codex pobiera projektowy obraz referencyjny: ${reference.description}.`)).toBeInTheDocument();
  expect(screen.queryByText(`Codex pobiera projektowy obraz referencyjny: ${reference.id}.`)).not.toBeInTheDocument();
  const previewButton = screen.getByRole('button', { name: `Pokaż obraz referencyjny ${reference.name}` });
  expect(previewButton.querySelector('img')).toHaveAttribute('src', reference.imageUrl);
  fireEvent.click(previewButton);
  expect(screen.getByRole('dialog', { name: reference.name })).toBeInTheDocument();
  expect(screen.getByText('OBRAZ REFERENCYJNY')).toBeInTheDocument();
  expect(screen.getByRole('img', { name: `Obraz referencyjny ${reference.name}` })).toHaveAttribute('src', reference.imageUrl);
});

it('pozwala przegenerować bez opisu i cofnąć odrzucenie', async () => {
  const version: AssetVersion = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', assetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    parentVersionId: null, mode: 'generate', status: 'rejected', prompt: 'Zielona łąka', feedback: '',
    category: 'flat_tile', elevationLevels: 0, relativeWidth: 1, relativeHeight: 1, characterAnimation: null, tags: ['łąka'], finalPath: 'assets/meadow/final.png',
    imageUrl: 'tilemap-asset://asset/meadow.png', width: 256, height: 128,
    footprint: { x: 1, y: 1 }, pivot: { x: 0.5, y: 0.5 }, aiDescription: 'Łąka', aiVerificationStatus: 'passed', aiVerificationMessage: '',
    rejectionReason: 'Za ciemna', error: '', createdAt: '2026-08-07T10:00:00.000Z', updatedAt: '2026-08-07T10:00:00.000Z',
  };
  const asset: AssetDetail = {
    id: version.assetId, name: 'Łąka', description: 'Łąka', category: 'flat_tile', elevationLevels: 0, relativeWidth: 1, relativeHeight: 1,
    currentApprovedVersionId: null, latestVersion: version, versionCount: 1, codexThreadId: null,
    createdAt: version.createdAt, updatedAt: version.updatedAt, versions: [version],
  };
  vi.mocked(window.tilemap.generation.enqueue).mockResolvedValue([{
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', assetId: asset.id,
    versionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', status: 'queued', progress: 'Oczekuje', error: '',
    createdAt: version.createdAt, updatedAt: version.updatedAt,
  }]);
  vi.mocked(window.tilemap.assets.undoRejection).mockResolvedValue({
    ...asset, versions: [{ ...version, status: 'needs_review', rejectionReason: '' }],
  });

  render(<QueryClientProvider client={new QueryClient()}><ReviewControls
    asset={asset} version={version} project={projectFixture} onChanged={() => undefined}
  /></QueryClientProvider>);

  const regenerate = screen.getByRole('button', { name: /Przegeneruj/i });
  expect(regenerate).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Typ assetu'), { target: { value: 'elevated_tile' } });
  fireEvent.change(screen.getByLabelText('Elevation height (poziomy)'), { target: { value: '3' } });
  fireEvent.click(regenerate);
  await waitFor(() => expect(window.tilemap.generation.enqueue).toHaveBeenCalledWith(expect.objectContaining({
    assetId: asset.id, parentVersionId: version.id, mode: 'variant', feedback: '',
    category: 'elevated_tile', elevationLevels: 3,
  })));
  expect(vi.mocked(window.tilemap.generation.enqueue).mock.calls[0][0]).not.toHaveProperty('pivot');

  fireEvent.click(screen.getByRole('button', { name: /Cofnij odrzucenie/i }));
  await waitFor(() => expect(window.tilemap.assets.undoRejection).toHaveBeenCalledWith(version.id));
});

it('pokazuje pivot wyznaczony przez AI dopiero w review i pozwala go nadpisać przed zatwierdzeniem', async () => {
  const version: AssetVersion = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', assetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    parentVersionId: null, mode: 'generate', status: 'needs_review', prompt: 'Stary dąb', feedback: '',
    category: 'vegetation', elevationLevels: 0, relativeWidth: 1, relativeHeight: 1, characterAnimation: null, tags: ['drzewo'],
    finalPath: 'assets/oak/final.png', imageUrl: 'tilemap-asset://asset/oak.png', width: 256, height: 256,
    footprint: { x: 2, y: 2 }, pivot: { x: 0.48, y: 0.12 }, aiDescription: 'Stary dąb', aiVerificationStatus: 'passed', aiVerificationMessage: '',
    rejectionReason: '', error: '', createdAt: '2026-08-07T10:00:00.000Z', updatedAt: '2026-08-07T10:00:00.000Z',
  };
  const asset: AssetDetail = {
    id: version.assetId, name: 'Dąb', description: 'Stary dąb', category: 'vegetation', elevationLevels: 0,
    relativeWidth: 1, relativeHeight: 1, currentApprovedVersionId: null, latestVersion: version, versionCount: 1,
    codexThreadId: null, createdAt: version.createdAt, updatedAt: version.updatedAt, versions: [version],
  };
  vi.mocked(window.tilemap.assets.review).mockResolvedValue({
    ...asset, currentApprovedVersionId: version.id, versions: [{ ...version, status: 'approved', pivot: { x: 0.5, y: 0.09 } }],
  });

  render(<QueryClientProvider client={new QueryClient()}><ReviewControls
    asset={asset} version={version} project={projectFixture} onChanged={() => undefined}
  /></QueryClientProvider>);

  expect(screen.getByLabelText('Pivot X (propozycja AI)')).toHaveValue(0.48);
  expect(screen.getByLabelText('Pivot Y (propozycja AI)')).toHaveValue(0.12);
  fireEvent.change(screen.getByLabelText('Pivot X (propozycja AI)'), { target: { value: '0.5' } });
  fireEvent.change(screen.getByLabelText('Pivot Y (propozycja AI)'), { target: { value: '0.09' } });
  fireEvent.click(screen.getByRole('button', { name: /^Zatwierdź$/i }));

  await waitFor(() => expect(window.tilemap.assets.review).toHaveBeenCalledWith(expect.objectContaining({
    versionId: version.id, decision: 'approved', pivot: { x: 0.5, y: 0.09 },
  })));
});

it('blokuje drugie zatwierdzenie i pozwala cofnąć bieżące', async () => {
  const pendingVersion: AssetVersion = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', assetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    parentVersionId: null, mode: 'variant', status: 'needs_review', prompt: 'Zielona łąka', feedback: '',
    category: 'flat_tile', elevationLevels: 0, relativeWidth: 1, relativeHeight: 1, characterAnimation: null, tags: ['łąka'], finalPath: 'assets/meadow/pending.png',
    imageUrl: 'tilemap-asset://asset/pending.png', width: 256, height: 128,
    footprint: { x: 1, y: 1 }, pivot: { x: 0.5, y: 0.5 }, aiDescription: 'Nowa łąka', aiVerificationStatus: 'passed', aiVerificationMessage: '',
    rejectionReason: '', error: '', createdAt: '2026-08-07T10:01:00.000Z', updatedAt: '2026-08-07T10:01:00.000Z',
  };
  const approvedVersion: AssetVersion = {
    ...pendingVersion,
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    status: 'approved',
    finalPath: 'assets/meadow/approved.png',
    imageUrl: 'tilemap-asset://asset/approved.png',
    aiDescription: 'Zatwierdzona łąka', aiVerificationStatus: 'passed', aiVerificationMessage: '',
    createdAt: '2026-08-07T10:00:00.000Z',
    updatedAt: '2026-08-07T10:00:00.000Z',
  };
  const asset: AssetDetail = {
    id: pendingVersion.assetId, name: 'Łąka', description: 'Łąka', category: 'flat_tile', elevationLevels: 0, relativeWidth: 1, relativeHeight: 1,
    currentApprovedVersionId: approvedVersion.id, latestVersion: pendingVersion, versionCount: 2, codexThreadId: null,
    createdAt: approvedVersion.createdAt, updatedAt: pendingVersion.updatedAt,
    versions: [pendingVersion, approvedVersion],
  };

  render(<QueryClientProvider client={new QueryClient()}><ReviewControls
    asset={asset} version={pendingVersion} project={projectFixture} onChanged={() => undefined}
  /></QueryClientProvider>);
  expect(screen.getByText(/Tylko jedna wersja assetu może być zatwierdzona/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Zatwierdź$/i })).toBeDisabled();

  cleanup();
  vi.mocked(window.tilemap.assets.undoApproval).mockResolvedValue({
    ...asset,
    currentApprovedVersionId: null,
    versions: [pendingVersion, { ...approvedVersion, status: 'needs_review' }],
  });
  render(<QueryClientProvider client={new QueryClient()}><ReviewControls
    asset={asset} version={approvedVersion} project={projectFixture} onChanged={() => undefined}
  /></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: /Cofnij zatwierdzenie/i }));
  await waitFor(() => expect(window.tilemap.assets.undoApproval).toHaveBeenCalledWith(approvedVersion.id));
});

it('pokazuje podejścia w prawym sidebarze assetu, a Art Direction tylko na poziomie projektu', async () => {
  const version: AssetVersion = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', assetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    parentVersionId: null, mode: 'generate', status: 'needs_review', prompt: 'Zielona łąka', feedback: '',
    category: 'flat_tile', elevationLevels: 0, relativeWidth: 1, relativeHeight: 1, characterAnimation: null, tags: ['łąka'], finalPath: 'assets/meadow/final.png',
    imageUrl: 'tilemap-asset://asset/meadow.png', width: 256, height: 128,
    footprint: { x: 1, y: 1 }, pivot: { x: 0.5, y: 0.5 }, aiDescription: 'Łąka', aiVerificationStatus: 'passed', aiVerificationMessage: '', rejectionReason: '', error: '',
    createdAt: '2026-08-07T10:00:00.000Z', updatedAt: '2026-08-07T10:00:00.000Z',
  };
  const detail: AssetDetail = {
    id: version.assetId, name: 'Łąka', description: 'Łąka', category: 'flat_tile', elevationLevels: 0, relativeWidth: 1, relativeHeight: 1, currentApprovedVersionId: null,
    latestVersion: version, versionCount: 1, codexThreadId: null, createdAt: version.createdAt,
    updatedAt: version.updatedAt, versions: [version],
  };
  vi.mocked(window.tilemap.projects.current).mockResolvedValue({
    id: '11111111-1111-4111-8111-111111111111', rootPath: 'C:\\project', name: 'Test', artBrief: 'Kreskówkowy',
    projection: 'isometric', tileWidthPx: 256, tileHeightPx: 128, pixelsPerUnit: 256,
    maxConcurrentJobs: 1,
    aiVerificationEnabled: true,
    styleSummary: '',
    styleSummaryStale: false, exportTargets: {}, createdAt: version.createdAt, updatedAt: version.updatedAt,
  });
  vi.mocked(window.tilemap.assets.list).mockResolvedValue([detail]);
  vi.mocked(window.tilemap.assets.get).mockResolvedValue(detail);
  vi.mocked(window.tilemap.generation.jobs).mockResolvedValue([]);
  vi.mocked(window.tilemap.style.history).mockResolvedValue([]);
  vi.mocked(window.tilemap.codex.health).mockResolvedValue({
    state: 'ready', version: '0.142.5', appServer: true, imageGeneration: true, imagegenSkill: true,
    skillPath: 'C:\\imagegen\\SKILL.md', logPath: 'C:\\logs\\main.jsonl', message: 'Gotowe',
  });

  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  expect(await screen.findByRole('heading', { name: 'DNA stylu' })).toBeInTheDocument();
  fireEvent.click(await screen.findByRole('button', { name: /Łąka/i }));
  expect(await screen.findByRole('heading', { name: 'Podejścia' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'DNA stylu' })).not.toBeInTheDocument();
  const generationLog = await screen.findByRole('region', { name: 'Dziennik generacji' });
  expect(generationLog.closest('.review-page')).not.toBeNull();
  expect(generationLog.closest('.asset-attempts-panel')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: /Tile obok tile/i }));
  const gridSize = screen.getByRole('group', { name: 'Rozmiar siatki podglądu' });
  expect(gridSize).toHaveAttribute('title', 'W izometrii szerokość i wysokość biegną po przekątnych siatki.');
  const columns = within(gridSize).getByRole('spinbutton', { name: 'Szerokość podglądu w kaflach' });
  const rows = within(gridSize).getByRole('spinbutton', { name: 'Wysokość podglądu w kaflach' });
  expect(columns).toHaveValue(3);
  expect(columns).toHaveAttribute('min', '1');
  expect(columns).toHaveAttribute('max', '16');
  expect(rows).toHaveValue(3);
  fireEvent.change(columns, { target: { value: '99' } });
  expect(columns).toHaveValue(16);
  fireEvent.change(rows, { target: { value: '0' } });
  expect(rows).toHaveValue(1);
  fireEvent.change(columns, { target: { value: '5' } });
  fireEvent.change(rows, { target: { value: '2' } });
  expect(document.querySelectorAll('.seam-tile')).toHaveLength(10);
  expect(document.querySelector('.seam-tile[data-column="5"][data-row="2"]')).toHaveStyle({ left: '640px', top: '384px' });
  expect(document.querySelectorAll('.seam-tile[aria-hidden="true"]')).toHaveLength(10);
  const stage = screen.getByRole('region', { name: /Podgląd powtarzania terenu Łąka/i });
  fireEvent.click(screen.getByRole('button', { name: 'Powiększ podgląd' }));
  fireEvent.pointerDown(stage, { button: 0, pointerId: 7, clientX: 100, clientY: 80 });
  fireEvent.pointerMove(stage, { pointerId: 7, clientX: 124, clientY: 92 });
  expect(document.querySelector('.seam-grid')).toHaveStyle({ '--preview-pan-x': '24px', '--preview-pan-y': '12px' });
  fireEvent.change(rows, { target: { value: '3' } });
  expect(screen.getByRole('button', { name: 'Resetuj zoom' })).toHaveTextContent('125%');
  expect(document.querySelector('.seam-grid')).toHaveStyle({ '--preview-pan-x': '0px', '--preview-pan-y': '0px' });

  fireEvent.click(screen.getByRole('button', { name: /Nowy asset/i }));
  expect(await screen.findByRole('heading', { name: 'DNA stylu' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Podejścia' })).not.toBeInTheDocument();
});

it('otwiera stronę projektu z nagłówka i wylicza wysokość bazowego tile 2:1', async () => {
  const project = {
    id: '11111111-1111-4111-8111-111111111111',
    rootPath: 'C:\\project',
    name: 'Test',
    artBrief: '',
    projection: 'isometric' as const,
    tileWidthPx: 256,
    tileHeightPx: 128,
    pixelsPerUnit: 256,
    maxConcurrentJobs: 1,
    aiVerificationEnabled: true,
    styleSummary: '',
    styleSummaryStale: false,
    exportTargets: {},
    createdAt: '2026-08-07T10:00:00.000Z',
    updatedAt: '2026-08-07T10:00:00.000Z',
  };
  vi.mocked(window.tilemap.projects.current).mockResolvedValue(project);
  vi.mocked(window.tilemap.projects.update).mockResolvedValue({
    ...project,
    tileWidthPx: 512,
    tileHeightPx: 256,
    maxConcurrentJobs: 4,
    aiVerificationEnabled: false,
    comfyUiEnabled: true,
  });
  vi.mocked(window.tilemap.assets.list).mockResolvedValue([]);
  vi.mocked(window.tilemap.generation.jobs).mockResolvedValue([]);
  vi.mocked(window.tilemap.style.history).mockResolvedValue([]);
  vi.mocked(window.tilemap.codex.health).mockResolvedValue({
    state: 'ready', version: '0.142.5', appServer: true, imageGeneration: true,
    imagegenSkill: true, skillPath: 'C:\\imagegen\\SKILL.md', logPath: null, message: 'Gotowe',
  });

  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Strona główna projektu Test' }));
  expect(await screen.findByRole('heading', { name: 'Bazowa jednostka projektu' })).toBeInTheDocument();
  expect(await screen.findByText('Polecany: Z-Image Turbo Q4_K')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Bazowa szerokość tile (px)'), { target: { value: '512' } });
  fireEvent.change(screen.getByLabelText('Maks. jednoczesnych zadań'), { target: { value: '4' } });
  const aiVerification = screen.getByLabelText(/Weryfikacja AI po generowaniu/);
  expect(aiVerification).toBeChecked();
  fireEvent.click(aiVerification);
  const comfyUi = screen.getByLabelText(/ComfyUI · Z-Image Turbo/);
  expect(comfyUi).not.toBeChecked();
  fireEvent.click(comfyUi);
  const stableDiffusionCpp = screen.getByLabelText(/stable-diffusion\.cpp · Z-Image Turbo/);
  expect(stableDiffusionCpp).not.toBeChecked();
  fireEvent.click(stableDiffusionCpp);
  expect(screen.getByLabelText('Wysokość rombu 2:1')).toHaveValue('256px');
  fireEvent.click(screen.getByRole('button', { name: /Zapisz ustawienia/i }));

  await waitFor(() => expect(window.tilemap.projects.update).toHaveBeenCalledWith(expect.objectContaining({
    tileWidthPx: 512, maxConcurrentJobs: 4, aiVerificationEnabled: false,
    codexGenerationEnabled: true, comfyUiEnabled: true, comfyUiProfile: 'z_image_turbo',
    stableDiffusionCppEnabled: true,
  })));
});

it('pokazuje niemutowalną projekcję top-down i zapisuje nieparzystą bazę 1:1', async () => {
  const project: ProjectInfo = {
    ...projectFixture,
    projection: 'top_down',
    tileWidthPx: 255,
    tileHeightPx: 255,
    pixelsPerUnit: 255,
  };
  vi.mocked(window.tilemap.projects.current).mockResolvedValue(project);
  vi.mocked(window.tilemap.projects.update).mockResolvedValue({
    ...project, tileWidthPx: 257, tileHeightPx: 257,
  });
  vi.mocked(window.tilemap.assets.list).mockResolvedValue([]);
  vi.mocked(window.tilemap.generation.jobs).mockResolvedValue([]);
  vi.mocked(window.tilemap.style.history).mockResolvedValue([]);
  vi.mocked(window.tilemap.codex.health).mockResolvedValue({
    state: 'ready', version: '0.142.5', appServer: true, imageGeneration: true,
    imagegenSkill: true, skillPath: 'C:\\imagegen\\SKILL.md', logPath: null, message: 'Gotowe',
  });

  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Strona główna projektu Test' }));
  expect(await screen.findByLabelText('Projekcja projektu')).toHaveValue('Top-down 1:1');
  expect(screen.getByLabelText('Wysokość tile 1:1')).toHaveValue('255px');
  fireEvent.change(screen.getByLabelText('Bazowa szerokość tile (px)'), { target: { value: '257' } });
  expect(screen.getByLabelText('Wysokość tile 1:1')).toHaveValue('257px');
  fireEvent.click(screen.getByRole('button', { name: /Zapisz ustawienia/i }));

  await waitFor(() => expect(window.tilemap.projects.update).toHaveBeenCalledWith(expect.objectContaining({
    tileWidthPx: 257,
  })));
  expect(vi.mocked(window.tilemap.projects.update).mock.calls[0][0]).not.toHaveProperty('projection');
});
