import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GatewayProvider } from '~/gateway/gateway-context'
import { $preferences } from '~/state/store'
import { MemoryGateway } from '~/test/memory-gateway'

import { emptyAdvancedProfileState, type CreateProfileCommand, type EditProfileCommand } from './profile-workflow'
import { useProfileWorkflow } from './use-profile-workflow'

const originalPreferences = $preferences.get()

beforeEach(() => {
  $preferences.set({ ...originalPreferences, profile: null, remoteURL: 'https://gateway.example' })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

function wrapperFor(gateway: MemoryGateway, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}><GatewayProvider gateway={gateway}>{children}</GatewayProvider></QueryClientProvider>
  }
}

function createCommand(): CreateProfileCommand {
  return {
    advanced: emptyAdvancedProfileState(),
    advancedTouched: false,
    appearance: { color: null, shape: 'blobatar', title: '', touched: false },
    cloneAll: false,
    cloneFrom: '',
    description: '',
    descriptionTouched: false,
    image: null,
    mirrorCredentials: true,
    mirrorCredentialsTouched: false,
    mode: 'create',
    name: 'research',
    noSkills: false,
    shareAuth: true,
    shareAuthTouched: false
  }
}

function editCommand(): EditProfileCommand {
  return {
    advanced: { ...emptyAdvancedProfileState(), dirtyModel: true, model: 'expensive', provider: 'fixture' },
    appearance: { color: null, shape: 'circle', title: 'Work', touched: false },
    avatar: { baseline: { image: null, status: 'known' }, current: null },
    description: '',
    descriptionTouched: false,
    mode: 'edit',
    name: 'work'
  }
}

describe('useProfileWorkflow reads', () => {
  it('enables reads by mode and explicit source', async () => {
    const gateway = new MemoryGateway()
      .handle('profiles.list', () => ({ profiles: [{ name: 'default' }] }))
      .handle('profiles.describe', params => ({ mcp_servers: [], name: (params as { name: string }).name, skills: [], soul: 'edit soul', toolsets: [] }))
      .handle('mcp.catalog', () => ({ servers: [] }))
      .handle('model.options', () => ({ providers: [] }))
    const onSaved = vi.fn()
    const hook = renderHook(props => useProfileWorkflow({ ...props, onSaved }), {
      initialProps: { advancedOpen: false, advancedSource: 'default', avatar: null, mode: 'create' as const, open: true },
      wrapper: wrapperFor(gateway)
    })

    expect(gateway.calls).toEqual([])
    hook.rerender({ advancedOpen: true, advancedSource: 'default', avatar: null, mode: 'create', open: true })
    await waitFor(() => expect(hook.result.current.advanced.data?.loaded).toBe(true))
    expect(gateway.calls.map(call => call.method)).toEqual(expect.arrayContaining(['profiles.list', 'profiles.describe', 'mcp.catalog', 'model.options']))
    expect(hook.result.current.advanced.data?.soul).toBe('')
  })

  it('suppresses a generated image after Scope changes', async () => {
    const image = deferred<{ image_data: string; success: boolean }>()
    const gateway = new MemoryGateway().handle('image.generate', () => image.promise)
    const hook = renderHook(() => useProfileWorkflow({ advancedOpen: false, advancedSource: null, avatar: null, mode: 'create', onSaved: vi.fn(), open: true }), { wrapper: wrapperFor(gateway) })

    let generated: string | null = 'pending'
    await act(async () => {
      const running = hook.result.current.generateAvatar('fox').then(value => { generated = value })
      $preferences.set({ ...$preferences.get(), profile: 'work' })
      image.resolve({ image_data: 'late-image', success: true })
      await running
    })
    expect(generated).toBeNull()
  })

  it('fetches an avatar only when hasAvatar lacks inline data', async () => {
    const gateway = new MemoryGateway().handle('profiles.get_asset', () => ({ data: 'image', found: true }))
    const hook = renderHook(props => useProfileWorkflow({ advancedOpen: false, advancedSource: null, mode: 'edit', onSaved: vi.fn(), open: true, ...props }), {
      initialProps: { avatar: { hasAsset: true, inlineImage: null as string | null, name: 'work' } },
      wrapper: wrapperFor(gateway)
    })
    await waitFor(() => expect(hook.result.current.avatar.baseline).toEqual({ image: 'image', status: 'known' }))
    expect(gateway.calls.map(call => call.method)).toEqual(['profiles.get_asset'])

    hook.rerender({ avatar: { hasAsset: true, inlineImage: 'inline', name: 'work' } })
    expect(hook.result.current.avatar.baseline).toEqual({ image: 'inline', status: 'known' })
    expect(gateway.calls).toHaveLength(1)
  })
})

describe('useProfileWorkflow mutation', () => {
  it('invalidates and reports successful creation', async () => {
    const gateway = new MemoryGateway().handle('profiles.create', () => ({ name: 'research', ok: true, path: '/profile' }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const onSaved = vi.fn()
    const hook = renderHook(() => useProfileWorkflow({ advancedOpen: false, advancedSource: null, avatar: null, mode: 'create', onSaved, open: true }), { wrapper: wrapperFor(gateway, client) })

    act(() => hook.result.current.mutation.submit(createCommand()))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ name: 'research' }))
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('suppresses completion when the dialog closes during a save', async () => {
    const created = deferred<{ name: string; ok: boolean; path: string }>()
    const gateway = new MemoryGateway().handle('profiles.create', () => created.promise)
    const onSaved = vi.fn()
    const hook = renderHook(props => useProfileWorkflow({ advancedOpen: false, advancedSource: null, avatar: null, mode: 'create', onSaved, ...props }), {
      initialProps: { open: true },
      wrapper: wrapperFor(gateway)
    })

    act(() => hook.result.current.mutation.submit(createCommand()))
    hook.rerender({ open: false })
    await act(async () => { created.resolve({ name: 'research', ok: true, path: '/profile' }) })
    await waitFor(() => expect(hook.result.current.mutation.busy).toBe(false))
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('freezes confirmation and decline leaves the dialog unsaved', async () => {
    const configure = vi.fn((params: unknown) => {
      const value = params as { confirm_expensive_model?: boolean }
      return value.confirm_expensive_model ? { ok: true } : { confirm_message: 'Costs more', confirm_required: true, ok: false }
    })
    const gateway = new MemoryGateway().handle('profiles.configure', configure)
    const onSaved = vi.fn()
    const hook = renderHook(() => useProfileWorkflow({ advancedOpen: false, advancedSource: null, avatar: { hasAsset: false, inlineImage: null, name: 'work' }, mode: 'edit', onSaved, open: true }), { wrapper: wrapperFor(gateway) })

    act(() => hook.result.current.mutation.submit(editCommand()))
    await waitFor(() => expect(hook.result.current.mutation.confirmation).toBe('Costs more'))
    act(() => hook.result.current.mutation.declineConfirmation())
    await waitFor(() => expect(hook.result.current.mutation.busy).toBe(false))
    expect(configure).toHaveBeenCalledTimes(1)
    expect(onSaved).not.toHaveBeenCalled()
  })
})
