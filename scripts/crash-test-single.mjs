#!/usr/bin/env node
/** Single-shot crash test. Exits 0 on success, crashes (SIGTRAP) on failure. */
import { DuckDBInstance } from '@duckdb/node-api';

const NUM_ROWS = parseInt(process.argv[2] || '200000', 10);
const NUM_COLUMNS = 58;

const instance = await DuckDBInstance.create(':memory:');
const conn = await instance.connect();
await conn.run('INSTALL arrow FROM community');
await conn.run('LOAD arrow');

const types = ['BIGINT', 'VARCHAR', 'DOUBLE', 'BOOLEAN', 'DATE', 'BIGINT', 'VARCHAR'];
const colDefs = Array.from({ length: NUM_COLUMNS }, (_, i) => `col_${i} ${types[i % types.length]}`).join(', ');
const colExprs = Array.from({ length: NUM_COLUMNS }, (_, i) => {
  switch (types[i % types.length]) {
    case 'BIGINT':  return `(i+${i})::BIGINT AS col_${i}`;
    case 'VARCHAR': return `('v'||i::VARCHAR)::VARCHAR AS col_${i}`;
    case 'DOUBLE':  return `(i*3.14)::DOUBLE AS col_${i}`;
    case 'BOOLEAN': return `(i%2=0)::BOOLEAN AS col_${i}`;
    case 'DATE':    return `(DATE'2020-01-01'+(i%1000)::INTEGER)::DATE AS col_${i}`;
  }
}).join(', ');

await conn.run(`CREATE TABLE t (${colDefs})`);
await conn.run(`INSERT INTO t SELECT ${colExprs} FROM range(${NUM_ROWS}) t(i)`);
const result = await conn.run(`SELECT * FROM to_arrow_ipc((SELECT * FROM t))`);
await result.getRows();
conn.closeSync();
instance.closeSync();
