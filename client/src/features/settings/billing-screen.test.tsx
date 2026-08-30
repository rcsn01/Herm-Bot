import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'

vi.mock('~/compat/primitives', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Skeleton: () => <span>Loading</span>,
  Switch: ({ checked, onCheckedChange }: { checked: boolean; onCheckedChange(value: boolean): void }) => <input checked={checked} onChange={event => onCheckedChange(event.target.checked)} type="checkbox" />,
  Textarea: (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />
}))

import { SettingsAdministrationScreen } from './settings-administration-screen'
import { GatewayProvider } from '~/gateway/gateway-context'
import type { GatewayController } from '~/state/gateway-controller'
import { $preferences } from '~/state/store'
import { MemoryGateway } from '~/test/memory-gateway'

const originalPreferences = $preferences.get()

afterEach(() => $preferences.set(originalPreferences))

const controller = {} as GatewayController

describe('BillingSettings', () => {
  it('renders account state and plan options from the gateway account', async () => {
    $preferences.set({ ...originalPreferences, profile: null, remoteURL: 'https://gateway.example' })
    const gateway = new MemoryGateway()
      .handle('billing.state', params => {
        expect(params).toEqual({})
        return { balance_display: '$12.00', can_change_plan: true, logged_in: true, ok: true, org_name: 'Hermes', portal_url: 'https://billing.example', usage: { total_spendable_display: '$10.00' } }
      })
      .handle('subscription.state', params => {
        expect(params).toEqual({})
        return { can_change_plan: true, context: 'personal', current: { cycle_ends_at: null, tier_name: 'Free' }, logged_in: true, ok: true, portal_url: 'https://billing.example', tiers: [{ dollars_per_month_display: '$9', is_current: false, is_enabled: true, monthly_credits: '100', name: 'Starter', tier_id: 'starter' }] }
      })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={queryClient}>
        <GatewayProvider gateway={gateway}>
          <SettingsAdministrationScreen controller={controller} onBack={() => undefined} page="billing" />
        </GatewayProvider>
      </QueryClientProvider>
    )

    expect(await screen.findByText('Billing')).toBeTruthy()
    expect(await screen.findByText('Starter')).toBeTruthy()
    expect(screen.getByText('Manage billing in official portal')).toBeTruthy()
    expect(gateway.calls.filter(call => call.kind === 'rpc').map(call => call.value)).toEqual([{}, {}])
  })
})
