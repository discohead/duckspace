#!/usr/bin/env node
/**
 * Minimal reproduction: to_arrow_ipc() SIGTRAP crash with wide tables.
 *
 * This script uses ONLY @duckdb/node-api (no Electron, no Datspace code)
 * to demonstrate that to_arrow_ipc() crashes the Node.js process when
 * given a wide table (many columns) at high row counts.
 *
 * Expected behavior: The query should return Arrow IPC blobs.
 * Actual behavior: The process crashes with SIGTRAP / EXC_BREAKPOINT
 *   in ArrowScalarData::Initialize (nanoarrow ArrowAppender constructor).
 *
 * Usage:
 *   node scripts/repro-arrow-crash.mjs [columns] [rows]
 *   node scripts/repro-arrow-crash.mjs 60 100000    # crashes
 *   node scripts/repro-arrow-crash.mjs 10 100000    # works (narrow table)
 *   node scripts/repro-arrow-crash.mjs 60 10000     # works (few rows)
 */

import { DuckDBInstance } from '@duckdb/node-api';

const NUM_COLUMNS = parseInt(process.argv[2] || '60', 10);
const NUM_ROWS = parseInt(process.argv[3] || '100000', 10);

console.log(`\n=== to_arrow_ipc() crash reproduction ===`);
console.log(`Columns: ${NUM_COLUMNS}`);
console.log(`Rows:    ${NUM_ROWS}`);
console.log(`Node:    ${process.version}`);
console.log(`Arch:    ${process.arch}`);
console.log(`Platform: ${process.platform}`);

async function main() {
  // Step 1: Create in-memory DuckDB instance
  console.log('\n[1] Creating DuckDB instance...');
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();

  // Step 2: Install and load the arrow community extension
  console.log('[2] Loading arrow extension...');
  await conn.run('INSTALL arrow FROM community');
  await conn.run('LOAD arrow');

  // Step 3: Generate a wide table with the specified number of columns and rows
  const colDefs = Array.from({ length: NUM_COLUMNS }, (_, i) => `col_${i} INTEGER`).join(', ');
  const colExprs = Array.from({ length: NUM_COLUMNS }, (_, i) => `(i + ${i}) AS col_${i}`).join(', ');

  console.log(`[3] Creating table with ${NUM_COLUMNS} columns, ${NUM_ROWS} rows...`);
  await conn.run(`CREATE TABLE wide_test (${colDefs})`);
  await conn.run(`INSERT INTO wide_test SELECT ${colExprs} FROM range(${NUM_ROWS}) t(i)`);

  // Verify table was created
  const countResult = await conn.run('SELECT COUNT(*) AS cnt FROM wide_test');
  const countRows = await countResult.getRows();
  console.log(`    Table created: ${countRows[0][0]} rows × ${NUM_COLUMNS} columns`);

  // Step 4: Execute to_arrow_ipc() — this is where the crash occurs
  console.log('[4] Running to_arrow_ipc()...');
  console.log('    SQL: SELECT * FROM to_arrow_ipc((SELECT * FROM wide_test))');
  console.log('    (If the process crashes here, the bug is confirmed)\n');

  try {
    const result = await conn.run('SELECT * FROM to_arrow_ipc((SELECT * FROM wide_test))');
    const rows = await result.getRows();

    // If we get here, the query succeeded (no crash)
    let totalBytes = 0;
    for (const row of rows) {
      const blob = row[0];
      if (blob && typeof blob === 'object' && 'bytes' in blob) {
        totalBytes += blob.bytes.length;
      }
    }

    console.log(`[OK] Query succeeded — ${rows.length} IPC chunks, ${totalBytes} bytes total`);
    console.log('     No crash occurred at this column/row combination.');
  } catch (err) {
    console.error(`[ERROR] Query threw: ${err.message}`);
  }

  // Cleanup
  conn.closeSync();
  instance.closeSync();
  console.log('\n[Done]');
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
