// Port of common/directives/gravatar.js (AC-GRAV-01). Shared component (spec §8.1: cluster 1 owns
// components/**). D17 fixed: https instead of http (the https demo would block http images), and the
// md5 helper is module-scoped (components/md5.ts).
import { md5 } from './md5.ts'

type GravatarProps = {
  email: string | undefined
  /** `s`: added only when it is a number (legacy `angular.isNumber`). */
  size?: number
  /** `d`, e.g. 'monsterid': added only when set. */
  defaultImage?: string
  /** `f=y`: added only when true. */
  forceDefault?: boolean
  /** Legacy `replace: true` put the element's classes on the `<img>` (e.g. `img-polaroid pull-right`). */
  className?: string
}

/**
 * The image URL. Parameters keep the legacy order (s, f, d: the order of the directive's watchers).
 * An empty e-mail has no hash, so the URL ends in `/avatar/`, as legacy rendered an undefined `{{hash}}`.
 */
export function gravatarUrl(email: string | undefined, options: Omit<GravatarProps, 'email' | 'className'> = {}) {
  const hash = email ? md5(email.trim().toLowerCase()) : ''
  const params: [string, string | number | undefined][] = [
    ['s', typeof options.size === 'number' ? options.size : undefined],
    ['f', options.forceDefault ? 'y' : undefined],
    ['d', options.defaultImage ? options.defaultImage : undefined],
  ]
  const query = params
    .filter((param): param is [string, string | number] => Boolean(param[1]))
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&')
  return `https://www.gravatar.com/avatar/${hash}${query ? `?${query}` : ''}`
}

export function Gravatar({ email, size, defaultImage, forceDefault, className }: GravatarProps) {
  // No alt attribute, as in the legacy template (B4: markup kept verbatim).
  return <img src={gravatarUrl(email, { size, defaultImage, forceDefault })} className={className} />
}
