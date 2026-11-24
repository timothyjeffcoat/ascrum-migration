// The translation layer between wire documents and rows (spec §3.2). The SQL schema and the reasons
// behind it are in api/migrations/001_initial_schema.sql; this file is its mirror in code.
//
// The one rule: a field's value goes into its typed column only if the column can give back exactly
// the same JSON value. Anything else (null, a string where a number belongs, an id that is not 24-hex,
// a field the schema does not know) goes into `extra` under its wire name. A given value therefore
// always lives in exactly one place, which is what lets `q` equality be translated exactly (pgStore.ts).
import type { CollectionName, Fields, WireDoc } from '../../web/stub/store.ts'

export type Kind = 'text' | 'number' | 'boolean' | 'id'

/**
 * `secret`: written, never read back (S-p5-1: users.password_hash). A SELECT leaves it out, so no
 * document a store returns holds a password hash, and a value that does not fit is dropped instead of
 * being kept in `extra` as readable data.
 */
export type Column = { wire: string; column: string; kind: Kind; secret?: true }

/** A list of ids kept in a join table, with a flag that tells an empty list from an absent one. */
export type ListField = { wire: string; table: string; owner: string; item: string; flag: string }

export type Table = {
  table: string
  /** Fields in wire order: the seed's order, so seed documents read back byte for byte (AC-PG-03). */
  fields: (Column | ListField)[]
}

const col = (wire: string, column: string, kind: Kind): Column => ({ wire, column, kind })

// Identifiers below are the only text ever spliced into SQL. They are constants, never request data.
export const TABLES: Record<CollectionName, Table> = {
  users: {
    table: 'users',
    fields: [
      col('email', 'email', 'text'),
      // S-p5-1: PgStore puts the scrypt hash of the sent password here (migration 002), never the text.
      { wire: 'password', column: 'password_hash', kind: 'text', secret: true },
      col('firstName', 'first_name', 'text'),
      col('lastName', 'last_name', 'text'),
      col('admin', 'admin', 'boolean'),
    ],
  },
  projects: {
    table: 'projects',
    fields: [
      col('name', 'name', 'text'),
      col('desc', 'description', 'text'),
      col('productOwner', 'product_owner', 'id'),
      col('scrumMaster', 'scrum_master', 'id'),
      {
        wire: 'teamMembers',
        table: 'project_team_members',
        owner: 'project_id',
        item: 'user_id',
        flag: 'has_team_members',
      },
    ],
  },
  productbacklog: {
    table: 'backlog_items',
    fields: [
      col('projectId', 'project_id', 'id'),
      col('name', 'name', 'text'),
      col('desc', 'description', 'text'),
      col('priority', 'priority', 'number'),
      col('estimation', 'estimation', 'number'),
    ],
  },
  sprints: {
    table: 'sprints',
    fields: [
      col('projectId', 'project_id', 'id'),
      col('name', 'name', 'text'),
      col('capacity', 'capacity', 'number'),
      col('start', 'start_on', 'text'),
      col('end', 'end_on', 'text'),
      {
        wire: 'sprintBacklog',
        table: 'sprint_backlog_items',
        owner: 'sprint_id',
        item: 'backlog_item_id',
        flag: 'has_sprint_backlog',
      },
    ],
  },
  tasks: {
    table: 'tasks',
    fields: [
      col('projectId', 'project_id', 'id'),
      col('sprintId', 'sprint_id', 'id'),
      col('productBacklogItemId', 'product_backlog_item_id', 'id'),
      col('name', 'name', 'text'),
      col('desc', 'description', 'text'),
      col('estimation', 'estimation', 'number'),
      col('remaining', 'remaining', 'number'),
      col('state', 'state', 'text'),
      col('assignedUserId', 'assigned_user_id', 'id'),
    ],
  },
}

export const isListField = (field: Column | ListField): field is ListField => 'table' in field

export const columnsOf = (t: Table): Column[] => t.fields.filter((f): f is Column => !isListField(f))
/** The columns a SELECT reads: all but the secret ones. */
export const readableColumnsOf = (t: Table): Column[] => columnsOf(t).filter((f) => !f.secret)
export const listOf = (t: Table): ListField | undefined => t.fields.find(isListField)

const HEX_ID = /^[0-9a-f]{24}$/
export const isHexId = (value: unknown): value is string => typeof value === 'string' && HEX_ID.test(value)

/** Can this column give `value` back unchanged? */
export function fits(kind: Kind, value: unknown): boolean {
  switch (kind) {
    case 'text':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'id':
      return isHexId(value)
  }
}

/** A document split for storage: typed columns (null = absent), the list (if any) and `extra`. */
export type Row = {
  columns: unknown[]
  list: { present: boolean; items: string[] }
  extra: Record<string, unknown>
}

export function toRow(t: Table, fields: Fields): Row {
  // No prototype, so an unknown field named "__proto__" is stored like any other.
  const extra = Object.create(null) as Record<string, unknown>
  const known = new Set<string>(['_id']) // the id comes from the URL or the counter, never the body
  const columns: unknown[] = []
  let list = { present: false, items: [] as string[] }
  for (const field of t.fields) {
    known.add(field.wire)
    const present = Object.hasOwn(fields, field.wire)
    const value = fields[field.wire]
    if (isListField(field)) {
      if (Array.isArray(value) && value.every(isHexId)) list = { present: true, items: value }
      else if (present) extra[field.wire] = value
    } else if (present && fits(field.kind, value)) {
      columns.push(value)
    } else if (field.secret) {
      columns.push(null) // never into extra
    } else {
      columns.push(null)
      if (present) extra[field.wire] = value
    }
  }
  for (const [key, value] of Object.entries(fields)) if (!known.has(key)) extra[key] = value
  return { columns, list, extra }
}

/** What a SELECT returns for one document: its id, the typed columns by name, the flag and extra. */
export type StoredRow = { id: string; extra: Record<string, unknown>; [column: string]: unknown }

export function toDoc(t: Table, row: StoredRow, items: string[]): WireDoc {
  // Entries, then Object.fromEntries: a field named "__proto__" stays an ordinary field.
  const entries: [string, unknown][] = [['_id', { $oid: row.id }]]
  const extra = row.extra
  for (const field of t.fields) {
    if (!isListField(field) && field.secret) continue
    if (isListField(field)) {
      if (row[field.flag] === true) entries.push([field.wire, items])
      else if (Object.hasOwn(extra, field.wire)) entries.push([field.wire, extra[field.wire]])
    } else if (row[field.column] !== null) {
      entries.push([field.wire, row[field.column]])
    } else if (Object.hasOwn(extra, field.wire)) {
      entries.push([field.wire, extra[field.wire]])
    }
  }
  const known = new Set(t.fields.map((f) => f.wire))
  for (const [key, value] of Object.entries(extra)) if (!known.has(key)) entries.push([key, value])
  return Object.fromEntries(entries) as WireDoc
}
