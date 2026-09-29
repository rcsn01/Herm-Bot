import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const createProfileDialogProps = vi.hoisted(() => vi.fn())

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
  RosterScreen: ({ onManageAgent, onOpenAgent }: { onManageAgent?(agent: { isDefault: boolean; name: string }): void; onOpenAgent(profile: null | string): void }) => (
    <div>Roster screen
      <button onClick={() => onOpenAgent('work')}>Open agent work</button>
      <button onClick={() => onOpenAgent(null)}>Open agent default</button>
      <button onClick={() => onManageAgent?.({
        avatar: 'data:image/png;base64,AA==',
        description: 'Operator',
        isDefault: false,
        meta: { color: '#3b82f6', shape: 'circle', title: 'Work' },
        name: 'work'
      } as never)}>Manage work</button>
    </div>
  )
}))
vi.mock('~/features/agents/create-profile-dialog', () => ({
  CreateProfileDialog: (props: unknown) => { createProfileDialogProps(props); return <div data-testid="create-profile-dialog" /> }
}))
vi.mock('~/features/groups/group-screen', () => ({
  GroupChatScreen: ({ roomId }: { roomId: string }) => <div data-testid="group-instance">Group {roomId}</div>
}))
vi.mock('~/features/settings/settings-screen', () => ({
  applyTheme: vi.fn(),
  SettingsScreen: ({ onExit }: { onExit?(): void }) => <div>Settings screen{onExit && <button onClick={onExit}>Settings back</button>}</div>
}))
vi.mock('~/features/capabilities/capabilities-screen', () => ({ CapabilitiesScreen: () => <div>Capabilities screen</div> }))
vi.mock('~/features/cron/cron-screen', () => ({ CronScreen: ({ onOpenSession }: { onOpenSession?(sessionId: string): Promise<void> }) => <div>Cron screen{onOpenSession && <button onClick={() => void onOpenSession('cron-session-1')}>Open run session</button>}</div> }))

import { App } from '~/app'
import { $chat, emptyChatState, reduceGatewayEvent } from '~/state/conversation'
import { publishRosterRooms, resetKnownRooms } from '~/features/groups/known-rooms'
import { resetNavigation } from '~/navigation/navigation-store'
import { resetWorkspacePolicy } from '~/navigation/workspace-navigation'
import { $connection, $preferences, $profileSwitching, $sessions } from '~/state/store'

afterEach(() => {
  cleanup()
  resetKnownRooms()
})

beforeEach(() => {
  resetKnownRooms()
  vi.clearAllMocks()
  // clearAllMocks drops resolved-value setups; restore the defaults.
  controller.openProfile.mockResolvedValue(undefined)
  // The URL is an optional cold-start input; runtime routes stay in memory.
  window.history.replaceState(null, '', '/')
  resetNavigation()
  // A stale open menu latch would render SessionsMenu over the app shell.
  resetWorkspacePolicy()
  $connection.set({ authMode: 'token', error: null, phase: 'connected', status: null })
  $preferences.set({ authMode: 'token', profile: null, remoteURL: 'https://gateway.test', theme: 'system' })
  $chat.set({ ...emptyChatState(), info: { running: false, title: 'Current chat', usage: null }, runtimeSessionId: 'runtime-1' })
  $sessions.set([])
  $profileSwitching.set(false)
})

function openNavigationPage() {
  fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }))
}

async function enterAgent(buttonName: 'Open agent work' | 'Open agent default' = 'Open agent default') {
  fireEvent.click(screen.getByRole('button', { name: buttonName }))
  await act(async () => undefined)
}

async function settleNavigation(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('sessions-menu').getAttribute('aria-hidden')).toBe('true'))
}

function expectBotConfigurationHeader(container: HTMLElement, section: string) {
  const header = container.querySelector('.foreground-layer .header-bot-button')!
  expect(header.querySelector('strong')?.textContent).toBe('Hermes')
  expect(header.querySelector('small')?.textContent).toBe(section)
}

