import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  it('keeps job instructions collapsed until the user expands them', async () => {
    const instruction = 'Compile every project update into a detailed briefing with links and follow-up actions.'
    const gateway = new MemoryGateway()
      .handle('/api/cron/jobs/job-1?profile=work', () => ({
        enabled: true,
        id: 'job-1',
        prompt: instruction,
        schedule_display: 'Every day at 9:00 AM',
        state: 'Active'
      }))
      .handle('/api/cron/jobs/job-1/runs?limit=50&profile=work', () => ({ runs: [] }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(<QueryClientProvider client={client}><GatewayProvider gateway={gateway}><CronScreen route={{ jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }} onNavigate={() => undefined} /></GatewayProvider></QueryClientProvider>)

    const summary = await screen.findByText('Instructions')
    const details = summary.closest('details')!
    expect(details.open).toBe(false)
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Untitled job')

    fireEvent.click(summary)
    expect(details.open).toBe(true)
    expect(screen.getByText(instruction)).not.toBeNull()
  })

  it('opens a cron run as its stored session when tapped', async () => {
    const onOpenSession = vi.fn().mockResolvedValue(undefined)
    const gateway = new MemoryGateway()
      .handle('/api/cron/jobs/job-1?profile=work', () => ({
        enabled: true,
        id: 'job-1',
        name: 'Morning briefing',
        prompt: 'Compile the briefing.',
        schedule_display: 'Every day at 9:00 AM',
        state: 'Active'
      }))
      .handle('/api/cron/jobs/job-1/runs?limit=50&profile=work', () => ({ runs: [{ ended_at: 1_777_374_300, id: 'cron_job-1_20260827_090000', started_at: 1_777_374_000 }] }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(<QueryClientProvider client={client}><GatewayProvider gateway={gateway}><CronScreen onOpenSession={onOpenSession} route={{ jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }} onNavigate={() => undefined} /></GatewayProvider></QueryClientProvider>)

    fireEvent.click(await screen.findByRole('button', { name: /Open cron session from/ }))
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('cron_job-1_20260827_090000'))
  })

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
