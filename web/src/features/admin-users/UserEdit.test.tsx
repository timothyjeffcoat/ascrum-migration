// AC-USR-04..07, D8, D9, and the legacy admin-users-edit.spec / uniqueEmail.spec form-level cases,
// through the real app (renderRoute + MSW stub).
import { fireEvent, getDefaultNormalizer, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { failNext } from '../../test/stubControl.ts'
import { recordRequests, renderRoute, type RecordedRequest } from '../../test/renderRoute.tsx'
import { USER } from '../../../stub/seed.ts'

const REQUIRED = 'This field is required.'
const INVALID_EMAIL = 'Please enter a valid email address.'
const TAKEN = 'This email address is not available - please enter another.'
const MISMATCH = 'Passwords do not match.'

function field(label: string): HTMLInputElement {
  const input = screen.getByLabelText(label)
  if (!(input instanceof HTMLInputElement)) throw new Error(`${label} is not an input`)
  return input
}

/** The inline errors that follow an input, up to the next label (legacy `help-inline` spans). */
function errorsAfter(label: string): string[] {
  const messages: string[] = []
  let node = field(label).nextElementSibling
  while (node && node.tagName === 'SPAN') {
    expect(node).toHaveClass('help-inline')
    messages.push(node.textContent)
    node = node.nextElementSibling
  }
  return messages
}

function saveButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Save' })
}

function userQueries(requests: RecordedRequest[]): unknown[] {
  return requests.filter((r) => r.method === 'GET' && r.pathname.endsWith('/collections/users')).map((r) => r.q)
}

async function openNew() {
  const rendered = await renderRoute('/admin/users/new', { as: 'admin' })
  await screen.findByLabelText('E-mail')
  await waitFor(() => expect(rendered.router.state.initialized).toBe(true))
  return rendered
}

async function openEdit(id: string) {
  const rendered = await renderRoute(`/admin/users/${id}`, { as: 'admin' })
  await waitFor(() => expect(field('E-mail').value).not.toBe(''))
  await waitFor(() => expect(rendered.router.state.initialized).toBe(true))
  return rendered
}

describe('UserEdit: route guards (AC-USR-01, §5.3 R17/R18)', () => {
  const NOT_AUTHENTICATED = 'You must be logged in to access this part of the application.'
  const NOT_AUTHORIZED = 'You do not have the necessary access permissions.  Do you want to login as someone else?'
  // The legacy message has two spaces; keep them when matching.
  const EXACT = { normalizer: getDefaultNormalizer({ collapseWhitespace: false }) }
  const cases = [
    { persona: 'anonymous', message: NOT_AUTHENTICATED },
    { persona: 'dev1', message: NOT_AUTHORIZED },
  ] as const
  const paths = [
    { route: 'R17', path: '/admin/users/new' },
    { route: 'R18', path: `/admin/users/${USER.po}` },
  ] as const

  for (const { route, path } of paths) {
    for (const { persona, message } of cases) {
      it(`AC-USR-01 / §5.3 ${route}: a deep link to ${path} as ${persona} gets the login modal and fetches no user`, async () => {
        const requests = recordRequests()
        const { router } = await renderRoute(path, { as: persona })
        expect(await screen.findByText(message, EXACT)).toHaveClass('alert alert-warning')
        expect(router.state.initialized).toBe(false)
        expect(screen.queryByLabelText('Last name')).not.toBeInTheDocument() // the login modal has its own E-mail
        expect(requests.filter((r) => r.pathname.includes('/collections/users'))).toEqual([])
      })
    }
  }
})

