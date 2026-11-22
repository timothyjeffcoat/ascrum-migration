import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, onTestFinished } from 'vitest'
import { PROJECT, USER } from '../../../stub/seed.ts'
import { users as usersApi } from '../../api/collections.ts'
import { productOwnerCandidates, scrumMasterCandidates, teamMemberCandidates } from '../../domain/projects.ts'
import { fullName } from '../../domain/users.ts'
import { failNext } from '../../test/stubControl.ts'
import { recordRequests, renderRoute } from '../../test/renderRoute.tsx'

const PROJECTS = '/databases/ascrum/collections/projects'
const PROJECTS_OR_USERS = /^\/databases\/ascrum\/collections\/(projects|users)(\/|$)/

const NOT_AUTHENTICATED = 'You must be logged in to access this part of the application.'
// The legacy string has a double space, which getByText's default normalizer collapses.
const NOT_AUTHORIZED = /^You do not have the necessary access permissions\. +Do you want to login as someone else\?$/

// fullName() of the seeded users: "Last First (email)".
const ADMIN = 'User Admin (admin@abc.com)'
const PO = 'Owner Paula (po@ascrum.test)'
const SM = 'Master Sam (sm@ascrum.test)'
const DEV1 = 'Developer Dana (dev1@ascrum.test)'
const DEV2 = 'Coder Devon (dev2@ascrum.test)'
const OUTSIDER = 'Outsider Otto (outsider@ascrum.test)'
const CHOOSE = '-- choose --'

async function openEdit(path: string) {
  const rendered = await renderRoute(path, { as: 'admin' })
  await screen.findByLabelText('Name')
  return rendered
}

function optionLabels(select: HTMLElement): string[] {
  return Array.from((select as HTMLSelectElement).options, (option) => option.textContent)
}

function selectedLabel(select: HTMLElement): string {
  const element = select as HTMLSelectElement
  return element.options[element.selectedIndex]?.textContent ?? ''
}

function devTeamTable(): HTMLElement {
  return screen.getByRole('columnheader', { name: 'User' }).closest('table') as HTMLElement
}

function teamSelect(): HTMLElement {
  return within(devTeamTable()).getByRole('combobox')
}

function teamRows(): string[] {
  // Every row but the header and the trailing "add" row.
  const rows = within(devTeamTable()).getAllByRole('row').slice(1, -1)
  return rows.map((row) => row.querySelector('td')?.textContent ?? '')
}

function removeMemberButton(name: string): HTMLElement {
  const cell = within(devTeamTable()).getByText(name)
  return within(cell.closest('tr') as HTMLElement).getByRole('button', { name: 'Remove' })
}

function crudButton(name: 'Save' | 'Revert changes' | 'Remove'): HTMLElement {
  // The team table has its own "Remove" buttons; the CrudButtons ones carry save/revert/remove classes.
  const cls = { Save: 'save', 'Revert changes': 'revert', Remove: 'remove' }[name]
  const button = screen.getAllByRole('button', { name }).find((b) => b.classList.contains(cls))
  if (!button) throw new Error(`No CrudButtons "${name}" button`)
  return button
}

function alert(type: 'success' | 'error', text: string | RegExp): HTMLElement {
  const element = screen.getByText(text)
  expect(element).toHaveClass(`alert alert-${type}`)
  return element
}

