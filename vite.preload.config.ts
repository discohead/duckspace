import { defineConfig } from 'vite';
import path from 'path';

// biome-ignore lint/style/noDefaultExport: Required by Vite
export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@preload': path.resolve(__dirname, 'src/preload'),
    },
  },
});
