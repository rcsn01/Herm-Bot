import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ButtonHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/compat/primitives', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  Skeleton: () => <span>Loading</span>,
  Switch: ({ checked, onCheckedChange }: { checked: boolean; onCheckedChange(value: boolean): void }) => <input checked={checked} onChange={event => onCheckedChange(event.target.checked)} type="checkbox" />,
  Textarea: (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />
}))

import { ConfigSectionScreen } from './config-section-screen'
import { GatewayProvider } from '~/gateway/gateway-context'
import { $preferences } from '~/state/store'
import { MemoryGateway } from '~/test/memory-gateway'

const originalPreferences = $preferences.get()

afterEach(() => {
  cleanup()
  $preferences.set(originalPreferences)
  vi.restoreAllMocks()
})

function renderSettings(gateway: MemoryGateway) {
  $preferences.set({ ...originalPreferences, profile: 'work', remoteURL: 'https://gateway.example' })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <GatewayProvider gateway={gateway}>
        <ConfigSectionScreen category="chat" onBack={() => undefined} />
      </GatewayProvider>
    </QueryClientProvider>
  )
}

const schema = {
  fields: {
    'display.personality': { type: 'string', description: 'Personality' },
    'timezone': { type: 'string', description: 'Timezone' },
    'display.show_reasoning': { type: 'boolean', description: 'Show reasoning' },
    'agent.image_input_mode': { type: 'select', description: 'Image input', options: ['auto', 'off'] }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function requestValue(call: { value: unknown }) {
  return call.value as { body?: unknown; method?: string; path?: string }
}

describe('ConfigSectionScreen', () => {
  it('saves only the changed nested field in the selected profile', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/config?profile=work', options => options && (options as { method?: string }).method === 'PUT' ? { ok: true } : { display: { personality: 'default' }, timezone: 'UTC' })
      .handle('/api/config/schema?profile=work', () => schema)

    renderSettings(gateway)
    const input = await screen.findByDisplayValue('default')
    fireEvent.change(input, { target: { value: 'concise' } })
    await waitFor(() => expect(gateway.calls.some(call => call.kind === 'request' && (call.value as { method?: string; path?: string }).path === '/api/config?profile=work' && (call.value as { method?: string }).method === 'PUT')).toBe(true), { timeout: 2_000 })
    const save = gateway.calls.find(call => call.kind === 'request' && (call.value as { method?: string; path?: string }).path === '/api/config?profile=work' && (call.value as { method?: string }).method === 'PUT')
    expect(save?.value).toMatchObject({ body: { config: { display: { personality: 'concise' } } }, path: '/api/config?profile=work' })
  })

  it('rolls back the optimistic value when the gateway rejects a save', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/config?profile=work', options => options && (options as { method?: string }).method === 'PUT' ? Promise.reject(new Error('save rejected')) : { display: { personality: 'default' } })
      .handle('/api/config/schema?profile=work', () => schema)

    renderSettings(gateway)
    const input = await screen.findByDisplayValue('default')
    fireEvent.change(input, { target: { value: 'concise' } })

    expect(await screen.findByText('save rejected')).toBeTruthy()
    await waitFor(() => expect(screen.getByDisplayValue('default')).toBeTruthy())
  })

  it('serializes rapid edits to different fields', async () => {
    const responses: Array<ReturnType<typeof deferred<{ ok: boolean }>>> = []
    const puts: unknown[] = []
    const gateway = new MemoryGateway()
      .handle('/api/config?profile=work', options => {
        if (requestValue({ value: options }).method !== 'PUT') return { display: { personality: 'default' }, timezone: 'UTC' }
        puts.push(options)
        const response = deferred<{ ok: boolean }>()
        responses.push(response)
        return response.promise
      })
      .handle('/api/config/schema?profile=work', () => schema)

    renderSettings(gateway)
    const personality = await screen.findByDisplayValue('default')
    const timezone = screen.getByDisplayValue('UTC')
    fireEvent.change(personality, { target: { value: 'concise' } })
    fireEvent.change(timezone, { target: { value: 'America/New_York' } })

    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 1_500 })
    expect(responses).toHaveLength(1)
    responses[0].resolve({ ok: true })
    await waitFor(() => expect(puts).toHaveLength(2), { timeout: 1_500 })
    expect(requestValue({ value: puts[0] }).body).toEqual({ config: { display: { personality: 'concise' } } })
    expect(requestValue({ value: puts[1] }).body).toEqual({ config: { timezone: 'America/New_York' } })
    responses[1].resolve({ ok: true })
  })

  it('keeps the newest same-field edit while an earlier save is in flight', async () => {
    const first = deferred<{ ok: boolean }>()
    const second = deferred<{ ok: boolean }>()
    const puts: unknown[] = []
    const gateway = new MemoryGateway()
      .handle('/api/config?profile=work', options => {
        if (requestValue({ value: options }).method !== 'PUT') return { display: { personality: 'default' } }
        puts.push(options)
        return puts.length === 1 ? first.promise : second.promise
      })
      .handle('/api/config/schema?profile=work', () => schema)

    renderSettings(gateway)
    const input = await screen.findByDisplayValue('default')
    fireEvent.change(input, { target: { value: 'concise' } })
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 1_500 })
    fireEvent.change(input, { target: { value: 'compact' } })
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(puts).toHaveLength(1)

    first.resolve({ ok: true })
    await waitFor(() => expect(puts).toHaveLength(2), { timeout: 1_500 })
    expect(requestValue({ value: puts[1] }).body).toEqual({ config: { display: { personality: 'compact' } } })
    second.resolve({ ok: true })
    await waitFor(() => expect(screen.getByDisplayValue('compact')).toBeTruthy())
  })

  it('does not save a debounced edit after switching profiles', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/config?profile=work', options => requestValue({ value: options }).method === 'PUT' ? { ok: true } : { display: { personality: 'default' } })
      .handle('/api/config/schema?profile=work', () => schema)
      .handle('/api/config?profile=other', options => requestValue({ value: options }).method === 'PUT' ? { ok: true } : { display: { personality: 'other' } })
      .handle('/api/config/schema?profile=other', () => schema)

    renderSettings(gateway)
    const input = await screen.findByDisplayValue('default')
    fireEvent.change(input, { target: { value: 'concise' } })
    $preferences.set({ ...$preferences.get(), profile: 'other' })
    await screen.findByDisplayValue('other')
    await new Promise(resolve => setTimeout(resolve, 500))

    expect(gateway.calls.some(call => call.kind === 'request' && requestValue(call).path === '/api/config?profile=work' && requestValue(call).method === 'PUT')).toBe(false)
  })

  it('ignores an in-flight rejection after switching profiles', async () => {
    const rejection = deferred<never>()
    const gateway = new MemoryGateway()
      .handle('/api/config?profile=work', options => requestValue({ value: options }).method === 'PUT' ? rejection.promise : { display: { personality: 'default' } })
      .handle('/api/config/schema?profile=work', () => schema)
      .handle('/api/config?profile=other', options => requestValue({ value: options }).method === 'PUT' ? { ok: true } : { display: { personality: 'other' } })
      .handle('/api/config/schema?profile=other', () => schema)

    renderSettings(gateway)
    const input = await screen.findByDisplayValue('default')
    fireEvent.change(input, { target: { value: 'concise' } })
    await waitFor(() => expect(gateway.calls.some(call => call.kind === 'request' && requestValue(call).method === 'PUT')).toBe(true), { timeout: 1_500 })
    $preferences.set({ ...$preferences.get(), profile: 'other' })
    rejection.reject(new Error('stale rejection'))

    expect(await screen.findByDisplayValue('other')).toBeTruthy()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen.queryByText('stale rejection')).toBeNull()
  })
})
