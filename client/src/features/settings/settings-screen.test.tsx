import { afterEach, describe, expect, it, vi } from 'vitest'

import { cleanup, render, screen } from '@testing-library/react'

vi.mock('~/compat/primitives', () => ({
  Badge: ({ children }: React.ComponentProps<'span'>) => <span>{children}</span>,
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
  Input: (props: React.ComponentProps<'input'>) => <input {...props} />
}))

import { SettingsScreen } from './settings-screen'
import { resetNavigation } from '~/navigation/navigation-store'
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
  $connection.set({ authMode: 'token', error: null, phase: 'connected', status: { profiles: ['default'] } as never })
}

function Harness({ controller }: { controller: GatewayController }) {
  const workspace = useWorkspaceNavigation()
  return <SettingsScreen controller={controller} workspace={workspace.screen('settings')} />
}

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