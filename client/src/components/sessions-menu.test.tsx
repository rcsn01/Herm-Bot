import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/compat/primitives', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
  Input: (props: React.ComponentProps<'input'>) => <input {...props} />
}))

import { SessionsMenu } from '~/components/sessions-menu'
import { $draftOwner, draftOwnerKey } from '~/state/draft-owner'
import { localPrivacy } from '~/state/local-privacy'
import { $chat, emptyChatState } from '~/state/conversation'
import type { GatewayController } from '~/state/gateway-controller'
import type { SelectionOutcome } from '~/state/session-selection'
import { $connection, $preferences, $sessions, $sessionsHasMore, $sessionsLoadingMore } from '~/state/store'

function selected(id: string): SelectionOutcome {
  return { resumed: true, session: { storedSessionId: id, runtimeSessionId: `runtime-${id}`, rows: [], info: {}, contractVersion: 6 } }
}

function controllerStub() {
  return {
    deleteSession: vi.fn().mockResolvedValue(undefined),
    loadMoreSessions: vi.fn().mockResolvedValue(undefined),
    newSession: vi.fn().mockResolvedValue(selected('created')),
    refreshSessions: vi.fn().mockResolvedValue(undefined),
    resumeSession: vi.fn(async (id: string) => {
      $chat.set({ ...emptyChatState(), storedSessionId: id, runtimeSessionId: `runtime-${id}` })
      return selected(id)
    })
  } as unknown as GatewayController
}

function deferred<T = void>() {
  let resolve!: (value?: T | PromiseLike<T>) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = value => done(value as T)
    reject = fail
  })
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
  const result = render(<SessionsMenu controller={controller} onDismissRequest={onDismissRequest} open={open} />)
  return { controller, onClose, onDismissRequest, onNavigate, onOpenModel, ...result }
}

function pointer(node: HTMLElement, type: 'pointerDown' | 'pointerMove' | 'pointerUp' | 'pointerCancel', values: Record<string, unknown>) {
  fireEvent[type](node, { isPrimary: true, pointerId: 1, pointerType: 'touch', ...values })
}

async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

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

