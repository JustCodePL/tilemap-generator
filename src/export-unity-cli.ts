import path from 'node:path';
import { ProjectDatabase } from './main/db/project-database';
import { UnityExporter } from './main/services/unity-exporter';

const [projectRootArgument, unityTargetArgument] = process.argv.slice(2);
if (!projectRootArgument || !unityTargetArgument) {
  throw new Error('Użycie: npm run export:unity -- <katalog biblioteki Tilemap Generator> <dokładny katalog docelowy w Unity/Assets>');
}

const projectRoot = path.resolve(projectRootArgument);
const unityTarget = path.resolve(unityTargetArgument);
const database = new ProjectDatabase(projectRoot);

try {
  const exporter = new UnityExporter();
  const preview = await exporter.preview(
    database,
    { integration: 'unity', targetDirectory: unityTarget },
  );
  const result = exporter.run(database, preview.token);
  process.stdout.write(`${JSON.stringify({
    assetCount: result.assetCount,
    fileCount: result.fileCount,
    writtenFileCount: result.writtenFileCount,
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
