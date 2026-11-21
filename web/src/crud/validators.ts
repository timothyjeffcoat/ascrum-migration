// Field validators for useCrudForm (spec §4.2). Each returns an error key or null. The keys are the
// ones legacy templates passed to showError(): 'required', 'email', 'equal', 'number', 'uniqueEmail'.
import type { ErrorKey, Validator } from './useCrudForm.ts'

/** AngularJS 1.2.0-rc.3's EMAIL_REGEXP (legacy vendor/angular/angular.js), so `type="email"` validity matches. */
export const EMAIL_REGEXP = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,6}$/

export function isEmail(value: string): boolean {
  return EMAIL_REGEXP.test(value)
}

/** AngularJS `$isEmpty`: undefined, null, '' and NaN are empty. */
function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '' || Number.isNaN(value)
}

/** The `required` attribute. */
export function required(value: unknown): ErrorKey | null {
  return isEmpty(value) ? 'required' : null
}

/** `type="email"`: an empty value is valid here (that is `required`'s job). */
export function email(value: unknown): ErrorKey | null {
  return typeof value === 'string' && value !== '' && !isEmail(value) ? 'email' : null
}

/**
 * Port of admin/users/validateEquals.js: the field must equal another field, else `equal`.
 * Validators rerun on every change, so a change to the other field re-validates this one (AC-CRUD-09).
 */
export function equalsField<V>(name: keyof V): Validator<V> {
  return (value, values) => (value === values[name] ? null : 'equal')
}
