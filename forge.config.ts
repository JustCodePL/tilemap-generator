import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isTilemapReleaseVersion, numericAppVersion } from './src/shared/update-feed';

const releaseBuild = process.env.TILEMAP_RELEASE_BUILD === '1';
const packageVersion = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
  version?: unknown;
};

if (typeof packageVersion.version !== 'string' || !isTilemapReleaseVersion(packageVersion.version)) {
  throw new Error(`Nieprawidłowa wersja package.json: ${String(packageVersion.version)}.`);
}
const fullPackageVersion = packageVersion.version;
const appIconPath = path.join(process.cwd(), 'assets', 'icon');

function requiredReleaseEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Brak wymaganej zmiennej release: ${name}`);
  return value;
}

function releaseVersionConfig(): { appVersion: string; buildVersion: string } | undefined {
  if (!releaseBuild) return undefined;

  const version = requiredReleaseEnvironment('TILEMAP_RELEASE_VERSION');
  if (!isTilemapReleaseVersion(version)) {
    throw new Error(`Nieprawidłowa wersja release: ${version}`);
  }
  if (fullPackageVersion !== version) {
    throw new Error(`Wersja package.json (${fullPackageVersion}) nie odpowiada release (${version}).`);
  }

  const buildVersion = requiredReleaseEnvironment('TILEMAP_BUILD_NUMBER');
  if (!/^[1-9]\d*$/.test(buildVersion)) {
    throw new Error(`Nieprawidłowy numer buildu macOS: ${buildVersion}`);
  }
  // Apple only accepts three numeric components in CFBundleShortVersionString.
  // The packaged package.json keeps the full SemVer (and app.getVersion() reads
  // it first), while the updater performs its own full-SemVer precheck.
  return { appVersion: numericAppVersion(version), buildVersion };
}

const releaseVersions = releaseVersionConfig() ?? {
  // Keep local beta packages valid too; package.json still carries the full
  // prerelease version consumed by app.getVersion().
  appVersion: numericAppVersion(fullPackageVersion),
};
const macSignConfig = releaseBuild
  ? {
    identity: requiredReleaseEnvironment('TILEMAP_MACOS_SIGN_IDENTITY'),
    keychain: requiredReleaseEnvironment('TILEMAP_MACOS_KEYCHAIN'),
    identityValidation: true,
    continueOnError: false,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    hardenedRuntime: true,
    timestamp: 'http://timestamp.apple.com/ts01',
  }
  : {
    identity: '-',
    identityValidation: false,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }),
  };

const config: ForgeConfig = {
  outDir: process.env.TILEMAP_BUILD_OUT_DIR || 'out',
  packagerConfig: {
    ...releaseVersions,
    asar: {
      // Sharp loads libvips through @rpath next to its native addon. Unpacking
      // only the `.node` file leaves the dylib inside ASAR and breaks macOS.
      unpack: '**/node_modules/@img/{sharp-*,sharp-libvips-*}/**/*',
    },
    appBundleId: 'ac.justcode.tilemap-generator',
    executableName: 'tilemap-generator',
    extraResource: ['dist/mcp'],
    icon: appIconPath,
    osxSign: macSignConfig,
    ...(releaseBuild ? {
      osxNotarize: {
        appleId: requiredReleaseEnvironment('APPLE_ID'),
        appleIdPassword: requiredReleaseEnvironment('APPLE_APP_SPECIFIC_PASSWORD'),
        teamId: requiredReleaseEnvironment('APPLE_TEAM_ID'),
      },
    } : {}),
    // The Vite plugin normally packages only its bundle. `sharp` and
    // `better-sqlite3` stay external so their platform-native binaries must
    // travel with the app; Electron Packager still prunes development modules.
    ignore: (file) => {
      if (!file) return false;
      return !file.startsWith('/.vite') && !file.startsWith('/node_modules');
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: 'tilemap_generator',
      setupExe: 'TilemapGeneratorSetup.exe',
      setupIcon: `${appIconPath}.ico`,
    }, ['win32']),
    new MakerZIP({}, ['win32']),
    // The release pipeline owns RELEASES.json and UPDATE.json. MakerZIP only
    // produces the signed application archive and must not compare beta SemVer.
    new MakerZIP({}, ['darwin']),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        { entry: 'src/main.ts', config: 'vite.main.config.ts' },
        { entry: 'src/preload.ts', config: 'vite.preload.config.ts' },
      ],
      renderer: [
        { name: 'main_window', config: 'vite.renderer.config.ts' },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
