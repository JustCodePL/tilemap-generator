import path from 'node:path';
import { ProjectDatabase } from './main/db/project-database';
import { UnityExporter } from './main/services/unity-exporter';

const [projectRootArgument, unityAssetsArgument] = process.argv.slice(2);
if (!projectRootArgument || !unityAssetsArgument) {
  throw new Error('Użycie: npm run export:unity -- <katalog TileMapGenerator> <katalog Unity/Assets>');
}

const projectRoot = path.resolve(projectRootArgument);
const unityAssets = path.resolve(unityAssetsArgument);
const database = new ProjectDatabase(projectRoot);

try {
  const exporter = new UnityExporter();
  const preview = await exporter.preview(
    database,
    { targetAssetsDirectory: unityAssets },
    (candidate) => path.resolve(candidate) === unityAssets,
  );
  const result = exporter.run(database, preview.token);
  process.stdout.write(`${JSON.stringify({
    exported: result.exported,
    manifestPath: result.manifestPath,
    files: preview.files.map((file) => ({
      role: file.role,
      action: file.action,
      destinationPath: file.destinationPath,
    })),
  }, null, 2)}\n`);
} finally {
  database.close();
}