describe('ProjectEdit (/admin/projects/new, /admin/projects/:itemId)', () => {
  it('AC-APR-03 / legacy :37 / legacy :115: edit shows the loaded project; PO and SM options are the domain candidates labelled with fullName', async () => {
    await openEdit(`/admin/projects/${PROJECT.webshop}`)

    // Class parity: the legacy form layout.
    const form = screen.getByLabelText('Name').closest('form') as HTMLElement
    expect(form.parentElement).toHaveClass('well')
    expect(form.querySelector(':scope > legend')).toHaveTextContent('Project')
    expect(form.querySelectorAll(':scope > .row-fluid > .span6')).toHaveLength(2)
    expect(devTeamTable()).toHaveClass('table table-bordered table-condensed table-striped table-hover')

    expect(screen.getByLabelText('Name')).toHaveValue('Webshop')
    expect(screen.getByLabelText('Description')).toHaveValue('Online store rewrite')

    const productOwner = screen.getByLabelText('Product Owner')
    const scrumMaster = screen.getByLabelText('Scrum Master')
    expect(productOwner).toHaveClass('span12')
    expect(selectedLabel(productOwner)).toBe(PO)
    expect(selectedLabel(scrumMaster)).toBe(SM)
    // Webshop: PO po, SM sm, devs dev1 + dev2. PO: not SM and not a dev. SM: not PO.
    expect(optionLabels(productOwner)).toEqual([CHOOSE, ADMIN, PO, OUTSIDER])
    expect(optionLabels(scrumMaster)).toEqual([CHOOSE, ADMIN, SM, DEV1, DEV2, OUTSIDER])

    // The same lists the domain functions give (AC-DOM-05), so the screen adds no filtering of its own.
    const users = await usersApi.all()
    const webshop = { productOwner: USER.po, scrumMaster: USER.sm, teamMembers: [USER.dev1, USER.dev2] }
    expect(optionLabels(productOwner).slice(1)).toEqual(productOwnerCandidates(users, webshop).map(fullName))
    expect(optionLabels(scrumMaster).slice(1)).toEqual(scrumMasterCandidates(users, webshop).map(fullName))
    expect(optionLabels(teamSelect()).slice(1)).toEqual(teamMemberCandidates(users, webshop).map(fullName))
  })

  it('AC-APR-02: name is required, description optional; PO and SM are required, so a new project needs all three before Save', async () => {
    const { user } = await openEdit('/admin/projects/new')

    // §5.6 draft: empty fields, empty team, nothing to save or revert yet, no Remove for a new document.
    expect(screen.getByLabelText('Name')).toHaveValue('')
    expect(screen.getByLabelText('Description')).toHaveValue('')
    expect(selectedLabel(screen.getByLabelText('Product Owner'))).toBe(CHOOSE)
    expect(teamRows()).toEqual([])
    expect(crudButton('Save')).toBeDisabled()
    expect(crudButton('Revert changes')).toBeDisabled()
    expect(screen.queryAllByRole('button', { name: 'Remove' })).toHaveLength(0)

    await user.type(screen.getByLabelText('Name'), 'Intranet')
    expect(crudButton('Save')).toBeDisabled() // PO and SM still unset
    expect(crudButton('Revert changes')).toBeEnabled()
    await user.selectOptions(screen.getByLabelText('Product Owner'), PO)
    expect(crudButton('Save')).toBeDisabled()
    await user.selectOptions(screen.getByLabelText('Scrum Master'), SM)
    expect(crudButton('Save')).toBeEnabled() // the description is optional

    await user.clear(screen.getByLabelText('Name'))
    expect(crudButton('Save')).toBeDisabled()
    await user.type(screen.getByLabelText('Name'), 'Intranet')
    await user.selectOptions(screen.getByLabelText('Scrum Master'), CHOOSE) // back to blank: required again
    expect(crudButton('Save')).toBeDisabled()
  })

  it('AC-APR-04: dev-team rows show full name + Remove; Add is disabled until a choice is made, and adding clears the choice', async () => {
    const { user } = await openEdit(`/admin/projects/${PROJECT.webshop}`)

    expect(teamRows()).toEqual([DEV1, DEV2])
    // Candidates: not the PO and not already a member.
    expect(optionLabels(teamSelect())).toEqual([CHOOSE, ADMIN, SM, OUTSIDER])
    const add = within(devTeamTable()).getByRole('button', { name: 'Add' })
    expect(add).toBeDisabled()
    expect(add).toHaveAttribute('type', 'button')

    await user.selectOptions(teamSelect(), OUTSIDER)
    expect(add).toBeEnabled()
    await user.click(add)

    expect(teamRows()).toEqual([DEV1, DEV2, OUTSIDER])
    expect(teamSelect()).toHaveValue('') // selection cleared
    expect(add).toBeDisabled()
    expect(optionLabels(teamSelect())).toEqual([CHOOSE, ADMIN, SM])
    expect(crudButton('Save')).toBeEnabled() // the team change makes the form dirty

    await user.click(removeMemberButton(DEV1))
    expect(teamRows()).toEqual([DEV2, OUTSIDER])
    expect(optionLabels(teamSelect())).toEqual([CHOOSE, ADMIN, SM, DEV1])
    expect(removeMemberButton(DEV2)).toHaveClass('btn btn-small')
    expect(removeMemberButton(DEV2)).toHaveAttribute('type', 'button')
  })

  it('AC-APR-04: the team selection is a form-only field: never dirty, never saved', async () => {
    const requests = recordRequests()
    const { user, router } = await openEdit(`/admin/projects/${PROJECT.webshop}`)

    await user.selectOptions(teamSelect(), ADMIN)
    expect(crudButton('Save')).toBeDisabled() // choosing alone changes nothing
    expect(crudButton('Revert changes')).toBeDisabled()

    await user.clear(screen.getByLabelText('Description'))
    await user.click(crudButton('Save'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/projects'))
    const put = requests.find((r) => r.method === 'PUT')
    expect(put?.body).toEqual({
      name: 'Webshop',
      desc: '',
      productOwner: USER.po,
      scrumMaster: USER.sm,
      teamMembers: [USER.dev1, USER.dev2],
    })
  })

  it('AC-APR-05: the candidate lists recompute as PO, SM and team change', async () => {
    const { user } = await openEdit('/admin/projects/new')
    const productOwner = screen.getByLabelText('Product Owner')
    const scrumMaster = screen.getByLabelText('Scrum Master')
    const everyone = [CHOOSE, ADMIN, PO, SM, DEV1, DEV2, OUTSIDER]
    expect(optionLabels(productOwner)).toEqual(everyone)
    expect(optionLabels(scrumMaster)).toEqual(everyone)
    expect(optionLabels(teamSelect())).toEqual(everyone)

    // A PO can be neither SM nor developer.
    await user.selectOptions(productOwner, PO)
    expect(optionLabels(scrumMaster)).toEqual([CHOOSE, ADMIN, SM, DEV1, DEV2, OUTSIDER])
    expect(optionLabels(teamSelect())).toEqual([CHOOSE, ADMIN, SM, DEV1, DEV2, OUTSIDER])

    // An SM cannot be PO (but can still be a developer).
    await user.selectOptions(scrumMaster, SM)
    expect(optionLabels(productOwner)).toEqual([CHOOSE, ADMIN, PO, DEV1, DEV2, OUTSIDER])
    expect(optionLabels(teamSelect())).toEqual([CHOOSE, ADMIN, SM, DEV1, DEV2, OUTSIDER])

    // A developer cannot be PO, and is no longer a team candidate.
    await user.selectOptions(teamSelect(), DEV1)
    await user.click(within(devTeamTable()).getByRole('button', { name: 'Add' }))
    expect(optionLabels(productOwner)).toEqual([CHOOSE, ADMIN, PO, DEV2, OUTSIDER])
    expect(optionLabels(teamSelect())).toEqual([CHOOSE, ADMIN, SM, DEV2, OUTSIDER])

    // Removing them makes them a candidate again.
    await user.click(removeMemberButton(DEV1))
    expect(optionLabels(productOwner)).toEqual([CHOOSE, ADMIN, PO, DEV1, DEV2, OUTSIDER])
  })

  it('AC-APR-06: saving a new project POSTs the form values (not the team selection), notifies next route and returns to the list', async () => {
    const requests = recordRequests()
    const { user, router } = await openEdit('/admin/projects/new')

    await user.type(screen.getByLabelText('Name'), 'Intranet')
    await user.type(screen.getByLabelText('Description'), 'New intranet')
    await user.selectOptions(screen.getByLabelText('Product Owner'), PO)
    await user.selectOptions(screen.getByLabelText('Scrum Master'), SM)
    await user.selectOptions(teamSelect(), DEV1)
    await user.click(within(devTeamTable()).getByRole('button', { name: 'Add' }))
    await user.click(crudButton('Save'))

    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/projects'))
    const post = requests.find((r) => r.method === 'POST' && r.pathname === PROJECTS)
    expect(post?.body).toEqual({
      name: 'Intranet',
      desc: 'New intranet',
      productOwner: USER.po,
      scrumMaster: USER.sm,
      teamMembers: [USER.dev1],
    })
    alert('success', /^A project with id '[0-9a-f]{24}' was saved successfully\.$/)
    expect(await screen.findByText('Intranet')).toBeInTheDocument()
  })

  it('AC-APR-06 / legacy :45: saving an existing project PUTs it, notifies next route with its id and returns to the list', async () => {
    const { user, router } = await openEdit(`/admin/projects/${PROJECT.mobileApp}`)

    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), 'Mobile App 2')
    await user.click(crudButton('Save'))

    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/projects'))
    alert('success', `A project with id '${PROJECT.mobileApp}' was saved successfully.`)
    expect(await screen.findByText('Mobile App 2')).toBeInTheDocument()
  })

  it('AC-APR-06 / legacy :57: a failed save notifies the current route with crud.project.save.error and stays on the form', async () => {
    const { user, router } = await openEdit(`/admin/projects/${PROJECT.mobileApp}`)
    failNext('PUT', `${PROJECTS}/*`, 500)

    await user.type(screen.getByLabelText('Name'), ' 2')
    await user.click(crudButton('Save'))

    await waitFor(() => alert('error', 'Something went wrong when saving a project...'))
    expect(router.state.location.pathname).toBe(`/admin/projects/${PROJECT.mobileApp}`)
    expect(screen.getByLabelText('Name')).toHaveValue('Mobile App 2')
  })

  it('AC-APR-06 / D21: removing a project DELETEs it, says "removed" (not "saved") on the list, and the row is gone', async () => {
    const requests = recordRequests()
    const { user, router } = await openEdit(`/admin/projects/${PROJECT.mobileApp}`)

    const remove = crudButton('Remove')
    expect(remove).toHaveClass('btn btn-danger remove')
    await user.click(remove)

    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/projects'))
    expect(requests.some((r) => r.method === 'DELETE' && r.pathname === `${PROJECTS}/${PROJECT.mobileApp}`)).toBe(true)
    alert('success', `A project with id '${PROJECT.mobileApp}' was removed successfully.`)
    expect(screen.queryByText(/was saved successfully/)).not.toBeInTheDocument()
    expect(await screen.findByText('Webshop')).toBeInTheDocument()
    expect(screen.queryByText('Mobile App')).not.toBeInTheDocument()
  })

  it('AC-APR-06: a failed remove notifies the current route with crud.project.remove.error and its id', async () => {
    const { user, router } = await openEdit(`/admin/projects/${PROJECT.mobileApp}`)
    failNext('DELETE', `${PROJECTS}/*`, 500)

    await user.click(crudButton('Remove'))

    await waitFor(() => alert('error', `Something went wrong when removing project with id '${PROJECT.mobileApp}'.`))
    expect(router.state.location.pathname).toBe(`/admin/projects/${PROJECT.mobileApp}`)
  })

  it('D13 / legacy :104: a project without teamMembers edits as an empty team, is not dirty for it, and saves the array once changed', async () => {
    const requests = recordRequests()
    const { user, router } = await openEdit(`/admin/projects/${PROJECT.legacyCleanup}`)

    // Seed: "Legacy Cleanup" has no teamMembers (and no scrumMaster) field at all.
    expect(teamRows()).toEqual([])
    expect(optionLabels(teamSelect())).toEqual([CHOOSE, PO, SM, DEV1, DEV2, OUTSIDER]) // all but the PO (admin)
    expect(crudButton('Revert changes')).toBeDisabled() // [] in the form is not a change
    expect(selectedLabel(screen.getByLabelText('Scrum Master'))).toBe(CHOOSE)

    await user.selectOptions(teamSelect(), DEV2)
    await user.click(within(devTeamTable()).getByRole('button', { name: 'Add' }))
    expect(teamRows()).toEqual([DEV2])
    expect(crudButton('Save')).toBeDisabled() // the Scrum Master is still required
    await user.selectOptions(screen.getByLabelText('Scrum Master'), SM)
    await user.click(crudButton('Save'))

    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/projects'))
    const put = requests.find((r) => r.method === 'PUT')
    expect(put?.pathname).toBe(`${PROJECTS}/${PROJECT.legacyCleanup}`)
    expect(put?.body).toMatchObject({ productOwner: USER.admin, scrumMaster: USER.sm, teamMembers: [USER.dev2] })
  })

  // DEV-admin-projects-01: the requireAdminUser() guards of the "new" and "edit" loaders (§5.3 R14/R15).
  for (const { name, route } of [
    { name: '/admin/projects/new', route: '/admin/projects/new' },
    { name: '/admin/projects/:itemId', route: `/admin/projects/${PROJECT.webshop}` },
  ]) {
    it(`AC-APR-01 / §5.3 R14/R15: a non-admin (dev1) deep link to ${name} gets the "not authorized" login modal and fetches no projects or users`, async () => {
      const requests = recordRequests()
      await renderRoute(route, { as: 'dev1' })

      const modal = (await screen.findByRole('heading', { name: 'Sign in' })).closest('.modal') as HTMLElement
      expect(within(modal).getByText(NOT_AUTHORIZED)).toHaveClass('alert alert-warning')
      expect(screen.queryByLabelText('Product Owner')).not.toBeInTheDocument()
      expect(requests.filter((r) => PROJECTS_OR_USERS.test(r.pathname))).toEqual([])
    })

    it(`AC-APR-01 / §5.3 R14/R15: an anonymous deep link to ${name} asks for a login and fetches no projects or users`, async () => {
      const requests = recordRequests()
      await renderRoute(route)

      const modal = (await screen.findByRole('heading', { name: 'Sign in' })).closest('.modal') as HTMLElement
      expect(within(modal).getByText(NOT_AUTHENTICATED)).toBeInTheDocument()
      expect(screen.queryByLabelText('Product Owner')).not.toBeInTheDocument()
      expect(requests.filter((r) => PROJECTS_OR_USERS.test(r.pathname))).toEqual([])
    })
  }

  it('AC-APR-04 / Q-admin-projects-1: a team pick that becomes the product owner is cleared', async () => {
    const requests = recordRequests()
    const { user, router } = await openEdit('/admin/projects/new')

    await user.selectOptions(teamSelect(), DEV1)
    expect(selectedLabel(teamSelect())).toBe(DEV1)
    await user.selectOptions(screen.getByLabelText('Product Owner'), DEV1)

    // Legacy kept the stale pick: the select showed `-- choose --` but Add stayed enabled.
    expect(selectedLabel(teamSelect())).toBe(CHOOSE)
    const add = within(devTeamTable()).getByRole('button', { name: 'Add' })
    expect(add).toBeDisabled()
    await user.click(add) // a no-op while disabled
    expect(teamRows()).toEqual([])

    await user.type(screen.getByLabelText('Name'), 'Intranet')
    await user.selectOptions(screen.getByLabelText('Scrum Master'), SM)
    await user.click(crudButton('Save'))

    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/projects'))
    const post = requests.find((r) => r.method === 'POST' && r.pathname === PROJECTS)
    expect(post?.body).toMatchObject({ productOwner: USER.dev1, teamMembers: [] })
  })
})

