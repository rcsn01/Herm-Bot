import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor, act } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $preferences } from '~/state/store'
import { beginScopedTask, currentGatewayScope, useScopedMutation } from './scope-guard'

const originalPreferences = $preferences.get()

type Deferred<T> = {
  promise: Promise<T>
  reject(reason?: unknown): void
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function createClient() {
  return new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false, staleTime: Infinity }
    }
  })
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

function bumpProfile(profile: string) {
  $preferences.set({ ...$preferences.get(), profile })
}

beforeEach(() => {
  $preferences.set({ ...originalPreferences, profile: null, remoteURL: 'https://gateway.example' })
})

afterEach(() => {
  cleanup()
  $preferences.set(originalPreferences)
})

describe('scoped operation toolkit', () => {
  it('runs callbacks for successful and failed mutations in the current scope', async () => {
    const client = createClient()
    const successDeferred = deferred<string>()
    const successEvents: string[] = []
    const success = renderHook(() => useScopedMutation<string, void>({
      mutationFn: () => successDeferred.promise,
      onSettled: () => successEvents.push('settled'),
      onSuccess: () => successEvents.push('success')
    }), { wrapper: wrapperFor(client) })

    let successPromise!: Promise<string>
    act(() => {
      successPromise = success.result.current.mutateAsync()
    })
    await waitFor(() => expect(success.result.current.isPending).toBe(true))
    await act(async () => {
      successDeferred.resolve('ok')
      await successPromise
    })

    expect(successEvents).toEqual(['success', 'settled'])

    const errorDeferred = deferred<string>()
    const errorEvents: string[] = []
    const failure = renderHook(() => useScopedMutation<string, void>({
      mutationFn: () => errorDeferred.promise,
      onError: () => errorEvents.push('error'),
      onSettled: () => errorEvents.push('settled')
    }), { wrapper: wrapperFor(client) })

    let errorPromise!: Promise<string>
    act(() => {
      errorPromise = failure.result.current.mutateAsync()
    })
    await waitFor(() => expect(failure.result.current.isPending).toBe(true))
    await act(async () => {
      errorDeferred.reject(new Error('failed'))
      await expect(errorPromise).rejects.toThrow('failed')
    })

    expect(errorEvents).toEqual(['error', 'settled'])
  })

  it('skips stale callbacks and does not roll back after a scope change', async () => {
    const client = createClient()
    const queryKey = ['scope-toolkit', 'stale']
    client.setQueryData(queryKey, { value: 'old' })
    const mutationDeferred = deferred<string>()
    const events: string[] = []
    const hook = renderHook(() => useScopedMutation<string, void, { value: string }>({
      mutationFn: () => mutationDeferred.promise,
      optimistic: {
        queryKey,
        apply: () => ({ value: 'optimistic' })
      },
      onError: () => events.push('error'),
      onSettled: () => events.push('settled'),
      onSuccess: () => events.push('success')
    }), { wrapper: wrapperFor(client) })

    let mutationPromise!: Promise<string>
    act(() => {
      mutationPromise = hook.result.current.mutateAsync()
    })
    await waitFor(() => expect(hook.result.current.isPending).toBe(true))
    expect(client.getQueryData(queryKey)).toEqual({ value: 'optimistic' })

    bumpProfile('stale-profile')
    await act(async () => {
      mutationDeferred.reject(new Error('stale failure'))
      await expect(mutationPromise).rejects.toThrow('stale failure')
    })

    expect(events).toEqual([])
    // The stale landing must not write the pre-mutation snapshot back into the cache.
    expect(client.getQueryData(queryKey)).toEqual({ value: 'optimistic' })
  })

  it('applies an optimistic value and refetches after a successful settle', async () => {
    const client = createClient()
    const queryKey = ['scope-toolkit', 'success']
    client.setQueryData(queryKey, { value: 'old' })
    let fetchCount = 0
    const mutationDeferred = deferred<string>()
    const hook = renderHook(() => {
      const query = useQuery({
        initialData: { value: 'old' },
        queryFn: async () => {
          fetchCount += 1
          return { value: 'fresh' }
        },
        queryKey
      })
      const mutation = useScopedMutation<string, void, { value: string }>({
        mutationFn: () => mutationDeferred.promise,
        optimistic: {
          queryKey,
          apply: () => ({ value: 'optimistic' })
        }
      })
      return { mutation, query }
    }, { wrapper: wrapperFor(client) })

    let promise!: Promise<string>
    act(() => {
      promise = hook.result.current.mutation.mutateAsync()
    })
    await waitFor(() => expect(hook.result.current.query.data).toEqual({ value: 'optimistic' }))
    await act(async () => {
      mutationDeferred.resolve('ok')
      await promise
    })

    await waitFor(() => expect(hook.result.current.query.data).toEqual({ value: 'fresh' }))
    expect(fetchCount).toBeGreaterThan(0)
  })

  it('rolls back before invoking the user error callback', async () => {
    const client = createClient()
    const queryKey = ['scope-toolkit', 'rollback']
    client.setQueryData(queryKey, { value: 'old' })
    const events: string[] = []
    const hook = renderHook(() => useScopedMutation<string, void, { value: string }>({
      mutationFn: async () => { throw new Error('failed') },
      optimistic: {
        queryKey,
        apply: () => {
          events.push('apply')
          return { value: 'optimistic' }
        }
      },
      onError: () => {
        events.push(`error:${client.getQueryData<{ value: string }>(queryKey)?.value}`)
      },
      onSettled: () => {
        events.push(`settled:${client.getQueryData<{ value: string }>(queryKey)?.value}`)
      }
    }), { wrapper: wrapperFor(client) })

    await act(async () => {
      await expect(hook.result.current.mutateAsync()).rejects.toThrow('failed')
    })

    expect(events).toEqual(['apply', 'error:old', 'settled:old'])
  })

  it('does not apply an optimistic value when the scope changes during onMutate', async () => {
    const client = createClient()
    const queryKey = ['scope-toolkit', 'on-mutate']
    client.setQueryData(queryKey, { value: 'old' })
    const events: string[] = []
    vi.spyOn(client, 'cancelQueries').mockImplementation(async () => {
      bumpProfile('changed-during-on-mutate')
    })
    const hook = renderHook(() => useScopedMutation<string, void, { value: string }>({
      mutationFn: async () => { throw new Error('stale failure') },
      optimistic: {
        queryKey,
        apply: () => {
          events.push('apply')
          return { value: 'optimistic' }
        }
      },
      onError: () => events.push('error'),
      onSettled: () => events.push('settled')
    }), { wrapper: wrapperFor(client) })

    await act(async () => {
      await expect(hook.result.current.mutateAsync()).rejects.toThrow('stale failure')
    })

    expect(events).toEqual([])
    expect(client.getQueryData(queryKey)).toEqual({ value: 'old' })
  })

  it('captures a scoped task once and follows the same generation semantics', () => {
    const scope = currentGatewayScope()
    const task = beginScopedTask()
    expect(task.scope).toEqual(scope)
    expect(task.isCurrent()).toBe(true)

    bumpProfile('task-stale')
    expect(task.isCurrent()).toBe(false)
  })
})
