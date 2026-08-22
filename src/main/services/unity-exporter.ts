import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  assetPixelSize,
  isTileAssetCategory,
  roadConnectionLabels,
  type ExportFilePreview,
  type ExportPreview,
  type ExportPreviewInput,
} from '../../shared/domain';
import type { ProjectDatabase } from '../db/project-database';
import { slugify } from './project-manager';
import {
  ensureTerrainBlendAtlas,
  type TerrainBlendAtlasResult,
} from './terrain-blend-generator';
import terrainBlendEditorSource from '../unity-package/TerrainBlendImporter.cs?raw';
import terrainBlendBrushSource from '../unity-package/TerrainBlendBrush.cs?raw';
import terrainBlendEditorAsmdef from '../unity-package/TilemapGenerator.TerrainBlend.Editor.asmdef?raw';
import terrainBlendDefinitionSource from '../unity-package/TerrainBlendDefinition.cs?raw';
import terrainBlendMapSource from '../unity-package/TerrainBlendMap.cs?raw';
import terrainBlendRuleTileSource from '../unity-package/TerrainBlendRuleTile.cs?raw';
import terrainBlendRuntimeSource from '../unity-package/TerrainBlendRuntime.cs?raw';
import terrainBlendRuntimeAsmdef from '../unity-package/TilemapGenerator.TerrainBlend.Runtime.asmdef?raw';
import terrainBlendSetSource from '../unity-package/TerrainBlendSet.cs?raw';
import terrainBlendSupportTileSource from '../unity-package/TerrainBlendSupportTile.cs?raw';
import buildingDefinitionSource from '../unity-package/BuildingDefinition.cs?raw';
import buildingInstanceSource from '../unity-package/BuildingInstance.cs?raw';
import buildingMapSource from '../unity-package/BuildingMap.cs?raw';
import buildingPlacementBrushSource from '../unity-package/BuildingPlacementBrush.cs?raw';
import buildingSetSource from '../unity-package/BuildingSet.cs?raw';

interface PendingExport {
  preview: ExportPreview;
  manifest: Record<string, unknown>;
  generatedFiles: Map<string, string>;
  createdAt: number;
}

export class UnityExporter {
  private readonly pending = new Map<string, PendingExport>();

