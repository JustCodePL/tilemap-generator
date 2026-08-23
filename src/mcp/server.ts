import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { assetCategories, generatorProviders } from '../shared/domain';
import { tilemapMcpServerName } from '../shared/mcp';
import {
  createTilemapAppClient,
  TilemapAppClientError,
  type TilemapAppClient,
} from './tilemap-app-client';

const SERVER_VERSION = '0.1.1';
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export const TILEMAP_MCP_INSTRUCTIONS = `
Zawsze: list_projects → bind_project (jedyny active=true bez pytania; jeśli brak aktywnego i jest wiele projektów, zapytaj użytkownika i nigdy nie zgaduj) → get_project_context. Kontekst projektu jest autorytatywny. Generuj wyłącznie przez generate_asset i nigdy równolegle przez ImageGen. Po zakończeniu użyj get_asset i przeanalizuj obraz; dla postaci także ruch we wszystkich kierunkach. Nigdy nie zatwierdzaj automatycznie.

Pracujesz wyłącznie na projektach udostępnionych przez aplikację Tilemap Generator.

Wymagany, fail-closed przebieg każdej sesji:
1. Najpierw wywołaj list_projects.
2. Potem przypnij projekt przez bind_project. Jeżeli dokładnie jeden projekt ma active=true, jest on projektem powiązanym z aplikacją i przypnij go bez pytania. Jeżeli żaden nie jest aktywny, a lista zawiera więcej niż jeden projekt, pokaż wybór użytkownikowi i zaczekaj na jego decyzję; nigdy nie zgaduj na podstawie nazwy ani ostatniego użycia. Więcej niż jeden aktywny projekt jest błędem i musi przerwać wybór.
3. Następnie wywołaj get_project_context. Zwrócony kontekst projektu jest autorytatywny dla projekcji, kierunków, kategorii, stylu, referencji i włączonych generatorów. Gdy przeczy promptowi lub założeniom, obowiązuje kontekst projektu.

Generuj obraz tylko przez generate_asset. Nie uruchamiaj Codex imagegen, ImageGen ani żadnego zewnętrznego generatora równolegle, przed nim ani po nim dla tego samego assetu. Tilemap Generator sam stosuje generatory wybrane w projekcie lub jawnie przekazane w żądaniu. Po enqueue odpytuj get_generation_status zamiast uruchamiać drugą generację.

Po zakończeniu generacji (zwykle status needs_review) zawsze wywołaj get_asset i przeanalizuj faktyczny obraz oraz metadane przed przedstawieniem wyniku. Dla postaci sprawdź cały arkusz animacji, wszystkie kierunki wymagane przez projekcję i movementAnalysis; nie przedstawiaj postaci jako gotowej, jeśli ruch jest niespójny. Nigdy automatycznie nie zatwierdzaj assetu — decyzja review należy do użytkownika w aplikacji.

Referencje projektu najpierw przeglądaj przez list_references, a bajty konkretnego obrazu pobieraj przez get_reference. Nie próbuj odczytywać katalogu projektu ani bazy danych bezpośrednio.
`.trim();

export const TILEMAP_MCP_TOOL_NAMES = [
  'list_projects',
  'bind_project',
  'get_project_context',
  'get_style',
  'update_style',
  'list_references',
  'add_reference',
  'get_reference',
  'get_asset',
  'generate_asset',
  'get_generation_status',
] as const;

export interface TilemapAppClientContract {
  connect(): Promise<void>;
  call<T>(method: string, params?: unknown): Promise<T>;
  close(): Promise<void>;
}

const emptyInputSchema = z.object({}).strict();
const bindProjectInputSchema = z.object({
  projectId: z.string().uuid().describe('ProjectId zwrócony przez ostatnie list_projects.'),
  confirmedByUser: z.boolean().default(false).describe(
    'Ustaw true dopiero po jawnym wyborze użytkownika, gdy list_projects zwróciło wiele projektów.',
  ),
}).strict();
const getStyleInputSchema = z.object({
  historyLimit: z.number().int().min(1).max(20).default(10),
}).strict();
const updateStyleInputSchema = z.object({
  summary: z.string().trim().min(1).max(30_000),
}).strict();
const addReferenceInputSchema = z.object({
  sourcePath: z.string().trim().min(1).max(32_767).describe(
    'Bezwzględna ścieżka do lokalnego obrazu wybranego przez użytkownika.',
  ),
  description: z.string().trim().min(3).max(4_000),
}).strict();
const getReferenceInputSchema = z.object({ referenceId: z.string().uuid() }).strict();
const getAssetInputSchema = z.object({
  assetId: z.string().uuid(),
  versionId: z.string().uuid().optional(),
}).strict();

