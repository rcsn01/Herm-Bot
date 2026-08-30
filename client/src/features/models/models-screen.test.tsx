import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/compat/primitives', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({ children, ...props }: ComponentProps<'button'>) => <button {...props}>{children}</button>,
  Input: (props: ComponentProps<'input'>) => <input {...props} />,
  Skeleton: (props: ComponentProps<'div'>) => <div {...props} />,
  Switch: ({ checked, disabled, onCheckedChange }: { checked: boolean; disabled?: boolean; onCheckedChange(next: boolean): void }) => (
    <input checked={checked} disabled={disabled} onChange={event => onCheckedChange(event.target.checked)} role="switch" type="checkbox" />
  )
}))

import { ModelsScreen } from '~/features/models/models-screen'
import { GatewayProvider } from '~/gateway/gateway-context'
import { $preferences } from '~/state/store'
import { MemoryGateway } from '~/test/memory-gateway'

const PROVIDERS = [
  {
    authenticated: true,
    capabilities: { 'anthropic/claude-opus-4.8': { fast: true, reasoning: true } },
    models: ['anthropic/claude-opus-4.8', 'deepseek/deepseek-v4-pro'],
    name: 'OpenRouter',
    slug: 'openrouter'
  },
  { authenticated: true, models: ['Hermes-4-405B'], name: 'Nous', slug: 'nous' }
]

const CUSTOM_ENDPOINT_PROVIDERS = [
  ...PROVIDERS,
  { api_url: 'http://localhost:8080/v1', authenticated: true, models: ['llama-4'], name: 'Self-hosted', slug: 'custom' }
]

const moaConfig = () => ({
  active_preset: 'default',
  aggregator: { model: 'anthropic/claude-opus-4.8', provider: 'openrouter' },
  aggregator_temperature: 0.4,
  default_preset: 'default',
  degraded_reference_policy: 'loud',
  enabled: true,
  max_tokens: 4096,
  presets: {
    default: {
      aggregator: { model: 'anthropic/claude-opus-4.8', provider: 'openrouter' },
      aggregator_temperature: 0.4,
      degraded_reference_policy: 'loud',
      enabled: true,
      max_tokens: 4096,
      reference_models: [
        { model: 'Hermes-4-405B', provider: 'nous' },
        { model: 'deepseek/deepseek-v4-pro', provider: 'openrouter' }
      ],
      reference_temperature: 0.7,
      reference_timeout: null
    }
  },
  reference_models: [],
  reference_temperature: 0.7,
  reference_timeout: null
})

const baseConfig = (overrides: Record<string, unknown> = {}) => ({
  agent: { reasoning_effort: 'high', service_tier: 'normal' },
  fallback_providers: ['nous/Hermes-4-405B', { model: 'deepseek/deepseek-v4-pro', provider: 'openrouter' }],
  model_context_length: 0,
  ...overrides
})

const modelInfo = {
  auto_context_length: 200_000,
  capabilities: { supports_reasoning: true, supports_tools: true, supports_vision: true },
  config_context_length: 0,
  effective_context_length: 200_000,
  model: 'anthropic/claude-opus-4.8',
  provider: 'openrouter'
}

const AUX_KEYS = ['vision', 'compression', 'skills_hub', 'approval', 'mcp', 'title_generation', 'review', 'curator']

const auxiliaryResponse = (overrides: Record<string, { model: string; provider: string }> = {}) => ({
  main: { model: 'anthropic/claude-opus-4.8', provider: 'openrouter' },
  tasks: AUX_KEYS.map(task => ({
    base_url: '',
    model: overrides[task]?.model ?? '',
    provider: overrides[task]?.provider ?? 'auto',
    task
  }))
})

const READ_PATHS = [
  '/api/model/info?profile=work',
  '/api/model/options?explicit_only=1&profile=work',
  '/api/model/auxiliary?profile=work',
  '/api/config?profile=work',
  '/api/model/moa?profile=work'
]

let originalPreferences: ReturnType<typeof $preferences.get>

beforeEach(() => {
  originalPreferences = $preferences.get()
  $preferences.set({ ...originalPreferences, profile: 'work', remoteURL: 'https://gateway.example' })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  $preferences.set(originalPreferences)
})

function mountScreen(gateway: MemoryGateway) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <GatewayProvider gateway={gateway}>
        <ModelsScreen onBack={() => undefined} />
      </GatewayProvider>
    </QueryClientProvider>
  )
}

