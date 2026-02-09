/* global console, process */

/**
 * Standalone Vite build script for e2e test artifacts.
 *
 * Replicates what Electron Forge's VitePlugin does during `npx electron-forge start`:
 * builds main-entry.js, preload-entry.js, and duckdb-worker.js into .vite/build/,
 * injecting the MAIN_WINDOW_VITE_DEV_SERVER_URL and MAIN_WINDOW_VITE_NAME defines
 * that lifecycle.ts expects at runtime.
 *
 * Usage: node scripts/build-e2e.mjs
 */

import { build } from 'vite';
import path from 'path';
import fs from 'fs';
import { builtinModules } from 'module';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.vite/build');

/**
 * Externals for the main/preload process builds.
 * Forge's VitePlugin does this automatically — we must replicate it:
 * - All Node.js built-in modules (both 'fs' and 'node:fs' forms)
 * - Electron
 * - Native addons
 */
const EXTERNALS = [
  'electron',
  '@duckdb/node-api',
  'chokidar',
  // Match both 'fs' and 'node:fs' forms of all built-in modules
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

async function buildMain() {
  console.log('[build-e2e] Building main process...');
  await build({
    configFile: path.join(ROOT, 'vite.main.config.ts'),
    root: ROOT,
    build: {
      lib: {
        entry: path.join(ROOT, 'src/main-entry.ts'),
        formats: ['cjs'],
        fileName: () => 'main-entry.js',
      },
      outDir: OUT_DIR,
      emptyOutDir: false,
      minify: false,
      rollupOptions: {
        external: EXTERNALS,
      },
    },
    define: {
      MAIN_WINDOW_VITE_DEV_SERVER_URL: JSON.stringify('http://localhost:5173'),
      MAIN_WINDOW_VITE_NAME: JSON.stringify('main_window'),
    },
  });
}

async function buildPreload() {
  console.log('[build-e2e] Building preload script...');
  await build({
    configFile: path.join(ROOT, 'vite.preload.config.ts'),
    root: ROOT,
    build: {
      lib: {
        entry: path.join(ROOT, 'src/preload-entry.ts'),
        formats: ['cjs'],
        fileName: () => 'preload-entry.js',
      },
      outDir: OUT_DIR,
      emptyOutDir: false,
      minify: false,
      rollupOptions: {
        external: EXTERNALS,
      },
    },
  });
}

// Ensure output directory exists
fs.mkdirSync(OUT_DIR, { recursive: true });

await buildMain();
// Worker is built by the closeBundle hook in vite.main.config.ts

await buildPreload();

// Verify all artifacts exist
const required = ['main-entry.js', 'preload-entry.js', 'duckdb-worker.js'];
const missing = required.filter((f) => !fs.existsSync(path.join(OUT_DIR, f)));

if (missing.length > 0) {
  console.error(`[build-e2e] Missing artifacts: ${missing.join(', ')}`);
  process.exit(1);
}

console.log('[build-e2e] All artifacts built successfully in .vite/build/');
