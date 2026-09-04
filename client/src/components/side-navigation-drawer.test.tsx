import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/compat/primitives', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
  Input: (props: React.ComponentProps<'input'>) => <input {...props} />
}))

import { SideNavigationDrawer } from '~/components/side-navigation-drawer'
import { emptyChatState } from '~/state/event-reducer'
import type { GatewayController } from '~/state/gateway-controller'
import { $chat, $sessions } from '~/state/store'

function controllerStub() {
  return {
    deleteSession: vi.fn().mockResolvedValue(undefined),
    newSession: vi.fn().mockResolvedValue(undefined),
    refreshSessions: vi.fn().mockResolvedValue(undefined),
    resumeSession: vi.fn().mockResolvedValue(undefined)
  } as unknown as GatewayController
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, reject, resolve }
}

function renderDrawer(controller = controllerStub(), open = true) {
  const onClose = vi.fn()
  const onNavigate = vi.fn()
  const result = render(<SideNavigationDrawer activeTab="sessions" controller={controller} onClose={onClose} onNavigate={onNavigate} open={open} />)
  return { controller, onClose, onNavigate, ...result }
}

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  $chat.set({ ...emptyChatState(), storedSessionId: 'session-1' })
  $sessions.set([
    { id: 'session-1', message_count: 4, preview: 'Hidden body', source: 'ios', started_at: 1_777_374_000, title: 'Planning session' },
    { id: 'session-2', message_count: 2, preview: 'Other hidden body', source: 'web', started_at: 1_777_460_400, title: 'Release notes' }
  ])
})

