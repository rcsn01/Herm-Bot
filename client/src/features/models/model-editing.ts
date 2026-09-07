import { useStore } from '@nanostores/react'
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { createModelsApi } from '~/features/models/api'
import { CONFIG_SAVE_DEBOUNCE_MS } from '~/features/models/config-editors'
import {
  fallbackEntriesEqual,
  getConfigValue,
  normalizeFallbackEntries,
  setConfigValue,
  type FallbackEntry
} from '~/features/models/helpers'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { useApi } from '~/gateway/gateway-api-hooks'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import { profileKey } from '~/gateway/profile-path'
import { beginScopedTask, useScopedTask, type ScopedTask } from '~/gateway/scope-guard'
import type { HermesConfigRecord, ModelOptionProvider, StaleAuxAssignment } from '~/lib/types'
import { $preferences } from '~/state/store'

export interface MainModelAssignment {
  base_url?: string
  model: string
  provider: string
}

export interface MainModelEditing {
  apply(assignment: MainModelAssignment): void
  confirm(): void
  decline(): void
  clearStaleAuxiliary(expectedVersion: number): void
  applying: boolean
  declined: boolean
  error: string | null
  pendingConfirmation: null | {
    assignment: MainModelAssignment
    message: string
  }
  staleAuxiliary: readonly StaleAuxAssignment[]
  staleAuxiliaryVersion: number
}

export interface AuxiliaryAssignment {
  model: string
  provider: string
  task: string
}

export interface AuxiliaryModelEditing {
  assign(assignment: AuxiliaryAssignment): Promise<boolean>
  resetAll(main: { model: string; provider: string }): Promise<boolean>
  applying: boolean
  error: string | null
}

export interface ModelConfigEditing {
  error: string | null
  setReasoningEffort(value: string): void
  setFastTier(enabled: boolean): void
  setContextLength(value: number): void
  setFallbacks(entries: readonly FallbackEntry[]): void
}

function useModelEditingDependencies() {
  const models = useApi(createModelsApi)
  const queryClient = useQueryClient()
  const preferences = useStore($preferences)
  const connectionKey = preferences.remoteURL
  const profile = preferences.profile
  const modelsKey = useMemo(
    () => gatewayScopeKey({ connectionKey, profile }, 'models'),
    [connectionKey, profile]
  )
  const configKey = useMemo(() => [...modelsKey, 'config'], [modelsKey])
  return { configKey, connectionKey, models, modelsKey, profile, queryClient }
}

const errorMessage = (error: unknown) => classifyGatewayError(error).message

export function useMainModelEditing(): MainModelEditing {
  const { connectionKey, models, modelsKey, profile, queryClient } = useModelEditingDependencies()
  const [applying, setApplying] = useState(false)
  const [declined, setDeclined] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingConfirmation, setPendingConfirmation] = useState<MainModelEditing['pendingConfirmation']>(null)
  const [staleReport, setStaleReport] = useState<{
    items: readonly StaleAuxAssignment[]
    version: number
  }>({ items: [], version: 0 })
  const operationGeneration = useRef(0)
  const action = useScopedTask()

  useEffect(() => {
    operationGeneration.current += 1
    setApplying(false)
    setDeclined(false)
    setError(null)
    setPendingConfirmation(null)
    setStaleReport({ items: [], version: 0 })
    return () => {
      operationGeneration.current += 1
    }
  }, [connectionKey, profile])

  const submit = useCallback((assignment: MainModelAssignment, confirmed: boolean) => {
    if (!assignment.provider || !assignment.model) return
    const generation = operationGeneration.current + 1
    operationGeneration.current = generation
    void action.run(async task => {
      const isCurrent = () => task.isCurrent() && operationGeneration.current === generation
      setError(null)
      const result = await models.setAssignment({
        ...assignment,
        scope: 'main',
        ...(confirmed ? { confirm_expensive_model: true } : {})
      })
      if (!isCurrent()) return
      if (result.confirm_required) {
        if (confirmed) {
          setPendingConfirmation(null)
          setError(result.confirm_message?.trim() || 'The gateway still refuses this model.')
          return
        }
        setPendingConfirmation({
          assignment,
          message: result.confirm_message?.trim() || 'This model may be expensive to run. Apply anyway?'
        })
        return
      }
      if (result.ok !== true) {
        setError(result.confirm_message?.trim() || 'The model assignment was not applied.')
        return
      }
      setPendingConfirmation(null)
      setDeclined(false)
      setStaleReport(current => ({ items: result.stale_aux ?? [], version: current.version + 1 }))
      if (isCurrent()) await queryClient.invalidateQueries({ queryKey: modelsKey })
    }, {
      // A superseded operation must never clear the newer run's busy flag or
      // publish its error; the Scope gate is the runner's, the generation
      // gate is this caller's.
      onBusy: busy => { if (operationGeneration.current === generation) setApplying(busy) },
      onError: error => { if (operationGeneration.current === generation) setError(error.message) }
    })
  }, [action, models, modelsKey, queryClient])

  const apply = useCallback((assignment: MainModelAssignment) => {
    setDeclined(false)
    setPendingConfirmation(null)
    submit(assignment, false)
  }, [submit])

  const confirm = useCallback(() => {
    const pending = pendingConfirmation
    if (!pending) return
    setPendingConfirmation(null)
    submit(pending.assignment, true)
  }, [pendingConfirmation, submit])

  const decline = useCallback(() => {
    operationGeneration.current += 1
    setApplying(false)
    setPendingConfirmation(null)
    setDeclined(true)
  }, [])

  const clearStaleAuxiliary = useCallback((expectedVersion: number) => {
    setStaleReport(current => current.version === expectedVersion ? { ...current, items: [] } : current)
  }, [])

  return {
    apply,
    applying,
    clearStaleAuxiliary,
    confirm,
    decline,
    declined,
    error,
    pendingConfirmation,
    staleAuxiliary: staleReport.items,
    staleAuxiliaryVersion: staleReport.version
  }
}

