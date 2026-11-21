// The breadcrumb bar of legacy header.tpl.html: every crumb but the last is a link (AC-SHELL-04).
import { Link } from 'react-router'
import type { Breadcrumb } from './breadcrumbs.ts'

type BreadcrumbsProps = { breadcrumbs: Breadcrumb[] }

export function Breadcrumbs({ breadcrumbs }: BreadcrumbsProps) {
  return (
    <div>
      <ul className="breadcrumb">
        {breadcrumbs.map((breadcrumb, index) => (
          <li key={breadcrumb.path}>
            <span className="divider">/</span>
            {index === breadcrumbs.length - 1 ? (
              <span>{breadcrumb.name}</span>
            ) : (
              <span>
                <Link to={breadcrumb.path}>{breadcrumb.name}</Link>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
