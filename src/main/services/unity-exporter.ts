import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  assetPixelSize,
  characterAnimationFrameSize,
  characterAnimationSheetSize,
  characterDirectionsForProjection,
  isTileAssetCategory,
  roadConnectionLabels,
  type AssetVersion,
  type CharacterDirection,
  type ExportIntegration,
  type ExportIntegrationDescriptor,
  type ExportFilePreview,
  type ExportPreview,
  type ExportPreviewInput,
  type ExportRunResult,
  type ProjectInfo,
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
import characterDefinitionSource from '../unity-package/CharacterDefinition.cs?raw';
import directionalCharacterAnimatorSource from '../unity-package/DirectionalCharacterAnimator.cs?raw';

const EXPORT_SCHEMA_VERSION = 9;
const MANIFEST_NAME = 'tilemap-assets.json';
const UNITY_INTEGRATION_DIRECTORY = 'TilemapGeneratorIntegration';
const UNITY_INTEGRATION_MANIFEST = 'tilemap-generator-integration.json';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const UNITY_SUPPORT_FILES = [
  { relativePath: path.join('Runtime', 'TerrainBlendRuntime.cs'), source: terrainBlendRuntimeSource },
  { relativePath: path.join('Runtime', 'TerrainBlendDefinition.cs'), source: terrainBlendDefinitionSource },
  { relativePath: path.join('Runtime', 'TerrainBlendSet.cs'), source: terrainBlendSetSource },
  { relativePath: path.join('Runtime', 'TerrainBlendMap.cs'), source: terrainBlendMapSource },
  { relativePath: path.join('Runtime', 'TerrainBlendRuleTile.cs'), source: terrainBlendRuleTileSource },
  { relativePath: path.join('Runtime', 'TerrainBlendSupportTile.cs'), source: terrainBlendSupportTileSource },
  { relativePath: path.join('Runtime', 'BuildingDefinition.cs'), source: buildingDefinitionSource },
  { relativePath: path.join('Runtime', 'BuildingInstance.cs'), source: buildingInstanceSource },
  { relativePath: path.join('Runtime', 'BuildingMap.cs'), source: buildingMapSource },
  { relativePath: path.join('Runtime', 'BuildingSet.cs'), source: buildingSetSource },
  { relativePath: path.join('Runtime', 'CharacterDefinition.cs'), source: characterDefinitionSource },
  { relativePath: path.join('Runtime', 'DirectionalCharacterAnimator.cs'), source: directionalCharacterAnimatorSource },
  { relativePath: path.join('Runtime', 'TilemapGenerator.TerrainBlend.Runtime.asmdef'), source: terrainBlendRuntimeAsmdef },
  { relativePath: path.join('Editor', 'TerrainBlendImporter.cs'), source: terrainBlendEditorSource },
  { relativePath: path.join('Editor', 'TerrainBlendBrush.cs'), source: terrainBlendBrushSource },
  { relativePath: path.join('Editor', 'BuildingPlacementBrush.cs'), source: buildingPlacementBrushSource },
  { relativePath: path.join('Editor', 'TilemapGenerator.TerrainBlend.Editor.asmdef'), source: terrainBlendEditorAsmdef },
] as const;

interface UnityTarget {
  targetDirectory: string;
  assetsDirectory: string;
  integrationDirectory: string;
}

interface ExistingDelivery {
  rootDirectory: string;
  manifestPath: string;
  managedFiles: Set<string>;
}

interface PendingExport {
  projectId: string;
  unityTarget: UnityTarget;
  deleteRoots: Map<string, string>;
  destinationSnapshots: Map<string, string | null>;
  sourceSnapshots: Map<string, string>;
  supportPlanned: boolean;
  preview: ExportPreview;
  manifest: Record<string, unknown>;
  generatedFiles: Map<string, string>;
  createdAt: number;
}

export class UnityExporter {
  readonly integration: ExportIntegration = 'unity';
  readonly descriptor: ExportIntegrationDescriptor = {
    id: 'unity',
    label: 'Unity',
    description: 'PNG, manifest oraz narzędzia importu i authoringu dla Unity 2D.',
    targetLabel: 'Katalog docelowy',
  };
  readonly targetDialog = {
    title: 'Wybierz katalog docelowy integracji Unity',
    buttonLabel: 'Wybierz katalog',
  };
  private readonly pending = new Map<string, PendingExport>();

  validateTarget(targetDirectory: string): string {
    return resolveUnityTarget(targetDirectory).targetDirectory;
  }

