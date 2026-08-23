import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  type JSONRPCMessage,
} from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTilemapMcpServer,
  TILEMAP_MCP_TOOL_NAMES,
  type TilemapAppClientContract,
} from '../mcp/server';

const FIRST_PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const REFERENCE_ID = '33333333-3333-4333-8333-333333333333';
const ASSET_ID = '44444444-4444-4444-8444-444444444444';
const VERSION_ID = '55555555-5555-4555-8555-555555555555';
const JOB_ID = '66666666-6666-4666-8666-666666666666';

const openHarnesses: ProtocolHarness[] = [];

afterEach(async () => {
  await Promise.allSettled(openHarnesses.splice(0).map((harness) => harness.close()));
});

describe('Tilemap Generator MCP server', () => {
  it('publikuje fail-closed instructions i kompletne metadata tooli przez protokół MCP', async () => {
    const client = fakeAppClient();
    const harness = await ProtocolHarness.create(client);
    openHarnesses.push(harness);

    expect(harness.initializeResult).toMatchObject({
      protocolVersion: LATEST_PROTOCOL_VERSION,
      serverInfo: { name: 'tilemap_generator', version: '0.1.1' },
    });
    const instructions = String(harness.initializeResult.instructions);
    expect(instructions).toContain('list_projects');
    expect(instructions).toContain('bind_project');
    expect(instructions).toContain('get_project_context');
    expect(instructions).toContain('nie zgaduj');
    expect(instructions).toContain('Codex imagegen');
    expect(instructions).toContain('get_asset');
    expect(instructions).toContain('Nigdy automatycznie nie zatwierdzaj');

    const listed = await harness.request('tools/list', {});
    const tools = expectRecord(listed).tools as Array<Record<string, unknown>>;
    expect(tools.map((tool) => tool.name)).toEqual(TILEMAP_MCP_TOOL_NAMES);
    expect(tools.every((tool) => expectRecord(tool.inputSchema).additionalProperties === false)).toBe(true);
    expect(tools.find((tool) => tool.name === 'get_asset')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tools.find((tool) => tool.name === 'generate_asset')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    const bindSchema = expectRecord(tools.find((tool) => tool.name === 'bind_project')?.inputSchema);
    expect(expectRecord(bindSchema.properties)).toHaveProperty('confirmedByUser');
  });

  it('wymusza list-bind-context, nie zgaduje projektu i zwraca obrazy bez ścieżek', async () => {
    const client = fakeAppClient();
    const harness = await ProtocolHarness.create(client);
    openHarnesses.push(harness);

    const styleBeforeBinding = await harness.callTool('get_style', {});
    expect(styleBeforeBinding).toMatchObject({ isError: true });
    expect(client.call).not.toHaveBeenCalled();

    const projects = await harness.callTool('list_projects', {});
    expect(projects).toMatchObject({
      structuredContent: {
        activeProjectId: FIRST_PROJECT_ID,
        requiresUserSelection: false,
        projects: [
          { projectId: FIRST_PROJECT_ID, name: 'Pierwszy' },
          { projectId: SECOND_PROJECT_ID, name: 'Drugi' },
        ],
      },
    });
    expect(JSON.stringify(projects)).not.toContain('rootPath');
    expect(JSON.stringify(projects)).not.toContain('/Users/artur');

    const binding = await harness.callTool('bind_project', { projectId: FIRST_PROJECT_ID });
    expect(binding).toMatchObject({
      structuredContent: { projectId: FIRST_PROJECT_ID, bound: true },
    });
    expect(client.call).toHaveBeenLastCalledWith('bind_project', { projectId: FIRST_PROJECT_ID });

    expect(await harness.callTool('get_style', {})).toMatchObject({ isError: true });
    const context = await harness.callTool('get_project_context', {});
    expect(context).toMatchObject({
      structuredContent: {
        project: { projectId: FIRST_PROJECT_ID, projection: 'top_down' },
        generation: { selectedGeneratorProviders: ['comfyui'] },
      },
    });
    expect(JSON.stringify(context)).not.toContain('rootPath');

    const reference = await harness.callTool('get_reference', { referenceId: REFERENCE_ID });
    expect(reference).toMatchObject({
      content: [
        { type: 'text' },
        { type: 'image', mimeType: 'image/png', data: Buffer.from('ref').toString('base64') },
      ],
      structuredContent: {
        projectId: FIRST_PROJECT_ID,
        metadata: { referenceId: REFERENCE_ID },
        sizeBytes: 3,
      },
    });
    expect(JSON.stringify(reference)).not.toContain('dataBase64');
    expect(JSON.stringify(reference)).not.toContain('absolutePath');

    const asset = await harness.callTool('get_asset', { assetId: ASSET_ID, versionId: VERSION_ID });
    expect(asset).toMatchObject({
      content: [
        { type: 'text' },
        { type: 'image', mimeType: 'image/png', data: Buffer.from('asset').toString('base64') },
      ],
      structuredContent: {
        metadata: { assetId: ASSET_ID, versionId: VERSION_ID, status: 'needs_review' },
      },
    });

    const generation = await harness.callTool('generate_asset', {
      request: {
        name: 'Bohater',
        category: 'character',
        prompt: 'Postać w czterech kierunkach.',
        characterAnimation: { framesPerSecond: 8 },
      },
      referenceIds: [REFERENCE_ID],
    });
    expect(generation).toMatchObject({
      structuredContent: {
        result: { projectId: FIRST_PROJECT_ID, jobs: [{ id: JOB_ID, assetId: ASSET_ID }] },
      },
    });
    expect(client.call).toHaveBeenCalledWith('generate_asset', expect.objectContaining({
      request: expect.objectContaining({
        name: 'Bohater',
        mode: 'generate',
        footprint: { x: 1, y: 1 },
        characterAnimation: { action: 'walk', framesPerDirection: 4, framesPerSecond: 8 },
      }),
      referenceIds: [REFERENCE_ID],
    }));

    const status = await harness.callTool('get_generation_status', { jobIds: [JOB_ID] });
    expect(status).toMatchObject({
      structuredContent: {
        projectId: FIRST_PROJECT_ID,
        jobs: [{ id: JOB_ID, status: 'needs_review' }],
      },
    });
    expect(client.call).toHaveBeenLastCalledWith('get_generation_status', {
      jobIds: [JOB_ID], includeLogs: true, logLimit: 20,
    });
  });

  it('pyta użytkownika tylko przy wielu projektach bez aktywnego projektu', async () => {
    const client = fakeAppClient(false);
    const harness = await ProtocolHarness.create(client);
    openHarnesses.push(harness);

    const projects = await harness.callTool('list_projects', {});
    expect(projects).toMatchObject({
      structuredContent: { activeProjectId: null, requiresUserSelection: true },
    });
    const unconfirmed = await harness.callTool('bind_project', { projectId: FIRST_PROJECT_ID });
    expect(unconfirmed).toMatchObject({ isError: true });
    expect(JSON.stringify(unconfirmed)).toContain('zapytaj użytkownika');
    expect(client.call).toHaveBeenCalledTimes(1);

    await expect(harness.callTool('bind_project', {
      projectId: FIRST_PROJECT_ID,
      confirmedByUser: true,
    })).resolves.toMatchObject({
      structuredContent: { projectId: FIRST_PROJECT_ID, bound: true },
    });
  });
});

function fakeAppClient(activeFirst = true) {
  const context = {
    project: {
      projectId: FIRST_PROJECT_ID,
      name: 'Pierwszy',
      projection: 'top_down',
      rootPath: '/Users/artur/sekret',
      supportedAssetCategories: ['flat_tile', 'character'],
      characterDirections: ['north', 'east', 'south', 'west'],
    },
    style: { summary: 'Pixel art', stale: false },
    registry: { assetCount: 1, approvedAssetCount: 0, referenceCount: 1 },
    generation: {
      selectedGeneratorProviders: ['comfyui'],
      aiVerificationEnabled: true,
      maxConcurrentJobs: 2,
      queueAttached: true,
      statusCounts: { needs_review: 1 },
    },
  };
  const call = vi.fn(async (method: string) => {
    if (method === 'list_projects') {
      return [
        {
          projectId: FIRST_PROJECT_ID, name: 'Pierwszy', active: activeFirst, bound: false,
          rootPath: '/Users/artur/sekret',
        },
        {
          projectId: SECOND_PROJECT_ID, name: 'Drugi', active: false, bound: false,
          rootPath: '/Users/artur/inny-sekret',
        },
      ];
    }
    if (method === 'bind_project' || method === 'get_project_context') return context;
    if (method === 'get_style') {
      return { projectId: FIRST_PROJECT_ID, activeSummary: 'Pixel art', stale: false, history: [] };
    }
    if (method === 'get_reference') {
      return {
        projectId: FIRST_PROJECT_ID,
        metadata: { referenceId: REFERENCE_ID, absolutePath: '/Users/artur/sekret/ref.png' },
        mimeType: 'image/png',
        sizeBytes: 3,
        dataBase64: Buffer.from('ref').toString('base64'),
      };
    }
    if (method === 'get_asset') {
      return {
        projectId: FIRST_PROJECT_ID,
        metadata: {
          assetId: ASSET_ID, versionId: VERSION_ID, status: 'needs_review',
          absolutePath: '/Users/artur/sekret/asset.png',
        },
        mimeType: 'image/png',
        sizeBytes: 5,
        dataBase64: Buffer.from('asset').toString('base64'),
      };
    }
    if (method === 'generate_asset') {
      return { projectId: FIRST_PROJECT_ID, jobs: [{ id: JOB_ID, assetId: ASSET_ID }] };
    }
    if (method === 'get_generation_status') {
      return { projectId: FIRST_PROJECT_ID, jobs: [{ id: JOB_ID, status: 'needs_review' }] };
    }
    return { projectId: FIRST_PROJECT_ID };
  });
  const client: TilemapAppClientContract = {
    connect: vi.fn(async () => undefined),
    call: call as TilemapAppClientContract['call'],
    close: vi.fn(async () => undefined),
  };
  return Object.assign(client, { call });
}

class ProtocolHarness {
  private nextId = 10;
  private readonly responses = new Map<string | number, (message: Record<string, unknown>) => void>();

  private constructor(
    private readonly server: ReturnType<typeof createTilemapMcpServer>,
    private readonly clientTransport: InMemoryTransport,
    readonly initializeResult: Record<string, unknown>,
  ) {}

  static async create(client: TilemapAppClientContract): Promise<ProtocolHarness> {
    const server = createTilemapMcpServer(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const pendingMessages: Record<string, unknown>[] = [];
    clientTransport.onmessage = (message) => pendingMessages.push(expectRecord(message));
    await clientTransport.start();
    await server.connect(serverTransport);
    const initializeId = 1;
    await clientTransport.send({
      jsonrpc: '2.0',
      id: initializeId,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'tilemap-generator-test', version: '1.0.0' },
      },
    } as JSONRPCMessage);
    const initializeMessage = await waitUntil(() => pendingMessages.find((message) => message.id === initializeId));
    const initializeResult = expectRecord(initializeMessage.result);
    await clientTransport.send({
      jsonrpc: '2.0', method: 'notifications/initialized', params: {},
    } as JSONRPCMessage);
    const harness = new ProtocolHarness(server, clientTransport, initializeResult);
    clientTransport.onmessage = (message) => harness.accept(expectRecord(message));
    return harness;
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const response = new Promise<Record<string, unknown>>((resolve) => this.responses.set(id, resolve));
    await this.clientTransport.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage);
    const message = await response;
    if ('error' in message) throw new Error(JSON.stringify(message.error));
    return message.result;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return expectRecord(await this.request('tools/call', { name, arguments: args }));
  }

  async close(): Promise<void> {
    await this.server.close();
    await this.clientTransport.close();
  }

  private accept(message: Record<string, unknown>): void {
    if (typeof message.id !== 'string' && typeof message.id !== 'number') return;
    const resolve = this.responses.get(message.id);
    if (!resolve) return;
    this.responses.delete(message.id);
    resolve(message);
  }
}

function expectRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf('object');
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

async function waitUntil<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('MCP protocol response timeout.');
}
