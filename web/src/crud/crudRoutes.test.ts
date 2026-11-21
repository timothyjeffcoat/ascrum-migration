import { matchRoutes } from 'react-router'
import { describe, expect, it } from 'vitest'
import { crudRoutes } from './crudRoutes.ts'

const part = (name: string) => ({ loader: () => name, Component: () => null })

describe('crudRoutes', () => {
  it('§4.3: produces basePath, basePath/new and basePath/:itemId with the given loaders and components', () => {
    const list = part('list')
    const create = part('create')
    const edit = part('edit')
    const routes = crudRoutes('/projects/:projectId/sprints', { list, create, edit })
    expect(routes).toEqual([
      { path: '/projects/:projectId/sprints', ...list },
      { path: '/projects/:projectId/sprints/new', ...create },
      { path: '/projects/:projectId/sprints/:itemId', ...edit },
    ])
    // 'new' outranks ':itemId', as legacy's route order made it.
    expect(matchRoutes(routes, '/projects/p1/sprints/new')?.[0]?.route.loader).toBe(create.loader)
    expect(matchRoutes(routes, '/projects/p1/sprints/s1')?.[0]?.params).toEqual({ projectId: 'p1', itemId: 's1' })
  })

  it('§4.3: parts that are not given produce no route', () => {
    expect(crudRoutes('/admin/users', { list: part('list') })).toHaveLength(1)
  })
})