describe('UserEdit: the form', () => {
  it('AC-USR-04: legacy markup: a well around the form, legend "User", span6 inputs, a 200px gravatar', async () => {
    await openEdit(USER.po)
    const form = field('E-mail').form
    if (!form) throw new Error('the e-mail input is not in a form')
    expect(form).toHaveAttribute('name', 'form')
    expect(form.parentElement).toHaveClass('well', { exact: true })
    expect(within(form).getByText('User').tagName).toBe('LEGEND')
    for (const label of ['E-mail', 'Last name', 'First name', 'Password', 'Password (repeat)']) {
      expect(field(label)).toHaveClass('span6', { exact: true })
    }
    expect(field('E-mail')).toHaveAttribute('type', 'email')
    expect(field('Password')).toHaveAttribute('type', 'password')
    expect(field('Password (repeat)')).toHaveAttribute('type', 'password')
    const gravatar = within(form).getByRole('img')
    expect(gravatar).toHaveClass('img-polaroid pull-right', { exact: true })
    expect(gravatar.getAttribute('src')).toMatch(/^https:\/\/www\.gravatar\.com\/avatar\/[0-9a-f]{32}\?s=200$/)
    expect(within(form).getByText('Admin').tagName).toBe('LABEL')
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    // CrudButtons, all type="button" (AC-CRUD-07), Remove shown because the user has an id.
    for (const name of ['Save', 'Revert changes', 'Remove']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('type', 'button')
    }
  })

  it('AC-USR-04: on create, every field shows "This field is required." straight away (no touched state) and Save is disabled', async () => {
    await openNew()
    expect(errorsAfter('E-mail')).toEqual([REQUIRED])
    expect(errorsAfter('Last name')).toEqual([REQUIRED])
    expect(errorsAfter('First name')).toEqual([REQUIRED])
    expect(errorsAfter('Password')).toEqual([REQUIRED])
    expect(errorsAfter('Password (repeat)')).toEqual([REQUIRED])
    expect(saveButton()).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
  })

  it('AC-USR-04: an invalid e-mail shows the legacy message; a taken one shows "not available"', async () => {
    const { user } = await openNew()
    await user.type(field('E-mail'), 'not-an-email')
    expect(errorsAfter('E-mail')).toEqual([INVALID_EMAIL])

    await user.clear(field('E-mail'))
    await user.type(field('E-mail'), 'po@ascrum.test')
    await waitFor(() => expect(errorsAfter('E-mail')).toEqual([TAKEN]))
  })

  it('AC-USR-04: the passwords must match; "Passwords do not match." shows under both fields, as in legacy', async () => {
    const { user } = await openNew()
    await user.type(field('Password'), 'secret')
    await user.type(field('Password (repeat)'), 'secreT')
    expect(errorsAfter('Password')).toEqual([MISMATCH])
    expect(errorsAfter('Password (repeat)')).toEqual([MISMATCH])

    // Changing the other field re-validates the repeat (validateEquals' watch).
    await user.clear(field('Password'))
    await user.type(field('Password'), 'secreT')
    expect(errorsAfter('Password')).toEqual([])
    expect(errorsAfter('Password (repeat)')).toEqual([])
  })

  it('AC-USR-04: on edit, the passwords are optional while both are blank, and both required once either is filled', async () => {
    const { user } = await openEdit(USER.po)
    expect(errorsAfter('Password')).toEqual([])
    expect(errorsAfter('Password (repeat)')).toEqual([])

    await user.type(field('Password'), 'x')
    expect(errorsAfter('Password (repeat)')).toEqual([REQUIRED, MISMATCH])

    await user.clear(field('Password'))
    expect(errorsAfter('Password')).toEqual([])
    expect(errorsAfter('Password (repeat)')).toEqual([])
  })

  it('AC-USR-04: last name and first name are required; the Admin checkbox edits `admin`', async () => {
    const { user } = await openEdit(USER.po)
    await user.clear(field('Last name'))
    await user.clear(field('First name'))
    expect(errorsAfter('Last name')).toEqual([REQUIRED])
    expect(errorsAfter('First name')).toEqual([REQUIRED])
    expect(saveButton()).toBeDisabled()

    await user.type(field('Last name'), 'Owner')
    await user.type(field('First name'), 'Paula')
    expect(saveButton()).toBeDisabled() // back to the loaded values: not dirty
    await user.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(saveButton()).toBeEnabled()
  })
})

