import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureTerrainBlendAtlas, type TerrainBlendAtlasManifest } from './main/services/terrain-blend-generator';

interface ExportedTerrainBlend extends TerrainBlendAtlasManifest {
  atlasFile: string;
  wallFile: string;
}

interface ExportedAsset {
  name: string;
  file: string;
  terrainBlend?: ExportedTerrainBlend;
}

interface ExportManifest {
  schemaVersion: number;
  managedFiles: string[];
  project: {
    projection: 'isometric' | 'top_down';
  };
  tile: {
    widthPx: number;
    heightPx: number;
  };
  assets: ExportedAsset[];
}

const [exportRootArgument] = process.argv.slice(2);
if (!exportRootArgument) {
  throw new Error('Użycie: npm run rebuild:terrain-blends -- <dokładny katalog delivery z tilemap-assets.json>');
}

const exportRoot = path.resolve(exportRootArgument);
const manifestPath = path.join(exportRoot, 'tilemap-assets.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExportManifest;
if (manifest.schemaVersion !== 9
  || !Array.isArray(manifest.managedFiles)
  || !manifest.managedFiles.includes('tilemap-assets.json')
  || !manifest.project
  || !['isometric', 'top_down'].includes(manifest.project.projection)
  || !manifest.tile
  || !Array.isArray(manifest.assets)) {
  throw new Error('Nieobsługiwany lub niekompletny manifest eksportu. Wymagany jest bieżący schemat v9.');
}
const managedFiles = new Set(manifest.managedFiles.map(validateManagedRelativePath));
const projection = manifest.project.projection;
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'terrain-blend-rebuild-'));

try {
  const generated: Array<{
    asset: ExportedAsset;
    atlasSource: string;
    wallSource: string;
    manifest: TerrainBlendAtlasManifest;
  }> = [];

  for (const [index, asset] of manifest.assets.entries()) {
    if (!asset.terrainBlend) continue;
    const sourcePath = resolveManagedExportPath(exportRoot, asset.file, managedFiles);
    const temporaryAssetDirectory = path.join(temporaryRoot, index.toString());
    mkdirSync(temporaryAssetDirectory, { recursive: true });
    const temporarySourcePath = path.join(temporaryAssetDirectory, path.basename(sourcePath));
    copyFileSync(sourcePath, temporarySourcePath);
    const result = await ensureTerrainBlendAtlas({
      sourcePath: temporarySourcePath,
      tileWidthPx: manifest.tile.widthPx,
      tileHeightPx: manifest.tile.heightPx,
      projection,
    });
    generated.push({
      asset,
      atlasSource: result.atlasPath,
      wallSource: result.wallPath,
      manifest: result.manifest,
    });
  }

  for (const result of generated) {
    const previousBlend = result.asset.terrainBlend!;
    copyFileSync(
      result.atlasSource,
      resolveManagedExportPath(exportRoot, previousBlend.atlasFile, managedFiles),
    );
    copyFileSync(
      result.wallSource,
      resolveManagedExportPath(exportRoot, previousBlend.wallFile, managedFiles),
    );
    result.asset.terrainBlend = {
      ...result.manifest,
      atlasFile: previousBlend.atlasFile,
      wallFile: previousBlend.wallFile,
    };
  }

  const temporaryManifestPath = `${manifestPath}.tmp`;
  writeFileSync(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  renameSync(temporaryManifestPath, manifestPath);
  process.stdout.write(`Przebudowano blending dla ${generated.length} terenów.\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function resolveManagedExportPath(
  rootDirectory: string,
  relativePath: string,
  managedFiles: Set<string>,
): string {
  const validated = validateManagedRelativePath(relativePath);
  if (!managedFiles.has(validated)) {
    throw new Error(`Manifest nie potwierdza własności pliku: ${validated}`);
  }
  return path.resolve(rootDirectory, ...validated.split('/'));
}

function validateManagedRelativePath(candidate: unknown): string {
  if (typeof candidate !== 'string'
    || !candidate
    || candidate.includes('\0')
    || candidate.includes('\\')
    || candidate.includes(':')
    || path.posix.isAbsolute(candidate)
    || path.win32.isAbsolute(candidate)) {
    throw new Error('Manifest zawiera niebezpieczną ścieżkę pliku zarządzanego.');
  }
  const segments = candidate.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Manifest zawiera niebezpieczny segment ścieżki pliku zarządzanego.');
  }
  return candidate;
}
