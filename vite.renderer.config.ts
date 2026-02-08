import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// biome-ignore lint/style/noDefaultExport: Required by Vite
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  optimizeDeps: {
    exclude: [
      '@finos/perspective',
      '@finos/perspective-viewer',
      '@finos/perspective-viewer-datagrid',
      '@finos/perspective-react',
    ],
    // CJS transitive deps of excluded perspective packages must be
    // explicitly included so Vite pre-bundles them into ESM.
    include: ['chroma-js', 'regular-table'],
  },
});