const footprintSchema = z.object({
  x: z.number().int().min(1).max(64),
  y: z.number().int().min(1).max(64),
}).strict();
const characterAnimationSchema = z.object({
  action: z.literal('walk').default('walk'),
  framesPerDirection: z.literal(4).default(4),
  framesPerSecond: z.number().int().min(1).max(24).default(8),
}).strict();
const generationRequestSchema = z.object({
  assetId: z.string().uuid().optional(),
  parentVersionId: z.string().uuid().optional(),
  name: z.string().trim().min(2).max(120),
  prompt: z.string().trim().max(20_000).default(''),
  feedback: z.string().trim().max(10_000).optional(),
  mode: z.enum(['generate', 'edit', 'variant']).default('generate'),
  category: z.enum(assetCategories).optional(),
  elevationLevels: z.number().int().min(1).max(16).optional(),
  relativeWidth: z.number().min(0.25).max(16).optional(),
  relativeHeight: z.number().min(0.25).max(16).optional(),
  characterAnimation: characterAnimationSchema.optional(),
  footprint: footprintSchema.default({ x: 1, y: 1 }),
  generatorProvider: z.enum(generatorProviders).optional(),
  generatorProviders: z.array(z.enum(generatorProviders))
    .min(1)
    .max(generatorProviders.length)
    .optional(),
}).strict().superRefine((input, context) => {
  if (input.characterAnimation && input.category !== undefined && input.category !== 'character') {
    context.addIssue({
      code: 'custom', path: ['characterAnimation'],
      message: 'Ustawienia animacji są dozwolone tylko dla kategorii character.',
    });
  }
  if (input.generatorProvider && input.generatorProviders) {
    context.addIssue({
      code: 'custom', path: ['generatorProviders'],
      message: 'Nie można łączyć generatorProvider i generatorProviders.',
    });
  }
  if (input.assetId && input.generatorProviders) {
    context.addIssue({
      code: 'custom', path: ['generatorProviders'],
      message: 'Wiele generatorów można wybrać tylko dla nowego assetu.',
    });
  }
  if (input.generatorProviders
    && new Set(input.generatorProviders).size !== input.generatorProviders.length) {
    context.addIssue({
      code: 'custom', path: ['generatorProviders'],
      message: 'Każdy generator może wystąpić tylko raz.',
    });
  }
});
const generateAssetInputSchema = z.object({
  request: generationRequestSchema,
  referenceIds: z.array(z.string().uuid()).max(20).default([]),
  styleDirection: z.string().trim().min(1).max(12_000).optional(),
}).strict().superRefine((input, context) => {
  if (new Set(input.referenceIds).size !== input.referenceIds.length) {
    context.addIssue({
      code: 'custom', path: ['referenceIds'],
      message: 'Każda referencja może wystąpić tylko raz.',
    });
  }
});
const getGenerationStatusInputSchema = z.object({
  jobIds: z.array(z.string().uuid()).min(1).max(20),
  includeLogs: z.boolean().default(true),
  logLimit: z.number().int().min(1).max(100).default(20),
}).strict().superRefine((input, context) => {
  if (new Set(input.jobIds).size !== input.jobIds.length) {
    context.addIssue({
      code: 'custom', path: ['jobIds'],
      message: 'Każde zadanie może wystąpić tylko raz.',
    });
  }
});

const projectDescriptorSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  openedAt: z.string().optional(),
  active: z.boolean(),
  bound: z.boolean(),
});
const projectListSchema = z.array(projectDescriptorSchema);
const projectContextEnvelopeSchema = z.object({
  project: z.object({ projectId: z.string().uuid() }).passthrough(),
}).passthrough();
const imageToolResponseSchema = z.object({
  projectId: z.string().uuid(),
  metadata: z.record(z.string(), z.unknown()),
  mimeType: z.literal('image/png'),
  sizeBytes: z.number().int().min(1).max(MAX_IMAGE_BYTES),
  dataBase64: z.string().min(1).max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 8),
});

interface SessionWorkflow {
  listedProjectIds: Set<string> | null;
  listedActiveProjectId: string | null;
  boundProjectId: string | null;
  contextProjectId: string | null;
  authorityFingerprint: string | null;
}

export function createTilemapMcpServer(
  client: TilemapAppClientContract = createTilemapAppClient(),
): McpServer {
  const workflow: SessionWorkflow = {
    listedProjectIds: null,
    listedActiveProjectId: null,
    boundProjectId: null,
    contextProjectId: null,
    authorityFingerprint: null,
  };
  const server = new McpServer(
    { name: tilemapMcpServerName, version: SERVER_VERSION },
    { instructions: TILEMAP_MCP_INSTRUCTIONS },
  );

  server.registerTool('list_projects', {
    title: 'Lista projektów Tilemap Generator',
    description: 'Pierwszy obowiązkowy krok. Zwraca projekty dostępne w aplikacji bez ujawniania ich ścieżek.',
    inputSchema: emptyInputSchema,
    annotations: readOnlyAnnotations,
  }, async () => executeTool(workflow, async () => {
    clearWorkflow(workflow);
    const raw = await client.call<unknown>('list_projects', {});
    const projects = projectListSchema.parse(raw).map((project) => ({
      projectId: project.projectId,
      name: project.name,
      ...(project.openedAt ? { openedAt: project.openedAt } : {}),
      active: project.active,
      bound: project.bound,
    }));
    const ids = projects.map((project) => project.projectId);
    if (new Set(ids).size !== ids.length) {
      throw new WorkflowError('Aplikacja zwróciła niejednoznaczną listę projectId. Przerwano wybór projektu.');
    }
    const activeProjects = projects.filter((project) => project.active);
    if (activeProjects.length > 1) {
      clearWorkflow(workflow);
      throw new WorkflowError('Aplikacja zwróciła więcej niż jeden aktywny projekt. Przerwano wybór projektu.');
    }
    workflow.listedProjectIds = new Set(ids);
    workflow.listedActiveProjectId = activeProjects[0]?.projectId ?? null;
    if (workflow.boundProjectId && !workflow.listedProjectIds.has(workflow.boundProjectId)) {
      clearBinding(workflow);
    }
    return jsonToolResult({
      projects,
      activeProjectId: workflow.listedActiveProjectId,
      requiresUserSelection: !workflow.listedActiveProjectId && projects.length > 1,
      nextAction: projects.length === 0
        ? 'Otwórz lub utwórz projekt w Tilemap Generator.'
        : workflow.listedActiveProjectId
          ? `Wywołaj bind_project dla aktywnego projektu ${workflow.listedActiveProjectId}; nie pytaj użytkownika.`
          : projects.length > 1
          ? 'Zapytaj użytkownika, który projekt wybrać, następnie wywołaj bind_project z confirmedByUser=true.'
          : 'Wywołaj bind_project dla jedynego projektu.',
    });
  }));

  server.registerTool('bind_project', {
    title: 'Przypnij projekt',
    description: 'Drugi obowiązkowy krok. Przypina dokładnie jeden projectId z ostatniego list_projects do tej sesji.',
    inputSchema: bindProjectInputSchema,
    annotations: stateChangeAnnotations(true),
  }, async ({ projectId, confirmedByUser }) => executeTool(workflow, async () => {
    if (!workflow.listedProjectIds) {
      throw new WorkflowError('Najpierw wywołaj list_projects.');
    }
    if (!workflow.listedProjectIds.has(projectId)) {
      throw new WorkflowError('ProjectId nie pochodzi z ostatniego list_projects. Odśwież listę i wybierz projekt ponownie.');
    }
    if (workflow.listedActiveProjectId && projectId !== workflow.listedActiveProjectId) {
      throw new WorkflowError('Aplikacja ma aktywny projekt. Przypnij projectId oznaczony active=true.');
    }
    if (!workflow.listedActiveProjectId && workflow.listedProjectIds.size > 1 && !confirmedByUser) {
      throw new WorkflowError('Dostępnych jest wiele projektów. Najpierw zapytaj użytkownika, potem ponów z confirmedByUser=true.');
    }
    const raw = await client.call<unknown>('bind_project', { projectId });
    const boundId = projectContextEnvelopeSchema.parse(raw).project.projectId;
    if (boundId !== projectId) {
      clearBinding(workflow);
      throw new WorkflowError('Aplikacja przypięła inny projekt niż jawnie wybrany. Przerwano sesję.');
    }
    workflow.boundProjectId = projectId;
    workflow.contextProjectId = null;
    workflow.authorityFingerprint = null;
    return jsonToolResult({
      projectId,
      bound: true,
      nextAction: 'Teraz wywołaj get_project_context; odpowiedź bind_project nie zastępuje tego kroku.',
    });
  }));

  server.registerTool('get_project_context', {
    title: 'Autorytatywny kontekst projektu',
    description: 'Trzeci obowiązkowy krok. Pobiera projekcję, kierunki, styl, registry i ustawienia generacji przypiętego projektu.',
    inputSchema: emptyInputSchema,
    annotations: readOnlyAnnotations,
  }, async () => executeTool(workflow, async () => {
    requireBound(workflow);
    const raw = await client.call<unknown>('get_project_context', {});
    const context = projectContextEnvelopeSchema.parse(raw);
    assertResponseProject(workflow, context.project.projectId);
    workflow.contextProjectId = workflow.boundProjectId;
    workflow.authorityFingerprint = authorityFingerprint(context);
    return jsonToolResult(sanitizeJson(context));
  }));

  server.registerTool('get_style', {
    title: 'Pobierz styl projektu',
    description: 'Zwraca aktywne podsumowanie stylu i ograniczoną historię rewizji.',
    inputSchema: getStyleInputSchema,
    annotations: readOnlyAnnotations,
  }, async (input) => executeTool(workflow, async () => {
    requireContext(workflow);
    return boundJsonToolResult(await client.call<unknown>('get_style', input), workflow);
  }));

  server.registerTool('update_style', {
    title: 'Zaktualizuj styl projektu',
    description: 'Tworzy nową ręczną rewizję stylu. Po zmianie ponownie pobierz get_project_context.',
    inputSchema: updateStyleInputSchema,
    annotations: stateChangeAnnotations(false),
  }, async (input) => executeTool(workflow, async () => {
    requireContext(workflow);
    const result = await client.call<unknown>('update_style', input);
    assertBoundResponse(result, workflow);
    clearContext(workflow);
    return jsonToolResult({
      result: sanitizeJson(result),
      nextAction: 'Styl zmieniony. Przed dalszą pracą ponownie wywołaj get_project_context.',
    });
  }));

  server.registerTool('list_references', {
    title: 'Lista referencji projektu',
    description: 'Zwraca metadane referencji bez ładowania obrazów.',
    inputSchema: emptyInputSchema,
    annotations: readOnlyAnnotations,
  }, async () => executeTool(workflow, async () => {
    requireContext(workflow);
    return boundJsonToolResult(await client.call<unknown>('list_references', {}), workflow);
  }));

  server.registerTool('add_reference', {
    title: 'Dodaj referencję',
    description: 'Kopiuje wskazany przez użytkownika lokalny obraz do przypiętego projektu i zapisuje opis.',
    inputSchema: addReferenceInputSchema,
    annotations: stateChangeAnnotations(false),
  }, async (input) => executeTool(workflow, async () => {
    requireContext(workflow);
    const result = await client.call<unknown>('add_reference', input);
    assertBoundResponse(result, workflow);
    clearContext(workflow);
    return jsonToolResult({
      result: sanitizeJson(result),
      nextAction: 'Referencja dodana. Ponownie wywołaj get_project_context.',
    });
  }));

  server.registerTool('get_reference', {
    title: 'Pobierz obraz referencyjny',
    description: 'Zwraca metadane i faktyczną zawartość PNG jednej referencji z przypiętego projektu.',
    inputSchema: getReferenceInputSchema,
    annotations: readOnlyAnnotations,
  }, async (input) => executeTool(workflow, async () => {
    requireContext(workflow);
    return imageToolResult(await client.call<unknown>('get_reference', input), workflow);
  }));

  server.registerTool('get_asset', {
    title: 'Pobierz obraz assetu',
    description: 'Zwraca metadane i PNG wybranej wersji; użyj po generacji do obowiązkowej analizy, nigdy do auto-approve.',
    inputSchema: getAssetInputSchema,
    annotations: readOnlyAnnotations,
  }, async (input) => executeTool(workflow, async () => {
    requireContext(workflow);
    return imageToolResult(await client.call<unknown>('get_asset', input), workflow);
  }));

  server.registerTool('generate_asset', {
    title: 'Wygeneruj asset',
    description: 'Kolejkuje generację wyłącznie w Tilemap Generator. Nie wolno równolegle używać zewnętrznego imagegen.',
    inputSchema: generateAssetInputSchema,
    annotations: stateChangeAnnotations(false),
  }, async (input) => executeTool(workflow, async () => {
    requireContext(workflow);
    const currentContext = projectContextEnvelopeSchema.parse(
      await client.call<unknown>('get_project_context', {}),
    );
    assertResponseProject(workflow, currentContext.project.projectId);
    if (authorityFingerprint(currentContext) !== workflow.authorityFingerprint) {
      clearContext(workflow);
      throw new WorkflowError('Autorytatywny kontekst projektu zmienił się. Wywołaj get_project_context i oceń nowe ustawienia przed generacją.');
    }
    const result = await client.call<unknown>('generate_asset', input);
    assertBoundResponse(result, workflow);
    return jsonToolResult({
      result: sanitizeJson(result),
      nextAction: 'Odpytuj get_generation_status. Po zakończeniu pobierz get_asset, przeanalizuj obraz i nie zatwierdzaj automatycznie.',
    });
  }));

  server.registerTool('get_generation_status', {
    title: 'Status generacji',
    description: 'Pobiera status i opcjonalne logi wskazanych jobów. Po zakończeniu użyj get_asset do analizy obrazu.',
    inputSchema: getGenerationStatusInputSchema,
    annotations: readOnlyAnnotations,
  }, async (input) => executeTool(workflow, async () => {
    requireContext(workflow);
    return boundJsonToolResult(await client.call<unknown>('get_generation_status', input), workflow);
  }));

  return server;
}

