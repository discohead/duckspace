import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import db from './stores/db';
import { checkAndRecover } from './lib/recovery';
import { DEFAULT_PREFERENCES } from '@shared/constants';

async function bootstrap() {
  // Initialize Dexie.js (opens IndexedDB)
  await db.open();

  // T066: Seed default preferences on first launch
  const prefCount = await db.preferences.count();
  if (prefCount === 0) {
    const now = new Date().toISOString();
    await db.preferences.bulkAdd(
      DEFAULT_PREFERENCES.map((p) => ({ ...p, updatedAt: now }))
    );
  }

  // T051: Check for crash recovery before marking dirty
  const recoveryTriggered = await checkAndRecover();

  // Mark shutdown status as dirty for this session
  await db.app_state.put({
    id: 'shutdown_status',
    value: 'dirty',
    updatedAt: new Date().toISOString(),
  });

  // Generate session ID
  await db.app_state.put({
    id: 'session_id',
    value: crypto.randomUUID(),
    updatedAt: new Date().toISOString(),
  });

  // Store recovery flag for UI notification
  if (recoveryTriggered) {
    await db.app_state.put({
      id: 'recovery_triggered',
      value: true,
      updatedAt: new Date().toISOString(),
    });
  }

  // T063: Restore tab state - focus the last active tab
  const lastActiveEntry = await db.app_state.get('last_active_tab_id');
  if (lastActiveEntry && typeof lastActiveEntry.value === 'string') {
    const targetTab = await db.tabs.get(lastActiveEntry.value);
    if (targetTab) {
      await db.tabs.toCollection().modify({ active: false });
      await db.tabs.update(targetTab.id, { active: true });
    }
  }

  // Render React app
  const root = createRoot(document.getElementById('root')!);
  root.render(<App />);

  // Signal to Main Process that renderer is ready
  await window.datspace.lifecycle.ready();

  // T034: Wire shutdown handler
  window.datspace.lifecycle.onShutdownPrepare(async () => {
    try {
      // Save window state
      await db.app_state.put({
        id: 'shutdown_status',
        value: 'clean',
        updatedAt: new Date().toISOString(),
      });

      // Save last active tab
      const activeTab = await db.tabs.filter((t) => t.active).first();
      if (activeTab) {
        await db.app_state.put({
          id: 'last_active_tab_id',
          value: activeTab.id,
          updatedAt: new Date().toISOString(),
        });
      }

      // Acknowledge shutdown
      await window.datspace.lifecycle.shutdownAck();
    } catch (err) {
      console.error('Error during shutdown preparation:', err);
      // Still ack even on error so the app can quit
      await window.datspace.lifecycle.shutdownAck();
    }
  });

  // T064: Wire window bounds persistence to Dexie.js
  window.datspace.lifecycle.onBoundsChanged(async (bounds) => {
    await db.app_state.put({
      id: 'window_bounds',
      value: bounds,
      updatedAt: new Date().toISOString(),
    });
  });

  // T067: Wire query history sync from DuckDB Worker to Dexie.js
  window.datspace.query.onQueryHistory(async (record) => {
    try {
      await db.query_history.put({
        id: record.queryId,
        sql: record.sql,
        executionTimeMs: record.executionTimeMs,
        rowCount: record.rowCount,
        timestamp: new Date().toISOString(),
        source: 'user',
        tags: [],
        status: record.status,
        errorMessage: record.errorMessage,
      });
    } catch (err) {
      console.error('Failed to sync query history to Dexie.js:', err);
    }
  });

  // Wire worker health updates to Dexie.js
  window.datspace.lifecycle.onWorkerHealth(async (health) => {
    await db.worker_health.put({
      id: health.worker,
      status: health.status,
      restartCount: health.restartCount ?? 0,
      lastHeartbeatAt: new Date().toISOString(),
      lastErrorMessage: health.message,
      upSince: new Date().toISOString(),
      activeQueryCount: 0,
    });
  });
}

bootstrap().catch((err) => {
  console.error('Failed to bootstrap renderer:', err);
});
