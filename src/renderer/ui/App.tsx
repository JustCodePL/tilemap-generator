import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Archive,
  Box,
  Check,
  ChevronRight,
  CircleDot,
  Download,
  FolderOpen,
  Gamepad2,
  ImagePlus,
  Layers3,
  LoaderCircle,
  PanelRight,
  Pause,
  PersonStanding,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  Sparkles,
  SquareStack,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  AssetCategory,
  AssetDetail,
  AssetSummary,
  AssetVersion,
  CodexHealth,
  ComfyUiHealth,
  ExportIntegration,
  ExportPreview,
  GenerationJob,
  GenerationLogEntry,
  GenerationMode,
  GeneratorProvider,
  ProjectInfo,
  ProjectProjection,
  ProjectReference,
  ProjectSettingsProposal,
  RecentProject,
  StableDiffusionCppHealth,
  StableDiffusionCppInstallEvent,
  StableDiffusionCppModelId,
  StableDiffusionCppModelOption,
  StyleSummaryRevision,
  VersionStatus,
} from '../../shared/domain';
import type { AppUpdateState } from '../../shared/update-feed';
import {
  assetCategories,
  assetPixelSize,
  characterAnimationFrameSize,
  characterAnimationSheetSize,
  characterDirectionsForProjection,
  defaultAssetSizing,
  isRelativeSizeCategory,
  isRoadAssetCategory,
  isTileAssetCategory,
  roadVariantLabel,
  tileHeightForProjection,
} from '../../shared/domain';

type View = 'project' | 'generate' | 'characters' | 'export' | 'diagnostics';

const categoryLabels: Record<AssetCategory, string> = {
  road_tile: 'Road tile',
  flat_tile: 'Flat terrain', elevated_tile: 'Elevated terrain', building: 'Budynek', character: 'Postać', vegetation: 'Roślinność',
  prop: 'Obiekt', effect: 'Efekt', ui: 'UI', other: 'Inne',
};

const statusLabels: Record<VersionStatus, string> = {
  queued: 'W kolejce', generating: 'Generowanie', needs_review: 'Do weryfikacji', approved: 'Zatwierdzony',
  rejected: 'Odrzucony', failed: 'Błąd', cancelled: 'Anulowany', interrupted: 'Przerwany',
};

const projectionLabels: Record<ProjectProjection, string> = {
  isometric: 'Izometryczna 2:1',
  top_down: 'Top-down 1:1',
};

const generatorProviderOrder: readonly GeneratorProvider[] = ['codex', 'comfyui', 'stable_diffusion_cpp'];

function newAssetGeneratorProviders(project: ProjectInfo): GeneratorProvider[] {
  const selected = generatorProviderOrder.filter((provider) => provider === 'codex'
    ? (project.codexGenerationEnabled ?? true)
    : provider === 'comfyui'
      ? (project.comfyUiEnabled ?? false)
      : (project.stableDiffusionCppEnabled ?? false));
  return selected.length ? selected : ['codex'];
}

function generatorProviderState(
  provider: GeneratorProvider,
  codexHealth?: CodexHealth,
  comfyHealth?: ComfyUiHealth,
  stableDiffusionCppHealth?: StableDiffusionCppHealth,
): { ready: boolean; detail: string; message: string } {
  if (provider === 'codex') return {
    ready: codexHealth?.state === 'ready',
    detail: codexHealth?.state === 'ready' ? 'Gotowy' : codexHealth?.message ?? 'Sprawdzanie…',
    message: codexHealth?.message ?? 'Codex: sprawdzanie gotowości…',
  };
  if (provider === 'comfyui') return {
    ready: comfyHealth?.state === 'ready',
    detail: comfyHealth?.state === 'ready'
      ? 'API gotowe'
      : comfyHealth?.installed
        ? `Comfy Desktop wykryty · API ${comfyHealth.server ? 'niegotowe' : 'offline'}`
        : 'Comfy Desktop nie został wykryty',
    message: comfyHealth?.message ?? 'ComfyUI: sprawdzanie gotowości…',
  };
  return {
    ready: stableDiffusionCppHealth?.state === 'ready',
    detail: stableDiffusionCppHealth?.state === 'ready'
      ? 'CLI gotowe'
      : stableDiffusionCppHealth?.installed
        ? 'CLI wykryte · model niegotowy'
        : 'CLI nie zostało wykryte',
    message: stableDiffusionCppHealth?.message ?? 'stable-diffusion.cpp: sprawdzanie gotowości…',
  };
}

function assetCategoriesForProjection(projection: ProjectProjection): readonly AssetCategory[] {
  return projection === 'top_down'
    ? assetCategories.filter((category) => category !== 'elevated_tile')
    : assetCategories;
}

function studioAssetCategoriesForProjection(projection: ProjectProjection): readonly AssetCategory[] {
  return assetCategoriesForProjection(projection).filter((category) => category !== 'character');
}

export function App() {
  const queryClient = useQueryClient();
  const projectQuery = useQuery({ queryKey: ['project'], queryFn: () => window.tilemap.projects.current() });
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [view, setView] = useState<View>('generate');

  useEffect(() => window.tilemap.generation.onEvent((event) => {
    void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    if (event.type === 'log') {
      void queryClient.invalidateQueries({ queryKey: ['generation-logs', event.entry.assetId] });
    }
    if (event.type === 'completed' || event.type === 'failed' || event.type === 'verification-completed') {
      void queryClient.invalidateQueries({ queryKey: ['assets'] });
      if (event.type === 'completed') setSelectedAssetId(event.assetId);
    }
    if (event.type === 'style-updated') {
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['style'] });
    }
  }), [queryClient]);

  useEffect(() => window.tilemap.projects.onChanged((project) => {
    setSelectedAssetId(null);
    setView('generate');
    queryClient.clear();
    queryClient.setQueryData(['project'], project);
    void queryClient.invalidateQueries();
  }), [queryClient]);

  if (projectQuery.isLoading) return <FullScreenLoader label="Otwieranie aplikacji…" />;
  if (!projectQuery.data) {
    return <Welcome onOpened={(project) => {
      queryClient.setQueryData(['project'], project);
      void queryClient.invalidateQueries();
    }} />;
  }

  return (
    <Workspace
      project={projectQuery.data}
      selectedAssetId={selectedAssetId}
      onSelectAsset={(id, category) => {
        setSelectedAssetId(id);
        setView(category === 'character' ? 'characters' : 'generate');
      }}
      onNewAsset={() => { setSelectedAssetId(null); setView('generate'); }}
      onNewCharacter={() => { setSelectedAssetId(null); setView('characters'); }}
      view={view}
      onView={(next) => { setView(next); setSelectedAssetId(null); }}
      onClose={async () => {
        await window.tilemap.projects.close();
        setSelectedAssetId(null);
        queryClient.clear();
        queryClient.setQueryData(['project'], null);
      }}
    />
  );
}

function Welcome({ onOpened }: { onOpened: (project: ProjectInfo) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('Nowy świat');
  const [artBrief, setArtBrief] = useState('');
  const [projection, setProjection] = useState<ProjectProjection>('isometric');
  const [width, setWidth] = useState(256);
  const [characterFramesPerDirection, setCharacterFramesPerDirection] = useState(8);
  const [storageDirectory, setStorageDirectory] = useState('');
  const [error, setError] = useState('');
  const recents = useQuery({ queryKey: ['recents'], queryFn: () => window.tilemap.projects.recents() });
  const chooseStorageDirectory = useMutation({
    mutationFn: () => window.tilemap.projects.chooseStorageDirectory(),
    onSuccess: (path) => {
      if (path) {
        setStorageDirectory(path);
        setError('');
      }
    },
    onError: (reason) => setError(errorMessage(reason)),
  });
  const create = useMutation({
    mutationFn: () => window.tilemap.projects.create({
      name,
      artBrief,
      projection,
      tileWidthPx: width,
      characterFramesPerDirection,
    }, storageDirectory),
    onSuccess: (project) => project && onOpened(project),
    onError: (reason) => setError(errorMessage(reason)),
  });
  const open = useMutation({
    mutationFn: () => window.tilemap.projects.open(),
    onSuccess: (project) => project && onOpened(project),
    onError: (reason) => setError(errorMessage(reason)),
  });
  const openRecent = useMutation({
    mutationFn: (rootPath: string) => window.tilemap.projects.openRecent(rootPath),
    onMutate: () => setError(''),
    onSuccess: (project) => onOpened(project),
    onError: (reason) => setError(errorMessage(reason)),
  });
  const removeRecent = useMutation({
    mutationFn: (rootPath: string) => window.tilemap.projects.removeRecent(rootPath),
    onMutate: () => setError(''),
    onSuccess: (_result, rootPath) => {
      queryClient.setQueryData<RecentProject[]>(['recents'], (current) => (
        current?.filter((recent) => recent.rootPath.toLocaleLowerCase() !== rootPath.toLocaleLowerCase()) ?? []
      ));
    },
    onError: (reason) => setError(errorMessage(reason)),
  });
  return (
    <main className="welcome-shell">
      <section className="welcome-copy">
        <div className="brand-mark"><Layers3 size={28} /></div>
        <p className="eyebrow">TILEMAP GENERATOR</p>
        <h1>Spójny świat,<br /><span>asset po assecie.</span></h1>
        <p className="lede">Lokalne studio generowania assetów izometrycznych i top-down. Codex i ComfyUI tworzą warianty, Ty wybierasz preferowany, registry pilnuje historii.</p>
        <div className="feature-line"><Sparkles size={17} /> Codex + imagegen oraz ComfyUI</div>
        <div className="feature-line"><Archive size={17} /> Pełna historia, bez kasowania odrzuceń</div>
        <div className="feature-line"><Download size={17} /> Eksport przez integracje</div>
      </section>
      <section className="welcome-card">
        <div className="card-heading">
          <div><p className="eyebrow">NOWY PROJEKT</p><h2>Zdefiniuj siatkę</h2></div>
          <button className="icon-button" title="Otwórz istniejący projekt" onClick={() => open.mutate()}><FolderOpen /></button>
        </div>
        <label>Nazwa projektu<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Kierunek artystyczny<textarea rows={4} placeholder="Np. ręcznie malowane kamienie, ciepłe światło, czytelne sylwetki…" value={artBrief} onChange={(event) => setArtBrief(event.target.value)} /></label>
        <label>Projekcja<select value={projection} onChange={(event) => setProjection(event.target.value as ProjectProjection)}><option value="isometric">Izometryczna 2:1</option><option value="top_down">Top-down 1:1</option></select></label>
        <div className="form-grid two">
          <label>Bazowa szerokość tile (px)<input type="number" min={16} max={4096} step={projection === 'isometric' ? 2 : 1} value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label>
          <label>{projection === 'isometric' ? 'Wysokość 2:1' : 'Wysokość 1:1'}<input value={`${tileHeightForProjection(projection, width)}px`} readOnly /></label>
        </div>
        <label className="welcome-character-frames">Klatki chodu na kierunek<input aria-label="Klatki chodu na kierunek" type="number" min={2} max={16} step={1} value={characterFramesPerDirection} onChange={(event) => setCharacterFramesPerDirection(Number(event.target.value))} /><small>Liczba obrazów pozy chodu dla każdego kierunku. FPS określa osobno tempo animacji.</small></label>
        <div className="directory-picker">
          <FolderOpen />
          <div><small>KATALOG BIBLIOTEKI</small><strong title={storageDirectory}>{storageDirectory || 'Nie wybrano'}</strong></div>
          <button className="secondary" type="button" disabled={chooseStorageDirectory.isPending} onClick={() => chooseStorageDirectory.mutate()}>
            {chooseStorageDirectory.isPending ? <LoaderCircle className="spin" /> : <FolderOpen />} Wybierz katalog biblioteki
          </button>
        </div>
        <p className="directory-help">Wybierz pusty katalog. Tutaj aplikacja zapisze registry, historię i wszystkie wersje assetów. Miejsce dla zatwierdzonych plików wybierzesz osobno podczas eksportu.</p>
        {projection === 'isometric' && width % 2 !== 0 && <p className="inline-warning"><AlertTriangle size={15} /> Bazowa szerokość musi być parzysta, aby wysokość 2:1 była całkowita.</p>}
        {error && <ErrorBox message={error} />}
        <button className="primary wide" disabled={create.isPending || !storageDirectory || name.trim().length < 2 || !Number.isInteger(characterFramesPerDirection) || characterFramesPerDirection < 2 || characterFramesPerDirection > 16 || (projection === 'isometric' && width % 2 !== 0)} onClick={() => create.mutate()}>
          {create.isPending ? <LoaderCircle className="spin" /> : <ImagePlus />} Utwórz projekt
        </button>
        {!!recents.data?.length && <div className="recents"><span>Ostatnie projekty</span>{recents.data.slice(0, 3).map((recent) => <div className="recent-row" key={recent.rootPath}>
          <button
            type="button"
            className="recent-open"
            disabled={openRecent.isPending || removeRecent.isPending}
            aria-label={`Otwórz projekt ${recent.name}`}
            onClick={() => openRecent.mutate(recent.rootPath)}
          >
            {openRecent.isPending && openRecent.variables === recent.rootPath ? <LoaderCircle className="spin" /> : <CircleDot />}
            <strong>{recent.name}</strong>
            <small title={recent.rootPath}>{recent.rootPath}</small>
          </button>
          <button
            type="button"
            className="recent-remove"
            disabled={openRecent.isPending || removeRecent.isPending}
            aria-label={`Usuń projekt ${recent.name} z listy`}
            title="Usuń z listy ostatnich projektów"
            onClick={() => removeRecent.mutate(recent.rootPath)}
          >{removeRecent.isPending && removeRecent.variables === recent.rootPath ? <LoaderCircle className="spin" /> : <Trash2 />}</button>
        </div>)}</div>}
      </section>
    </main>
  );
}

function Workspace(props: {
  project: ProjectInfo;
  selectedAssetId: string | null;
  onSelectAsset: (id: string, category: AssetCategory) => void;
  onNewAsset: () => void;
  onNewCharacter: () => void;
  view: View;
  onView: (view: View) => void;
  onClose: () => void;
}) {
  const assets = useQuery({ queryKey: ['assets'], queryFn: () => window.tilemap.assets.list(), refetchInterval: 5_000 });
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: () => window.tilemap.generation.jobs(), refetchInterval: 2_000 });
  const health = useQuery({ queryKey: ['codex-health'], queryFn: () => window.tilemap.codex.health(), refetchInterval: 10_000 });
  const comfyHealth = useQuery({ queryKey: ['comfy-health'], queryFn: () => window.tilemap.comfy.refresh(), refetchInterval: 10_000 });
  const stableDiffusionCppHealth = useQuery({
    queryKey: ['stable-diffusion-cpp-health'],
    queryFn: () => window.tilemap.stableDiffusionCpp.health(),
    refetchInterval: 10_000,
  });
  const [filter, setFilter] = useState('');
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  useEffect(() => setSelectedVersionId(null), [props.selectedAssetId]);
  const visibleAssets = useMemo(() => assets.data?.filter((asset) => {
    const query = filter.toLocaleLowerCase('pl-PL');
    return asset.name.toLocaleLowerCase('pl-PL').includes(query)
      || asset.description.toLocaleLowerCase('pl-PL').includes(query)
      || asset.latestVersion?.tags.some((tag) => tag.toLocaleLowerCase('pl-PL').includes(query));
  }) ?? [], [assets.data, filter]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className={`project-title ${props.view === 'project' ? 'active' : ''}`} aria-label={`Strona główna projektu ${props.project.name}`} onClick={() => props.onView('project')}><div className="brand-mark small"><Layers3 size={20} /></div><div><strong>{props.project.name}</strong><span>baza {props.project.tileWidthPx}×{props.project.tileHeightPx}px · {props.project.projection === 'isometric' ? '2:1' : '1:1'}</span></div><ChevronRight /></button>
        <nav>
          <button className={props.view === 'generate' ? 'active' : ''} onClick={() => props.onView('generate')}><Sparkles /> Studio</button>
          <button className={props.view === 'characters' ? 'active' : ''} onClick={() => props.onView('characters')}><PersonStanding /> Postacie</button>
          <button className={props.view === 'export' ? 'active' : ''} onClick={() => props.onView('export')}><Download /> Eksport</button>
          <button className={props.view === 'diagnostics' ? 'active' : ''} onClick={() => props.onView('diagnostics')}><Settings2 /> Diagnostyka</button>
        </nav>
        <div className="top-actions"><HealthPill health={health.data} /><ComfyHealthPill health={comfyHealth.data} /><StableDiffusionCppHealthPill health={stableDiffusionCppHealth.data} /><button className="ghost close-project" aria-label="Zamknij projekt" title="Zamknij projekt" onClick={props.onClose}><X /> <span>Zamknij</span></button></div>
      </header>
      <div className="workspace-grid">
        <aside className="asset-sidebar">
          <button className="new-asset" onClick={props.view === 'characters' ? props.onNewCharacter : props.onNewAsset}>
            {props.view === 'characters' ? <PersonStanding /> : <ImagePlus />}
            {props.view === 'characters' ? 'Nowa postać' : 'Nowy asset'}
          </button>
          <div className="search-box"><Search size={16} /><input placeholder="Szukaj po nazwie lub tagu" value={filter} onChange={(event) => setFilter(event.target.value)} /></div>
          <div className="sidebar-label"><span>REGISTRY</span><small>{assets.data?.length ?? 0}</small></div>
          <div className="asset-list">
            {visibleAssets.map((asset) => <AssetListItem
              key={asset.id}
              asset={asset}
              active={props.selectedAssetId === asset.id}
              expectedCharacterFrames={props.project.characterFramesPerDirection}
              onClick={() => props.onSelectAsset(asset.id, asset.latestVersion?.category ?? asset.category)}
            />)}
            {!visibleAssets.length && <div className="empty-compact"><SquareStack /><span>Brak assetów</span></div>}
          </div>
        </aside>
        <section className={`content-area ${['generate', 'characters'].includes(props.view) && props.selectedAssetId ? 'asset-review-content' : ''}`}>
          <ProjectSettingsProposalNotice onOpen={() => props.onView('project')} />
          {props.view === 'project' && <ProjectHome project={props.project} codexHealth={health.data} comfyHealth={comfyHealth.data} stableDiffusionCppHealth={stableDiffusionCppHealth.data} />}
          {props.view === 'generate' && (props.selectedAssetId
            ? <AssetReview
              assetId={props.selectedAssetId}
              jobs={jobs.data ?? []}
              project={props.project}
              selectedVersionId={selectedVersionId}
              onSelectVersion={setSelectedVersionId}
            />
            : <GenerationStudio project={props.project} codexHealth={health.data} comfyHealth={comfyHealth.data} stableDiffusionCppHealth={stableDiffusionCppHealth.data} />)}
          {props.view === 'characters' && (props.selectedAssetId
            ? <AssetReview
              assetId={props.selectedAssetId}
              jobs={jobs.data ?? []}
              project={props.project}
              selectedVersionId={selectedVersionId}
              onSelectVersion={setSelectedVersionId}
            />
            : <CharacterStudio
              project={props.project}
              codexHealth={health.data}
              comfyHealth={comfyHealth.data}
              stableDiffusionCppHealth={stableDiffusionCppHealth.data}
            />)}
          {props.view === 'export' && <ExportView project={props.project} assets={assets.data ?? []} />}
          {props.view === 'diagnostics' && <DiagnosticsView codexHealth={health.data} comfyHealth={comfyHealth.data} stableDiffusionCppHealth={stableDiffusionCppHealth.data} />}
        </section>
        {['generate', 'characters'].includes(props.view) && props.selectedAssetId
          ? <AssetAttemptsSidebar
            assetId={props.selectedAssetId}
            selectedVersionId={selectedVersionId}
            onSelectVersion={setSelectedVersionId}
            expectedCharacterFrames={props.project.characterFramesPerDirection}
          />
          : <StylePanel project={props.project} />}
      </div>
      <QueueBar jobs={jobs.data ?? []} />
    </div>
  );
}

