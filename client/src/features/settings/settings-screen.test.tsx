import { describe, expect, it, vi } from 'vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach } from 'vitest'

vi.mock('~/compat/primitives', () => ({
  Badge: ({ children }: React.ComponentProps<'span'>) => <span>{children}</span>,
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
  Input: (props: React.ComponentProps<'input'>) => <input {...props} />
}))

import { SettingsScreen } from './settings-screen'
import type { GatewayController } from '~/state/gateway-controller'
import { $connection, $preferences } from '~/state/store'
import { emptyChatState, $chat } from '~/state/conversation'
import { ROOT_ROUTES } from '~/navigation/routes'

afterEach(cleanup)

const controllerStub = () => ({}) as unknown as GatewayController

beforeEachSetup()

function beforeEachSetup() {
  $preferences.set({ authMode: 'token', profile: null, remoteURL: 'https://gateway.test', theme: 'system' })
  $connection.set({ authMode: 'token', error: null, phase: 'connected', status: { profiles: ['default'] } as never })
}

describe('root settings page chrome', () => {
  it('leaves the title and back navigation to the top bar', () => {
    const { container } = render(
      <SettingsScreen controller={controllerStub()} onBack={vi.fn()} onNavigate={vi.fn()} route={ROOT_ROUTES.settings} />
    )

    // The top bar owns the "Settings" title and the back chevron; the page
    // body must not repeat either.
    expect(container.querySelector('.page-heading')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Back to chat' })).toBeNull()
    expect(screen.getByText('Profile defaults, mobile preferences, and gateway administration.')).not.toBeNull()
  })
})