import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor, act } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $preferences } from '~/state/store'
import { beginScopedTask, currentGatewayScope, useScopedMutation, useScopedQuery, useScopeKey, useScopeReset, useScopedTask, type ScopedTask } from './scope-guard'
import { GatewayError } from './gateway-error'

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

describe('scoped query scaffold', () => {
  it('derives keys from the active scope and updates them on profile changes', () => {
    const hook = renderHook(() => useScopeKey('settings', ['providers']))
    expect(hook.result.current).toEqual(['gateway', 'https://gateway.example', 'default', 'settings', 'providers'])

    act(() => bumpProfile('work'))
    expect(hook.result.current).toEqual(['gateway', 'https://gateway.example', 'work', 'settings', 'providers'])
  })

  it('pins unscoped keys to the default profile', () => {
    const hook = renderHook(() => useScopeKey('settings', ['billing'], { unscoped: true }))
    const initial = hook.result.current
    act(() => bumpProfile('work'))
    expect(hook.result.current).toEqual(['gateway', 'https://gateway.example', 'default', 'settings', 'billing'])
    expect(hook.result.current).toEqual(initial)
  })

  it('resolves data and classifies failures', async () => {
    const client = createClient()
    const success = renderHook(() => useScopedQuery(['success'], { queryFn: async () => 'ok' }), { wrapper: wrapperFor(client) })
    await waitFor(() => expect(success.result.current.data).toBe('ok'))

    const failure = renderHook(() => useScopedQuery(['failure'], {
      queryFn: async () => { throw new TypeError('Failed to fetch') }
    }), { wrapper: wrapperFor(client) })
    await waitFor(() => expect(failure.result.current.isError).toBe(true))
    expect(failure.result.current.error).toBeInstanceOf(GatewayError)
    expect(failure.result.current.error).toMatchObject({ kind: 'network', retryable: true })
  })

  it('does not call a disabled query', async () => {
    const client = createClient()
    const queryFn = vi.fn(async () => 'unused')
    const hook = renderHook(() => useScopedQuery(['disabled'], { enabled: false, queryFn }), { wrapper: wrapperFor(client) })
    await act(async () => Promise.resolve())
    expect(hook.result.current.fetchStatus).toBe('idle')
    expect(queryFn).not.toHaveBeenCalled()
  })

  it('keeps separate cache entries for each scope', async () => {
    const client = createClient()
    let calls = 0
    const hook = renderHook(() => {
      const key = useScopeKey('profiles')
      const query = useScopedQuery(key, { queryFn: async () => `value-${++calls}` })
      return { key, query }
    }, { wrapper: wrapperFor(client) })
    await waitFor(() => expect(hook.result.current.query.data).toBe('value-1'))
    const defaultKey = [...hook.result.current.key]

    act(() => bumpProfile('work'))
    await waitFor(() => expect(hook.result.current.query.data).toBe('value-2'))
    expect(client.getQueryData(defaultKey)).toBe('value-1')
    expect(client.getQueryData(hook.result.current.key)).toBe('value-2')
  })

  it('resets on mount and scope changes, not unrelated rerenders', () => {
    const reset = vi.fn()
    const hook = renderHook(() => useScopeReset(reset))
    expect(reset).toHaveBeenCalledTimes(1)
    hook.rerender()
    expect(reset).toHaveBeenCalledTimes(1)
    act(() => bumpProfile('work'))
    expect(reset).toHaveBeenCalledTimes(2)
    act(() => $preferences.set({ ...$preferences.get(), remoteURL: 'https://other.example' }))
    expect(reset).toHaveBeenCalledTimes(3)
  })

  it('resets for extra dependencies and cleans up on changes and unmount', () => {
    const cleanupEffect = vi.fn()
    const reset = vi.fn(() => cleanupEffect)
    const hook = renderHook(({ value }) => useScopeReset(reset, value), { initialProps: { value: 'a' } })
    expect(reset).toHaveBeenCalledTimes(1)

    hook.rerender({ value: 'b' })
    expect(cleanupEffect).toHaveBeenCalledTimes(1)
    expect(reset).toHaveBeenCalledTimes(2)
    act(() => bumpProfile('work'))
    expect(cleanupEffect).toHaveBeenCalledTimes(2)
    expect(reset).toHaveBeenCalledTimes(3)
    hook.unmount()
    expect(cleanupEffect).toHaveBeenCalledTimes(3)
  })
})