export function ProjectHome({
  project,
  codexHealth,
  comfyHealth,
  stableDiffusionCppHealth,
}: {
  project: ProjectInfo;
  codexHealth?: CodexHealth;
  comfyHealth?: ComfyUiHealth;
  stableDiffusionCppHealth?: StableDiffusionCppHealth;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(project.name);
  const [artBrief, setArtBrief] = useState(project.artBrief);
  const [tileWidth, setTileWidth] = useState(project.tileWidthPx);
  const [pixelsPerUnit, setPixelsPerUnit] = useState(project.pixelsPerUnit);
  const [maxConcurrentJobs, setMaxConcurrentJobs] = useState(project.maxConcurrentJobs);
  const [characterFramesPerDirection, setCharacterFramesPerDirection] = useState(project.characterFramesPerDirection);
  const [aiVerificationEnabled, setAiVerificationEnabled] = useState(project.aiVerificationEnabled);
  const [codexGenerationEnabled, setCodexGenerationEnabled] = useState(project.codexGenerationEnabled ?? true);
  const [comfyUiEnabled, setComfyUiEnabled] = useState(project.comfyUiEnabled ?? false);
  const [stableDiffusionCppEnabled, setStableDiffusionCppEnabled] = useState(project.stableDiffusionCppEnabled ?? false);
  const [error, setError] = useState('');

  useEffect(() => {
    setName(project.name);
    setArtBrief(project.artBrief);
    setTileWidth(project.tileWidthPx);
    setPixelsPerUnit(project.pixelsPerUnit);
    setMaxConcurrentJobs(project.maxConcurrentJobs);
    setCharacterFramesPerDirection(project.characterFramesPerDirection);
    setAiVerificationEnabled(project.aiVerificationEnabled);
    setCodexGenerationEnabled(project.codexGenerationEnabled ?? true);
    setComfyUiEnabled(project.comfyUiEnabled ?? false);
    setStableDiffusionCppEnabled(project.stableDiffusionCppEnabled ?? false);
  }, [project]);

  const save = useMutation({
    mutationFn: () => window.tilemap.projects.update({
      name,
      artBrief,
      tileWidthPx: tileWidth,
      pixelsPerUnit,
      maxConcurrentJobs,
      characterFramesPerDirection,
      aiVerificationEnabled,
      codexGenerationEnabled,
      comfyUiEnabled,
      comfyUiProfile: project.comfyUiProfile ?? 'z_image_turbo',
      stableDiffusionCppEnabled,
    }),
    onSuccess: (updated) => {
      setError('');
      queryClient.setQueryData(['project'], updated);
      void queryClient.invalidateQueries({ queryKey: ['project-settings-proposals'] });
    },
    onError: (reason) => setError(errorMessage(reason)),
  });
  const dirty = name !== project.name
    || artBrief !== project.artBrief
    || tileWidth !== project.tileWidthPx
    || pixelsPerUnit !== project.pixelsPerUnit
    || maxConcurrentJobs !== project.maxConcurrentJobs
    || characterFramesPerDirection !== project.characterFramesPerDirection
    || aiVerificationEnabled !== project.aiVerificationEnabled
    || codexGenerationEnabled !== (project.codexGenerationEnabled ?? true)
    || comfyUiEnabled !== (project.comfyUiEnabled ?? false)
    || stableDiffusionCppEnabled !== (project.stableDiffusionCppEnabled ?? false);
  const valid = name.trim().length >= 2
    && tileWidth >= 16
    && (project.projection === 'top_down' || tileWidth % 2 === 0)
    && pixelsPerUnit >= 1
    && maxConcurrentJobs >= 1
    && maxConcurrentJobs <= 8
    && Number.isInteger(characterFramesPerDirection)
    && characterFramesPerDirection >= 2
    && characterFramesPerDirection <= 16
    && (codexGenerationEnabled || comfyUiEnabled || stableDiffusionCppEnabled);
  const tileHeight = tileHeightForProjection(project.projection, tileWidth);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid && dirty) save.mutate();
  };

  return <div className="project-page">
    <div className="section-heading">
      <div><p className="eyebrow">PROJEKT</p><h2>{project.name}</h2><p>Projekt ustala bazową jednostkę {project.projection === 'isometric' ? 'izometryczną 2:1' : 'top-down 1:1'}. Typ i skala należą do każdego assetu.</p></div>
      <div className="project-geometry-summary"><span><Layers3 /></span><div><strong>Bazowy tile</strong><small>{tileWidth}×{tileHeight}px · {project.projection === 'isometric' ? '2:1' : '1:1'}</small></div></div>
    </div>
    <div className="project-library-path" role="note">
      <FolderOpen />
      <div><small>KATALOG BIBLIOTEKI</small><strong title={project.rootPath}>{project.rootPath}</strong><span>Registry, historia i wszystkie wersje assetów.</span></div>
    </div>
    <form className="project-settings-card" onSubmit={submit}>
      <div className="settings-section-heading"><div><p className="eyebrow">USTAWIENIA</p><h3>Bazowa jednostka projektu</h3></div><Settings2 /></div>
      <label>Nazwa projektu<input value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Projekcja projektu<input value={projectionLabels[project.projection]} readOnly /></label>
      <label>Kierunek artystyczny<textarea rows={5} value={artBrief} onChange={(event) => setArtBrief(event.target.value)} placeholder="Paleta, materiały, oświetlenie i reguły stylu projektu…" /></label>
      <div className="form-grid three">
        <label>Bazowa szerokość tile (px)<input type="number" min={16} max={4096} step={project.projection === 'isometric' ? 2 : 1} value={tileWidth} onChange={(event) => setTileWidth(Number(event.target.value))} /></label>
        <label>{project.projection === 'isometric' ? 'Wysokość rombu 2:1' : 'Wysokość tile 1:1'}<input value={`${tileHeight}px`} readOnly /></label>
        <label>Pixels per unit<input type="number" min={1} max={4096} value={pixelsPerUnit} onChange={(event) => setPixelsPerUnit(Number(event.target.value))} /></label>
      </div>
      <div className="character-project-setting">
        <PersonStanding />
        <label>Klatki chodu na kierunek<input type="number" min={2} max={16} step={1} value={characterFramesPerDirection} onChange={(event) => setCharacterFramesPerDirection(Number(event.target.value))} /></label>
        <p><strong>Docelowa liczba klatek w każdej pętli chodu</strong><span>To ustawienie obowiązuje wszystkie nowe postacie i kolejne wersje. Tempo odtwarzania jest określane osobno przez FPS.</span></p>
      </div>
      <div className="queue-concurrency-setting">
        <label>Maks. jednoczesnych zadań<input type="number" min={1} max={8} step={1} value={maxConcurrentJobs} onChange={(event) => setMaxConcurrentJobs(Number(event.target.value))} /></label>
        <p>Określa, ile różnych assetów kolejka może generować równolegle. Zmniejszenie limitu nie przerywa już uruchomionych zadań.</p>
        <label className="ai-verification-toggle">
          <input type="checkbox" checked={aiVerificationEnabled} onChange={(event) => setAiVerificationEnabled(event.target.checked)} />
          <span><strong>Weryfikacja AI po generowaniu</strong><small>Codex ogląda wynik i może wykonać automatyczną korektę. Po wyłączeniu gotowy asset można sprawdzić później przyciskiem Weryfikacja. Kontrole techniczne PNG oraz obowiązkowa analiza ruchu postaci pozostają aktywne.</small></span>
        </label>
        <div className="generator-settings">
          <p><strong>Domyślne generatory nowych assetów</strong><small>Każdy wybrany generator tworzy osobny wariant. Wybór z ostatnio uruchomionej generacji jest zapamiętywany tutaj.</small></p>
          <label className="ai-verification-toggle">
            <input type="checkbox" checked={codexGenerationEnabled} onChange={(event) => setCodexGenerationEnabled(event.target.checked)} />
            <span><strong>Codex + imagegen</strong><small>{codexHealth?.state === 'ready' ? 'Online' : codexHealth?.message ?? 'Sprawdzanie…'}</small></span>
          </label>
          <label className="ai-verification-toggle">
            <input type="checkbox" checked={comfyUiEnabled} onChange={(event) => setComfyUiEnabled(event.target.checked)} />
            <span><strong>ComfyUI · Z-Image Turbo</strong><small>{comfyHealth?.state === 'ready' ? `Online · ${comfyHealth.model}` : comfyHealth?.message ?? 'Sprawdzanie…'}</small></span>
          </label>
          <label className="ai-verification-toggle">
            <input type="checkbox" checked={stableDiffusionCppEnabled} onChange={(event) => setStableDiffusionCppEnabled(event.target.checked)} />
            <span><strong>stable-diffusion.cpp · Z-Image Turbo</strong><small>{stableDiffusionCppHealth?.state === 'ready' ? `Online · ${stableDiffusionCppHealth.model}` : stableDiffusionCppHealth?.message ?? 'Sprawdzanie…'}</small></span>
          </label>
        </div>
        <StableDiffusionCppSetupPanel />
      </div>
      {!codexGenerationEnabled && !comfyUiEnabled && !stableDiffusionCppEnabled && <p className="inline-warning"><AlertTriangle /> Włącz co najmniej jeden generator.</p>}
      {project.projection === 'isometric' && tileWidth % 2 !== 0 && <p className="inline-warning"><AlertTriangle /> Bazowa szerokość musi być parzysta.</p>}
      {error && <ErrorBox message={error} />}
      <div className="project-settings-actions"><span>{dirty ? 'Masz niezapisane zmiany.' : 'Ustawienia są aktualne.'}</span><button className="primary" type="submit" disabled={!dirty || !valid || save.isPending}>{save.isPending ? <LoaderCircle className="spin" /> : <Save />} Zapisz ustawienia</button></div>
    </form>
  </div>;
}

function StableDiffusionCppSetupPanel() {
  const queryClient = useQueryClient();
  const setup = useQuery({
    queryKey: ['stable-diffusion-cpp-setup'],
    queryFn: () => window.tilemap.stableDiffusionCpp.setup(),
  });
  const [progress, setProgress] = useState<StableDiffusionCppInstallEvent | null>(null);
  const [error, setError] = useState('');

  useEffect(() => window.tilemap.stableDiffusionCpp.onInstallEvent((event) => {
    setProgress(event);
    if (event.phase === 'failed') setError(event.message);
    if (event.phase === 'completed') {
      setError('');
      void queryClient.invalidateQueries({ queryKey: ['stable-diffusion-cpp-setup'] });
      void queryClient.invalidateQueries({ queryKey: ['stable-diffusion-cpp-health'] });
    }
  }), [queryClient]);

  const install = useMutation({
    mutationFn: (modelId: StableDiffusionCppModelId) => window.tilemap.stableDiffusionCpp.install(modelId),
    onMutate: () => { setError(''); setProgress(null); },
    onSuccess: (value) => {
      queryClient.setQueryData(['stable-diffusion-cpp-setup'], value);
      void queryClient.invalidateQueries({ queryKey: ['stable-diffusion-cpp-health'] });
    },
    onError: (reason) => {
      if (!(reason instanceof Error && reason.name === 'AbortError')) setError(errorMessage(reason));
    },
  });
  const select = useMutation({
    mutationFn: (modelId: StableDiffusionCppModelId) => window.tilemap.stableDiffusionCpp.selectModel(modelId),
    onSuccess: (value) => {
      setError('');
      queryClient.setQueryData(['stable-diffusion-cpp-setup'], value);
      void queryClient.invalidateQueries({ queryKey: ['stable-diffusion-cpp-health'] });
    },
    onError: (reason) => setError(errorMessage(reason)),
  });
  const cancel = useMutation({ mutationFn: () => window.tilemap.stableDiffusionCpp.cancelInstall() });

  if (setup.isLoading) return <section className="sd-cpp-setup loading"><LoaderCircle className="spin" /> Sprawdzanie instalacji stable-diffusion.cpp…</section>;
  if (setup.isError || !setup.data) return <section className="sd-cpp-setup"><ErrorBox message={errorMessage(setup.error)} /></section>;
  const value = setup.data;
  const recommended = value.models.find((model) => model.recommended)!;
  const active = install.isPending;
  const progressRatio = progress && progress.totalBytes > 0
    ? Math.min(1, progress.downloadedBytes / progress.totalBytes)
    : 0;

  return <section className="sd-cpp-setup">
    <div className="sd-cpp-setup-heading">
      <div><p className="eyebrow">LOKALNY RENDERER</p><h4>stable-diffusion.cpp</h4><small>{value.runtime.installed ? `Silnik ${value.runtime.version ?? 'lokalny'} · Vulkan` : 'Silnik nie jest jeszcze zainstalowany'}</small></div>
      <span className={value.runtime.installed ? 'installed' : ''}>{value.runtime.installed ? <Check /> : <Download />}{value.runtime.installed ? 'Gotowy' : 'Do instalacji'}</span>
    </div>
    <div className="sd-cpp-recommendation">
      <Sparkles />
      <div><strong>Polecany: {recommended.name}</strong><span>{value.hardware.recommendation}</span></div>
      {(!value.runtime.installed || !recommended.installed || !recommended.selected) && <button type="button" className="primary" disabled={active || select.isPending} onClick={() => install.mutate(recommended.id)}>{active && install.variables === recommended.id ? <LoaderCircle className="spin" /> : <Download />} Zainstaluj polecany</button>}
    </div>
    <div className="sd-cpp-models">
      {value.models.map((model) => <StableDiffusionCppModelCard
        key={model.id}
        model={model}
        runtimeInstalled={value.runtime.installed}
        busy={active || select.isPending}
        activeModelId={install.variables}
        onInstall={(modelId) => install.mutate(modelId)}
        onSelect={(modelId) => select.mutate(modelId)}
      />)}
    </div>
    {active && <div className="sd-cpp-progress">
      <div><strong>{progress?.message ?? 'Przygotowywanie instalacji…'}</strong><span>{progress?.fileName ? `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}` : ''}</span></div>
      <div className="sd-cpp-progress-track"><i style={{ width: `${Math.round(progressRatio * 100)}%` }} /></div>
      <button type="button" className="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate()}><X /> Anuluj</button>
    </div>}
    <small className="sd-cpp-install-path">Pliki aplikacji: {value.installRoot}</small>
    {error && <ErrorBox message={error} />}
  </section>;
}

