// Test-only SqlDb adapter: real Postgres semantics in-process (PGlite), running the production SQL migration.
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import type { Queryable, SqlDb } from '../lib/jobs/db.js'

export async function createTestDb(): Promise<SqlDb & { raw: PGlite }> {
  const pg = new PGlite()
  await pg.exec(readFileSync(new URL('../db/001_jobs.sql', import.meta.url), 'utf8'))
  const wrap = (c: { query: PGlite['query'] }): Queryable => ({
    query: async (sql, params) => { const r: any = await c.query(sql, params as any[]); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length } }
  })
  return { ...wrap(pg), raw: pg, transaction: (fn) => pg.transaction((tx) => fn(wrap(tx as any))), close: () => pg.close() }
}
