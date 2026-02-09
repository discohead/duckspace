#!/usr/bin/env node
/**
 * Minimal reproduction: to_arrow_ipc() SIGTRAP crash in Electron worker_threads.
 *
 * This script demonstrates that the nanoarrow DuckDB extension crashes with
 * SIGTRAP (EXC_BREAKPOINT) in ArrowScalarData<long long>::Initialize when
 * to_arrow_ipc() is called on a wide table (58+ columns) at row counts >= 200k
 * inside an Electron process.
 *
 * The SAME query succeeds in standalone Node.js (even at 1.5M rows).
 *
 * Environment:
 *   - Electron 33.4.11 (Node.js 20.18.0)
 *   - @duckdb/node-api 1.4.4
 *   - nanoarrow community extension (INSTALL arrow FROM community)
 *   - macOS 26.2 / Apple Silicon (ARM64)
 *
 * Crash stack (from macOS crash report):
 *   nanoarrow.duckdb_extension  ArrowScalarData<long long>::Initialize
 *   nanoarrow.duckdb_extension  ArrowAppender::InitializeChild
 *   nanoarrow.duckdb_extension  ArrowAppender::ArrowAppender (constructor)
 *   nanoarrow.duckdb_extension  ToArrowIPCFunction::Function
 *   libduckdb.dylib             PhysicalTableInOutFunction::Execute
 *   libduckdb.dylib             PipelineExecutor::Execute
 *   libduckdb.dylib             TaskScheduler::ExecuteForever
 *
 * Usage (standalone Node.js — does NOT crash):
 *   node scripts/repro-electron-nanoarrow-crash.mjs
 *
 * To reproduce the crash in Electron:
 *   1. npm install electron @duckdb/node-api
 *   2. Run with Electron:
 *      ELECTRON_RUN_AS_NODE=1 npx electron scripts/repro-electron-nanoarrow-crash.mjs
 *      (This runs the script inside Electron's Node.js runtime)
 */

import { DuckDBInstance } from '@duckdb/node-api';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

// Parameters that trigger the crash in Electron
const NUM_COLUMNS = 58;
const LIMITS = [10_000, 50_000, 100_000, 200_000, 500_000];

if (isMainThread) {
  const isElectron = typeof process.versions.electron !== 'undefined';
  console.log(`\n=== nanoarrow to_arrow_ipc() crash reproduction ===`);
  console.log(`Runtime:  ${isElectron ? 'Electron ' + process.versions.electron : 'Node.js'}`);
  console.log(`Node:     ${process.version}`);
  console.log(`Arch:     ${process.arch}`);
  console.log(`Platform: ${process.platform}`);
  console.log(`Columns:  ${NUM_COLUMNS}`);
  console.log(`Limits:   ${LIMITS.join(', ')}`);

  // Test 1: Main thread
  console.log(`\n--- Main thread tests ---`);
  await runTests('main');

  // Test 2: Worker thread (matches Electron app's DuckDB worker pattern)
  console.log(`\n--- Worker thread tests ---`);
  const __filename = fileURLToPath(import.meta.url);
  const worker = new Worker(__filename, {
    workerData: { runInWorker: true },
  });

  worker.on('message', (msg) => console.log(msg));
  worker.on('error', (err) => console.error(`[worker ERROR] ${err.message}`));
  worker.on('exit', (code) => {
    if (code !== 0) {
      console.log(`\n[worker CRASHED with exit code ${code}]`);
      console.log('This confirms the crash when running inside a worker_thread.');
    } else {
      console.log('\n[worker completed normally]');
    }
    console.log('\n[Done]');
  });
} else {
  // Worker thread
  try {
    await runTests('worker');
    parentPort.postMessage('[worker] All tests passed');
  } catch (err) {
    parentPort.postMessage(`[worker] FAILED: ${err.message}`);
    process.exit(1);
  }
}

async function runTests(context) {
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();

  // Load nanoarrow extension
  await conn.run('INSTALL arrow FROM community');
  await conn.run('LOAD arrow');

  // Get DuckDB version
  const verResult = await conn.run('SELECT version()');
  const verRows = await verResult.getRows();
  console.log(`[${context}] DuckDB ${verRows[0][0]}`);

  // Generate mixed-type columns matching real CSV data
  const types = ['BIGINT', 'VARCHAR', 'DOUBLE', 'BOOLEAN', 'DATE', 'BIGINT', 'VARCHAR'];
  const colDefs = [];
  const colExprs = [];

  for (let i = 0; i < NUM_COLUMNS; i++) {
    const type = types[i % types.length];
    colDefs.push(`col_${i} ${type}`);

    switch (type) {
      case 'BIGINT':
        colExprs.push(`(i + ${i})::BIGINT AS col_${i}`);
        break;
      case 'VARCHAR':
        colExprs.push(`('val_' || i::VARCHAR || '_${i}')::VARCHAR AS col_${i}`);
        break;
      case 'DOUBLE':
        colExprs.push(`(i * 3.14 + ${i})::DOUBLE AS col_${i}`);
        break;
      case 'BOOLEAN':
        colExprs.push(`(i % 2 = 0)::BOOLEAN AS col_${i}`);
        break;
      case 'DATE':
        colExprs.push(`(DATE '2020-01-01' + (i % 1000)::INTEGER)::DATE AS col_${i}`);
        break;
    }
  }

  await conn.run(`CREATE TABLE test_data (${colDefs.join(', ')})`);

  for (const limit of LIMITS) {
    // Insert exactly 'limit' rows
    await conn.run('DELETE FROM test_data');
    await conn.run(
      `INSERT INTO test_data SELECT ${colExprs.join(', ')} FROM range(${limit}) t(i)`,
    );

    process.stdout.write(`[${context}] ${limit.toLocaleString()} rows × ${NUM_COLUMNS} cols → `);

    try {
      const result = await conn.run(
        `SELECT * FROM to_arrow_ipc((SELECT * FROM test_data))`,
      );
      const ipcRows = await result.getRows();
      let totalBytes = 0;
      for (const row of ipcRows) {
        const val = row[0];
        if (val && typeof val === 'object' && 'bytes' in val) {
          totalBytes += val.bytes.length;
        }
      }
      console.log(`OK (${ipcRows.length} chunks, ${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }
  }

  conn.closeSync();
  instance.closeSync();
}