describe('UserEdit: uniqueEmail in the form (AC-USR-05, D9, legacy uniqueEmail.spec)', () => {
  it('uniqueEmail.spec:29: the e-mail is valid initially (no uniqueEmail error)', async () => {
    await openNew()
    expect(errorsAfter('E-mail')).not.toContain(TAKEN)
  })

  it('uniqueEmail.spec:32: loading a user (a model change, not a view change) does not query', async () => {
    const requests = recordRequests()
    await openEdit(USER.po)
    expect(userQueries(requests)).toEqual([])
  })

  it('AC-USR-05: typing (a view change) queries users by e-mail; Save waits for the check (pending)', async () => {
    const requests = recordRequests()
    const { user } = await openEdit(USER.po)
    fireEvent.change(field('E-mail'), { target: { value: 'paula@ascrum.test' } })
    expect(saveButton()).toBeDisabled() // pending
    await waitFor(() => expect(saveButton()).toBeEnabled())
    expect(userQueries(requests)).toEqual([{ email: 'paula@ascrum.test' }])
    await user.clear(field('E-mail'))
    expect(errorsAfter('E-mail')).toEqual([REQUIRED])
    expect(userQueries(requests)).toHaveLength(1) // an empty value is not checked
  })

  it('D9: editing a user, their own e-mail is not reported as taken, so the user can be saved', async () => {
    const { user, router } = await openEdit(USER.po)
    await user.clear(field('E-mail'))
    await user.type(field('E-mail'), 'po@ascrum.test') // back to their own address, checked on each keystroke
    await user.type(field('Last name'), 'x')
    await waitFor(() => expect(saveButton()).toBeEnabled())
    expect(errorsAfter('E-mail')).toEqual([])

    await user.clear(field('E-mail'))
    await user.type(field('E-mail'), 'sm@ascrum.test') // somebody else's
    await waitFor(() => expect(errorsAfter('E-mail')).toEqual([TAKEN]))
    expect(saveButton()).toBeDisabled()
    expect(router.state.location.pathname).toBe(`/admin/users/${USER.po}`)
  })

  it('D9: a stale uniqueness response (for a value since changed) is discarded', async () => {
    await openEdit(USER.po)
    // Both changes happen before either response can arrive: the "taken" answer for the first
    // value must not mark the second value as taken.
    fireEvent.change(field('E-mail'), { target: { value: 'sm@ascrum.test' } })
    fireEvent.change(field('E-mail'), { target: { value: 'fresh@ascrum.test' } })
    await waitFor(() => expect(saveButton()).toBeEnabled())
    expect(errorsAfter('E-mail')).toEqual([])
  })
})

describe('UserEdit: passwords (AC-USR-06, D8)', () => {
  it('admin-users-edit.spec:26 → D8: the password fields always start empty on edit', async () => {
    const requests = recordRequests()
    await openEdit(USER.admin)
    expect(field('E-mail')).toHaveValue('admin@abc.com')
    expect(field('Password')).toHaveValue('')
    expect(field('Password (repeat)')).toHaveValue('')
    // …and nothing the client received carried a password to pre-fill them with (D7/A3).
    const loaded = requests.find((r) => r.pathname.endsWith(`/collections/users/${USER.admin}`))
    expect(loaded?.method).toBe('GET')
  })

  it('D8: the password fields start empty on create', async () => {
    await openNew()
    expect(field('Password')).toHaveValue('')
    expect(field('Password (repeat)')).toHaveValue('')
  })

  it('AC-USR-06: on edit with blank passwords, `password` is left out of the PUT payload', async () => {
    const requests = recordRequests()
    const { user } = await openEdit(USER.dev1)
    await user.clear(field('First name'))
    await user.type(field('First name'), 'Dina')
    await user.click(saveButton())
    await screen.findByText(`A user with id '${USER.dev1}' was saved successfully.`)

    const put = requests.find((r) => r.method === 'PUT')
    expect(put?.pathname).toBe(`/databases/ascrum/collections/users/${USER.dev1}`)
    expect(put?.body).toEqual({ email: 'dev1@ascrum.test', firstName: 'Dina', lastName: 'Developer', admin: false })
  })

  it('AC-USR-04 / Q-admin-users-1: a password-only change on edit can be saved', async () => {
    const requests = recordRequests()
    const { user } = await openEdit(USER.dev1)
    expect(saveButton()).toBeDisabled() // blank passwords are not dirty against the loaded user
    await user.type(field('Password'), 'only-pw')
    await user.type(field('Password (repeat)'), 'only-pw')
    expect(saveButton()).toBeEnabled()
    await user.click(saveButton())
    await screen.findByText(`A user with id '${USER.dev1}' was saved successfully.`)

    const put = requests.find((r) => r.method === 'PUT')
    expect(put?.pathname).toBe(`/databases/ascrum/collections/users/${USER.dev1}`)
    // The loaded fields unchanged, plus the new password; never the repeat.
    expect(put?.body).toEqual({
      email: 'dev1@ascrum.test',
      firstName: 'Dana',
      lastName: 'Developer',
      admin: false,
      password: 'only-pw',
    })
  })

  it('AC-USR-06: on edit with a new password (and another change), the password is sent; the repeat never is', async () => {
    const requests = recordRequests()
    const { user } = await openEdit(USER.dev1)
    await user.type(field('Password'), 'n3w')
    await user.type(field('Password (repeat)'), 'n3w')
    await user.type(field('Last name'), 's')
    await user.click(saveButton())
    await screen.findByText(`A user with id '${USER.dev1}' was saved successfully.`)

    const put = requests.find((r) => r.method === 'PUT')
    expect(put?.body).toEqual({
      email: 'dev1@ascrum.test',
      firstName: 'Dana',
      lastName: 'Developers',
      admin: false,
      password: 'n3w',
    })
  })
})

