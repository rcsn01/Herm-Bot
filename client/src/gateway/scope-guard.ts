import { useCallback, useMemo } from 'react'
import { useMutation, useQueryClient, type QueryKey, type UseMutationResult } from '@tanstack/react-query'

import { classifyGatewayError, type GatewayError } from './gateway-error'
import { gatewayScopeSnapshot, sameGatewayScope, type GatewayScopeSnapshot } from './gateway-scope'
import { $preferences } from '~/state/store'

export interface CurrentGatewayScope extends GatewayScopeSnapshot {
  /** Changes even when the user switches away and back to the same profile. */
  generation: number
}

let generation = 0
let last = gatewayScopeSnapshot($preferences.get().remoteURL, $preferences.get().profile)

$preferences.listen(preferences => {
  const next = gatewayScopeSnapshot(preferences.remoteURL, preferences.profile)
  if (!sameGatewayScope(last, next)) {
    generation += 1
    last = next
  }
})

/** Capture the profile and connection selected when an async operation starts. */
export function currentGatewayScope(): CurrentGatewayScope {
  const preferences = $preferences.get()
  const current = gatewayScopeSnapshot(preferences.remoteURL, preferences.profile)
  if (!sameGatewayScope(last, current)) {
    generation += 1
    last = current
  }
  return { ...current, generation }
}

/** True only while the captured connection/profile is still foreground. */
export function isCurrentGatewayScope(scope: CurrentGatewayScope): boolean {
  const current = currentGatewayScope()
  return scope.generation === current.generation && sameGatewayScope(scope, current)
}

export interface ScopedTask {
  /** The Scope captured when the task began. */
  readonly scope: CurrentGatewayScope
  /** True while the captured connection/profile is still foreground. */
  isCurrent(): boolean
}

/** Capture the Scope for a manual async operation and guard its effects. */
export function beginScopedTask(): ScopedTask {
  const scope = currentGatewayScope()
  return {
    scope,
    isCurrent: () => isCurrentGatewayScope(scope)
  }
}

/** Policy callbacks for a managed Scoped task. Every callback is optional. */
export interface ScopedTaskCallbacks {
  /** Classified failure, invoked ONLY while the captured Scope is current.
   *  Receives the classified GatewayError — display policy stays with the caller. */
  onError?: (error: GatewayError) => void
  /** Busy signal: invoked with `true` at start (unconditionally, matching today's
   *  unguarded setBusy(true)) and `false` when settled while the Scope is current. */
  onBusy?: (busy: boolean) => void
  /** Invoked once after success or handled failure, ONLY while the Scope is current. */
  onSettled?: () => void
}

export interface ScopedTaskRunner {
  /**
   * Run one manual async operation guarded by the Scope captured at call time.
   * Resolves the body's result, or `undefined` when the Scope went stale or the
   * body threw (the classified error went to `onError` instead). Never rejects.
   */
  run<T>(body: (task: ScopedTask) => Promise<T>, callbacks?: ScopedTaskCallbacks): Promise<T | undefined>
}

/** Managed Scoped task: owns capture, stale discard, and error classification. */
export function useScopedTask(): ScopedTaskRunner {
  // Stable across renders: the runner owns no reactive state, so overlapping
  // run() calls stay independent — identical to today's per-handler tasks.
  const run = useCallback(
    async <T,>(body: (task: ScopedTask) => Promise<T>, callbacks: ScopedTaskCallbacks = {}): Promise<T | undefined> => {
      const task = beginScopedTask()
      callbacks.onBusy?.(true)
      try {
        const result = await body(task)
        if (!task.isCurrent()) return undefined
        return result
      } catch (caught) {
        if (task.isCurrent()) callbacks.onError?.(classifyGatewayError(caught))
        return undefined
      } finally {
        if (task.isCurrent()) {
          callbacks.onSettled?.()
          callbacks.onBusy?.(false)
        }
      }
    },
    []
  )
  // Stable across renders too, so effect dependency arrays can include the runner.
  return useMemo(() => ({ run }), [run])
}

export interface ScopedMutationOptimistic<TQueryData, TVariables> {
  /** The query the optimistic write targets (already scope-keyed). */
  queryKey: QueryKey
  /** Transform the cached rows; return undefined to leave the cache untouched. */
  apply: (previous: TQueryData | undefined, variables: TVariables) => TQueryData | undefined
}

export interface ScopedMutationOptions<TData, TVariables, TQueryData = unknown> {
  mutationFn: (variables: TVariables) => Promise<TData>
  /** Own cancel → snapshot → apply → rollback → invalidate for this mutation. */
  optimistic?: ScopedMutationOptimistic<TQueryData, TVariables>
  /** Called only while the captured Scope is current; optimistic rollback happens first. */
  onError?: (error: unknown, variables: TVariables) => void
  /** Called only while the captured Scope is current. */
  onSuccess?: (data: TData, variables: TVariables) => void
  /** Called only while the captured Scope is current; optimistic invalidation follows it. */
  onSettled?: (data: TData | undefined, error: unknown, variables: TVariables) => void
}

type ScopedMutationContext<TQueryData> = {
  previous?: TQueryData
  scope: CurrentGatewayScope
}

/**
 * Capture scope at mutation start and discard stale callbacks/effects; an optimistic
 * configuration owns cancellation, snapshot, guarded apply/rollback, and invalidation.
 */
export function useScopedMutation<TData, TVariables, TQueryData = unknown>(
  options: ScopedMutationOptions<TData, TVariables, TQueryData>
): UseMutationResult<TData, unknown, TVariables> {
  const queryClient = useQueryClient()

  const mutation = useMutation<TData, unknown, TVariables, ScopedMutationContext<TQueryData>>({
    mutationFn: options.mutationFn,
    onMutate: async variables => {
      const scope = currentGatewayScope()
      if (!options.optimistic) return { scope }

      const { apply, queryKey } = options.optimistic
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData<TQueryData>(queryKey)
      if (isCurrentGatewayScope(scope)) {
        const next = apply(previous, variables)
        if (next !== undefined) queryClient.setQueryData(queryKey, next)
      }
      return { previous, scope }
    },
    onError: async (error, variables, context) => {
      if (!context || !isCurrentGatewayScope(context.scope)) return
      if (options.optimistic && context.previous !== undefined) {
        queryClient.setQueryData(options.optimistic.queryKey, context.previous)
      }
      await options.onError?.(error, variables)
    },
    onSuccess: async (data, variables, context) => {
      if (!context || !isCurrentGatewayScope(context.scope)) return
      await options.onSuccess?.(data, variables)
    },
    onSettled: async (data, error, variables, context) => {
      if (!context || !isCurrentGatewayScope(context.scope)) return
      await options.onSettled?.(data, error, variables)
      if (options.optimistic && isCurrentGatewayScope(context.scope)) {
        void queryClient.invalidateQueries({ queryKey: options.optimistic.queryKey })
      }
    }
  })

  // Keep React Query's internal rollback context out of the public mutation type.
  return mutation as unknown as UseMutationResult<TData, unknown, TVariables>
}
