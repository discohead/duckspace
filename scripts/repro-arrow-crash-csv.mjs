#!/usr/bin/env node
/**
 * Reproduction: to_arrow_ipc() crash with real CSV data.
 *
 * Uses the actual 58-column, 1.5M-row CSV that triggered the original crash.
 * This script uses ONLY @duckdb/node-api — no Electron, no Duckspace code.
 *
 * Tests at various row limits to find the crash threshold.
 */

import { DuckDBInstance } from '@duckdb/node-api';

const CSV_PATH = process.argv[2] || '/Users/jaredmcfarland/Downloads/archive/instagram_usage_lifestyle.csv';
const LIMITS = [10000, 50000, 100000, 200000, 500000, 1000000, 0]; // 0 = no limit

console.log(`\n=== to_arrow_ipc() CSV crash reproduction ===`);
console.log(`CSV: ${CSV_PATH}`);
console.log(`Node: ${process.version}, Arch: ${process.arch}, Platform: ${process.platform}`);

async function testLimit(conn, limit) {
  const limitClause = limit > 0 ? `LIMIT ${limit}` : '';
  const sql = `SELECT * FROM read_csv('${CSV_PATH}') ${limitClause}`;
  const wrappedSql = `SELECT * FROM to_arrow_ipc((${sql}))`;

  const label = limit > 0 ? `${limit.toLocaleString()} rows` : 'ALL rows (~1.5M)';
  process.stdout.write(`  ${label.padEnd(25)} → `);

  try {
    const result = await conn.run(wrappedSql);
    const rows = await result.getRows();

    let totalBytes = 0;
    for (const row of rows) {
      const val = row[0];
      if (val && typeof val === 'object' && 'bytes' in val) {
        totalBytes += val.bytes.length;
      }
    }

    console.log(`OK (${rows.length} chunks, ${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
    return true;
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
    return false;
  }
}

async function main() {
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();

  await conn.run('INSTALL arrow FROM community');
  await conn.run('LOAD arrow');

  // Get CSV stats
  const statsResult = await conn.run(`SELECT COUNT(*) as cnt FROM read_csv('${CSV_PATH}')`);
  const statsRows = await statsResult.getRows();
  console.log(`CSV rows: ${statsRows[0][0]}\n`);

  // Get column count and types
  const descResult = await conn.run(`DESCRIBE SELECT * FROM read_csv('${CSV_PATH}') LIMIT 1`);
  const descRows = await descResult.getRows();
  console.log(`Columns: ${descRows.length}`);
  console.log(`Types: ${descRows.map(r => `${r[0]}:${r[1]}`).slice(0, 5).join(', ')}...\n`);

  console.log('[conn.run() tests]');
  for (const limit of LIMITS) {
    const ok = await testLimit(conn, limit);
    if (!ok) {
      console.log('  (stopping — crash or error detected)');
      break;
    }
  }

  // Also test conn.stream() at the largest working limit
  console.log('\n[conn.stream() tests]');
  for (const limit of [100000, 500000]) {
    const sql = `SELECT * FROM read_csv('${CSV_PATH}') LIMIT ${limit}`;
    const wrappedSql = `SELECT * FROM to_arrow_ipc((${sql}))`;
    const label = `${limit.toLocaleString()} rows (stream)`;
    process.stdout.write(`  ${label.padEnd(25)} → `);

    try {
      const reader = await conn.stream(wrappedSql);
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
      console.log(`OK (${chunkCount} chunks, ${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }
  }

  conn.closeSync();
  instance.closeSync();
  console.log('\n[Done]');
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
