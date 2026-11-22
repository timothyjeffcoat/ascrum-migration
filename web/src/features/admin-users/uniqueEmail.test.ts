// AC-USR-05 / D9, and the legacy uniqueEmail.spec cases that test the validator itself
// (the form-level cases are in UserEdit.test.tsx). Runs against the shared MSW stub.
import { describe, expect, it } from 'vitest'
import { recordRequests } from '../../test/renderRoute.tsx'
import { USER } from '../../../stub/seed.ts'
import { uniqueEmail } from './uniqueEmail.ts'

const NEW = { isNew: true } as const

describe('uniqueEmail', () => {
  it('uniqueEmail.spec:36 / AC-USR-05: runs users.query({email}) for the value', async () => {
    const requests = recordRequests()
    await uniqueEmail('someone@ascrum.test', {}, NEW)
    const queries = requests.filter((r) => r.method === 'GET' && r.pathname.endsWith('/collections/users'))
    expect(queries.map((r) => r.q)).toEqual([{ email: 'someone@ascrum.test' }])
  })

  it('uniqueEmail.spec:40 / AC-USR-05: invalid ("uniqueEmail") if the query finds a user', async () => {
    expect(await uniqueEmail('po@ascrum.test', {}, NEW)).toBe('uniqueEmail')
  })

  it('uniqueEmail.spec:47 / AC-USR-05: valid if the query finds no users', async () => {
    expect(await uniqueEmail('nobody@ascrum.test', {}, NEW)).toBeNull()
  })

  it('AC-USR-05: an empty value skips the check (no request)', async () => {
    const requests = recordRequests()
    expect(await uniqueEmail('', {}, NEW)).toBeNull()
    expect(await uniqueEmail(undefined, {}, NEW)).toBeNull()
    expect(requests).toEqual([])
  })

  it("D9 / AC-USR-05: the edited user's own e-mail is not a conflict; another user's still is", async () => {
    const editingPo = { isNew: false, originalId: USER.po }
    expect(await uniqueEmail('po@ascrum.test', {}, editingPo)).toBeNull()
    expect(await uniqueEmail('sm@ascrum.test', {}, editingPo)).toBe('uniqueEmail')
  })
})
