import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const config: ForgeConfig = {
  outDir: process.env.TILEMAP_BUILD_OUT_DIR || 'out',
  packagerConfig: {
    asar: {
      // Sharp loads libvips through @rpath next to its native addon. Unpacking
      // only the `.node` file leaves the dylib inside ASAR and breaks macOS.
      unpack: '**/node_modules/@img/{sharp-*,sharp-libvips-*}/**/*',
    },
    appBundleId: 'ac.justcode.tilemap-generator',
    executableName: 'tilemap-generator',
    extraResource: ['dist/mcp'],
    icon: undefined,
    osxSign: {
      identity: '-',
      identityValidation: false,
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }),
    },
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
    }, ['win32']),
    new MakerZIP({}, ['win32', 'darwin']),
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
