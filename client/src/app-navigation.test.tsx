import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const controller = vi.hoisted(() => ({
  deleteSession: vi.fn().mockResolvedValue(undefined),
  dispose: vi.fn(),
  gateway: {},
  initialize: vi.fn().mockResolvedValue(undefined),
  newSession: vi.fn().mockResolvedValue(undefined),
  reconcileHistory: vi.fn().mockResolvedValue(undefined),
  refreshSessions: vi.fn().mockResolvedValue(undefined),
  resumeSession: vi.fn().mockResolvedValue(undefined),
  switchProfile: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('~/compat/primitives', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
  Input: (props: React.ComponentProps<'input'>) => <input {...props} />
}))
vi.mock('~/state/gateway-controller', async importOriginal => {
  const original = await importOriginal<typeof import('~/state/gateway-controller')>()
  return { ...original, GatewayController: class { constructor() { return controller } } }
})
vi.mock('~/native/deep-links', () => ({ observeHermesDeepLinks: () => () => undefined }))
vi.mock('~/components/chat-screen', async () => {
  const { useRef } = await import('react')
  let nextId = 0
  return { ChatScreen: () => { const id = useRef(++nextId); return <div data-testid="chat-instance">Chat {id.current}</div> } }
})
vi.mock('~/components/settings-screen', () => ({
  applyTheme: vi.fn(),
  SettingsScreen: () => <div>Settings detail</div>
}))
vi.mock('~/features/capabilities/capabilities-screen', () => ({ CapabilitiesScreen: () => <div>Capabilities screen</div> }))
vi.mock('~/features/operations/operations-screen', () => ({ OperationsScreen: () => <div>Operations screen</div> }))
vi.mock('~/features/more/more-screen', () => ({ MoreScreen: ({ onSelect }: { onSelect(id: 'settings'): void }) => <div>More hub<button onClick={() => onSelect('settings')}>Settings</button></div> }))
vi.mock('~/features/shared/remote-resource', () => ({ RemoteResourceScreen: () => <div>Remote resource</div> }))
vi.mock('~/components/files-screen', () => ({ FilesScreen: () => <div>Projects</div> }))

import { App } from '~/app'
import { emptyChatState } from '~/state/event-reducer'
import { resetNavigation } from '~/navigation/navigation-store'
import { $chat, $connection, $preferences, $sessions } from '~/state/store'

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  resetNavigation()
  $connection.set({ authMode: 'token', error: null, phase: 'connected', status: null })
  $preferences.set({ authMode: 'token', profile: null, remoteURL: 'https://gateway.test', theme: 'system' })
  $chat.set({ ...emptyChatState(), info: { model: 'provider/test-model', title: 'Current chat' } as never, runtimeSessionId: 'runtime-1' })
  $sessions.set([])
})

function openDrawer() {
  fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }))
}

describe('App navigation', () => {
  it('opens the drawer from the menu button and has no bottom navigation', () => {
    render(<App />)
    const menu = screen.getByRole('button', { name: 'Open navigation' })
    expect(menu.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(menu)
    expect(menu.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('dialog', { name: 'Navigation' })).not.toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull()
  })

  it('switches primary destinations and closes the drawer', () => {
    render(<App />)
    openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Capabilities' }))

    expect(screen.getByText('Capabilities screen')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Open navigation' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps the More stack and reaches Settings through the More hub', () => {
    render(<App />)
    openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getByText('More hub')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByText('Settings detail')).not.toBeNull()

    openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Capabilities' }))
    openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getByText('Settings detail')).not.toBeNull()
  })

  it('keeps the active ChatScreen instance through drawer toggles and destination round trips', () => {
    render(<App />)
    const chat = screen.getByTestId('chat-instance')
    expect(chat.textContent).toContain('Chat')

    openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Close navigation' }))
    expect(screen.getByTestId('chat-instance')).toBe(chat)

    openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Operations' }))
    openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }))
    expect(screen.getByTestId('chat-instance')).toBe(chat)
  })

  it('shows the connected active chat immediately and keeps the model badge Settings shortcut', () => {
    render(<App />)
    expect(screen.getByTestId('chat-instance')).not.toBeNull()
    expect(screen.getByTestId('side-navigation-backdrop').getAttribute('aria-hidden')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    expect(screen.getByText('Settings detail')).not.toBeNull()
  })
})
