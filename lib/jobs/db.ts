// Provider-neutral SQL access. Production uses any Postgres via DATABASE_URL (node-postgres);
// tests use PGlite (tools/testDb.ts). No provider SDK is imported here.

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>
}
export interface SqlDb extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>
  close?(): Promise<void>
}

export async function createPgDbFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<SqlDb> {
  const url = env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not configured (Production Job store needs a Postgres database)')
  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString: url, max: Number(env.DATABASE_POOL_MAX || 5), ssl: env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false } })
  const wrap = (c: { query: (s: string, p?: unknown[]) => Promise<any> }): Queryable => ({
    query: async (sql, params) => { const r = await c.query(sql, params as unknown[]); return { rows: r.rows, rowCount: r.rowCount ?? 0 } }
  })
  return {
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const out = await fn(wrap(client))
        await client.query('COMMIT')
        return out
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      } finally { client.release() }
    },
    close: () => pool.end()
  }
}