describe('useScopedTask', () => {
  function useRunnerEvents(events: string[]) {
    return {
      onBusy: (busy: boolean) => events.push(`busy:${busy}`),
      onError: () => events.push('error'),
      onSettled: () => events.push('settled')
    }
  }

  it('resolves the body value and fires the busy/settled callbacks on the happy path', async () => {
    const { result } = renderHook(() => useScopedTask())
    const events: string[] = []
    let outcome: string | undefined
    await act(async () => {
      outcome = await result.current.run(async () => 'value', useRunnerEvents(events))
    })
    expect(outcome).toBe('value')
    expect(events).toEqual(['busy:true', 'settled', 'busy:false'])
  })

  it('discards a stale run without firing any completion callback', async () => {
    const { result } = renderHook(() => useScopedTask())
    const body = deferred<string>()
    const events: string[] = []
    let outcome: string | undefined
    await act(async () => {
      const running = result.current.run(async () => body.promise, useRunnerEvents(events))
      bumpProfile('stale-run')
      body.resolve('late')
      outcome = await running
    })
    expect(outcome).toBeUndefined()
    expect(events).toEqual(['busy:true'])
  })

  it('classifies a current-scope failure and settles in order', async () => {
    const { result } = renderHook(() => useScopedTask())
    const events: string[] = []
    const errors: GatewayError[] = []
    let outcome: string | undefined
    await act(async () => {
      outcome = await result.current.run(async () => { throw new Error('failed') }, {
        ...useRunnerEvents(events),
        onError: error => { errors.push(error); events.push('error') }
      })
    })
    expect(outcome).toBeUndefined()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(GatewayError)
    expect(errors[0].kind).toBe('server')
    expect(errors[0].message).toBe('failed')
    expect(events).toEqual(['busy:true', 'error', 'settled', 'busy:false'])
  })

  it('does not invoke onError when the scope changed before the failure', async () => {
    const { result } = renderHook(() => useScopedTask())
    const body = deferred<string>()
    const events: string[] = []
    let outcome: string | undefined
    await act(async () => {
      const running = result.current.run(async () => body.promise, useRunnerEvents(events))
      bumpProfile('stale-error')
      body.reject(new Error('late failure'))
      outcome = await running
    })
    expect(outcome).toBeUndefined()
    expect(events).toEqual(['busy:true'])
  })

  it('skips settled callbacks when the scope goes stale inside onError', async () => {
    const { result } = renderHook(() => useScopedTask())
    const events: string[] = []
    await act(async () => {
      await result.current.run(async () => { throw new Error('failed') }, {
        onBusy: busy => events.push(`busy:${busy}`),
        onError: () => { events.push('error'); bumpProfile('stale-in-onerror') },
        onSettled: () => events.push('settled')
      })
    })
    expect(events).toEqual(['busy:true', 'error'])
  })

  it('fires onBusy(true) unconditionally even when the scope goes stale mid-flight', async () => {
    const { result } = renderHook(() => useScopedTask())
    const events: string[] = []
    await act(async () => {
      const outcome = await result.current.run(async () => {
        bumpProfile('mid-flight-stale')
        return 'never'
      }, useRunnerEvents(events))
      expect(outcome).toBeUndefined()
    })
    expect(events).toEqual(['busy:true'])
  })

  it('lets the body gate its own mid-run effects via the task handle', async () => {
    const { result } = renderHook(() => useScopedTask())
    const applied: string[] = []
    const gate = deferred<void>()
    let kept: boolean | undefined
    await act(async () => {
      const running = result.current.run(async task => {
        await gate.promise
        if (task.isCurrent()) applied.push('kept')
        return task.isCurrent()
      })
      gate.resolve()
      kept = await running
    })
    expect(kept).toBe(true)
    expect(applied).toEqual(['kept'])

    const staleGate = deferred<void>()
    let staleOutcome: boolean | undefined
    await act(async () => {
      const running = result.current.run(async task => {
        await staleGate.promise
        if (task.isCurrent()) applied.push('skipped')
        return task.isCurrent()
      }, { onSettled: () => applied.push('settled') })
      bumpProfile('mid-run-gate')
      staleGate.resolve()
      staleOutcome = await running
    })
    expect(staleOutcome).toBeUndefined()
    expect(applied).toEqual(['kept'])
  })

  it('keeps concurrent runs independent', async () => {
    const { result } = renderHook(() => useScopedTask())
    const firstBody = deferred<string>()
    const secondBody = deferred<string>()
    const firstEvents: string[] = []
    const secondEvents: string[] = []
    let firstOutcome: string | undefined
    let secondOutcome: string | undefined
    await act(async () => {
      const first = result.current.run(async () => firstBody.promise, useRunnerEvents(firstEvents))
      bumpProfile('concurrent-stale')
      const second = result.current.run(async () => secondBody.promise, useRunnerEvents(secondEvents))
      firstBody.resolve('first')
      firstOutcome = await first
      secondBody.resolve('second')
      secondOutcome = await second
    })
    expect(firstOutcome).toBeUndefined()
    expect(secondOutcome).toBe('second')
    expect(firstEvents).toEqual(['busy:true'])
    expect(secondEvents).toEqual(['busy:true', 'settled', 'busy:false'])
  })

  it('never rejects and classifies non-Error throwables', async () => {
    const { result } = renderHook(() => useScopedTask())
    const errors: GatewayError[] = []
    let outcome: string | undefined
    await act(async () => {
      outcome = await result.current.run(async () => {
        throw 'plain string'
      }, { onError: error => errors.push(error) })
    })
    expect(outcome).toBeUndefined()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(GatewayError)
    expect(errors[0].message).toBe('plain string')
  })

  it('exposes the captured task handle to the body', async () => {
    const { result } = renderHook(() => useScopedTask())
    let captured: ScopedTask | undefined
    await act(async () => {
      await result.current.run(async task => { captured = task })
    })
    expect(captured?.isCurrent()).toBe(true)
    bumpProfile('after-capture')
    expect(captured?.isCurrent()).toBe(false)
  })
})
