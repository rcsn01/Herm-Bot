import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewayProvider } from '~/gateway/gateway-context'
import { MemoryGateway } from '~/test/memory-gateway'
import { $chat, emptyChatState } from '~/state/conversation'
import type { GatewayController } from '~/state/gateway-controller'
import { $connection, $preferences, $sessionSelecting } from '~/state/store'
import { ArchivedChatsScreen } from './archived-chats-screen'
import { $draftOwner, draftOwnerKey } from '~/state/draft-owner'
import { localPrivacy } from '~/state/local-privacy'

vi.mock('~/compat/primitives', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
  Input: (props: React.ComponentProps<'input'>) => <input {...props} />
}))
vi.mock('~/components/ui/confirm-dialog', () => ({
  ConfirmDialog: ({ confirmLabel, onConfirm, onCancel }: { confirmLabel: string; onConfirm(): void; onCancel(): void }) => <div role="dialog"><button onClick={onConfirm}>{confirmLabel}</button><button onClick={onCancel}>Cancel</button></div>
}))

const clients: QueryClient[] = []
function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function setup(options: { restore?: () => Promise<void>; resume?: () => Promise<unknown>; refresh?: () => Promise<void>; failList?: boolean } = {}) {
  const events: string[] = []
  let rows = [{ id: 'old', title: 'Old notes', preview: '<script>literal preview</script>', message_count: 3 }]
  const gateway = new MemoryGateway()
    .handle('/api/sessions?archived=only&limit=100&order=recent&profile=work', () => {
      if (options.failList) throw new Error('archive unavailable')
      return { sessions: rows }
    })
    .handle('/api/sessions/old?profile=work', async value => {
      const request = value as { method: string }
      events.push(request.method)
      if (request.method === 'PATCH') await options.restore?.()
      rows = []
      return { ok: true }
    })
  const controller = {
    refreshSessions: vi.fn(async () => { events.push('refresh'); await options.refresh?.() }),
    resumeSession: vi.fn(async () => {
      events.push('resume')
      if (options.resume) return options.resume()
      $chat.set({ ...emptyChatState(), storedSessionId: 'old', runtimeSessionId: 'runtime-old' })
      return { session: { storedSessionId: 'old' }, resumed: true }
    })
  } as unknown as GatewayController
  const onOpened = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const result = render(<QueryClientProvider client={client}><GatewayProvider gateway={gateway}><ArchivedChatsScreen controller={controller} onBack={() => undefined} onOpened={onOpened} /></GatewayProvider></QueryClientProvider>)
  return { ...result, gateway, controller, onOpened, events }
}
beforeEach(() => {
  $sessionSelecting.set(false)
  $preferences.set({ ...$preferences.get(), profile: 'work', remoteURL: 'https://gateway.test' })
  $chat.set({ ...emptyChatState(), storedSessionId: 'current', runtimeSessionId: 'runtime-current' })
})
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.restoreAllMocks() })