/**
 * P4: records `defaultPrevented` for every submit event that reaches window. The listener sits outside
 * React's root, so it sees each event after the form's onSubmit has run. jsdom never navigates on a
 * native submission, so a cancelled submit event is the only unit-level proof that the browser would
 * not reload the page (the reload itself is covered by e2e/forms-enter.spec.ts).
 */
function watchSubmits(): boolean[] {
  const prevented: boolean[] = []
  const listener = (event: Event) => prevented.push(event.defaultPrevented)
  window.addEventListener('submit', listener)
  onTestFinished(() => window.removeEventListener('submit', listener))
  return prevented
}

describe('ProjectEdit: Enter in the form (P4)', () => {
  it('DSC-1 / P4: Enter in the project Name field keeps the edits and does not submit', async () => {
    const { user, router } = await openEdit(`/admin/projects/${PROJECT.webshop}`)
    await waitFor(() => expect(router.state.initialized).toBe(true))
    const name = screen.getByLabelText('Name')
    expect(name).toHaveValue('Webshop')
    const team = teamRows()
    expect(team).toEqual([DEV1, DEV2])
    const { pathname, search } = router.state.location
    await user.clear(name)
    await user.type(name, 'Renamed but unsaved')

    const requests = recordRequests()
    const submits = watchSubmits()
    await user.type(name, '{Enter}')

    // Name is the only field that blocks implicit submission, so Enter does submit; the submit is cancelled.
    expect(submits).toEqual([true])
    expect(name).toHaveValue('Renamed but unsaved')
    expect(requests).toEqual([])
    expect(router.state.location).toMatchObject({ pathname, search })
    // Legacy's Enter clicked the first team "Remove"; not ported.
    expect(teamRows()).toEqual(team)
  })
})

describe('ProjectEdit: trimming (P6)', () => {
  it('P6 / DSC-B-1: a spaces-only Name keeps Save disabled; a padded Name and description are saved trimmed', async () => {
    const requests = recordRequests()
    const { user, router } = await openEdit(`/admin/projects/${PROJECT.mobileApp}`)
    const name = screen.getByLabelText('Name')
    await user.clear(name)
    await user.type(name, '   ')
    expect(name).toHaveValue('   ')
    expect(crudButton('Save')).toBeDisabled()

    await user.type(name, 'Mobile  App 2 ')
    await user.clear(screen.getByLabelText('Description'))
    await user.type(screen.getByLabelText('Description'), '  New desc  ')
    expect(name).toHaveValue('   Mobile  App 2 ')
    await user.click(crudButton('Save'))

    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/projects'))
    const put = requests.find((r) => r.method === 'PUT' && r.pathname.startsWith(PROJECTS))
    expect(put?.body).toMatchObject({ name: 'Mobile  App 2', desc: 'New desc' })
  })
})
