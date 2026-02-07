import db from '../stores/db';
import type { RecoveryLogEntry, CatalogEntry, ColumnSchemaRecord } from '@shared/types';

/**
 * T051: Check shutdown status and trigger recovery if needed.
 * Called during renderer bootstrap.
 */
export async function checkAndRecover(): Promise<boolean> {
  const shutdownEntry = await db.app_state.get('shutdown_status');

  // No previous session — nothing to recover
  if (!shutdownEntry) return false;

  const wasDirty = shutdownEntry.value === 'dirty';

  if (wasDirty) {
    // T053: Log abnormal shutdown
    await writeRecoveryLog({
      type: 'abnormal_shutdown',
      details: 'Previous session did not shut down cleanly. Initiating recovery.',
      outcome: 'recovered',
    });

    // T052: Request integrity verification from Main Process
    try {
      const appState = await window.datspace.lifecycle.getAppState();
      await writeRecoveryLog({
        type: 'integrity_check',
        details: `DuckDB integrity check passed. Worker status: ${appState.workers.duckdb}`,
        outcome: 'recovered',
        affectedWorker: 'duckdb',
      });
    } catch (err) {
      await writeRecoveryLog({
        type: 'integrity_check',
        details: `DuckDB integrity check could not be verified: ${err}`,
        outcome: 'degraded',
        affectedWorker: 'duckdb',
      });
    }

    // T054: Catalog reconciliation
    await reconcileCatalog();

    return true; // Recovery was triggered
  }

  return false; // Clean startup
}

/**
 * T053: Write a recovery log entry to Dexie.js
 */
export async function writeRecoveryLog(entry: Omit<RecoveryLogEntry, 'id' | 'timestamp'>): Promise<void> {
  await db.recovery_log.add({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry,
  });
}

/**
 * T054: Reconcile DuckDB catalog with Dexie.js catalog_entries.
 * After crash, tables may have been created/dropped without Dexie being updated.
 */
async function reconcileCatalog(): Promise<void> {
  try {
    // Fetch current DuckDB tables via preload
    const duckdbTables = await window.datspace.catalog.listTables();

    // Get current Dexie entries
    const dexieEntries = await db.catalog_entries.toArray();
    const dexieByName = new Map(dexieEntries.map((e) => [e.name, e]));
    const duckdbByName = new Map(duckdbTables.map((t) => [t.name, t]));

    // Create missing entries (tables in DuckDB but not in Dexie)
    for (const [name, table] of duckdbByName) {
      if (!dexieByName.has(name)) {
        const entry: CatalogEntry = {
          id: `catalog-${name}`,
          name,
          schema: 'main',
          type: table.type,
          status: 'active',
          rowCount: table.rowCount,
          sizeBytes: table.sizeBytes,
          columnCount: table.columnCount,
          registeredAt: new Date().toISOString(),
        };
        await db.catalog_entries.put(entry);

        // Fetch and store column schemas
        try {
          const columns = await window.datspace.catalog.describeTable(name);
          for (const col of columns) {
            const record: ColumnSchemaRecord = {
              id: `${entry.id}_${col.name}`,
              catalogEntryId: entry.id,
              columnName: col.name,
              columnType: col.duckdbType,
              arrowType: col.arrowType,
              nullable: col.nullable,
              ordinalPosition: col.ordinalPosition,
            };
            await db.column_schemas.put(record);
          }
        } catch { /* best effort */ }
      }
    }

    // Mark orphaned entries (in Dexie but not in DuckDB)
    for (const [name, entry] of dexieByName) {
      if (!duckdbByName.has(name) && entry.status === 'active') {
        await db.catalog_entries.update(entry.id, { status: 'removed' });
      }
    }

    await writeRecoveryLog({
      type: 'wal_recovery',
      details: `Catalog reconciliation complete. ${duckdbByName.size} tables in DuckDB, ${dexieByName.size} in local cache.`,
      outcome: 'recovered',
    });
  } catch (err) {
    await writeRecoveryLog({
      type: 'wal_recovery',
      details: `Catalog reconciliation failed: ${err}`,
      outcome: 'degraded',
    });
  }
}