export function runTilemapMcpServer(): { handle: StdioServerHandle; close(): Promise<void> } {
  const clients = new Set<TilemapAppClient>();
  const handle = serveStdio(() => {
    const client = createTilemapAppClient();
    clients.add(client);
    return createTilemapMcpServer(client);
  }, {
    onerror: (error) => {
      process.stderr.write(`[tilemap-generator-mcp] ${safeErrorMessage(error)}\n`);
    },
  });
  let closing: Promise<void> | null = null;
  const close = () => {
    closing ??= (async () => {
      await handle.close();
      await Promise.allSettled([...clients].map((client) => client.close()));
      clients.clear();
    })();
    return closing;
  };
  const shutdown = () => void close();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
  return { handle, close };
}

async function executeTool(
  workflow: SessionWorkflow,
  operation: () => Promise<CallToolResult> | CallToolResult,
): Promise<CallToolResult> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TilemapAppClientError && error.code !== 'REMOTE_ERROR') {
      clearWorkflow(workflow);
    }
    return errorToolResult(error);
  }
}

function jsonToolResult(value: unknown): CallToolResult {
  const safe = sanitizeJson(value);
  const structuredContent = isRecord(safe) ? safe : { result: safe };
  return {
    content: [{ type: 'text', text: JSON.stringify(safe) }],
    structuredContent,
  };
}