function StableDiffusionCppModelCard({
  model,
  runtimeInstalled,
  busy,
  activeModelId,
  onInstall,
  onSelect,
}: {
  model: StableDiffusionCppModelOption;
  runtimeInstalled: boolean;
  busy: boolean;
  activeModelId?: StableDiffusionCppModelId;
  onInstall: (modelId: StableDiffusionCppModelId) => void;
  onSelect: (modelId: StableDiffusionCppModelId) => void;
}) {
  const needsInstall = !runtimeInstalled || !model.installed;
  const installing = busy && activeModelId === model.id;
  const action = needsInstall ? onInstall : onSelect;
  const actionLabel = !runtimeInstalled && model.installed
    ? 'Zainstaluj silnik'
    : !model.installed
      ? `Pobierz ${formatBytes(model.downloadBytesRemaining)}`
      : model.selected
        ? 'Aktywny'
        : 'Użyj modelu';
  return <article className={`sd-cpp-model ${model.selected ? 'selected' : ''} ${model.recommended ? 'recommended' : ''}`}>
    <div className="sd-cpp-model-title"><div><strong>{model.name}</strong><small>{model.quantization} · od {model.recommendedVramGb} GB VRAM</small></div>{model.recommended && <span>POLECANY</span>}</div>
    <p>{model.description}</p>
    <div className="sd-cpp-model-meta"><span>{model.installed ? <><Check /> Zainstalowany</> : <><Download /> Do pobrania: {formatBytes(model.downloadBytesRemaining)}</>}</span><small>Pełny profil: {formatBytes(model.totalSizeBytes)}</small></div>
    <button type="button" className={model.selected && !needsInstall ? 'ghost' : 'secondary'} disabled={busy || (model.selected && !needsInstall)} onClick={() => action(model.id)}>{installing ? <LoaderCircle className="spin" /> : model.selected && !needsInstall ? <Check /> : needsInstall ? <Download /> : <CircleDot />}{actionLabel}</button>
  </article>;
}

function ProjectSettingsProposalNotice({ onOpen }: { onOpen: () => void }) {
  const proposals = useQuery({
    queryKey: ['project-settings-proposals'],
    queryFn: () => window.tilemap.projects.settingsProposals(),
    refetchInterval: 2_000,
  });
  const pending = (proposals.data ?? []).filter((proposal) => proposal.status === 'pending');
  if (!pending.length) return null;
  return <button className="settings-proposal-notice" onClick={onOpen}>
    <AlertTriangle /><span><strong>Agent proponuje zmianę ustawień projektu</strong><small>{pending[0].reason}</small></span><b>{pending.length}</b><ChevronRight />
  </button>;
}

function AssetListItem({
  asset,
  active,
  expectedCharacterFrames,
  onClick,
}: {
  asset: AssetSummary;
  active: boolean;
  expectedCharacterFrames: number;
  onClick: () => void;
}) {
  const version = asset.latestVersion;
  const category = version?.category ?? asset.category;
  const relativeWidth = version?.relativeWidth ?? asset.relativeWidth;
  const relativeHeight = version?.relativeHeight ?? asset.relativeHeight;
  const dimensionSummary = category === 'character' && version?.characterAnimation
    ? ` · Chód · ${version.characterAnimation.directions.length} kierunki · ${version.characterAnimation.settings.framesPerDirection} kl./kierunek`
    : isRelativeSizeCategory(category)
    ? ` · obraz ${relativeWidth}×${relativeHeight}${version ? ` · siatka ${version.footprint.x}×${version.footprint.y}` : ''}`
    : '';
  return <button className={`asset-row ${active ? 'active' : ''}`} onClick={onClick}>
    <div className="asset-thumb">{version?.imageUrl ? <img src={version.imageUrl} alt="" /> : <Box />}</div>
    <div className="asset-row-copy"><strong>{asset.name}</strong><span>{categoryLabels[category]}{category === 'elevated_tile' ? ` · h${version?.elevationLevels ?? asset.elevationLevels}` : ''}{dimensionSummary} · {asset.versionCount} wer.</span><CharacterFrameCountWarning version={version} expected={expectedCharacterFrames} compact /><StatusBadge status={version?.status ?? 'queued'} /></div>
    <ChevronRight size={16} />
  </button>;
}

function CharacterFrameCountWarning({
  version,
  expected,
  compact = false,
}: {
  version?: AssetVersion | null;
  expected: number;
  compact?: boolean;
}) {
  const actual = version?.category === 'character'
    ? version.characterAnimation?.settings.framesPerDirection
    : undefined;
  if (actual === undefined || actual >= expected) return null;
  const message = `Liczba klatek chodu na kierunek: ${actual}; projekt: ${expected}. Wygeneruj nową wersję postaci.`;
  return compact
    ? <span className="character-frame-warning compact" title={message}><AlertTriangle /> {actual}/{expected} kl. · wygeneruj nową wersję</span>
    : <p className="character-frame-warning" role="alert"><AlertTriangle /> {message}</p>;
}

function GeneratorProviderPicker({
  selected,
  onChange,
  codexHealth,
  comfyHealth,
  stableDiffusionCppHealth,
}: {
  selected: GeneratorProvider[];
  onChange: (providers: GeneratorProvider[]) => void;
  codexHealth?: CodexHealth;
  comfyHealth?: ComfyUiHealth;
  stableDiffusionCppHealth?: StableDiffusionCppHealth;
}) {
  const labels: Record<GeneratorProvider, { name: string; description: string }> = {
    codex: { name: 'Codex imagegen', description: 'Generacja przez Codex i model obrazowy.' },
    comfyui: { name: 'ComfyUI', description: 'Lokalny workflow uruchomiony przez Comfy Desktop.' },
    stable_diffusion_cpp: { name: 'stable-diffusion.cpp', description: 'Lokalny, natywny generator uruchamiany z CLI.' },
  };
  const toggle = (provider: GeneratorProvider, checked: boolean) => {
    const next = checked
      ? generatorProviderOrder.filter((candidate) => candidate === provider || selected.includes(candidate))
      : selected.filter((candidate) => candidate !== provider);
    if (next.length) onChange([...next]);
  };

  return <fieldset className="generator-picker">
    <legend>Generatory tego assetu</legend>
    <p>Wybierz jeden lub kilka wariantów. Po uruchomieniu generacji ten wybór zostanie zapamiętany dla następnego nowego assetu w projekcie.</p>
    <div className="generator-options">
      {generatorProviderOrder.map((provider) => {
        const state = generatorProviderState(provider, codexHealth, comfyHealth, stableDiffusionCppHealth);
        const label = labels[provider];
        return <label className={`generator-option ${selected.includes(provider) ? 'selected' : ''} ${state.ready ? 'ready' : 'unavailable'}`} key={provider}>
          <input
            type="checkbox"
            checked={selected.includes(provider)}
            disabled={selected.length === 1 && selected.includes(provider)}
            onChange={(event) => toggle(provider, event.target.checked)}
          />
          <span className="generator-option-copy"><strong>{label.name}</strong><small>{label.description}</small></span>
          <span className="generator-option-status">{state.ready ? <Check /> : <CircleDot />}{state.detail}</span>
        </label>;
      })}
    </div>
  </fieldset>;
}

