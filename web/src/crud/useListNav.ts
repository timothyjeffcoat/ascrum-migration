// Port of services/crud.js `crudListMethods(pathPrefix)` (AC-CRUD-08): `new` → prefix/new,
// `edit(id)` → prefix/id. Renamed onNew/onEdit because `new` is awkward as a property in JSX.
import { useNavigate } from 'react-router'

export type ListNav = { onNew(): void; onEdit(id: string): void }

export function useListNav(prefix: string): ListNav {
  const navigate = useNavigate()
  return {
    onNew: () => void navigate(`${prefix}/new`),
    onEdit: (id) => void navigate(`${prefix}/${id}`),
  }
}