  async preview(
    database: ProjectDatabase,
    input: ExportPreviewInput,
  ): Promise<ExportPreview> {
    if (input.integration !== this.integration) throw new Error('Nieprawidłowa integracja eksportu Unity.');
    const project = database.getProject();
    const unityTarget = resolveUnityTarget(input.targetDirectory);
    const exportRoot = unityTarget.targetDirectory;
    const manifestPath = path.join(exportRoot, MANIFEST_NAME);
    const currentDelivery = readExistingDelivery(manifestPath, exportRoot, project.id);
    const previousTarget = project.exportTargets.unity;
    const retargetedDelivery = previousTarget && pathKey(previousTarget) !== pathKey(exportRoot)
      ? readRetargetedDelivery(previousTarget, unityTarget, project.id)
      : null;
    const approved = database.approvedAssets(input.assetIds);
    if (project.projection === 'top_down'
      && approved.some(({ version }) => version.category === 'elevated_tile')) {
      throw new Error('Projekt top-down nie obsługuje elevated tile.');
    }
    const terrainBlends = new Map<string, TerrainBlendAtlasResult>();
    await Promise.all(approved.map(async ({ version, absolutePath }) => {
      if (!isTileAssetCategory(version.category)) return;
      terrainBlends.set(version.id, await ensureTerrainBlendAtlas({
        sourcePath: absolutePath,
        tileWidthPx: project.tileWidthPx,
        tileHeightPx: project.tileHeightPx,
        projection: project.projection,
      }));
    }));

    const files: ExportFilePreview[] = [];
    const currentOwnedFiles = currentDelivery?.managedFiles ?? new Set<string>();
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
          return {
            assetId: asset.id,
            versionId: version.id,
            sourcePath,
            destinationPath,
            variantMask: variant.connectionMask,
            role: 'road_variant' as const,
            action: fileAction(exportRoot, sourcePath, destinationPath, currentOwnedFiles, currentDelivery !== null),
          };
        }));
        continue;
      }
      const filename = `${slugify(asset.name)}--${asset.id.slice(0, 8)}.png`;
      const destinationPath = path.join(exportRoot, version.category, filename);
      files.push({
        assetId: asset.id,
        versionId: version.id,
        sourcePath: absolutePath,
        destinationPath,
        role: 'asset',
        action: fileAction(exportRoot, absolutePath, destinationPath, currentOwnedFiles, currentDelivery !== null),
      });

      const blend = terrainBlends.get(version.id);
      if (blend) {
        const blendDestinationPath = path.join(
          exportRoot,
          version.category,
          `${path.basename(filename, '.png')}--blend.png`,
        );
        files.push({
          assetId: asset.id,
          versionId: version.id,
          sourcePath: blend.atlasPath,
          destinationPath: blendDestinationPath,
          role: 'terrain_blend_atlas',
          action: fileAction(exportRoot, blend.atlasPath, blendDestinationPath, currentOwnedFiles, currentDelivery !== null),
        });

        const wallDestinationPath = path.join(
          exportRoot,
          version.category,
          `${path.basename(filename, '.png')}--walls.png`,
        );
        files.push({
          assetId: asset.id,
          versionId: version.id,
          sourcePath: blend.wallPath,
          destinationPath: wallDestinationPath,
          role: 'terrain_wall',
          action: fileAction(exportRoot, blend.wallPath, wallDestinationPath, currentOwnedFiles, currentDelivery !== null),
        });
      }
    }
    const generatedFiles = new Map<string, string>();
    for (const { version } of approved) {
      if (version.category === 'character') assertExportableCharacterAnimation(project, version);
    }
    const hasGeneratedUnityAuthoring = terrainBlends.size > 0
      || approved.some(({ version }) => (
        version.category === 'building'
        || version.category === 'character'
        || (version.category === 'road_tile' && version.roadVariants?.length === 16)
      ));
    if (hasGeneratedUnityAuthoring) {
      planUnitySupportFiles(unityTarget, files, generatedFiles);
    }

    const managedFiles = managedDeliveryFiles(exportRoot, manifestPath, files);
    planStaleDeliveryFiles(currentDelivery, managedFiles, files);
    planRetargetedDeliveryFiles(retargetedDelivery, files);
    const token = randomUUID();
    const preview: ExportPreview = {
      token,
      integration: this.integration,
      targetDirectory: exportRoot,
      manifestPath,
      assetCount: approved.length,
      files,
    };
    const manifest = {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      managedFiles: [...managedFiles]
        .map((managedPath) => toManagedRelativePath(exportRoot, managedPath))
        .sort(),
      project: { id: project.id, name: project.name, projection: project.projection },
      tile: {
        widthPx: project.tileWidthPx,
        heightPx: project.tileHeightPx,
        pixelsPerUnit: project.pixelsPerUnit,
      },
      assets: approved.map(({ asset, version }) => {
        const assetFile = version.category === 'road_tile'
          ? null
          : path.relative(
            exportRoot,
            files.find((file) => file.assetId === asset.id && file.role === 'asset')!.destinationPath,
          ).split(path.sep).join('/');
        return {
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
              directions: roadConnectionLabels(variant.connectionMask, project.projection),
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
        expectedCanvasPx: version.category === 'character' && version.characterAnimation
          ? version.characterAnimation.sheetSize
          : assetPixelSize(project, version),
        tags: version.tags,
        generatedBy: {
          provider: version.generatorProvider ?? 'codex',
          model: version.generatorModel || (version.generatorProvider === 'codex' ? 'imagegen' : null),
          workflowHash: version.generatorWorkflowHash || null,
          runId: version.providerRunId || null,
          metadata: version.generationMetadata,
        },
        file: assetFile,
        characterAnimation: version.category === 'character'
          ? characterAnimationManifest(project, version, assetFile!)
          : null,
        width: version.width,
        height: version.height,
        footprintCells: version.footprint,
        pivotNormalized: version.pivot,
        pixelsPerUnit: project.pixelsPerUnit,
      };
      }),
    };
    const deleteRoots = new Map<string, string>();
    for (const file of files.filter((candidate) => candidate.action === 'delete')) {
      const root = retargetedDelivery && isContainedPath(retargetedDelivery.rootDirectory, file.destinationPath)
        ? retargetedDelivery.rootDirectory
        : isContainedPath(unityTarget.integrationDirectory, file.destinationPath)
          ? unityTarget.integrationDirectory
          : exportRoot;
      deleteRoots.set(pathKey(file.destinationPath), root);
    }
    const destinationSnapshots = snapshotDestinations(
      files,
      manifestPath,
      deleteRoots,
      unityTarget,
    );
    const sourceSnapshots = snapshotSources(files);
    this.pending.set(token, {
      projectId: project.id,
      unityTarget,
      deleteRoots,
      destinationSnapshots,
      sourceSnapshots,
      supportPlanned: hasGeneratedUnityAuthoring,
      preview,
      manifest,
      generatedFiles,
      createdAt: Date.now(),
    });
    this.cleanup();
    return preview;
  }

  run(database: ProjectDatabase, token: string): ExportRunResult {
    const pending = this.pending.get(token);
    if (!pending || Date.now() - pending.createdAt > 10 * 60_000) {
      throw new Error('Podgląd eksportu wygasł. Wygeneruj go ponownie.');
    }
    if (pending.projectId !== database.getProject().id) {
      throw new Error('Podgląd eksportu należy do innego projektu. Przygotuj go ponownie.');
    }
    const currentTarget = resolveUnityTarget(pending.preview.targetDirectory);
    if (pathKey(currentTarget.targetDirectory) !== pathKey(pending.unityTarget.targetDirectory)
      || pathKey(currentTarget.assetsDirectory) !== pathKey(pending.unityTarget.assetsDirectory)) {
      throw new Error('Katalog docelowy Unity zmienił się od przygotowania podglądu. Przygotuj eksport ponownie.');
    }
    if (pending.supportPlanned) {
      readIntegrationOwnership(
        pending.unityTarget.integrationDirectory,
        path.join(pending.unityTarget.integrationDirectory, UNITY_INTEGRATION_MANIFEST),
      );
    }
    assertSourceSnapshots(pending);
    assertDestinationSnapshots(pending);

    for (const file of pending.preview.files) {
      if (file.action === 'delete') {
        const deleteRoot = pending.deleteRoots.get(pathKey(file.destinationPath));
        if (!deleteRoot) throw new Error('Plan usunięcia wykracza poza zarządzane katalogi eksportu.');
        if (existsSync(file.destinationPath)) assertSafeManagedFile(deleteRoot, file.destinationPath, true);
      } else {
        const writeRoot = file.role === 'integration_support'
          ? pending.unityTarget.integrationDirectory
          : pending.unityTarget.targetDirectory;
        assertSafeDestination(writeRoot, file.destinationPath);
      }
    }

    const filesystemCommit = commitPendingExport(pending);
    try {
      database.commitExport(
        this.integration,
        pending.preview.targetDirectory,
        pending.preview.manifestPath,
        pending.preview.assetCount,
      );
    } catch (error) {
      try {
        filesystemCommit.rollback();
      } catch (rollbackError) {
        throw new Error(
          `Nie zapisano historii eksportu i nie udało się w pełni przywrócić plików: ${errorMessage(rollbackError)}. Błąd bazy: ${errorMessage(error)}`,
        );
      }
      throw error;
    }
    filesystemCommit.finalize();
    this.pending.delete(token);
    return {
      assetCount: pending.preview.assetCount,
      fileCount: pending.preview.files.length,
      writtenFileCount: filesystemCommit.writtenFileCount,
      manifestPath: pending.preview.manifestPath,
    };
  }

  private cleanup(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [token, item] of this.pending) if (item.createdAt < cutoff) this.pending.delete(token);
  }
}

