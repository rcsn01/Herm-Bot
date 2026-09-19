import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CapabilitiesScreen } from '~/features/capabilities/capabilities-screen'
import { $navigation, resetNavigation } from '~/navigation/navigation-store'
import { ROOT_ROUTES } from '~/navigation/routes'
import { useWorkspaceNavigation } from '~/navigation/use-workspace-navigation'
import { resetWorkspacePolicy } from '~/navigation/workspace-navigation'

vi.mock('~/compat/primitives', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({ children, ...props }: ComponentProps<'button'>) => <button {...props}>{children}</button>
}))

beforeEach(() => {
  resetNavigation()
  resetWorkspacePolicy()
})

afterEach(() => cleanup())

function Harness() {
  const workspace = useWorkspaceNavigation()
  return <CapabilitiesScreen workspace={workspace.screen('capabilities')} />
}

describe('CapabilitiesScreen', () => {
  it('contains only Skills, Tools, and MCP at the capabilities root', () => {
    // The store rests on the roster, so the screen api narrows to the
    // capabilities root.
    render(<Harness />)

    expect(screen.queryByRole('heading', { name: 'Capabilities' })).toBeNull()
    expect(screen.queryByText('Profile scoped')).toBeNull()
    expect(screen.getByRole('button', { name: /^Skills/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Tools/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^MCP/ })).toBeTruthy()
    expect(screen.queryByText('Models')).toBeNull()
    expect(screen.queryByText('Providers')).toBeNull()
    expect(screen.queryByText('Credentials')).toBeNull()
  })

  it('navigates to a selected capabilities section through the workspace stack', () => {
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: /^MCP/ }))
    expect($navigation.get().stacks.capabilities).toEqual([
      ROOT_ROUTES.capabilities,
      { section: 'mcp', tab: 'capabilities', type: 'capabilities-section' }
    ])
  })
})