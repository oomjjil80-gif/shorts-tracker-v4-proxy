// npm run db:migrate  — applies db/*.sql in order against DATABASE_URL (idempotent, recorded in schema_migrations).
import { readdirSync, readFileSync } from 'node:fs'
import { createPgDbFromEnv } from '../lib/jobs/db.js'

const db = await createPgDbFromEnv()
await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
for (const file of readdirSync(new URL('../db/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort()) {
  const done = await db.query('SELECT 1 FROM schema_migrations WHERE name=$1', [file])
  if (done.rows[0]) { console.log('skip', file); continue }
  await db.transaction(async (tx) => {
    await tx.query(readFileSync(new URL(`../db/${file}`, import.meta.url), 'utf8'))
    await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
  })
  console.log('applied', file)
}
await db.close?.()
