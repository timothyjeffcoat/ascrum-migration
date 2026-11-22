// Port of services/crudRouteProvider.js (spec §4.3): the list, new and edit routes of one resource,
// with the legacy paths `basePath`, `basePath/new` and `basePath/:itemId`.
import type { ComponentType } from 'react'
import type { LoaderFunction, RouteObject } from 'react-router'

export type CrudRoutePart = { loader: LoaderFunction; Component: ComponentType }
export type CrudRouteParts = { list?: CrudRoutePart; create?: CrudRoutePart; edit?: CrudRoutePart }

export function crudRoutes(basePath: string, parts: CrudRouteParts): RouteObject[] {
  const routes: RouteObject[] = []
  if (parts.list) routes.push({ path: basePath, ...parts.list })
  if (parts.create) routes.push({ path: `${basePath}/new`, ...parts.create })
  if (parts.edit) routes.push({ path: `${basePath}/:itemId`, ...parts.edit })
  return routes
}