function assertExportableCharacterAnimation(
  project: ProjectInfo,
  version: AssetVersion,
): asserts version is AssetVersion & { characterAnimation: NonNullable<AssetVersion['characterAnimation']> } {
  const animation = version.characterAnimation;
  if (!animation) {
    throw new Error('Zatwierdzona postać nie zawiera kompletnego arkusza animacji v1.');
  }
  const expectedDirections = characterDirectionsForProjection(project.projection);
  if (animation.settings.action !== 'walk'
    || !Number.isInteger(animation.settings.framesPerDirection)
    || animation.settings.framesPerDirection < 2
    || animation.settings.framesPerDirection > 16
    || !Number.isInteger(animation.settings.framesPerSecond)
    || animation.settings.framesPerSecond < 1
    || animation.settings.framesPerSecond > 24) {
    throw new Error('Animacja postaci ma nieobsługiwane ustawienia. Unity wymaga walk v1: idle oraz 2–16 klatek chodu na kierunek.');
  }
  const expectedFrame = characterAnimationFrameSize(project, version);
  const expectedSheet = characterAnimationSheetSize(expectedFrame, animation.settings);
  if (animation.frameSize.width !== expectedFrame.width
    || animation.frameSize.height !== expectedFrame.height
    || animation.sheetSize.width !== expectedSheet.width
    || animation.sheetSize.height !== expectedSheet.height
    || version.width !== expectedSheet.width
    || version.height !== expectedSheet.height) {
    throw new Error(
      `Arkusz zatwierdzonej postaci nie odpowiada wymiarom klatki i układowi ${animation.settings.framesPerDirection + 1}×4.`,
    );
  }
  if (!sameCharacterDirections(animation.directions, expectedDirections)) {
    throw new Error('Arkusz postaci nie zawiera dokładnego zestawu kierunków bieżącej projekcji.');
  }
  const analysis = animation.movementAnalysis;
  if (analysis.status !== 'passed'
    || !analysis.summary.trim()
    || !analysis.turnId?.trim()
    || !analysis.analyzedAt
    || Number.isNaN(Date.parse(analysis.analyzedAt))
    || analysis.directions.length !== expectedDirections.length
    || analysis.directions.some((item, index) => (
      item.direction !== expectedDirections[index].id
      || item.status !== 'passed'
      || !item.message.trim()
    ))) {
    throw new Error('Eksport postaci jest zablokowany: końcowa analiza ruchu nie potwierdza wszystkich kierunków.');
  }
}

function sameCharacterDirections(
  actual: readonly CharacterDirection[],
  expected: readonly CharacterDirection[],
): boolean {
  return actual.length === expected.length && actual.every((direction, index) => {
    const target = expected[index];
    return direction.id === target.id
      && direction.shortLabel === target.shortLabel
      && direction.screenDelta.x === target.screenDelta.x
      && direction.screenDelta.y === target.screenDelta.y
      && direction.gridDelta.x === target.gridDelta.x
      && direction.gridDelta.y === target.gridDelta.y;
  });
}

