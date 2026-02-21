#!/usr/bin/env node
/**
 * Reproduction attempt with mixed data types and worker_threads context.
 *
 * Our actual crash occurred in an Electron worker_thread, with real CSV/Parquet
 * data that has mixed column types. This script tests both factors.
 */

import { DuckDBInstance } from '@duckdb/node-api';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const NUM_COLUMNS = parseInt(process.argv[2] || '60', 10);
const NUM_ROWS = parseInt(process.argv[3] || '100000', 10);

if (isMainThread) {
  console.log(`\n=== to_arrow_ipc() mixed-type + worker_threads reproduction ===`);
  console.log(`Columns: ${NUM_COLUMNS}, Rows: ${NUM_ROWS}`);
  console.log(`Node: ${process.version}, Arch: ${process.arch}, Platform: ${process.platform}\n`);

  // Run tests in main thread first, then in worker thread
  await runTests('main-thread');

  console.log('\n--- Now running inside worker_threads ---\n');

  const __filename = fileURLToPath(import.meta.url);
  const worker = new Worker(__filename, {
    workerData: { numColumns: NUM_COLUMNS, numRows: NUM_ROWS },
  });

  worker.on('message', (msg) => console.log(`[worker] ${msg}`));
  worker.on('error', (err) => console.error(`[worker ERROR] ${err.message}`));
  worker.on('exit', (code) => {
    console.log(`[worker exited with code ${code}]`);
    if (code !== 0) process.exit(code);
  });
} else {
  // Worker thread
  const { numColumns, numRows } = workerData;
  try {
    await runTests('worker-thread', numColumns, numRows);
    parentPort.postMessage('All tests passed in worker thread');
  } catch (err) {
    parentPort.postMessage(`FAILED: ${err.message}`);
    process.exit(1);
  }
}

async function runTests(context, cols = NUM_COLUMNS, rows = NUM_ROWS) {
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();

  await conn.run('INSTALL arrow FROM community');
  await conn.run('LOAD arrow');

  // Generate mixed-type columns (closer to real CSV/Parquet data)
  const types = ['INTEGER', 'BIGINT', 'DOUBLE', 'VARCHAR', 'BOOLEAN', 'DATE', 'TIMESTAMP'];
  const colDefs = [];
  const colExprs = [];

  for (let i = 0; i < cols; i++) {
    const type = types[i % types.length];
    colDefs.push(`col_${i} ${type}`);

    switch (type) {
      case 'INTEGER':
        colExprs.push(`(i + ${i})::INTEGER AS col_${i}`);
        break;
      case 'BIGINT':
        colExprs.push(`(i * 1000000 + ${i})::BIGINT AS col_${i}`);
        break;
      case 'DOUBLE':
        colExprs.push(`(i * 3.14159 + ${i})::DOUBLE AS col_${i}`);
        break;
      case 'VARCHAR':
        colExprs.push(`('row_' || i::VARCHAR || '_col${i}')::VARCHAR AS col_${i}`);
        break;
      case 'BOOLEAN':
        colExprs.push(`(i % 2 = 0)::BOOLEAN AS col_${i}`);
        break;
      case 'DATE':
        colExprs.push(`(DATE '2020-01-01' + (i % 1000)::INTEGER)::DATE AS col_${i}`);
        break;
      case 'TIMESTAMP':
        colExprs.push(`(TIMESTAMP '2020-01-01' + INTERVAL (i % 86400) SECOND)::TIMESTAMP AS col_${i}`);
        break;
    }
  }

  console.log(`[${context}] Creating mixed-type table: ${cols} cols × ${rows} rows...`);
  await conn.run(`CREATE TABLE mixed_test (${colDefs.join(', ')})`);
  await conn.run(`INSERT INTO mixed_test SELECT ${colExprs.join(', ')} FROM range(${rows}) t(i)`);

  // Test with conn.run()
  console.log(`[${context}] conn.run() + to_arrow_ipc()...`);
  try {
    const result = await conn.run('SELECT * FROM to_arrow_ipc((SELECT * FROM mixed_test))');
    const ipcRows = await result.getRows();
    let totalBytes = 0;
    for (const row of ipcRows) {
      const val = row[0];
      if (val && typeof val === 'object' && 'bytes' in val) {
        totalBytes += val.bytes.length;
      }
    }
    console.log(`[${context}] OK: ${ipcRows.length} chunks, ${totalBytes} bytes`);
  } catch (err) {
    console.error(`[${context}] ERROR: ${err.message}`);
  }

  // Test with conn.stream()
  console.log(`[${context}] conn.stream() + to_arrow_ipc()...`);
  try {
    const reader = await conn.stream('SELECT * FROM to_arrow_ipc((SELECT * FROM mixed_test))');
    let chunkCount = 0;
    let totalBytes = 0;

    while (true) {
      const chunk = await reader.fetchChunk();
      if (!chunk || chunk.rowCount === 0) break;
      chunkCount++;
      for (let r = 0; r < chunk.rowCount; r++) {
        const val = chunk.getColumnValues(0)[r];
        if (val && typeof val === 'object' && 'bytes' in val) {
          totalBytes += val.bytes.length;
        }
      }
    }
    console.log(`[${context}] OK: ${chunkCount} stream chunks, ${totalBytes} bytes`);
  } catch (err) {
    console.error(`[${context}] ERROR: ${err.message}`);
  }

  conn.closeSync();
  instance.closeSync();
}
