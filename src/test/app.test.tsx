// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { TilemapGeneratorApi } from '../shared/bridge';
import type { AssetDetail, AssetVersion, ProjectInfo } from '../shared/domain';
import { App, GenerationLogPanel, PreviewZoomControls, ProjectReferencesPanel, ProjectSettingsProposalsPanel, ReviewControls, TerrainSeamPreview } from '../renderer/ui/App';

const projectFixture: ProjectInfo = {
  id: '11111111-1111-4111-8111-111111111111', rootPath: 'C:\\project', name: 'Test', artBrief: '',
  projection: 'isometric', tileWidthPx: 256, tileHeightPx: 128, pixelsPerUnit: 256,
  maxConcurrentJobs: 1,
  aiVerificationEnabled: true,
  styleSummary: '', styleSummaryStale: false, unityExportPath: null,
  createdAt: '2026-08-07T10:00:00.000Z', updatedAt: '2026-08-07T10:00:00.000Z',
};

beforeEach(() => {
  cleanup();
  window.tilemap = {
    projects: {
      current: vi.fn(async () => null), recents: vi.fn(async () => []),
      create: vi.fn(), open: vi.fn(), openRecent: vi.fn(), update: vi.fn(), close: vi.fn(), removeRecent: vi.fn(),
      settingsProposals: vi.fn(async () => []), reviewSettingsProposal: vi.fn(),
    },
    assets: { list: vi.fn(), get: vi.fn(), review: vi.fn(), undoApproval: vi.fn(), undoRejection: vi.fn() },
    references: { list: vi.fn(async () => []), add: vi.fn(), update: vi.fn(), remove: vi.fn() },
    generation: { enqueue: vi.fn(), cancel: vi.fn(), retry: vi.fn(), verify: vi.fn(), jobs: vi.fn(), logs: vi.fn(async () => []), onEvent: vi.fn(() => () => undefined) },
    style: { history: vi.fn(), update: vi.fn(), restore: vi.fn(), rebuild: vi.fn() },
    export: { chooseTarget: vi.fn(), preview: vi.fn(), run: vi.fn() },
    codex: { health: vi.fn(), refresh: vi.fn() },
    comfy: {
      health: vi.fn(async () => ({
        state: 'unavailable', installed: false, server: false, endpoint: 'http://127.0.0.1:8188',
        version: null, profile: 'z_image_turbo', model: 'z_image_turbo_bf16.safetensors',
        missingNodes: [], missingModels: [], message: 'ComfyUI wyłączone',
      })),
      refresh: vi.fn(),
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

it('pokazuje ekran tworzenia projektu bez otwartego registry', async () => {
  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  expect(await screen.findByRole('heading', { name: /Spójny świat/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Utwórz projekt/i })).toBeInTheDocument();
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

it('pozwala generować asset z samej nazwy bez opcjonalnego opisu', async () => {
  vi.mocked(window.tilemap.projects.current).mockResolvedValue({
    id: '11111111-1111-4111-8111-111111111111', rootPath: 'C:\\project', name: 'Test', artBrief: '',
    projection: 'isometric', tileWidthPx: 256, tileHeightPx: 128, pixelsPerUnit: 256,
    maxConcurrentJobs: 1,
    aiVerificationEnabled: true,
    codexGenerationEnabled: true,
    comfyUiEnabled: false,
    comfyUiProfile: 'z_image_turbo',
    styleSummary: '', styleSummaryStale: false, unityExportPath: null,
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
  fireEvent.change(screen.getByLabelText('Footprint X — zajęte komórki'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('Footprint Y — zajęte komórki'), { target: { value: '2' } });
  expect(screen.getByText('4 pola łącznie')).toBeInTheDocument();
  const generate = screen.getByRole('button', { name: /Generuj asset/i });
  expect(screen.getByLabelText('Opis dla agenta (opcjonalnie)')).toHaveValue('');
  await waitFor(() => expect(generate).toBeEnabled());
  fireEvent.click(generate);

  await waitFor(() => expect(window.tilemap.generation.enqueue).toHaveBeenCalledWith(expect.objectContaining({
    name: 'Kamienna droga', prompt: '', category: 'elevated_tile', elevationLevels: 2,
    footprint: { x: 2, y: 2 },
  })));
  expect(vi.mocked(window.tilemap.generation.enqueue).mock.calls[0][0]).not.toHaveProperty('pivot');
});

it('rozróżnia rozmiar obrazu budynku od footprintu siatki', async () => {
  const version: AssetVersion = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', assetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    parentVersionId: null, mode: 'generate', status: 'generating', prompt: '', feedback: '',
    category: 'building', elevationLevels: 0, relativeWidth: 2, relativeHeight: 2, tags: [],
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

it('pokazuje komplet road tile jako siatkę 4×4 bez zielonych markerów', async () => {
  const roadVersion: AssetVersion = {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', assetId: '33333333-3333-4333-8333-333333333333',
    parentVersionId: null, mode: 'generate', status: 'needs_review', prompt: '', feedback: '',
    category: 'road_tile', elevationLevels: 0, relativeWidth: 1, relativeHeight: 1, roadConnections: 15,
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
    unityExportPath: null,
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
    category: 'flat_tile', elevationLevels: 0, relativeWidth: 1, relativeHeight: 1, tags: ['łąka'], finalPath: null, imageUrl: null, width: null, height: null,
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
    styleSummaryStale: false, unityExportPath: null, createdAt: failedVersion.createdAt, updatedAt: failedVersion.updatedAt,
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
    category: 'other', elevationLevels: 0, relativeWidth: 1, relativeHeight: 1, tags: ['kamień'],
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

  expect(screen.getByRole('img', { name: /Podgląd powtarzania terenu Łąka/i })).toBeInTheDocument();
  expect(screen.getAllByAltText(/Łąka — sąsiad/i)).toHaveLength(9);
  expect(view.container.querySelector('.seam-grid')).toHaveStyle({ width: '448px', height: '224px' });
  expect(screen.getByAltText('Łąka — sąsiad 3,2')).toHaveStyle({ left: '448px', top: '224px' });

  const stage = screen.getByRole('img', { name: /Podgląd powtarzania terenu Łąka/i });
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
    category: 'flat_tile', elevationLevels: 0, relativeWidth: 1, relativeHeight: 1, tags: ['łąka'], finalPath: 'assets/meadow/final.png',
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
    category: 'vegetation', elevationLevels: 0, relativeWidth: 1, relativeHeight: 1, tags: ['drzewo'],
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
    category: 'flat_tile', elevationLevels: 0, relativeWidth: 1, relativeHeight: 1, tags: ['łąka'], finalPath: 'assets/meadow/pending.png',
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
    category: 'flat_tile', elevationLevels: 0, relativeWidth: 1, relativeHeight: 1, tags: ['łąka'], finalPath: 'assets/meadow/final.png',
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
    styleSummaryStale: false, unityExportPath: null, createdAt: version.createdAt, updatedAt: version.updatedAt,
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
    unityExportPath: null,
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