export function useAuxiliaryModelEditing(
  providers: readonly ModelOptionProvider[]
): AuxiliaryModelEditing {
  const { connectionKey, models, modelsKey, profile, queryClient } = useModelEditingDependencies()
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationGeneration = useRef(0)
  const action = useScopedTask()

  useEffect(() => {
    operationGeneration.current += 1
    setApplying(false)
    setError(null)
    return () => {
      operationGeneration.current += 1
    }
  }, [connectionKey, profile])

  const submit = useCallback(async (assignment: AuxiliaryAssignment): Promise<boolean> => {
    const generation = operationGeneration.current + 1
    operationGeneration.current = generation
    const endpoint = providers.find(provider => provider.slug === assignment.provider)?.api_url
    return (await action.run(async task => {
      const isCurrent = () => task.isCurrent() && operationGeneration.current === generation
      setError(null)
      const result = await models.setAssignment({
        ...assignment,
        scope: 'auxiliary',
        ...(endpoint ? { base_url: endpoint } : {})
      })
      if (!isCurrent()) return false
      if (result.ok !== true) throw new Error('The auxiliary model assignment was not applied.')
      await queryClient.invalidateQueries({ queryKey: modelsKey })
      return isCurrent()
    }, {
      onBusy: busy => { if (operationGeneration.current === generation) setApplying(busy) },
      onError: error => { if (operationGeneration.current === generation) setError(error.message) }
    })) === true
  }, [action, models, modelsKey, providers, queryClient])

  const assign = useCallback((assignment: AuxiliaryAssignment) => submit(assignment), [submit])
  const resetAll = useCallback(
    (main: { model: string; provider: string }) => submit({ ...main, task: '__reset__' }),
    [submit]
  )

  return { applying, assign, error, resetAll }
}

type ConfigPath = 'agent.reasoning_effort' | 'agent.service_tier' | 'model_context_length' | 'fallback_providers'

interface ConfigQueueRecord {
  confirmedBaseline: unknown
  debounceReservations: number
  queuedCount: number
  tail: Promise<void>
  tailSettled: boolean
}

const configWriteQueues = new Map<string, ConfigQueueRecord>()

function queueKey(connectionKey: string, profile: null | string, path: ConfigPath): string {
  return `${connectionKey}\u0000${profileKey(profile)}\u0000${path}`
}

function getOrCreateQueue(key: string, baseline: unknown): ConfigQueueRecord {
  const existing = configWriteQueues.get(key)
  if (existing) return existing
  const created: ConfigQueueRecord = {
    confirmedBaseline: baseline,
    debounceReservations: 0,
    queuedCount: 0,
    tail: Promise.resolve(),
    tailSettled: true
  }
  configWriteQueues.set(key, created)
  return created
}

function removeIdleQueue(key: string, record: ConfigQueueRecord): void {
  if (
    configWriteQueues.get(key) === record &&
    record.queuedCount === 0 &&
    record.debounceReservations === 0 &&
    record.tailSettled
  ) {
    configWriteQueues.delete(key)
  }
}

function enqueueConfigWrite(
  key: string,
  record: ConfigQueueRecord,
  operation: () => Promise<void>
): void {
  record.queuedCount += 1
  record.tailSettled = false
  const current = record.tail.catch(() => undefined).then(operation)
  record.tail = current
  void current.then(
    () => settle(),
    () => settle()
  )

  function settle() {
    record.queuedCount -= 1
    if (record.tail === current) record.tailSettled = true
    removeIdleQueue(key, record)
  }
}

function configValuesEqual(path: ConfigPath, current: unknown, submitted: unknown): boolean {
  if (path === 'fallback_providers') {
    return fallbackEntriesEqual(
      normalizeFallbackEntries(current),
      normalizeFallbackEntries(submitted)
    )
  }
  return Object.is(current, submitted)
}