  async preview(
    database: ProjectDatabase,
    input: ExportPreviewInput,
    isGranted: (path: string) => boolean,
  ): Promise<ExportPreview> {
    const assetsDirectory = path.resolve(input.targetAssetsDirectory);
    if (!isGranted(assetsDirectory)) throw new Error('Katalog eksportu nie został wybrany przez dialog aplikacji.');
    if (!existsSync(assetsDirectory) || !statSync(assetsDirectory).isDirectory()) {
      throw new Error('Katalog Assets nie istnieje.');
    }
    if (path.basename(assetsDirectory).toLocaleLowerCase() !== 'assets') {
      throw new Error('Eksport jest dozwolony wyłącznie do katalogu Assets projektu Unity.');
    }

    const project = database.getProject();
    const exportRoot = path.join(assetsDirectory, 'TilemapGenerator');
    const approved = database.approvedAssets(input.assetIds);
    const terrainBlends = new Map<string, TerrainBlendAtlasResult>();
    await Promise.all(approved.map(async ({ version, absolutePath }) => {
      if (!isTileAssetCategory(version.category)) return;
      terrainBlends.set(version.id, await ensureTerrainBlendAtlas({
        sourcePath: absolutePath,
        tileWidthPx: project.tileWidthPx,
        tileHeightPx: project.tileHeightPx,
      }));
    }));

    const files: ExportFilePreview[] = [];
    for (const { asset, version, absolutePath } of approved) {
      if (version.category === 'road_tile' && version.roadVariants?.length) {
        const setDirectory = `${slugify(asset.name)}--${asset.id.slice(0, 8)}`;
        files.push(...version.roadVariants.map((variant) => {
          const destinationPath = path.join(
            exportRoot,
            version.category,
            setDirectory,
            `road-${variant.connectionMask.toString().padStart(2, '0')}.png`,
          );
          const sourcePath = database.resolveRelative(variant.finalPath);
          let action: 'create' | 'replace' | 'unchanged' = 'create';
          if (existsSync(destinationPath)) action = sameFile(sourcePath, destinationPath) ? 'unchanged' : 'replace';
          return {
            assetId: asset.id,
            versionId: version.id,
            sourcePath,
            destinationPath,
            variantMask: variant.connectionMask,
            role: 'road_variant' as const,
            action,
          };
        }));
        continue;
      }
      const filename = `${slugify(asset.name)}--${asset.id.slice(0, 8)}.png`;
      const destinationPath = path.join(exportRoot, version.category, filename);
      let action: 'create' | 'replace' | 'unchanged' = 'create';
      if (existsSync(destinationPath)) action = sameFile(absolutePath, destinationPath) ? 'unchanged' : 'replace';
      files.push({
        assetId: asset.id,
        versionId: version.id,
        sourcePath: absolutePath,
        destinationPath,
        role: 'asset',
        action,
      });

      const blend = terrainBlends.get(version.id);
      if (blend) {
        const blendDestinationPath = path.join(
          exportRoot,
          version.category,
          `${path.basename(filename, '.png')}--blend.png`,
        );
        let blendAction: 'create' | 'replace' | 'unchanged' = 'create';
        if (existsSync(blendDestinationPath)) {
          blendAction = sameFile(blend.atlasPath, blendDestinationPath) ? 'unchanged' : 'replace';
        }
        files.push({
          assetId: asset.id,
          versionId: version.id,
          sourcePath: blend.atlasPath,
          destinationPath: blendDestinationPath,
          role: 'terrain_blend_atlas',
          action: blendAction,
        });

        const wallDestinationPath = path.join(
          exportRoot,
          version.category,
          `${path.basename(filename, '.png')}--walls.png`,
        );
        let wallAction: 'create' | 'replace' | 'unchanged' = 'create';
        if (existsSync(wallDestinationPath)) {
          wallAction = sameFile(blend.wallPath, wallDestinationPath) ? 'unchanged' : 'replace';
        }
        files.push({
          assetId: asset.id,
          versionId: version.id,
          sourcePath: blend.wallPath,
          destinationPath: wallDestinationPath,
          role: 'terrain_wall',
          action: wallAction,
        });
      }
    }
    const generatedFiles = new Map<string, string>();
    const hasGeneratedUnityAuthoring = terrainBlends.size > 0
      || approved.some(({ version }) => (
        version.category === 'building'
        || (version.category === 'road_tile' && version.roadVariants?.length === 16)
      ));
    if (hasGeneratedUnityAuthoring) {
      const supportFiles = [
        {
          relativePath: path.join('Runtime', 'TerrainBlendRuntime.cs'),
          source: terrainBlendRuntimeSource,
        },
        {
          relativePath: path.join('Runtime', 'TerrainBlendDefinition.cs'),
          source: terrainBlendDefinitionSource,
        },
        {
          relativePath: path.join('Runtime', 'TerrainBlendSet.cs'),
          source: terrainBlendSetSource,
        },
        {
          relativePath: path.join('Runtime', 'TerrainBlendMap.cs'),
          source: terrainBlendMapSource,
        },
        {
          relativePath: path.join('Runtime', 'TerrainBlendRuleTile.cs'),
          source: terrainBlendRuleTileSource,
        },
        {
          relativePath: path.join('Runtime', 'TerrainBlendSupportTile.cs'),
          source: terrainBlendSupportTileSource,
        },
        {
          relativePath: path.join('Runtime', 'BuildingDefinition.cs'),
          source: buildingDefinitionSource,
        },
        {
          relativePath: path.join('Runtime', 'BuildingInstance.cs'),
          source: buildingInstanceSource,
        },
        {
          relativePath: path.join('Runtime', 'BuildingMap.cs'),
          source: buildingMapSource,
        },
        {
          relativePath: path.join('Runtime', 'BuildingSet.cs'),
          source: buildingSetSource,
        },
        {
          relativePath: path.join('Runtime', 'TilemapGenerator.TerrainBlend.Runtime.asmdef'),
          source: terrainBlendRuntimeAsmdef,
        },
        {
          relativePath: path.join('Editor', 'TerrainBlendImporter.cs'),
          source: terrainBlendEditorSource,
        },
        {
          relativePath: path.join('Editor', 'TerrainBlendBrush.cs'),
          source: terrainBlendBrushSource,
        },
        {
          relativePath: path.join('Editor', 'BuildingPlacementBrush.cs'),
          source: buildingPlacementBrushSource,
        },
        {
          relativePath: path.join('Editor', 'TilemapGenerator.TerrainBlend.Editor.asmdef'),
          source: terrainBlendEditorAsmdef,
        },
      ];
      for (const support of supportFiles) {
        const destinationPath = path.join(exportRoot, support.relativePath);
        generatedFiles.set(destinationPath, support.source);
        files.push({
          assetId: project.id,
          versionId: project.id,
          sourcePath: `embedded://${support.relativePath.split(path.sep).join('/')}`,
          destinationPath,
          role: 'unity_support',
          action: fileMatchesContent(destinationPath, support.source) ? 'unchanged'
            : existsSync(destinationPath) ? 'replace' : 'create',
        });
      }
    }
    const manifestPath = path.join(exportRoot, 'tilemap-assets.json');
    const token = randomUUID();
    const preview: ExportPreview = { token, targetAssetsDirectory: assetsDirectory, manifestPath, files };
    const manifest = {
      schemaVersion: 6,
      generatedAt: new Date().toISOString(),
      project: { id: project.id, name: project.name, projection: 'isometric' },
      tile: {
        widthPx: project.tileWidthPx,
        heightPx: project.tileHeightPx,
        pixelsPerUnit: project.pixelsPerUnit,
      },
      assets: approved.map(({ asset, version }) => ({
        id: asset.id,
        versionId: version.id,
        name: asset.name,
        category: version.category,
        elevationLevels: version.elevationLevels,
        relativeSize: { width: version.relativeWidth, height: version.relativeHeight },
        roadVariants: version.category === 'road_tile'
          ? (version.roadVariants ?? []).map((variant) => {
            const file = files.find((candidate) => (
              candidate.assetId === asset.id && candidate.variantMask === variant.connectionMask
            ));
            return {
              mask: variant.connectionMask,
              directions: roadConnectionLabels(variant.connectionMask),
              file: file ? path.relative(exportRoot, file.destinationPath).split(path.sep).join('/') : null,
              width: variant.width,
              height: variant.height,
            };
          })
          : null,
        terrainBlend: terrainBlends.has(version.id)
          ? {
            ...terrainBlends.get(version.id)!.manifest,
            atlasFile: path.relative(
              exportRoot,
              files.find((file) => file.versionId === version.id && file.role === 'terrain_blend_atlas')!.destinationPath,
            ).split(path.sep).join('/'),
            wallFile: path.relative(
              exportRoot,
              files.find((file) => file.versionId === version.id && file.role === 'terrain_wall')!.destinationPath,
            ).split(path.sep).join('/'),
          }
          : null,
        expectedCanvasPx: assetPixelSize(project, version),
        tags: version.tags,
        generatedBy: {
          provider: version.generatorProvider ?? 'codex',
          model: version.generatorModel || (version.generatorProvider === 'codex' ? 'imagegen' : null),
          workflowHash: version.generatorWorkflowHash || null,
          runId: version.providerRunId || null,
          metadata: version.generationMetadata,
        },
        file: version.category === 'road_tile'
          ? null
          : path.relative(
            exportRoot,
            files.find((file) => file.assetId === asset.id && file.role === 'asset')!.destinationPath,
          ).split(path.sep).join('/'),
        width: version.width,
        height: version.height,
        footprintCells: version.footprint,
        pivotNormalized: version.pivot,
        pixelsPerUnit: project.pixelsPerUnit,
      })),
    };
    this.pending.set(token, { preview, manifest, generatedFiles, createdAt: Date.now() });
    this.cleanup();
    return preview;
  }

