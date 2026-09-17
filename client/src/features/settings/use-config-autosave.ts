import { useQueryClient, type QueryKey } from '@tanstack/react-query'
import { useRef, useState } from 'react'

import { getConfigValue, setConfigValue } from '~/features/models/helpers'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { beginScopedTask, useScopeReset, type ScopedTask } from '~/gateway/scope-guard'
import type { HermesConfigRecord } from '~/lib/types'
import type { SettingsApi } from './settings-api'

const SAVE_DELAY_MS = 450

type ConfigOperation = {
  epoch: number
  path: string
  queryKey: QueryKey
  ready: boolean
  revision: number
  task: ScopedTask
  value: unknown
}

type FieldRecord = {
  confirmed: unknown
  draft: unknown
  hasDraft: boolean
  revision: number
  timer?: number
}

export interface UseConfigAutosaveOptions {
  category: string
  config: HermesConfigRecord | undefined
  queryKey: QueryKey
  settings: Pick<SettingsApi, 'savePartial'>
}

export interface ConfigAutosave {
  error: string | null
  valueFor(path: string): unknown
  change(path: string, value: unknown): void
}

export function useConfigAutosave({ category, config, queryKey, settings }: UseConfigAutosaveOptions): ConfigAutosave {
  const queryClient = useQueryClient()
  const [drafts, setDrafts] = useState<Record<string, unknown>>({})
  const [error, setError] = useState<string | null>(null)
  const fields = useRef(new Map<string, FieldRecord>())
  const pending = useRef(new Map<string, ConfigOperation>())
  const active = useRef<{ controller: AbortController; operation: ConfigOperation } | null>(null)
  const epoch = useRef(0)
  const needsInvalidation = useRef(false)

  const removeDraft = (path: string) => setDrafts(current => {
    if (!Object.prototype.hasOwnProperty.call(current, path)) return current
    const next = { ...current }
    delete next[path]
    return next
  })

  const restoreOwnedDraft = (operation: ConfigOperation, updateState: boolean) => {
    const record = fields.current.get(operation.path)
    if (!record || record.revision !== operation.revision) return
    queryClient.setQueryData<HermesConfigRecord>(operation.queryKey, current => {
      if (!current || !Object.is(getConfigValue(current, operation.path), record.draft)) return current
      return setConfigValue(current, operation.path, record.confirmed)
    })
    record.hasDraft = false
    if (updateState) removeDraft(operation.path)
  }

  const laneIsIdle = () => active.current === null && pending.current.size === 0

  const invalidateIfIdle = (capturedKey: QueryKey) => {
    if (!laneIsIdle() || !needsInvalidation.current) return
    needsInvalidation.current = false
    void queryClient.invalidateQueries({ queryKey: capturedKey })
  }

  const drain = () => {
    if (active.current) return
    const operation = [...pending.current.values()].find(candidate => candidate.ready)
    if (!operation) {
      invalidateIfIdle(queryKey)
      return
    }
    if (operation.epoch !== epoch.current || !operation.task.isCurrent()) {
      pending.current.delete(operation.path)
      drain()
      return
    }

    pending.current.delete(operation.path)
    const controller = new AbortController()
    active.current = { controller, operation }
    void settings.savePartial(setConfigValue({}, operation.path, operation.value), controller.signal).then(result => {
      if (controller.signal.aborted || operation.epoch !== epoch.current || !operation.task.isCurrent()) return
      if (!result.ok) throw new Error('The gateway rejected this setting.')

      needsInvalidation.current = true
      const record = fields.current.get(operation.path)
      if (!record) return
      record.confirmed = operation.value
      if (record.revision === operation.revision) {
        record.hasDraft = false
        removeDraft(operation.path)
        setError(null)
      }
    }).catch(caught => {
      if (controller.signal.aborted || operation.epoch !== epoch.current || !operation.task.isCurrent()) return
      const record = fields.current.get(operation.path)
      if (!record || record.revision !== operation.revision) return

      const cached = queryClient.getQueryData<HermesConfigRecord>(queryKey)
      if (cached && Object.is(getConfigValue(cached, operation.path), operation.value)) {
        queryClient.setQueryData(queryKey, setConfigValue(cached, operation.path, record.confirmed))
      } else {
        needsInvalidation.current = true
      }
      record.hasDraft = false
      removeDraft(operation.path)
      setError(classifyGatewayError(caught).message)
    }).finally(() => {
      if (active.current?.operation === operation) active.current = null
      if (operation.epoch === epoch.current && operation.task.isCurrent()) drain()
      else restoreOwnedDraft(operation, true)
    })
  }

  useScopeReset(() => {
    epoch.current += 1
    setDrafts({})
    setError(null)
    return () => {
      epoch.current += 1
      const uncertainRequest = active.current !== null
      for (const record of fields.current.values()) {
        if (record.timer !== undefined) window.clearTimeout(record.timer)
      }
      for (const [path, record] of fields.current) {
        if (!record.hasDraft) continue
        queryClient.setQueryData<HermesConfigRecord>(queryKey, current => {
          if (!current || !Object.is(getConfigValue(current, path), record.draft)) return current
          return setConfigValue(current, path, record.confirmed)
        })
      }
      pending.current.clear()
      active.current?.controller.abort()
      active.current = null
      fields.current.clear()
      if (uncertainRequest || needsInvalidation.current) {
        needsInvalidation.current = false
        void queryClient.invalidateQueries({ queryKey, refetchType: 'none' })
      }
    }
  }, category, settings.savePartial)

  const valueFor = (path: string) => Object.prototype.hasOwnProperty.call(drafts, path)
    ? drafts[path]
    : getConfigValue(queryClient.getQueryData<HermesConfigRecord>(queryKey) ?? config, path)

  const change = (path: string, value: unknown) => {
    const currentConfig = queryClient.getQueryData<HermesConfigRecord>(queryKey) ?? config
    let record = fields.current.get(path)
    if (!record) {
      record = {
        confirmed: getConfigValue(currentConfig, path),
        draft: value,
        hasDraft: true,
        revision: 0
      }
      fields.current.set(path, record)
    }
    record.revision += 1
    record.draft = value
    record.hasDraft = true
    const revision = record.revision
    const operation: ConfigOperation = {
      epoch: epoch.current,
      path,
      queryKey,
      ready: false,
      revision,
      task: beginScopedTask(),
      value
    }
    pending.current.set(path, operation)
    setDrafts(current => ({ ...current, [path]: value }))
    if (currentConfig) queryClient.setQueryData(queryKey, setConfigValue(currentConfig, path, value))

    if (record.timer !== undefined) window.clearTimeout(record.timer)
    record.timer = window.setTimeout(() => {
      const currentRecord = fields.current.get(path)
      const currentOperation = pending.current.get(path)
      if (!currentRecord || currentRecord.revision !== revision || currentOperation !== operation) return
      currentRecord.timer = undefined
      if (operation.epoch !== epoch.current || !operation.task.isCurrent()) {
        pending.current.delete(path)
        restoreOwnedDraft(operation, true)
        invalidateIfIdle(queryKey)
        return
      }
      operation.ready = true
      drain()
    }, SAVE_DELAY_MS)
  }

  return { change, error, valueFor }
}
