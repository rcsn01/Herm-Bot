import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const controller = vi.hoisted(() => ({
  conversation: {
    reconcileHistory: vi.fn().mockResolvedValue(undefined)
  },
  deleteSession: vi.fn().mockResolvedValue(undefined),
  dispose: vi.fn(),
  gateway: {},
  initialize: vi.fn().mockResolvedValue(undefined),
  newSession: vi.fn().mockResolvedValue(undefined),
  openProfile: vi.fn().mockResolvedValue(undefined),
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
vi.mock('~/features/agents/roster-screen', () => ({
  RosterScreen: ({ onOpenAgent }: { onOpenAgent(profile: null | string): void }) => (
    <div>Roster screen
      <button onClick={() => onOpenAgent('work')}>Open agent work</button>
      <button onClick={() => onOpenAgent(null)}>Open agent default</button>
    </div>
  )
}))
vi.mock('~/features/settings/settings-screen', () => ({
  applyTheme: vi.fn(),
  SettingsScreen: ({ onExit }: { onExit?(): void }) => <div>Settings screen{onExit && <button onClick={onExit}>Settings back</button>}</div>
}))
vi.mock('~/features/capabilities/capabilities-screen', () => ({ CapabilitiesScreen: () => <div>Capabilities screen</div> }))
vi.mock('~/features/cron/cron-screen', () => ({ CronScreen: ({ onOpenSession }: { onOpenSession?(sessionId: string): Promise<void> }) => <div>Cron screen{onOpenSession && <button onClick={() => void onOpenSession('cron-session-1')}>Open run session</button>}</div> }))

import { App } from '~/app'
import { $chat, emptyChatState } from '~/state/conversation'
import { resetNavigation } from '~/navigation/navigation-store'
import { $connection, $preferences, $sessions } from '~/state/store'

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  // The URL is an input now: App restores the screen it describes on mount.
  window.history.replaceState(null, '', '/')
  resetNavigation()
  $connection.set({ authMode: 'token', error: null, phase: 'connected', status: null })
  $preferences.set({ authMode: 'token', profile: null, remoteURL: 'https://gateway.test', theme: 'system' })
  $chat.set({ ...emptyChatState(), info: { model: 'provider/test-model', title: 'Current chat' } as never, runtimeSessionId: 'runtime-1' })
  $sessions.set([])
})

function openDrawer() {
  fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }))
}

async function enterAgent(buttonName: 'Open agent work' | 'Open agent default' = 'Open agent default') {
  fireEvent.click(screen.getByRole('button', { name: buttonName }))
  await act(async () => undefined)
}

