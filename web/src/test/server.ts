// The one MSW server every Vitest file shares, built from the real stub handlers (spec §13 item 5).
import { setupServer } from 'msw/node'
import { createStubContext } from '../../stub/handlers.ts'
import { createStubHandlers } from '../../stub/msw.ts'

export const stubContext = createStubContext({ allowReset: true })

// jsdom has document.cookie but nothing writes Set-Cookie into it, so the adapter does (spec §11-2).
export const server = setupServer(...createStubHandlers(stubContext, { writeDocumentCookies: true }))