describe('App navigation', () => {
  it('launches on the agent roster with settings access and no side navigation', () => {
    render(<App />)

    expect(screen.getByText('Roster screen')).not.toBeNull()
    expect(screen.getByRole('searchbox', { name: 'Search bots' })).not.toBeNull()
    expect(screen.getByTestId('chat-instance')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Open navigation' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open bot profile' })).toBeNull()
    expect(screen.queryByTestId('sessions-menu')).toBeNull()
    expect(screen.getByRole('button', { name: 'Create profile' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Open settings' })).not.toBeNull()
  })

  it('offers bot and group creation from the roster action', () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }))
    const dialog = screen.getByRole('dialog', { name: 'Create new' })
    expect(within(dialog).getByRole('button', { name: 'New bot' })).not.toBeNull()
    expect(within(dialog).getByRole('button', { name: 'New group chat' })).not.toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Create new' })).toBeNull()
  })

  it('passes one duplicate seed with the hydrated roster metadata', () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Manage work' }))
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate profile' }))

    expect(screen.getByTestId('create-profile-dialog')).not.toBeNull()
    expect(createProfileDialogProps).toHaveBeenLastCalledWith(expect.objectContaining({
      seed: {
        cloneAll: true,
        cloneFrom: 'work',
        color: '#3b82f6',
        description: 'Operator',
        image: 'data:image/png;base64,AA==',
        name: 'work-2',
        shape: 'circle',
        title: 'Work (copy)'
      }
    }))
  })

  it('enters the tapped agent latest conversation', async () => {
    render(<App />)

    await enterAgent('Open agent work')

    expect(controller.openProfile).toHaveBeenCalledWith('work')
    expect(screen.getByText('Roster screen').closest('.roster-layer')?.getAttribute('aria-hidden')).toBe('true')
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

  it.each([
    { name: 'empty', title: '' },
    { name: 'non-string', title: 42 }
  ])('uses the New conversation header fallback for a $name title', async ({ title }) => {
    const info = reduceGatewayEvent($chat.get(), {
      type: 'session.info', session_id: 'runtime-1', payload: { title }
    })
    $chat.set(info)
    const { container } = render(<App />)

    await enterAgent()

    expect(container.querySelector('.header-bot-button small')?.textContent).toBe('New conversation')
  })

  it('opens a desktop group chat from its URL with the top bar owning back and title', () => {
    window.history.replaceState(null, '', '/group/id%3Ar-crew')
    const { container } = render(<App />)

    expect(screen.getByTestId('group-instance')).not.toBeNull()
    expect(container.querySelector('.header-title strong')?.textContent).toBe('Group chat')

    // once the roster snapshot lands, the room name replaces the fallback.
    // Keep the fixture gateway-shaped: empty-log rooms are filtered upstream.
    act(() => publishRosterRooms([{
      key: 'id:r-crew',
      log: [{ at: 1_700_000_000_000, from: { kind: 'user', name: 'You' }, text: 'Research notes' }],
      members: [{ name: 'default' }],
      name: 'Research crew',
      roomId: 'r-crew'
    }]))
    expect(container.querySelector('.header-title strong')?.textContent).toBe('Research crew')

    fireEvent.click(screen.getByRole('button', { name: 'Back to bots' }))
    expect(screen.getByText('Roster screen')).not.toBeNull()
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

    expect(screen.getByText('Roster screen')).not.toBeNull()
    expect(screen.getByRole('searchbox', { name: 'Search bots' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Back to bots' })).toBeNull()
    expect(screen.getByTestId('chat-instance')).not.toBeNull()
  })

  it('opens the navigation page only inside a profile', async () => {
    const { container } = render(<App />)
    expect(screen.queryByRole('button', { name: 'Open navigation' })).toBeNull()

    await enterAgent()
    openNavigationPage()

    expect(window.location.pathname).toBe('/')
    expect(screen.getByRole('main', { name: 'Sessions menu' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Back' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Models' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Capabilities' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Automations' })).not.toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Capabilities' }))
    await settleNavigation()
    expect(screen.getByText('Capabilities screen')).not.toBeNull()
    expectBotConfigurationHeader(container, 'Capabilities')
    expect(screen.getByRole('button', { name: 'Back to menu' })).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Back to menu' }))
    expect(screen.getByRole('main', { name: 'Sessions menu' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByTestId('chat-instance')).not.toBeNull()
  })

  it('closes the navigation page from its back button without changing the current screen', async () => {
    render(<App />)
    await enterAgent()
    openNavigationPage()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await settleNavigation()

    expect(screen.getByTestId('chat-instance')).not.toBeNull()
    expect(screen.getByTestId('sessions-menu').getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByRole('button', { name: 'Open navigation' }).getAttribute('aria-expanded')).toBe('false')
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

    openNavigationPage()
    expect(screen.queryByRole('button', { name: 'Open settings' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    await settleNavigation()
    expect(screen.getByText('Settings screen')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Open settings' })).toBeNull()
  })

  it('switches configuration pages through persistent bottom navigation and opens Sessions by default', async () => {
    const { container } = render(<App />)

    await enterAgent()
    openNavigationPage()
    fireEvent.click(screen.getByRole('button', { name: 'Capabilities' }))
    await settleNavigation()
    expect(screen.getByText('Capabilities screen')).not.toBeNull()
    const capabilitiesNavigation = screen.getByRole('navigation', { name: 'Bot workspace' })
    expect(within(capabilitiesNavigation).getByRole('button', { name: 'Capabilities' }).getAttribute('aria-current')).toBe('page')

    fireEvent.click(within(capabilitiesNavigation).getByRole('button', { name: 'Automations' }))
    expect(screen.getByText('Cron screen')).not.toBeNull()
    expectBotConfigurationHeader(container, 'Automations')
    const automationsNavigation = screen.getByRole('navigation', { name: 'Bot workspace' })
    expect(within(automationsNavigation).getByRole('button', { name: 'Automations' }).getAttribute('aria-current')).toBe('page')

    fireEvent.click(within(automationsNavigation).getByRole('button', { name: 'Sessions' }))
    const menu = screen.getByRole('main', { name: 'Sessions menu' })
    expect(within(menu).getByRole('button', { name: 'Sessions' }).getAttribute('aria-current')).toBe('page')
    fireEvent.click(within(menu).getByRole('button', { name: 'Back' }))
    expect(screen.getByText('Cron screen')).not.toBeNull()
  })

  it('opens model settings from the side navigation and returns to the chat', async () => {
    const { container } = render(<App />)

    await enterAgent()
    openNavigationPage()
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    await settleNavigation()
    expect(screen.getByText('Settings screen')).not.toBeNull()
    expectBotConfigurationHeader(container, 'Models')
    expect(screen.getByRole('button', { name: 'Back to menu' })).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Back to menu' }))
    expect(screen.getByRole('main', { name: 'Sessions menu' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByTestId('chat-instance')).not.toBeNull()

    // The sessions menu's bot identity also returns to the chat.
    openNavigationPage()
    fireEvent.click(screen.getByRole('button', { name: 'Open bot chat' }))
    await settleNavigation()
    expect(screen.getByTestId('chat-instance')).not.toBeNull()
  })

  it('resumes a cron run session and returns to chat', async () => {
    render(<App />)

    await enterAgent()
    openNavigationPage()
    fireEvent.click(screen.getByRole('button', { name: 'Automations' }))
    await settleNavigation()

    fireEvent.click(screen.getByRole('button', { name: 'Open run session' }))

    await act(async () => undefined)
    expect(controller.resumeSession).toHaveBeenCalledWith('cron-session-1')
    expect(screen.queryByText('Cron screen')).toBeNull()
    expect(screen.getByTestId('chat-instance')).not.toBeNull()
  })

  it('enters the tapped agent conversation immediately, while the switch is still connecting', async () => {
    let releaseOpenProfile: (() => void) | null = null
    controller.openProfile.mockImplementation(() => new Promise<void>(resolve => { releaseOpenProfile = resolve }))
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Open agent work' }))
    await act(async () => undefined)

    // The chat shell is up before the profile switch resolves; no full-screen
    // connecting takeover in between.
    expect(screen.getByTestId('chat-instance')).not.toBeNull()
    expect(screen.queryByLabelText('Connecting to Hermes')).toBeNull()
    releaseOpenProfile!()
    await act(async () => undefined)
  })

  it('renders the app shell during a switching connect and the boot takeover otherwise', () => {
    act(() => {
      $connection.set({ authMode: 'token', error: null, phase: 'connecting', status: null })
      $profileSwitching.set(true)
    })
    const { container } = render(<App />)

    expect(screen.getByTestId('chat-instance')).not.toBeNull()
    expect(screen.queryByLabelText('Connecting to Hermes')).toBeNull()

    act(() => { $profileSwitching.set(false) })
    expect(screen.queryByLabelText('Connecting to Hermes')).not.toBeNull()
    expect(container).toBeTruthy()
  })

  it('keeps the active ChatScreen instance through navigation page toggles and destination round trips', async () => {
    render(<App />)
    await enterAgent()
    const chat = screen.getByTestId('chat-instance')

    openNavigationPage()
    fireEvent.keyDown(screen.getByRole('main', { name: 'Sessions menu' }), { key: 'Escape' })
    await settleNavigation()
    expect(screen.getByTestId('chat-instance')).toBe(chat)

    openNavigationPage()
    fireEvent.click(screen.getByRole('button', { name: 'Automations' }))
    await settleNavigation()
    expect(screen.getByText('Cron screen')).not.toBeNull()

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Bot workspace' })).getByRole('button', { name: 'Sessions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open bot chat' }))
    await settleNavigation()
    expect(screen.getByTestId('chat-instance')).toBe(chat)
  })

  it('keeps navigation-page open and close operations out of browser history', async () => {
    render(<App />)
    await enterAgent()
    const beforeLength = window.history.length
    const beforeState = window.history.state
    const back = vi.spyOn(window.history, 'back')

    openNavigationPage()
    expect(window.location.pathname).toBe('/')
    expect(window.history.length).toBe(beforeLength)
    expect(window.history.state).toBe(beforeState)

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await settleNavigation()

    expect(back).not.toHaveBeenCalled()
    expect(screen.getByTestId('sessions-menu').getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByRole('button', { name: 'Open navigation' }).getAttribute('aria-expanded')).toBe('false')
    back.mockRestore()
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