function GenerationStudio({
  project,
  codexHealth,
  comfyHealth,
  stableDiffusionCppHealth,
}: {
  project: ProjectInfo;
  codexHealth?: CodexHealth;
  comfyHealth?: ComfyUiHealth;
  stableDiffusionCppHealth?: StableDiffusionCppHealth;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [category, setCategory] = useState<AssetCategory>('flat_tile');
  const [elevationLevels, setElevationLevels] = useState(1);
  const [relativeWidth, setRelativeWidth] = useState(1);
  const [relativeHeight, setRelativeHeight] = useState(1);
  const [footprintX, setFootprintX] = useState(1);
  const [footprintY, setFootprintY] = useState(1);
  const [selectedProviders, setSelectedProviders] = useState<GeneratorProvider[]>(() => newAssetGeneratorProviders(project));
  const [error, setError] = useState('');
  useEffect(() => setSelectedProviders(newAssetGeneratorProviders(project)), [
    project.id,
    project.codexGenerationEnabled,
    project.comfyUiEnabled,
    project.stableDiffusionCppEnabled,
  ]);
  const fixedFootprint = isTileAssetCategory(category) || isRoadAssetCategory(category);
  const mutation = useMutation({
    mutationFn: () => window.tilemap.generation.enqueue({
      name,
      prompt,
      mode: 'generate',
      category,
      elevationLevels: category === 'elevated_tile' ? elevationLevels : undefined,
      relativeWidth: isRelativeSizeCategory(category) ? relativeWidth : undefined,
      relativeHeight: isRelativeSizeCategory(category) ? relativeHeight : undefined,
      footprint: fixedFootprint ? { x: 1, y: 1 } : { x: footprintX, y: footprintY },
      generatorProviders: selectedProviders,
    }),
    onSuccess: () => {
      setName(''); setPrompt(''); setError('');
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['assets'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
    },
    onError: (reason) => setError(errorMessage(reason)),
  });
  const selectedProviderStates = selectedProviders.map((provider) => ({
    provider,
    ...generatorProviderState(provider, codexHealth, comfyHealth, stableDiffusionCppHealth),
  }));
  const unavailableProvider = selectedProviderStates.find((provider) => !provider.ready);
  const ready = selectedProviders.length > 0 && !unavailableProvider;
  const generatorCount = selectedProviders.length;
  const readinessMessage = selectedProviders.length === 0
    ? 'Wybierz co najmniej jeden generator dla tego assetu.'
    : unavailableProvider?.message;
  const expectedSize = assetPixelSize(project, {
    category,
    elevationLevels,
    relativeWidth,
    relativeHeight,
  });
  const availableCategories = studioAssetCategoriesForProjection(project.projection);
  const changeCategory = (next: AssetCategory) => {
    if (project.projection === 'top_down' && next === 'elevated_tile') return;
    const defaults = defaultAssetSizing(next);
    setCategory(next);
    setElevationLevels(defaults.elevationLevels || 1);
    setRelativeWidth(defaults.relativeWidth);
    setRelativeHeight(defaults.relativeHeight);
    if (isTileAssetCategory(next) || isRoadAssetCategory(next)) {
      setFootprintX(1);
      setFootprintY(1);
    }
  };

  return <div className="studio-page">
    <div className="section-heading"><div><p className="eyebrow">NOWA GENERACJA</p><h2>Co budujemy?</h2><p>Podaj nazwę assetu i wybierz generatory, których chcesz użyć. Każdy z nich przygotuje osobny wariant do porównania.</p></div><div className="grid-chip"><span>{project.tileWidthPx}</span><small>×</small><span>{project.tileHeightPx}</span><em>px</em></div></div>
    {!ready && <ErrorBox message={readinessMessage ?? 'Generatory nie są jeszcze gotowe.'} />}
    <div className="request-card">
      <div className="form-grid two"><label>Nazwa assetu<input placeholder="Kamienna droga" value={name} onChange={(event) => setName(event.target.value)} /></label><label>Typ assetu<select value={category} onChange={(event) => changeCategory(event.target.value as AssetCategory)}>{availableCategories.map((item) => <option key={item} value={item}>{categoryLabels[item]}</option>)}</select></label></div>
      {category === 'elevated_tile' && <div className="asset-size-settings"><label>Elevation height (poziomy)<input type="number" min={1} max={16} step={1} value={elevationLevels} onChange={(event) => setElevationLevels(Number(event.target.value))} /></label><AssetCanvasSummary size={expectedSize} base={project} detail={`${elevationLevels} × wysokość bazowego rombu`} /></div>}
      {isRelativeSizeCategory(category) && <div className="asset-size-settings"><div className="form-grid two"><label>Szerokość canvasa (× tile)<input type="number" min={0.25} max={16} step={0.25} value={relativeWidth} onChange={(event) => setRelativeWidth(Number(event.target.value))} /></label><label>Wysokość canvasa (× tile)<input type="number" min={0.25} max={16} step={0.25} value={relativeHeight} onChange={(event) => setRelativeHeight(Number(event.target.value))} /></label></div><AssetCanvasSummary size={expectedSize} base={project} detail={`${relativeWidth}× szerokości · ${relativeHeight}× wysokości tile`} /></div>}
      {category === 'flat_tile' && <AssetCanvasSummary size={expectedSize} base={project} detail={project.projection === 'isometric' ? 'Bazowy romb 2:1' : 'Bazowy kwadrat 1:1'} />}
      {category === 'road_tile' && <div className="road-settings"><RoadSetSummary projection={project.projection} /><AssetCanvasSummary size={expectedSize} base={project} detail="16 transparentnych nakładek 1×1" /></div>}
      <label>Opis dla agenta (opcjonalnie)<textarea className="hero-textarea" rows={8} placeholder="Możesz doprecyzować wygląd, materiały lub detale…" value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
      <GeneratorProviderPicker
        selected={selectedProviders}
        onChange={setSelectedProviders}
        codexHealth={codexHealth}
        comfyHealth={comfyHealth}
        stableDiffusionCppHealth={stableDiffusionCppHealth}
      />
      <div className="request-footer">
        <div className="footprint-control">
          <span><strong>Zajęte komórki (footprint)</strong><small>{fixedFootprint ? 1 : footprintX * footprintY} {!fixedFootprint && footprintX * footprintY !== 1 ? 'pola' : 'pole'} łącznie</small></span>
          <input aria-label="Footprint X — zajęte komórki" type="number" min={1} max={64} value={fixedFootprint ? 1 : footprintX} disabled={fixedFootprint} onChange={(event) => setFootprintX(Number(event.target.value))} />
          <small>×</small>
          <input aria-label="Footprint Y — zajęte komórki" type="number" min={1} max={64} value={fixedFootprint ? 1 : footprintY} disabled={fixedFootprint} onChange={(event) => setFootprintY(Number(event.target.value))} />
        </div>
        <button className="primary" disabled={!ready || name.trim().length < 2 || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? <LoaderCircle className="spin" /> : <Sparkles />} Generuj {generatorCount > 1 ? `${generatorCount} warianty` : 'asset'}</button>
      </div>
      {error && <ErrorBox message={error} />}
    </div>
    <div className="process-strip"><ProcessStep number="01" title="Generacja" detail="Codex, ComfyUI i/lub stable-diffusion.cpp" /><ProcessStep number="02" title="Review" detail="Wspólna walidacja i wybór" /><ProcessStep number="03" title="Registry" detail="Provenance + historia" /></div>
  </div>;
}

function CharacterStudio({
  project,
  codexHealth,
  comfyHealth,
  stableDiffusionCppHealth,
}: {
  project: ProjectInfo;
  codexHealth?: CodexHealth;
  comfyHealth?: ComfyUiHealth;
  stableDiffusionCppHealth?: StableDiffusionCppHealth;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [relativeWidth, setRelativeWidth] = useState(0.5);
  const [relativeHeight, setRelativeHeight] = useState(1.5);
  const [footprintX, setFootprintX] = useState(1);
  const [footprintY, setFootprintY] = useState(1);
  const [framesPerSecond, setFramesPerSecond] = useState(8);
  const [selectedProviders, setSelectedProviders] = useState<GeneratorProvider[]>(() => newAssetGeneratorProviders(project));
  const [error, setError] = useState('');
  useEffect(() => setSelectedProviders(newAssetGeneratorProviders(project)), [
    project.id,
    project.codexGenerationEnabled,
    project.comfyUiEnabled,
    project.stableDiffusionCppEnabled,
  ]);
  const directions = characterDirectionsForProjection(project.projection);
  const animationSettings = {
    action: 'walk' as const,
    framesPerDirection: project.characterFramesPerDirection,
    framesPerSecond,
  };
  const frameSize = characterAnimationFrameSize(project, { relativeWidth, relativeHeight });
  const sheetSize = characterAnimationSheetSize(frameSize, animationSettings);
  const selectedProviderStates = selectedProviders.map((provider) => ({
    provider,
    ...generatorProviderState(provider, codexHealth, comfyHealth, stableDiffusionCppHealth),
  }));
  const unavailableProvider = selectedProviderStates.find((provider) => !provider.ready);
  const generatorCount = selectedProviders.length;
  const analyzerReady = codexHealth?.state === 'ready';
  const generatorsReady = generatorCount > 0 && !unavailableProvider;
  const ready = analyzerReady && generatorsReady;
  const readinessMessage = !analyzerReady
    ? `Obowiązkowy analizator ruchu Codex nie jest gotowy. ${codexHealth?.message ?? 'Sprawdzanie połączenia…'}`
    : generatorCount === 0
      ? 'Wybierz co najmniej jeden generator dla tej postaci.'
      : unavailableProvider?.message ?? '';
  const valid = name.trim().length >= 2
    && relativeWidth >= 0.25 && relativeWidth <= 16
    && relativeHeight >= 0.25 && relativeHeight <= 16
    && footprintX >= 1 && footprintX <= 64
    && footprintY >= 1 && footprintY <= 64
    && framesPerSecond >= 1 && framesPerSecond <= 24;
  const mutation = useMutation({
    mutationFn: () => window.tilemap.generation.enqueue({
      name,
      prompt,
      mode: 'generate',
      category: 'character',
      relativeWidth,
      relativeHeight,
      footprint: { x: footprintX, y: footprintY },
      characterAnimation: animationSettings,
      generatorProviders: selectedProviders,
    }),
    onSuccess: () => {
      setName(''); setPrompt(''); setError('');
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['assets'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
    },
    onError: (reason) => setError(errorMessage(reason)),
  });

  return <div className="studio-page character-studio">
    <div className="section-heading">
      <div><p className="eyebrow">STUDIO POSTACI</p><h2>Postać gotowa do ruchu</h2><p>Wygeneruj spójny arkusz z bezruchem i chodem we wszystkich kierunkach bieżącej projekcji.</p></div>
      <div className="grid-chip"><PersonStanding /><span>{project.characterFramesPerDirection + 1}</span><small>×</small><span>{directions.length}</span><em>arkusz</em></div>
    </div>
    {!ready && <ErrorBox message={readinessMessage || 'Generatory nie są jeszcze gotowe.'} />}
    <div className="request-card character-request-card">
      <div className="form-grid three">
        <label>Nazwa postaci<input placeholder="Strażniczka lasu" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Klatki chodu na kierunek<input value={project.characterFramesPerDirection} readOnly /></label>
        <label>Klatki na sekundę (FPS)<input type="number" min={1} max={24} step={1} value={framesPerSecond} onChange={(event) => setFramesPerSecond(Number(event.target.value))} /></label>
      </div>
      <CharacterDirectionSummary projection={project.projection} />
      <div className="character-animation-settings">
        <div className="form-grid two">
          <label>Szerokość klatki (× tile)<input type="number" min={0.25} max={16} step={0.25} value={relativeWidth} onChange={(event) => setRelativeWidth(Number(event.target.value))} /></label>
          <label>Wysokość klatki (× tile)<input type="number" min={0.25} max={16} step={0.25} value={relativeHeight} onChange={(event) => setRelativeHeight(Number(event.target.value))} /></label>
        </div>
        <div className="character-sheet-summary" role="note">
          <SquareStack />
          <div><strong>{frameSize.width}×{frameSize.height}px / klatkę</strong><span>Arkusz {sheetSize.width}×{sheetSize.height}px</span><small>Kolumna 1: idle · kolumny 2–{project.characterFramesPerDirection + 1}: chód</small></div>
        </div>
      </div>
      <label>Opis postaci dla agenta (opcjonalnie)<textarea className="hero-textarea" rows={7} placeholder="Sylwetka, strój, wyposażenie, sposób poruszania się…" value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
      <div className="mandatory-analysis-note" role="note">
        <CircleDot />
        <div><strong>Analiza ruchu jest obowiązkowa</strong><span>Po wygenerowaniu Codex obejrzy idle i pełną pętlę chodu w każdym z 4 kierunków. Dopiero zaliczony komplet trafi do review — niezależnie od ogólnego przełącznika weryfikacji AI.</span></div>
      </div>
      <GeneratorProviderPicker
        selected={selectedProviders}
        onChange={setSelectedProviders}
        codexHealth={codexHealth}
        comfyHealth={comfyHealth}
        stableDiffusionCppHealth={stableDiffusionCppHealth}
      />
      <div className="request-footer">
        <div className="footprint-control">
          <span><strong>Zajęte komórki (footprint)</strong><small>{footprintX * footprintY} {footprintX * footprintY === 1 ? 'pole' : 'pola'} łącznie</small></span>
          <input aria-label="Footprint X postaci — zajęte komórki" type="number" min={1} max={64} value={footprintX} onChange={(event) => setFootprintX(Number(event.target.value))} />
          <small>×</small>
          <input aria-label="Footprint Y postaci — zajęte komórki" type="number" min={1} max={64} value={footprintY} onChange={(event) => setFootprintY(Number(event.target.value))} />
        </div>
        <button className="primary" disabled={!ready || !valid || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? <LoaderCircle className="spin" /> : <PersonStanding />} Generuj {generatorCount > 1 ? `${generatorCount} warianty postaci` : 'postać'}</button>
      </div>
      {error && <ErrorBox message={error} />}
    </div>
    <div className="process-strip character-process-strip"><ProcessStep number="01" title="Arkusz" detail={`Idle + ${project.characterFramesPerDirection} klatek chodu`} /><ProcessStep number="02" title="Kierunki" detail={directions.map((direction) => direction.shortLabel).join(' / ')} /><ProcessStep number="03" title="Analiza ruchu" detail="Obowiązkowa kontrola Codex" /><ProcessStep number="04" title="Review" detail="Dopiero po zaliczeniu" /></div>
  </div>;
}

function CharacterDirectionSummary({ projection }: { projection: ProjectProjection }) {
  const directions = characterDirectionsForProjection(projection);
  return <section className="character-direction-summary" aria-label="Kierunki animacji postaci">
    <div><PersonStanding /><span><strong>Pełny zestaw 4 kierunków</strong><small>{projection === 'isometric' ? 'Izometryczne osie ekranu' : 'Top-down, osie świata'}</small></span></div>
    <div className="character-direction-chips">{directions.map((direction) => <span className="direction-chip" key={direction.id} title={direction.label}><b>{direction.shortLabel}</b>{direction.label}</span>)}</div>
  </section>;
}

function ProcessStep({ number, title, detail }: { number: string; title: string; detail: string }) {
  return <div><span>{number}</span><strong>{title}</strong><small>{detail}</small></div>;
}

function AssetCanvasSummary({
  size,
  base,
  detail,
}: {
  size: { width: number; height: number } | null;
  base: ProjectInfo;
  detail: string;
}) {
  if (!size) return null;
  return <div className="asset-canvas-summary"><SquareStack /><div><strong>{size.width}×{size.height}px</strong><span>{detail}</span><small>Baza projektu: {base.tileWidthPx}×{base.tileHeightPx}px</small></div></div>;
}

function RoadSetSummary({ projection }: { projection: ProjectProjection }) {
  return <div className="road-set-summary">
    <SquareStack />
    <div><strong>Komplet 16 wariantów</strong><span>1 materiał AI + geometria aplikacji · kierunki {projection === 'isometric' ? 'NW/NE/SE/SW' : 'N/E/S/W'} · 4 końce · 2 proste · 4 zakręty · 4 warianty T · skrzyżowanie · izolowany</span></div>
  </div>;
}

function AssetReview({
  assetId,
  jobs,
  project,
  selectedVersionId,
  onSelectVersion,
}: {
  assetId: string;
  jobs: GenerationJob[];
  project: ProjectInfo;
  selectedVersionId: string | null;
  onSelectVersion: (versionId: string) => void;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ['asset', assetId], queryFn: () => window.tilemap.assets.get(assetId), refetchInterval: 3_000 });
  const [repeatTerrain, setRepeatTerrain] = useState(false);
  const [singleZoom, setSingleZoom] = useState(100);
  const [seamZoom, setSeamZoom] = useState(100);
  const [seamColumns, setSeamColumns] = useState(3);
  const [seamRows, setSeamRows] = useState(3);
  const [showError, setShowError] = useState(false);
  const [retryError, setRetryError] = useState('');
  const [verificationError, setVerificationError] = useState('');
  const [detailTab, setDetailTab] = useState<'description' | 'timeline'>('description');
  const errorTriggerRef = useRef<HTMLButtonElement>(null);
  const descriptionTabRef = useRef<HTMLButtonElement>(null);
  const timelineTabRef = useRef<HTMLButtonElement>(null);
  const asset = detail.data;
  const version = asset?.versions.find((item) => item.id === selectedVersionId) ?? asset?.versions[0];
  const retryJob = version
    ? jobs.find((job) => job.versionId === version.id && ['failed', 'cancelled', 'interrupted'].includes(job.status))
    : undefined;

  const handleChanged = (nextVersionId?: string) => {
    if (nextVersionId) onSelectVersion(nextVersionId);
    void queryClient.invalidateQueries({ queryKey: ['asset', assetId] });
    void queryClient.invalidateQueries({ queryKey: ['assets'] });
    void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    void queryClient.invalidateQueries({ queryKey: ['generation-logs', assetId] });
    void queryClient.invalidateQueries({ queryKey: ['project'] });
  };
  const retry = useMutation({
    mutationFn: () => {
      if (!retryJob) throw new Error('Brak zadania, które można ponowić.');
      return window.tilemap.generation.retry(retryJob.id);
    },
    onSuccess: (job) => {
      setRetryError('');
      setShowError(false);
      handleChanged(job.versionId);
    },
    onError: (reason) => {
      setRetryError(errorMessage(reason));
      setShowError(true);
    },
  });
  const verify = useMutation({
    mutationFn: () => {
      if (!version) throw new Error('Brak wersji do weryfikacji.');
      return window.tilemap.generation.verify(version.id);
    },
    onSuccess: (updated) => {
      setVerificationError('');
      queryClient.setQueryData(['asset', assetId], updated);
      handleChanged();
    },
    onError: (reason) => {
      setVerificationError(errorMessage(reason));
      handleChanged();
    },
  });

  useEffect(() => { if (version && !isTileAssetCategory(version.category)) setRepeatTerrain(false); }, [version?.category]);
  useEffect(() => {
    setShowError(false);
    setRetryError('');
    setVerificationError('');
    setDetailTab('description');
  }, [version?.id]);
  if (detail.isLoading || !asset || !version) return <FullScreenLoader label="Wczytywanie assetu…" compact />;

  const isTerrain = isTileAssetCategory(version.category);
  const expectedAssetSize = version.category === 'character' && version.characterAnimation
    ? version.characterAnimation.sheetSize
    : assetPixelSize(project, version);
  const assetSizeMismatch = expectedAssetSize && version.width !== null && version.height !== null
    && (version.width !== expectedAssetSize.width || version.height !== expectedAssetSize.height);
  const previewZoom = repeatTerrain ? seamZoom : singleZoom;
  const setPreviewZoom = repeatTerrain ? setSeamZoom : setSingleZoom;

  const errorDetails = retryError || version.error;
  const canVerifyWithAi = Boolean(version.finalPath)
    && version.aiVerificationStatus !== 'passed'
    && ['needs_review', 'approved', 'rejected'].includes(version.status);
  const verificationDetails = verificationError
    || (version.aiVerificationStatus === 'failed' ? version.aiVerificationMessage : '');
  const descriptionTabId = `asset-description-tab-${version.id}`;
  const descriptionPanelId = `asset-description-panel-${version.id}`;
  const timelineTabId = `asset-timeline-tab-${version.id}`;
  const timelinePanelId = `asset-timeline-panel-${version.id}`;
  const generationActive = jobs.some((job) => job.assetId === asset.id && ['queued', 'generating'].includes(job.status));
  const selectDetailTab = (nextTab: 'description' | 'timeline', focus = false) => {
    setDetailTab(nextTab);
    if (focus) {
      (nextTab === 'description' ? descriptionTabRef : timelineTabRef).current?.focus();
    }
  };

  return <div className="review-page">
    <div className="section-heading compact review-heading">
      <div><p className="eyebrow">ASSET / {categoryLabels[version.category].toLocaleUpperCase()}</p><h2>{asset.name}</h2></div>
      <div className="status-actions">
        <GeneratorBadge version={version} />
        <StatusBadge
          status={version.status}
          large
          onClick={version.status === 'failed' ? () => setShowError(true) : undefined}
          buttonRef={errorTriggerRef}
        />
        {retryJob && <button className="secondary retry-inline" disabled={retry.isPending} onClick={() => retry.mutate()}>
          {retry.isPending ? <LoaderCircle className="spin" /> : <RefreshCw />} Ponów
        </button>}
        {canVerifyWithAi && <button className="secondary retry-inline" disabled={verify.isPending} onClick={() => verify.mutate()}>
          {verify.isPending ? <LoaderCircle className="spin" /> : <CircleDot />} Weryfikacja
        </button>}
      </div>
    </div>
    <section className="review-details" aria-label="Szczegóły wersji assetu">
      <div className="review-detail-tabs" role="tablist" aria-label="Widok szczegółów assetu">
        <button
          ref={descriptionTabRef}
          id={descriptionTabId}
          type="button"
          role="tab"
          aria-selected={detailTab === 'description'}
          aria-controls={descriptionPanelId}
          tabIndex={detailTab === 'description' ? 0 : -1}
          onClick={() => selectDetailTab('description')}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'End') {
              event.preventDefault();
              selectDetailTab('timeline', true);
            }
          }}
        >Opis</button>
        <button
          ref={timelineTabRef}
          id={timelineTabId}
          type="button"
          role="tab"
          aria-selected={detailTab === 'timeline'}
          aria-controls={timelinePanelId}
          tabIndex={detailTab === 'timeline' ? 0 : -1}
          onClick={() => selectDetailTab('timeline')}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'Home') {
              event.preventDefault();
              selectDetailTab('description', true);
            }
          }}
        >Przebieg{generationActive && <i aria-hidden="true" title="Generacja aktywna" />}</button>
      </div>
      <div
        id={descriptionPanelId}
        className="review-description-panel"
        role="tabpanel"
        aria-labelledby={descriptionTabId}
        hidden={detailTab !== 'description'}
      >
        <p>{version.aiDescription || version.prompt || 'Brak opisu tej wersji.'}</p>
      </div>
      <div
        id={timelinePanelId}
        className="review-timeline-panel"
        role="tabpanel"
        aria-labelledby={timelineTabId}
        hidden={detailTab !== 'timeline'}
      >
        <GenerationLogPanel
          assetId={asset.id}
          versions={asset.versions}
          active={generationActive}
          embedded
        />
      </div>
    </section>
    {verificationDetails && <p className="geometry-warning"><AlertTriangle /> Weryfikacja AI: {verificationDetails}</p>}
    <div className="review-layout">
      <div className="preview-column">
        {version.imageUrl && version.category !== 'character' && <div className="preview-toolbar">
          {isTerrain && <div className="preview-mode-switch" aria-label="Tryb podglądu terenu">
            <button className={!repeatTerrain ? 'active' : ''} aria-pressed={!repeatTerrain} onClick={() => setRepeatTerrain(false)}>Pojedynczy tile</button>
            <button className={repeatTerrain ? 'active' : ''} aria-pressed={repeatTerrain} onClick={() => setRepeatTerrain(true)}><Layers3 /> Tile obok tile</button>
          </div>}
          {isTerrain && repeatTerrain && <div
            className="preview-grid-size-controls"
            role="group"
            aria-label="Rozmiar siatki podglądu"
            title={project.projection === 'isometric' ? 'W izometrii szerokość i wysokość biegną po przekątnych siatki.' : undefined}
          >
            <label><span>Szerokość</span><input aria-label="Szerokość podglądu w kaflach" type="number" min={1} max={16} step={1} value={seamColumns} onChange={(event) => setSeamColumns(clampTerrainPreviewTiles(Number(event.target.value)))} /></label>
            <label><span>Wysokość</span><input aria-label="Wysokość podglądu w kaflach" type="number" min={1} max={16} step={1} value={seamRows} onChange={(event) => setSeamRows(clampTerrainPreviewTiles(Number(event.target.value)))} /></label>
          </div>}
          <PreviewZoomControls zoom={previewZoom} onZoom={setPreviewZoom} />
        </div>}
        {version.category === 'character' && version.characterAnimation && version.imageUrl
          ? <div className="character-review-preview">
            <CharacterAnimationPreview version={version} assetName={asset.name} />
            <MovementAnalysisPanel animation={version.characterAnimation} />
          </div>
          : version.category === 'road_tile' && version.roadVariants?.length
            ? <RoadVariantGrid version={version} assetName={asset.name} projection={project.projection} zoom={singleZoom} />
          : repeatTerrain && version.imageUrl
            ? <TerrainSeamPreview
            version={version}
            assetName={asset.name}
            tileWidth={project.tileWidthPx}
            tileHeight={project.tileHeightPx}
            projection={project.projection}
            spriteHeight={expectedAssetSize?.height}
            columns={seamColumns}
            rows={seamRows}
            zoom={seamZoom}
            onZoom={setSeamZoom}
            />
            : <div className={`image-stage ${isTerrain ? 'terrain-stage' : ''} ${version.status === 'failed' ? 'failed-stage' : ''}`} style={expectedAssetSize ? { aspectRatio: `${expectedAssetSize.width} / ${expectedAssetSize.height}` } : undefined}>
            {version.imageUrl
              ? <div className="preview-zoom-layer" style={{ '--preview-zoom': singleZoom / 100 } as React.CSSProperties}><img src={version.imageUrl} alt={asset.name} /><TileOverlay version={version} /></div>
              : version.status === 'failed'
                ? <div className="empty-preview failed-preview"><span>{statusLabels[version.status]}</span></div>
                : <div className="empty-preview"><LoaderCircle className={version.status === 'generating' ? 'spin' : ''} /><span>{statusLabels[version.status]}</span></div>}
            </div>}
        <div className="image-meta"><span>{version.width ?? '—'} × {version.height ?? '—'} px</span><span>{categoryLabels[version.category]}</span><GeneratorBadge version={version} compact />{version.category === 'road_tile' && <span>{version.roadVariants?.length ?? 0} wariantów</span>}{version.category === 'elevated_tile' && <span>Elevation {version.elevationLevels}</span>}{version.category === 'character' && version.characterAnimation && <><span>Idle + {version.characterAnimation.settings.framesPerDirection} kl. chodu</span><span>{version.characterAnimation.settings.framesPerSecond} FPS</span><span>{version.characterAnimation.directions.length} kierunki</span></>}{isRelativeSizeCategory(version.category) && <span>Size {version.relativeWidth}×{version.relativeHeight}</span>}<span>Footprint {version.footprint.x}×{version.footprint.y}</span>{version.imageUrl && <span>Pivot {version.pivot.x.toFixed(2)}, {version.pivot.y.toFixed(2)}</span>}{repeatTerrain && <span className="seam-legend">Różowe = szczelina</span>}</div>
        {assetSizeMismatch && <p className="geometry-warning"><AlertTriangle /> Ten asset ma canvas {version.width}×{version.height}px zamiast {expectedAssetSize.width}×{expectedAssetSize.height}px wynikającego z parametrów tej wersji.</p>}
      </div>
      <ReviewControls asset={asset} version={version} project={project} onChanged={handleChanged} />
    </div>
    {showError && <ErrorDetailsModal
      message={errorDetails || 'Brak dodatkowych szczegółów błędu.'}
      onClose={() => setShowError(false)}
      returnFocusRef={errorTriggerRef}
    />}
  </div>;
}

