// Port of admin/users/admin-users-list.js (UsersListCtrl) + users-list.tpl.html (AC-USR-01..03).
import { useState, type MouseEvent } from 'react'
import { useLoaderData } from 'react-router'
import { users as usersApi } from '../../api/collections.ts'
import type { User } from '../../api/types.ts'
import { requireAdminUser } from '../../auth/guards.ts'
import { Gravatar } from '../../components/Gravatar.tsx'
import { useListNav } from '../../crud/useListNav.ts'
import { pushForCurrentRoute } from '../../notifications/store.ts'

/** R16 resolve: `currentUser: requireAdminUser`, `users: Users.all()`. */
export async function usersListLoader(): Promise<User[]> {
  await requireAdminUser()
  return usersApi.all()
}

export function UsersList() {
  const loaded = useLoaderData<typeof usersListLoader>()
  // Legacy spliced the removed user out of its local array. Keeping the removed ids (rather than a
  // copy of the list) means a revalidated loader result is still shown, minus what was removed here.
  const [removedIds, setRemovedIds] = useState<readonly string[]>([])
  const users = loaded.filter((user) => user.id === undefined || !removedIds.includes(user.id))
  const { onNew, onEdit } = useListNav('/admin/users')

  function remove(user: User, event: MouseEvent) {
    // Don't let the click bubble up to the row, which would open this user for editing (AC-USR-03).
    event.stopPropagation()
    usersApi.remove(user).then(
      () => {
        // It is gone from the DB, so remove it from the local list too.
        setRemovedIds((ids) => (user.id === undefined ? ids : [...ids, user.id]))
        pushForCurrentRoute('crud.user.remove.success', 'success', { id: user.id })
      },
      () => {
        pushForCurrentRoute('crud.user.remove.error', 'error', { id: user.id })
      },
    )
  }

  return (
    <>
      <table className="table table-bordered table-condensed table-striped table-hover">
        <thead>
          <tr>
            <th></th>
            <th>E-mail</th>
            <th>Last name</th>
            <th>First name</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} onClick={() => user.id !== undefined && onEdit(user.id)}>
              <td>
                <Gravatar email={user.email} size={50} defaultImage="monsterid" />
              </td>
              <td>{user.email}</td>
              <td>{user.lastName}</td>
              <td>{user.firstName}</td>
              <td>
                <button className="btn btn-danger remove" onClick={(event) => remove(user, event)}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="well">
        <button className="btn" onClick={onNew}>
          New User
        </button>
      </div>
    </>
  )
}