describe('UserEdit: outcomes (AC-USR-07, legacy admin-users-edit.spec)', () => {
  it('admin-users-edit.spec:33 / AC-USR-07: creating a user notifies crud.user.save.success on the next route and goes to /admin/users', async () => {
    const requests = recordRequests()
    const { user, router } = await openNew()
    await user.type(field('E-mail'), 'newbie@ascrum.test')
    await user.type(field('Last name'), 'Bie')
    await user.type(field('First name'), 'New')
    await user.type(field('Password'), 'pw')
    await user.type(field('Password (repeat)'), 'pw')
    await waitFor(() => expect(saveButton()).toBeEnabled())
    await user.click(saveButton())

    const notice = await screen.findByText(/^A user with id '[0-9a-f]{24}' was saved successfully\.$/)
    expect(notice).toHaveClass('alert alert-success')
    expect(router.state.location.pathname).toBe('/admin/users')
    expect(within(screen.getByRole('table')).getByText('newbie@ascrum.test')).toBeInTheDocument()

    const post = requests.find((r) => r.method === 'POST' && r.pathname.endsWith('/collections/users'))
    expect(post?.body).toEqual({
      email: 'newbie@ascrum.test',
      lastName: 'Bie',
      firstName: 'New',
      admin: false,
      password: 'pw',
    })
  })

  it('admin-users-edit.spec:43 / AC-USR-07: a failed save shows crud.user.save.error on the current route and stays', async () => {
    const { user, router } = await openEdit(USER.dev2)
    await user.type(field('Last name'), 'x')
    failNext('PUT', '/databases/ascrum/collections/users/*', 500)
    await user.click(saveButton())

    const notice = await screen.findByText('Something went wrong when saving a user...')
    expect(notice).toHaveClass('alert alert-error')
    expect(router.state.location.pathname).toBe(`/admin/users/${USER.dev2}`)
    expect(field('Last name')).toHaveValue('Coderx')
  })

  it('AC-USR-07: Remove from the edit page notifies crud.user.remove.success on the next route and goes to the list', async () => {
    const { user, router } = await openEdit(USER.outsider)
    await user.click(screen.getByRole('button', { name: 'Remove' }))

    const notice = await screen.findByText(`A user with id '${USER.outsider}' was removed successfully.`)
    expect(notice).toHaveClass('alert alert-success')
    expect(router.state.location.pathname).toBe('/admin/users')
    expect(within(screen.getByRole('table')).queryByText('outsider@ascrum.test')).not.toBeInTheDocument()
  })

  it('AC-USR-07 / S12: a failed Remove shows crud.user.remove.error {id} on the current route and stays', async () => {
    const { user, router } = await openEdit(USER.outsider)
    failNext('DELETE', '/databases/ascrum/collections/users/*', 500)
    await user.click(screen.getByRole('button', { name: 'Remove' }))

    const notice = await screen.findByText(`Something went wrong when removing user with id '${USER.outsider}'.`)
    expect(notice).toHaveClass('alert alert-error')
    expect(router.state.location.pathname).toBe(`/admin/users/${USER.outsider}`)
  })

  it('AC-USR-07: Revert changes restores the loaded values and empties the passwords', async () => {
    const { user } = await openEdit(USER.sm)
    await user.type(field('Last name'), 'y')
    await user.type(field('Password'), 'abc')
    await user.click(screen.getByRole('button', { name: 'Revert changes' }))
    expect(field('Last name')).toHaveValue('Master')
    expect(field('Password')).toHaveValue('')
    expect(saveButton()).toBeDisabled()
  })
})
