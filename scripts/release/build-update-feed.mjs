import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const siteRoot = path.resolve(required('FEED_ROOT'));
const releaseAssetsRoot = path.resolve(required('RELEASE_ASSETS_PATH'));
const repository = required('GITHUB_REPOSITORY');
const tag = required('RELEASE_TAG');
const version = required('RELEASE_VERSION');
const channel = required('RELEASE_CHANNEL');
const assetName = required('RELEASE_ASSET_NAME');
const updateName = required('RELEASE_UPDATE_NAME');
const publishedAt = required('RELEASE_PUBLISHED_AT');

if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error(`Nieprawidłowe repozytorium: ${repository}`);
}
if (!/^\d+\.\d+\.\d+(?:-beta\.[1-9]\d*)?$/.test(version) || tag !== `v${version}`) {
  throw new Error(`Tag ${tag} i wersja ${version} nie tworzą wspólnego SemVer.`);
}
if (!['stable', 'beta'].includes(channel)) {
  throw new Error(`Nieprawidłowy kanał: ${channel}`);
}
if (!/^[A-Za-z0-9_.-]+\.zip$/.test(assetName)) {
  throw new Error(`Nieprawidłowa nazwa ZIP: ${assetName}`);
}
if (!/^[A-Za-z0-9_.-]+\.json$/.test(updateName)) {
  throw new Error(`Nieprawidłowa nazwa payloadu aktualizacji: ${updateName}`);
}
if (!Number.isFinite(Date.parse(publishedAt))) {
  throw new Error(`Nieprawidłowa data publikacji: ${publishedAt}`);
}

const assetUrl = `https://github.com/${repository}/releases/download/${tag}/${assetName}`;
const serverUrl = `https://github.com/${repository}/releases/download/${tag}/${updateName}`;
const updateTo = {
  name: `Tilemap Generator ${version}`,
  version,
  pub_date: new Date(publishedAt).toISOString(),
  notes: '',
  url: assetUrl,
};
const update = {
  currentRelease: version,
  releases: [{
    version,
    updateTo: { ...updateTo, serverUrl },
  }],
};

const targetChannels = channel === 'stable' ? ['stable', 'beta'] : ['beta'];
for (const targetChannel of targetChannels) {
  const existingPath = path.join(siteRoot, 'updates', targetChannel, 'darwin', 'arm64', 'RELEASES.json');
  const existing = readOptionalManifest(existingPath, targetChannel);
  if (existing && compareVersions(version, existing.currentRelease) < 0) {
    throw new Error(
      `Wydanie ${version} nie może cofnąć kanału ${targetChannel} z ${existing.currentRelease}.`,
    );
  }
}

mkdirSync(releaseAssetsRoot, { recursive: true });
writeFileSync(path.join(releaseAssetsRoot, updateName), `${JSON.stringify(updateTo, null, 2)}\n`);

for (const targetChannel of targetChannels) {
  const directory = path.join(siteRoot, 'updates', targetChannel, 'darwin', 'arm64');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'RELEASES.json'), `${JSON.stringify(update, null, 2)}\n`);
}

// A beta must not erase the last Stable feed when Pages replaces the entire
// artifact. The workflow downloads the previous Stable manifest before this
// script runs; reject it instead of silently preserving malformed content.
if (channel === 'beta') {
  const stablePath = path.join(siteRoot, 'updates', 'stable', 'darwin', 'arm64', 'RELEASES.json');
  readOptionalManifest(stablePath, 'stable');
}

writeFileSync(path.join(siteRoot, 'index.html'), `<!doctype html>
<html lang="pl"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Tilemap Generator – aktualizacje</title>
<body><main><h1>Tilemap Generator</h1><p>Publiczny feed podpisanych aktualizacji macOS.</p>
<p><a href="https://github.com/${repository}/releases">Pobierz najnowsze wydanie</a></p></main></body></html>\n`);

function validateManifest(value, expectedChannel) {
  if (!value || typeof value !== 'object' || typeof value.currentRelease !== 'string') {
    throw new Error(`Zachowany manifest ${expectedChannel} ma nieprawidłowy format.`);
  }
  if (!Array.isArray(value.releases) || value.releases.length === 0) {
    throw new Error(`Zachowany manifest ${expectedChannel} nie zawiera wydań.`);
  }
  parseVersion(value.currentRelease);
  for (const release of value.releases) {
    const url = release?.updateTo?.url;
    const serverUrl = release?.updateTo?.serverUrl;
    const releasePrefix = `https://github.com/${repository}/releases/download/`;
    if (typeof url !== 'string' || !url.startsWith(releasePrefix)
      || typeof serverUrl !== 'string' || !serverUrl.startsWith(releasePrefix)) {
      throw new Error(`Zachowany manifest ${expectedChannel} wskazuje obcy zasób.`);
    }
  }
}

function readOptionalManifest(filePath, expectedChannel) {
  try {
    const manifest = JSON.parse(readFileSync(filePath, 'utf8'));
    validateManifest(manifest, expectedChannel);
    return manifest;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
    throw error;
  }
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const field of ['major', 'minor', 'patch']) {
    if (a[field] > b[field]) return 1;
    if (a[field] < b[field]) return -1;
  }
  if (a.beta === null && b.beta === null) return 0;
  if (a.beta === null) return 1;
  if (b.beta === null) return -1;
  return a.beta > b.beta ? 1 : a.beta < b.beta ? -1 : 0;
}

function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/.exec(value);
  if (!match) throw new Error(`Nieprawidłowa wersja w zachowanym feedzie: ${value}.`);
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    beta: match[4] ? BigInt(match[4]) : null,
  };
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Brak wymaganej zmiennej: ${name}`);
  return value;
}
