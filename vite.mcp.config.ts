import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

const nodeBuiltins = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

export default defineConfig({
  build: {
    target: 'node20',
    outDir: 'dist/mcp',
    emptyOutDir: true,
    ssr: 'src/mcp/server.ts',
    rollupOptions: {
      external: nodeBuiltins,
      output: {
        entryFileNames: 'server.mjs',
        chunkFileNames: 'chunks/[name]-[hash].mjs',
        format: 'es',
      },
    },
  },
  ssr: {
    noExternal: true,
  },
});