function characterAnimationManifest(
  project: ProjectInfo,
  version: AssetVersion,
  sheetFile: string,
): Record<string, unknown> {
  assertExportableCharacterAnimation(project, version);
  const animation = version.characterAnimation;
  const frameRect = (row: number, column: number) => ({
    x: column * animation.frameSize.width,
    y: row * animation.frameSize.height,
    width: animation.frameSize.width,
    height: animation.frameSize.height,
  });
  const directions = characterDirectionsForProjection(project.projection).map((direction, row) => ({
    id: direction.id,
    label: direction.shortLabel,
    row,
    screenDelta: direction.screenDelta,
    gridDelta: direction.gridDelta,
  }));
  const clips = directions.flatMap((direction) => [
    {
      id: `idle_${direction.id}`,
      action: 'idle',
      direction: direction.id,
      framesPerSecond: animation.settings.framesPerSecond,
      loop: true,
      frames: [{ index: 0, column: 0, row: direction.row, rectPx: frameRect(direction.row, 0) }],
    },
    {
      id: `walk_${direction.id}`,
      action: 'walk',
      direction: direction.id,
      framesPerSecond: animation.settings.framesPerSecond,
      loop: true,
      frames: Array.from({ length: animation.settings.framesPerDirection }, (_, frameIndex) => ({
        index: frameIndex,
        column: frameIndex + 1,
        row: direction.row,
        rectPx: frameRect(direction.row, frameIndex + 1),
      })),
    },
  ]);
  return {
    schemaVersion: 1,
    settings: animation.settings,
    sheet: {
      file: sheetFile,
      widthPx: animation.sheetSize.width,
      heightPx: animation.sheetSize.height,
      frameWidthPx: animation.frameSize.width,
      frameHeightPx: animation.frameSize.height,
      columns: animation.settings.framesPerDirection + 1,
      rows: 4,
      origin: 'top_left',
    },
    directions,
    clips,
    sharedPivotNormalized: version.pivot,
    movementAnalysis: {
      status: 'passed',
      summary: animation.movementAnalysis.summary,
      directions: animation.movementAnalysis.directions,
      analyzer: {
        provider: 'codex',
        turnId: animation.movementAnalysis.turnId,
        analyzedAt: animation.movementAnalysis.analyzedAt,
      },
    },
  };
}

function resolveUnityTarget(targetDirectory: string): UnityTarget {
  const resolved = path.resolve(targetDirectory);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error('Katalog docelowy integracji Unity nie istnieje.');
  }
  const canonicalTarget = realpathSync.native(resolved);
  const assetsDirectory = findUnityAssetsDirectory(canonicalTarget);
  if (!assetsDirectory) {
    throw new Error(
      'Katalog docelowy musi znajdować się w Assets projektu Unity zawierającego ProjectSettings/ProjectVersion.txt.',
    );
  }
  const integrationDirectory = path.join(assetsDirectory, UNITY_INTEGRATION_DIRECTORY);
  if (isContainedPath(integrationDirectory, canonicalTarget)) {
    throw new Error(`Katalog ${UNITY_INTEGRATION_DIRECTORY} jest zarezerwowany dla plików integracji Unity.`);
  }
  return { targetDirectory: canonicalTarget, assetsDirectory, integrationDirectory };
}

