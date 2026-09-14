import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/compat/primitives', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
  Input: (props: React.ComponentProps<'input'>) => <input {...props} />
}))

import { SideNavigationPage } from '~/components/side-navigation-page'
import { $chat, emptyChatState } from '~/state/conversation'
import type { GatewayController } from '~/state/gateway-controller'
import { $preferences, $sessions, $sessionsHasMore, $sessionsLoadingMore } from '~/state/store'

function controllerStub() {
  return {
    deleteSession: vi.fn().mockResolvedValue(undefined),
    loadMoreSessions: vi.fn().mockResolvedValue(undefined),
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

function renderNavigationPage(controller = controllerStub(), open = true) {
  const onClose = vi.fn()
  const onNavigate = vi.fn()
  const onOpenModel = vi.fn()
  const onDismissRequest = vi.fn((intent = { type: 'close' as const }) => {
    onClose()
    if (intent.type === 'model') onOpenModel()
    else if (intent.type === 'tab') onNavigate(intent.tab)
  })
  const result = render(<SideNavigationPage activeTab="sessions" controller={controller} onDismissRequest={onDismissRequest} open={open} />)
  return { controller, onClose, onDismissRequest, onNavigate, onOpenModel, ...result }
}

function pointer(node: HTMLElement, type: 'pointerDown' | 'pointerMove' | 'pointerUp' | 'pointerCancel', values: Record<string, unknown>) {
  fireEvent[type](node, { isPrimary: true, pointerId: 1, pointerType: 'touch', ...values })
}

async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
}

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  $preferences.set({ authMode: 'token', profile: 'work', remoteURL: 'https://gateway.test', theme: 'system' })
  $chat.set({ ...emptyChatState(), storedSessionId: 'session-1' })
  $sessionsHasMore.set(false)
  $sessionsLoadingMore.set(false)
  $sessions.set([
    { id: 'session-1', message_count: 4, preview: 'Hidden body', source: 'ios', started_at: 1_777_374_000, title: 'Planning session' },
    { id: 'session-2', message_count: 2, preview: 'Other hidden body', source: 'web', started_at: 1_777_460_400, title: 'Release notes' }
  ])
})