export function AssetAttemptsSidebar({
  assetId,
  selectedVersionId,
  onSelectVersion,
  expectedCharacterFrames,
}: {
  assetId: string;
  selectedVersionId: string | null;
  onSelectVersion: (versionId: string) => void;
  expectedCharacterFrames: number;
}) {
  const detail = useQuery({ queryKey: ['asset', assetId], queryFn: () => window.tilemap.assets.get(assetId), refetchInterval: 3_000 });
  const asset = detail.data;
  const selected = asset?.versions.find((version) => version.id === selectedVersionId)?.id
    ?? asset?.versions[0]?.id
    ?? '';
  return <aside className="asset-attempts-panel">
    <div className="attempts-title">
      <div><p className="eyebrow">HISTORIA ASSETU</p><h3>Podejścia</h3></div>
      <span>{asset?.versions.length ?? 0}</span>
    </div>
    {detail.isLoading && <FullScreenLoader label="Wczytywanie wersji…" compact />}
    {asset && <VersionRail versions={asset.versions} selected={selected} onSelect={onSelectVersion} expectedCharacterFrames={expectedCharacterFrames} />}
  </aside>;
}

function TileOverlay({ version }: { version: AssetVersion }) {
  return <div className="tile-overlay" style={{ '--pivot-x': `${version.pivot.x * 100}%`, '--pivot-y': `${(1 - version.pivot.y) * 100}%` } as React.CSSProperties}>
    <div className="pivot-dot" title="Pivot" />
  </div>;
}

export function CharacterAnimationPreview({ version, assetName }: { version: AssetVersion; assetName: string }) {
  const animation = version.characterAnimation;
  const [action, setAction] = useState<'idle' | 'walk'>('walk');
  const [selectedDirectionId, setSelectedDirectionId] = useState(animation?.directions[0]?.id ?? '');
  const [playing, setPlaying] = useState(true);
  const [frameIndex, setFrameIndex] = useState(0);
  const directionCount = animation?.directions.length ?? 0;
  const frameCount = action === 'idle' ? 1 : animation?.settings.framesPerDirection ?? 1;
  const sheetColumnCount = (animation?.settings.framesPerDirection ?? 1) + 1;
  const selectedDirectionIndex = Math.max(0, animation?.directions.findIndex((direction) => direction.id === selectedDirectionId) ?? 0);
  const sheetColumn = action === 'idle' ? 0 : frameIndex + 1;

  useEffect(() => {
    setSelectedDirectionId(animation?.directions[0]?.id ?? '');
    setAction('walk');
    setPlaying(true);
    setFrameIndex(0);
  }, [version.id]);
  useEffect(() => setFrameIndex(0), [action, selectedDirectionId]);
  useEffect(() => {
    if (!animation || action !== 'walk' || !playing || frameCount < 2) return undefined;
    const timer = window.setInterval(
      () => setFrameIndex((current) => (current + 1) % frameCount),
      1_000 / animation.settings.framesPerSecond,
    );
    return () => window.clearInterval(timer);
  }, [action, animation?.settings.framesPerSecond, frameCount, playing]);

  if (!animation || !version.imageUrl || !directionCount) return null;
  const selectedDirection = animation.directions[selectedDirectionIndex];
  const previewScale = Math.min(360 / animation.frameSize.width, 300 / animation.frameSize.height);
  const previewSize = {
    width: Math.max(1, Math.round(animation.frameSize.width * previewScale)),
    height: Math.max(1, Math.round(animation.frameSize.height * previewScale)),
  };
  const frameStyle = (column: number, row: number): React.CSSProperties => ({
    backgroundImage: `url(${JSON.stringify(version.imageUrl)})`,
    backgroundSize: `${sheetColumnCount * 100}% ${directionCount * 100}%`,
    backgroundPosition: `${sheetColumnCount === 1 ? 0 : column * 100 / (sheetColumnCount - 1)}% ${directionCount === 1 ? 0 : row * 100 / (directionCount - 1)}%`,
  });

  return <section className="character-animation-preview" aria-label="Podgląd animacji postaci">
    <div className="character-animation-toolbar">
      <div className="character-action-tabs" role="tablist" aria-label="Animacja postaci">
        <button role="tab" aria-selected={action === 'idle'} className={action === 'idle' ? 'active' : ''} onClick={() => setAction('idle')}>Idle</button>
        <button role="tab" aria-selected={action === 'walk'} className={action === 'walk' ? 'active' : ''} onClick={() => setAction('walk')}>Chód</button>
      </div>
      <div className="character-playback">
        <button aria-label={playing ? 'Wstrzymaj animację' : 'Odtwórz animację'} disabled={action === 'idle'} onClick={() => setPlaying((current) => !current)}>{playing ? <Pause /> : <Play />}</button>
        <span>{action === 'idle' ? 'Klatka idle' : `Klatka ${frameIndex + 1} / ${frameCount}`}</span>
        <small>{animation.settings.framesPerSecond} FPS</small>
      </div>
    </div>
    <div className="character-direction-tabs" role="tablist" aria-label="Kierunek ruchu postaci">
      {animation.directions.map((direction) => <button
        key={direction.id}
        role="tab"
        aria-selected={direction.id === selectedDirection?.id}
        className={direction.id === selectedDirection?.id ? 'active' : ''}
        title={direction.label}
        onClick={() => setSelectedDirectionId(direction.id)}
      ><b>{direction.shortLabel}</b><span>{direction.label}</span></button>)}
    </div>
    <div className="character-animation-stage">
      <div
        className="character-frame-preview"
        role="img"
        aria-label={`${assetName}: ${action === 'idle' ? 'idle' : 'chód'}, kierunek ${selectedDirection?.label}`}
        data-column={sheetColumn}
        data-row={selectedDirectionIndex}
        style={{
          ...frameStyle(sheetColumn, selectedDirectionIndex),
          width: previewSize.width,
          height: previewSize.height,
        }}
      ><TileOverlay version={version} /></div>
    </div>
    <div className="character-frame-strip" aria-label="Klatki wybranej animacji">
      {Array.from({ length: frameCount }, (_, index) => {
        const column = action === 'idle' ? 0 : index + 1;
        return <button
          key={`${action}-${index}`}
          className={index === frameIndex ? 'active' : ''}
          aria-label={action === 'idle' ? 'Pokaż klatkę idle' : `Pokaż klatkę chodu ${index + 1}`}
          aria-pressed={index === frameIndex}
          onClick={() => { setFrameIndex(index); setPlaying(false); }}
        ><span data-column={column} data-row={selectedDirectionIndex} style={{ ...frameStyle(column, selectedDirectionIndex), aspectRatio: `${animation.frameSize.width} / ${animation.frameSize.height}` }} /><small>{action === 'idle' ? 'idle' : index + 1}</small></button>;
      })}
    </div>
  </section>;
}

export function MovementAnalysisPanel({ animation }: { animation: NonNullable<AssetVersion['characterAnimation']> }) {
  const analysis = animation.movementAnalysis;
  const statusLabel = analysis.status === 'passed' ? 'Zaliczona' : analysis.status === 'failed' ? 'Niezaliczona' : 'W toku';
  return <section
    className={`movement-analysis ${analysis.status}`}
    role={analysis.status === 'failed' ? 'alert' : 'status'}
    aria-live="polite"
    aria-label="Analiza ruchu postaci"
  >
    <div className="movement-analysis-heading">
      <span>{analysis.status === 'passed' ? <Check /> : analysis.status === 'failed' ? <AlertTriangle /> : <LoaderCircle className="spin" />}</span>
      <div><p className="eyebrow">OBOWIĄZKOWA ANALIZA AGENTA</p><strong>{statusLabel}</strong></div>
      <b>{analysis.directions.filter((direction) => direction.status === 'passed').length} / {animation.directions.length} kierunki</b>
    </div>
    <p>{analysis.summary || 'Codex analizuje ciągłość sylwetki, kierunek kroku i płynność pełnej pętli.'}</p>
    <div className="movement-direction-results">
      {animation.directions.map((direction) => {
        const result = analysis.directions.find((item) => item.direction === direction.id);
        const status = result?.status ?? 'pending';
        return <div className={status} key={direction.id}>
          <span>{status === 'passed' ? <Check /> : status === 'failed' ? <X /> : <LoaderCircle className="spin" />}</span>
          <strong>{direction.shortLabel}</strong>
          <div><b>{direction.label}</b><small>{result?.message || 'Oczekuje na analizę ruchu.'}</small></div>
        </div>;
      })}
    </div>
    {analysis.analyzedAt && <small className="movement-analyzed-at">Analiza zakończona {formatDate(analysis.analyzedAt)}</small>}
  </section>;
}

function RoadVariantGrid({
  version,
  assetName,
  projection,
  zoom,
}: {
  version: AssetVersion;
  assetName: string;
  projection: ProjectProjection;
  zoom: number;
}) {
  return <div className="road-variant-stage">
    <div className="road-variant-grid" style={{ width: `${zoom}%` }}>
      {version.roadVariants?.map((variant) => <figure className="road-variant-card" key={variant.connectionMask}>
        <div><img src={variant.imageUrl} alt={`${assetName}: ${roadVariantLabel(variant.connectionMask, projection)}`} /></div>
        <figcaption><strong>{variant.connectionMask.toString().padStart(2, '0')}</strong><span>{roadVariantLabel(variant.connectionMask, projection)}</span></figcaption>
      </figure>)}
    </div>
  </div>;
}

export function PreviewZoomControls({ zoom, onZoom }: { zoom: number; onZoom: (zoom: number) => void }) {
  return <div className="preview-zoom-controls" aria-label="Zoom podglądu">
    <button aria-label="Pomniejsz podgląd" disabled={zoom <= 50} onClick={() => onZoom(clampPreviewZoom(zoom - 25))}><ZoomOut /></button>
    <button className="preview-zoom-value" aria-label="Resetuj zoom" title="Resetuj zoom do 100%" onClick={() => onZoom(100)}>{zoom}%</button>
    <button aria-label="Powiększ podgląd" disabled={zoom >= 300} onClick={() => onZoom(clampPreviewZoom(zoom + 25))}><ZoomIn /></button>
  </div>;
}

function clampPreviewZoom(value: number): number {
  return Math.min(300, Math.max(50, value));
}

function clampTerrainPreviewTiles(value: number): number {
  if (!Number.isFinite(value)) return 3;
  return Math.min(16, Math.max(1, Math.round(value)));
}

function createTerrainPreviewCells(columns: number, rows: number) {
  return Array.from({ length: rows }, (_, row) => row)
    .flatMap((row) => Array.from({ length: columns }, (_, column) => ({
      column,
      row,
    })))
    .sort((left, right) => (left.column + left.row) - (right.column + right.row) || left.column - right.column);
}

export function TerrainSeamPreview({
  version,
  assetName,
  tileWidth,
  tileHeight,
  projection = 'isometric',
  spriteHeight,
  columns = 3,
  rows = 3,
  zoom = 100,
  onZoom,
}: {
  version: AssetVersion;
  assetName: string;
  tileWidth: number;
  tileHeight: number;
  projection?: ProjectProjection;
  spriteHeight?: number;
  columns?: number;
  rows?: number;
  zoom?: number;
  onZoom: (zoom: number) => void;
}) {
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const scaledTileWidth = Math.round(tileWidth * zoom / 100);
  const scaledTileHeight = Math.round(tileHeight * zoom / 100);
  const scaledSpriteHeight = Math.round((spriteHeight ?? tileHeight) * zoom / 100);
  const topDown = projection === 'top_down';
  const visibleColumns = clampTerrainPreviewTiles(columns);
  const visibleRows = clampTerrainPreviewTiles(rows);
  const terrainPreviewCells = useMemo(
    () => createTerrainPreviewCells(visibleColumns, visibleRows),
    [visibleColumns, visibleRows],
  );
  const gridWidth = topDown
    ? scaledTileWidth * visibleColumns
    : (visibleColumns + visibleRows) * scaledTileWidth / 2;
  const gridHeight = topDown
    ? scaledTileHeight * visibleRows
    : (visibleColumns + visibleRows) * scaledTileHeight / 2 + Math.max(0, scaledSpriteHeight - scaledTileHeight);

  useEffect(() => setPan({ x: 0, y: 0 }), [version.id, visibleColumns, visibleRows]);

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.deltaY) return;
    event.preventDefault();
    const nextZoom = clampPreviewZoom(zoom + (event.deltaY < 0 ? 25 : -25));
    if (nextZoom === zoom) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const cursorX = event.clientX - bounds.left - bounds.width / 2;
    const cursorY = event.clientY - bounds.top - bounds.height / 2;
    const ratio = nextZoom / zoom;
    setPan((current) => ({
      x: Math.round(cursorX - (cursorX - current.x) * ratio),
      y: Math.round(cursorY - (cursorY - current.y) * ratio),
    }));
    onZoom(nextZoom);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPan({
      x: Math.round(drag.panX + event.clientX - drag.x),
      y: Math.round(drag.panY + event.clientY - drag.y),
    });
  };

  const finishDragging = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setDragging(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const panStep = 24;
    if (event.key === 'ArrowLeft') setPan((current) => ({ ...current, x: current.x - panStep }));
    else if (event.key === 'ArrowRight') setPan((current) => ({ ...current, x: current.x + panStep }));
    else if (event.key === 'ArrowUp') setPan((current) => ({ ...current, y: current.y - panStep }));
    else if (event.key === 'ArrowDown') setPan((current) => ({ ...current, y: current.y + panStep }));
    else if (event.key === '+' || event.key === '=') onZoom(clampPreviewZoom(zoom + 25));
    else if (event.key === '-' || event.key === '_') onZoom(clampPreviewZoom(zoom - 25));
    else if (event.key === '0') { setPan({ x: 0, y: 0 }); onZoom(100); }
    else return;
    event.preventDefault();
  };

  return <div
    className={`seam-stage${dragging ? ' dragging' : ''}`}
    role="region"
    tabIndex={0}
    aria-label={`Podgląd powtarzania terenu ${assetName}: ${topDown ? 'top-down' : 'izometryczny'}, siatka ${visibleColumns}×${visibleRows}. Przeciągnij lub użyj strzałek, aby przesunąć. Kółko myszy albo klawisze plus i minus zmieniają zoom; klawisz 0 resetuje widok.`}
    title="Przeciągnij, aby przesunąć · kółko myszy zmienia zoom · klawisz 0 resetuje widok"
    onWheel={handleWheel}
    onPointerDown={handlePointerDown}
    onPointerMove={handlePointerMove}
    onPointerUp={finishDragging}
    onPointerCancel={finishDragging}
    onDoubleClick={() => setPan({ x: 0, y: 0 })}
    onKeyDown={handleKeyDown}
  >
    <div className="seam-grid" style={{
      width: `${gridWidth}px`,
      height: `${gridHeight}px`,
      '--preview-pan-x': `${pan.x}px`,
      '--preview-pan-y': `${pan.y}px`,
    } as React.CSSProperties}>
      {terrainPreviewCells.map(({ column, row }) => <img
        key={`${column}:${row}`}
        className="seam-tile"
        src={version.imageUrl!}
        alt=""
        aria-hidden="true"
        data-column={column + 1}
        data-row={row + 1}
        draggable={false}
        style={{
          left: `${topDown ? (column + 0.5) * scaledTileWidth : (visibleRows + column - row) * (scaledTileWidth / 2)}px`,
          top: `${topDown ? (row + 0.5) * scaledTileHeight : (column + row + 1) * (scaledTileHeight / 2)}px`,
          width: `${scaledTileWidth}px`,
          height: `${scaledSpriteHeight}px`,
          transform: topDown ? 'translate(-50%, -50%)' : `translate(-50%, -${scaledTileHeight / 2}px)`,
        }}
      />)}
    </div>
  </div>;
}

