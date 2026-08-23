import { expect, it } from 'vitest';
import type { MakerZIP } from '@electron-forge/maker-zip';
import forgeConfig from '../../forge.config';

it('pozostawia tworzenie RELEASES.json i UPDATE.json pipeline release, nie MakerZIP', async () => {
  const makers = forgeConfig.makers ?? [];
  const darwinZip = makers
    .map((maker) => maker as unknown as MakerZIP)
    .find((maker) => maker.name === 'zip' && maker.platforms.includes('darwin'));

  expect(darwinZip).toBeDefined();
  await darwinZip!.prepareConfig('arm64');
  expect(darwinZip!.config).not.toHaveProperty('macUpdateManifestBaseUrl');
  expect(darwinZip!.config).not.toHaveProperty('macUpdateReleaseNotes');
});