describe('SessionsMenu', () => {
  it('shows the bot identity and Sessions title without brand chrome', () => {
    const { container, onClose, onNavigate } = renderNavigationPage()

    const identity = screen.getByRole('button', { name: 'Open bot chat' })
    expect(identity.querySelector('strong')?.textContent).toBe('Work')
    expect(identity.querySelector('small')?.textContent).toBe('Sessions')
    expect(container.querySelector('.sessions-menu-header .header-bot-button .brand-mark')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Search loaded titles' })).not.toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Primary navigation' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull()
    expect(screen.queryByText('Recent sessions')).toBeNull()
    const newSession = screen.getByRole('button', { name: 'New session' })
    expect(newSession.firstElementChild?.tagName).toBe('svg')
    expect(newSession.lastElementChild?.textContent).toBe('New session')
    expect(screen.getByRole('region', { name: 'Sessions' }).firstElementChild).toBe(newSession)

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
    const page = container.querySelector('.sessions-menu') as HTMLElement
    const surface = container.querySelector('.session-main') as HTMLElement
    pointer(surface, 'pointerDown', { clientX: 4, clientY: 220 })
    pointer(surface, 'pointerMove', { clientX: 180, clientY: 224 })
    expect(Number(page.style.getPropertyValue('--swipe-progress'))).toBeGreaterThan(0)
    pointer(surface, 'pointerUp', { clientX: 180, clientY: 224 })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(onDismissRequest).toHaveBeenCalledExactlyOnceWith({ type: 'close' })
    expect(container.querySelector('.session-row')?.classList.contains('delete-revealed')).toBe(false)
    vi.useRealTimers()
  })

  it('does not let a non-edge page swipe dismiss navigation', () => {
    vi.useFakeTimers()
    const { container, onDismissRequest } = renderNavigationPage()
    const page = container.querySelector('.sessions-menu') as HTMLElement
    pointer(page, 'pointerDown', { clientX: 60, clientY: 220 })
    pointer(page, 'pointerMove', { clientX: 240, clientY: 224 })
    pointer(page, 'pointerUp', { clientX: 240, clientY: 224 })
    act(() => { vi.advanceTimersByTime(1000) })
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
    act(() => { vi.advanceTimersByTime(1000) })
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
    expect(screen.getByRole('button', { name: /^Planning session/ })).not.toBeNull()
  })

  it('shows Sessions, Capabilities, and Models without the relocated Automations entry', () => {
    const { onClose, onNavigate, onOpenModel } = renderNavigationPage()
    const navigation = screen.getByRole('navigation', { name: 'Bot workspace' })
    const tabs = Array.from(navigation.querySelectorAll('button'))
    const sessions = screen.getByRole('region', { name: 'Sessions' })

    expect(tabs.map(tab => tab.getAttribute('aria-label'))).toEqual(['Sessions', 'Capabilities', 'Models'])
    expect(tabs[0]?.getAttribute('aria-current')).toBe('page')
    expect(sessions.compareDocumentPosition(navigation) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'Capabilities' }))
    expect(onNavigate).toHaveBeenCalledWith('capabilities')
    expect(onClose).toHaveBeenCalledOnce()

    expect(screen.queryByRole('button', { name: 'Automations' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    expect(onOpenModel).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('keeps the new-session action, session rows, and pagination inside the session-list scroll region', () => {
    $sessionsHasMore.set(true)
    renderNavigationPage()

    const sessionList = screen.getByRole('region', { name: 'Sessions' })
    expect(sessionList.contains(screen.getByRole('button', { name: 'New session' }))).toBe(true)
    expect(sessionList.contains(screen.getByRole('button', { name: /^Planning session/ }))).toBe(true)
    expect(sessionList.contains(screen.getByRole('button', { name: 'Load more sessions' }))).toBe(true)
    expect(sessionList.contains(screen.getByRole('textbox', { name: 'Search loaded titles' }))).toBe(false)
    expect(sessionList.contains(screen.getByRole('button', { name: 'Open bot chat' }))).toBe(false)
    expect(sessionList.contains(screen.getByRole('button', { name: 'Capabilities' }))).toBe(false)
    expect(sessionList.contains(screen.getByRole('button', { name: 'Capabilities' }))).toBe(false)
  })

  it('filters session titles only and keeps the query while closed', () => {
    const controller = controllerStub()
    const { rerender } = renderNavigationPage(controller)
    const search = screen.getByRole<HTMLInputElement>('textbox', { name: 'Search loaded titles' })
    fireEvent.change(search, { target: { value: 'release' } })

    expect(screen.queryByText('Planning session')).toBeNull()
    expect(screen.getByText('Release notes')).not.toBeNull()
    expect(screen.getByText('Other hidden body')).not.toBeNull()
    fireEvent.change(search, { target: { value: 'Other hidden body' } })
    expect(screen.queryByText('Release notes')).toBeNull()
    fireEvent.change(search, { target: { value: 'release' } })

    rerender(<SessionsMenu controller={controller} onDismissRequest={() => undefined} open={false} />)
    rerender(<SessionsMenu controller={controller} onDismissRequest={() => undefined} open />)
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Search loaded titles' }).value).toBe('release')
  })

  it('loads more sessions only when the bounded page reports more', () => {
    const controller = controllerStub()
    $sessionsHasMore.set(true)
    const { rerender } = renderNavigationPage(controller)

    fireEvent.click(screen.getByRole('button', { name: 'Load more sessions' }))
    expect(controller.loadMoreSessions).toHaveBeenCalledOnce()

    $sessionsLoadingMore.set(true)
    rerender(<SessionsMenu controller={controller} onDismissRequest={() => undefined} open />)
    expect(screen.getByRole('button', { name: 'Loading more…' }).getAttribute('aria-disabled')).toBe('true')
  })

  it('marks and opens the active durable session without resuming it', () => {
    const { controller, onClose, onNavigate } = renderNavigationPage()
    const active = screen.getByRole('button', { name: /^Planning session/ })
    expect(active.getAttribute('aria-current')).toBe('page')

    fireEvent.click(active)
    expect(controller.resumeSession).not.toHaveBeenCalled()
    expect(onNavigate).toHaveBeenCalledWith('sessions')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('waits for resume before navigating and closing', async () => {
    const controller = controllerStub()
    const resume = deferred<SelectionOutcome | undefined>()
    vi.mocked(controller.resumeSession).mockReturnValue(resume.promise)
    const { onClose, onNavigate } = renderNavigationPage(controller)

    fireEvent.click(screen.getByRole('button', { name: /^Release notes/ }))
    expect(controller.resumeSession).toHaveBeenCalledWith('session-2')
    expect(onNavigate).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    act(() => $chat.set({ ...emptyChatState(), storedSessionId: 'session-2' }))
    resume.resolve(selected('session-2'))
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('sessions'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('waits for new-session creation and disables competing session actions', async () => {
    const controller = controllerStub()
    const creation = deferred<SelectionOutcome | undefined>()
    vi.mocked(controller.newSession).mockReturnValue(creation.promise)
    const { onClose, onNavigate } = renderNavigationPage(controller)

    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /^Release notes/ }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /^Release notes/ }))
    expect(controller.resumeSession).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    creation.resolve(selected('created'))
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('sessions'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it.each([
    ['resume', 'resumeSession', /^Release notes/, 'resume failed'],
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

  it('does not dismiss a reopened menu for an old action completion', async () => {
    const controller = controllerStub()
    const resume = deferred<SelectionOutcome | undefined>()
    vi.mocked(controller.resumeSession).mockReturnValue(resume.promise)
    const { rerender, onDismissRequest } = renderNavigationPage(controller)
    fireEvent.click(screen.getByRole('button', { name: /^Release notes/ }))
    rerender(<SessionsMenu controller={controller} onDismissRequest={onDismissRequest} open={false} />)
    rerender(<SessionsMenu controller={controller} onDismissRequest={onDismissRequest} open />)
    act(() => $chat.set({ ...emptyChatState(), storedSessionId: 'session-2' }))
    await act(async () => resume.resolve(selected('session-2')))
    expect(onDismissRequest).not.toHaveBeenCalled()
  })

  it('does not dismiss after a superseded remote resume', async () => {
    const controller = controllerStub()
    vi.mocked(controller.resumeSession).mockResolvedValue(undefined)
    const { onDismissRequest } = renderNavigationPage(controller)
    fireEvent.click(screen.getByRole('button', { name: /^Release notes/ }))
    await act(async () => { await Promise.resolve() })
    expect(onDismissRequest).not.toHaveBeenCalled()
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

  it('offers explicit search expansion and never uses preview text as a match', async () => {
    $sessionsHasMore.set(true)
    const controller = controllerStub()
    const page = deferred()
    vi.mocked(controller.loadMoreSessions).mockReturnValue(page.promise)
    renderNavigationPage(controller)
    const search = screen.getByRole('textbox', { name: 'Search loaded titles' })
    fireEvent.change(search, { target: { value: 'older' } })
    expect(await screen.findByText('No matching loaded titles. Load more sessions to look further.')).not.toBeNull()
    expect(screen.getByText(/not message contents or archived chats/)).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Load more sessions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Load more sessions' }))
    expect(controller.loadMoreSessions).toHaveBeenCalledOnce()
    act(() => $sessions.set([...$sessions.get(), { id: 'old', title: 'Older match', started_at: 1, source: 'mobile', preview: '<script>literal</script>', message_count: 9 }]))
    page.resolve()
    await screen.findByText('Older match')
    expect((search as HTMLInputElement).value).toBe('older')
    expect(screen.getByText('<script>literal</script>')).not.toBeNull()
  })

  it('clears the query and stale local feedback when the profile changes', async () => {
    const controller = controllerStub()
    const delayed = deferred()
    vi.mocked(controller.loadMoreSessions).mockReturnValue(delayed.promise)
    $sessionsHasMore.set(true)
    renderNavigationPage(controller)
    fireEvent.change(screen.getByRole('textbox', { name: 'Search loaded titles' }), { target: { value: 'secret title' } })
    fireEvent.click(screen.getByRole('button', { name: 'Load more sessions' }))
    act(() => $preferences.set({ ...$preferences.get(), profile: 'other' }))
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Search loaded titles' }).value).toBe('')
    delayed.reject(new Error('old scope failure'))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByText('old scope failure')).toBeNull()
  })

  it('retires an observer when search begins, including an already queued callback', async () => {
    const observers: Array<{ notify(): void; disconnect: ReturnType<typeof vi.fn> }> = []
    vi.stubGlobal('IntersectionObserver', class {
      disconnect = vi.fn()
      observe() {}
      constructor(callback: IntersectionObserverCallback) {
        observers.push({ notify: () => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver), disconnect: this.disconnect })
      }
    })
    $sessionsHasMore.set(true)
    const { controller } = renderNavigationPage()
    await waitFor(() => expect(observers.length).toBeGreaterThan(0))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search loaded titles' }), { target: { value: 'missing' } })
    expect(observers[0].disconnect).toHaveBeenCalled()
    act(() => observers[0].notify())
    expect(controller.loadMoreSessions).not.toHaveBeenCalled()
  })

  it('clears local search and confirmations on a same-owner privacy reset', () => {
    renderNavigationPage()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Planning' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete Planning session' }))
    vi.spyOn(localPrivacy, 'revision').mockReturnValue('reset-discovery')
    act(() => localPrivacy.$reset.set({ owner: draftOwnerKey($draftOwner.get()), revision: 'reset-discovery', external: false }))
    expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('retires loading feedback when connection drops during a menu refresh', async () => {
    const refresh = deferred()
    const controller = controllerStub()
    vi.mocked(controller.refreshSessions).mockReturnValue(refresh.promise)
    renderNavigationPage(controller)
    expect(screen.getByText('Loading sessions…')).not.toBeNull()
    act(() => $connection.set({ ...$connection.get(), phase: 'reconnecting' }))
    expect(screen.queryByText('Loading sessions…')).toBeNull()
    refresh.reject(new Error('retired refresh'))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByText('retired refresh')).toBeNull()
  })

  it('changes to saved-title coverage offline without searching remote rows or clearing the query', () => {
    $sessionsHasMore.set(true)
    renderNavigationPage()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Planning' } })
    act(() => $connection.set({ ...$connection.get(), phase: 'reconnecting' }))
    expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('Planning')
    expect(screen.getByText(/Searches titles saved on this device/)).not.toBeNull()
    expect(screen.queryByRole('button', { name: /^Planning session/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Load more sessions' })).toBeNull()
  })

  it('regroups at local midnight and restores focus to the same session', () => {
    vi.useFakeTimers()
    const date = new Date(2026, 6, 3, 23, 59, 59)
    vi.setSystemTime(date)
    $sessions.set([{ id: 'midnight', title: 'Midnight notes', started_at: date.getTime() / 1000, message_count: 1, source: 'mobile', preview: '' }])
    renderNavigationPage()
    screen.getByRole('button', { name: /^Midnight notes/ }).focus()
    act(() => vi.advanceTimersByTime(1100))
    expect(screen.getByRole('heading', { name: 'Yesterday' })).not.toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Midnight notes/ }))
  })

  it('provides non-gesture delete and archive entry actions', () => {
    const { onDismissRequest } = renderNavigationPage()
    const rail = screen.getByText('Planning session').closest('article')!.querySelector('.session-delete-action button')!
    fireEvent.click(rail)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Planning session' }))
    expect(screen.getByRole('alertdialog')).not.toBeNull()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' })
    expect(onDismissRequest).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Archived chats' }))
    expect(onDismissRequest).toHaveBeenCalledWith({ type: 'archived-chats' })
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
    const { container, rerender } = render(<SessionsMenu controller={controller} onDismissRequest={() => undefined} open={false} />)
    const page = container.querySelector<HTMLElement>('.sessions-menu')!
    expect(page.getAttribute('aria-hidden')).toBe('true')
    expect(page.hasAttribute('inert')).toBe(true)

    rerender(<SessionsMenu controller={controller} onDismissRequest={() => undefined} open />)
    expect(document.activeElement).toBe(screen.getByRole('main', { name: 'Sessions menu' }))
    expect(document.activeElement).not.toBe(screen.getByRole('textbox', { name: 'Search loaded titles' }))
    rerender(<SessionsMenu controller={controller} onDismissRequest={() => undefined} open={false} />)
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})