describe('SideNavigationDrawer', () => {
  it('shows the exact primary order and keeps recent sessions below it', () => {
    const { onClose, onNavigate } = renderDrawer()

    expect(screen.getByText('Hermes')).not.toBeNull()
    expect(screen.getByRole('textbox', { name: 'Search sessions' })).not.toBeNull()
    const primary = screen.getByRole('navigation', { name: 'Primary navigation' })
    expect([...primary.querySelectorAll('button')].map(button => button.textContent?.trim())).toEqual(['Capabilities', 'Cron Jobs', 'Settings'])
    expect(screen.getByRole('button', { name: 'Recent sessions' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'New session' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(onNavigate).toHaveBeenCalledWith('settings')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('filters session titles only and keeps the query while closed', () => {
    const controller = controllerStub()
    const { rerender } = renderDrawer(controller)
    const search = screen.getByRole<HTMLInputElement>('textbox', { name: 'Search sessions' })
    fireEvent.change(search, { target: { value: 'release' } })

    expect(screen.queryByText('Planning session')).toBeNull()
    expect(screen.getByText('Release notes')).not.toBeNull()
    expect(screen.queryByText('Other hidden body')).toBeNull()

    rerender(<SideNavigationDrawer activeTab="sessions" controller={controller} onClose={() => undefined} onNavigate={() => undefined} open={false} />)
    rerender(<SideNavigationDrawer activeTab="sessions" controller={controller} onClose={() => undefined} onNavigate={() => undefined} open />)
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Search sessions' }).value).toBe('release')
  })

  it('returns to the current chat from Recent sessions without a session RPC', () => {
    const { controller, onClose, onNavigate } = renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Recent sessions' }))

    expect(onNavigate).toHaveBeenCalledWith('sessions')
    expect(onClose).toHaveBeenCalledOnce()
    expect(controller.resumeSession).not.toHaveBeenCalled()
    expect(controller.newSession).not.toHaveBeenCalled()
  })

  it('marks and opens the active durable session without resuming it', () => {
    const { controller, onClose, onNavigate } = renderDrawer()
    const active = screen.getByRole('button', { name: /Planning session/ })
    expect(active.getAttribute('aria-current')).toBe('page')

    fireEvent.click(active)
    expect(controller.resumeSession).not.toHaveBeenCalled()
    expect(onNavigate).toHaveBeenCalledWith('sessions')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('waits for resume before navigating and closing', async () => {
    const controller = controllerStub()
    const resume = deferred()
    vi.mocked(controller.resumeSession).mockReturnValue(resume.promise)
    const { onClose, onNavigate } = renderDrawer(controller)

    fireEvent.click(screen.getByRole('button', { name: /Release notes/ }))
    expect(controller.resumeSession).toHaveBeenCalledWith('session-2')
    expect(onNavigate).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    resume.resolve()
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('sessions'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('waits for new-session creation and disables competing session actions', async () => {
    const controller = controllerStub()
    const creation = deferred()
    vi.mocked(controller.newSession).mockReturnValue(creation.promise)
    const { onClose, onNavigate } = renderDrawer(controller)

    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Release notes/ }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Release notes/ }))
    expect(controller.resumeSession).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    creation.resolve()
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('sessions'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it.each([
    ['resume', 'resumeSession', /Release notes/, 'resume failed'],
    ['creation', 'newSession', 'New session', 'creation failed']
  ] as const)('keeps the drawer open when %s fails', async (_label, method, control, message) => {
    const controller = controllerStub()
    vi.mocked(controller[method]).mockRejectedValue(new Error(message))
    const { onClose, onNavigate } = renderDrawer(controller)

    fireEvent.click(screen.getByRole('button', { name: control }))
    expect((await screen.findByRole('alert')).textContent).toContain(message)
    expect(onClose).not.toHaveBeenCalled()
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('keeps loaded rows and the drawer open when refresh fails', async () => {
    const controller = controllerStub()
    vi.mocked(controller.refreshSessions).mockRejectedValue(new Error('refresh failed'))
    const { onClose } = renderDrawer(controller)

    expect((await screen.findByRole('alert')).textContent).toContain('refresh failed')
    expect(screen.getByText('Planning session')).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('reveals delete with a left swipe, confirms it, and reports deletion failures', async () => {
    const controller = controllerStub()
    vi.mocked(controller.deleteSession).mockRejectedValue(new Error('delete failed'))
    const { onClose } = renderDrawer(controller)
    const row = screen.getByText('Release notes').closest('article')!
    const remove = row.querySelector<HTMLButtonElement>('[aria-label="Delete Release notes"]')!

    fireEvent.touchStart(row, { touches: [{ clientX: 200, clientY: 20 }] })
    fireEvent.touchEnd(row, { changedTouches: [{ clientX: 100, clientY: 24 }] })
    expect(remove.getAttribute('aria-hidden')).toBe('false')
    fireEvent.click(remove)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect((await screen.findByRole('alert')).textContent).toContain('delete failed')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes with Escape, backdrop click, and the close button', () => {
    const escape = renderDrawer()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(escape.onClose).toHaveBeenCalledOnce()
    escape.unmount()

    const backdrop = renderDrawer()
    fireEvent.click(screen.getByTestId('side-navigation-backdrop'))
    expect(backdrop.onClose).toHaveBeenCalledOnce()
    backdrop.unmount()

    const close = renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Close navigation' }))
    expect(close.onClose).toHaveBeenCalledOnce()
  })

  it('makes the closed drawer inert, focuses search on open, and restores opener focus', () => {
    const controller = controllerStub()
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const { container, rerender } = render(<SideNavigationDrawer activeTab="sessions" controller={controller} onClose={() => undefined} onNavigate={() => undefined} open={false} />)
    const backdrop = container.querySelector<HTMLElement>('.side-drawer-backdrop')!
    expect(backdrop.getAttribute('aria-hidden')).toBe('true')
    expect(backdrop.hasAttribute('inert')).toBe(true)

    rerender(<SideNavigationDrawer activeTab="sessions" controller={controller} onClose={() => undefined} onNavigate={() => undefined} open />)
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search sessions' }))
    rerender(<SideNavigationDrawer activeTab="sessions" controller={controller} onClose={() => undefined} onNavigate={() => undefined} open={false} />)
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})
