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
  ImagePlus,
  Layers3,
  LoaderCircle,
  PanelRight,
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
  ExportPreview,
  GenerationJob,
  GenerationLogEntry,
  GenerationMode,
  ProjectInfo,
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
import {
  assetCategories,
  assetPixelSize,
  defaultAssetSizing,
  isRelativeSizeCategory,
  isTileAssetCategory,
  roadVariantLabel,
} from '../../shared/domain';

type View = 'project' | 'generate' | 'export' | 'diagnostics';

const categoryLabels: Record<AssetCategory, string> = {
  road_tile: 'Road tile',
  flat_tile: 'Flat terrain', elevated_tile: 'Elevated terrain', building: 'Budynek', character: 'Postać', vegetation: 'Roślinność',
  prop: 'Obiekt', effect: 'Efekt', ui: 'UI', other: 'Inne',
};

const statusLabels: Record<VersionStatus, string> = {
  queued: 'W kolejce', generating: 'Generowanie', needs_review: 'Do weryfikacji', approved: 'Zatwierdzony',
  rejected: 'Odrzucony', failed: 'Błąd', cancelled: 'Anulowany', interrupted: 'Przerwany',
};

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
      onSelectAsset={(id) => { setSelectedAssetId(id); setView('generate'); }}
      onNewAsset={() => { setSelectedAssetId(null); setView('generate'); }}
      view={view}
      onView={(next) => { setView(next); if (next !== 'generate') setSelectedAssetId(null); }}
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
  const [width, setWidth] = useState(256);
  const [error, setError] = useState('');
  const recents = useQuery({ queryKey: ['recents'], queryFn: () => window.tilemap.projects.recents() });
  const create = useMutation({
    mutationFn: () => window.tilemap.projects.create({
      name,
      artBrief,
      tileWidthPx: width,
    }),
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
        <p className="lede">Lokalne studio generowania izometrycznych assetów. Codex i ComfyUI tworzą warianty, Ty wybierasz preferowany, registry pilnuje historii.</p>
        <div className="feature-line"><Sparkles size={17} /> Codex + imagegen oraz ComfyUI</div>
        <div className="feature-line"><Archive size={17} /> Pełna historia, bez kasowania odrzuceń</div>
        <div className="feature-line"><Download size={17} /> Eksport gotowy dla Unity</div>
      </section>
      <section className="welcome-card">
        <div className="card-heading">
          <div><p className="eyebrow">NOWY PROJEKT</p><h2>Zdefiniuj siatkę</h2></div>
          <button className="icon-button" title="Otwórz istniejący projekt" onClick={() => open.mutate()}><FolderOpen /></button>
        </div>
        <label>Nazwa projektu<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Kierunek artystyczny<textarea rows={4} placeholder="Np. ręcznie malowane kamienie, ciepłe światło, czytelne sylwetki…" value={artBrief} onChange={(event) => setArtBrief(event.target.value)} /></label>
        <div className="form-grid two">
          <label>Bazowa szerokość tile (px)<input type="number" min={16} max={4096} step={2} value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label>
          <label>Wysokość 2:1<input value={`${width / 2}px`} readOnly /></label>
        </div>
        {width % 2 !== 0 && <p className="inline-warning"><AlertTriangle size={15} /> Bazowa szerokość musi być parzysta, aby wysokość 2:1 była całkowita.</p>}
        {error && <ErrorBox message={error} />}
        <button className="primary wide" disabled={create.isPending || name.trim().length < 2 || width % 2 !== 0} onClick={() => create.mutate()}>
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
  onSelectAsset: (id: string) => void;
  onNewAsset: () => void;
  view: View;
  onView: (view: View) => void;
  onClose: () => void;
}) {
  const assets = useQuery({ queryKey: ['assets'], queryFn: () => window.tilemap.assets.list(), refetchInterval: 5_000 });
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: () => window.tilemap.generation.jobs(), refetchInterval: 2_000 });
  const health = useQuery({ queryKey: ['codex-health'], queryFn: () => window.tilemap.codex.health(), refetchInterval: 10_000 });
  const comfyHealth = useQuery({ queryKey: ['comfy-health'], queryFn: () => window.tilemap.comfy.health(), refetchInterval: 10_000 });
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
        <button className={`project-title ${props.view === 'project' ? 'active' : ''}`} aria-label={`Strona główna projektu ${props.project.name}`} onClick={() => props.onView('project')}><div className="brand-mark small"><Layers3 size={20} /></div><div><strong>{props.project.name}</strong><span>baza {props.project.tileWidthPx}×{props.project.tileHeightPx}px · 2:1</span></div><ChevronRight /></button>
        <nav>
          <button className={props.view === 'generate' ? 'active' : ''} onClick={() => props.onView('generate')}><Sparkles /> Studio</button>
          <button className={props.view === 'export' ? 'active' : ''} onClick={() => props.onView('export')}><Download /> Eksport</button>
          <button className={props.view === 'diagnostics' ? 'active' : ''} onClick={() => props.onView('diagnostics')}><Settings2 /> Diagnostyka</button>
        </nav>
        <div className="top-actions"><HealthPill health={health.data} /><ComfyHealthPill health={comfyHealth.data} /><StableDiffusionCppHealthPill health={stableDiffusionCppHealth.data} /><button className="ghost" onClick={props.onClose}><X /> Zamknij</button></div>
      </header>
      <div className="workspace-grid">
        <aside className="asset-sidebar">
          <button className="new-asset" onClick={props.onNewAsset}><ImagePlus /> Nowy asset</button>
          <div className="search-box"><Search size={16} /><input placeholder="Szukaj po nazwie lub tagu" value={filter} onChange={(event) => setFilter(event.target.value)} /></div>
          <div className="sidebar-label"><span>REGISTRY</span><small>{assets.data?.length ?? 0}</small></div>
          <div className="asset-list">
            {visibleAssets.map((asset) => <AssetListItem key={asset.id} asset={asset} active={props.selectedAssetId === asset.id} onClick={() => props.onSelectAsset(asset.id)} />)}
            {!visibleAssets.length && <div className="empty-compact"><SquareStack /><span>Brak assetów</span></div>}
          </div>
        </aside>
        <section className={`content-area ${props.view === 'generate' && props.selectedAssetId ? 'asset-review-content' : ''}`}>
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
          {props.view === 'export' && <ExportView project={props.project} assets={assets.data ?? []} />}
          {props.view === 'diagnostics' && <DiagnosticsView codexHealth={health.data} comfyHealth={comfyHealth.data} stableDiffusionCppHealth={stableDiffusionCppHealth.data} />}
        </section>
        {props.view === 'generate' && props.selectedAssetId
          ? <AssetAttemptsSidebar
            assetId={props.selectedAssetId}
            selectedVersionId={selectedVersionId}
            onSelectVersion={setSelectedVersionId}
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
    || aiVerificationEnabled !== project.aiVerificationEnabled
    || codexGenerationEnabled !== (project.codexGenerationEnabled ?? true)
    || comfyUiEnabled !== (project.comfyUiEnabled ?? false)
    || stableDiffusionCppEnabled !== (project.stableDiffusionCppEnabled ?? false);
  const valid = name.trim().length >= 2
    && tileWidth >= 16
    && tileWidth % 2 === 0
    && pixelsPerUnit >= 1
    && maxConcurrentJobs >= 1
    && maxConcurrentJobs <= 8
    && (codexGenerationEnabled || comfyUiEnabled || stableDiffusionCppEnabled);
  const tileHeight = tileWidth / 2;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid && dirty) save.mutate();
  };

  return <div className="project-page">
    <div className="section-heading">
      <div><p className="eyebrow">PROJEKT</p><h2>{project.name}</h2><p>Projekt ustala bazową jednostkę 2:1. Typ i skala należą do każdego assetu.</p></div>
      <div className="project-geometry-summary"><span><Layers3 /></span><div><strong>Bazowy tile</strong><small>{tileWidth}×{tileHeight}px · 2:1</small></div></div>
    </div>
    <form className="project-settings-card" onSubmit={submit}>
      <div className="settings-section-heading"><div><p className="eyebrow">USTAWIENIA</p><h3>Bazowa jednostka projektu</h3></div><Settings2 /></div>
      <label>Nazwa projektu<input value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Kierunek artystyczny<textarea rows={5} value={artBrief} onChange={(event) => setArtBrief(event.target.value)} placeholder="Paleta, materiały, oświetlenie i reguły stylu projektu…" /></label>
      <div className="form-grid three">
        <label>Bazowa szerokość tile (px)<input type="number" min={16} max={4096} step={2} value={tileWidth} onChange={(event) => setTileWidth(Number(event.target.value))} /></label>
        <label>Wysokość rombu 2:1<input value={`${tileHeight}px`} readOnly /></label>
        <label>Pixels per unit<input type="number" min={1} max={4096} value={pixelsPerUnit} onChange={(event) => setPixelsPerUnit(Number(event.target.value))} /></label>
      </div>
      <div className="queue-concurrency-setting">
        <label>Maks. jednoczesnych zadań<input type="number" min={1} max={8} step={1} value={maxConcurrentJobs} onChange={(event) => setMaxConcurrentJobs(Number(event.target.value))} /></label>
        <p>Określa, ile różnych assetów kolejka może generować równolegle. Zmniejszenie limitu nie przerywa już uruchomionych zadań.</p>
        <label className="ai-verification-toggle">
          <input type="checkbox" checked={aiVerificationEnabled} onChange={(event) => setAiVerificationEnabled(event.target.checked)} />
          <span><strong>Weryfikacja AI po generowaniu</strong><small>Codex ogląda wynik i może wykonać automatyczną korektę. Po wyłączeniu gotowy asset można sprawdzić później przyciskiem Weryfikacja. Kontrole techniczne PNG pozostają aktywne.</small></span>
        </label>
        <div className="generator-settings">
          <p><strong>Generatory wariantów</strong><small>Każdy aktywny generator tworzy osobną wersję tego samego assetu.</small></p>
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
      {tileWidth % 2 !== 0 && <p className="inline-warning"><AlertTriangle /> Bazowa szerokość musi być parzysta.</p>}
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

