import { afterEach, describe, expect, it, vi } from 'vitest'

import { cleanup, render, screen } from '@testing-library/react'

vi.mock('~/compat/primitives', () => ({
  Badge: ({ children }: React.ComponentProps<'span'>) => <span>{children}</span>,
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
  Input: (props: React.ComponentProps<'input'>) => <input {...props} />,
  Switch: ({ onCheckedChange, ...props }: React.ComponentProps<'input'> & { onCheckedChange(value: boolean): void }) => <input {...props} onChange={event => onCheckedChange(event.target.checked)} role="switch" type="checkbox" />
}))

import { SettingsScreen } from './settings-screen'
import { ROOT_ROUTES } from '~/navigation/routes'
import { applyPathState, resetNavigation } from '~/navigation/navigation-store'
import { useWorkspaceNavigation } from '~/navigation/use-workspace-navigation'
import { resetWorkspacePolicy } from '~/navigation/workspace-navigation'
import type { GatewayController } from '~/state/gateway-controller'
import { $connection, $preferences } from '~/state/store'

afterEach(cleanup)

const controllerStub = () => ({}) as unknown as GatewayController

beforeEachSetup()

function beforeEachSetup() {
  resetNavigation()
  resetWorkspacePolicy()
  $preferences.set({ authMode: 'token', profile: null, remoteURL: 'https://gateway.test', theme: 'system' })
  $connection.set({ ...$connection.get(), authMode: 'token', error: null, phase: 'connected', status: { profiles: ['default'] } as never })
}

function Harness({ controller }: { controller: GatewayController }) {
  const workspace = useWorkspaceNavigation()
  return <SettingsScreen controller={controller} workspace={workspace.screen('settings')} />
}

it('renders Privacy as a local category without gateway access during interruptions', () => {
  beforeEachSetup()
  $connection.set({ ...$connection.get(), phase: 'error', errorKind: 'network', workspaceAvailable: true })
  applyPathState('settings', [ROOT_ROUTES.settings, { type: 'settings-category', tab: 'settings', category: 'privacy' }])
  const controller = { privacyClearBlocker: () => null, clearLocalData: vi.fn() } as unknown as GatewayController
  const { container } = render(<Harness controller={controller} />)
  expect(screen.getByRole('heading', { name: 'Privacy' })).toBeTruthy()
  expect(screen.getByRole('switch', { name: 'Save conversation history on this device' })).toBeTruthy()
  expect(container.querySelector('fieldset[disabled]')).toBeNull()
  resetNavigation()
})

describe('root settings page chrome', () => {
  it('leaves the title and back navigation to the top bar', () => {
    const { container } = render(<Harness controller={controllerStub()} />)

    // The top bar owns the "Settings" title and the back chevron; the page
    // body must not repeat either. The store rests on the roster, so the
    // screen api narrows to the settings root.
    expect(container.querySelector('.page-heading')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Back to chat' })).toBeNull()
    expect(screen.getByText('Profile defaults, mobile preferences, and gateway administration.')).not.toBeNull()
  })
})