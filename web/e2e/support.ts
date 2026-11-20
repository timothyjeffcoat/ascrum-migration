// Helpers for the Phase 2 harness specs. Cluster e2e files use their own page-level helpers.
import { expect, type Page } from '@playwright/test'

/** Navigate and wait until React has rendered something into #root. Returns the document response. */
export async function bootApp(page: Page, path: string) {
  const response = await page.goto(path)
  await expect(page.locator('#root > *').first()).toBeVisible()
  return response
}

/** Injects legacy Bootstrap markup and reads computed styles, so the probe never depends on app markup. */
export async function probeStyles(page: Page) {
  return page.evaluate(() => {
    const host = document.createElement('div')
    host.innerHTML =
      '<p id="probe-p">x</p><button class="close" id="probe-close">x</button><i class="icon-user" id="probe-icon"></i>'
    document.body.appendChild(host)
    const style = (id: string) => getComputedStyle(document.getElementById(id) as Element)
    const result = {
      paragraphMarginBottom: style('probe-p').marginBottom,
      closeOpacity: style('probe-close').opacity,
      iconUrl: /url\("?([^")]+)"?\)/.exec(style('probe-icon').backgroundImage)?.[1] ?? '',
    }
    host.remove()
    return result
  })
}