describe('App navigation', () => {
  it('launches on the agent roster with settings access and no side navigation', () => {
    render(<App />)

    expect(screen.getByText('Roster screen')).not.toBeNull()
    expect(screen.getByRole('searchbox', { name: 'Search bots' })).not.toBeNull()
    expect(screen.getByTestId('chat-instance')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Open navigation' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open bot profile' })).toBeNull()
    expect(screen.queryByTestId('side-navigation-backdrop')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open settings' })).not.toBeNull()
  })

  it('enters the tapped agent latest conversation', async () => {
    render(<App />)

    await enterAgent('Open agent work')

    expect(controller.openProfile).toHaveBeenCalledWith('work')
    expect(screen.queryByText('Roster screen')).toBeNull()
    expect(screen.getByTestId('chat-instance')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Open navigation' })).not.toBeNull()
  })

  it('titles the messaging header with the profile name and the session beneath', async () => {
    // the real openProfile flow persists the switched profile
    $preferences.set({ authMode: 'token', profile: 'work', remoteURL: 'https://gateway.test', theme: 'system' })
    const { container } = render(<App />)

    await enterAgent('Open agent work')

    const header = container.querySelector('.header-bot-button')!
    expect(header.querySelector('strong')?.textContent).toBe('Work')
    expect(header.querySelector('small')?.textContent).toBe('Current chat')
  })

  it('titles the messaging header Hermes for the default profile', async () => {
    const { container } = render(<App />)

    await enterAgent('Open agent default')

    const header = container.querySelector('.header-bot-button')!
    expect(header.querySelector('strong')?.textContent).toBe('Hermes')
    expect(header.querySelector('small')?.textContent).toBe('Current chat')
  })

  it('returns to the roster from the header back button', async () => {
    render(<App />)
    expect(screen.queryByRole('button', { name: 'Back to bots' })).toBeNull()

    await enterAgent()
    expect(screen.getByRole('button', { name: 'Back to bots' })).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Back to bots' }))
    // In-app back rides history.back(); the popstate lands in a later task.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    expect(screen.getByText('Roster screen')).not.toBeNull()
    expect(screen.getByRole('searchbox', { name: 'Search bots' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Back to bots' })).toBeNull()
    expect(screen.getByTestId('chat-instance')).not.toBeNull()
  })

  it('opens the drawer only inside a profile', async () => {
    render(<App />)
    expect(screen.queryByRole('button', { name: 'Open navigation' })).toBeNull()

    await enterAgent()
    openDrawer()

    expect(screen.getByRole('dialog', { name: 'Navigation' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Capabilities' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Cron Jobs' })).not.toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Capabilities' }))
    expect(screen.getByText('Capabilities screen')).not.toBeNull()
  })

  it('opens Settings from the main screen header button and returns to the roster', () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    expect(screen.getByText('Settings screen')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Open navigation' }).getAttribute('aria-expanded')).toBe('false')

    // The top bar owns settings exit: its chevron returns to the bots roster.
    fireEvent.click(screen.getByRole('button', { name: 'Back to bots' }))
    expect(screen.getByText('Roster screen')).not.toBeNull()
  })

  it('keeps settings reachable only from the main screen', async () => {
    render(<App />)
    expect(screen.getByRole('button', { name: 'Open settings' })).not.toBeNull()

    await enterAgent()
    expect(screen.queryByRole('button', { name: 'Open settings' })).toBeNull()

    openDrawer()
    expect(screen.queryByRole('button', { name: 'Open settings' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    expect(screen.getByText('Settings screen')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Open settings' })).toBeNull()
  })

  it('reaches Capabilities and Cron Jobs from the side navigation', async () => {
    render(<App />)

    await enterAgent()
    openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Capabilities' }))
    expect(screen.getByText('Capabilities screen')).not.toBeNull()

    openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Cron Jobs' }))
    expect(screen.getByText('Cron screen')).not.toBeNull()
  })

  it('opens model settings from the side navigation and returns to the chat', async () => {
    render(<App />)

    await enterAgent()
    openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    expect(screen.getByText('Settings screen')).not.toBeNull()

    // With no in-page exit left, the drawer's bot identity returns to the chat.
    openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Open bot chat' }))
    expect(screen.getByTestId('chat-instance')).not.toBeNull()
  })

  it('resumes a cron run session and returns to chat', async () => {
    render(<App />)

    await enterAgent()
    openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Cron Jobs' }))

    fireEvent.click(screen.getByRole('button', { name: 'Open run session' }))

    await act(async () => undefined)
    expect(controller.resumeSession).toHaveBeenCalledWith('cron-session-1')
    expect(screen.queryByText('Cron screen')).toBeNull()
    expect(screen.getByTestId('chat-instance')).not.toBeNull()
  })

  it('keeps the active ChatScreen instance through drawer toggles and destination round trips', async () => {
    render(<App />)
    await enterAgent()
    const chat = screen.getByTestId('chat-instance')

    openDrawer()
    fireEvent.click(screen.getByTestId('side-navigation-backdrop'))
    expect(screen.getByTestId('chat-instance')).toBe(chat)

    openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Cron Jobs' }))
    openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Open bot chat' }))
    expect(screen.getByTestId('chat-instance')).toBe(chat)
  })

  it('keeps the cached chat shell mounted while reconnecting an existing session', () => {
    $connection.set({ ...$connection.get(), phase: 'reconnecting' })

    render(<App />)

    expect(screen.getByTestId('chat-instance')).not.toBeNull()
    expect(screen.queryByRole('heading', { name: 'Hermes Mobile' })).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Reconnecting')
  })

  it('restores interaction without remounting chat after reconnect succeeds', () => {
    $connection.set({ ...$connection.get(), phase: 'reconnecting' })
    const view = render(<App />)
    const chat = screen.getByTestId('chat-instance')

    act(() => {
      $connection.set({ ...$connection.get(), phase: 'connected' })
    })

    expect(screen.getByTestId('chat-instance')).toBe(chat)
    expect(screen.queryByRole('status')).toBeNull()
    expect(view.container.querySelector('.mobile-shell')?.getAttribute('aria-busy')).toBe('false')
  })

  it('shows a neutral startup screen while connecting instead of flashing login', () => {
    $connection.set({ ...$connection.get(), phase: 'connecting' })

    render(<App />)

    expect(screen.queryByTestId('chat-instance')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Hermes Mobile' })).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Connecting…')
  })

  it('shows the startup screen while reconnecting without a cached session', () => {
    $connection.set({ ...$connection.get(), phase: 'reconnecting' })
    $chat.set(emptyChatState())

    render(<App />)

    expect(screen.queryByTestId('chat-instance')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Hermes Mobile' })).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Connecting…')
  })

  it('does not show cached chat after an unexpected disconnect', () => {
    $connection.set({ ...$connection.get(), phase: 'disconnected' })

    render(<App />)

    expect(screen.queryByTestId('chat-instance')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Hermes Mobile' })).not.toBeNull()
  })
})