describe('SideNavigationPage', () => {
  it('shows the bot identity and Sessions title without brand chrome', () => {
    const { container, onClose, onNavigate } = renderNavigationPage()

    const identity = screen.getByRole('button', { name: 'Open bot chat' })
    expect(identity.querySelector('strong')?.textContent).toBe('Work')
    expect(identity.querySelector('small')?.textContent).toBe('Sessions')
    expect(container.querySelector('.navigation-identity .brand-mark')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Search sessions' })).not.toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Primary navigation' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Recent sessions' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'New session' })).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Open bot chat' }))
    expect(onNavigate).toHaveBeenCalledWith('sessions')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('requests an in-memory dismissal from the accessible back button', () => {
    const { onDismissRequest } = renderNavigationPage()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    expect(onDismissRequest).toHaveBeenCalledWith({ type: 'close' })
  })

  it('dismisses from the left edge with a rightward swipe', () => {
    vi.useFakeTimers()
    const { container, onDismissRequest } = renderNavigationPage()
    const page = container.querySelector('.side-navigation-page') as HTMLElement
    const surface = container.querySelector('.session-main') as HTMLElement
    pointer(surface, 'pointerDown', { clientX: 4, clientY: 220 })
    pointer(surface, 'pointerMove', { clientX: 180, clientY: 224 })
    expect(Number(page.style.getPropertyValue('--swipe-progress'))).toBeGreaterThan(0)
    pointer(surface, 'pointerUp', { clientX: 180, clientY: 224 })
    act(() => { vi.runAllTimers() })
    expect(onDismissRequest).toHaveBeenCalledExactlyOnceWith({ type: 'close' })
    expect(container.querySelector('.session-row')?.classList.contains('delete-revealed')).toBe(false)
    vi.useRealTimers()
  })

  it('does not let a non-edge page swipe dismiss navigation', () => {
    vi.useFakeTimers()
    const { container, onDismissRequest } = renderNavigationPage()
    const page = container.querySelector('.side-navigation-page') as HTMLElement
    pointer(page, 'pointerDown', { clientX: 60, clientY: 220 })
    pointer(page, 'pointerMove', { clientX: 240, clientY: 224 })
    pointer(page, 'pointerUp', { clientX: 240, clientY: 224 })
    act(() => { vi.runAllTimers() })
    expect(onDismissRequest).not.toHaveBeenCalled()
    expect(page.style.getPropertyValue('--swipe-progress')).toBe('0')
    vi.useRealTimers()
  })

  it('lets a session-row swipe reveal its delete action without closing the navigation page', () => {
    vi.useFakeTimers()
    const { container, onClose } = renderNavigationPage()
    const row = container.querySelector('.session-row') as HTMLElement
    const surface = row.querySelector('.session-main') as HTMLElement
    pointer(surface, 'pointerDown', { clientX: 300, clientY: 200 })
    pointer(surface, 'pointerMove', { clientX: 180, clientY: 200 })
    pointer(surface, 'pointerUp', { clientX: 180, clientY: 200 })
    act(() => { vi.runAllTimers() })
    expect(row.classList.contains('delete-revealed')).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('hides cron-run sessions from the recent sessions list', () => {
    $sessions.set([
      { id: 'session-1', message_count: 4, preview: 'Hidden body', source: 'ios', started_at: 1_777_374_000, title: 'Planning session' },
      { id: 'cron-1', message_count: 9, preview: 'Cron body', source: 'cron', started_at: 1_777_500_000, title: 'Nightly digest' }
    ])
    const { container } = renderNavigationPage()

    expect(container.querySelector('.session-list')?.textContent).not.toContain('Nightly digest')
    expect(screen.getByRole('button', { name: /Planning session/ })).not.toBeNull()
  })

  it('offers agent capabilities and cron jobs next to the sessions search', () => {
    const { onClose, onNavigate } = renderNavigationPage()

    fireEvent.click(screen.getByRole('button', { name: 'Capabilities' }))
    expect(onNavigate).toHaveBeenCalledWith('capabilities')
    expect(onClose).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Cron Jobs' }))
    expect(onNavigate).toHaveBeenCalledWith('cron')
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('opens the model settings from the sections list', () => {
    const { onClose, onOpenModel } = renderNavigationPage()

    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    expect(onOpenModel).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('keeps only session rows and pagination inside the session-list scroll region', () => {
    $sessionsHasMore.set(true)
    renderNavigationPage()

    const sessionList = screen.getByRole('region', { name: 'Sessions' })
    expect(sessionList.contains(screen.getByRole('button', { name: /Planning session/ }))).toBe(true)
    expect(sessionList.contains(screen.getByRole('button', { name: 'Load more sessions' }))).toBe(true)
    expect(sessionList.contains(screen.getByRole('textbox', { name: 'Search sessions' }))).toBe(false)
    expect(sessionList.contains(screen.getByRole('button', { name: 'Open bot chat' }))).toBe(false)
    expect(sessionList.contains(screen.getByRole('button', { name: 'Recent sessions' }))).toBe(false)
    expect(sessionList.contains(screen.getByRole('button', { name: 'Capabilities' }))).toBe(false)
    expect(sessionList.contains(screen.getByRole('button', { name: 'Cron Jobs' }))).toBe(false)
  })

  it('filters session titles only and keeps the query while closed', () => {
    const controller = controllerStub()
    const { rerender } = renderNavigationPage(controller)
    const search = screen.getByRole<HTMLInputElement>('textbox', { name: 'Search sessions' })
    fireEvent.change(search, { target: { value: 'release' } })

    expect(screen.queryByText('Planning session')).toBeNull()
    expect(screen.getByText('Release notes')).not.toBeNull()
    expect(screen.queryByText('Other hidden body')).toBeNull()

    rerender(<SideNavigationPage activeTab="sessions" controller={controller} onDismissRequest={() => undefined} open={false} />)
    rerender(<SideNavigationPage activeTab="sessions" controller={controller} onDismissRequest={() => undefined} open />)
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Search sessions' }).value).toBe('release')
  })

  it('loads more sessions only when the bounded page reports more', () => {
    const controller = controllerStub()
    $sessionsHasMore.set(true)
    const { rerender } = renderNavigationPage(controller)

    fireEvent.click(screen.getByRole('button', { name: 'Load more sessions' }))
    expect(controller.loadMoreSessions).toHaveBeenCalledOnce()

    $sessionsLoadingMore.set(true)
    rerender(<SideNavigationPage activeTab="sessions" controller={controller} onDismissRequest={() => undefined} open />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Loading more…' }).disabled).toBe(true)
  })

  it('returns to the current chat from Recent sessions without a session RPC', () => {
    const { controller, onClose, onNavigate } = renderNavigationPage()
    fireEvent.click(screen.getByRole('button', { name: 'Recent sessions' }))

    expect(onNavigate).toHaveBeenCalledWith('sessions')
    expect(onClose).toHaveBeenCalledOnce()
    expect(controller.resumeSession).not.toHaveBeenCalled()
    expect(controller.newSession).not.toHaveBeenCalled()
  })

  it('marks and opens the active durable session without resuming it', () => {
    const { controller, onClose, onNavigate } = renderNavigationPage()
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
    const { onClose, onNavigate } = renderNavigationPage(controller)

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
    const { onClose, onNavigate } = renderNavigationPage(controller)

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
  ] as const)('keeps the navigation page open when %s fails', async (_label, method, control, message) => {
    const controller = controllerStub()
    vi.mocked(controller[method]).mockRejectedValue(new Error(message))
    const { onClose, onNavigate } = renderNavigationPage(controller)

    fireEvent.click(screen.getByRole('button', { name: control }))
    expect((await screen.findByRole('alert')).textContent).toContain(message)
    expect(onClose).not.toHaveBeenCalled()
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('keeps loaded rows and the navigation page open when refresh fails', async () => {
    const controller = controllerStub()
    vi.mocked(controller.refreshSessions).mockRejectedValue(new Error('refresh failed'))
    const { onClose } = renderNavigationPage(controller)

    expect((await screen.findByRole('alert')).textContent).toContain('refresh failed')
    expect(screen.getByText('Planning session')).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('reveals delete with a left swipe, confirms it, and reports deletion failures', async () => {
    const controller = controllerStub()
    vi.mocked(controller.deleteSession).mockRejectedValue(new Error('delete failed'))
    const { onClose } = renderNavigationPage(controller)
    const row = screen.getByText('Release notes').closest('article')!
    const remove = row.querySelector<HTMLButtonElement>('[aria-label="Delete Release notes"]')!
    const surface = row.querySelector<HTMLElement>('.session-main')!

    pointer(surface, 'pointerDown', { clientX: 300, clientY: 20 })
    pointer(surface, 'pointerMove', { clientX: 100, clientY: 20 })
    pointer(surface, 'pointerUp', { clientX: 100, clientY: 20 })
    await settle()
    expect(remove.getAttribute('aria-hidden')).toBe('false')
    fireEvent.click(remove)
    fireEvent.click(remove)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect((await screen.findByRole('alert')).textContent).toContain('delete failed')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes with Escape', () => {
    const escape = renderNavigationPage()
    fireEvent.keyDown(screen.getByRole('main'), { key: 'Escape' })
    expect(escape.onClose).toHaveBeenCalledOnce()
  })

  it('makes the closed navigation page inert, focuses the panel on open without focusing search, and restores opener focus', () => {
    const controller = controllerStub()
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const { container, rerender } = render(<SideNavigationPage activeTab="sessions" controller={controller} onDismissRequest={() => undefined} open={false} />)
    const page = container.querySelector<HTMLElement>('.side-navigation-page')!
    expect(page.getAttribute('aria-hidden')).toBe('true')
    expect(page.hasAttribute('inert')).toBe(true)

    rerender(<SideNavigationPage activeTab="sessions" controller={controller} onDismissRequest={() => undefined} open />)
    expect(document.activeElement).toBe(screen.getByRole('main', { name: 'Navigation' }))
    expect(document.activeElement).not.toBe(screen.getByRole('textbox', { name: 'Search sessions' }))
    rerender(<SideNavigationPage activeTab="sessions" controller={controller} onDismissRequest={() => undefined} open={false} />)
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})
