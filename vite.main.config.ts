import { defineConfig } from 'vite';
import path from 'path';
import { build as viteBuild } from 'vite';

// Plugin that builds the DuckDB worker as a separate bundle after the main build
function buildWorkerPlugin() {
  return {
    name: 'build-duckdb-worker',
    async closeBundle() {
      await viteBuild({
        configFile: false,
        resolve: {
          alias: {
            '@shared': path.resolve(__dirname, 'src/shared'),
          },
        },
        build: {
          lib: {
            entry: path.resolve(__dirname, 'src/workers/duckdb-worker.ts'),
            formats: ['cjs'],
            fileName: () => 'duckdb-worker.js',
          },
          outDir: path.resolve(__dirname, '.vite/build'),
          emptyOutDir: false,
          minify: false,
          rollupOptions: {
            external: [
              '@duckdb/node-api',
              'worker_threads',
              /^node:/,
            ],
          },
        },
      });
    },
  };
}

// biome-ignore lint/style/noDefaultExport: Required by Vite
export default defineConfig({
  resolve: {
    alias: {
      '@main': path.resolve(__dirname, 'src/main'),
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@workers': path.resolve(__dirname, 'src/workers'),
      '@preload': path.resolve(__dirname, 'src/preload'),
    },
  },
  plugins: [buildWorkerPlugin()],
  build: {
    rollupOptions: {
      external: [
        '@duckdb/node-api',
        'worker_threads',
        'chokidar',
        /^node:/,
      ],
    },
  },
});
