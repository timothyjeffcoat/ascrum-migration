// AC-PG-02: migrations from empty to current; a second run is a no-op. Needs DATABASE_URL.
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { listMigrations, migrate } from './migrate.ts'
import { emptySchema, poolFor } from './testDb.ts'

/** Everything a migration could change: tables, columns, constraints, indexes, sequences. */
async function describeSchema(pool: pg.Pool): Promise<unknown> {
  const columns = await pool.query(
    `SELECT table_name, column_name, data_type, character_maximum_length, is_nullable, column_default
     FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position`,
  )
  const constraints = await pool.query(
    `SELECT conrelid::regclass::text AS on_table, conname, pg_get_constraintdef(oid) AS def
     FROM pg_constraint WHERE connamespace = current_schema()::regnamespace ORDER BY 1, 2`,
  )
  const indexes = await pool.query(
    `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() ORDER BY 1, 2`,
  )
  const sequences = await pool.query(
    `SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = current_schema() ORDER BY 1`,
  )
  return { columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows, sequences: sequences.rows }
}

describe('AC-PG-02: migrations', () => {
  it('AC-PG-02: run from an empty schema to current, and running them again is a no-op', async () => {
    const pool = poolFor(await emptySchema())
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = current_schema()')).rows,
    ).toEqual([{ n: 0 }])

    const all = (await listMigrations()).map((m) => m.version)
    expect(all[0]).toBe('001')
    expect(await migrate(pool)).toEqual(all)
    const tables = await pool.query<{ tablename: string }>(
      'SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY 1',
    )
    expect(tables.rows.map((r) => r.tablename)).toEqual([
      'backlog_items',
      'login_throttle',
      'project_team_members',
      'projects',
      'schema_migrations',
      'sessions',
      'sprint_backlog_items',
      'sprints',
      'tasks',
      'users',
    ])
    const before = await describeSchema(pool)
    const recorded = (await pool.query('SELECT version, applied_at FROM schema_migrations ORDER BY version')).rows

    expect(await migrate(pool)).toEqual([])
    expect(await describeSchema(pool)).toEqual(before)
    expect((await pool.query('SELECT version, applied_at FROM schema_migrations ORDER BY version')).rows).toEqual(
      recorded,
    )
  })

  it('AC-PG-02: two processes migrating the same empty database at once apply each migration once', async () => {
    const schema = await emptySchema()
    const [a, b] = await Promise.all([migrate(poolFor(schema)), migrate(poolFor(schema))])
    expect([...(a ?? []), ...(b ?? [])].sort()).toEqual((await listMigrations()).map((m) => m.version))
  })

  it('AC-PG-02: sprint_backlog_items has no foreign key to backlog_items (D13), only to its sprint', async () => {
    const pool = poolFor(await emptySchema())
    await migrate(pool)
    const fks = await pool.query<{ on_table: string; def: string }>(
      `SELECT conrelid::regclass::text AS on_table, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE contype = 'f' AND connamespace = current_schema()::regnamespace ORDER BY 1`,
    )
    expect(fks.rows).toEqual([
      { on_table: 'project_team_members', def: 'FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE' },
      { on_table: 'sprint_backlog_items', def: 'FOREIGN KEY (sprint_id) REFERENCES sprints(id) ON DELETE CASCADE' },
    ])
  })
})