function VersionRail({
  versions,
  selected,
  onSelect,
  expectedCharacterFrames,
}: {
  versions: AssetVersion[];
  selected: string;
  onSelect: (id: string) => void;
  expectedCharacterFrames: number;
}) {
  return <div className="version-rail">{versions.map((version, index) => <button key={version.id} className={selected === version.id ? 'active' : ''} onClick={() => onSelect(version.id)}>
    <span className="version-number">v{versions.length - index}</span>
    <small>{version.mode === 'edit' ? 'Edycja' : version.mode === 'variant' ? 'Wariant' : 'Generacja'}</small>
    <GeneratorBadge version={version} compact />
    <CharacterFrameCountWarning version={version} expected={expectedCharacterFrames} compact />
    <StatusBadge status={version.status} />
    {version.imageUrl ? <img src={version.imageUrl} alt="" /> : <div className="version-placeholder"><LoaderCircle className={version.status === 'generating' ? 'spin' : ''} /></div>}
  </button>)}</div>;
}

function GeneratorBadge({ version, compact = false }: { version: AssetVersion; compact?: boolean }) {
  const provider = version.generatorProvider ?? 'codex';
  const model = version.generatorModel || (provider === 'codex' ? 'imagegen' : 'model nieznany');
  const providerLabel = provider === 'comfyui'
    ? 'ComfyUI'
    : provider === 'stable_diffusion_cpp'
      ? 'stable-diffusion.cpp'
      : 'Codex';
  const label = `${providerLabel} · ${model}`;
  return <span className={`generator-badge provider-${provider} ${compact ? 'compact' : ''}`} title={label}>{label}</span>;
}

const generationStageLabels: Record<GenerationLogEntry['stage'], string> = {
  generation: 'Generowanie',
  verification: 'Weryfikacja',
  retry: 'Auto-retry',
  review: 'Review',
  system: 'System',
};

export function GenerationLogPanel({
  assetId,
  active,
  versions,
  embedded = false,
}: {
  assetId: string;
  active: boolean;
  versions?: AssetVersion[];
  embedded?: boolean;
}) {
  const entriesRef = useRef<HTMLDivElement>(null);
  const previewTriggerRef = useRef<HTMLButtonElement>(null);
  const [expandedEntryIds, setExpandedEntryIds] = useState<ReadonlySet<string>>(() => new Set());
  const [preview, setPreview] = useState<{ entry: GenerationLogEntry; reference: ProjectReference | null } | null>(null);
  const closePreview = useCallback(() => setPreview(null), []);
  const logs = useQuery({
    queryKey: ['generation-logs', assetId],
    queryFn: () => window.tilemap.generation.logs(assetId),
    refetchInterval: active ? 1_000 : false,
  });
  const references = useQuery({
    queryKey: ['project-references'],
    queryFn: () => window.tilemap.references.list(),
  });
  const entries = logs.data?.slice(-60) ?? [];
  const versionLabels = new Map(versions?.map((version, index) => [version.id, `v${versions.length - index}`]) ?? []);
  const referencesById = new Map((references.data ?? []).map((reference) => [reference.id, reference]));
  useEffect(() => {
    if (active && entriesRef.current) entriesRef.current.scrollTop = entriesRef.current.scrollHeight;
  }, [active, entries.length]);
  return <section className={`generation-log${embedded ? ' embedded' : ''}`} aria-label="Dziennik generacji" aria-live="polite">
    {!embedded && <div className="generation-log-heading">
      <div><p className="eyebrow">PRZEBIEG</p><strong>Log generacji</strong></div>
      {active && <span className="generation-log-live"><i /> AKTYWNA</span>}
    </div>}
    <div className="generation-log-entries" ref={entriesRef}>
      {logs.isLoading && <div className="generation-log-empty"><LoaderCircle className="spin" /> Wczytywanie logu…</div>}
      {!logs.isLoading && !entries.length && <div className="generation-log-empty">Log pojawi się po rozpoczęciu generacji.</div>}
      {entries.map((entry) => {
        const expanded = expandedEntryIds.has(entry.id);
        const detailsId = `generation-log-details-${entry.id}`;
        const referenceId = entry.details?.tool === 'registry.get_reference'
          && typeof entry.details.arguments.referenceId === 'string'
          ? entry.details.arguments.referenceId
          : null;
        const reference = referenceId ? referencesById.get(referenceId) ?? null : null;
        const message = reference
          ? `Codex pobiera projektowy obraz referencyjny: ${reference.description || reference.name}.`
          : entry.message;
        const failedPreview = entry.stage === 'verification'
          && (entry.level === 'warning' || entry.level === 'error')
          && entry.previewUrl;
        const previewUrl = reference?.imageUrl ?? failedPreview;
        return <div className={`generation-log-entry level-${entry.level}`} key={entry.id}>
          {entry.details ? <button
            type="button"
            className={`generation-log-toggle${expanded ? ' expanded' : ''}`}
            aria-expanded={expanded}
            aria-controls={detailsId}
            aria-label={expanded ? 'Ukryj szczegóły wywołania' : 'Pokaż szczegóły wywołania'}
            onClick={() => setExpandedEntryIds((current) => {
              const next = new Set(current);
              if (next.has(entry.id)) next.delete(entry.id);
              else next.add(entry.id);
              return next;
            })}
          ><ChevronRight /></button> : <i className="generation-log-dot" />}
          <span className={`generation-log-stage stage-${entry.stage}`}>{generationStageLabels[entry.stage]}</span>
          <small>{[versionLabels.get(entry.versionId), entry.attempt > 0 ? `Próba ${entry.attempt}` : ''].filter(Boolean).join(' · ') || '—'}</small>
          <p>{message}</p>
          <time dateTime={entry.createdAt}>{formatLogTime(entry.createdAt)}</time>
          {previewUrl && <button
            type="button"
            className="generation-log-preview"
            aria-label={reference
              ? `Pokaż obraz referencyjny ${reference.name}`
              : `Pokaż podgląd nieudanej próby ${entry.attempt}`}
            onClick={(event) => {
              previewTriggerRef.current = event.currentTarget;
              setPreview({ entry: { ...entry, message, previewUrl }, reference });
            }}
          ><img src={previewUrl} alt="" /></button>}
          {entry.details && expanded && <div className="generation-log-details" id={detailsId}>
            <strong>{entry.details.tool}</strong><pre>{JSON.stringify(entry.details.arguments, null, 2)}</pre>
          </div>}
        </div>;
      })}
    </div>
    {preview?.entry.previewUrl && <GenerationLogPreviewModal
      entry={preview.entry}
      reference={preview.reference}
      onClose={closePreview}
      returnFocusRef={previewTriggerRef}
    />}
  </section>;
}

function GenerationLogPreviewModal({
  entry,
  reference,
  onClose,
  returnFocusRef,
}: {
  entry: GenerationLogEntry;
  reference: ProjectReference | null;
  onClose: () => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      returnFocusRef.current?.focus();
    };
  }, [onClose, returnFocusRef]);

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="attempt-preview-modal" role="dialog" aria-modal="true" aria-labelledby="attempt-preview-title">
      <div className="attempt-preview-heading">
        <div><p className="eyebrow">{reference ? 'OBRAZ REFERENCYJNY' : 'NIEUDANA WERYFIKACJA'}</p><h3 id="attempt-preview-title">{reference?.name ?? `Próba ${entry.attempt}`}</h3></div>
        <button ref={closeButtonRef} type="button" className="icon-button" aria-label="Zamknij podgląd" onClick={onClose}><X /></button>
      </div>
      <div className="attempt-preview-stage"><img src={entry.previewUrl!} alt={reference ? `Obraz referencyjny ${reference.name}` : `Asset odrzucony w próbie ${entry.attempt}`} /></div>
      <p className="attempt-preview-message">{entry.message}</p>
    </section>
  </div>;
}

export function ReviewControls({
  asset,
  version,
  project,
  onChanged,
}: {
  asset: AssetDetail;
  version: AssetVersion;
  project: ProjectInfo;
  onChanged: (nextVersionId?: string) => void;
}) {
  const [category, setCategory] = useState(version.category);
  const [elevationLevels, setElevationLevels] = useState(version.elevationLevels);
  const [relativeWidth, setRelativeWidth] = useState(version.relativeWidth);
  const [relativeHeight, setRelativeHeight] = useState(version.relativeHeight);
  const [characterFramesPerSecond, setCharacterFramesPerSecond] = useState(version.characterAnimation?.settings.framesPerSecond ?? 8);
  const [tags, setTags] = useState(version.tags.join(', '));
  const [fx, setFx] = useState(version.footprint.x);
  const [fy, setFy] = useState(version.footprint.y);
  const [px, setPx] = useState(version.pivot.x);
  const [py, setPy] = useState(version.pivot.y);
  const [feedback, setFeedback] = useState('');
  const [rejection, setRejection] = useState('');
  const [error, setError] = useState('');
  const anotherVersionApproved = asset.versions.some(
    (item) => item.id !== version.id && item.status === 'approved',
  );
  const versionHasFixedFootprint = isTileAssetCategory(version.category) || isRoadAssetCategory(version.category);
  const nextHasFixedFootprint = isTileAssetCategory(category) || isRoadAssetCategory(category);
  const movementAnalysisPassed = version.category !== 'character'
    || version.characterAnimation?.movementAnalysis.status === 'passed';

  useEffect(() => {
    setCategory(version.category); setTags(version.tags.join(', '));
    setElevationLevels(version.elevationLevels);
    setRelativeWidth(version.relativeWidth);
    setRelativeHeight(version.relativeHeight);
    setCharacterFramesPerSecond(version.characterAnimation?.settings.framesPerSecond ?? 8);
    setFx(version.footprint.x); setFy(version.footprint.y); setPx(version.pivot.x); setPy(version.pivot.y);
  }, [version.id, version.footprint.x, version.footprint.y, version.pivot.x, version.pivot.y]);

  const review = useMutation({
    mutationFn: (decision: 'approved' | 'rejected') => {
      if (decision === 'approved' && !movementAnalysisPassed) {
        throw new Error('Postać można zatwierdzić dopiero po zaliczeniu obowiązkowej analizy ruchu.');
      }
      return window.tilemap.assets.review({
        versionId: version.id, decision,
        tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
        rejectionReason: decision === 'rejected' ? rejection : undefined,
        footprint: versionHasFixedFootprint ? { x: 1, y: 1 } : { x: fx, y: fy }, pivot: { x: px, y: py },
      });
    },
    onSuccess: () => { setError(''); onChanged(); },
    onError: (reason) => setError(errorMessage(reason)),
  });
  const iterate = useMutation({
    mutationFn: (mode: GenerationMode) => window.tilemap.generation.enqueue({
      assetId: asset.id, parentVersionId: version.id, name: asset.name, prompt: version.prompt,
      feedback, mode, category,
      elevationLevels: category === 'elevated_tile' ? elevationLevels : undefined,
      relativeWidth: isRelativeSizeCategory(category) ? relativeWidth : undefined,
      relativeHeight: isRelativeSizeCategory(category) ? relativeHeight : undefined,
      footprint: nextHasFixedFootprint ? { x: 1, y: 1 } : { x: fx, y: fy },
      characterAnimation: category === 'character'
        ? { action: 'walk', framesPerDirection: project.characterFramesPerDirection, framesPerSecond: characterFramesPerSecond }
        : undefined,
    }),
    onSuccess: (jobs) => { setFeedback(''); setError(''); onChanged(jobs[0]?.versionId); },
    onError: (reason) => setError(errorMessage(reason)),
  });
  const undoRejection = useMutation({
    mutationFn: () => window.tilemap.assets.undoRejection(version.id),
    onSuccess: () => { setError(''); setRejection(''); onChanged(); },
    onError: (reason) => setError(errorMessage(reason)),
  });
  const undoApproval = useMutation({
    mutationFn: () => window.tilemap.assets.undoApproval(version.id),
    onSuccess: () => { setError(''); onChanged(); },
    onError: (reason) => setError(errorMessage(reason)),
  });
  const nextExpectedSize = assetPixelSize(project, { category, elevationLevels, relativeWidth, relativeHeight });
  const availableCategories = version.category === 'character'
    ? ['character'] as const
    : studioAssetCategoriesForProjection(project.projection);
  const changeCategory = (next: AssetCategory) => {
    if (project.projection === 'top_down' && next === 'elevated_tile') return;
    const defaults = next === version.category
      ? { elevationLevels: version.elevationLevels, relativeWidth: version.relativeWidth, relativeHeight: version.relativeHeight }
      : defaultAssetSizing(next);
    setCategory(next);
    setElevationLevels(defaults.elevationLevels || 1);
    setRelativeWidth(defaults.relativeWidth);
    setRelativeHeight(defaults.relativeHeight);
    if (isTileAssetCategory(next) || isRoadAssetCategory(next)) {
      setFx(1);
      setFy(1);
    }
  };

  return <div className="review-controls">
    <p className="eyebrow">METADANE</p>
    <CharacterFrameCountWarning version={version} expected={project.characterFramesPerDirection} />
    <label>Typ tej wersji<input value={categoryLabels[version.category]} readOnly /></label>
    {version.category === 'road_tile' && <label>Warianty drogi<input value={`${version.roadVariants?.length ?? 0} / 16`} readOnly /></label>}
    {version.category === 'character' && version.characterAnimation && <label>Animacja tej wersji<input value={`Idle + ${formatPolishCount(version.characterAnimation.settings.framesPerDirection, 'klatka', 'klatki', 'klatek')} chodu · ${version.characterAnimation.settings.framesPerSecond} FPS · ${version.characterAnimation.directions.length} kierunki`} readOnly /></label>}
    <label>Tagi AI <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="kamień, droga, mech" /></label>
    {isRelativeSizeCategory(version.category) && <div className="dimension-explainer" role="note">
      <strong>{version.category === 'character' ? 'Klatka animacji' : 'Canvas obrazu'}: {version.relativeWidth}×{version.relativeHeight} tile</strong>
      <span>{version.category === 'character' && version.characterAnimation ? `Arkusz tej wersji zawiera ${version.characterAnimation.settings.framesPerDirection + 1} kolumn i ${version.characterAnimation.directions.length} wiersze kierunków.` : 'To rozmiar PNG.'} Footprint poniżej określa osobno liczbę komórek zajętych na logicznej siatce.</span>
    </div>}
    <div className="form-grid two"><label>Footprint X — zajęte komórki<input type="number" min={1} max={64} value={versionHasFixedFootprint ? 1 : fx} disabled={versionHasFixedFootprint} onChange={(event) => setFx(Number(event.target.value))} /></label><label>Footprint Y — zajęte komórki<input type="number" min={1} max={64} value={versionHasFixedFootprint ? 1 : fy} disabled={versionHasFixedFootprint} onChange={(event) => setFy(Number(event.target.value))} /></label></div>
    {version.imageUrl && <div className="form-grid two"><label>Pivot X (propozycja AI)<input type="number" min={0} max={1} step={0.01} value={px} onChange={(event) => setPx(Number(event.target.value))} /></label><label>Pivot Y (propozycja AI)<input type="number" min={0} max={1} step={0.01} value={py} onChange={(event) => setPy(Number(event.target.value))} /></label></div>}
    {version.status === 'needs_review' && <>
      {anotherVersionApproved && <p className="inline-warning"><AlertTriangle /> Najpierw cofnij zatwierdzenie obecnej wersji. Tylko jedna wersja assetu może być zatwierdzona.</p>}
      {!movementAnalysisPassed && <p className="inline-warning"><AlertTriangle /> Agent musi najpierw zaliczyć analizę ruchu we wszystkich 4 kierunkach. Tej kontroli nie można pominąć.</p>}
      <div className="decision-row"><button className="approve" disabled={review.isPending || anotherVersionApproved || !movementAnalysisPassed} onClick={() => review.mutate('approved')}><Check /> Zatwierdź</button><button className="reject" disabled={review.isPending} onClick={() => review.mutate('rejected')}><X /> Odrzuć</button></div>
      <label className="small-label">Powód odrzucenia (opcjonalny)<input value={rejection} onChange={(event) => setRejection(event.target.value)} /></label>
    </>}
    {version.status === 'approved' && <button className="secondary wide undo-approval" disabled={undoApproval.isPending} onClick={() => undoApproval.mutate()}>
      {undoApproval.isPending ? <LoaderCircle className="spin" /> : <RotateCcw />} Cofnij zatwierdzenie
    </button>}
    {version.status === 'rejected' && <button className="secondary wide undo-rejection" disabled={undoRejection.isPending} onClick={() => undoRejection.mutate()}>
      {undoRejection.isPending ? <LoaderCircle className="spin" /> : <RotateCcw />} Cofnij odrzucenie
    </button>}
    {version.imageUrl && <div className="iteration-box">
      <p className="eyebrow">PARAMETRY KOLEJNEJ ITERACJI</p>
      {version.category === 'character'
        ? <label>Typ assetu<input value={categoryLabels.character} readOnly /></label>
        : <label>Typ assetu<select value={category} onChange={(event) => changeCategory(event.target.value as AssetCategory)}>{availableCategories.map((item) => <option key={item} value={item}>{categoryLabels[item]}</option>)}</select></label>}
      {category === 'road_tile' && <RoadSetSummary projection={project.projection} />}
      {category === 'elevated_tile' && <label>Elevation height (poziomy)<input type="number" min={1} max={16} step={1} value={elevationLevels} onChange={(event) => setElevationLevels(Number(event.target.value))} /></label>}
      {isRelativeSizeCategory(category) && <div className="form-grid two"><label>Szerokość canvasa (× tile)<input type="number" min={0.25} max={16} step={0.25} value={relativeWidth} onChange={(event) => setRelativeWidth(Number(event.target.value))} /></label><label>Wysokość canvasa (× tile)<input type="number" min={0.25} max={16} step={0.25} value={relativeHeight} onChange={(event) => setRelativeHeight(Number(event.target.value))} /></label></div>}
      {category === 'character' && <div className="character-iteration-summary" role="note"><PersonStanding /><div><strong>Idle + {project.characterFramesPerDirection} klatek chodu × 4 kierunki</strong><span>{characterDirectionsForProjection(project.projection).map((direction) => direction.shortLabel).join(' / ')}</span></div><label>Klatki/kierunek<input value={project.characterFramesPerDirection} readOnly /></label><label>FPS<input type="number" min={1} max={24} step={1} value={characterFramesPerSecond} onChange={(event) => setCharacterFramesPerSecond(Number(event.target.value))} /></label></div>}
      {nextExpectedSize && <AssetCanvasSummary size={nextExpectedSize} base={project} detail={category === 'elevated_tile' ? `Elevation ${elevationLevels}` : category === 'road_tile' ? 'Transparentna nakładka 1×1' : category === 'flat_tile' ? project.projection === 'isometric' ? 'Bazowy romb 2:1' : 'Bazowy kwadrat 1:1' : `${relativeWidth}×${relativeHeight} jednostki tile`} />}
      <textarea rows={4} placeholder="Opcjonalnie opisz zmianę. Bez opisu możesz wygenerować nowy wariant." value={feedback} onChange={(event) => setFeedback(event.target.value)} />
      <div><button className="secondary" disabled={feedback.trim().length < 3 || iterate.isPending} onClick={() => iterate.mutate('edit')}><RefreshCw /> Edytuj obraz</button><button className="ghost" disabled={iterate.isPending} onClick={() => iterate.mutate('variant')}><SquareStack /> Przegeneruj</button></div>
    </div>}
    {error && <ErrorBox message={error} />}
  </div>;
}

