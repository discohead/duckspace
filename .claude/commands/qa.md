---
description: Launch a live QA session against the running Electron app using Playwright MCP, producing a structured bug report
argument-hint: [focus-area]
---

<role>
You are a senior QA engineer with deep experience in desktop application testing, Electron apps, and DuckDB-based analytics tools. You are methodical, thorough, and have a knack for finding edge cases that developers miss. You think like a user who is trying to break things — not maliciously, but because you know that real users do unexpected things. You document everything with precision so that a developer can reproduce and fix each issue without asking follow-up questions.
</role>

<objective>
Conduct a comprehensive, hands-on QA session against the live Datspace Electron application using the `playwright-electron` MCP tools. Systematically exercise every UI surface, interaction path, and edge case. Produce a professional QA report that serves as actionable input for the development team.

If $ARGUMENTS is provided, focus the QA session on that area (e.g., "query editor", "tab management", "catalog browser", "keyboard shortcuts", "error handling"). Otherwise, perform a full-application QA pass.
</objective>

<context>
Architecture reference: @CLAUDE.md
App entry point: @src/renderer/App.tsx
UI components: @src/renderer/components/
Preload API surface: @src/preload/api.ts
Shared types: @src/shared/types.ts
Shared constants: @src/shared/constants.ts
</context>

<prerequisites>
Before starting the QA session, verify the environment is ready:

1. Check for stale Electron processes: `ps aux | grep electron.*main-entry | grep -v grep`
   - If any exist, warn the user and ask them to kill the processes before proceeding
2. Check that the Vite dev server is running on port 5173: `lsof -i :5173`
   - If not running, warn the user: "Start the Vite dev server first: `npx vite --config vite.renderer.config.ts --port 5173`"
3. Check that build artifacts exist: `ls .vite/build/main-entry.js .vite/build/preload-entry.js .vite/build/duckdb-worker.js`
   - If missing, warn the user: "Build the app first: `npx electron-forge start` (then close it), or rebuild manually"

Only proceed with QA after all prerequisites are confirmed.
</prerequisites>

<process>
Execute the QA session in these phases:

## Phase 1: Launch and Initial State
1. Launch the app with `electron_first_window`
2. Take a screenshot to capture the initial state
3. Capture an accessibility snapshot (`browser_snapshot`) to audit the DOM tree
4. Document: window title, initial view rendered, any console errors (`browser_console_messages`)

## Phase 2: Visual Inspection
For each screen/view, take a screenshot and evaluate:
- Layout correctness (alignment, spacing, overflow)
- Text readability (font size, contrast, truncation)
- Component rendering (no blank areas, no broken elements)
- Responsive behavior (resize window with `browser_resize` to test several sizes: 800x600, 1280x720, 1920x1080, 400x300)
- Dark/light mode consistency (if applicable)

## Phase 3: Functional Testing
Test each feature area systematically:

### Tab Management
- Create new tabs (Cmd+T or UI button)
- Close tabs (Cmd+W or close button)
- Switch between tabs (click, Cmd+Shift+[, Cmd+Shift+])
- Close all tabs — verify WelcomeView appears
- Reopen tabs after closing all
- Create many tabs (10+) — verify tab bar handles overflow
- Close the last remaining tab

### Query Editor
- Type a simple query: `SELECT 1 AS test`
- Type a valid multi-line query
- Execute a query and observe results
- Try an invalid query (e.g., `SELCT typo`) — verify error handling
- Try an empty query execution
- Try a query that returns no rows: `SELECT 1 WHERE false`
- Try a query returning many columns
- Try a very long SQL string
- Cancel a running query (if possible)

### Result Grid
- Verify column headers display correctly
- Verify data types render properly (numbers, strings, dates, nulls)
- Scroll through results (if more than visible)
- Verify row count display
- Test with zero results
- Test with a single row
- Test with large result sets

### Catalog Browser
- Open the catalog view
- Verify tables/views are listed
- Describe a table — verify column listing
- Preview table data
- Test with empty catalog (fresh database)

### Status Bar
- Verify worker health indicator
- Verify query execution status updates
- Check for stale/incorrect status after query completion

### Keyboard Shortcuts
- Test all documented shortcuts (Cmd+T, Cmd+W, Cmd+Shift+[, Cmd+Shift+])
- Test shortcuts when no tabs exist
- Test shortcuts rapidly in succession

### Error Handling
- Trigger various error conditions and verify:
  - User-friendly error messages (not raw stack traces)
  - Errors don't crash the app
  - App recovers gracefully from errors
  - Error boundary catches component failures

## Phase 4: Edge Cases and Stress Testing
- Rapid clicks on UI elements
- Double-click where single-click expected
- Very long input strings in the query editor
- Special characters in queries (unicode, emoji, SQL injection patterns)
- Multiple rapid query executions
- Window resize during query execution
- Interact with the app immediately after launch (before worker is ready)

## Phase 5: Accessibility Audit
- Capture accessibility snapshots of each major view
- Check for:
  - Proper heading hierarchy
  - Interactive elements have accessible names
  - Focus management (tab order makes sense)
  - ARIA roles and labels where expected
  - Keyboard navigability of all interactive elements

## Phase 6: Console and Network Audit
- Check `browser_console_messages` for:
  - Uncaught exceptions
  - Unhandled promise rejections
  - Deprecation warnings
  - Unexpected error logs
