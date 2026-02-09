#!/usr/bin/env node
/**
 * Reproduction attempt: conn.stream() with to_arrow_ipc().
 *
 * Our code comments say conn.stream() triggers a nanoarrow SIGTRAP crash
 * in ArrowScalarData<double>::Initialize, which is why we use conn.run().
 */

import { DuckDBInstance } from '@duckdb/node-api';

const NUM_COLUMNS = parseInt(process.argv[2] || '60', 10);
const NUM_ROWS = parseInt(process.argv[3] || '100000', 10);

console.log(`\n=== to_arrow_ipc() + conn.stream() crash reproduction ===`);
console.log(`Columns: ${NUM_COLUMNS}, Rows: ${NUM_ROWS}`);
console.log(`Node: ${process.version}, Arch: ${process.arch}, Platform: ${process.platform}\n`);

async function main() {
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();

  await conn.run('INSTALL arrow FROM community');
  await conn.run('LOAD arrow');

  const colDefs = Array.from({ length: NUM_COLUMNS }, (_, i) => `col_${i} INTEGER`).join(', ');
  const colExprs = Array.from({ length: NUM_COLUMNS }, (_, i) => `(i + ${i}) AS col_${i}`).join(', ');

  await conn.run(`CREATE TABLE wide_test (${colDefs})`);
  await conn.run(`INSERT INTO wide_test SELECT ${colExprs} FROM range(${NUM_ROWS}) t(i)`);

  // Test 1: conn.stream() with to_arrow_ipc()
  console.log('[Test 1] conn.stream() with to_arrow_ipc()...');
  try {
    const reader = await conn.stream('SELECT * FROM to_arrow_ipc((SELECT * FROM wide_test))');
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

    console.log(`[OK] stream() succeeded: ${chunkCount} chunks, ${totalBytes} bytes`);
  } catch (err) {
    console.error(`[ERROR] stream() threw: ${err.message}`);
  }

  // Test 2: Concurrent conn.run() calls (no mutex)
  console.log('\n[Test 2] Concurrent conn.run() calls with to_arrow_ipc()...');
  try {
    const sql = `SELECT * FROM to_arrow_ipc((SELECT * FROM wide_test LIMIT 10000))`;
    const [r1, r2] = await Promise.all([
      conn.run(sql),
      conn.run(sql),
    ]);

    const rows1 = await r1.getRows();
    const rows2 = await r2.getRows();
    console.log(`[OK] Concurrent calls succeeded: ${rows1.length} + ${rows2.length} chunks`);
  } catch (err) {
    console.error(`[ERROR] Concurrent calls threw: ${err.message}`);
  }

  conn.closeSync();
  instance.closeSync();
  console.log('\n[Done]');
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
