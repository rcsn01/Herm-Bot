import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { GatewayActionRegion } from './gateway-action-region'
import { $connection } from '~/state/store'
afterEach(cleanup)
it('makes remote content inert while nearby navigation remains usable', () => {
  $connection.set({ ...$connection.get(), phase: 'error' })
  render(<><button>Back</button><GatewayActionRegion><input aria-label="Remote setting" /></GatewayActionRegion></>)
  expect(screen.getByLabelText('Remote setting').closest('[inert]')).not.toBeNull()
  expect(screen.getByRole('button', { name: 'Back' }).closest('[inert]')).toBeNull()
  expect(screen.getByRole('status').textContent).toContain('Reconnect')
})