function findUnityAssetsDirectory(candidate: string): string | null {
  let current = path.resolve(candidate);
  while (true) {
    if (path.basename(current) === 'Assets') {
      const marker = path.join(path.dirname(current), 'ProjectSettings', 'ProjectVersion.txt');
      if (existsSync(marker)) {
        const markerInfo = lstatSync(marker);
        if (markerInfo.isFile() && !markerInfo.isSymbolicLink()) return realpathSync.native(current);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readRetargetedDelivery(
  previousTarget: string,
  currentTarget: UnityTarget,
  projectId: string,
): ExistingDelivery | null {
  const resolvedPrevious = path.resolve(previousTarget);
  if (!existsSync(resolvedPrevious)) return null;
  if (!statSync(resolvedPrevious).isDirectory()) {
    throw new Error('Poprzedni cel eksportu Unity nie jest katalogiem; automatyczne przeniesienie zostało zablokowane.');
  }
  const canonicalPrevious = realpathSync.native(resolvedPrevious);
  if (pathKey(canonicalPrevious) === pathKey(currentTarget.targetDirectory)) return null;
  const previousAssets = findUnityAssetsDirectory(canonicalPrevious);
  if (!previousAssets) {
    throw new Error('Nie można potwierdzić projektu Unity poprzedniego celu eksportu. Wybierz poprzedni cel i usuń delivery ręcznie.');
  }
  if (pathKey(previousAssets) !== pathKey(currentTarget.assetsDirectory)) return null;
  if (pathsOverlap(canonicalPrevious, currentTarget.targetDirectory)) {
    throw new Error('Stary i nowy cel eksportu nakładają się. Wybierz niezależne katalogi w Assets.');
  }
  const oldManifestPath = path.join(canonicalPrevious, MANIFEST_NAME);
  if (!existsSync(oldManifestPath)) {
    throw new Error('Poprzedni cel w tym samym projekcie Unity nie ma wiarygodnego manifestu własności. Usuń go ręcznie przed zmianą celu.');
  }
  const delivery = readExistingDelivery(oldManifestPath, canonicalPrevious, projectId);
  if (!delivery) throw new Error('Nie udało się potwierdzić własności poprzedniego delivery Unity.');
  return delivery;
}

function readExistingDelivery(
  manifestPath: string,
  rootDirectory: string,
  projectId: string,
): ExistingDelivery | null {
  if (!existsSync(manifestPath)) return null;
  assertSafeManagedFile(rootDirectory, manifestPath, true);
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root');
    manifest = parsed as Record<string, unknown>;
  } catch {
    throw new Error(`Manifest ${manifestPath} jest nieczytelny. Eksport został zablokowany, aby nie nadpisać obcych plików.`);
  }

  if (manifest.schemaVersion !== EXPORT_SCHEMA_VERSION) {
    throw new Error(`Manifest ${manifestPath} ma nieobsługiwany schemaVersion ${String(manifest.schemaVersion)}; automatyczna synchronizacja została zablokowana.`);
  }
  const manifestProject = asRecord(manifest.project, 'project');
  const manifestProjectId = manifestProject.id;
  if (typeof manifestProjectId !== 'string'
    || !UUID_PATTERN.test(manifestProjectId)
    || manifestProjectId !== projectId) {
    throw new Error(`Manifest ${manifestPath} należy do innego projektu. Wybierz pusty katalog docelowy.`);
  }

  const relativeFiles = readCurrentManagedFiles(manifest);
  const managedFiles = new Set(relativeFiles.map((relativePath) => (
    resolveManagedPath(rootDirectory, relativePath)
  )));
  return {
    rootDirectory,
    manifestPath,
    managedFiles,
  };
}

function readCurrentManagedFiles(manifest: Record<string, unknown>): string[] {
  if (!Array.isArray(manifest.managedFiles)) throw new Error('Manifest v9 nie zawiera listy managedFiles.');
  const managedFiles = manifest.managedFiles.map((candidate) => validateManagedRelativePath(candidate));
  if (!managedFiles.includes(MANIFEST_NAME)) throw new Error('Manifest v9 nie deklaruje własności własnego pliku.');
  const uniqueFiles = [...new Set(managedFiles)];
  if (uniqueFiles.length !== managedFiles.length) throw new Error('Manifest v9 zawiera powtórzone ścieżki managedFiles.');
  return uniqueFiles;
}

function validateManagedRelativePath(candidate: unknown): string {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0') || candidate.includes('\\')
    || candidate.includes(':') || path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) {
    throw new Error('Manifest zawiera niebezpieczną ścieżkę managedFiles.');
  }
  const segments = candidate.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Manifest zawiera niebezpieczny segment ścieżki managedFiles.');
  }
  const rootSegment = segments[0].toLowerCase();
  if (rootSegment === 'generated'
    || rootSegment === UNITY_INTEGRATION_DIRECTORY.toLowerCase()
    || candidate.toLowerCase().endsWith('.meta')) {
    throw new Error('Manifest próbuje zarządzać plikiem Unity, którego generator nie może usuwać.');
  }
  return candidate;
}

function resolveManagedPath(rootDirectory: string, relativePath: string): string {
  const validated = validateManagedRelativePath(relativePath);
  const resolved = path.resolve(rootDirectory, ...validated.split('/'));
  if (!isContainedPath(rootDirectory, resolved)) throw new Error('Plik zarządzany wykracza poza katalog delivery.');
  return resolved;
}

function managedDeliveryFiles(
  exportRoot: string,
  manifestPath: string,
  files: ExportFilePreview[],
): Set<string> {
  const managed = new Set<string>([manifestPath]);
  for (const file of files) {
    if (file.action === 'delete' || file.role === 'integration_support') continue;
    if (!isContainedPath(exportRoot, file.destinationPath)) {
      throw new Error('Plan delivery wykracza poza wybrany katalog docelowy.');
    }
    managed.add(file.destinationPath);
  }
  return managed;
}

function planStaleDeliveryFiles(
  existing: ExistingDelivery | null,
  desiredFiles: Set<string>,
  files: ExportFilePreview[],
): void {
  if (!existing) return;
  for (const ownedPath of existing.managedFiles) {
    if (desiredFiles.has(ownedPath) || !existsSync(ownedPath)) continue;
    planDelete(existing.rootDirectory, ownedPath, files);
  }
}

function planRetargetedDeliveryFiles(existing: ExistingDelivery | null, files: ExportFilePreview[]): void {
  if (!existing) return;
  for (const ownedPath of existing.managedFiles) {
    if (!existsSync(ownedPath)) continue;
    planDelete(existing.rootDirectory, ownedPath, files);
  }
}

function planDelete(rootDirectory: string, destinationPath: string, files: ExportFilePreview[]): void {
  assertSafeManagedFile(rootDirectory, destinationPath, true);
  if (files.some((file) => pathKey(file.destinationPath) === pathKey(destinationPath))) return;
  files.push({
    assetId: null,
    versionId: null,
    sourcePath: null,
    destinationPath,
    action: 'delete',
  });
}

function planUnitySupportFiles(
  target: UnityTarget,
  files: ExportFilePreview[],
  generatedFiles: Map<string, string>,
): void {
  const supportRoot = target.integrationDirectory;
  const markerPath = path.join(supportRoot, UNITY_INTEGRATION_MANIFEST);
  const existingOwnership = readIntegrationOwnership(supportRoot, markerPath);
  const hasOwnership = existingOwnership !== null;
  const desiredRelativePaths = unitySupportManagedFiles();

  for (const support of UNITY_SUPPORT_FILES) {
    const destinationPath = path.join(supportRoot, support.relativePath);
    generatedFiles.set(destinationPath, support.source);
    files.push({
      assetId: null,
      versionId: null,
      sourcePath: `embedded://${support.relativePath.split(path.sep).join('/')}`,
      destinationPath,
      role: 'integration_support',
      action: contentAction(
        supportRoot,
        support.source,
        destinationPath,
        existingOwnership?.managedFiles ?? new Set(),
        hasOwnership,
      ),
    });
  }

  const markerContent = JSON.stringify({
    schemaVersion: 1,
    owner: 'tilemap-generator',
    integration: 'unity',
    managedFiles: desiredRelativePaths,
  }, null, 2);
  generatedFiles.set(markerPath, markerContent);
  files.push({
    assetId: null,
    versionId: null,
    sourcePath: `embedded://${UNITY_INTEGRATION_MANIFEST}`,
    destinationPath: markerPath,
    role: 'integration_support',
    action: contentAction(
      supportRoot,
      markerContent,
      markerPath,
      existingOwnership?.managedFiles ?? new Set(),
      hasOwnership,
    ),
  });
}

function readIntegrationOwnership(
  supportRoot: string,
  markerPath: string,
): { managedFiles: Set<string> } | null {
  if (!existsSync(supportRoot)) return null;
  if (!statSync(supportRoot).isDirectory() || lstatSync(supportRoot).isSymbolicLink()) {
    throw new Error(`Katalog ${UNITY_INTEGRATION_DIRECTORY} nie jest bezpiecznym katalogiem integracji.`);
  }
  if (!existsSync(markerPath)) {
    if (readdirSync(supportRoot).length === 0) return null;
    throw new Error(`Katalog ${UNITY_INTEGRATION_DIRECTORY} zawiera obce pliki bez manifestu własności.`);
  }
  assertSafeManagedFile(supportRoot, markerPath, true);
  let parsedMarker: unknown;
  try {
    parsedMarker = JSON.parse(readFileSync(markerPath, 'utf8')) as unknown;
  } catch {
    throw new Error(`Manifest integracji ${markerPath} jest nieczytelny; eksport został zablokowany.`);
  }
  const marker = asRecord(parsedMarker, 'integracji');
  if (marker.schemaVersion !== 1 || marker.owner !== 'tilemap-generator' || marker.integration !== 'unity'
    || !Array.isArray(marker.managedFiles)) {
    throw new Error(`Manifest integracji ${markerPath} nie potwierdza własności Tilemap Generator.`);
  }
  const relativeFiles = marker.managedFiles.map((candidate) => validateManagedRelativePath(candidate));
  const expectedFiles = unitySupportManagedFiles();
  const actualFiles = [...new Set(relativeFiles)].sort();
  if (relativeFiles.length !== expectedFiles.length
    || actualFiles.length !== expectedFiles.length
    || actualFiles.some((relativePath, index) => relativePath !== expectedFiles[index])) {
    throw new Error(`Manifest integracji ${markerPath} nie zawiera dokładnej listy plików bieżącej integracji Unity.`);
  }
  return {
    managedFiles: new Set(relativeFiles.map((relativePath) => resolveManagedPath(supportRoot, relativePath))),
  };
}

function unitySupportManagedFiles(): string[] {
  return [
    ...UNITY_SUPPORT_FILES.map((support) => support.relativePath.split(path.sep).join('/')),
    UNITY_INTEGRATION_MANIFEST,
  ].sort();
}

function fileAction(
  rootDirectory: string,
  sourcePath: string,
  destinationPath: string,
  ownedFiles: Set<string>,
  hasManifest: boolean,
): 'create' | 'replace' | 'unchanged' {
  if (!existsSync(destinationPath)) return 'create';
  assertSafeManagedFile(rootDirectory, destinationPath, true);
  if (!hasManifest || !ownedFiles.has(destinationPath)) {
    throw new Error(`Plik ${destinationPath} już istnieje, ale manifest nie potwierdza własności generatora.`);
  }
  if (sameFile(sourcePath, destinationPath)) return 'unchanged';
  return 'replace';
}

function contentAction(
  rootDirectory: string,
  content: string,
  destinationPath: string,
  ownedFiles: Set<string>,
  hasManifest: boolean,
): 'create' | 'replace' | 'unchanged' {
  if (!existsSync(destinationPath)) return 'create';
  assertSafeManagedFile(rootDirectory, destinationPath, true);
  if (!hasManifest || !ownedFiles.has(destinationPath)) {
    throw new Error(`Plik integracji ${destinationPath} istnieje bez potwierdzonej własności generatora.`);
  }
  if (fileMatchesContent(destinationPath, content)) return 'unchanged';
  return 'replace';
}

function toManagedRelativePath(rootDirectory: string, filePath: string): string {
  if (!isContainedPath(rootDirectory, filePath)) throw new Error('Plik manifestu wykracza poza delivery.');
  return validateManagedRelativePath(path.relative(rootDirectory, filePath).split(path.sep).join('/'));
}

function snapshotDestinations(
  files: ExportFilePreview[],
  manifestPath: string,
  deleteRoots: Map<string, string>,
  target: UnityTarget,
): Map<string, string | null> {
  const snapshots = new Map<string, string | null>();
  for (const file of files) {
    const rootDirectory = file.action === 'delete'
      ? deleteRoots.get(pathKey(file.destinationPath))
      : file.role === 'integration_support'
        ? target.integrationDirectory
        : target.targetDirectory;
    if (!rootDirectory) throw new Error('Plan eksportu nie określa bezpiecznego katalogu operacji.');
    snapshots.set(file.destinationPath, snapshotDestination(rootDirectory, file.destinationPath));
  }
  snapshots.set(manifestPath, snapshotDestination(target.targetDirectory, manifestPath));
  return snapshots;
}

function snapshotDestination(rootDirectory: string, destinationPath: string): string | null {
  if (!existsSync(destinationPath)) {
    assertSafeDestination(rootDirectory, destinationPath);
    return null;
  }
  assertSafeManagedFile(rootDirectory, destinationPath, true);
  return digest(destinationPath);
}

function snapshotSources(files: ExportFilePreview[]): Map<string, string> {
  const snapshots = new Map<string, string>();
  for (const file of files) {
    if (file.action === 'delete' || file.role === 'integration_support' || !file.sourcePath) continue;
    const info = lstatSync(file.sourcePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Plik źródłowy eksportu nie jest bezpiecznym zwykłym plikiem: ${file.sourcePath}`);
    }
    snapshots.set(file.sourcePath, digest(file.sourcePath));
  }
  return snapshots;
}

function assertSourceSnapshots(pending: PendingExport): void {
  for (const [sourcePath, expectedDigest] of pending.sourceSnapshots) {
    if (!existsSync(sourcePath)) {
      throw new Error('Pliki źródłowe zmieniły się od przygotowania podglądu. Przygotuj eksport ponownie.');
    }
    const info = lstatSync(sourcePath);
    if (!info.isFile() || info.isSymbolicLink() || digest(sourcePath) !== expectedDigest) {
      throw new Error('Pliki źródłowe zmieniły się od przygotowania podglądu. Przygotuj eksport ponownie.');
    }
  }
}

function assertDestinationSnapshots(pending: PendingExport): void {
  for (const [destinationPath, expectedDigest] of pending.destinationSnapshots) {
    const file = pending.preview.files.find((candidate) => (
      pathKey(candidate.destinationPath) === pathKey(destinationPath)
    ));
    const rootDirectory = file?.action === 'delete'
      ? pending.deleteRoots.get(pathKey(destinationPath))
      : file?.role === 'integration_support'
        ? pending.unityTarget.integrationDirectory
        : pending.unityTarget.targetDirectory;
    if (!rootDirectory) throw new Error('Plan eksportu nie określa bezpiecznego katalogu operacji.');

    if (!existsSync(destinationPath)) {
      if (expectedDigest === null || file?.action === 'delete') continue;
      throw new Error('Pliki docelowe zmieniły się od przygotowania podglądu. Przygotuj eksport ponownie.');
    }
    assertSafeManagedFile(rootDirectory, destinationPath, true);
    if (expectedDigest === null || digest(destinationPath) !== expectedDigest) {
      throw new Error('Pliki docelowe zmieniły się od przygotowania podglądu. Przygotuj eksport ponownie.');
    }
  }
}

function assertSafeManagedFile(rootDirectory: string, filePath: string, mustExist: boolean): void {
  if (!isContainedPath(rootDirectory, filePath)) throw new Error('Operacja na pliku wykracza poza zarządzany katalog.');
  if (existsSync(rootDirectory)) {
    const rootInfo = lstatSync(rootDirectory);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error(`Zarządzany katalog nie jest bezpiecznym zwykłym katalogiem: ${rootDirectory}`);
    }
  }
  const relative = path.relative(rootDirectory, filePath);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = rootDirectory;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    if (!existsSync(current)) {
      if (mustExist) throw new Error(`Zarządzany plik zniknął przed operacją: ${filePath}`);
      return;
    }
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw new Error(`Ścieżka zarządzana zawiera symlink: ${current}`);
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw new Error(`Element ścieżki zarządzanej nie jest katalogiem: ${current}`);
    }
    if (index === segments.length - 1 && !info.isFile()) {
      throw new Error(`Generator może zarządzać wyłącznie zwykłymi plikami: ${current}`);
    }
  }
  if (existsSync(filePath) && !isContainedPath(realpathSync.native(rootDirectory), realpathSync.native(filePath))) {
    throw new Error('Rzeczywista ścieżka pliku wykracza poza zarządzany katalog.');
  }
}

function assertSafeDestination(rootDirectory: string, destinationPath: string): void {
  assertSafeManagedFile(rootDirectory, destinationPath, false);
}

interface StagedWrite {
  destinationPath: string;
  rootDirectory: string;
  stagedPath: string;
}

interface BackupFile {
  destinationPath: string;
  backupPath: string;
}

interface ExportFilesystemCommit {
  writtenFileCount: number;
  finalize(): void;
  rollback(): void;
}

function commitPendingExport(pending: PendingExport): ExportFilesystemCommit {
  const stagedWrites: StagedWrite[] = [];
  let manifestWrite: StagedWrite | null = null;
  const backups: BackupFile[] = [];
  const installedPaths: string[] = [];
  const createdDirectories = new Set<string>();
  const deletePaths = new Set(
    pending.preview.files
      .filter((file) => file.action === 'delete')
      .map((file) => pathKey(file.destinationPath)),
  );
  let deletedFileCount = 0;

  try {
    for (const file of pending.preview.files) {
      if (file.action === 'delete' || file.action === 'unchanged') continue;
      const rootDirectory = file.role === 'integration_support'
        ? pending.unityTarget.integrationDirectory
        : pending.unityTarget.targetDirectory;
      const generatedContent = pending.generatedFiles.get(file.destinationPath);
      stagedWrites.push(stageWrite({
        destinationPath: file.destinationPath,
        rootDirectory,
        token: pending.preview.token,
        content: generatedContent,
        sourcePath: generatedContent === undefined ? file.sourcePath : null,
        createdDirectories,
      }));
    }
    manifestWrite = stageWrite({
      destinationPath: pending.preview.manifestPath,
      rootDirectory: pending.unityTarget.targetDirectory,
      token: pending.preview.token,
      content: JSON.stringify(pending.manifest, null, 2),
      sourcePath: null,
      createdDirectories,
    });

    const destinationsToBackup = new Map<string, { destinationPath: string; rootDirectory: string }>();
    for (const file of pending.preview.files) {
      if (file.action !== 'delete' && file.action !== 'replace') continue;
      const rootDirectory = file.action === 'delete'
        ? pending.deleteRoots.get(pathKey(file.destinationPath))
        : file.role === 'integration_support'
          ? pending.unityTarget.integrationDirectory
          : pending.unityTarget.targetDirectory;
      if (!rootDirectory) throw new Error('Plan eksportu nie określa bezpiecznego katalogu operacji.');
      destinationsToBackup.set(pathKey(file.destinationPath), {
        destinationPath: file.destinationPath,
        rootDirectory,
      });
    }
    if (existsSync(pending.preview.manifestPath)) {
      destinationsToBackup.set(pathKey(pending.preview.manifestPath), {
        destinationPath: pending.preview.manifestPath,
        rootDirectory: pending.unityTarget.targetDirectory,
      });
    }

    for (const { destinationPath, rootDirectory } of destinationsToBackup.values()) {
      if (!existsSync(destinationPath)) continue;
      assertSafeManagedFile(rootDirectory, destinationPath, true);
      const backupPath = temporarySibling(destinationPath, pending.preview.token, 'rollback');
      assertTemporaryPathAvailable(rootDirectory, backupPath);
      renameSync(destinationPath, backupPath);
      backups.push({ destinationPath, backupPath });
      if (deletePaths.has(pathKey(destinationPath))) deletedFileCount += 1;
    }

    for (const staged of stagedWrites) {
      assertSafeDestination(staged.rootDirectory, staged.destinationPath);
      renameSync(staged.stagedPath, staged.destinationPath);
      installedPaths.push(staged.destinationPath);
    }
    assertSafeDestination(manifestWrite.rootDirectory, manifestWrite.destinationPath);
    renameSync(manifestWrite.stagedPath, manifestWrite.destinationPath);
    installedPaths.push(manifestWrite.destinationPath);

    let settled = false;
    return {
      writtenFileCount: stagedWrites.length + deletedFileCount,
      finalize: () => {
        if (settled) return;
        settled = true;
        for (const backup of backups) cleanupTemporaryFile(backup.backupPath);
      },
      rollback: () => {
        if (settled) return;
        settled = true;
        const rollbackErrors = rollbackFilesystemChanges({
          installedPaths,
          backups,
          stagedWrites,
          manifestWrite,
          createdDirectories,
        });
        if (rollbackErrors.length) {
          throw new Error(`Rollback eksportu nie przywrócił wszystkich plików: ${rollbackErrors.join('; ')}`);
        }
      },
    };
  } catch (error) {
    const rollbackErrors = rollbackFilesystemChanges({
      installedPaths,
      backups,
      stagedWrites,
      manifestWrite,
      createdDirectories,
    });
    if (rollbackErrors.length) {
      throw new Error(
        `Eksport nie powiódł się, a rollback nie przywrócił wszystkich plików: ${rollbackErrors.join('; ')}. Pierwotny błąd: ${errorMessage(error)}`,
      );
    }
    throw error;
  }
}

function rollbackFilesystemChanges(input: {
  installedPaths: string[];
  backups: BackupFile[];
  stagedWrites: StagedWrite[];
  manifestWrite: StagedWrite | null;
  createdDirectories: Set<string>;
}): string[] {
  const errors: string[] = [];
  for (const installedPath of [...input.installedPaths].reverse()) {
    try {
      if (existsSync(installedPath)) unlinkSync(installedPath);
    } catch (error) {
      errors.push(`nie usunięto ${installedPath}: ${errorMessage(error)}`);
    }
  }
  for (const backup of [...input.backups].reverse()) {
    try {
      if (!existsSync(backup.backupPath)) continue;
      if (existsSync(backup.destinationPath)) {
        errors.push(`nie można odtworzyć ${backup.destinationPath}, ponieważ ścieżka jest zajęta`);
        continue;
      }
      renameSync(backup.backupPath, backup.destinationPath);
    } catch (error) {
      errors.push(`nie odtworzono ${backup.destinationPath}: ${errorMessage(error)}`);
    }
  }
  for (const staged of input.stagedWrites) cleanupTemporaryFile(staged.stagedPath);
  if (input.manifestWrite) cleanupTemporaryFile(input.manifestWrite.stagedPath);
  removeCreatedEmptyDirectories(input.createdDirectories);
  return errors;
}

function stageWrite(input: {
  destinationPath: string;
  rootDirectory: string;
  token: string;
  content: string | undefined;
  sourcePath: string | null;
  createdDirectories: Set<string>;
}): StagedWrite {
  ensureDestinationDirectory(
    input.rootDirectory,
    path.dirname(input.destinationPath),
    input.createdDirectories,
  );
  assertSafeDestination(input.rootDirectory, input.destinationPath);
  const stagedPath = temporarySibling(input.destinationPath, input.token, 'stage');
  assertTemporaryPathAvailable(input.rootDirectory, stagedPath);
  try {
    if (input.content !== undefined) {
      writeFileSync(stagedPath, input.content, { encoding: 'utf8', flag: 'wx' });
    } else {
      if (!input.sourcePath) throw new Error('Plan zapisu nie zawiera pliku źródłowego.');
      copyFileSync(input.sourcePath, stagedPath, constants.COPYFILE_EXCL);
    }
  } catch (error) {
    cleanupTemporaryFile(stagedPath);
    throw error;
  }
  return { destinationPath: input.destinationPath, rootDirectory: input.rootDirectory, stagedPath };
}

function ensureDestinationDirectory(
  rootDirectory: string,
  directoryPath: string,
  createdDirectories: Set<string>,
): void {
  if (!isContainedPath(rootDirectory, directoryPath)) {
    throw new Error('Katalog stagingu wykracza poza zarządzany katalog.');
  }
  const missingDirectories: string[] = [];
  let current = directoryPath;
  while (!existsSync(current)) {
    missingDirectories.push(current);
    if (pathKey(current) === pathKey(rootDirectory)) break;
    const parent = path.dirname(current);
    if (parent === current || !isContainedPath(rootDirectory, current)) {
      throw new Error('Nie można bezpiecznie utworzyć katalogu stagingu.');
    }
    current = parent;
  }
  try {
    mkdirSync(directoryPath, { recursive: true });
  } catch (error) {
    recordCreatedDirectories(missingDirectories, createdDirectories);
    throw error;
  }
  recordCreatedDirectories(missingDirectories, createdDirectories);
  for (const createdDirectory of missingDirectories) {
    const info = lstatSync(createdDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Utworzona ścieżka stagingu nie jest zwykłym katalogiem: ${createdDirectory}`);
    }
  }
}

