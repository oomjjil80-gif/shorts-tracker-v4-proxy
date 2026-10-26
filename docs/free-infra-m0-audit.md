# M0 — No-paid-infrastructure migration audit (Issue #234)

Status: **inventory only; backup NOT VERIFIED; no runtime changes**.

## Verified from source code
- `worker/index.ts`: always-on worker initializes `createPgDbFromEnv()` and a PostgreSQL-backed job store; idle polling/backoff exists. Removing Railway without a replacement stops automated jobs.
- `server/railwayApi.ts`: Express continuity service handles story, sync, materials, health and a hosted HTML page. Requires route-by-route replacement rather than blind removal.
- `tools/migrate.ts`: SQL migrations are applied against `DATABASE_URL`; it is a **write operation**, not a backup tool. Do not execute it as a backup.
- `lib/objectStorage.ts`: Cloudflare R2 integration plus Vercel Blob fallback; media storage is separate from Neon. Preserve both namespaces and references.
- `package.json`: `pg`, `@electric-sql/pglite`, `@vercel/blob`, Chromium and FFmpeg dependencies. PGlite availability does not prove data has migrated.
- Existing usage meter is installed in Worker, but its presence does not prove the requested cross-provider **$20/month hard approval gate**.

## Immediate safety gates (must complete before any cutover)
1. Obtain **read-only** database access through an authorized path, without exposing credentials in chat or commits. Record schema, table list, row counts, foreign keys, jobs and media references. Avoid heavy queries on quota-limited Neon.
2. Export full database to a private encrypted destination. Verify size, checksums and counts; perform isolated restore test. Mark backup VERIFIED only with evidence. If Neon quota blocks access, mark BLOCKED and keep resources intact.
3. Inventory R2/Blob object keys, sizes and pointers; preserve source assets, generated media and metadata. Do not infer that GitHub source is a database backup.
4. Confirm no paid infrastructure upgrade, no credential exposure, no destructive action, and no paid AI API call.
5. Prepare an offline-first 4:5 carousel path independently of the legacy Worker/DB, with project JSON export/import and image export. Commercial hosting terms must be checked.
6. Metered AI gateway must use a shared atomic reservation, per-batch approval, bounded retry, idempotency, cost ledger and monthly USD 20 budget across GPT/Claude/Gemini. UI-only limit is insufficient. Provider-side spend controls where available.

## Acceptance evidence to attach
- [ ] Database inventory and private export checksum
- [ ] Isolated restore successful
- [ ] R2/Blob media inventory
- [ ] Old system untouched and rollback plan
- [ ] No-bill infrastructure deployment proof
- [ ] Card-news mobile export proof
- [ ] Cost gate concurrency / retry / rollover tests

**Do not merge a runtime cutover based on this document alone.**
