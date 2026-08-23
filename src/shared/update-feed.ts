export const appUpdateChannels = ['stable', 'beta'] as const;
export type AppUpdateChannel = typeof appUpdateChannels[number];

export const macUpdateArchitectures = ['arm64', 'x64'] as const;
export type MacUpdateArchitecture = typeof macUpdateArchitectures[number];

export const updateFeedRoot = 'https://justcodepl.github.io/tilemap-generator/updates';

export type AppUpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'up-to-date'
  | 'downloaded'
  | 'installing'
  | 'error';

export interface AppUpdateState {
  enabled: boolean;
  status: AppUpdateStatus;
  channel: AppUpdateChannel;
  architecture: string;
  currentVersion: string;
  feedUrl: string | null;
  message: string;
  availableVersion: string | null;
  releaseNotes: string | null;
  releaseDate: string | null;
  checkedAt: string | null;
}

export interface MacUpdatePayload {
  version: string;
  url: string;
  serverUrl: string;
  name: string;
  notes: string;
  pub_date: string;
}

export interface MacUpdateRelease {
  version: string;
  updateTo: MacUpdatePayload;
}

export interface MacUpdateManifest {
  currentRelease: string;
  releases: MacUpdateRelease[];
}

interface ParsedTilemapVersion {
  major: bigint;
  minor: bigint;
  patch: bigint;
  baseVersion: string;
  beta: bigint | null;
}

const tilemapVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/;

export function updateChannelForVersion(version: string): AppUpdateChannel {
  return parseTilemapVersion(version).beta === null ? 'stable' : 'beta';
}

export function numericAppVersion(version: string): string {
  return parseTilemapVersion(version).baseVersion;
}

export function compareTilemapVersions(left: string, right: string): number {
  const leftVersion = parseTilemapVersion(left);
  const rightVersion = parseTilemapVersion(right);
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (leftVersion[field] > rightVersion[field]) return 1;
    if (leftVersion[field] < rightVersion[field]) return -1;
  }
  if (leftVersion.beta === null && rightVersion.beta === null) return 0;
  if (leftVersion.beta === null) return 1;
  if (rightVersion.beta === null) return -1;
  if (leftVersion.beta > rightVersion.beta) return 1;
  if (leftVersion.beta < rightVersion.beta) return -1;
  return 0;
}

export function isTilemapReleaseVersion(version: string): boolean {
  try {
    parseTilemapVersion(version);
    return true;
  } catch {
    return false;
  }
}

export function isMacUpdateArchitecture(architecture: string): architecture is MacUpdateArchitecture {
  return (macUpdateArchitectures as readonly string[]).includes(architecture);
}

export function macUpdateManifestBaseUrl(
  version: string,
  architecture: MacUpdateArchitecture,
): string {
  return `${updateFeedRoot}/${updateChannelForVersion(version)}/darwin/${architecture}`;
}

export function macUpdateManifestUrl(
  version: string,
  architecture: MacUpdateArchitecture,
): string {
  return `${macUpdateManifestBaseUrl(version, architecture)}/RELEASES.json`;
}

export function parseMacUpdateManifest(
  value: unknown,
  channel: AppUpdateChannel,
  architecture: MacUpdateArchitecture,
): MacUpdateManifest {
  const manifest = requireRecord(value, 'Manifest aktualizacji');
  const currentRelease = requireString(manifest.currentRelease, 'currentRelease', 100);
  const parsedCurrent = parseTilemapVersion(currentRelease);
  if (channel === 'stable' && parsedCurrent.beta !== null) {
    throw new Error('Kanał stable wskazuje wersję beta.');
  }
  if (!Array.isArray(manifest.releases) || manifest.releases.length === 0 || manifest.releases.length > 100) {
    throw new Error('Pole releases musi zawierać od 1 do 100 wydań.');
  }

  const matching = manifest.releases.filter((candidate) => (
    isRecord(candidate) && candidate.version === currentRelease
  ));
  if (matching.length !== 1) {
    throw new Error('Manifest musi zawierać dokładnie jedno wydanie zgodne z currentRelease.');
  }

  const releaseRecord = requireRecord(matching[0], 'Wydanie aktualizacji');
  const version = requireString(releaseRecord.version, 'releases[].version', 100);
  parseTilemapVersion(version);
  const updateRecord = requireRecord(releaseRecord.updateTo, 'releases[].updateTo');
  const updateVersion = requireString(updateRecord.version, 'updateTo.version', 100);
  if (updateVersion !== version) {
    throw new Error('updateTo.version musi być zgodne z wersją wydania.');
  }
  const url = requireString(updateRecord.url, 'updateTo.url', 2_048);
  if (!isTrustedReleaseAssetUrl(url, version, architecture)) {
    throw new Error('updateTo.url nie wskazuje zaufanego ZIP-a wydania Tilemap Generator.');
  }
  const serverUrl = requireString(updateRecord.serverUrl, 'updateTo.serverUrl', 2_048);
  if (!isTrustedUpdateServerUrl(serverUrl, version, architecture)) {
    throw new Error('updateTo.serverUrl nie wskazuje zaufanego endpointu wydania Tilemap Generator.');
  }
  const name = requireString(updateRecord.name, 'updateTo.name', 200);
  const notes = requireString(updateRecord.notes, 'updateTo.notes', 16_000, true);
  const publishedAt = requireString(updateRecord.pub_date, 'updateTo.pub_date', 100);
  const parsedDate = new Date(publishedAt);
  if (!Number.isFinite(parsedDate.getTime())) {
    throw new Error('updateTo.pub_date nie jest prawidłową datą ISO 8601.');
  }

  return {
    currentRelease,
    releases: [{
      version,
      updateTo: {
        version: updateVersion,
        url,
        serverUrl,
        name,
        notes,
        pub_date: parsedDate.toISOString(),
      },
    }],
  };
}

function parseTilemapVersion(value: string): ParsedTilemapVersion {
  const match = tilemapVersionPattern.exec(value);
  if (!match) {
    throw new Error(`Nieprawidłowa wersja aplikacji: ${value}.`);
  }
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    baseVersion: `${match[1]}.${match[2]}.${match[3]}`,
    beta: match[4] ? BigInt(match[4]) : null,
  };
}

function isTrustedReleaseAssetUrl(
  value: string,
  version: string,
  architecture: MacUpdateArchitecture,
): boolean {
  return trustedReleaseAssetName(value, version)
    === `tilemap-generator-darwin-${architecture}-${version}.zip`;
}

function isTrustedUpdateServerUrl(
  value: string,
  version: string,
  architecture: MacUpdateArchitecture,
): boolean {
  return trustedReleaseAssetName(value, version)
    === `tilemap-generator-darwin-${architecture}-${version}-update.json`;
}

function trustedReleaseAssetName(value: string, version: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port
      || url.username || url.password || url.search || url.hash) return null;
    const prefix = `/JustCodePL/tilemap-generator/releases/download/v${version}/`;
    const assetName = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
    return assetName && !assetName.includes('/') ? assetName : null;
  } catch {
    return null;
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} nie jest obiektem JSON.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(
  value: unknown,
  label: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && !value.trim())) {
    throw new Error(`${label} musi być ${allowEmpty ? '' : 'niepustym '}tekstem do ${maxLength} znaków.`);
  }
  return value;
}