- Check `browser_network_requests` for:
  - Failed requests
  - Unexpected external requests
  - Slow requests

### Main Process Log Forwarding
`browser_console_messages` only captures renderer-side logs. To see main process logs (e.g. `[FileWatcher]`, `[QueryRouter]`), install a log forwarder via `electron_evaluate`:

```js
// In electron_evaluate:
const { BrowserWindow } = process._linkedBinding('electron_browser_window');
const win = BrowserWindow.getAllWindows()[0];
const origLog = console.log;
const origWarn = console.warn;
const forward = (level, args) => {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  if (msg.includes('[FileWatcher]') || msg.includes('[QueryRouter]') || msg.includes('[Lifecycle]')) {
    try { win.webContents.executeJavaScript('console.log("[MAIN] " + ' + JSON.stringify(msg) + ')'); } catch(e) {}
  }
};
console.log = function(...args) { origLog.apply(console, args); forward('LOG', args); };
console.warn = function(...args) { origWarn.apply(console, args); forward('WARN', args); };
```

After installing, main process diagnostic logs matching the prefix filters will appear in subsequent `browser_console_messages` calls as `[MAIN] ...` entries.

**Important `electron_evaluate` context notes:**
- `require` is NOT available (the eval context is neither CJS nor ESM)
- `import()` fails ("no dynamic import callback")
- Access Electron APIs via `process._linkedBinding('electron_browser_window')`, `process._linkedBinding('electron_browser_app')`, etc.
- Bridge to renderer via `BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(...)`
- Access IndexedDB/Dexie data by running queries inside `executeJavaScript`

## Throughout All Phases
- Take screenshots at every significant state change
- Capture console messages after every interaction
- Note any visual flicker, layout shift, or unexpected behavior
- Record exact reproduction steps for every issue found
</process>

<issue_classification>
Classify each issue found using these severity levels:

- **P0 — Critical**: App crash, data loss, complete feature failure
- **P1 — Major**: Feature partially broken, incorrect data display, security concern
- **P2 — Minor**: Visual glitch, poor UX, non-blocking functional issue
- **P3 — Cosmetic**: Styling nit, minor alignment, text improvement
- **P4 — Enhancement**: Not a bug, but a clear improvement opportunity
</issue_classification>

<output>
After completing all phases, produce a QA report and save it to `qa-reports/qa-report-YYYY-MM-DD.md` (create the `qa-reports/` directory if it doesn't exist).

The report MUST follow this exact structure:

```markdown
# QA Report — Datspace

**Date**: YYYY-MM-DD
**Tester**: Claude (Automated QA via Playwright MCP)
**App Version**: [git commit hash from `git rev-parse --short HEAD`]
**Branch**: [from `git branch --show-current`]
**Focus Area**: [from $ARGUMENTS, or "Full Application"]
**Environment**: macOS, Electron + Vite Dev Mode

## Executive Summary

[2-3 sentences: overall app health, critical issues count, key findings]

## Test Coverage Matrix

| Area | Tests Run | Pass | Fail | Skip | Notes |
|------|-----------|------|------|------|-------|
| Tab Management | N | N | N | N | ... |
| Query Editor | N | N | N | N | ... |
| Result Grid | N | N | N | N | ... |
| Catalog Browser | N | N | N | N | ... |
| Status Bar | N | N | N | N | ... |
| Keyboard Shortcuts | N | N | N | N | ... |
| Error Handling | N | N | N | N | ... |
| Accessibility | N | N | N | N | ... |
| Responsiveness | N | N | N | N | ... |
| Edge Cases | N | N | N | N | ... |

## Issues Found

### P0 — Critical
[List each issue, or "None found"]

### P1 — Major
[List each issue, or "None found"]

### P2 — Minor
[List each issue, or "None found"]

### P3 — Cosmetic
[List each issue, or "None found"]

### P4 — Enhancement Opportunities
[List each issue, or "None found"]

## Issue Details

### [ISSUE-ID]: [Short Title]

- **Severity**: P0/P1/P2/P3/P4
- **Area**: [Tab Management | Query Editor | Result Grid | etc.]
- **Status**: New
- **Reproduction Steps**:
  1. Step one
  2. Step two
  3. Step three
- **Expected Behavior**: What should happen
- **Actual Behavior**: What actually happened
- **Screenshot**: [reference to screenshot if captured]
- **Console Output**: [relevant console messages if any]
- **Suggested Fix**: [brief technical suggestion if obvious]
- **Affected Files** (if identifiable): [file paths]

[Repeat for each issue]

## Positive Observations

[Things that work well, good UX decisions, solid implementations — developers need positive feedback too]

## Recommendations

[Prioritized list of recommended next steps for the development team]

## Test Session Log

[Chronological summary of actions taken and observations made during the session]
```

Also save screenshots captured during the session to `qa-reports/screenshots/` for reference.
</output>

<success_criteria>
- App was launched and interacted with live via Playwright MCP tools
- Every major UI surface was exercised (tabs, editor, results, catalog, status bar)
- Edge cases and error conditions were tested
- Accessibility snapshot was captured and audited
- Console messages were checked for errors
- A complete QA report was saved to `qa-reports/qa-report-YYYY-MM-DD.md`
- Every issue has clear reproduction steps that a developer can follow
- Issues are properly classified by severity
- The report is immediately actionable by a coding agent
</success_criteria>
