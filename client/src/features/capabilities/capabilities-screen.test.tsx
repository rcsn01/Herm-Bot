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
})
