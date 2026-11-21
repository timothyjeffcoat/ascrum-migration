import { describe, expect, it } from 'vitest'
import { getMessage, MESSAGES } from './messages.ts'

// Legacy common/services/localizedMessages.spec.js, with its injected catalogue.
describe('legacy localizedMessages cases', () => {
  const messages: Record<string, string> = {}

  it('should return a localized message if defined', () => {
    messages.existing = 'Existing message!'
    expect(getMessage('existing', {}, messages)).toBe('Existing message!')
  })

  it('should return a message key surrounded by a question mark for non-existing messages', () => {
    expect(getMessage('non.existing', {}, messages)).toBe('?non.existing?')
  })

  it('should interpolate parameters', () => {
    messages.sth = 'en {{param}} us'
    expect(getMessage('sth', { param: 'value' }, messages)).toBe('en value us')
  })

  it('should not break for missing params', () => {
    messages.sth = 'en {{param}} us'
    expect(getMessage('sth', undefined, messages)).toBe('en  us')
    expect(getMessage('sth', { other: 'value' }, messages)).toBe('en  us')
  })
})

describe('message catalogue', () => {
  it('§5.4: the 12 legacy keys verbatim (app.js I18N.MESSAGES)', () => {
    expect(MESSAGES).toMatchObject({
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
    })
  })

  it('§5.4 / S6: the 8 new keys, and nothing else', () => {
    expect(MESSAGES).toMatchObject({
      'crud.project.remove.error': "Something went wrong when removing project with id '{{id}}'.",
      'crud.backlogItem.save.error': 'Something went wrong when saving a backlog item...',
      'crud.backlogItem.remove.error': 'Something went wrong when removing a backlog item...',
      'crud.sprint.save.error': 'Something went wrong when saving a sprint...',
      'crud.sprint.remove.error': 'Something went wrong when removing a sprint...',
      'crud.task.save.error': 'Something went wrong when saving a task...',
      'crud.task.remove.error': 'Something went wrong when removing a task...',
      'error.fatal': 'An unexpected error occurred: {{message}}',
    })
    expect(Object.keys(MESSAGES)).toHaveLength(20)
  })

  it('AC-NOT-02: {{name}} interpolation against the real catalogue; a missing key renders ?key?', () => {
    expect(getMessage('crud.user.remove.error', { id: 'abc' })).toBe(
      "Something went wrong when removing user with id 'abc'.",
    )
    expect(getMessage('error.fatal', { message: 'boom' })).toBe('An unexpected error occurred: boom')
    expect(getMessage('missing.key')).toBe('?missing.key?')
    expect(getMessage('toString')).toBe('?toString?') // only the catalogue's own keys count
  })
})