function AssetListItem({ asset, active, onClick }: { asset: AssetSummary; active: boolean; onClick: () => void }) {
  const version = asset.latestVersion;
  const category = version?.category ?? asset.category;
  const relativeWidth = version?.relativeWidth ?? asset.relativeWidth;
  const relativeHeight = version?.relativeHeight ?? asset.relativeHeight;
  const dimensionSummary = isRelativeSizeCategory(category)
    ? ` · obraz ${relativeWidth}×${relativeHeight}${version ? ` · siatka ${version.footprint.x}×${version.footprint.y}` : ''}`
    : '';
  return <button className={`asset-row ${active ? 'active' : ''}`} onClick={onClick}>
    <div className="asset-thumb">{version?.imageUrl ? <img src={version.imageUrl} alt="" /> : <Box />}</div>
    <div className="asset-row-copy"><strong>{asset.name}</strong><span>{categoryLabels[category]}{category === 'elevated_tile' ? ` · h${version?.elevationLevels ?? asset.elevationLevels}` : ''}{dimensionSummary} · {asset.versionCount} wer.</span><StatusBadge status={version?.status ?? 'queued'} /></div>
    <ChevronRight size={16} />
  </button>;
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
  const [error, setError] = useState('');
  const mutation = useMutation({
    mutationFn: () => window.tilemap.generation.enqueue({
      name,
      prompt,
      mode: 'generate',
      category,
      elevationLevels: category === 'elevated_tile' ? elevationLevels : undefined,
      relativeWidth: isRelativeSizeCategory(category) ? relativeWidth : undefined,
      relativeHeight: isRelativeSizeCategory(category) ? relativeHeight : undefined,
      footprint: category === 'road_tile' ? { x: 1, y: 1 } : { x: footprintX, y: footprintY },
    }),
    onSuccess: () => {
      setName(''); setPrompt(''); setError('');
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['assets'] });
    },
    onError: (reason) => setError(errorMessage(reason)),
  });
  const codexEnabled = project.codexGenerationEnabled ?? true;
  const comfyEnabled = project.comfyUiEnabled ?? false;
  const stableDiffusionCppEnabled = project.stableDiffusionCppEnabled ?? false;
  const codexReady = !codexEnabled || codexHealth?.state === 'ready';
  const comfyReady = !comfyEnabled || comfyHealth?.state === 'ready';
  const stableDiffusionCppReady = !stableDiffusionCppEnabled || stableDiffusionCppHealth?.state === 'ready';
  const ready = (codexEnabled || comfyEnabled || stableDiffusionCppEnabled)
    && codexReady
    && comfyReady
    && stableDiffusionCppReady;
  const generatorCount = Number(codexEnabled) + Number(comfyEnabled) + Number(stableDiffusionCppEnabled);
  const readinessMessage = !codexReady
    ? codexHealth?.message
    : !comfyReady
      ? comfyHealth?.message
      : !stableDiffusionCppReady
        ? stableDiffusionCppHealth?.message
        : 'Włącz co najmniej jeden generator w ustawieniach projektu.';
  const expectedSize = assetPixelSize(project, {
    category,
    elevationLevels,
    relativeWidth,
    relativeHeight,
  });
  const changeCategory = (next: AssetCategory) => {
    const defaults = defaultAssetSizing(next);
    setCategory(next);
    setElevationLevels(defaults.elevationLevels || 1);
    setRelativeWidth(defaults.relativeWidth);
    setRelativeHeight(defaults.relativeHeight);
    if (next === 'road_tile') {
      setFootprintX(1);
      setFootprintY(1);
    }
  };

  return <div className="studio-page">
    <div className="section-heading"><div><p className="eyebrow">NOWA GENERACJA</p><h2>Co budujemy?</h2><p>Podaj nazwę assetu. Każdy aktywny generator przygotuje osobny wariant do porównania.</p></div><div className="grid-chip"><span>{project.tileWidthPx}</span><small>×</small><span>{project.tileHeightPx}</span><em>px</em></div></div>
    {!ready && <ErrorBox message={readinessMessage ?? 'Generatory nie są jeszcze gotowe.'} />}
    <div className="request-card">
      <div className="form-grid two"><label>Nazwa assetu<input placeholder="Kamienna droga" value={name} onChange={(event) => setName(event.target.value)} /></label><label>Typ assetu<select value={category} onChange={(event) => changeCategory(event.target.value as AssetCategory)}>{assetCategories.map((item) => <option key={item} value={item}>{categoryLabels[item]}</option>)}</select></label></div>
      {category === 'elevated_tile' && <div className="asset-size-settings"><label>Elevation height (poziomy)<input type="number" min={1} max={16} step={1} value={elevationLevels} onChange={(event) => setElevationLevels(Number(event.target.value))} /></label><AssetCanvasSummary size={expectedSize} base={project} detail={`${elevationLevels} × wysokość bazowego rombu`} /></div>}
      {isRelativeSizeCategory(category) && <div className="asset-size-settings"><div className="form-grid two"><label>Szerokość canvasa (× tile)<input type="number" min={0.25} max={16} step={0.25} value={relativeWidth} onChange={(event) => setRelativeWidth(Number(event.target.value))} /></label><label>Wysokość canvasa (× tile)<input type="number" min={0.25} max={16} step={0.25} value={relativeHeight} onChange={(event) => setRelativeHeight(Number(event.target.value))} /></label></div><AssetCanvasSummary size={expectedSize} base={project} detail={`${relativeWidth}× szerokości · ${relativeHeight}× wysokości tile`} /></div>}
      {category === 'flat_tile' && <AssetCanvasSummary size={expectedSize} base={project} detail="Bazowy romb 2:1" />}
      {category === 'road_tile' && <div className="road-settings"><RoadSetSummary /><AssetCanvasSummary size={expectedSize} base={project} detail="16 transparentnych nakładek 1×1" /></div>}
      <label>Opis dla agenta (opcjonalnie)<textarea className="hero-textarea" rows={8} placeholder="Możesz doprecyzować wygląd, materiały lub detale…" value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
      <div className="request-footer">
        <div className="footprint-control">
          <span><strong>Zajęte komórki w Unity (footprint)</strong><small>{category === 'road_tile' ? 1 : footprintX * footprintY} {category !== 'road_tile' && footprintX * footprintY === 1 ? 'pole' : 'pola'} łącznie</small></span>
          <input aria-label="Footprint X — zajęte komórki" type="number" min={1} max={64} value={category === 'road_tile' ? 1 : footprintX} disabled={category === 'road_tile'} onChange={(event) => setFootprintX(Number(event.target.value))} />
          <small>×</small>
          <input aria-label="Footprint Y — zajęte komórki" type="number" min={1} max={64} value={category === 'road_tile' ? 1 : footprintY} disabled={category === 'road_tile'} onChange={(event) => setFootprintY(Number(event.target.value))} />
        </div>
        <button className="primary" disabled={!ready || name.trim().length < 2 || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? <LoaderCircle className="spin" /> : <Sparkles />} Generuj {generatorCount > 1 ? `${generatorCount} warianty` : 'asset'}</button>
      </div>
      {error && <ErrorBox message={error} />}
    </div>
    <div className="process-strip"><ProcessStep number="01" title="Generacja" detail="Codex, ComfyUI i/lub stable-diffusion.cpp" /><ProcessStep number="02" title="Review" detail="Wspólna walidacja i wybór" /><ProcessStep number="03" title="Registry" detail="Provenance + historia" /></div>
  </div>;
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