function imageToolResult(raw: unknown, workflow: SessionWorkflow): CallToolResult {
  const parsed = imageToolResponseSchema.parse(raw);
  assertResponseProject(workflow, parsed.projectId);
  const bytes = Buffer.from(parsed.dataBase64, 'base64');
  if (bytes.length !== parsed.sizeBytes || bytes.length > MAX_IMAGE_BYTES) {
    throw new WorkflowError('Aplikacja zwróciła niespójny lub zbyt duży obraz.');
  }
  const metadata = sanitizeJson(parsed.metadata);
  const summary = {
    projectId: parsed.projectId,
    metadata,
    mimeType: parsed.mimeType,
    sizeBytes: parsed.sizeBytes,
  };
  return {
    content: [
      { type: 'text', text: JSON.stringify(summary) },
      { type: 'image', data: parsed.dataBase64, mimeType: parsed.mimeType },
    ],
    structuredContent: summary,
  };
}

function boundJsonToolResult(raw: unknown, workflow: SessionWorkflow): CallToolResult {
  assertBoundResponse(raw, workflow);
  return jsonToolResult(sanitizeJson(raw));
}

function assertBoundResponse(raw: unknown, workflow: SessionWorkflow): void {
  const response = z.object({ projectId: z.string().uuid() }).passthrough().parse(raw);
  assertResponseProject(workflow, response.projectId);
}

