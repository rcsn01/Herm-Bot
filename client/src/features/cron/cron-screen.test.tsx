import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/compat/primitives', () => ({
  Badge: ({ children }: React.ComponentProps<'span'>) => <span>{children}</span>,
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
  Input: (props: React.ComponentProps<'input'>) => <input {...props} />,
  Skeleton: (props: React.ComponentProps<'div'>) => <div {...props} />,
  Switch: ({ checked, onCheckedChange }: { checked: boolean; onCheckedChange(value: boolean): void }) => <input checked={checked} onChange={event => onCheckedChange(event.target.checked)} type="checkbox" />,
  Textarea: (props: React.ComponentProps<'textarea'>) => <textarea {...props} />
}))

import { CronScreen } from './cron-screen'
import { GatewayProvider } from '~/gateway/gateway-context'
import { $preferences } from '~/state/store'
import { MemoryGateway } from '~/test/memory-gateway'

beforeEach(() => {
  $preferences.set({ authMode: 'token', profile: 'work', remoteURL: 'https://gateway.example', theme: 'system' })
})

afterEach(() => cleanup())

describe('cron jobs', () => {
  it('renders the jobs returned for the selected profile', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/cron/jobs?profile=work', () => ([{
        enabled: true,
        id: 'job-1',
        last_run_at: '2026-08-27T09:00:00Z',
        name: 'Morning briefing',
        next_run_at: '2026-08-28T09:00:00Z',
        prompt: 'Compile and deliver the complete morning briefing.',
        schedule_display: 'Every day at 9:00 AM',
        state: 'Active'
      }]))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(<QueryClientProvider client={client}><GatewayProvider gateway={gateway}><CronScreen route={{ tab: 'cron', type: 'cron-root' }} onNavigate={() => undefined} /></GatewayProvider></QueryClientProvider>)

    expect(await screen.findByText('Morning briefing')).not.toBeNull()
    expect(screen.getByText('Every day at 9:00 AM')).not.toBeNull()
    expect(screen.getAllByText('Active').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/work/)).not.toBeNull()
    expect(screen.getAllByText(/2026/).length).toBe(2)
    expect(gateway.calls.at(-1)?.value).toMatchObject({ path: '/api/cron/jobs?profile=work' })
  })
})
