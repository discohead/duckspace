#!/usr/bin/env node

/**
 * electron-verify.mjs
 * 
 * Closed-loop verification script for Electron apps.
 * Launches the app via Playwright, captures screenshots, runs assertions,
 * and outputs results for Claude to inspect.
 * 
 * Usage:
 *   node .claude/scripts/electron-verify.mjs [options]
 * 
 * Options:
 *   --entry <path>        Override the Electron entry point
 *   --skip-build          Skip the build step
 *   --screenshot-only     Just take screenshots, no assertions  
 *   --screen <name>       Only verify a specific named screen
 *   --eval <code>         Execute JS in the renderer before screenshotting
 *   --width <px>          Override window width
 *   --height <px>         Override window height
 *   --timeout <ms>        Override window wait timeout
 *   --no-headless         Show the window (default: runs offscreen)
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Find project root (walk up until we find package.json)
function findProjectRoot(startDir) {
  let dir = startDir;
  while (dir !== '/') {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

const PROJECT_ROOT = process.env.CLAUDE_PROJECT_DIR || findProjectRoot(process.cwd());

function loadConfig() {
  const configPath = join(PROJECT_ROOT, '.claude', 'electron-verify.config.json');
  const defaults = {
    entry: '.',
    buildCommand: 'npm run build',
    skipBuild: false,
    screenshotDir: '.claude/verify-output',
    windowWaitMs: 2000,
    defaultWidth: 1280,
    defaultHeight: 800,
    assertions: [],
    screens: [{ name: 'main', setup: null }],
  };

  if (existsSync(configPath)) {
    try {
      const userConfig = JSON.parse(readFileSync(configPath, 'utf8'));
      return { ...defaults, ...userConfig };
    } catch (e) {
      console.error(`⚠ Failed to parse config: ${e.message}. Using defaults.`);
      return defaults;
    }
  }
  return defaults;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--entry':       args.entry = argv[++i]; break;
      case '--skip-build':  args.skipBuild = true; break;
      case '--screenshot-only': args.screenshotOnly = true; break;
      case '--screen':      args.screen = argv[++i]; break;
      case '--eval':        args.evalCode = argv[++i]; break;
      case '--width':       args.width = parseInt(argv[++i]); break;
      case '--height':      args.height = parseInt(argv[++i]); break;
      case '--timeout':     args.timeout = parseInt(argv[++i]); break;
      case '--no-headless': args.noHeadless = true; break;
      default:
        if (!argv[i].startsWith('--')) {
          args.entry = args.entry || argv[i];
        }
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

async function runAssertion(page, assertion) {
  const result = { name: assertion.name, type: assertion.type, passed: false, detail: '' };

  try {
    switch (assertion.type) {
      case 'title': {
        const title = await page.title();
        result.passed = title.includes(assertion.expected);
        result.detail = result.passed
          ? `Title "${title}" contains "${assertion.expected}"`
          : `Title "${title}" does not contain "${assertion.expected}"`;
        break;
      }

      case 'selector': {
        const el = page.locator(assertion.selector);
        const count = await el.count();
        if (assertion.expectVisible) {
          if (count > 0) {
            const visible = await el.first().isVisible();
            result.passed = visible;
            result.detail = visible
              ? `Selector "${assertion.selector}" is visible`
              : `Selector "${assertion.selector}" exists but is not visible`;
          } else {
            result.passed = false;
            result.detail = `Selector "${assertion.selector}" not found in DOM`;
          }
        } else {
          result.passed = count > 0;
          result.detail = `Selector "${assertion.selector}" found ${count} element(s)`;
        }
        break;
      }

      case 'text': {
        const textEl = page.locator(assertion.selector);
        const count = await textEl.count();
        if (count === 0) {
          result.passed = false;
          result.detail = `Selector "${assertion.selector}" not found`;
        } else {
          const text = await textEl.first().textContent();
          result.passed = text.includes(assertion.expectedText);
          result.detail = result.passed
            ? `Text contains "${assertion.expectedText}"`
            : `Text "${text?.substring(0, 100)}" does not contain "${assertion.expectedText}"`;
        }
        break;
      }

      case 'count': {
        const countEl = page.locator(assertion.selector);
        const actual = await countEl.count();
        result.passed = actual === assertion.expectedCount;
        result.detail = `Found ${actual} elements (expected ${assertion.expectedCount})`;
        break;
      }

      case 'accessibility': {
        const snapshot = await page.accessibility.snapshot();
        result.passed = snapshot !== null;
        result.detail = snapshot
          ? `Accessibility tree has ${JSON.stringify(snapshot).length} chars`
          : 'No accessibility tree available';
        break;
      }

      default:
        result.detail = `Unknown assertion type: ${assertion.type}`;
    }
  } catch (e) {
    result.detail = `Error: ${e.message}`;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = loadConfig();
  const args = parseArgs(process.argv);

  // Merge args over config
  const entry = args.entry || config.entry;
  const skipBuild = args.skipBuild || config.skipBuild;
  const screenshotDir = resolve(PROJECT_ROOT, config.screenshotDir);
  const windowWaitMs = args.timeout || config.windowWaitMs;
  const width = args.width || config.defaultWidth;
  const height = args.height || config.defaultHeight;

  // Ensure output directory exists
  mkdirSync(screenshotDir, { recursive: true });

  const results = {
    timestamp: new Date().toISOString(),
    projectRoot: PROJECT_ROOT,
    entry,
    screens: [],
    assertions: [],
    summary: { total: 0, passed: 0, failed: 0 },
    errors: [],
  };

  // ---- Step 1: Build ----
  if (!skipBuild && config.buildCommand) {
    console.log(`🔨 Building: ${config.buildCommand}`);
    try {
      execSync(config.buildCommand, {
        cwd: PROJECT_ROOT,
        stdio: 'pipe',
        timeout: 60000,
      });
      console.log('✅ Build succeeded');
    } catch (e) {
      const stderr = e.stderr?.toString().substring(0, 500) || e.message;
      console.error(`❌ Build failed: ${stderr}`);
      results.errors.push({ phase: 'build', error: stderr });
      writeResults(screenshotDir, results);
      process.exit(1);
    }
  } else {
    console.log('⏭  Skipping build');
  }

  // ---- Step 2: Launch Electron via Playwright ----
  let electron, app, page;
  try {
    const pw = await import('playwright');
    // Playwright exports _electron for Electron support
    electron = pw._electron || pw.default?._electron;
    if (!electron) {
      throw new Error(
        'Playwright Electron support not found. Make sure playwright is installed: npm i -D playwright'
      );
    }
  } catch (e) {
    console.error(`❌ Failed to load Playwright: ${e.message}`);
    results.errors.push({ phase: 'playwright-import', error: e.message });
    writeResults(screenshotDir, results);
    process.exit(1);
  }

  try {
    console.log(`🚀 Launching Electron: ${entry}`);

    // Resolve the entry point
    let entryPath = entry;
    if (entry === '.') {
      // Read from package.json main field
      const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
      entryPath = pkg.main || 'index.js';
    }
    entryPath = resolve(PROJECT_ROOT, entryPath);

    const launchArgs = [entryPath];

    app = await electron.launch({
      args: launchArgs,
      cwd: PROJECT_ROOT,
      timeout: 15000,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        ELECTRON_VERIFY: '1',  // Apps can check this to adapt behavior
        ELECTRON_RUN_AS_NODE: '',  // Must be unset so Electron runs as app, not Node
      },
    });

    // Get the first window
    page = await app.firstWindow();
    console.log(`📐 Setting viewport: ${width}x${height}`);
    await page.setViewportSize({ width, height });

    // Wait for the app to render
    console.log(`⏳ Waiting ${windowWaitMs}ms for render...`);
    await page.waitForTimeout(windowWaitMs);

  } catch (e) {
    console.error(`❌ Failed to launch Electron: ${e.message}`);
    results.errors.push({ phase: 'launch', error: e.message });
    writeResults(screenshotDir, results);
    if (app) await app.close().catch(() => {});
    process.exit(1);
  }

  // ---- Step 3: Eval (if provided) ----
  if (args.evalCode) {
    try {
      console.log(`🔧 Evaluating: ${args.evalCode.substring(0, 80)}...`);
      await page.evaluate(args.evalCode);
      await page.waitForTimeout(500); // Brief wait for any UI updates
    } catch (e) {
      console.error(`⚠ Eval failed: ${e.message}`);
      results.errors.push({ phase: 'eval', error: e.message });
    }
  }

  // ---- Step 4: Screenshot each screen ----
  const screensToCapture = args.screen
    ? config.screens.filter((s) => s.name === args.screen)
    : config.screens;

  if (screensToCapture.length === 0 && args.screen) {
    // If user specified a screen name that doesn't exist, just screenshot current state
    screensToCapture.push({ name: args.screen, setup: null });
  }

  for (const screen of screensToCapture) {
    try {
      // Run setup if defined
      if (screen.setup) {
        console.log(`🔧 Setting up screen "${screen.name}": ${screen.setup.substring(0, 60)}...`);
        const setupFn = new Function('page', `return (async () => { ${screen.setup} })()`);
        await setupFn(page);
        await page.waitForTimeout(500);
      }

      const screenshotPath = join(screenshotDir, `${screen.name}.png`);
      console.log(`📸 Capturing screen "${screen.name}" → ${screenshotPath}`);
      await page.screenshot({ path: screenshotPath, fullPage: false });

      results.screens.push({
        name: screen.name,
        path: screenshotPath,
        captured: true,
      });
    } catch (e) {
      console.error(`⚠ Failed to capture screen "${screen.name}": ${e.message}`);
      results.screens.push({ name: screen.name, captured: false, error: e.message });
    }
  }

  // Also always save a "screenshot.png" as the default (first screen or current state)
  try {
    const defaultPath = join(screenshotDir, 'screenshot.png');
    await page.screenshot({ path: defaultPath, fullPage: false });
    console.log(`📸 Default screenshot → ${defaultPath}`);
  } catch (e) {
    // Non-fatal
  }

  // ---- Step 5: Run assertions ----
  if (!args.screenshotOnly && config.assertions.length > 0) {
    console.log(`\n🔍 Running ${config.assertions.length} assertion(s)...`);
    for (const assertion of config.assertions) {
      const result = await runAssertion(page, assertion);
      results.assertions.push(result);
      results.summary.total++;
      if (result.passed) {
        results.summary.passed++;
        console.log(`  ✅ ${result.name}: ${result.detail}`);
      } else {
        results.summary.failed++;
        console.log(`  ❌ ${result.name}: ${result.detail}`);
      }
    }
  }

  // ---- Step 6: Capture accessibility tree (bonus context for Claude) ----
  try {
    const a11ySnapshot = await page.accessibility.snapshot();
    if (a11ySnapshot) {
      const a11yPath = join(screenshotDir, 'accessibility.json');
      writeFileSync(a11yPath, JSON.stringify(a11ySnapshot, null, 2));
      results.accessibilityTree = a11yPath;
    }
  } catch (e) {
    // Non-fatal — some apps may not support this
  }

  // ---- Step 7: Cleanup ----
  try {
    await app.close();
    console.log('🛑 App closed cleanly');
  } catch (e) {
    console.error(`⚠ App close failed: ${e.message}`);
  }

  // ---- Step 8: Write results ----
  writeResults(screenshotDir, results);

  // ---- Summary ----
  console.log('\n' + '='.repeat(60));
  console.log(`📊 Verification Complete`);
  console.log(`   Screenshots: ${results.screens.filter((s) => s.captured).length}/${results.screens.length}`);
  if (results.summary.total > 0) {
    console.log(`   Assertions: ${results.summary.passed}/${results.summary.total} passed`);
  }
  if (results.errors.length > 0) {
    console.log(`   Errors: ${results.errors.length}`);
  }
  console.log(`   Results: ${join(screenshotDir, 'results.json')}`);
  console.log('='.repeat(60));

  // Suggest next steps for Claude
  console.log('\n💡 Claude: Run these commands to inspect results:');
  console.log(`   view ${join(screenshotDir, 'screenshot.png')}`);
  if (results.screens.length > 1) {
    for (const s of results.screens.filter((s) => s.captured)) {
      console.log(`   view ${s.path}`);
    }
  }
  console.log(`   cat ${join(screenshotDir, 'results.json')}`);

  // Exit with error code if assertions failed
  if (results.summary.failed > 0) {
    process.exit(1);
  }
}

function writeResults(dir, results) {
  const resultsPath = join(dir, 'results.json');
  writeFileSync(resultsPath, JSON.stringify(results, null, 2));
}

// Run
main().catch((e) => {
  console.error(`💥 Unexpected error: ${e.message}`);
  process.exit(2);
});