function errorToolResult(error: unknown): CallToolResult {
  const prefix = error instanceof WorkflowError ? 'Przerwano bezpiecznie' : 'Tilemap Generator odrzucił żądanie';
  return {
    isError: true,
    content: [{ type: 'text', text: `${prefix}: ${safeErrorMessage(error)}` }],
  };
}

function requireBound(workflow: SessionWorkflow): string {
  if (!workflow.boundProjectId) {
    throw new WorkflowError('Najpierw wykonaj list_projects i bind_project.');
  }
  return workflow.boundProjectId;
}

function requireContext(workflow: SessionWorkflow): string {
  const projectId = requireBound(workflow);
  if (workflow.contextProjectId !== projectId || !workflow.authorityFingerprint) {
    throw new WorkflowError('Najpierw pobierz get_project_context dla przypiętego projektu.');
  }
  return projectId;
}

function assertResponseProject(workflow: SessionWorkflow, projectId: string): void {
  if (!workflow.boundProjectId || projectId !== workflow.boundProjectId) {
    clearBinding(workflow);
    throw new WorkflowError('Odpowiedź aplikacji nie należy do projektu przypiętego w tej sesji.');
  }
}

function authorityFingerprint(rawContext: unknown): string {
  const context = sanitizeJson(projectContextEnvelopeSchema.parse(rawContext));
  if (!isRecord(context)) throw new WorkflowError('Nieprawidłowy kontekst projektu.');
  const generation = isRecord(context.generation) ? context.generation : {};
  return JSON.stringify({
    project: context.project,
    style: context.style,
    generation: {
      selectedGeneratorProviders: generation.selectedGeneratorProviders,
      aiVerificationEnabled: generation.aiVerificationEnabled,
      maxConcurrentJobs: generation.maxConcurrentJobs,
      queueAttached: generation.queueAttached,
    },
  });
}

function clearContext(workflow: SessionWorkflow): void {
  workflow.contextProjectId = null;
  workflow.authorityFingerprint = null;
}

function clearBinding(workflow: SessionWorkflow): void {
  workflow.boundProjectId = null;
  clearContext(workflow);
}

function clearWorkflow(workflow: SessionWorkflow): void {
  workflow.listedProjectIds = null;
  workflow.listedActiveProjectId = null;
  clearBinding(workflow);
}

function sanitizeJson(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (!isRecord(value)) return String(value);
  const safe: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:rootPath|absolutePath|socketPath|tokenPath)$/i.test(key) || child === undefined) continue;
    safe[key] = sanitizeJson(child);
  }
  return safe;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ');
  }
  const message = error instanceof Error && error.message.trim() ? error.message : 'nieznany błąd';
  return message.replace(
    /(?:[A-Za-z]:\\|\/(?:Users|home|private|var|tmp|Volumes|Applications|opt|etc)\/)[^\s,;:)]+/g,
    '[ścieżka ukryta]',
  );
}

class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowError';
  }
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function stateChangeAnnotations(idempotentHint: boolean) {
  return {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint,
    openWorldHint: false,
  } as const;
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) runTilemapMcpServer();
