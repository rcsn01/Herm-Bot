import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
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
import { $navigation, applyPathState, resetNavigation } from '~/navigation/navigation-store'
import { ROOT_ROUTES, type CronRoute } from '~/navigation/routes'
import { useWorkspaceNavigation } from '~/navigation/use-workspace-navigation'
import { resetWorkspacePolicy } from '~/navigation/workspace-navigation'
import { $preferences } from '~/state/store'
import { MemoryGateway } from '~/test/memory-gateway'

beforeEach(() => {
  resetNavigation()
  resetWorkspacePolicy()
  $preferences.set({ authMode: 'token', profile: 'work', remoteURL: 'https://gateway.example', theme: 'system' })
})

afterEach(() => cleanup())

/** Renders the real adapter + screen pair against the arranged route. */
function renderCronScreen(route: CronRoute, gateway: MemoryGateway, onOpenSession?: (sessionId: string) => Promise<void>) {
  applyPathState('cron', route.type === 'cron-root' ? [ROOT_ROUTES.cron] : [ROOT_ROUTES.cron, route])
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  function Harness() {
    const workspace = useWorkspaceNavigation()
    return <CronScreen onOpenSession={onOpenSession} workspace={workspace.screen('cron')} />
  }
  return render(
    <QueryClientProvider client={client}>
      <GatewayProvider gateway={gateway}>
        <Harness />
      </GatewayProvider>
    </QueryClientProvider>
  )
}

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

    renderCronScreen({ jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }, gateway)

    const summary = await screen.findByText('Instructions')
    const details = summary.closest('details')!
    expect(details.open).toBe(false)
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Untitled job')

    fireEvent.click(summary)
    expect(details.open).toBe(true)
    expect(screen.getByText(instruction)).not.toBeNull()
  })

  it('shows a cron job model override instead of implying the header model is used', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/cron/jobs/job-1?profile=work', () => ({
        enabled: true,
        id: 'job-1',
        model: 'gpt-old',
        name: 'Morning briefing',
        prompt: 'Compile the briefing.',
        provider: 'openai-api',
        schedule_display: 'Every day at 9:00 AM',
        state: 'Active'
      }))
      .handle('/api/cron/jobs/job-1/runs?limit=50&profile=work', () => ({ runs: [] }))

    renderCronScreen({ jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }, gateway)

    expect(await screen.findByText(/Model override: openai-api · gpt-old/)).not.toBeNull()
  })

  it('clears stored model overrides when blank fields are saved', async () => {
    let updateBody: unknown
    const job = {
      enabled: true,
      id: 'job-1',
      model: 'gpt-old',
      name: 'Morning briefing',
      prompt: 'Compile the briefing.',
      provider: 'openai-api',
      schedule: { expr: 'every day 9am', kind: 'natural' }
    }
    const gateway = new MemoryGateway()
      .handle('/api/cron/jobs?profile=work', () => [job])
      .handle('/api/cron/jobs/job-1?profile=work', value => {
        // A successful save lands on the detail view, whose GET shares this
        // handler — capture the PUT body only.
        if ((value as { method?: string }).method === 'PUT') updateBody = value
        return { ...job, model: null, provider: null }
      })

    renderCronScreen({ jobId: 'job-1', tab: 'cron', type: 'cron-job-editor' }, gateway)

    const provider = await screen.findByRole('button', { name: /^Provider/ })
    await waitFor(() => expect(provider.textContent).toContain('openai-api'))
    expect(screen.getByRole('button', { name: /^Model/ }).textContent).toContain('gpt-old')
    fireEvent.click(provider)
    expect(screen.getByRole('dialog', { name: 'Choose provider' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(updateBody).toMatchObject({ body: { updates: { model: null, provider: null } } }))
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

    renderCronScreen({ jobId: 'job-1', tab: 'cron', type: 'cron-job-detail' }, gateway, onOpenSession)

    fireEvent.click(await screen.findByRole('button', { name: /Open cron session from/ }))
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('cron_job-1_20260827_090000'))
  })

  it('renders the jobs returned for the selected profile and navigates through the workspace stack', async () => {
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

    const { container } = renderCronScreen({ tab: 'cron', type: 'cron-root' }, gateway)

    expect(await screen.findByText('Morning briefing')).not.toBeNull()
    expect(screen.queryByRole('heading', { name: 'Cron jobs' })).toBeNull()
    const newAutomation = screen.getByRole('button', { name: 'New automations' })
    expect(newAutomation.firstElementChild?.tagName).toBe('svg')
    expect(newAutomation.lastElementChild?.textContent).toBe('New automations')
    expect(container.querySelector('.cron-job-list')?.firstElementChild).toBe(newAutomation)
    expect(screen.queryByRole('button', { name: 'Blueprints' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Refresh cron jobs' })).toBeNull()
    expect(screen.queryByText('Showing cached jobs. Pull to refresh.')).toBeNull()
    expect(screen.getByText('Every day at 9:00 AM')).not.toBeNull()
    expect(screen.getAllByText('Active').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText('Remote automation')).toBeNull()
    expect(screen.queryByText(/Gateway-owned schedules/)).toBeNull()
    expect(screen.getAllByText(/2026/).length).toBe(2)
    expect(gateway.calls.at(-1)?.value).toMatchObject({ path: '/api/cron/jobs?profile=work' })

    fireEvent.click(newAutomation)
    expect(screen.getByRole('dialog', { name: 'New automation' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Use a blueprint' }))
    expect($navigation.get().stacks.cron).toEqual([ROOT_ROUTES.cron, { tab: 'cron', type: 'cron-blueprints' }])

    // Back at the root, create-from-scratch pushes the editor route the same way.
    act(() => { applyPathState('cron', [ROOT_ROUTES.cron]) })
    fireEvent.click(screen.getByRole('button', { name: 'New automations' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create from scratch' }))
    expect($navigation.get().stacks.cron).toEqual([ROOT_ROUTES.cron, { tab: 'cron', type: 'cron-job-editor' }])
  })
})