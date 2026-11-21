// Port of services/breadcrumbs.js: one crumb per raw path segment (D3: ids stay as they are).
// Legacy rebuilt the list on `$routeChangeSuccess`; callers pass the router's committed location,
// which also changes only once a navigation has completed (AC-SHELL-04).

export type Breadcrumb = { name: string; path: string }

export function breadcrumbsFor(pathname: string): Breadcrumb[] {
  const segments = pathname.split('/')
  segments.shift() // the empty string before the leading '/'
  return segments.map((name, index) => ({ name, path: '/' + segments.slice(0, index + 1).join('/') }))
}