function RoadSetSummary() {
  return <div className="road-set-summary">
    <SquareStack />
    <div><strong>Komplet 16 wariantów</strong><span>1 materiał AI + geometria aplikacji · 4 końce · 2 proste · 4 zakręty · 4 warianty T · skrzyżowanie · izolowany</span></div>
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
  const [showError, setShowError] = useState(false);
  const [retryError, setRetryError] = useState('');
  const [verificationError, setVerificationError] = useState('');
  const errorTriggerRef = useRef<HTMLButtonElement>(null);
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
  useEffect(() => { setShowError(false); setRetryError(''); setVerificationError(''); }, [version?.id]);
  if (detail.isLoading || !asset || !version) return <FullScreenLoader label="Wczytywanie assetu…" compact />;

  const isTerrain = isTileAssetCategory(version.category);
  const expectedAssetSize = assetPixelSize(project, version);
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

  return <div className="review-page">
    <div className="section-heading compact">
      <div><p className="eyebrow">ASSET / {categoryLabels[version.category].toLocaleUpperCase()}</p><h2>{asset.name}</h2><p>{version.aiDescription || version.prompt}</p></div>
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
    {verificationDetails && <p className="geometry-warning"><AlertTriangle /> Weryfikacja AI: {verificationDetails}</p>}
    <div className="review-layout">
      <div className="preview-column">
        {version.imageUrl && <div className="preview-toolbar">
          {isTerrain && <div className="preview-mode-switch" aria-label="Tryb podglądu terenu">
            <button className={!repeatTerrain ? 'active' : ''} aria-pressed={!repeatTerrain} onClick={() => setRepeatTerrain(false)}>Pojedynczy tile</button>
            <button className={repeatTerrain ? 'active' : ''} aria-pressed={repeatTerrain} onClick={() => setRepeatTerrain(true)}><Layers3 /> Tile obok tile</button>
          </div>}
          <PreviewZoomControls zoom={previewZoom} onZoom={setPreviewZoom} />
        </div>}
        {version.category === 'road_tile' && version.roadVariants?.length
          ? <RoadVariantGrid version={version} assetName={asset.name} zoom={singleZoom} />
          : repeatTerrain && version.imageUrl
            ? <TerrainSeamPreview
            version={version}
            assetName={asset.name}
            tileWidth={project.tileWidthPx}
            tileHeight={project.tileHeightPx}
            spriteHeight={expectedAssetSize?.height}
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
        <div className="image-meta"><span>{version.width ?? '—'} × {version.height ?? '—'} px</span><span>{categoryLabels[version.category]}</span><GeneratorBadge version={version} compact />{version.category === 'road_tile' && <span>{version.roadVariants?.length ?? 0} wariantów</span>}{version.category === 'elevated_tile' && <span>Elevation {version.elevationLevels}</span>}{isRelativeSizeCategory(version.category) && <span>Size {version.relativeWidth}×{version.relativeHeight}</span>}<span>Footprint {version.footprint.x}×{version.footprint.y}</span>{version.imageUrl && <span>Pivot {version.pivot.x.toFixed(2)}, {version.pivot.y.toFixed(2)}</span>}{repeatTerrain && <span className="seam-legend">Różowe = szczelina</span>}</div>
        {assetSizeMismatch && <p className="geometry-warning"><AlertTriangle /> Ten asset ma canvas {version.width}×{version.height}px zamiast {expectedAssetSize.width}×{expectedAssetSize.height}px wynikającego z parametrów tej wersji.</p>}
      </div>
      <ReviewControls asset={asset} version={version} project={project} onChanged={handleChanged} />
    </div>
    <GenerationLogPanel
      assetId={asset.id}
      versions={asset.versions}
      active={jobs.some((job) => job.assetId === asset.id && ['queued', 'generating'].includes(job.status))}
    />
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
}: {
  assetId: string;
  selectedVersionId: string | null;
  onSelectVersion: (versionId: string) => void;
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
    {asset && <VersionRail versions={asset.versions} selected={selected} onSelect={onSelectVersion} />}
  </aside>;
}

function TileOverlay({ version }: { version: AssetVersion }) {
  return <div className="tile-overlay" style={{ '--pivot-x': `${version.pivot.x * 100}%`, '--pivot-y': `${(1 - version.pivot.y) * 100}%` } as React.CSSProperties}>
    <div className="pivot-dot" title="Pivot" />
  </div>;
}

function RoadVariantGrid({ version, assetName, zoom }: { version: AssetVersion; assetName: string; zoom: number }) {
  return <div className="road-variant-stage">
    <div className="road-variant-grid" style={{ width: `${zoom}%` }}>
      {version.roadVariants?.map((variant) => <figure className="road-variant-card" key={variant.connectionMask}>
        <div><img src={variant.imageUrl} alt={`${assetName}: ${roadVariantLabel(variant.connectionMask)}`} /></div>
        <figcaption><strong>{variant.connectionMask.toString().padStart(2, '0')}</strong><span>{roadVariantLabel(variant.connectionMask)}</span></figcaption>
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

const terrainPreviewCells = Array.from({ length: 3 }, (_, row) => row - 1)
  .flatMap((y) => Array.from({ length: 3 }, (_, column) => ({ x: column - 1, y })))
  .sort((left, right) => (left.x + left.y) - (right.x + right.y) || left.x - right.x);

export function TerrainSeamPreview({
  version,
  assetName,
  tileWidth,
  tileHeight,
  spriteHeight,
  zoom = 100,
  onZoom,
}: {
  version: AssetVersion;
  assetName: string;
  tileWidth: number;
  tileHeight: number;
  spriteHeight?: number;
  zoom?: number;
  onZoom: (zoom: number) => void;
}) {
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const scaledTileWidth = Math.round(tileWidth * zoom / 100);
  const scaledTileHeight = Math.round(tileHeight * zoom / 100);
  const scaledSpriteHeight = Math.round((spriteHeight ?? tileHeight) * zoom / 100);

  useEffect(() => setPan({ x: 0, y: 0 }), [version.id]);

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
    role="img"
    tabIndex={0}
    aria-label={`Podgląd powtarzania terenu ${assetName}. Przeciągnij, aby przesunąć. Użyj kółka myszy, aby zmienić zoom.`}
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
      width: `${scaledTileWidth}px`,
      height: `${scaledTileHeight}px`,
      '--preview-pan-x': `${pan.x}px`,
      '--preview-pan-y': `${pan.y}px`,
    } as React.CSSProperties}>
      {terrainPreviewCells.map(({ x, y }) => <img
        key={`${x}:${y}`}
        className="seam-tile"
        src={version.imageUrl!}
        alt={`${assetName} — sąsiad ${x + 2},${y + 2}`}
        draggable={false}
        style={{
          left: `${scaledTileWidth / 2 + (x - y) * (scaledTileWidth / 2)}px`,
          top: `${scaledTileHeight / 2 + (x + y) * (scaledTileHeight / 2)}px`,
          width: `${scaledTileWidth}px`,
          height: `${scaledSpriteHeight}px`,
          transform: `translate(-50%, -${scaledTileHeight / 2}px)`,
        }}
      />)}
    </div>
  </div>;
}

function VersionRail({ versions, selected, onSelect }: { versions: AssetVersion[]; selected: string; onSelect: (id: string) => void }) {
  return <div className="version-rail">{versions.map((version, index) => <button key={version.id} className={selected === version.id ? 'active' : ''} onClick={() => onSelect(version.id)}>
    <span className="version-number">v{versions.length - index}</span>
    <small>{version.mode === 'edit' ? 'Edycja' : version.mode === 'variant' ? 'Wariant' : 'Generacja'}</small>
    <GeneratorBadge version={version} compact />
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
}: {
  assetId: string;
  active: boolean;
  versions?: AssetVersion[];
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
  return <section className="generation-log" aria-label="Dziennik generacji" aria-live="polite">
    <div className="generation-log-heading">
      <div><p className="eyebrow">PRZEBIEG</p><strong>Log generacji</strong></div>
      {active && <span className="generation-log-live"><i /> AKTYWNA</span>}
    </div>
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

  useEffect(() => {
    setCategory(version.category); setTags(version.tags.join(', '));
    setElevationLevels(version.elevationLevels);
    setRelativeWidth(version.relativeWidth);
    setRelativeHeight(version.relativeHeight);
    setFx(version.footprint.x); setFy(version.footprint.y); setPx(version.pivot.x); setPy(version.pivot.y);
  }, [version.id, version.footprint.x, version.footprint.y, version.pivot.x, version.pivot.y]);

  const review = useMutation({
    mutationFn: (decision: 'approved' | 'rejected') => window.tilemap.assets.review({
      versionId: version.id, decision,
      tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      rejectionReason: decision === 'rejected' ? rejection : undefined,
      footprint: category === 'road_tile' ? { x: 1, y: 1 } : { x: fx, y: fy }, pivot: { x: px, y: py },
    }),
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
      footprint: category === 'road_tile' ? { x: 1, y: 1 } : { x: fx, y: fy },
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
  const changeCategory = (next: AssetCategory) => {
    const defaults = next === version.category
      ? { elevationLevels: version.elevationLevels, relativeWidth: version.relativeWidth, relativeHeight: version.relativeHeight }
      : defaultAssetSizing(next);
    setCategory(next);
    setElevationLevels(defaults.elevationLevels || 1);
    setRelativeWidth(defaults.relativeWidth);
    setRelativeHeight(defaults.relativeHeight);
    if (next === 'road_tile') {
      setFx(1);
      setFy(1);
    }
  };

  return <div className="review-controls">
    <p className="eyebrow">METADANE</p>
    <label>Typ tej wersji<input value={categoryLabels[version.category]} readOnly /></label>
    {version.category === 'road_tile' && <label>Warianty drogi<input value={`${version.roadVariants?.length ?? 0} / 16`} readOnly /></label>}
    <label>Tagi AI <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="kamień, droga, mech" /></label>
    {isRelativeSizeCategory(version.category) && <div className="dimension-explainer" role="note">
      <strong>Canvas obrazu: {version.relativeWidth}×{version.relativeHeight} tile</strong>
      <span>To rozmiar PNG. Footprint poniżej określa osobno liczbę komórek zajętych na Gridzie w Unity.</span>
    </div>}
    <div className="form-grid two"><label>Footprint X — zajęte komórki<input type="number" min={1} max={64} value={fx} disabled={version.category === 'road_tile'} onChange={(event) => setFx(Number(event.target.value))} /></label><label>Footprint Y — zajęte komórki<input type="number" min={1} max={64} value={fy} disabled={version.category === 'road_tile'} onChange={(event) => setFy(Number(event.target.value))} /></label></div>
    {version.imageUrl && <div className="form-grid two"><label>Pivot X (propozycja AI)<input type="number" min={0} max={1} step={0.01} value={px} onChange={(event) => setPx(Number(event.target.value))} /></label><label>Pivot Y (propozycja AI)<input type="number" min={0} max={1} step={0.01} value={py} onChange={(event) => setPy(Number(event.target.value))} /></label></div>}
    {version.status === 'needs_review' && <>
      {anotherVersionApproved && <p className="inline-warning"><AlertTriangle /> Najpierw cofnij zatwierdzenie obecnej wersji. Tylko jedna wersja assetu może być zatwierdzona.</p>}
      <div className="decision-row"><button className="approve" disabled={review.isPending || anotherVersionApproved} onClick={() => review.mutate('approved')}><Check /> Zatwierdź</button><button className="reject" disabled={review.isPending} onClick={() => review.mutate('rejected')}><X /> Odrzuć</button></div>
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
      <label>Typ assetu<select value={category} onChange={(event) => changeCategory(event.target.value as AssetCategory)}>{assetCategories.map((item) => <option key={item} value={item}>{categoryLabels[item]}</option>)}</select></label>
      {category === 'road_tile' && <RoadSetSummary />}
      {category === 'elevated_tile' && <label>Elevation height (poziomy)<input type="number" min={1} max={16} step={1} value={elevationLevels} onChange={(event) => setElevationLevels(Number(event.target.value))} /></label>}
      {isRelativeSizeCategory(category) && <div className="form-grid two"><label>Szerokość canvasa (× tile)<input type="number" min={0.25} max={16} step={0.25} value={relativeWidth} onChange={(event) => setRelativeWidth(Number(event.target.value))} /></label><label>Wysokość canvasa (× tile)<input type="number" min={0.25} max={16} step={0.25} value={relativeHeight} onChange={(event) => setRelativeHeight(Number(event.target.value))} /></label></div>}
      {nextExpectedSize && <AssetCanvasSummary size={nextExpectedSize} base={project} detail={category === 'elevated_tile' ? `Elevation ${elevationLevels}` : category === 'road_tile' ? 'Transparentna nakładka 1×1' : category === 'flat_tile' ? 'Bazowy romb 2:1' : `${relativeWidth}×${relativeHeight} jednostki tile`} />}
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
  const [target, setTarget] = useState(project.unityExportPath ?? '');
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [error, setError] = useState('');
  const approvedCount = assets.filter((asset) => asset.currentApprovedVersionId).length;
  const choose = useMutation({
    mutationFn: () => window.tilemap.export.chooseTarget(),
    onSuccess: (path) => { if (path) { setTarget(path); setPreview(null); } },
    onError: (reason) => setError(errorMessage(reason)),
  });
  const makePreview = useMutation({
    mutationFn: () => window.tilemap.export.preview({ targetAssetsDirectory: target }),
    onSuccess: (value) => { setPreview(value); setError(''); },
    onError: (reason) => setError(errorMessage(reason)),
  });
  const run = useMutation({
    mutationFn: () => window.tilemap.export.run(preview!.token),
    onSuccess: (result) => { setError(''); alert(`Wyeksportowano ${result.exported} assetów.\n${result.manifestPath}`); },
    onError: (reason) => setError(errorMessage(reason)),
  });

  return <div className="export-page">
    <div className="section-heading"><div><p className="eyebrow">UNITY DELIVERY</p><h2>Eksport zatwierdzonych assetów</h2><p>Pliki PNG i manifest trafią do wydzielonego katalogu. Istniejące pliki .meta pozostaną nietknięte.</p></div><div className="approved-counter"><strong>{approvedCount}</strong><span>zatwierdzonych</span></div></div>
    <div className="export-target"><FolderOpen /><div><small>KATALOG ASSETS</small><strong>{target || 'Nie wybrano'}</strong></div><button className="secondary" onClick={() => choose.mutate()}>Wybierz</button></div>
    <button className="primary" disabled={!target || makePreview.isPending || approvedCount === 0} onClick={() => makePreview.mutate()}>{makePreview.isPending ? <LoaderCircle className="spin" /> : <Play />} Przygotuj podgląd</button>
    {preview && <div className="export-preview"><div className="preview-heading"><h3>Plan eksportu</h3><span>{preview.files.length} plików</span></div>{preview.files.map((file) => <div key={`${file.assetId}-${file.variantMask ?? 'main'}`} className="export-file"><span className={`action ${file.action}`}>{file.action === 'create' ? 'NOWY' : file.action === 'replace' ? 'ZAMIANA' : 'BEZ ZMIAN'}</span><strong>{file.destinationPath}</strong></div>)}<div className="manifest-row"><Archive /><span>{preview.manifestPath}</span></div><button className="approve wide" disabled={run.isPending} onClick={() => run.mutate()}>{run.isPending ? <LoaderCircle className="spin" /> : <Download />} Eksportuj do Unity</button></div>}
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
    ['stable-diffusion.cpp CLI', Boolean(stableDiffusionCppHealth?.installed), stableDiffusionCppHealth?.executablePath ?? 'Nie wykryto sd-cli.exe'],
    ['stable-diffusion.cpp Z-Image Turbo', stableDiffusionCppHealth?.state === 'ready', stableDiffusionCppHealth?.state === 'ready' ? stableDiffusionCppHealth.model : stableDiffusionCppHealth?.missingFiles.join(', ') || 'Niegotowy'],
    ['Log aplikacji', Boolean(codexHealth?.logPath), codexHealth?.logPath ?? 'Niedostępny'],
  ] as const;
  return <div className="diagnostics-page"><div className="section-heading"><div><p className="eyebrow">SYSTEM</p><h2>Diagnostyka generatorów</h2><p>Każdy włączony generator musi przejść własne kontrole gotowości.</p></div><button className="secondary" disabled={refresh.isPending} onClick={() => refresh.mutate()}><RefreshCw className={refresh.isPending ? 'spin' : ''} /> Sprawdź ponownie</button></div><div className="diagnostic-grid">{checks.map(([name, ok, detail]) => <div key={name} className={ok ? 'ok' : 'bad'}><span>{ok ? <Check /> : <X />}</span><div><strong>{name}</strong><small>{detail}</small></div></div>)}</div><div className="diagnostic-message"><CircleDot /><span>{codexHealth?.message ?? 'Codex: sprawdzanie…'}<br />{comfyHealth?.message ?? 'ComfyUI: sprawdzanie…'}<br />{stableDiffusionCppHealth?.message ?? 'stable-diffusion.cpp: sprawdzanie…'}</span></div></div>;
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
function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value >= 1024 ** 3) return `${(value / (1024 ** 3)).toFixed(1).replace('.', ',')} GB`;
  if (value >= 1024 ** 2) return `${Math.round(value / (1024 ** 2))} MB`;
  return `${Math.round(value / 1024)} KB`;
}
function formatDate(value: string): string { return new Intl.DateTimeFormat('pl-PL', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)); }
function formatLogTime(value: string): string { return new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)); }