function baseGateway(overrides: {
  auxiliary?: Record<string, { model: string; provider: string }>
  config?: Record<string, unknown>
  onMoaPut?: (body: Record<string, unknown>) => Promise<unknown>
  onSet?: (body: Record<string, unknown>) => unknown
  providers?: typeof PROVIDERS
} = {}) {
  return new MemoryGateway()
    .handle('/api/model/info?profile=work', () => modelInfo)
    .handle('/api/model/options?explicit_only=1&profile=work', () => ({
      model: modelInfo.model,
      provider: modelInfo.provider,
      providers: overrides.providers ?? PROVIDERS
    }))
    .handle('/api/model/auxiliary?profile=work', () => auxiliaryResponse(overrides.auxiliary))
    .handle('/api/config?profile=work', () => baseConfig(overrides.config))
    .handle('/api/model/moa?profile=work', value => {
      if ((value as { method?: string }).method === 'PUT') {
        const handler = overrides.onMoaPut
        if (handler) return handler((value as { body: Record<string, unknown> }).body)
        return { ok: true, ...(value as { body: Record<string, unknown> }).body }
      }
      return moaConfig()
    })
    .handle('/api/model/set?profile=work', value => {
      const body = (value as { body?: Record<string, unknown> }).body ?? {}
      if (overrides.onSet) return overrides.onSet(body)
      return { ok: true, model: String(body.model ?? ''), provider: String(body.provider ?? ''), scope: body.scope, stale_aux: [] }
    })
}

const postCalls = (gateway: MemoryGateway) =>
  gateway.calls.filter(call => call.kind === 'request' && (call.value as { method?: string }).method === 'POST')

// Test-only loose shape: gateway payloads are untyped JSON.
/* eslint-disable @typescript-eslint/no-explicit-any */
const putBodies = (gateway: MemoryGateway, path: string): Array<Record<string, any>> =>
  gateway.calls
    .filter(call => call.kind === 'request' && (call.value as { method?: string; path: string }).method === 'PUT' && (call.value as { path: string }).path === path)
    .map(call => (call.value as { body: Record<string, any> }).body)

const configPutBodies = (gateway: MemoryGateway) => putBodies(gateway, '/api/config?profile=work').map(body => body.config)
const moaPutBodies = (gateway: MemoryGateway) => putBodies(gateway, '/api/model/moa?profile=work')

async function loadedScreen(gateway: MemoryGateway) {
  mountScreen(gateway)
  await screen.findByText('Applied:')
}

