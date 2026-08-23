import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  linkSync,
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
  type ExportFilePreview,
  type ExportIntegration,
  type ExportIntegrationDescriptor,
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

const PHASER_SCHEMA_VERSION = 1;
const PHASER_PACK_SECTION = 'tilemap-generator';
const MANIFEST_NAME = 'tilemap-assets.phaser.json';
const PREVIEW_TTL_MS = 10 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PhaserPackFile = {
  type: 'image' | 'spritesheet';
  key: string;
  url: string;
  frameConfig?: {
    frameWidth: number;
    frameHeight: number;
    startFrame: number;
    endFrame: number;
  };
};

interface ExistingDelivery {
  manifestPath: string;
  managedFiles: Set<string>;
}

interface PendingExport {
  projectId: string;
  projectRoot: string;
  assetIds?: string[];
  exportStateFingerprint: string;
  targetDirectory: string;
  preview: ExportPreview;
  manifest: Record<string, unknown>;
  destinationSnapshots: Map<string, string | null>;
  sourceSnapshots: Map<string, string>;
  createdAt: number;
}

interface StagedWrite {
  destinationPath: string;
  stagedPath: string;
}

interface BackupFile {
  destinationPath: string;
  backupPath: string;
}

interface FilesystemCommit {
  writtenFileCount: number;
  finalize(): void;
  rollback(): void;
}

export class PhaserExporter {
  readonly integration: ExportIntegration = 'phaser';
  readonly descriptor: ExportIntegrationDescriptor = {
    id: 'phaser',
    label: 'Phaser 3',
    description: 'PNG, spritesheety i natywny File Pack z metadanymi dla Phaser 3.',
    targetLabel: 'Katalog docelowy',
  };
  readonly targetDialog = {
    title: 'Wybierz katalog docelowy integracji Phaser',
    buttonLabel: 'Wybierz katalog',
  };
  private readonly pending = new Map<string, PendingExport>();

  validateTarget(targetDirectory: string): string {
    return resolveTarget(targetDirectory);
  }

