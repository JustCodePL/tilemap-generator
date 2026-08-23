import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import packageJson from '../../package.json';
import { numericAppVersion } from '../shared/update-feed';

const releaseEnvironment = [
  'TILEMAP_RELEASE_BUILD',
  'TILEMAP_RELEASE_VERSION',
  'TILEMAP_BUILD_NUMBER',
  'TILEMAP_MACOS_SIGN_IDENTITY',
  'TILEMAP_MACOS_KEYCHAIN',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
] as const;

afterEach(() => {
  for (const name of releaseEnvironment) delete process.env[name];
  vi.restoreAllMocks();
  vi.resetModules();
});

it('zachowuje lokalny podpis ad-hoc poza buildem release', async () => {
  const { default: config } = await import('../../forge.config');
  const packagerConfig = config.packagerConfig as Record<string, unknown>;

  expect(packagerConfig.osxSign).toMatchObject({
    identity: '-',
    identityValidation: false,
    preAutoEntitlements: false,
  });
  expect(packagerConfig).not.toHaveProperty('osxNotarize');
  expect(packagerConfig).toHaveProperty('appVersion', numericAppVersion(packageJson.version));
  expect(packagerConfig).not.toHaveProperty('buildVersion');
});

it('odrzuca release bez kompletu sekretów i metadanych', async () => {
  process.env.TILEMAP_RELEASE_BUILD = '1';
  process.env.TILEMAP_RELEASE_VERSION = packageJson.version;
  process.env.TILEMAP_BUILD_NUMBER = '42';

  await expect(import('../../forge.config')).rejects.toThrow(
    'Brak wymaganej zmiennej release: TILEMAP_MACOS_SIGN_IDENTITY',
  );
});

it('włącza Developer ID, hardened runtime, timestamp i notarization tylko dla release', async () => {
  process.env.TILEMAP_RELEASE_BUILD = '1';
  process.env.TILEMAP_RELEASE_VERSION = packageJson.version;
  process.env.TILEMAP_BUILD_NUMBER = '42';
  process.env.TILEMAP_MACOS_SIGN_IDENTITY = 'Developer ID Application: Test (TEAM123456)';
  process.env.TILEMAP_MACOS_KEYCHAIN = '/tmp/tilemap-release.keychain-db';
  process.env.APPLE_ID = 'release@example.invalid';
  process.env.APPLE_APP_SPECIFIC_PASSWORD = 'not-a-real-secret';
  process.env.APPLE_TEAM_ID = 'TEAM123456';

  const { default: config } = await import('../../forge.config');
  const packagerConfig = config.packagerConfig as Record<string, unknown>;

  expect(packagerConfig).toMatchObject({
    appVersion: numericAppVersion(packageJson.version),
    buildVersion: '42',
    osxSign: {
      identity: 'Developer ID Application: Test (TEAM123456)',
      keychain: '/tmp/tilemap-release.keychain-db',
      identityValidation: true,
      continueOnError: false,
      preAutoEntitlements: false,
      hardenedRuntime: true,
      timestamp: 'http://timestamp.apple.com/ts01',
    },
    osxNotarize: {
      appleId: 'release@example.invalid',
      appleIdPassword: 'not-a-real-secret',
      teamId: 'TEAM123456',
    },
  });
});

it('zostawia pełny SemVer w package.json, ale daje Apple numeryczny CFBundleShortVersionString', async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'tilemap-forge-beta-'));
  writeFileSync(path.join(temporaryRoot, 'package.json'), JSON.stringify({ version: '0.2.0-beta.1' }));
  vi.spyOn(process, 'cwd').mockReturnValue(temporaryRoot);
  process.env.TILEMAP_RELEASE_BUILD = '1';
  process.env.TILEMAP_RELEASE_VERSION = '0.2.0-beta.1';
  process.env.TILEMAP_BUILD_NUMBER = '43';
  process.env.TILEMAP_MACOS_SIGN_IDENTITY = 'Developer ID Application: Test (TEAM123456)';
  process.env.TILEMAP_MACOS_KEYCHAIN = '/tmp/tilemap-release.keychain-db';
  process.env.APPLE_ID = 'release@example.invalid';
  process.env.APPLE_APP_SPECIFIC_PASSWORD = 'not-a-real-secret';
  process.env.APPLE_TEAM_ID = 'TEAM123456';

  try {
    const { default: config } = await import('../../forge.config');
    expect(config.packagerConfig).toMatchObject({
      appVersion: '0.2.0',
      buildVersion: '43',
    });
    expect(JSON.parse(readFileSync(path.join(temporaryRoot, 'package.json'), 'utf8')))
      .toMatchObject({ version: '0.2.0-beta.1' });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