function StylePanel({ project }: { project: ProjectInfo }) {
  const queryClient = useQueryClient();
  const history = useQuery({ queryKey: ['style'], queryFn: () => window.tilemap.style.history() });
  const [summary, setSummary] = useState(project.styleSummary);
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => setSummary(project.styleSummary), [project.styleSummary]);
  const save = useMutation({
    mutationFn: () => window.tilemap.style.update({ summary }),
    onSuccess: () => { setError(''); void queryClient.invalidateQueries({ queryKey: ['project'] }); void queryClient.invalidateQueries({ queryKey: ['style'] }); },
    onError: (reason) => setError(errorMessage(reason)),
  });
  const rebuild = useMutation({
    mutationFn: () => window.tilemap.style.rebuild(),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['project'] }); void queryClient.invalidateQueries({ queryKey: ['style'] }); },
    onError: (reason) => setError(errorMessage(reason)),
  });
  const restore = useMutation({
    mutationFn: (id: string) => window.tilemap.style.restore(id),
    onSuccess: (revision) => { setSummary(revision.summary); void queryClient.invalidateQueries({ queryKey: ['project'] }); void queryClient.invalidateQueries({ queryKey: ['style'] }); },
  });

  return <aside className="style-panel">
    <div className="style-title"><div><p className="eyebrow">ART DIRECTION</p><h3>DNA stylu</h3></div><button className="icon-button" onClick={() => setShowHistory(!showHistory)} title="Historia"><PanelRight /></button></div>
    {project.styleSummaryStale && <p className="stale-note"><AlertTriangle /> Summary oczekuje na aktualizację</p>}
    <textarea className="style-summary" value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="Summary powstanie po zatwierdzeniu pierwszego assetu. Możesz też wpisać je ręcznie." />
    <div className="style-actions"><button className="secondary" disabled={!summary.trim() || save.isPending || summary === project.styleSummary} onClick={() => save.mutate()}><Save /> Zapisz</button><button className="ghost" disabled={rebuild.isPending} onClick={() => rebuild.mutate()}>{rebuild.isPending ? <LoaderCircle className="spin" /> : <RefreshCw />} Przebuduj AI</button></div>
    {error && <ErrorBox message={error} />}
    {showHistory && <div className="history-list"><p className="eyebrow">HISTORIA</p>{history.data?.map((revision: StyleSummaryRevision) => <button key={revision.id} onClick={() => restore.mutate(revision.id)}><span>{revision.source === 'ai' ? 'AI' : revision.source === 'manual' ? 'Ręcznie' : 'Przywrócono'}</span><small>{formatDate(revision.createdAt)}</small><RotateCcw /></button>)}</div>}
    <div className="brief-box"><p className="eyebrow">BRIEF STARTOWY</p><p>{project.artBrief || 'Nie zdefiniowano.'}</p></div>
    <ProjectSettingsProposalsPanel />
    <ProjectReferencesPanel />
  </aside>;
}

export function ProjectSettingsProposalsPanel() {
  const queryClient = useQueryClient();
  const proposals = useQuery({
    queryKey: ['project-settings-proposals'],
    queryFn: () => window.tilemap.projects.settingsProposals(),
    refetchInterval: 2_000,
  });
  const references = useQuery({ queryKey: ['project-references'], queryFn: () => window.tilemap.references.list() });
  const review = useMutation({
    mutationFn: (input: { proposalId: string; decision: 'approved' | 'rejected' }) => (
      window.tilemap.projects.reviewSettingsProposal(input)
    ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project-settings-proposals'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
    },
  });
  const items = proposals.data ?? [];
  const pendingCount = items.filter((proposal) => proposal.status === 'pending').length;
  const visibleItems = [
    ...items.filter((proposal) => proposal.status === 'pending'),
    ...items.filter((proposal) => proposal.status !== 'pending').slice(0, 3),
  ];
  const referenceNames = new Map((references.data ?? []).map((reference) => [reference.id, reference.name]));

  return <section className="project-setting-proposals">
    <div className="reference-heading"><div><p className="eyebrow">PROJECT SETTINGS</p><strong>Propozycje agenta</strong></div><span>{pendingCount}</span></div>
    <p className="reference-help">Agent może zaproponować korektę ustawień, ale zastosuje ją dopiero po Twojej zgodzie.</p>
    {proposals.isError && <ErrorBox message={errorMessage(proposals.error)} />}
    {review.isError && <ErrorBox message={errorMessage(review.error)} />}
    <div className="setting-proposal-list">
      {visibleItems.map((proposal) => <ProjectSettingsProposalCard
        key={proposal.id}
        proposal={proposal}
        referenceNames={referenceNames}
        busy={review.isPending}
        onReview={(decision) => review.mutate({ proposalId: proposal.id, decision })}
      />)}
      {!proposals.isLoading && !proposals.isError && !items.length && <div className="settings-proposal-empty"><Settings2 /><span>Brak propozycji zmian</span></div>}
    </div>
  </section>;
}

function ProjectSettingsProposalCard({
  proposal,
  referenceNames,
  busy,
  onReview,
}: {
  proposal: ProjectSettingsProposal;
  referenceNames: Map<string, string>;
  busy: boolean;
  onReview: (decision: 'approved' | 'rejected') => void;
}) {
  const changes = projectSettingChanges(proposal);
  const status = proposal.status === 'pending' ? 'OCZEKUJE' : proposal.status === 'approved' ? 'ZASTOSOWANO' : 'ODRZUCONO';
  return <article className={`setting-proposal-card ${proposal.status}`}>
    <div className="setting-proposal-status"><strong>{status}</strong><small>{formatDate(proposal.createdAt)}</small></div>
    <p>{proposal.reason}</p>
    <div className="setting-change-list">{changes.map((change) => <div key={change.label} className={change.long ? 'long' : ''}>
      <strong>{change.label}</strong>
      <span>{change.before}</span><ChevronRight /><b>{change.after}</b>
    </div>)}</div>
    {!!proposal.referenceIds.length && <small className="proposal-references">Referencje: {proposal.referenceIds.map((id) => referenceNames.get(id) ?? id.slice(0, 8)).join(', ')}</small>}
    {proposal.status === 'pending' && <>
      <p className="proposal-warning">Zmiana wpłynie na kolejne generacje i eksport. Istniejące PNG nie zostaną przeskalowane.</p>
      <div className="setting-proposal-actions"><button className="approve" disabled={busy} onClick={() => onReview('approved')}><Check /> Zastosuj</button><button className="reject" disabled={busy} onClick={() => onReview('rejected')}><X /> Odrzuć</button></div>
    </>}
  </article>;
}

function projectSettingChanges(proposal: ProjectSettingsProposal): Array<{ label: string; before: string; after: string; long?: boolean }> {
  const changes: Array<{ label: string; before: string; after: string; long?: boolean }> = [];
  if (proposal.proposed.artBrief !== undefined) changes.push({ label: 'Brief', before: `Obecnie: ${proposal.before.artBrief || '(pusty)'}`, after: `Propozycja: ${proposal.proposed.artBrief || '(pusty)'}`, long: true });
  if (proposal.proposed.tileWidthPx !== undefined) changes.push({ label: 'Szerokość tile', before: `${proposal.before.tileWidthPx}px`, after: `${proposal.proposed.tileWidthPx}px` });
  if (proposal.proposed.pixelsPerUnit !== undefined) changes.push({ label: 'PPU', before: String(proposal.before.pixelsPerUnit), after: String(proposal.proposed.pixelsPerUnit) });
  if (proposal.proposed.codexGenerationEnabled !== undefined) changes.push({ label: 'Codex', before: proposal.before.codexGenerationEnabled ? 'włączony' : 'wyłączony', after: proposal.proposed.codexGenerationEnabled ? 'włączony' : 'wyłączony' });
  if (proposal.proposed.comfyUiEnabled !== undefined) changes.push({ label: 'ComfyUI', before: proposal.before.comfyUiEnabled ? 'włączone' : 'wyłączone', after: proposal.proposed.comfyUiEnabled ? 'włączone' : 'wyłączone' });
  if (proposal.proposed.stableDiffusionCppEnabled !== undefined) changes.push({ label: 'stable-diffusion.cpp', before: proposal.before.stableDiffusionCppEnabled ? 'włączone' : 'wyłączone', after: proposal.proposed.stableDiffusionCppEnabled ? 'włączone' : 'wyłączone' });
  if (proposal.proposed.comfyUiProfile !== undefined) changes.push({ label: 'Profil ComfyUI', before: proposal.before.comfyUiProfile ?? 'z_image_turbo', after: String(proposal.proposed.comfyUiProfile) });
  return changes;
}

export function ProjectReferencesPanel() {
  const queryClient = useQueryClient();
  const references = useQuery({ queryKey: ['project-references'], queryFn: () => window.tilemap.references.list() });
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const add = useMutation({
    mutationFn: () => window.tilemap.references.add({ description }),
    onSuccess: (reference) => {
      if (reference) {
        setDescription('');
        void queryClient.invalidateQueries({ queryKey: ['project-references'] });
      }
      setError('');
    },
    onError: (reason) => setError(errorMessage(reason)),
  });
  return <section className="project-references">
    <div className="reference-heading"><div><p className="eyebrow">REFERENCE IMAGES</p><strong>Obrazy referencyjne</strong></div><span>{references.data?.length ?? 0}</span></div>
    <p className="reference-help">Agent widzi opisy i może selektywnie pobrać obraz podczas generacji.</p>
    <label>Opis nowej referencji<textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Np. wzór palety, miękkich krawędzi i faktury piasku…" /></label>
    <button className="secondary wide" disabled={description.trim().length < 3 || add.isPending} onClick={() => add.mutate()}>
      {add.isPending ? <LoaderCircle className="spin" /> : <ImagePlus />} Dodaj obraz
    </button>
    {references.isError && <ErrorBox message={errorMessage(references.error)} />}
    {error && <ErrorBox message={error} />}
    <div className="reference-list">
      {references.data?.map((reference) => <ProjectReferenceCard key={reference.id} reference={reference} />)}
      {!references.isLoading && !references.isError && !references.data?.length && <div className="reference-empty"><ImagePlus /><span>Brak referencji projektu</span></div>}
    </div>
  </section>;
}

function ProjectReferenceCard({ reference }: { reference: ProjectReference }) {
  const queryClient = useQueryClient();
  const [description, setDescription] = useState(reference.description);
  const [error, setError] = useState('');
  useEffect(() => setDescription(reference.description), [reference.description]);
  const update = useMutation({
    mutationFn: () => window.tilemap.references.update({ referenceId: reference.id, description }),
    onSuccess: () => { setError(''); void queryClient.invalidateQueries({ queryKey: ['project-references'] }); },
    onError: (reason) => setError(errorMessage(reason)),
  });
  const remove = useMutation({
    mutationFn: () => window.tilemap.references.remove(reference.id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['project-references'] }),
    onError: (reason) => setError(errorMessage(reason)),
  });
  return <article className="reference-card">
    <div className="reference-image"><img src={reference.imageUrl} alt={reference.name} /></div>
    <div className="reference-card-title"><div><strong>{reference.name}</strong><small>{reference.width}×{reference.height}px</small></div><button className="icon-button" title="Odepnij referencję" disabled={remove.isPending} onClick={() => {
      if (confirm(`Odpiąć referencję „${reference.name}”? Oryginalny plik nie zostanie usunięty.`)) remove.mutate();
    }}><X /></button></div>
    <textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} aria-label={`Opis referencji ${reference.name}`} />
    <button className="ghost reference-save" disabled={description.trim().length < 3 || description.trim() === reference.description || update.isPending} onClick={() => update.mutate()}>
      {update.isPending ? <LoaderCircle className="spin" /> : <Save />} Zapisz opis
    </button>
    {error && <ErrorBox message={error} />}
  </article>;
}

