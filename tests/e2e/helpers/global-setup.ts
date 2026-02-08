import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const BUILD_DIR = path.join(ROOT, '.vite/build');

const REQUIRED_ARTIFACTS = ['main-entry.js', 'preload-entry.js', 'duckdb-worker.js'];

/** Validates that all Vite build artifacts exist before e2e tests run. */
function globalSetup(): void {
  const missing = REQUIRED_ARTIFACTS.filter((file) => !fs.existsSync(path.join(BUILD_DIR, file)));

  if (missing.length > 0) {
    throw new Error(
      `[e2e-setup] Missing build artifacts in .vite/build/: ${missing.join(', ')}\n` +
        `Run "npm run build:e2e" or "npx electron-forge start" (then Ctrl+C) to generate them.`,
    );
  }

  console.log('[e2e-setup] All build artifacts present.');
}

// biome-ignore lint/style/noDefaultExport: Required by Playwright globalSetup
export default globalSetup;
