import { defineConfig } from 'vitest/config';
import path from 'path';

// biome-ignore lint/style/noDefaultExport: Required by Vitest
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
        // Integration-heavy files requiring DuckDB/Electron/Perspective runtime
        'src/main/ingestion/format-detector.ts',
        'src/main/ingestion/ingestion-router.ts',
        'src/main/ingestion/progress-tracker.ts',
        'src/renderer/components/DataGrid.tsx',
        'src/renderer/lib/perspective-bridge.ts',
        // Complex UI form/dialog components requiring extensive mocking
        'src/renderer/components/CatalogSidebar.tsx',
        'src/renderer/components/ImportDialog.tsx',
        'src/renderer/components/WatchDirConfig.tsx',
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
    typecheck: {
      enabled: true,
    },
  },
});
