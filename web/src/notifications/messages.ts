// Port of services/localizedMessages.js and the `I18N.MESSAGES` constant in app.js (D4: keep the tiny
// key → `{{name}}` module). The catalogue is complete up front (spec §5.4): the 12 legacy keys
// verbatim, then the keys added by S6 for the D14 and S12 fixes and the error boundary.

export const MESSAGES = {
  // Legacy, verbatim (app.js).
  'errors.route.changeError': 'Route change error',
  'crud.user.save.success': "A user with id '{{id}}' was saved successfully.",
  'crud.user.remove.success': "A user with id '{{id}}' was removed successfully.",
  'crud.user.remove.error': "Something went wrong when removing user with id '{{id}}'.",
  'crud.user.save.error': 'Something went wrong when saving a user...',
  'crud.project.save.success': "A project with id '{{id}}' was saved successfully.",
  'crud.project.remove.success': "A project with id '{{id}}' was removed successfully.",
  'crud.project.save.error': 'Something went wrong when saving a project...',
  'login.reason.notAuthorized':
    'You do not have the necessary access permissions.  Do you want to login as someone else?',
  'login.reason.notAuthenticated': 'You must be logged in to access this part of the application.',
  'login.error.invalidCredentials': 'Login failed.  Please check your credentials and try again.',
  'login.error.serverError': 'There was a problem with authenticating: {{exception}}.',
  // New (spec §5.4, S6).
  'crud.project.remove.error': "Something went wrong when removing project with id '{{id}}'.",
  'crud.backlogItem.save.error': 'Something went wrong when saving a backlog item...',
  'crud.backlogItem.remove.error': 'Something went wrong when removing a backlog item...',
  'crud.sprint.save.error': 'Something went wrong when saving a sprint...',
  'crud.sprint.remove.error': 'Something went wrong when removing a sprint...',
  'crud.task.save.error': 'Something went wrong when saving a task...',
  'crud.task.remove.error': 'Something went wrong when removing a task...',
  'error.fatal': 'An unexpected error occurred: {{message}}',
} as const

export type MessageKey = keyof typeof MESSAGES
export type MessageParams = Record<string, unknown>
export type Catalogue = Readonly<Record<string, string>>

function display(value: unknown): string {
  // AngularJS $interpolate rendered null/undefined as '' and objects as JSON.
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** Replaces each `{{name}}` with the param's value; a missing param renders as ''. */
export function interpolate(template: string, params: MessageParams = {}): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, name: string) => display(params[name]))
}

/** AC-NOT-02: the interpolated message, or `?key?` when the key is not in the catalogue. */
export function getMessage(key: string, params: MessageParams = {}, catalogue: Catalogue = MESSAGES): string {
  const template = Object.hasOwn(catalogue, key) ? catalogue[key] : undefined
  return template === undefined ? `?${key}?` : interpolate(template, params)
}
