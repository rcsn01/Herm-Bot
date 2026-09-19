import { useCallback, useEffect, useRef, useState } from 'react'

import { classifyGatewayError, GatewayError, type GatewayError as GatewayErrorValue } from './gateway-error'
import type { GatewayPort } from './gateway-port'
import { beginScopedTask, useScopeReset, type ScopedTask } from './scope-guard'
import { runRemoteAction } from './remote-action'

export type OAuthPhase = 'approved' | 'denied' | 'error' | 'expired' | 'waiting'

export interface OAuthFlowSnapshot {
  authorizationURL?: string
  flowId?: string
  message?: string
  phase: OAuthPhase
  userCode?: string
}

export interface OAuthFlowAdapter {
  readonly gateway: GatewayPort
  readonly polling?: {
    intervalMs?: number
    maxAttempts?: number
    maxIntervalMs?: number
  }
  start(signal: AbortSignal): Promise<OAuthFlowSnapshot>
  poll(current: OAuthFlowSnapshot, signal: AbortSignal): Promise<OAuthFlowSnapshot>
}

export interface OAuthFlowController {
  readonly busy: boolean
  readonly error: GatewayErrorValue | null
  readonly snapshot: OAuthFlowSnapshot | null
  start(adapter: OAuthFlowAdapter): void
  stop(): void
  openAuthorization(): Promise<void>
}

const OAUTH_TIMEOUT_MESSAGE = 'OAuth authorization timed out. Start authorization again if needed.'
const phases = new Set<OAuthPhase>(['approved', 'denied', 'error', 'expired', 'waiting'])

interface ActiveRun {
  controller: AbortController
  generation: number
  task: ScopedTask
}

function normalizeSnapshot(value: OAuthFlowSnapshot): OAuthFlowSnapshot {
  if (!value || typeof value !== 'object' || !phases.has(value.phase)) {
    throw new Error('The OAuth adapter returned an invalid flow phase.')
  }
  for (const [key, candidate] of Object.entries(value)) {
    if (candidate !== undefined && typeof candidate !== 'string' && key !== 'phase') {
      throw new Error(`The OAuth adapter returned an invalid ${key}.`)
    }
  }
  return { ...value }
}

function mergeSnapshot(previous: OAuthFlowSnapshot | null, next: OAuthFlowSnapshot): OAuthFlowSnapshot {
  const merged = { ...(previous ?? {}), ...next }
  return {
    ...merged,
    authorizationURL: next.authorizationURL ?? previous?.authorizationURL,
    flowId: next.flowId ?? previous?.flowId,
    userCode: next.userCode ?? previous?.userCode
  }
}

export function useOAuthFlow({ openExternal }: { openExternal?: (url: string) => Promise<void> }): OAuthFlowController {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<GatewayErrorValue | null>(null)
  const [snapshot, setSnapshot] = useState<OAuthFlowSnapshot | null>(null)
  const activeRunRef = useRef<ActiveRun | null>(null)
  const generationRef = useRef(0)
  const mountedRef = useRef(true)
  const snapshotRef = useRef<OAuthFlowSnapshot | null>(null)

  const publishSnapshot = useCallback((next: OAuthFlowSnapshot | null) => {
    snapshotRef.current = next
    setSnapshot(next)
  }, [])

  const reset = useCallback(() => {
    generationRef.current += 1
    const active = activeRunRef.current
    activeRunRef.current = null
    active?.controller.abort()
    if (!mountedRef.current) return
    publishSnapshot(null)
    setError(null)
    setBusy(false)
  }, [publishSnapshot])

  useScopeReset(reset)

  useEffect(() => () => {
    mountedRef.current = false
    generationRef.current += 1
    const active = activeRunRef.current
    activeRunRef.current = null
    active?.controller.abort()
  }, [])

  const start = useCallback((adapter: OAuthFlowAdapter) => {
    if (activeRunRef.current) return

    const generation = generationRef.current + 1
    generationRef.current = generation
    const active: ActiveRun = {
      controller: new AbortController(),
      generation,
      task: beginScopedTask()
    }
    activeRunRef.current = active
    publishSnapshot(null)
    setError(null)
    setBusy(true)

    const isCurrentRun = () => {
      const current = activeRunRef.current
      return mountedRef.current
        && current?.generation === generation
        && current === active
        && active.task.isCurrent()
    }

    const openStartedURL = async (started: OAuthFlowSnapshot) => {
      if (!started.authorizationURL || !openExternal || !isCurrentRun()) return
      try {
        await openExternal(started.authorizationURL)
      } catch (caught) {
        if (isCurrentRun()) setError(classifyGatewayError(caught))
      }
    }

    const run = async () => {
      let current: OAuthFlowSnapshot | null = null
      const publish = (candidate: OAuthFlowSnapshot): OAuthFlowSnapshot => {
        current = mergeSnapshot(current, candidate)
        if (isCurrentRun()) publishSnapshot(current)
        return current
      }

      try {
        const state = await runRemoteAction<OAuthFlowSnapshot>({
          gateway: adapter.gateway,
          intervalMs: adapter.polling?.intervalMs,
          isComplete: candidate => candidate.result?.phase !== 'waiting',
          isCurrentScope: () => active.task.isCurrent(),
          maxAttempts: adapter.polling?.maxAttempts,
          maxIntervalMs: adapter.polling?.maxIntervalMs,
          poll: async (_gateway, signal) => {
            if (!current) throw new Error('OAuth polling started without a flow snapshot.')
            const next = publish(normalizeSnapshot(await adapter.poll(current, signal)))
            return { result: next, status: next.phase }
          },
          signal: active.controller.signal,
          start: async (_gateway, signal) => {
            const started = publish(normalizeSnapshot(await adapter.start(signal)))
            void openStartedURL(started)
            return { result: started, status: started.phase }
          },
          timeoutError: attempts => new GatewayError(OAUTH_TIMEOUT_MESSAGE, {
            code: 'OAUTH_TIMEOUT',
            details: { attempts },
            kind: 'server',
            retryable: false
          })
        })

        if (!isCurrentRun()) return
        if (state.result) publishSnapshot(state.result)
        activeRunRef.current = null
        setBusy(false)
        setError(null)
      } catch (caught) {
        const currentRun = activeRunRef.current
        if (!mountedRef.current || currentRun !== active || !active.task.isCurrent()) {
          if (currentRun === active) activeRunRef.current = null
          return
        }
        const classified = classifyGatewayError(caught)
        activeRunRef.current = null
        setBusy(false)
        if (classified.kind === 'aborted') {
          publishSnapshot(null)
          setError(null)
          return
        }
        const failed = mergeSnapshot(current, { message: classified.message, phase: 'error' })
        publishSnapshot(failed)
        setError(classified)
      }
    }

    void run()
  }, [openExternal, publishSnapshot])

  const stop = useCallback(() => reset(), [reset])

  const openAuthorization = useCallback(async () => {
    const current = snapshotRef.current
    if (!current?.authorizationURL || !openExternal) return
    const generation = generationRef.current
    const task = beginScopedTask()
    setError(null)
    try {
      await openExternal(current.authorizationURL)
    } catch (caught) {
      if (mountedRef.current && generationRef.current === generation && task.isCurrent()) {
        setError(classifyGatewayError(caught))
      }
    }
  }, [openExternal])

  return { busy, error, openAuthorization, snapshot, start, stop }
}