  run(database: ProjectDatabase, token: string): { exported: number; manifestPath: string } {
    const pending = this.pending.get(token);
    if (!pending || Date.now() - pending.createdAt > 10 * 60_000) {
      throw new Error('Podgląd eksportu wygasł. Wygeneruj go ponownie.');
    }
    for (const file of pending.preview.files) {
      mkdirSync(path.dirname(file.destinationPath), { recursive: true });
      if (file.action === 'unchanged') continue;
      const generatedContent = pending.generatedFiles.get(file.destinationPath);
      if (generatedContent !== undefined) {
        const temporaryPath = `${file.destinationPath}.${pending.preview.token}.tmp`;
        writeFileSync(temporaryPath, generatedContent, 'utf8');
        renameSync(temporaryPath, file.destinationPath);
      } else {
        copyFileSync(file.sourcePath, file.destinationPath);
      }
    }
    mkdirSync(path.dirname(pending.preview.manifestPath), { recursive: true });
    const temporaryManifest = `${pending.preview.manifestPath}.${token}.tmp`;
    writeFileSync(temporaryManifest, JSON.stringify(pending.manifest, null, 2), 'utf8');
    renameSync(temporaryManifest, pending.preview.manifestPath);
    database.setUnityExportPath(pending.preview.targetAssetsDirectory);
    database.recordExport(pending.preview.targetAssetsDirectory, pending.preview.manifestPath, pending.preview.files.length);
    this.pending.delete(token);
    return { exported: pending.preview.files.length, manifestPath: pending.preview.manifestPath };
  }

  private cleanup(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [token, item] of this.pending) if (item.createdAt < cutoff) this.pending.delete(token);
  }
}

function sameFile(left: string, right: string): boolean {
  return digest(left) === digest(right);
}

function digest(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function fileMatchesContent(filePath: string, content: string): boolean {
  return existsSync(filePath) && readFileSync(filePath, 'utf8') === content;
}