describe('ModelsScreen', () => {
  it('reads every models surface through the profile-scoped routes', async () => {
    const gateway = baseGateway()
    mountScreen(gateway)

    expect(await screen.findByText('Applied:')).not.toBeNull()
    for (const path of READ_PATHS) {
      expect(gateway.calls.some(call => call.kind === 'request' && (call.value as { path: string }).path === path)).toBe(true)
    }
    expect(screen.getAllByText(/openrouter · anthropic\/claude-opus-4\.8/i).length).toBeGreaterThan(0)
  })

  it('applies a main assignment for the selected provider and model', async () => {
    const gateway = baseGateway()
    await loadedScreen(gateway)

    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), { target: { value: 'nous' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'Hermes-4-405B' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => {
      const post = postCalls(gateway).at(0)
      expect(post).toBeTruthy()
      expect((post!.value as { body: Record<string, unknown> }).body).toEqual({ model: 'Hermes-4-405B', provider: 'nous', scope: 'main' })
    })
  })

  it('carries a custom provider api_url as base_url', async () => {
    const gateway = baseGateway({ providers: CUSTOM_ENDPOINT_PROVIDERS })
    await loadedScreen(gateway)

    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), { target: { value: 'custom' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'llama-4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => {
      const post = postCalls(gateway).at(0)
      expect((post!.value as { body: Record<string, unknown> }).body).toEqual({
        base_url: 'http://localhost:8080/v1',
        model: 'llama-4',
        provider: 'custom',
        scope: 'main'
      })
    })
  })

  it('asks for expensive-model confirmation and retries with the ack', async () => {
    const responses = [
      { confirm_message: 'This model is expensive to run.', confirm_required: true, ok: false },
      { ok: true, model: 'Hermes-4-405B', provider: 'nous', scope: 'main', stale_aux: [] }
    ]
    const gateway = baseGateway({ onSet: () => responses.shift() ?? { ok: true } })
    await loadedScreen(gateway)

    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), { target: { value: 'nous' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'Hermes-4-405B' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(await screen.findByText('This model is expensive to run.')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Apply anyway' }))

    await waitFor(() => {
      const posts = postCalls(gateway)
      expect(posts).toHaveLength(2)
      expect((posts[1].value as { body: Record<string, unknown> }).body).toMatchObject({
        confirm_expensive_model: true,
        model: 'Hermes-4-405B',
        provider: 'nous',
        scope: 'main'
      })
    })
  })

  it('closes the confirmation without persisting when declined', async () => {
    const gateway = baseGateway({ onSet: () => ({ confirm_message: 'Expensive.', confirm_required: true, ok: false }) })
    await loadedScreen(gateway)

    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), { target: { value: 'nous' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'Hermes-4-405B' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

    expect(await screen.findByText('Model change cancelled')).not.toBeNull()
    expect(postCalls(gateway)).toHaveLength(1)
  })

  it('warns when auxiliary tasks stay pinned to another provider and resets them all', async () => {
    const gateway = baseGateway({
      auxiliary: { skills_hub: { model: 'Hermes-4-405B', provider: 'nous' }, vision: { model: 'Hermes-4-405B', provider: 'nous' } }
    })
    mountScreen(gateway)

    expect(await screen.findByText(/2 auxiliary tasks \(Vision, Skills hub\) still run on/)).not.toBeNull()

    fireEvent.click(screen.getAllByRole('button', { name: 'Reset all to main' })[0])

    await waitFor(() => {
      const posts = postCalls(gateway)
      expect(posts.some(call => (call.value as { body: { task?: string } }).body.task === '__reset__')).toBe(true)
      const reset = posts.find(call => (call.value as { body: { task?: string } }).body.task === '__reset__')!
      expect((reset.value as { body: Record<string, unknown> }).body).toMatchObject({ model: 'anthropic/claude-opus-4.8', provider: 'openrouter', scope: 'auxiliary', task: '__reset__' })
    })
  })

  it('sends an auxiliary override payload for one task', async () => {
    const gateway = baseGateway()
    await loadedScreen(gateway)

    const vision = within(screen.getByLabelText('Auxiliary Vision'))
    fireEvent.click(vision.getByRole('button', { name: 'Change' }))
    fireEvent.change(vision.getByRole('combobox', { name: 'Provider for Vision' }), { target: { value: 'nous' } })
    fireEvent.change(vision.getByRole('combobox', { name: 'Model for Vision' }), { target: { value: 'Hermes-4-405B' } })
    fireEvent.click(vision.getByRole('button', { name: 'Apply' }))

    await waitFor(() => {
      const post = postCalls(gateway).find(call => (call.value as { body: { task?: string } }).body.task === 'vision')
      expect(post).toBeTruthy()
      expect((post!.value as { body: Record<string, unknown> }).body).toEqual({ model: 'Hermes-4-405B', provider: 'nous', scope: 'auxiliary', task: 'vision' })
    })
  })

  it('sends a partial config update for the reasoning default', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const gateway = baseGateway()
      await loadedScreen(gateway)

      fireEvent.change(screen.getByRole('combobox', { name: 'Default reasoning effort' }), { target: { value: 'ultra' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })

      const configPuts = configPutBodies(gateway)
      expect(configPuts).toHaveLength(1)
      // Partial update only: unrelated profile configuration stays untouched.
      expect(configPuts[0]).toEqual({ agent: { reasoning_effort: 'ultra' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes the fast tier through agent.service_tier', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const gateway = baseGateway()
      await loadedScreen(gateway)

      fireEvent.click(screen.getByRole('switch', { name: 'Fast tier' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })

      const configPuts = configPutBodies(gateway)
      expect(configPuts).toHaveLength(1)
      expect(configPuts[0]).toEqual({ agent: { service_tier: 'fast' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('persists only complete fallback pairs and normalizes legacy entries', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const gateway = baseGateway()
      await loadedScreen(gateway)

      // Legacy "nous/Hermes-4-405B" string entry edits like a structured row.
      const first = within(screen.getByLabelText('Fallback 1'))
      expect((first.getByRole('combobox', { name: 'Provider for fallback 1' }) as HTMLSelectElement).value).toBe('nous')
      expect((first.getByRole('combobox', { name: 'Model for fallback 1' }) as HTMLSelectElement).value).toBe('Hermes-4-405B')

      fireEvent.click(screen.getByRole('button', { name: 'Add fallback' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(700) })

      let configPuts = configPutBodies(gateway)
      expect(configPuts).toHaveLength(1)
      expect(configPuts[0].fallback_providers).toEqual([
        { model: 'Hermes-4-405B', provider: 'nous' },
        { model: 'deepseek/deepseek-v4-pro', provider: 'openrouter' }
      ])

      const third = within(screen.getByLabelText('Fallback 3'))
      fireEvent.change(third.getByRole('combobox', { name: 'Provider for fallback 3' }), { target: { value: 'nous' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(700) })

      // Half-filled row: provider picked, model pending — still not persisted.
      configPuts = configPutBodies(gateway)
      expect(configPuts).toHaveLength(2)
      expect((configPuts.at(-1)!.fallback_providers as unknown[])).toHaveLength(2)

      fireEvent.change(third.getByRole('combobox', { name: 'Model for fallback 3' }), { target: { value: 'Hermes-4-405B' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(700) })

      configPuts = configPutBodies(gateway)
      expect(configPuts).toHaveLength(3)
      expect(configPuts.at(-1)!.fallback_providers).toEqual([
        { model: 'Hermes-4-405B', provider: 'nous' },
        { model: 'deepseek/deepseek-v4-pro', provider: 'openrouter' },
        { model: 'Hermes-4-405B', provider: 'nous' }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('debounces context-window writes and treats blank as auto-detect', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const gateway = baseGateway()
      await loadedScreen(gateway)

      const input = screen.getByRole('spinbutton', { name: 'Context window tokens' })
      fireEvent.change(input, { target: { value: '128000' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(400) })
      expect(configPutBodies(gateway)).toHaveLength(0)

      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      expect(configPutBodies(gateway)).toEqual([{ model_context_length: 128_000 }])

      fireEvent.change(input, { target: { value: '' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(700) })
      expect(configPutBodies(gateway).at(-1)).toEqual({ model_context_length: 0 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds the MoA autosave while a slot is half-filled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const gateway = baseGateway()
      await loadedScreen(gateway)

      const refProvider = screen.getByRole('combobox', { name: 'Provider for reference 1' })
      fireEvent.change(refProvider, { target: { value: 'openrouter' } })

      // Model cleared by the provider change → config incomplete → no save,
      // even well past the 600ms window.
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(moaPutBodies(gateway)).toHaveLength(0)
      expect(screen.getByText('openrouter · No model')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('persists the MoA config once the debounce elapses after completing the slot', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const gateway = baseGateway()
      await loadedScreen(gateway)

      fireEvent.change(screen.getByRole('combobox', { name: 'Provider for reference 1' }), { target: { value: 'openrouter' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(700) })
      expect(moaPutBodies(gateway)).toHaveLength(0)

      fireEvent.change(screen.getByRole('combobox', { name: 'Model for reference 1' }), { target: { value: 'deepseek/deepseek-v4-pro' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(moaPutBodies(gateway)).toHaveLength(0)

      await act(async () => { await vi.advanceTimersByTimeAsync(200) })
      const puts = moaPutBodies(gateway)
      expect(puts).toHaveLength(1)
      const sent = puts[0]
      // The completed slot persists; untouched slots and round-tripped fields ride along.
      expect(sent.presets.default.reference_models[0]).toEqual({ model: 'deepseek/deepseek-v4-pro', provider: 'openrouter' })
      expect(sent.presets.default.reference_models[1]).toEqual({ model: 'deepseek/deepseek-v4-pro', provider: 'openrouter' })
      expect(sent.presets.default.aggregator).toEqual({ model: 'anthropic/claude-opus-4.8', provider: 'openrouter' })
      expect(sent.presets.default.reference_temperature).toBe(0.7)
      expect(sent.presets.default.max_tokens).toBe(4096)
      expect(sent.presets.default.reference_models).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never offers the moa virtual provider in reference or aggregator slots', async () => {
    const gateway = baseGateway({
      providers: [...PROVIDERS, { authenticated: true, models: [], name: 'Mixture of Agents', slug: 'moa' }]
    })
    await loadedScreen(gateway)

    const refProvider = screen.getByRole('combobox', { name: 'Provider for reference 1' })
    const values = Array.from(refProvider.querySelectorAll('option')).map(option => option.value)
    expect(values).toContain('nous')
    expect(values).not.toContain('moa')

    const aggregator = screen.getByRole('combobox', { name: 'Aggregator provider' })
    expect(Array.from(aggregator.querySelectorAll('option')).map(option => option.value)).not.toContain('moa')
  })

  it('ignores a stale MoA save response that arrives after newer edits', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const pending: Array<(value: unknown) => void> = []
    try {
      const gateway = baseGateway({ onMoaPut: () => new Promise(resolve => { pending.push(resolve) }) })
      await loadedScreen(gateway)

      // First edit → debounced save A, held open by the deferred handler.
      fireEvent.click(screen.getByRole('checkbox', { name: 'Toggle reference 1' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(700) })
      expect(pending).toHaveLength(1)

      // A newer edit lands while save A is still in flight (generation bump).
      fireEvent.change(screen.getByRole('combobox', { name: 'Provider for reference 2' }), { target: { value: 'nous' } })

      // The in-flight response echoes the OLD config; it must not repaint.
      pending.shift()?.(moaConfig())
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })

      expect((screen.getByRole('checkbox', { name: 'Toggle reference 1' }) as HTMLInputElement).checked).toBe(false)
      expect((screen.getByRole('combobox', { name: 'Provider for reference 2' }) as HTMLSelectElement).value).toBe('nous')

      // Completing the held slot flushes a follow-up save.
      fireEvent.change(screen.getByRole('combobox', { name: 'Model for reference 2' }), { target: { value: 'Hermes-4-405B' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(700) })
      expect(moaPutBodies(gateway)).toHaveLength(2)
      expect((moaPutBodies(gateway).at(-1)!.presets.default.reference_models[1])).toEqual({ model: 'Hermes-4-405B', provider: 'nous' })
      pending.at(0)?.({ ok: true, ...moaPutBodies(gateway).at(-1) })
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    } finally {
      vi.useRealTimers()
    }
  })

  it('serializes MoA writes when switching away and back to a profile', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const pending: Array<(value: unknown) => void> = []
    try {
      const gateway = baseGateway({ onMoaPut: () => new Promise(resolve => { pending.push(resolve) }) })
        .handle('/api/model/info?profile=default', () => modelInfo)
        .handle('/api/model/options?explicit_only=1&profile=default', () => ({ model: modelInfo.model, provider: modelInfo.provider, providers: PROVIDERS }))
        .handle('/api/model/auxiliary?profile=default', () => auxiliaryResponse())
        .handle('/api/config?profile=default', () => baseConfig())
        .handle('/api/model/moa?profile=default', value => {
          if ((value as { method?: string }).method === 'PUT') return { ok: true, ...((value as { body: Record<string, unknown> }).body) }
          return moaConfig()
        })
      await loadedScreen(gateway)

      fireEvent.click(screen.getByRole('checkbox', { name: 'Toggle reference 1' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(700) })
      expect(pending).toHaveLength(1)

      act(() => { $preferences.set({ ...$preferences.get(), profile: null }) })
      await screen.findByRole('button', { name: 'Add preset' })
      act(() => { $preferences.set({ ...$preferences.get(), profile: 'work' }) })
      await screen.findByRole('button', { name: 'Add preset' })

      fireEvent.change(screen.getByRole('textbox', { name: 'New preset name' }), { target: { value: 'follow-up' } })
      fireEvent.click(screen.getByRole('button', { name: 'Add preset' }))
      await act(async () => { await Promise.resolve() })

      // The old request may still be processed by the gateway after its
      // client-side abort, so the new same-profile write waits for it.
      expect(moaPutBodies(gateway)).toHaveLength(1)
      pending.shift()?.({ ok: true, ...moaConfig() })
      await waitFor(() => expect(moaPutBodies(gateway)).toHaveLength(2))
      expect(moaPutBodies(gateway).at(-1)?.presets).toHaveProperty('follow-up')
      pending.shift()?.({ ok: true, ...moaPutBodies(gateway).at(-1) })
    } finally {
      vi.useRealTimers()
    }
  })

  it('refetches MoA after a rejected write instead of keeping the optimistic draft', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const gateway = baseGateway({ onMoaPut: async () => { throw new Error('MoA save rejected') } })
      await loadedScreen(gateway)

      fireEvent.click(screen.getByRole('checkbox', { name: 'Toggle reference 1' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(700) })

      expect(await screen.findByText('MoA save rejected')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the rest of Models usable when the MoA endpoint is unavailable', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/model/info?profile=work', () => modelInfo)
      .handle('/api/model/options?explicit_only=1&profile=work', () => ({ model: modelInfo.model, provider: modelInfo.provider, providers: PROVIDERS }))
      .handle('/api/model/auxiliary?profile=work', () => auxiliaryResponse())
      .handle('/api/config?profile=work', () => baseConfig())
      .handle('/api/model/moa?profile=work', () => { throw new Error('Method not found') })
    mountScreen(gateway)

    expect(await screen.findByText('Mixture of Agents unavailable')).not.toBeNull()
    expect(screen.getByText('This gateway does not provide the MoA endpoint. The rest of Models still works.')).not.toBeNull()
    expect(screen.getByRole('combobox', { name: 'Provider' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Apply' })).not.toBeNull()
  })
})