function ExportView({ project, assets }: { project: ProjectInfo; assets: AssetSummary[] }) {
  const queryClient = useQueryClient();
  const integrations = useQuery({
    queryKey: ['export-integrations'],
    queryFn: () => window.tilemap.export.listIntegrations(),
  });
  const [selectedIntegration, setSelectedIntegration] = useState<ExportIntegration>('unity');
  const [targets, setTargets] = useState<ProjectInfo['exportTargets']>(project.exportTargets);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [error, setError] = useState('');
  const approvedCount = assets.filter((asset) => asset.currentApprovedVersionId).length;
  const target = targets[selectedIntegration] ?? '';
  const selectedDescriptor = integrations.data?.find((integration) => integration.id === selectedIntegration);

  useEffect(() => setTargets(project.exportTargets), [project.exportTargets]);

  const choose = useMutation({
    mutationFn: (integration: ExportIntegration) => window.tilemap.export.chooseTarget(integration),
    onSuccess: (path, integration) => {
      if (path) {
        setTargets((current) => ({ ...current, [integration]: path }));
        setPreview(null);
        setError('');
      }
    },
    onError: (reason) => setError(errorMessage(reason)),
  });
  const makePreview = useMutation({
    mutationFn: () => window.tilemap.export.preview({ integration: selectedIntegration, targetDirectory: target }),
    onSuccess: (value) => { setPreview(value); setError(''); },
    onError: (reason) => setError(errorMessage(reason)),
  });
  const run = useMutation({
    mutationFn: () => window.tilemap.export.run(preview!.token),
    onSuccess: (result) => {
      setError('');
      queryClient.setQueryData<ProjectInfo>(['project'], (current) => current ? {
        ...current,
        exportTargets: { ...current.exportTargets, [preview!.integration]: preview!.targetDirectory },
      } : current);
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      alert(`${selectedDescriptor?.label ?? 'Integracja'}: wyeksportowano ${formatPolishCount(result.assetCount, 'zatwierdzony asset', 'zatwierdzone assety', 'zatwierdzonych assetów')}.\nZmienione pliki: ${result.writtenFileCount}/${result.fileCount}.\n${result.manifestPath}`);
      setPreview(null);
    },
    onError: (reason) => setError(errorMessage(reason)),
  });

  return <div className="export-page">
    <div className="section-heading"><div><p className="eyebrow">EKSPORT</p><h2>Integracje eksportu</h2><p>Wybierz format i miejsce docelowe. Plan synchronizuje zatwierdzone wersje i może usunąć wyłącznie nieaktualne pliki zarządzane przez aplikację.</p></div><div className="approved-counter"><strong>{approvedCount}</strong><span>zatwierdzonych</span></div></div>
    <div className="integration-list" role="list" aria-label="Dostępne integracje eksportu">
      {integrations.data?.map((integration) => <button
        key={integration.id}
        type="button"
        data-integration={integration.id}
        className={`integration-card ${selectedIntegration === integration.id ? 'active' : ''}`}
        aria-pressed={selectedIntegration === integration.id}
        disabled={choose.isPending || makePreview.isPending || run.isPending}
        onClick={() => {
          if (selectedIntegration === integration.id) return;
          setSelectedIntegration(integration.id);
          setPreview(null);
          setError('');
        }}
      >
        <span>{integration.id === 'phaser' ? <Gamepad2 /> : <Box />}</span>
        <div><strong>{integration.label}</strong><small>{integration.description}</small></div>
        {selectedIntegration === integration.id && <Check />}
      </button>)}
      {integrations.isLoading && <div className="integration-loading"><LoaderCircle className="spin" /> Wczytywanie integracji…</div>}
    </div>
    {selectedDescriptor && <section className="integration-settings" aria-label={`Ustawienia integracji ${selectedDescriptor.label}`}>
      <div className="integration-settings-heading"><div><p className="eyebrow">{selectedDescriptor.label.toLocaleUpperCase('pl-PL')}</p><h3>Miejsce eksportu</h3></div><span>{formatPolishCount(preview?.assetCount ?? approvedCount, 'asset', 'assety', 'assetów')}</span></div>
      <p className="integration-target-help">{selectedIntegration === 'unity'
        ? <>Wybierz dokładne miejsce wewnątrz katalogu <code>Assets</code> projektu Unity. Trafią tam zatwierdzone pliki i manifest. Narzędzia Unity są instalowane raz, osobno w <code>Assets/TilemapGeneratorIntegration</code>.</>
        : selectedIntegration === 'phaser'
          ? <>Wybierz dokładny katalog docelowy używany przez grę Phaser. Trafią tam wyłącznie zatwierdzone assety oraz natywny manifest Phaser File Pack <code>tilemap-assets.phaser.json</code>.</>
        : <>Wybierz dokładny katalog docelowy integracji {selectedDescriptor.label}. Trafią tam wyłącznie zatwierdzone assety.</>}</p>
      <div className="export-target"><FolderOpen /><div><small>{selectedDescriptor.targetLabel}</small><strong title={target}>{target || 'Nie wybrano'}</strong></div><button className="secondary" type="button" disabled={choose.isPending || makePreview.isPending || run.isPending} onClick={() => choose.mutate(selectedIntegration)}>{choose.isPending ? <LoaderCircle className="spin" /> : <FolderOpen />} Wybierz miejsce eksportu</button></div>
      <button className="primary" disabled={!target || choose.isPending || makePreview.isPending || run.isPending} onClick={() => makePreview.mutate()}>{makePreview.isPending ? <LoaderCircle className="spin" /> : <Play />} Przygotuj podgląd</button>
    </section>}
    {preview && <div className="export-preview"><div className="preview-heading"><h3>Plan eksportu</h3><span>{formatPolishCount(preview.assetCount, 'asset', 'assety', 'assetów')} · {formatPolishCount(preview.files.length, 'plik', 'pliki', 'plików')}</span></div>{preview.files.map((file) => <div key={`${file.destinationPath}-${file.variantMask ?? 'main'}`} className="export-file"><span className={`action ${file.action}`}>{file.action === 'create' ? 'NOWY' : file.action === 'replace' ? 'ZAMIANA' : file.action === 'delete' ? 'USUNIĘCIE' : 'BEZ ZMIAN'}</span><strong>{file.destinationPath}</strong></div>)}<div className="manifest-row"><Archive /><span>{preview.manifestPath}</span></div><button className="approve wide" disabled={choose.isPending || makePreview.isPending || run.isPending} onClick={() => run.mutate()}>{run.isPending ? <LoaderCircle className="spin" /> : <Download />} Eksportuj przez {selectedDescriptor?.label ?? preview.integration}</button></div>}
    {integrations.error && <ErrorBox message={errorMessage(integrations.error)} />}
    {error && <ErrorBox message={error} />}
  </div>;
}

function DiagnosticsView({
  codexHealth,
  comfyHealth,
  stableDiffusionCppHealth,
}: {
  codexHealth?: CodexHealth;
  comfyHealth?: ComfyUiHealth;
  stableDiffusionCppHealth?: StableDiffusionCppHealth;
}) {
  const queryClient = useQueryClient();
  const refresh = useMutation({
    mutationFn: () => Promise.all([
      window.tilemap.codex.refresh(),
      window.tilemap.comfy.refresh(),
      window.tilemap.stableDiffusionCpp.refresh(),
    ]),
    onSuccess: ([codex, comfy, stableDiffusionCpp]) => {
      queryClient.setQueryData(['codex-health'], codex);
      queryClient.setQueryData(['comfy-health'], comfy);
      queryClient.setQueryData(['stable-diffusion-cpp-health'], stableDiffusionCpp);
    },
  });
  const checks = [
    ['Codex CLI', Boolean(codexHealth?.version), codexHealth?.version ?? 'Nie wykryto'],
    ['Codex App Server', Boolean(codexHealth?.appServer), codexHealth?.appServer ? 'Połączony' : 'Niedostępny'],
    ['Codex imagegen', Boolean(codexHealth?.imageGeneration && codexHealth?.imagegenSkill), codexHealth?.skillPath ?? 'Niedostępny'],
    ['Comfy Desktop', Boolean(comfyHealth?.installed), comfyHealth?.installed ? 'Wykryty' : 'Nie wykryto'],
    ['ComfyUI API', Boolean(comfyHealth?.server), comfyHealth?.server ? comfyHealth.endpoint : `${comfyHealth?.endpoint ?? '127.0.0.1:8188'} · offline`],
    ['ComfyUI Z-Image Turbo', comfyHealth?.state === 'ready', comfyHealth?.state === 'ready' ? comfyHealth.model : [...(comfyHealth?.missingModels ?? []), ...(comfyHealth?.missingNodes ?? [])].join(', ') || 'Niegotowy'],
    ['stable-diffusion.cpp CLI', Boolean(stableDiffusionCppHealth?.installed), stableDiffusionCppHealth?.executablePath ?? 'Nie wykryto sd-cli'],
    ['stable-diffusion.cpp Z-Image Turbo', stableDiffusionCppHealth?.state === 'ready', stableDiffusionCppHealth?.state === 'ready' ? stableDiffusionCppHealth.model : stableDiffusionCppHealth?.missingFiles.join(', ') || 'Niegotowy'],
    ['Log aplikacji', Boolean(codexHealth?.logPath), codexHealth?.logPath ?? 'Niedostępny'],
  ] as const;
  return <div className="diagnostics-page"><div className="section-heading"><div><p className="eyebrow">SYSTEM</p><h2>Diagnostyka generatorów</h2><p>Każdy włączony generator musi przejść własne kontrole gotowości.</p></div><button className="secondary" disabled={refresh.isPending} onClick={() => refresh.mutate()}><RefreshCw className={refresh.isPending ? 'spin' : ''} /> Sprawdź ponownie</button></div><div className="diagnostic-grid">{checks.map(([name, ok, detail]) => <div key={name} className={ok ? 'ok' : 'bad'}><span>{ok ? <Check /> : <X />}</span><div><strong>{name}</strong><small>{detail}</small></div></div>)}</div><div className="diagnostic-message"><CircleDot /><span>{codexHealth?.message ?? 'Codex: sprawdzanie…'}<br />{comfyHealth?.message ?? 'ComfyUI: sprawdzanie…'}<br />{stableDiffusionCppHealth?.message ?? 'stable-diffusion.cpp: sprawdzanie…'}</span></div><AppUpdatePanel /></div>;
}

export function AppUpdatePanel() {
  const queryClient = useQueryClient();
  const update = useQuery({
    queryKey: ['app-update'],
    queryFn: () => window.tilemap.updates.status(),
    staleTime: Infinity,
  });
  useEffect(() => window.tilemap.updates.onState((state) => {
    queryClient.setQueryData(['app-update'], state);
  }), [queryClient]);
  const check = useMutation({
    mutationFn: () => window.tilemap.updates.check(),
    onSuccess: (state) => queryClient.setQueryData(['app-update'], state),
  });
  const install = useMutation({ mutationFn: () => window.tilemap.updates.install() });
  const state = update.data;

  if (!state) return <section className="app-update-panel loading"><LoaderCircle className="spin" /> Sprawdzanie konfiguracji aktualizacji…</section>;

  const busy = ['checking', 'downloading', 'installing'].includes(state.status);
  return <section className={`app-update-panel ${state.status}`} aria-label="Aktualizacje aplikacji">
    <div className="app-update-heading">
      <span>{updateStatusIcon(state)}</span>
      <div><p className="eyebrow">APLIKACJA</p><h3>Aktualizacje macOS</h3></div>
      <div className="app-update-version"><strong>v{state.currentVersion}</strong><small>{state.channel === 'beta' ? 'BETA' : 'STABLE'} · {state.architecture}</small></div>
    </div>
    <div className="app-update-status" role={state.status === 'error' ? 'alert' : 'status'}>
      <strong>{updateStatusLabel(state)}</strong>
      <span>{state.message}</span>
      {state.availableVersion && <small>{state.availableVersion}{state.releaseDate ? ` · ${formatDate(state.releaseDate)}` : ''}</small>}
      {state.releaseNotes && <p>{state.releaseNotes}</p>}
      {state.checkedAt && <small>Ostatnie sprawdzenie: {formatDate(state.checkedAt)}</small>}
    </div>
    <div className="app-update-actions">
      {state.status === 'downloaded'
        ? <button className="primary" type="button" disabled={install.isPending} onClick={() => install.mutate()}>{install.isPending ? <LoaderCircle className="spin" /> : <RotateCcw />} Uruchom ponownie i zainstaluj</button>
        : <button className="secondary" type="button" disabled={!state.enabled || busy || check.isPending} onClick={() => check.mutate()}>{busy || check.isPending ? <LoaderCircle className="spin" /> : <RefreshCw />} Sprawdź aktualizacje</button>}
    </div>
    {install.error && <ErrorBox message={errorMessage(install.error)} />}
  </section>;
}

function updateStatusIcon(state: AppUpdateState) {
  if (['checking', 'downloading', 'installing'].includes(state.status)) return <LoaderCircle className="spin" />;
  if (state.status === 'downloaded') return <Download />;
  if (state.status === 'up-to-date') return <Check />;
  if (state.status === 'error') return <AlertTriangle />;
  return <CircleDot />;
}

function updateStatusLabel(state: AppUpdateState): string {
  switch (state.status) {
    case 'disabled': return 'Updater wyłączony';
    case 'idle': return 'Gotowy';
    case 'checking': return 'Sprawdzanie';
    case 'downloading': return 'Pobieranie';
    case 'up-to-date': return 'Aktualna wersja';
    case 'downloaded': return 'Gotowa do instalacji';
    case 'installing': return 'Instalowanie';
    case 'error': return 'Błąd aktualizacji';
  }
}

function QueueBar({ jobs }: { jobs: Awaited<ReturnType<typeof window.tilemap.generation.jobs>> }) {
  const queryClient = useQueryClient();
  const active = jobs.filter((job) => ['queued', 'generating'].includes(job.status));
  const latestJob = jobs[0];
  const retryable = latestJob && ['failed', 'cancelled', 'interrupted'].includes(latestJob.status) ? latestJob : undefined;
  const retry = useMutation({
    mutationFn: (id: string) => window.tilemap.generation.retry(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['assets'] });
    },
  });
  const cancel = useMutation({ mutationFn: (id: string) => window.tilemap.generation.cancel(id), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['jobs'] }) });
  if (!active.length && !retryable) return null;
  return <div className="queue-bar">
    <div className="queue-title">{active.length ? <LoaderCircle className="spin" /> : <AlertTriangle />}<strong>{active.length ? 'Kolejka generacji' : 'Generacja nieudana'}</strong>{active.length > 0 && <span>{active.length}</span>}</div>
    {active.slice(0, 3).map((job) => <div className="queue-job" key={job.id}><StatusBadge status={job.status} /><span>{job.progress}</span><button className="icon-button" onClick={() => cancel.mutate(job.id)}><X /></button></div>)}
    {!active.length && retryable && <div className="queue-job failed-job"><StatusBadge status={retryable.status} /><span title={retryable.error}>{retryable.error || retryable.progress}</span></div>}
    {retryable && <button className="secondary" disabled={retry.isPending} onClick={() => retry.mutate(retryable.id)}>{retry.isPending ? <LoaderCircle className="spin" /> : <RefreshCw />} Ponów generację</button>}
  </div>;
}

function StatusBadge({
  status,
  large = false,
  onClick,
  buttonRef,
}: {
  status: VersionStatus;
  large?: boolean;
  onClick?: () => void;
  buttonRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const className = `status status-${status} ${large ? 'large' : ''} ${onClick ? 'status-button' : ''}`;
  if (onClick) {
    return <button ref={buttonRef} type="button" className={className} aria-haspopup="dialog" aria-label={`${statusLabels[status]} — pokaż szczegóły`} onClick={onClick}><i />{statusLabels[status]}</button>;
  }
  return <span className={className}><i />{statusLabels[status]}</span>;
}

function HealthPill({ health }: { health?: CodexHealth }) {
  const ready = health?.state === 'ready';
  return <span className={`health-pill ${ready ? 'ready' : ''}`} title={health?.message}><i />{ready ? 'Codex online' : health?.state === 'checking' ? 'Sprawdzanie' : 'Codex offline'}</span>;
}

function ComfyHealthPill({ health }: { health?: ComfyUiHealth }) {
  const ready = health?.state === 'ready';
  const detected = health?.state === 'detected';
  return <span className={`health-pill ${ready ? 'ready' : ''} ${detected ? 'detected' : ''}`} title={health?.message}><i />{ready ? 'Comfy online' : detected ? 'Comfy wykryte' : health?.state === 'checking' ? 'Sprawdzanie' : 'Comfy offline'}</span>;
}

function StableDiffusionCppHealthPill({ health }: { health?: StableDiffusionCppHealth }) {
  const ready = health?.state === 'ready';
  const detected = health?.state === 'detected';
  return <span className={`health-pill ${ready ? 'ready' : ''} ${detected ? 'detected' : ''}`} title={health?.message}><i />{ready ? 'SD.cpp online' : detected ? 'SD.cpp wykryte' : health?.state === 'checking' ? 'Sprawdzanie' : 'SD.cpp offline'}</span>;
}

function ErrorBox({ message }: { message: string }) {
  return <div className="error-box"><AlertTriangle /><span className="error-box-copy">{message}</span></div>;
}

function ErrorDetailsModal({
  message,
  onClose,
  returnFocusRef,
}: {
  message: string;
  onClose: () => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      returnFocusRef.current?.focus();
    };
  }, [onClose, returnFocusRef]);

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="error-modal" role="dialog" aria-modal="true" aria-labelledby="error-modal-title" aria-describedby="error-modal-message">
      <div className="error-modal-heading">
        <div><p className="eyebrow">GENERACJA NIEUDANA</p><h3 id="error-modal-title">Szczegóły błędu</h3></div>
        <button ref={closeButtonRef} type="button" className="icon-button" aria-label="Zamknij szczegóły błędu" onClick={onClose}><X /></button>
      </div>
      <div className="error-modal-message"><AlertTriangle /><p id="error-modal-message">{message}</p></div>
      <div className="error-modal-footer"><button type="button" className="secondary" onClick={onClose}>Zamknij</button></div>
    </section>
  </div>;
}

function FullScreenLoader({ label, compact = false }: { label: string; compact?: boolean }) { return <div className={compact ? 'loader compact' : 'loader'}><LoaderCircle className="spin" /><span>{label}</span></div>; }

function errorMessage(reason: unknown): string {
  const message = reason instanceof Error
    ? reason.message.replace(/^Error invoking remote method '[^']+': /, '')
    : String(reason);
  if (/No handler registered for/i.test(message)) {
    return 'Proces główny aplikacji jest w starszej wersji. Zamknij całkowicie Tilemap Generator i uruchom go ponownie.';
  }
  return message;
}
function formatPolishCount(value: number, singular: string, few: string, many: string): string {
  const absolute = Math.abs(value);
  const lastDigit = absolute % 10;
  const lastTwoDigits = absolute % 100;
  const form = absolute === 1
    ? singular
    : lastDigit >= 2 && lastDigit <= 4 && (lastTwoDigits < 12 || lastTwoDigits > 14)
      ? few
      : many;
  return `${value} ${form}`;
}
function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value >= 1024 ** 3) return `${(value / (1024 ** 3)).toFixed(1).replace('.', ',')} GB`;
  if (value >= 1024 ** 2) return `${Math.round(value / (1024 ** 2))} MB`;
  return `${Math.round(value / 1024)} KB`;
}
function formatDate(value: string): string { return new Intl.DateTimeFormat('pl-PL', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)); }
function formatLogTime(value: string): string { return new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)); }