describe('archive discovery', () => {
  it('uses the bounded profile request, plain previews and title-only search', async () => {
    const { gateway } = setup()
    await screen.findByText('Old notes')
    expect(screen.getByText('<script>literal preview</script>')).not.toBeNull()
    expect(screen.getByText(/up to 100 chats, not a verified complete archive/)).not.toBeNull()
    expect(gateway.calls[0].value).toMatchObject({ path: '/api/sessions?archived=only&limit=100&order=recent&profile=work' })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'literal preview' } })
    expect(screen.getByText('No matching loaded archived titles.')).not.toBeNull()
  })

  it('restores without opening and refreshes the live roster', async () => {
    const { controller, events, onOpened } = setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Old notes' }))
    await screen.findByText('Restored.')
    expect(events).toEqual(['PATCH', 'refresh'])
    expect(controller.resumeSession).not.toHaveBeenCalled()
    expect(onOpened).not.toHaveBeenCalled()
  })

  it('restores then opens by exact ID, even when list refresh fails', async () => {
    const { events, controller, onOpened } = setup({ refresh: async () => { throw new Error('list failed') } })
    fireEvent.click(await screen.findByRole('button', { name: 'Restore and open Old notes' }))
    await waitFor(() => expect(onOpened).toHaveBeenCalledOnce())
    expect(events).toEqual(['PATCH', 'refresh', 'resume'])
    expect(controller.resumeSession).toHaveBeenCalledWith('old')
  })

  it('reports restore failure without trying to open', async () => {
    const { controller, onOpened } = setup({ restore: async () => { throw new Error('restore failed') } })
    fireEvent.click(await screen.findByRole('button', { name: 'Restore and open Old notes' }))
    expect((await screen.findByRole('alert')).textContent).toContain('restore failed')
    expect(controller.resumeSession).not.toHaveBeenCalled()
    expect(onOpened).not.toHaveBeenCalled()
  })

  it('retries opening after restore without issuing the mutation again', async () => {
    const resume = vi.fn().mockRejectedValueOnce(new Error('resume failed')).mockImplementation(async () => {
      $chat.set({ ...emptyChatState(), storedSessionId: 'old' })
      return { session: { storedSessionId: 'old' }, resumed: true }
    })
    const { events, onOpened } = setup({ resume })
    fireEvent.click(await screen.findByRole('button', { name: 'Restore and open Old notes' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Restored, but could not open.')
    fireEvent.click(screen.getByRole('button', { name: 'Open restored chat' }))
    await waitFor(() => expect(onOpened).toHaveBeenCalledOnce())
    expect(events.filter(event => event === 'PATCH')).toHaveLength(1)
    expect(resume).toHaveBeenCalledTimes(2)
  })

  it('does not navigate for an undefined superseded selection outcome', async () => {
    const { onOpened } = setup({ resume: async () => undefined })
    fireEvent.click(await screen.findByRole('button', { name: 'Restore and open Old notes' }))
    await screen.findByText(/Opening was superseded/)
    expect(onOpened).not.toHaveBeenCalled()
  })

  it('does not navigate if another selection is pending after a published resume', async () => {
    const { onOpened } = setup({ resume: async () => {
      $chat.set({ ...emptyChatState(), storedSessionId: 'old' })
      $sessionSelecting.set(true)
      return { session: { storedSessionId: 'old' }, resumed: true }
    } })
    fireEvent.click(await screen.findByRole('button', { name: 'Restore and open Old notes' }))
    await screen.findByText(/Opening was superseded/)
    expect(onOpened).not.toHaveBeenCalled()
  })

  it('shows an accessible offline explanation instead of a disabled loading query', async () => {
    setup()
    await screen.findByText('Old notes')
    act(() => $connection.set({ ...$connection.get(), phase: 'reconnecting' }))
    expect(screen.getByText(/Archived chats are not saved on this device/)).not.toBeNull()
    expect(screen.queryByText('Loading archived chats…')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Restore Old notes' })).toBeNull()
    expect(screen.getByRole('button', { name: /Back/ })).not.toBeNull()
  })

  it('guards duplicate clicks while restore is pending', async () => {
    const restore = deferred()
    const { events, onOpened } = setup({ restore: () => restore.promise })
    const button = await screen.findByRole('button', { name: 'Restore and open Old notes' })
    button.focus()
    fireEvent.click(button)
    fireEvent.click(button)
    expect(events).toEqual(['PATCH'])
    expect(document.activeElement).toBe(button)
    await act(async () => restore.resolve())
    await waitFor(() => expect(onOpened).toHaveBeenCalledOnce())
  })

  it('does not open over a newer selection made during restoration', async () => {
    const restore = deferred()
    const { controller, onOpened } = setup({ restore: () => restore.promise })
    fireEvent.click(await screen.findByRole('button', { name: 'Restore and open Old notes' }))
    act(() => $chat.set({ ...emptyChatState(), storedSessionId: 'newer', runtimeSessionId: 'runtime-newer' }))
    await act(async () => restore.resolve())
    await screen.findByText(/Another selection took precedence/)
    expect(controller.resumeSession).not.toHaveBeenCalled()
    expect(onOpened).not.toHaveBeenCalled()
  })

  it.each(['unmount', 'profile', 'privacy'] as const)('retires pending restore on %s', async change => {
    const restore = deferred()
    const { controller, onOpened, unmount } = setup({ restore: () => restore.promise })
    fireEvent.click(await screen.findByRole('button', { name: 'Restore and open Old notes' }))
    if (change === 'unmount') unmount()
    else if (change === 'profile') act(() => $preferences.set({ ...$preferences.get(), profile: 'other' }))
    else {
      vi.spyOn(localPrivacy, 'revision').mockReturnValue('archive-reset')
      act(() => localPrivacy.$reset.set({ owner: draftOwnerKey($draftOwner.get()), revision: 'archive-reset', external: false }))
    }
    await act(async () => restore.resolve())
    expect(controller.resumeSession).not.toHaveBeenCalled()
    expect(controller.refreshSessions).not.toHaveBeenCalled()
    expect(onOpened).not.toHaveBeenCalled()
  })

  it('requires confirmation for permanent deletion', async () => {
    const { events } = setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete archived Old notes' }))
    expect(events).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))
    await screen.findByText('Deleted.')
    expect(events).toEqual(['DELETE', 'refresh'])
  })

  it('does not report a failed archive request as an empty archive', async () => {
    setup({ failList: true })
    await screen.findByRole('button', { name: 'Retry archived chats' })
    expect(screen.queryByText('No archived chats in this response.')).toBeNull()
  })
})
