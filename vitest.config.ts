import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/unit/**/*.test.tsx',
      'tests/integration/**/*.test.ts',
    ],
    exclude: ['tests/e2e/**'],
    alias: {
      '@main': path.resolve(__dirname, 'src/main'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@workers': path.resolve(__dirname, 'src/workers'),
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@preload': path.resolve(__dirname, 'src/preload'),
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.d.ts',
        'src/shared/types.ts',
        'src/main-entry.ts',
        'src/preload-entry.ts',
        'src/preload/api.ts',
      ],
    },
  },
});
