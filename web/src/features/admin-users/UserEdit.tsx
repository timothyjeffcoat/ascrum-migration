// Port of admin/users/admin-users-edit.js (UsersEditCtrl) + users-edit.tpl.html (AC-USR-04..07).
// D8 fixed: legacy copied the stored plaintext password into both password fields. Here both always
// start empty (§5.6), and a blank password on edit is left out of the payload, which the stub reads as
// "unchanged" (A3, S8). Q-admin-users-1 (b): `password` is a `values` field, so a password-only change
// makes the form dirty and can be saved, as in legacy; only `passwordRepeat` is a form-only `extra`.
import type { LoaderFunctionArgs } from 'react-router'
import { useLoaderData, useNavigate } from 'react-router'
import { users } from '../../api/collections.ts'
import type { Draft, User } from '../../api/types.ts'
import { requireAdminUser } from '../../auth/guards.ts'
import { Gravatar } from '../../components/Gravatar.tsx'
import { CrudButtons } from '../../crud/CrudButtons.tsx'
import { useCrudForm, type Ctx, type Validator } from '../../crud/useCrudForm.ts'
import { email, equalsField, required } from '../../crud/validators.ts'
import { pushForCurrentRoute, pushForNextRoute } from '../../notifications/store.ts'
import { uniqueEmail } from './uniqueEmail.ts'

type RepeatField = { passwordRepeat: string }
type UserFormValues = Draft<User> & RepeatField

/** §5.6 draft for `/admin/users/new`. A fresh object per call: forms must never share one. */
export function newUserDraft(): Draft<User> {
  return { email: '', lastName: '', firstName: '', admin: false, password: '' }
}

function emptyRepeat(): RepeatField {
  return { passwordRepeat: '' }
}

/** R17 resolve: `currentUser: requireAdminUser`, `user: new Users()`. */
export async function newUserLoader(): Promise<Draft<User>> {
  await requireAdminUser()
  return newUserDraft()
}

/**
 * R18 resolve: `currentUser: requireAdminUser`, `user: Users.getById(itemId)`. The loaded user gets
 * `password: ''` (Q-admin-users-1), so a blank password field is not dirty against it.
 */
export async function editUserLoader({ params }: LoaderFunctionArgs): Promise<Draft<User>> {
  await requireAdminUser()
  const user = await users.getById(params.itemId ?? '')
  return { ...user, password: '' }
}

/**
 * AC-USR-04: the password fields are required on create; on edit only once either one is filled in
 * (blank on edit = "unchanged", A3). Legacy had a plain `required` on both, which together with D8's
 * pre-filled password is what made editing work at all.
 */
const passwordRequired: Validator<UserFormValues> = (value, values, ctx: Ctx) =>
  ctx.isNew || (values.password ?? '') !== '' || values.passwordRepeat !== '' ? required(value) : null

/** AC-USR-06: the password is sent only when one was entered; on edit, blank means "unchanged" (A3). */
function toPayload(values: Draft<User>): Draft<User> {
  const payload: Draft<User> = { ...values }
  if (payload.password === '') Reflect.deleteProperty(payload, 'password')
  return payload
}

/** Both the new and the edit route render this; keyed by id so another user gets a fresh form. */
export function UserEditRoute() {
  const user = useLoaderData<typeof editUserLoader>()
  return <UserEdit key={user.id ?? 'new'} user={user} />
}

type UserEditProps = { user: Draft<User> }

export function UserEdit({ user }: UserEditProps) {
  const navigate = useNavigate()
  const form = useCrudForm<User, RepeatField>({
    initial: user,
    extra: emptyRepeat(),
    validators: {
      email: [required, email],
      lastName: [required],
      firstName: [required],
      password: [passwordRequired],
      passwordRepeat: [passwordRequired, equalsField<UserFormValues>('password')],
    },
    asyncValidators: { email: uniqueEmail },
    toPayload,
    save: (payload) => users.save(payload),
    remove: (doc) => users.remove(doc),
    onSave: (saved) => {
      pushForNextRoute('crud.user.save.success', 'success', { id: saved.id })
      void navigate('/admin/users')
    },
    onRemove: (removed) => {
      pushForNextRoute('crud.user.remove.success', 'success', { id: removed.id })
      void navigate('/admin/users')
    },
    onError: (op) => {
      // S12: legacy crudEdit called the same onError for a failed remove, so it said "saving".
      if (op === 'save') pushForCurrentRoute('crud.user.save.error', 'error')
      else pushForCurrentRoute('crud.user.remove.error', 'error', { id: user.id })
    },
  })
  const { values, extra, showError } = form

  return (
    <div className="well">
      <form name="form" noValidate>
        <legend>User</legend>
        <Gravatar email={values.email} size={200} className="img-polaroid pull-right" />
        <label htmlFor="email">E-mail</label>
        <input
          className="span6"
          type="email"
          id="email"
          name="email"
          value={values.email ?? ''}
          onChange={(event) => form.setField('email', event.target.value)}
          required
        />
        {showError('email', 'required') && <span className="help-inline">This field is required.</span>}
        {showError('email', 'email') && <span className="help-inline">Please enter a valid email address.</span>}
        {showError('email', 'uniqueEmail') && (
          <span className="help-inline">This email address is not available - please enter another.</span>
        )}
        <label htmlFor="lastName">Last name</label>
        <input
          className="span6"
          type="text"
          id="lastName"
          name="lastName"
          value={values.lastName ?? ''}
          onChange={(event) => form.setField('lastName', event.target.value)}
          required
        />
        {showError('lastName', 'required') && <span className="help-inline">This field is required.</span>}
        <label htmlFor="firstName">First name</label>
        <input
          className="span6"
          type="text"
          id="firstName"
          name="firstName"
          value={values.firstName ?? ''}
          onChange={(event) => form.setField('firstName', event.target.value)}
          required
        />
        {showError('firstName', 'required') && <span className="help-inline">This field is required.</span>}
        <label htmlFor="password">Password</label>
        <input
          className="span6"
          type="password"
          id="password"
          name="password"
          value={values.password ?? ''}
          onChange={(event) => form.setField('password', event.target.value)}
          required
        />
        {showError('password', 'required') && <span className="help-inline">This field is required.</span>}
        {showError('passwordRepeat', 'equal') && <span className="help-inline">Passwords do not match.</span>}
        <label htmlFor="passwordRepeat">Password (repeat)</label>
        <input
          className="span6"
          type="password"
          id="passwordRepeat"
          name="passwordRepeat"
          value={extra.passwordRepeat}
          onChange={(event) => form.setExtra('passwordRepeat', event.target.value)}
          required
        />
        {showError('passwordRepeat', 'required') && <span className="help-inline">This field is required.</span>}
        {showError('passwordRepeat', 'equal') && <span className="help-inline">Passwords do not match.</span>}
        <label>Admin</label>
        <input
          type="checkbox"
          checked={values.admin ?? false}
          onChange={(event) => form.setField('admin', event.target.checked)}
        />
        <hr />
        <CrudButtons form={form} />
      </form>
    </div>
  )
}
