import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ProjectDatabase } from '../main/db/project-database';
import { UnityExporter } from '../main/services/unity-exporter';

const liveIt = process.env.TILEMAP_LIVE_EXPORT === '1' ? it : it.skip;

liveIt('eksportuje wskazany projekt danych do wskazanego katalogu Unity Assets', async () => {
  const projectRoot = process.env.TILEMAP_EXPORT_PROJECT_ROOT;
  const assetsDirectory = process.env.TILEMAP_EXPORT_UNITY_ASSETS;
  if (!projectRoot || !assetsDirectory) {
    throw new Error('Ustaw TILEMAP_EXPORT_PROJECT_ROOT i TILEMAP_EXPORT_UNITY_ASSETS.');
  }

  const database = new ProjectDatabase(projectRoot);
  try {
    const exporter = new UnityExporter();
    const preview = await exporter.preview(
      database,
      { targetAssetsDirectory: assetsDirectory },
      () => true,
    );
    expect(preview.files.length).toBeGreaterThan(0);
    const result = exporter.run(database, preview.token);
    expect(result.exported).toBe(preview.files.length);
    expect(existsSync(result.manifestPath)).toBe(true);
  } finally {
    database.close();
  }
});