  async preview(database: ProjectDatabase, input: ExportPreviewInput): Promise<ExportPreview> {
    if (input.integration !== this.integration) throw new Error('Nieprawidłowa integracja eksportu Phaser.');
    const targetDirectory = resolveTarget(input.targetDirectory);
    const project = database.getProject();
    const manifestPath = path.join(targetDirectory, MANIFEST_NAME);
    const existing = readExistingDelivery(targetDirectory, manifestPath, project.id);
    const approved = database.approvedAssets(input.assetIds);
    if (project.projection === 'top_down'
      && approved.some(({ version }) => version.category === 'elevated_tile')) {
      throw new Error('Projekt top-down nie obsługuje elevated tile.');
    }

    for (const { version, absolutePath } of approved) {
      assertSafeSource(project.rootPath, absolutePath);
      for (const variant of version.roadVariants ?? []) {
        assertSafeSource(project.rootPath, database.resolveRelative(variant.finalPath));
      }
      if (isTileAssetCategory(version.category)) {
        assertSafeTerrainDerivedDirectory(project.rootPath, absolutePath);
      }
      if (version.category === 'character') assertExportableCharacterAnimation(project, version);
      if (version.category === 'road_tile') assertExportableRoadVariants(project, version);
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

    for (const { version } of approved) {
      const blend = terrainBlends.get(version.id);
      if (blend) {
        assertSafeSource(project.rootPath, blend.atlasPath);
        assertSafeSource(project.rootPath, blend.wallPath);
      }
    }

    const files: ExportFilePreview[] = [];
    const packFiles: PhaserPackFile[] = [];
    const assetEntries: Array<Record<string, unknown>> = [];
    const ownedFiles = existing?.managedFiles ?? new Set<string>();

    for (const { asset, version, absolutePath } of approved) {
      const stableKey = textureKey(asset.id);
      const directory = path.join(targetDirectory, 'assets', version.category);
      const stem = `${slugify(asset.name)}--${asset.id.slice(0, 8)}`;
      let mainFile: ExportFilePreview | null = null;
      let mainLoader: PhaserPackFile | null = null;

      if (version.category !== 'road_tile') {
        const destinationPath = path.join(directory, `${stem}.png`);
        mainFile = planCopy({
          targetDirectory,
          existing,
          ownedFiles,
          files,
          assetId: asset.id,
          versionId: version.id,
          sourcePath: absolutePath,
          destinationPath,
          role: 'asset',
        });
        mainLoader = version.category === 'character'
          ? characterPackFile(stableKey, relativeUrl(targetDirectory, destinationPath), version)
          : imagePackFile(stableKey, relativeUrl(targetDirectory, destinationPath));
        packFiles.push(mainLoader);
      }

      const roadVariants = version.category === 'road_tile'
        ? (version.roadVariants ?? []).map((variant) => {
          const variantKey = `${stableKey}-road-${variant.connectionMask.toString().padStart(2, '0')}`;
          const destinationPath = path.join(
            directory,
            stem,
            `road-${variant.connectionMask.toString().padStart(2, '0')}.png`,
          );
          planCopy({
            targetDirectory,
            existing,
            ownedFiles,
            files,
            assetId: asset.id,
            versionId: version.id,
            sourcePath: database.resolveRelative(variant.finalPath),
            destinationPath,
            role: 'road_variant',
            variantMask: variant.connectionMask,
          });
          const loader = imagePackFile(variantKey, relativeUrl(targetDirectory, destinationPath));
          packFiles.push(loader);
          return {
            mask: variant.connectionMask,
            directions: roadConnectionLabels(variant.connectionMask, project.projection),
            textureKey: variantKey,
            file: loader.url,
            loader,
            widthPx: variant.width,
            heightPx: variant.height,
            origin: phaserOrigin(version.pivot),
          };
        })
        : null;

      const blend = terrainBlends.get(version.id);
      let terrainBlend: Record<string, unknown> | null = null;
      if (blend) {
        const atlasKey = `${stableKey}-blend`;
        const atlasDestination = path.join(directory, `${stem}--blend.png`);
        planCopy({
          targetDirectory,
          existing,
          ownedFiles,
          files,
          assetId: asset.id,
          versionId: version.id,
          sourcePath: blend.atlasPath,
          destinationPath: atlasDestination,
          role: 'terrain_blend_atlas',
        });
        const atlasLoader: PhaserPackFile = {
          type: 'spritesheet',
          key: atlasKey,
          url: relativeUrl(targetDirectory, atlasDestination),
          frameConfig: {
            frameWidth: blend.manifest.spriteWidthPx,
            frameHeight: blend.manifest.spriteHeightPx,
            startFrame: 0,
            endFrame: blend.manifest.variants.length - 1,
          },
        };
        packFiles.push(atlasLoader);

        let wall: Record<string, unknown> | null = null;
        if (project.projection === 'isometric') {
          const wallKey = `${stableKey}-walls`;
          const wallDestination = path.join(directory, `${stem}--walls.png`);
          planCopy({
            targetDirectory,
            existing,
            ownedFiles,
            files,
            assetId: asset.id,
            versionId: version.id,
            sourcePath: blend.wallPath,
            destinationPath: wallDestination,
            role: 'terrain_wall',
          });
          const wallLoader = imagePackFile(wallKey, relativeUrl(targetDirectory, wallDestination));
          packFiles.push(wallLoader);
          wall = { textureKey: wallKey, file: wallLoader.url, loader: wallLoader };
        }

        terrainBlend = {
          schemaVersion: blend.manifest.schemaVersion,
          mode: blend.manifest.mode,
          textureKey: atlasKey,
          file: atlasLoader.url,
          loader: atlasLoader,
          columns: blend.manifest.columns,
          rows: blend.manifest.rows,
          atlasWidthPx: blend.manifest.atlasWidthPx,
          atlasHeightPx: blend.manifest.atlasHeightPx,
          frameWidthPx: blend.manifest.spriteWidthPx,
          frameHeightPx: blend.manifest.spriteHeightPx,
          surfaceHeightPx: blend.manifest.surfaceHeightPx,
          sourcePivotNormalized: blend.manifest.pivotNormalized,
          origin: phaserOrigin(blend.manifest.pivotNormalized),
          variants: blend.manifest.variants.map((variant, frameIndex) => ({
            mask: variant.mask,
            frameIndex,
            frameName: variant.spriteName,
            rectPx: {
              x: variant.rect.x,
              y: blend.manifest.atlasHeightPx - variant.rect.y - variant.rect.height,
              width: variant.rect.width,
              height: variant.rect.height,
            },
          })),
          wall,
        };
      }

      const mainUrl = mainFile ? relativeUrl(targetDirectory, mainFile.destinationPath) : null;
      assetEntries.push({
        id: asset.id,
        versionId: version.id,
        name: asset.name,
        category: version.category,
        textureKey: mainLoader?.key ?? null,
        file: mainUrl,
        loader: mainLoader,
        widthPx: version.width,
        heightPx: version.height,
        expectedCanvasPx: version.category === 'character' && version.characterAnimation
          ? version.characterAnimation.sheetSize
          : assetPixelSize(project, version),
        relativeSize: { width: version.relativeWidth, height: version.relativeHeight },
        footprintCells: version.footprint,
        tags: version.tags,
        sourcePivotNormalized: version.pivot,
        origin: phaserOrigin(version.pivot),
        elevationLevels: version.elevationLevels,
        roadVariants,
        terrainBlend,
        characterAnimation: version.category === 'character'
          ? characterAnimationManifest(project, version, stableKey)
          : null,
        generatedBy: {
          provider: version.generatorProvider ?? 'codex',
          model: version.generatorModel || (version.generatorProvider === 'codex' ? 'imagegen' : null),
          workflowHash: version.generatorWorkflowHash || null,
          runId: version.providerRunId || null,
          metadata: version.generationMetadata,
        },
      });
    }

    const desiredManagedFiles = new Set<string>([
      manifestPath,
      ...files.filter((file) => file.action !== 'delete').map((file) => file.destinationPath),
    ]);
    if (existing) {
      for (const ownedPath of existing.managedFiles) {
        if (desiredManagedFiles.has(ownedPath) || !existsSync(ownedPath)) continue;
        assertSafeManagedFile(targetDirectory, ownedPath, true);
        files.push({
          assetId: null,
          versionId: null,
          sourcePath: null,
          destinationPath: ownedPath,
          action: 'delete',
        });
      }
    }

    const managedFiles = [...desiredManagedFiles]
      .map((filePath) => relativeManagedPath(targetDirectory, filePath))
      .sort();
    const generatedAt = new Date().toISOString();
    const section = {
      schemaVersion: PHASER_SCHEMA_VERSION,
      engine: 'phaser3',
      generatedAt,
      files: packFiles,
      managedFiles,
      project: {
        id: project.id,
        name: project.name,
        projection: project.projection,
      },
      grid: {
        orientation: project.projection === 'top_down' ? 'orthogonal' : 'isometric',
        tileWidthPx: project.tileWidthPx,
        tileHeightPx: project.tileHeightPx,
        pixelsPerUnit: project.pixelsPerUnit,
      },
      assets: assetEntries,
    };
    const manifest: Record<string, unknown> = {
      [PHASER_PACK_SECTION]: section,
      meta: {
        app: 'Tilemap Generator',
        version: '1.0',
        generated: generatedAt,
      },
    };
    const token = randomUUID();
    const preview: ExportPreview = {
      token,
      integration: this.integration,
      targetDirectory,
      manifestPath,
      assetCount: approved.length,
      files,
    };
    this.pending.set(token, {
      projectId: project.id,
      projectRoot: project.rootPath,
      ...(input.assetIds ? { assetIds: [...input.assetIds].sort() } : {}),
      exportStateFingerprint: exportStateFingerprint(project, approved),
      targetDirectory,
      preview,
      manifest,
      destinationSnapshots: snapshotDestinations(targetDirectory, manifestPath, files),
      sourceSnapshots: snapshotSources(files),
      createdAt: Date.now(),
    });
    this.cleanup();
    return preview;
  }

  run(database: ProjectDatabase, token: string): ExportRunResult {
    const pending = this.pending.get(token);
    if (!pending || Date.now() - pending.createdAt > PREVIEW_TTL_MS) {
      this.pending.delete(token);
      throw new Error('Podgląd eksportu wygasł. Wygeneruj go ponownie.');
    }
    const project = database.getProject();
    if (pending.projectId !== project.id) {
      this.pending.delete(token);
      throw new Error('Podgląd eksportu należy do innego projektu. Przygotuj go ponownie.');
    }
    const currentApproved = database.approvedAssets(pending.assetIds);
    if (pending.exportStateFingerprint !== exportStateFingerprint(project, currentApproved)) {
      this.pending.delete(token);
      throw new Error('Projekt lub zatwierdzone assety zmieniły się od przygotowania podglądu. Przygotuj eksport ponownie.');
    }
    if (resolveTarget(pending.preview.targetDirectory) !== pending.targetDirectory) {
      throw new Error('Katalog docelowy Phaser zmienił się od przygotowania podglądu. Przygotuj eksport ponownie.');
    }
    assertSourceSnapshots(pending);
    assertDestinationSnapshots(pending);
    const filesystemCommit = commitFilesystem(pending);
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
          `Nie zapisano historii eksportu i nie udało się przywrócić plików: ${errorMessage(rollbackError)}. `
          + `Błąd bazy: ${errorMessage(error)}`,
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
    const cutoff = Date.now() - PREVIEW_TTL_MS;
    for (const [token, item] of this.pending) if (item.createdAt < cutoff) this.pending.delete(token);
  }
}

function planCopy(input: {
  targetDirectory: string;
  existing: ExistingDelivery | null;
  ownedFiles: Set<string>;
  files: ExportFilePreview[];
  assetId: string;
  versionId: string;
  sourcePath: string;
  destinationPath: string;
  role: NonNullable<ExportFilePreview['role']>;
  variantMask?: number;
}): ExportFilePreview {
  const action = fileAction(
    input.targetDirectory,
    input.sourcePath,
    input.destinationPath,
    input.ownedFiles,
    input.existing !== null,
  );
  const file: ExportFilePreview = {
    assetId: input.assetId,
    versionId: input.versionId,
    sourcePath: input.sourcePath,
    destinationPath: input.destinationPath,
    role: input.role,
    action,
    ...(input.variantMask === undefined ? {} : { variantMask: input.variantMask }),
  };
  input.files.push(file);
  return file;
}

function imagePackFile(key: string, url: string): PhaserPackFile {
  return { type: 'image', key, url };
}

function characterPackFile(key: string, url: string, version: AssetVersion): PhaserPackFile {
  const animation = version.characterAnimation;
  if (!animation) throw new Error('Postać nie zawiera arkusza animacji.');
  const columns = animation.settings.framesPerDirection + 1;
  return {
    type: 'spritesheet',
    key,
    url,
    frameConfig: {
      frameWidth: animation.frameSize.width,
      frameHeight: animation.frameSize.height,
      startFrame: 0,
      endFrame: columns * animation.directions.length - 1,
    },
  };
}

function characterAnimationManifest(
  project: ProjectInfo,
  version: AssetVersion,
  key: string,
): Record<string, unknown> {
  assertExportableCharacterAnimation(project, version);
  const animation = version.characterAnimation;
  const columns = animation.settings.framesPerDirection + 1;
  const directions = characterDirectionsForProjection(project.projection).map((direction, row) => ({
    id: direction.id,
    label: direction.shortLabel,
    row,
    screenDelta: direction.screenDelta,
    // Phaser Tilemap uses screen-style tile coordinates: Y grows downwards.
    gridDelta: project.projection === 'top_down' ? direction.screenDelta : direction.gridDelta,
  }));
  return {
    schemaVersion: 1,
    textureKey: key,
    frameConfig: {
      frameWidth: animation.frameSize.width,
      frameHeight: animation.frameSize.height,
      columns,
      rows: 4,
      startFrame: 0,
      endFrame: columns * directions.length - 1,
    },
    settings: animation.settings,
    directions,
    animations: directions.flatMap((direction) => [
      {
        key: `${key}-idle-${direction.id}`,
        action: 'idle',
        direction: direction.id,
        frameNumbers: [direction.row * columns],
        frames: [{ key, frame: direction.row * columns }],
        frameRate: animation.settings.framesPerSecond,
        repeat: -1,
      },
      {
        key: `${key}-walk-${direction.id}`,
        action: 'walk',
        direction: direction.id,
        frameNumbers: Array.from(
          { length: animation.settings.framesPerDirection },
          (_, frame) => direction.row * columns + frame + 1,
        ),
        frames: Array.from(
          { length: animation.settings.framesPerDirection },
          (_, frame) => ({ key, frame: direction.row * columns + frame + 1 }),
        ),
        frameRate: animation.settings.framesPerSecond,
        repeat: -1,
      },
    ]),
    sourcePivotNormalized: version.pivot,
    origin: phaserOrigin(version.pivot),
    movementAnalysis: animation.movementAnalysis,
  };
}

function assertExportableRoadVariants(project: ProjectInfo, version: AssetVersion): void {
  const variants = version.roadVariants;
  if (!variants || variants.length !== 16) {
    throw new Error('Droga Phaser wymaga dokładnie 16 wariantów masek 0–15.');
  }
  const masks = new Set<number>();
  for (const variant of variants) {
    if (!Number.isInteger(variant.connectionMask)
      || variant.connectionMask < 0
      || variant.connectionMask > 15
      || masks.has(variant.connectionMask)) {
      throw new Error('Droga Phaser zawiera niepełny albo powtórzony zestaw masek 0–15.');
    }
    if (variant.width !== project.tileWidthPx || variant.height !== project.tileHeightPx) {
      throw new Error(
        `Warianty drogi Phaser muszą mieć dokładnie ${project.tileWidthPx}×${project.tileHeightPx}px.`,
      );
    }
    masks.add(variant.connectionMask);
  }
  if (Array.from({ length: 16 }, (_, mask) => mask).some((mask) => !masks.has(mask))) {
    throw new Error('Droga Phaser wymaga pełnego zestawu masek 0–15.');
  }
}

function assertExportableCharacterAnimation(
  project: ProjectInfo,
  version: AssetVersion,
): asserts version is AssetVersion & { characterAnimation: NonNullable<AssetVersion['characterAnimation']> } {
  const animation = version.characterAnimation;
  if (!animation) throw new Error('Zatwierdzona postać nie zawiera kompletnego arkusza animacji v1.');
  const expectedDirections = characterDirectionsForProjection(project.projection);
  const expectedFrame = characterAnimationFrameSize(project, version);
  const expectedSheet = characterAnimationSheetSize(expectedFrame, animation.settings);
  if (animation.settings.action !== 'walk'
    || !Number.isInteger(animation.settings.framesPerDirection)
    || animation.settings.framesPerDirection < 2
    || animation.settings.framesPerDirection > 16
    || !Number.isInteger(animation.settings.framesPerSecond)
    || animation.settings.framesPerSecond < 1
    || animation.settings.framesPerSecond > 24
    || animation.frameSize.width !== expectedFrame.width
    || animation.frameSize.height !== expectedFrame.height
    || animation.sheetSize.width !== expectedSheet.width
    || animation.sheetSize.height !== expectedSheet.height
    || version.width !== expectedSheet.width
    || version.height !== expectedSheet.height
    || !sameCharacterDirections(animation.directions, expectedDirections)) {
    throw new Error(
      `Zatwierdzona postać nie odpowiada kontraktowi arkusza walk v1 ${animation.settings.framesPerDirection + 1}×4.`,
    );
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

function phaserOrigin(pivot: { x: number; y: number }): { x: number; y: number } {
  return { x: pivot.x, y: Number((1 - pivot.y).toFixed(6)) };
}

function textureKey(assetId: string): string {
  return `tilemap-${assetId}`;
}

function exportStateFingerprint(
  project: ProjectInfo,
  approved: ReturnType<ProjectDatabase['approvedAssets']>,
): string {
  const state = {
    project: {
      id: project.id,
      name: project.name,
      projection: project.projection,
      tileWidthPx: project.tileWidthPx,
      tileHeightPx: project.tileHeightPx,
      pixelsPerUnit: project.pixelsPerUnit,
    },
    approved: approved
      .map(({ asset, version }) => ({
        assetId: asset.id,
        approvedVersionId: asset.currentApprovedVersionId,
        assetUpdatedAt: asset.updatedAt,
        version,
      }))
      .sort((left, right) => left.assetId.localeCompare(right.assetId)),
  };
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

function resolveTarget(targetDirectory: string): string {
  const resolved = path.resolve(targetDirectory);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error('Katalog docelowy integracji Phaser nie istnieje.');
  }
  const info = lstatSync(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Katalog docelowy integracji Phaser nie może być symlinkiem.');
  }
  return realpathSync.native(resolved);
}

function readExistingDelivery(
  targetDirectory: string,
  manifestPath: string,
  projectId: string,
): ExistingDelivery | null {
  if (!existsSync(manifestPath)) return null;
  assertSafeManagedFile(targetDirectory, manifestPath, true);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  } catch {
    throw new Error('Manifest Phaser jest nieczytelny; eksport został zablokowany, aby nie nadpisać obcych plików.');
  }
  const root = asRecord(parsed, 'root');
  const section = asRecord(root[PHASER_PACK_SECTION], PHASER_PACK_SECTION);
  if (section.schemaVersion !== PHASER_SCHEMA_VERSION || section.engine !== 'phaser3') {
    throw new Error('Manifest Phaser ma nieobsługiwany schemat; automatyczna synchronizacja została zablokowana.');
  }
  const manifestProject = asRecord(section.project, 'project');
  if (typeof manifestProject.id !== 'string'
    || !UUID_PATTERN.test(manifestProject.id)
    || manifestProject.id !== projectId) {
    throw new Error('Manifest Phaser należy do innego projektu. Wybierz inny katalog docelowy.');
  }
  if (!Array.isArray(section.managedFiles)) throw new Error('Manifest Phaser nie zawiera listy managedFiles.');
  const relativeFiles = section.managedFiles.map(validateManagedRelativePath);
  if (!relativeFiles.includes(MANIFEST_NAME)) throw new Error('Manifest Phaser nie deklaruje własnego pliku.');
  if (new Set(relativeFiles).size !== relativeFiles.length) {
    throw new Error('Manifest Phaser zawiera powtórzone ścieżki managedFiles.');
  }
  if (!Array.isArray(section.files)) throw new Error('Manifest Phaser nie zawiera natywnej listy File Pack.');
  const loaderFiles = section.files.map((candidate, index) => {
    const loader = asRecord(candidate, `files[${index}]`);
    return validateManagedRelativePath(loader.url);
  });
  if (loaderFiles.some((relativePath) => relativePath === MANIFEST_NAME)
    || new Set(loaderFiles).size !== loaderFiles.length
    || relativeFiles.length !== loaderFiles.length + 1
    || loaderFiles.some((relativePath) => !relativeFiles.includes(relativePath))) {
    throw new Error('Manifest Phaser ma niespójną deklarację File Pack i managedFiles.');
  }
  return {
    manifestPath,
    managedFiles: new Set(relativeFiles.map((relativePath) => (
      path.resolve(targetDirectory, ...relativePath.split('/'))
    ))),
  };
}

function validateManagedRelativePath(candidate: unknown): string {
  if (typeof candidate !== 'string'
    || !candidate
    || candidate.includes('\0')
    || candidate.includes('\\')
    || candidate.includes(':')
    || path.posix.isAbsolute(candidate)
    || path.win32.isAbsolute(candidate)) {
    throw new Error('Manifest Phaser zawiera niebezpieczną ścieżkę managedFiles.');
  }
  const segments = candidate.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Manifest Phaser zawiera niebezpieczny segment ścieżki managedFiles.');
  }
  if (candidate !== MANIFEST_NAME && segments[0] !== 'assets') {
    throw new Error('Manifest Phaser może zarządzać wyłącznie własnym manifestem i katalogiem assets.');
  }
  return candidate;
}

function fileAction(
  targetDirectory: string,
  sourcePath: string,
  destinationPath: string,
  ownedFiles: Set<string>,
  hasManifest: boolean,
): 'create' | 'replace' | 'unchanged' {
  if (!existsSync(destinationPath)) {
    assertSafeManagedFile(targetDirectory, destinationPath, false);
    return 'create';
  }
  assertSafeManagedFile(targetDirectory, destinationPath, true);
  if (!hasManifest || !ownedFiles.has(destinationPath)) {
    throw new Error(`Plik ${destinationPath} już istnieje, ale manifest Phaser nie potwierdza własności generatora.`);
  }
  return digest(sourcePath) === digest(destinationPath) ? 'unchanged' : 'replace';
}

function relativeUrl(targetDirectory: string, filePath: string): string {
  return relativeManagedPath(targetDirectory, filePath);
}

function relativeManagedPath(targetDirectory: string, filePath: string): string {
  const relative = path.relative(targetDirectory, filePath).split(path.sep).join('/');
  return validateManagedRelativePath(relative);
}

function snapshotSources(files: ExportFilePreview[]): Map<string, string> {
  const snapshots = new Map<string, string>();
  for (const file of files) {
    if (file.action === 'delete' || !file.sourcePath) continue;
    const info = lstatSync(file.sourcePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Plik źródłowy eksportu Phaser nie jest zwykłym plikiem: ${file.sourcePath}`);
    }
    snapshots.set(file.sourcePath, digest(file.sourcePath));
  }
  return snapshots;
}

function snapshotDestinations(
  targetDirectory: string,
  manifestPath: string,
  files: ExportFilePreview[],
): Map<string, string | null> {
  const snapshots = new Map<string, string | null>();
  for (const file of files) {
    snapshots.set(file.destinationPath, snapshotDestination(targetDirectory, file.destinationPath));
  }
  snapshots.set(manifestPath, snapshotDestination(targetDirectory, manifestPath));
  return snapshots;
}

function snapshotDestination(targetDirectory: string, filePath: string): string | null {
  if (!existsSync(filePath)) {
    assertSafeManagedFile(targetDirectory, filePath, false);
    return null;
  }
  assertSafeManagedFile(targetDirectory, filePath, true);
  return digest(filePath);
}

function assertSourceSnapshots(pending: PendingExport): void {
  for (const [filePath, expected] of pending.sourceSnapshots) {
    assertSafeSource(pending.projectRoot, filePath);
    if (!existsSync(filePath)) throw new Error('Źródła eksportu Phaser zmieniły się od przygotowania podglądu.');
    const info = lstatSync(filePath);
    if (!info.isFile() || info.isSymbolicLink() || digest(filePath) !== expected) {
      throw new Error('Źródła eksportu Phaser zmieniły się od przygotowania podglądu.');
    }
  }
}

function assertSafeSource(projectRoot: string, filePath: string): void {
  const lexicalRoot = path.resolve(projectRoot);
  const lexicalFile = path.resolve(filePath);
  if (!isContainedPath(lexicalRoot, lexicalFile)) {
    throw new Error('Plik źródłowy eksportu Phaser wykracza poza bibliotekę projektu.');
  }
  const segments = path.relative(lexicalRoot, lexicalFile).split(path.sep).filter(Boolean);
  let current = lexicalRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    if (!existsSync(current)) throw new Error(`Plik źródłowy eksportu Phaser nie istnieje: ${filePath}`);
    const component = lstatSync(current);
    if (component.isSymbolicLink()) {
      throw new Error(`Ścieżka źródłowa eksportu Phaser zawiera symlink: ${current}`);
    }
    if (index < segments.length - 1 && !component.isDirectory()) {
      throw new Error(`Element ścieżki źródłowej Phaser nie jest katalogiem: ${current}`);
    }
  }
  if (!existsSync(filePath)) throw new Error(`Plik źródłowy eksportu Phaser nie istnieje: ${filePath}`);
  const info = lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Plik źródłowy eksportu Phaser nie jest zwykłym plikiem: ${filePath}`);
  }
  const realRoot = realpathSync.native(projectRoot);
  const realFile = realpathSync.native(filePath);
  if (!isContainedPath(realRoot, realFile)) {
    throw new Error('Plik źródłowy eksportu Phaser wykracza poza bibliotekę projektu.');
  }
}

function assertSafeTerrainDerivedDirectory(projectRoot: string, sourcePath: string): void {
  const root = path.resolve(projectRoot);
  const derivedDirectory = path.join(path.dirname(path.resolve(sourcePath)), 'derived');
  if (!isContainedPath(root, derivedDirectory)) {
    throw new Error('Katalog danych pochodnych terenu wykracza poza bibliotekę projektu.');
  }
  const segments = path.relative(root, derivedDirectory).split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!existsSync(current)) return;
    const info = lstatSync(current);
    if (info.isSymbolicLink()) {
      throw new Error(`Ścieżka danych pochodnych terenu zawiera symlink: ${current}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`Ścieżka danych pochodnych terenu nie jest katalogiem: ${current}`);
    }
  }
  if (!isContainedPath(realpathSync.native(root), realpathSync.native(derivedDirectory))) {
    throw new Error('Rzeczywisty katalog danych pochodnych wykracza poza bibliotekę projektu.');
  }
}

function assertDestinationSnapshots(pending: PendingExport): void {
  for (const [filePath, expected] of pending.destinationSnapshots) {
    if (!existsSync(filePath)) {
      if (expected === null) continue;
      throw new Error('Cel eksportu Phaser zmienił się od przygotowania podglądu.');
    }
    assertSafeManagedFile(pending.targetDirectory, filePath, true);
    if (expected === null || digest(filePath) !== expected) {
      throw new Error('Cel eksportu Phaser zmienił się od przygotowania podglądu.');
    }
  }
}

function commitFilesystem(pending: PendingExport): FilesystemCommit {
  const stagedWrites: StagedWrite[] = [];
  let stagedManifest: StagedWrite | null = null;
  const backups: BackupFile[] = [];
  const installedPaths: string[] = [];
  const createdDirectories = new Set<string>();
  let deletedFileCount = 0;
  try {
    for (const file of pending.preview.files) {
      if (file.action === 'delete' || file.action === 'unchanged') continue;
      if (!file.sourcePath) throw new Error('Plan eksportu Phaser nie zawiera pliku źródłowego.');
      stagedWrites.push(stageCopy(
        pending.targetDirectory,
        file.sourcePath,
        file.destinationPath,
        pending.preview.token,
        createdDirectories,
        pending.sourceSnapshots.get(file.sourcePath),
      ));
    }
    stagedManifest = stageContent(
      pending.targetDirectory,
      pending.preview.manifestPath,
      JSON.stringify(pending.manifest, null, 2),
      pending.preview.token,
      createdDirectories,
    );
    assertDestinationSnapshots(pending);

    const backupCandidates = new Set<string>();
    for (const file of pending.preview.files) {
      if (file.action === 'replace' || file.action === 'delete') backupCandidates.add(file.destinationPath);
    }
    if (pending.destinationSnapshots.get(pending.preview.manifestPath) !== null) {
      backupCandidates.add(pending.preview.manifestPath);
    }
    for (const destinationPath of backupCandidates) {
      const expected = pending.destinationSnapshots.get(destinationPath);
      if (!expected || snapshotDestination(pending.targetDirectory, destinationPath) !== expected) {
        throw new Error('Cel eksportu Phaser zmienił się podczas przygotowywania plików.');
      }
      assertSafeManagedFile(pending.targetDirectory, destinationPath, true);
      const backupPath = temporarySibling(destinationPath, pending.preview.token, 'rollback');
      assertTemporaryAvailable(pending.targetDirectory, backupPath);
      renameSync(destinationPath, backupPath);
      backups.push({ destinationPath, backupPath });
      if (digest(backupPath) !== expected) {
        throw new Error('Cel eksportu Phaser zmienił się podczas zabezpieczania pliku.');
      }
      if (pending.preview.files.some((file) => (
        file.action === 'delete' && pathKey(file.destinationPath) === pathKey(destinationPath)
      ))) deletedFileCount += 1;
    }

    for (const staged of stagedWrites) {
      assertSafeManagedFile(pending.targetDirectory, staged.destinationPath, false);
      installStagedExclusive(staged, installedPaths);
    }
    assertSafeManagedFile(pending.targetDirectory, stagedManifest.destinationPath, false);
    installStagedExclusive(stagedManifest, installedPaths);

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
        const errors = rollbackFilesystem({
          installedPaths,
          backups,
          stagedWrites,
          stagedManifest,
          createdDirectories,
        });
        if (errors.length) throw new Error(errors.join('; '));
      },
    };
  } catch (error) {
    const errors = rollbackFilesystem({
      installedPaths,
      backups,
      stagedWrites,
      stagedManifest,
      createdDirectories,
    });
    if (errors.length) {
      throw new Error(`Eksport Phaser nie powiódł się, a rollback był niepełny: ${errors.join('; ')}. ${errorMessage(error)}`);
    }
    throw error;
  }
}

function stageCopy(
  targetDirectory: string,
  sourcePath: string,
  destinationPath: string,
  token: string,
  createdDirectories: Set<string>,
  expectedDigest: string | undefined,
): StagedWrite {
  ensureDestinationDirectory(targetDirectory, path.dirname(destinationPath), createdDirectories);
  const stagedPath = temporarySibling(destinationPath, token, 'stage');
  assertTemporaryAvailable(targetDirectory, stagedPath);
  try {
    copyFileSync(sourcePath, stagedPath, constants.COPYFILE_EXCL);
    if (!expectedDigest || digest(stagedPath) !== expectedDigest) {
      throw new Error('Źródło eksportu Phaser zmieniło się podczas kopiowania.');
    }
  } catch (error) {
    cleanupTemporaryFile(stagedPath);
    throw error;
  }
  return { destinationPath, stagedPath };
}

function installStagedExclusive(staged: StagedWrite, installedPaths: string[]): void {
  linkSync(staged.stagedPath, staged.destinationPath);
  installedPaths.push(staged.destinationPath);
  unlinkSync(staged.stagedPath);
}

function stageContent(
  targetDirectory: string,
  destinationPath: string,
  content: string,
  token: string,
  createdDirectories: Set<string>,
): StagedWrite {
  ensureDestinationDirectory(targetDirectory, path.dirname(destinationPath), createdDirectories);
  const stagedPath = temporarySibling(destinationPath, token, 'stage');
  assertTemporaryAvailable(targetDirectory, stagedPath);
  try {
    writeFileSync(stagedPath, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    cleanupTemporaryFile(stagedPath);
    throw error;
  }
  return { destinationPath, stagedPath };
}

function rollbackFilesystem(input: {
  installedPaths: string[];
  backups: BackupFile[];
  stagedWrites: StagedWrite[];
  stagedManifest: StagedWrite | null;
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
  if (input.stagedManifest) cleanupTemporaryFile(input.stagedManifest.stagedPath);
  removeCreatedEmptyDirectories(input.createdDirectories);
  return errors;
}

function ensureDestinationDirectory(
  targetDirectory: string,
  directoryPath: string,
  createdDirectories: Set<string>,
): void {
  if (!isContainedPath(targetDirectory, directoryPath)) throw new Error('Katalog eksportu wykracza poza cel Phaser.');
  const missing: string[] = [];
  let current = directoryPath;
  while (!existsSync(current)) {
    missing.push(current);
    if (pathKey(current) === pathKey(targetDirectory)) break;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Nie można bezpiecznie utworzyć katalogu eksportu Phaser.');
    current = parent;
  }
  if (existsSync(current)) {
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Ścieżka eksportu Phaser nie jest bezpiecznym katalogiem.');
  }
  mkdirSync(directoryPath, { recursive: true });
  for (const candidate of missing) {
    if (!existsSync(candidate)) continue;
    const info = lstatSync(candidate);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Utworzona ścieżka eksportu Phaser nie jest katalogiem.');
    createdDirectories.add(candidate);
  }
}

function removeCreatedEmptyDirectories(directories: Set<string>): void {
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    try {
      if (existsSync(directory)
        && lstatSync(directory).isDirectory()
        && !lstatSync(directory).isSymbolicLink()
        && readdirSync(directory).length === 0) {
        rmdirSync(directory);
      }
    } catch {
      // Rollback removes only directories proven empty and created by this run.
    }
  }
}

function assertSafeManagedFile(targetDirectory: string, filePath: string, mustExist: boolean): void {
  if (!isContainedPath(targetDirectory, filePath)) throw new Error('Operacja eksportu Phaser wykracza poza katalog docelowy.');
  const relative = path.relative(targetDirectory, filePath);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = targetDirectory;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    if (!existsSync(current)) {
      if (mustExist) throw new Error(`Plik eksportu Phaser zniknął: ${filePath}`);
      return;
    }
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw new Error(`Ścieżka eksportu Phaser zawiera symlink: ${current}`);
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw new Error(`Element ścieżki eksportu Phaser nie jest katalogiem: ${current}`);
    }
    if (index === segments.length - 1 && !info.isFile()) {
      throw new Error(`Eksporter Phaser może zarządzać wyłącznie plikami: ${current}`);
    }
  }
  if (existsSync(filePath)
    && !isContainedPath(realpathSync.native(targetDirectory), realpathSync.native(filePath))) {
    throw new Error('Rzeczywista ścieżka pliku Phaser wykracza poza katalog docelowy.');
  }
}

function temporarySibling(destinationPath: string, token: string, purpose: 'stage' | 'rollback'): string {
  return path.join(path.dirname(destinationPath), `.${path.basename(destinationPath)}.${token}.${purpose}`);
}

function assertTemporaryAvailable(targetDirectory: string, temporaryPath: string): void {
  assertSafeManagedFile(targetDirectory, temporaryPath, false);
  if (existsSync(temporaryPath)) throw new Error(`Plik tymczasowy eksportu Phaser już istnieje: ${temporaryPath}`);
}

function cleanupTemporaryFile(filePath: string): void {
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // A hidden temporary file is safer than mutating a committed destination.
  }
}

function isContainedPath(rootDirectory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(rootDirectory), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function pathKey(candidate: string): string {
  const resolved = path.resolve(candidate);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
}

function digest(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function asRecord(candidate: unknown, label: string): Record<string, unknown> {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error(`Manifest Phaser ma niepoprawne pole ${label}.`);
  }
  return candidate as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
