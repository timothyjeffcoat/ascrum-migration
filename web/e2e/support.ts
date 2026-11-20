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
    host.innerHTML = [
      '<p id="probe-p">x</p>',
      '<button class="close" id="probe-close">x</button>',
      '<i class="icon-user" id="probe-icon"></i>',
      // One element per vendored-LESS patch (spec/questions/harness.md Q-harness-3):
      '<div class="span12" id="probe-span"></div>', // selector interpolation in #grid > .core
      '<div class="offset1" id="probe-offset"></div>', // same, offsets
      '<button class="btn" id="probe-btn">x</button>', // .box-shadow arity overloads (2 shadows)
      '<div class="navbar navbar-static-top"><div class="container" id="probe-navbar-container"></div></div>', // inlined #grid width
    ].join('')
    document.body.appendChild(host)
    const style = (id: string) => getComputedStyle(document.getElementById(id) as Element)
    const result = {
      paragraphMarginBottom: style('probe-p').marginBottom,
      closeOpacity: style('probe-close').opacity,
      iconUrl: /url\("?([^")]+)"?\)/.exec(style('probe-icon').backgroundImage)?.[1] ?? '',
      spanWidth: style('probe-span').width,
      offsetMarginLeft: style('probe-offset').marginLeft,
      buttonShadow: style('probe-btn').boxShadow,
      navbarContainerWidth: style('probe-navbar-container').width,
    }
    host.remove()
    return result
  })
}
