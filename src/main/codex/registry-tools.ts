import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { assetCategories, createProjectSettingsProposalSchema, versionStatuses } from '../../shared/domain';
import type { ProjectDatabase } from '../db/project-database';

const searchSchema = z.object({
  query: z.string().max(500).optional(),
  category: z.enum(assetCategories).optional(),
  tags: z.array(z.string().max(60)).max(20).optional(),
  statuses: z.array(z.enum(versionStatuses)).max(8).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const getSchema = z.object({ assetId: z.string().uuid(), versionId: z.string().uuid().optional() });
const getReferenceSchema = z.object({ referenceId: z.string().uuid() });

export const registryDynamicTools = [{
  type: 'namespace',
  name: 'registry',
  description: 'Access to the current Tilemap Generator project registry. Project changes can only be proposed; the user must approve them in the app.',
  tools: [
    {
      type: 'function',
      name: 'list_tags',
      description: 'List the fixed categories and tags already used in the current project.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      type: 'function',
      name: 'get_generation_settings',
      description: 'Read the character frame requirement, enabled image generators, and selected ComfyUI profile for the current project.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      type: 'function',
      name: 'search_assets',
      description: 'Search project assets by text, category, tags, and review status. Defaults to approved versions.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          category: { type: 'string', enum: assetCategories },
          tags: { type: 'array', items: { type: 'string' }, maxItems: 20 },
          statuses: { type: 'array', items: { type: 'string', enum: versionStatuses }, maxItems: 8 },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'get_asset',
      description: 'Load one asset version as metadata and an image reference. The approved current version is used by default.',
      inputSchema: {
        type: 'object',
        properties: { assetId: { type: 'string', format: 'uuid' }, versionId: { type: 'string', format: 'uuid' } },
        required: ['assetId'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'list_references',
      description: 'List project reference images and their user-authored descriptions without loading image bytes.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      type: 'function',
      name: 'get_reference',
      description: 'Load one project reference image and its user-authored description.',
      inputSchema: {
        type: 'object',
        properties: { referenceId: { type: 'string', format: 'uuid' } },
        required: ['referenceId'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'propose_project_settings',
      description: 'Submit a project-settings change proposal for explicit user approval. This never changes the project directly.',
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', minLength: 10, maxLength: 4000 },
          settings: {
            type: 'object',
            properties: {
              artBrief: { type: 'string', maxLength: 12000 },
              tileWidthPx: { type: 'integer', minimum: 16, maximum: 4096 },
              pixelsPerUnit: { type: 'integer', minimum: 1, maximum: 4096 },
              characterFramesPerDirection: { type: 'integer', minimum: 2, maximum: 16 },
              codexGenerationEnabled: { type: 'boolean' },
              comfyUiEnabled: { type: 'boolean' },
              comfyUiProfile: { type: 'string', enum: ['z_image_turbo'] },
              stableDiffusionCppEnabled: { type: 'boolean' },
            },
            minProperties: 1,
            additionalProperties: false,
          },
          referenceIds: { type: 'array', items: { type: 'string', format: 'uuid' }, maxItems: 20 },
        },
        required: ['reason', 'settings'],
        additionalProperties: false,
      },
    },
  ],
}];

export async function handleRegistryTool(database: ProjectDatabase, params: Record<string, unknown>): Promise<unknown> {
  if (params.namespace !== 'registry') throw new Error('Nieznany namespace dynamicznego toola.');
  const tool = String(params.tool);
  const args = (params.arguments ?? {}) as unknown;
  if (tool === 'list_tags') {
    return textResult({ categories: assetCategories, tags: database.listTags() });
  }
  if (tool === 'get_generation_settings') {
    const project = database.getProject();
    return textResult({
      characterFramesPerDirection: project.characterFramesPerDirection,
      codexGenerationEnabled: project.codexGenerationEnabled,
      comfyUiEnabled: project.comfyUiEnabled,
      comfyUiProfile: project.comfyUiProfile,
      stableDiffusionCppEnabled: project.stableDiffusionCppEnabled,
    });
  }
  if (tool === 'search_assets') {
    return textResult({ assets: database.searchAssets(searchSchema.parse(args)) });
  }
  if (tool === 'get_asset') {
    const input = getSchema.parse(args);
    const result = database.getAssetToolData(input.assetId, input.versionId);
    if (statSync(result.absolutePath).size > 15 * 1024 * 1024) {
      throw new Error('Obraz przekracza limit 15 MB dla kontekstu agenta.');
    }
    const imageUrl = `data:image/png;base64,${readFileSync(result.absolutePath).toString('base64')}`;
    return {
      success: true,
      contentItems: [
        { type: 'inputText', text: JSON.stringify(result.metadata) },
        { type: 'inputImage', imageUrl },
      ],
    };
  }
  if (tool === 'list_references') {
    return textResult({ references: database.listProjectReferences().map((reference) => ({
      referenceId: reference.id,
      name: reference.name,
      description: reference.description,
      width: reference.width,
      height: reference.height,
    })) });
  }
  if (tool === 'get_reference') {
    const input = getReferenceSchema.parse(args);
    const result = database.getProjectReferenceToolData(input.referenceId);
    if (statSync(result.absolutePath).size > 15 * 1024 * 1024) {
      throw new Error('Obraz referencyjny przekracza limit 15 MB dla kontekstu agenta.');
    }
    return {
      success: true,
      contentItems: [
        { type: 'inputText', text: JSON.stringify(result.metadata) },
        { type: 'inputImage', imageUrl: `data:image/png;base64,${readFileSync(result.absolutePath).toString('base64')}` },
      ],
    };
  }
  if (tool === 'propose_project_settings') {
    const proposal = database.createProjectSettingsProposal(createProjectSettingsProposalSchema.parse(args));
    return textResult({
      proposalId: proposal.id,
      status: proposal.status,
      message: 'Propozycja oczekuje na decyzję użytkownika. Ustawienia projektu nie zostały zmienione.',
    });
  }
  throw new Error(`Nieznany tool registry: ${tool}`);
}

function textResult(value: unknown): unknown {
  return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] };
}