function recordCreatedDirectories(
  candidates: string[],
  createdDirectories: Set<string>,
): void {
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const info = lstatSync(candidate);
    if (info.isDirectory() && !info.isSymbolicLink()) createdDirectories.add(candidate);
  }
}

function removeCreatedEmptyDirectories(createdDirectories: Set<string>): void {
  const deepestFirst = [...createdDirectories].sort((left, right) => right.length - left.length);
  for (const directoryPath of deepestFirst) {
    try {
      if (existsSync(directoryPath)
        && lstatSync(directoryPath).isDirectory()
        && !lstatSync(directoryPath).isSymbolicLink()
        && readdirSync(directoryPath).length === 0) {
        rmdirSync(directoryPath);
      }
    } catch {
      // Rollback only removes directories proven empty and created by this run.
    }
  }
}

function temporarySibling(destinationPath: string, token: string, purpose: 'stage' | 'rollback'): string {
  return path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.${token}.${purpose}`,
  );
}

function assertTemporaryPathAvailable(rootDirectory: string, temporaryPath: string): void {
  assertSafeDestination(rootDirectory, temporaryPath);
  if (existsSync(temporaryPath)) throw new Error(`Tymczasowy plik eksportu już istnieje: ${temporaryPath}`);
}

function cleanupTemporaryFile(temporaryPath: string): void {
  try {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  } catch {
    // The delivery is already committed or rolled back; a leftover hidden temp
    // file is safer than mutating any destination after the ownership commit.
  }
}

function asRecord(candidate: unknown, label: string): Record<string, unknown> {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error(`Manifest ma niepoprawne pole ${label}.`);
  }
  return candidate as Record<string, unknown>;
}

function pathsOverlap(left: string, right: string): boolean {
  return isContainedPath(left, right) || isContainedPath(right, left);
}

function isContainedPath(rootDirectory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(rootDirectory), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function pathKey(candidate: string): string {
  const resolved = path.resolve(candidate);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
