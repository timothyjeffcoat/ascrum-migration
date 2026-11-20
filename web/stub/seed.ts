// Deterministic demo data (spec §7.6, owner answer C4). Ids are fixed so tests and docs can name them.
// Every call returns fresh objects: the store mutates documents, the seed must stay pristine.
import type { CollectionName, WireDoc } from './store.ts'

/** Fixed 24-hex id: one hex digit per collection, then a number. */
function oid(prefix: string, n: number): string {
  return prefix + n.toString(16).padStart(23, '0')
}

export const USER = {
  admin: oid('1', 1),
  po: oid('1', 2),
  sm: oid('1', 3),
  dev1: oid('1', 4),
  dev2: oid('1', 5),
  outsider: oid('1', 6),
} as const

export const PROJECT = {
  webshop: oid('2', 1),
  mobileApp: oid('2', 2),
  legacyCleanup: oid('2', 3),
} as const

export const BACKLOG = {
  catalogue: oid('3', 1),
  cart: oid('3', 2),
  checkout: oid('3', 3),
  orderHistory: oid('3', 4),
  search: oid('3', 5),
  wishList: oid('3', 6),
  login: oid('3', 7),
  push: oid('3', 8),
  offline: oid('3', 9),
  /** Referenced by a sprint but never present: the D13 "deleted backlog item" case. */
  deleted: oid('3', 255),
} as const

export const SPRINT = {
  webshop1: oid('4', 1),
  webshop2: oid('4', 2),
  mobile1: oid('4', 3), // has 0 tasks
} as const

/** Demo credentials, also listed in the README. */
export const CREDENTIALS = {
  admin: { email: 'admin@abc.com', password: 'changeme' },
  po: { email: 'po@ascrum.test', password: 'demo' },
  sm: { email: 'sm@ascrum.test', password: 'demo' },
  dev1: { email: 'dev1@ascrum.test', password: 'demo' },
  dev2: { email: 'dev2@ascrum.test', password: 'demo' },
  outsider: { email: 'outsider@ascrum.test', password: 'demo' },
} as const

type Fields = Record<string, unknown>
const doc = (id: string, fields: Fields): WireDoc => ({ _id: { $oid: id }, ...fields })

function users(): WireDoc[] {
  const user = (id: string, who: keyof typeof CREDENTIALS, firstName: string, lastName: string) =>
    doc(id, { ...CREDENTIALS[who], firstName, lastName, admin: who === 'admin' })
  return [
    user(USER.admin, 'admin', 'Admin', 'User'), // legacy initDB.js admin
    user(USER.po, 'po', 'Paula', 'Owner'),
    user(USER.sm, 'sm', 'Sam', 'Master'),
    user(USER.dev1, 'dev1', 'Dana', 'Developer'),
    user(USER.dev2, 'dev2', 'Devon', 'Coder'),
    user(USER.outsider, 'outsider', 'Otto', 'Outsider'),
  ]
}

function projects(): WireDoc[] {
  return [
    doc(PROJECT.webshop, {
      name: 'Webshop',
      desc: 'Online store rewrite',
      productOwner: USER.po,
      scrumMaster: USER.sm,
      teamMembers: [USER.dev1, USER.dev2],
    }),
    doc(PROJECT.mobileApp, {
      name: 'Mobile App',
      desc: 'Companion app for the webshop',
      productOwner: USER.sm,
      scrumMaster: USER.dev1,
      teamMembers: [USER.dev2],
    }),
    // D13: a partial document. No teamMembers (and no scrumMaster) field at all.
    doc(PROJECT.legacyCleanup, {
      name: 'Legacy Cleanup',
      desc: 'Retire the old intranet',
      productOwner: USER.admin,
    }),
  ]
}

