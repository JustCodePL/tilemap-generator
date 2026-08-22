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
  tile: {
    widthPx: number;
    heightPx: number;
  };
  assets: ExportedAsset[];
}

const [exportRootArgument] = process.argv.slice(2);
if (!exportRootArgument) {
  throw new Error('Użycie: npm run rebuild:terrain-blends -- <katalog Assets/TilemapGenerator>');
}

const exportRoot = path.resolve(exportRootArgument);
const manifestPath = path.join(exportRoot, 'tilemap-assets.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExportManifest;
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
    const sourcePath = path.resolve(exportRoot, asset.file);
    const temporaryAssetDirectory = path.join(temporaryRoot, index.toString());
    mkdirSync(temporaryAssetDirectory, { recursive: true });
    const temporarySourcePath = path.join(temporaryAssetDirectory, path.basename(sourcePath));
    copyFileSync(sourcePath, temporarySourcePath);
    const result = await ensureTerrainBlendAtlas({
      sourcePath: temporarySourcePath,
      tileWidthPx: manifest.tile.widthPx,
      tileHeightPx: manifest.tile.heightPx,
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
    copyFileSync(result.atlasSource, path.resolve(exportRoot, previousBlend.atlasFile));
    copyFileSync(result.wallSource, path.resolve(exportRoot, previousBlend.wallFile));
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
