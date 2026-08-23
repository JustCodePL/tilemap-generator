import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('buduje feed beta do publicznego release tego samego repo i zachowuje Stable', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tilemap-release-feed-'));
  const assets = mkdtempSync(path.join(os.tmpdir(), 'tilemap-release-assets-'));
  temporaryRoots.push(root);
  temporaryRoots.push(assets);
  const stablePath = path.join(root, 'updates', 'stable', 'darwin', 'arm64');
  const stableUrl = 'https://github.com/JustCodePL/tilemap-generator/releases/download/v0.1.1/tilemap-generator-darwin-arm64-0.1.1.zip';
  writeFileTree(path.join(stablePath, 'RELEASES.json'), JSON.stringify({
    currentRelease: '0.1.1',
    releases: [{ version: '0.1.1', updateTo: {
      url: stableUrl,
      serverUrl: 'https://github.com/JustCodePL/tilemap-generator/releases/download/v0.1.1/tilemap-generator-darwin-arm64-0.1.1-update.json',
    } }],
  }));

  build(root, assets, {
    RELEASE_TAG: 'v0.2.0-beta.1',
    RELEASE_VERSION: '0.2.0-beta.1',
    RELEASE_CHANNEL: 'beta',
    RELEASE_ASSET_NAME: 'tilemap-generator-darwin-arm64-0.2.0-beta.1.zip',
    RELEASE_UPDATE_NAME: 'tilemap-generator-darwin-arm64-0.2.0-beta.1-update.json',
  });

  const beta = JSON.parse(readFileSync(
    path.join(root, 'updates', 'beta', 'darwin', 'arm64', 'RELEASES.json'),
    'utf8',
  ));
  expect(beta).toMatchObject({
    currentRelease: '0.2.0-beta.1',
    releases: [{
      version: '0.2.0-beta.1',
      updateTo: {
        version: '0.2.0-beta.1',
        url: 'https://github.com/JustCodePL/tilemap-generator/releases/download/v0.2.0-beta.1/tilemap-generator-darwin-arm64-0.2.0-beta.1.zip',
        serverUrl: 'https://github.com/JustCodePL/tilemap-generator/releases/download/v0.2.0-beta.1/tilemap-generator-darwin-arm64-0.2.0-beta.1-update.json',
      },
    }],
  });
  expect(JSON.parse(readFileSync(path.join(stablePath, 'RELEASES.json'), 'utf8')))
    .toMatchObject({ currentRelease: '0.1.1' });
  expect(JSON.parse(readFileSync(
    path.join(assets, 'tilemap-generator-darwin-arm64-0.2.0-beta.1-update.json'),
    'utf8',
  ))).toMatchObject({
    version: '0.2.0-beta.1',
    url: 'https://github.com/JustCodePL/tilemap-generator/releases/download/v0.2.0-beta.1/tilemap-generator-darwin-arm64-0.2.0-beta.1.zip',
  });
});

it('Stable aktualizuje jednocześnie kanały stable i beta', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tilemap-release-feed-'));
  const assets = mkdtempSync(path.join(os.tmpdir(), 'tilemap-release-assets-'));
  temporaryRoots.push(root);
  temporaryRoots.push(assets);
  build(root, assets, {
    RELEASE_TAG: 'v0.2.0',
    RELEASE_VERSION: '0.2.0',
    RELEASE_CHANNEL: 'stable',
    RELEASE_ASSET_NAME: 'tilemap-generator-darwin-arm64-0.2.0.zip',
    RELEASE_UPDATE_NAME: 'tilemap-generator-darwin-arm64-0.2.0-update.json',
  });

  for (const channel of ['stable', 'beta']) {
    const manifest = JSON.parse(readFileSync(
      path.join(root, 'updates', channel, 'darwin', 'arm64', 'RELEASES.json'),
      'utf8',
    ));
    expect(manifest.currentRelease).toBe('0.2.0');
  }
});

it('nie pozwala cofnąć istniejącego kanału do starszej wersji', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tilemap-release-feed-'));
  const assets = mkdtempSync(path.join(os.tmpdir(), 'tilemap-release-assets-'));
  temporaryRoots.push(root);
  temporaryRoots.push(assets);
  writeFileTree(
    path.join(root, 'updates', 'beta', 'darwin', 'arm64', 'RELEASES.json'),
    JSON.stringify({
      currentRelease: '0.2.0-beta.2',
      releases: [{ version: '0.2.0-beta.2', updateTo: {
        url: 'https://github.com/JustCodePL/tilemap-generator/releases/download/v0.2.0-beta.2/tilemap-generator-darwin-arm64-0.2.0-beta.2.zip',
        serverUrl: 'https://github.com/JustCodePL/tilemap-generator/releases/download/v0.2.0-beta.2/tilemap-generator-darwin-arm64-0.2.0-beta.2-update.json',
      } }],
    }),
  );

  expect(() => build(root, assets, {
    RELEASE_TAG: 'v0.2.0-beta.1',
    RELEASE_VERSION: '0.2.0-beta.1',
    RELEASE_CHANNEL: 'beta',
    RELEASE_ASSET_NAME: 'tilemap-generator-darwin-arm64-0.2.0-beta.1.zip',
    RELEASE_UPDATE_NAME: 'tilemap-generator-darwin-arm64-0.2.0-beta.1-update.json',
  })).toThrow(/nie może cofnąć kanału beta/);
});

it('nie pozwala wydaniu stable cofnąć nowszego kanału beta', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tilemap-release-feed-'));
  const assets = mkdtempSync(path.join(os.tmpdir(), 'tilemap-release-assets-'));
  temporaryRoots.push(root);
  temporaryRoots.push(assets);
  writeFileTree(
    path.join(root, 'updates', 'beta', 'darwin', 'arm64', 'RELEASES.json'),
    JSON.stringify({
      currentRelease: '0.3.0-beta.1',
      releases: [{ version: '0.3.0-beta.1', updateTo: {
        url: 'https://github.com/JustCodePL/tilemap-generator/releases/download/v0.3.0-beta.1/tilemap-generator-darwin-arm64-0.3.0-beta.1.zip',
        serverUrl: 'https://github.com/JustCodePL/tilemap-generator/releases/download/v0.3.0-beta.1/tilemap-generator-darwin-arm64-0.3.0-beta.1-update.json',
      } }],
    }),
  );

  expect(() => build(root, assets, {
    RELEASE_TAG: 'v0.2.0',
    RELEASE_VERSION: '0.2.0',
    RELEASE_CHANNEL: 'stable',
    RELEASE_ASSET_NAME: 'tilemap-generator-darwin-arm64-0.2.0.zip',
    RELEASE_UPDATE_NAME: 'tilemap-generator-darwin-arm64-0.2.0-update.json',
  })).toThrow(/nie może cofnąć kanału beta/);
});

function build(root: string, assets: string, release: Record<string, string>): void {
  execFileSync(process.execPath, ['scripts/release/build-update-feed.mjs'], {
    cwd: path.resolve(__dirname, '../..'),
    env: {
      ...process.env,
      FEED_ROOT: root,
      RELEASE_ASSETS_PATH: assets,
      GITHUB_REPOSITORY: 'JustCodePL/tilemap-generator',
      RELEASE_PUBLISHED_AT: '2026-08-23T12:00:00.000Z',
      ...release,
    },
  });
}

function writeFileTree(filePath: string, content: string): void {
  const directory = path.dirname(filePath);
  // Test fixture setup; the production builder owns the same path contract.
  mkdirSync(directory, { recursive: true });
  writeFileSync(filePath, content);
}
