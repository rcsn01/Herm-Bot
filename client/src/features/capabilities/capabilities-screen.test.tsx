import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { capabilityById } from '~/features/capabilities/api'
import { CapabilitiesScreen } from '~/features/capabilities/capabilities-screen'

vi.mock('~/compat/primitives', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>
}))
vi.mock('~/features/shared/remote-resource', () => ({
  RemoteResourceScreen: () => <div>Remote resource</div>
}))
vi.mock('~/features/models/models-screen', () => ({
  ModelsScreen: () => <div>Dedicated models screen</div>
}))

describe('CapabilitiesScreen', () => {
  it('presents providers and credentials as separate destinations', () => {
    const onSelect = vi.fn()
    render(<CapabilitiesScreen onBack={vi.fn()} onSelect={onSelect} />)

    const providers = screen.getByRole('button', { name: /^Providers/ })
    const credentials = screen.getByRole('button', { name: /^Credentials/ })

    fireEvent.click(providers)
    expect(onSelect).toHaveBeenLastCalledWith('providers')

    fireEvent.click(credentials)
    expect(onSelect).toHaveBeenLastCalledWith('credentials')

    expect(capabilityById('providers')?.path).toBe('/api/model/info')
    expect(capabilityById('credentials')?.path).toBe('/api/env')
  })

  it('routes Models to the dedicated screen while Providers stays a generic resource', () => {
    const { rerender } = render(<CapabilitiesScreen selected="models" onBack={vi.fn()} onSelect={vi.fn()} />)

    expect(screen.getByText('Dedicated models screen')).not.toBeNull()
    expect(screen.queryByText('Remote resource')).toBeNull()

    rerender(<CapabilitiesScreen selected="providers" onBack={vi.fn()} onSelect={vi.fn()} />)

    expect(screen.getByText('Remote resource')).not.toBeNull()
    expect(screen.queryByText('Dedicated models screen')).toBeNull()
  })
})