interface PendingDebounce {
  generation: number
  key: string
  path: ConfigPath
  queryKey: QueryKey
  queryClient: QueryClient
  record: ConfigQueueRecord
  submitted: unknown
  task: ScopedTask
  timer: number
}

export function useModelConfigEditing(
  config: HermesConfigRecord | undefined
): ModelConfigEditing {
  const { configKey, connectionKey, models, profile, queryClient } = useModelEditingDependencies()
  const [error, setError] = useState<string | null>(null)
  const fieldGenerations = useRef(new Map<ConfigPath, number>())
  const timers = useRef(new Map<ConfigPath, PendingDebounce>())

  const cancelDebounce = useCallback((pending: PendingDebounce, restore: boolean) => {
    window.clearTimeout(pending.timer)
    timers.current.delete(pending.path)
    pending.record.debounceReservations -= 1
    if (restore) {
      pending.queryClient.setQueryData<HermesConfigRecord>(pending.queryKey, current => {
        if (!current || !configValuesEqual(pending.path, getConfigValue(current, pending.path), pending.submitted)) return current
        return setConfigValue(current, pending.path, pending.record.confirmedBaseline)
      })
    }
    removeIdleQueue(pending.key, pending.record)
  }, [])

  useEffect(() => {
    setError(null)
    return () => {
      for (const path of fieldGenerations.current.keys()) {
        fieldGenerations.current.set(path, (fieldGenerations.current.get(path) ?? 0) + 1)
      }
      for (const pending of [...timers.current.values()]) cancelDebounce(pending, true)
    }
  }, [cancelDebounce, connectionKey, profile])

  const writeField = useCallback((path: ConfigPath, submitted: unknown, debounce: boolean) => {
    const currentConfig = queryClient.getQueryData<HermesConfigRecord>(configKey) ?? config
    if (!currentConfig) return

    const generation = (fieldGenerations.current.get(path) ?? 0) + 1
    fieldGenerations.current.set(path, generation)
    const task = beginScopedTask()
    const key = queueKey(connectionKey, profile, path)
    const existingTimer = timers.current.get(path)
    const record = getOrCreateQueue(key, getConfigValue(currentConfig, path))

    if (existingTimer) {
      window.clearTimeout(existingTimer.timer)
      timers.current.delete(path)
    } else if (debounce) {
      record.debounceReservations += 1
    }

    queryClient.setQueryData<HermesConfigRecord>(configKey, current =>
      setConfigValue(current ?? currentConfig, path, submitted)
    )
    setError(null)

    const run = () => {
      enqueueConfigWrite(key, record, async () => {
        if (!task.isCurrent() || fieldGenerations.current.get(path) !== generation) return
        let sent = false
        try {
          sent = true
          await models.saveConfig(setConfigValue({}, path, submitted))
          record.confirmedBaseline = submitted
        } catch (caught) {
          const currentOperation = task.isCurrent() && fieldGenerations.current.get(path) === generation
          if (currentOperation) {
            queryClient.setQueryData<HermesConfigRecord>(configKey, current => {
              if (!current || !configValuesEqual(path, getConfigValue(current, path), submitted)) return current
              return setConfigValue(current, path, record.confirmedBaseline)
            })
            setError(errorMessage(caught))
            void queryClient.invalidateQueries({ queryKey: configKey, refetchType: 'none' })
          }
        } finally {
          if (sent && !task.isCurrent()) {
            void queryClient.invalidateQueries({ queryKey: configKey, refetchType: 'none' })
          }
        }
      })
    }

    if (!debounce) {
      run()
      return
    }

    const pending: PendingDebounce = {
      generation,
      key,
      path,
      queryClient,
      queryKey: configKey,
      record,
      submitted,
      task,
      timer: 0
    }
    pending.timer = window.setTimeout(() => {
      if (timers.current.get(path) !== pending) return
      timers.current.delete(path)
      record.debounceReservations -= 1
      if (!task.isCurrent() || fieldGenerations.current.get(path) !== generation) {
        removeIdleQueue(key, record)
        return
      }
      run()
    }, CONFIG_SAVE_DEBOUNCE_MS)
    timers.current.set(path, pending)
  }, [config, configKey, connectionKey, models, profile, queryClient])

  const setReasoningEffort = useCallback(
    (value: string) => writeField('agent.reasoning_effort', value, false),
    [writeField]
  )
  const setFastTier = useCallback(
    (enabled: boolean) => writeField('agent.service_tier', enabled ? 'fast' : 'normal', false),
    [writeField]
  )
  const setContextLength = useCallback(
    (value: number) => writeField('model_context_length', value, true),
    [writeField]
  )
  const setFallbacks = useCallback(
    (entries: readonly FallbackEntry[]) => writeField('fallback_providers', [...entries], true),
    [writeField]
  )

  return { error, setContextLength, setFallbacks, setFastTier, setReasoningEffort }
}
