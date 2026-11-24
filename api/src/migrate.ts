// Migrations (spec §2, AC-PG-02): plain numbered .sql files in api/migrations/, applied in order, each
// in its own transaction together with its row in schema_migrations. A version already recorded is
// skipped, so running the runner twice is a no-op. No ORM, no down migrations (boring on purpose).
//
//   DATABASE_URL=postgres://... node api/src/migrate.ts
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'

export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')
const FILE = /^(\d{3})_[a-z0-9_]+\.sql$/

// Any constant works; it only has to be the same for every API process sharing the database, so two
// containers starting at once do not both apply the same migration.
const LOCK_KEY = 5_420_001

export type Migration = { version: string; file: string }

export async function listMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  return files.map((file) => {
    const match = FILE.exec(file)
    if (!match?.[1]) throw new Error(`migration file name must look like 001_name.sql: ${file}`)
    return { version: match[1], file }
  })
}

/** Applies every pending migration; returns the versions it applied (empty when already current). */
export async function migrate(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const migrations = await listMigrations(dir)
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY])
    try {
      await client.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      )
      const done = new Set(
        (await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version),
      )
      const applied: string[] = []
      for (const { version, file } of migrations) {
        if (done.has(version)) continue
        const sql = await readFile(join(dir, file), 'utf8')
        await client.query('BEGIN')
        try {
          await client.query(sql) // a trusted file from this repo, never request data
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version])
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw new Error(`migration ${file} failed`, { cause: error })
        }
        applied.push(version)
      }
      return applied
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY])
    }
  } finally {
    client.release()
  }
}

if (import.meta.main) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const applied = await migrate(pool)
    console.log(applied.length > 0 ? `[migrate] applied ${applied.join(', ')}` : '[migrate] already current')
  } finally {
    await pool.end()
  }
}
