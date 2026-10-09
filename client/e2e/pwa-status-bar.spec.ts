import { expect, test } from '@playwright/test'

test('uses the default iOS status bar instead of a translucent overlay', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes')
  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute('content', 'default')
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/)
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible()
})

test('renders bots, chat, and sessions as fixed pages with opaque headers', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Use password for Test account' }).click()
  await page.getByPlaceholder('Username').fill('browser-e2e')
  await page.getByPlaceholder('Password').fill('fixture-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  const checkHeader = async (selector: string) => {
    const header = page.locator(selector)
    await expect(header).toBeVisible()
    const frame = await header.evaluate(element => {
      const content = element.parentElement!
      const page = content.parentElement!
      const style = getComputedStyle(content)
      return {
        pagePosition: getComputedStyle(page).position,
        directShellChild: page.parentElement!.classList.contains('mobile-shell'),
        sharedFrame: content.classList.contains('sessions-menu-content'),
        display: style.display,
        direction: style.flexDirection,
        overflow: style.overflow,
        headerFlex: getComputedStyle(element).flexShrink
      }
    })
    expect(frame).toEqual({ pagePosition: 'fixed', directShellChild: true, sharedFrame: true, display: 'flex', direction: 'column', overflow: 'hidden', headerFlex: '0' })
    await expect.poll(() => header.evaluate(element => getComputedStyle(element.parentElement!.parentElement!).bottom)).toBe('0px')
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => {
        document.documentElement.classList.toggle('dark', theme === 'dark')
        document.documentElement.dataset.theme = theme
      }, theme)
      const appearance = await header.evaluate(element => {
        const style = getComputedStyle(element)
        const reference = document.createElement('div')
        reference.style.backgroundColor = 'var(--bg)'
        element.append(reference)
        const background = getComputedStyle(reference).backgroundColor
        reference.remove()
        return {
          background: style.backgroundColor,
          expectedBackground: background,
          blur: style.backdropFilter,
          webkitBlur: style.getPropertyValue('-webkit-backdrop-filter')
        }
      })
      expect(appearance.background).toBe(appearance.expectedBackground)
      expect(appearance.blur).toBe('none')
      expect(['', 'none']).toContain(appearance.webkitBlur)
    }
  }

  await checkHeader('.roster-layer > .sessions-menu-content > .app-header')
  await page.getByRole('button', { name: 'Hermes', exact: true }).click()
  await expect(page.getByLabel('Message Hermes')).toBeVisible()
  await checkHeader('.foreground-layer.active > .sessions-menu-content > .app-header')
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await checkHeader('.sessions-menu.open .app-header')
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.getByLabel('Message Hermes')).toBeVisible()
  await checkHeader('.foreground-layer.active > .sessions-menu-content > .app-header')
})
