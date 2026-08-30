import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CapabilitiesScreen } from '~/features/capabilities/capabilities-screen'

vi.mock('~/compat/primitives', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>
}))

afterEach(() => cleanup())

describe('CapabilitiesScreen', () => {
  it('contains only Skills, Tools, and MCP at the capabilities root', () => {
    render(<CapabilitiesScreen onBack={vi.fn()} onNavigate={vi.fn()} route={{ tab: 'capabilities', type: 'capabilities-root' }} />)

    expect(screen.getByRole('heading', { name: 'Capabilities' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Skills/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Tools/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^MCP/ })).toBeTruthy()
    expect(screen.queryByText('Models')).toBeNull()
    expect(screen.queryByText('Providers')).toBeNull()
    expect(screen.queryByText('Credentials')).toBeNull()
  })

  it('navigates to a selected capabilities section', () => {
    const onNavigate = vi.fn()
    render(<CapabilitiesScreen onBack={vi.fn()} onNavigate={onNavigate} route={{ tab: 'capabilities', type: 'capabilities-root' }} />)

    fireEvent.click(screen.getByRole('button', { name: /^MCP/ }))
    expect(onNavigate).toHaveBeenLastCalledWith({ section: 'mcp', tab: 'capabilities', type: 'capabilities-section' })
  })
})