function productBacklog(): WireDoc[] {
  const item = (id: string, projectId: string, name: string, desc: string, priority: number, estimation: number) =>
    doc(id, { projectId, name, desc, priority, estimation })
  return [
    item(BACKLOG.catalogue, PROJECT.webshop, 'Product catalogue', 'Browse products by category', 1, 5),
    item(BACKLOG.cart, PROJECT.webshop, 'Shopping cart', 'Add, remove and update items', 2, 8),
    item(BACKLOG.checkout, PROJECT.webshop, 'Checkout', 'Address, shipping and payment', 3, 13),
    item(BACKLOG.orderHistory, PROJECT.webshop, 'Order history', 'Customers see their past orders', 4, 5),
    item(BACKLOG.search, PROJECT.webshop, 'Search', 'Full-text product search', 5, 8),
    item(BACKLOG.wishList, PROJECT.webshop, 'Wish list', 'Save products for later', 6, 3),
    item(BACKLOG.login, PROJECT.mobileApp, 'Login screen', 'Sign in with the webshop account', 1, 3),
    item(BACKLOG.push, PROJECT.mobileApp, 'Push notifications', 'Order status updates', 2, 5),
    item(BACKLOG.offline, PROJECT.mobileApp, 'Offline mode', 'Browse the catalogue without a connection', 3, 13),
  ]
}

function sprints(): WireDoc[] {
  return [
    doc(SPRINT.webshop1, {
      projectId: PROJECT.webshop,
      name: 'Sprint 1',
      capacity: 20,
      start: '2026-11-02',
      end: '2026-11-13',
      sprintBacklog: [BACKLOG.catalogue, BACKLOG.cart, BACKLOG.deleted], // D13: dangling id
    }),
    doc(SPRINT.webshop2, {
      projectId: PROJECT.webshop,
      name: 'Sprint 2',
      capacity: 20,
      start: '2026-11-16',
      end: '2026-11-27',
      sprintBacklog: [BACKLOG.checkout, BACKLOG.orderHistory],
    }),
    doc(SPRINT.mobile1, {
      projectId: PROJECT.mobileApp,
      name: 'Sprint 1',
      capacity: 15,
      start: '2026-11-09',
      end: '2026-11-20',
      sprintBacklog: [BACKLOG.login],
    }),
  ]
}

function tasks(): WireDoc[] {
  let n = 0
  const task = (
    sprintId: string,
    productBacklogItemId: string,
    name: string,
    estimation: number,
    remaining: number,
    state: 'TODO' | 'IN_DEV' | 'BLOCKED' | 'IN_TEST' | 'DONE',
    assignedUserId?: string,
  ) => {
    n += 1
    const fields: Fields = {
      projectId: PROJECT.webshop,
      sprintId,
      productBacklogItemId,
      name,
      desc: name,
      estimation,
      remaining,
      state,
    }
    if (assignedUserId) fields.assignedUserId = assignedUserId // unassigned = field absent
    return doc(oid('5', n), fields)
  }
  const s1 = SPRINT.webshop1
  const s2 = SPRINT.webshop2
  return [
    task(s1, BACKLOG.catalogue, 'Design catalogue page', 3, 0, 'DONE', USER.dev1),
    task(s1, BACKLOG.catalogue, 'Category API endpoint', 5, 0, 'DONE', USER.dev2),
    task(s1, BACKLOG.catalogue, 'Product image thumbnails', 2, 1, 'IN_TEST', USER.dev1),
    task(s1, BACKLOG.cart, 'Cart data model', 3, 2, 'IN_DEV', USER.dev2),
    task(s1, BACKLOG.cart, 'Cart UI', 5, 5, 'TODO'),
    task(s1, BACKLOG.cart, 'Cart persistence', 3, 3, 'BLOCKED', USER.dev1),
    task(s1, BACKLOG.cart, 'Price rounding bug', 1, 1, 'TODO'),
    task(s2, BACKLOG.checkout, 'Address form', 3, 3, 'TODO', USER.dev1),
    task(s2, BACKLOG.checkout, 'Payment provider spike', 5, 4, 'IN_DEV', USER.dev2),
    task(s2, BACKLOG.checkout, 'Shipping options', 3, 3, 'TODO'),
    task(s2, BACKLOG.orderHistory, 'Order history list', 3, 1, 'IN_TEST', USER.dev2),
    task(s2, BACKLOG.orderHistory, 'Order details page', 2, 2, 'BLOCKED'),
  ]
}

export function seedCollections(): Record<CollectionName, WireDoc[]> {
  return { users: users(), projects: projects(), productbacklog: productBacklog(), sprints: sprints(), tasks: tasks() }
}
