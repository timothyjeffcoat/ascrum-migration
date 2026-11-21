import { beforeEach, describe, expect, it } from 'vitest'
import { recordRequests, resetClientState, signIn } from '../test/renderRoute.tsx'
import { failNext } from '../test/stubControl.ts'
import { BACKLOG, PROJECT, SPRINT, USER } from '../../stub/seed.ts'
import { ApiError } from './errors.ts'
import { productBacklog, projects, sprints, tasks, users } from './collections.ts'

const COLLECTIONS = '/databases/ascrum/collections'

beforeEach(() => resetClientState())

describe('api/collection', () => {
  it('AC-API-03: collection(name) targets /databases/ascrum/collections/<name>; query sends q=JSON; all() sends q={}', async () => {
    const seen = recordRequests()
    const all = await users.all()
    const byEmail = await users.query({ email: 'po@ascrum.test' })
    await productBacklog.forProject(PROJECT.webshop)
    await sprints.forProject(PROJECT.mobileApp)
    await tasks.forSprint(SPRINT.webshop1)

    expect(seen.map((r) => [r.pathname, r.q])).toEqual([
      [`${COLLECTIONS}/users`, {}],
      [`${COLLECTIONS}/users`, { email: 'po@ascrum.test' }],
      [`${COLLECTIONS}/productbacklog`, { projectId: PROJECT.webshop }],
      [`${COLLECTIONS}/sprints`, { projectId: PROJECT.mobileApp }],
      [`${COLLECTIONS}/tasks`, { sprintId: SPRINT.webshop1 }],
    ])
    expect(all).toHaveLength(6)
    expect(byEmail).toEqual([
      { id: USER.po, email: 'po@ascrum.test', firstName: 'Paula', lastName: 'Owner', admin: false },
    ])
  })

  it('AC-API-04 / D10: a 404 on getById rejects with ApiError{code:"resource.notfound"}; any other non-2xx rejects with ApiError{status}', async () => {
    const missing: unknown = await projects.getById('ffffffffffffffffffffffff').catch((e: unknown) => e)
    expect(missing).toBeInstanceOf(ApiError)
    expect(missing).toMatchObject({ status: 404, code: 'resource.notfound', collection: 'projects' })

    failNext('GET', `${COLLECTIONS}/projects/*`, 500)
    const failed: unknown = await projects.getById(PROJECT.webshop).catch((e: unknown) => e)
    expect(failed).toBeInstanceOf(ApiError)
    expect(failed).toMatchObject({ status: 500, code: undefined })

    failNext('GET', `${COLLECTIONS}/projects`, 503)
    await expect(projects.all()).rejects.toMatchObject({ status: 503 })
  })

  it('AC-API-05: getByIds sends {_id:{$in:[{$oid}…]}}, including for an empty list', async () => {
    const seen = recordRequests()
    const found = await productBacklog.getByIds([BACKLOG.catalogue, BACKLOG.cart])
    const none = await productBacklog.getByIds([])

    expect(seen.map((r) => r.q)).toEqual([
      { _id: { $in: [{ $oid: BACKLOG.catalogue }, { $oid: BACKLOG.cart }] } },
      { _id: { $in: [] } },
    ])
    expect(found.map((item) => item.id)).toEqual([BACKLOG.catalogue, BACKLOG.cart])
    expect(none).toEqual([])
  })

  it('AC-API-06: save POSTs a new document and PUTs an existing one to /<id> without _id; remove DELETEs /<id>; results are app types', async () => {
    await signIn('dev1')
    const seen = recordRequests()
    const draft = {
      projectId: PROJECT.webshop,
      sprintId: SPRINT.webshop2,
      productBacklogItemId: BACKLOG.search,
      name: 'Index products',
      desc: 'Build the search index',
      estimation: 3,
      remaining: 3,
      state: 'TODO' as const,
    }

    const created = await tasks.save(draft)
    expect(created.id).toMatch(/^[0-9a-f]{24}$/)
    expect(created).not.toHaveProperty('_id')

    const updated = await tasks.save({ ...created, remaining: 1 })
    expect(updated).toEqual({ ...created, remaining: 1 })

    await tasks.remove(updated)
    await expect(tasks.getById(updated.id ?? '')).rejects.toMatchObject({ code: 'resource.notfound' })

    expect(seen.map((r) => [r.method, r.pathname])).toEqual([
      ['POST', `${COLLECTIONS}/tasks`],
      ['PUT', `${COLLECTIONS}/tasks/${created.id}`],
      ['DELETE', `${COLLECTIONS}/tasks/${created.id}`],
      ['GET', `${COLLECTIONS}/tasks/${created.id}`],
    ])
    expect(seen[0]?.body).toEqual(draft)
    expect(seen[1]?.body).toEqual({ ...draft, remaining: 1 }) // neither id nor _id in the body
  })

  it('AC-API-06: fields the app types do not know survive a round trip (a PUT replaces the whole document)', async () => {
    await signIn('dev1')
    const created = await tasks.save({ projectId: PROJECT.webshop, name: 'x', colour: 'red' } as Parameters<
      typeof tasks.save
    >[0])
    const reloaded = await tasks.getById(created.id ?? '')
    const resaved = await tasks.save({ ...reloaded, name: 'y' })
    expect(resaved).toMatchObject({ name: 'y', colour: 'red' })
  })
})
