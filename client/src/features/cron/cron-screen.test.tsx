import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/compat/primitives', () => ({
  Badge: ({ children }: React.ComponentProps<'span'>) => <span>{children}</span>,
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
  Skeleton: (props: React.ComponentProps<'div'>) => <div {...props} />
}))

import { OperationsScreen } from '~/features/operations/operations-screen'
import { GatewayProvider } from '~/gateway/gateway-context'
import { $preferences } from '~/state/store'
import { MemoryGateway } from '~/test/memory-gateway'

beforeEach(() => {
  $preferences.set({ authMode: 'token', profile: 'work', remoteURL: 'https://gateway.example', theme: 'system' })
})

describe('cron jobs', () => {
  it('renders the jobs returned for the selected profile', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/cron/jobs?profile=work', () => ([{
        enabled: true,
        id: 'job-1',
        name: 'Morning briefing',
        prompt: 'Compile and deliver the complete morning briefing.',
        next_run_at: '2026-08-28T09:00:00Z',
        schedule_display: 'Every day at 9:00 AM'
      }]))
      .handle('/api/cron/jobs/job-1/runs?limit=20&profile=work', () => ({ runs: [
        { ended_at: 1_777_374_060, id: 'run-1', input_tokens: 1200, is_active: false, message_count: 2, model: 'provider/example-model', output_tokens: 300, preview: 'Briefing delivered successfully.', started_at: 1_777_374_000, title: 'Morning briefing run 1' },
        { ended_at: 1_777_287_660, id: 'run-2', is_active: false, message_count: 2, started_at: 1_777_287_600, title: 'Morning briefing run 2' },
        { ended_at: 1_777_201_260, id: 'run-3', is_active: false, message_count: 2, started_at: 1_777_201_200, title: 'Morning briefing run 3' },
        { ended_at: 1_777_114_860, id: 'run-4', is_active: false, message_count: 2, started_at: 1_777_114_800, title: 'Morning briefing run 4' }
      ] }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(<QueryClientProvider client={client}><GatewayProvider gateway={gateway}><OperationsScreen selected="cron" onBack={() => undefined} onSelect={() => undefined} /></GatewayProvider></QueryClientProvider>)

    expect(await screen.findByText('Morning briefing')).not.toBeNull()
    expect(screen.getByText('Every day at 9:00 AM')).not.toBeNull()
    expect(screen.queryByText('Compile and deliver the complete morning briefing.')).toBeNull()

    expect((await screen.findAllByText('Complete'))).toHaveLength(3)
    expect(screen.queryByText(/Morning briefing run/)).toBeNull()
    expect(screen.queryByText('Briefing delivered successfully.')).toBeNull()
    expect(screen.queryByText('example-model')).toBeNull()
    expect(screen.queryByText(/1,500 tokens/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /show full history/i }))
    expect(await screen.findAllByText('Complete')).toHaveLength(4)
  })
})
