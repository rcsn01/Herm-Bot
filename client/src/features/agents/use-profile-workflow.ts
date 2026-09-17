import { useCallback, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { useApi } from '~/gateway/gateway-api-hooks'
import { useScopeKey, useScopedQuery, useScopedTask, useScopeReset } from '~/gateway/scope-guard'

import {
  createAgentsApi,
  type AgentModelOptionsResult,
  type AgentRosterPage
} from './agents-api'
import {
  createProfileWorkflow,
  type ProfileAdvancedState,
  type ProfileAvatarBaseline,
  type ProfileSaveCommand,
  type ProfileWorkflowMode
} from './profile-workflow'

export interface UseProfileWorkflowOptions {
  advancedOpen: boolean
  advancedSource: string | null
  avatar: null | {
    hasAsset: boolean
    inlineImage: string | null
    name: string
  }
  mode: ProfileWorkflowMode
  onSaved(result: { name: string; warning?: string }): void
  open: boolean
}

export interface UseProfileWorkflowResult {
  advanced: { data: ProfileAdvancedState | null; error: string | null; loading: boolean }
  avatar: { baseline: ProfileAvatarBaseline | null; loading: boolean }
  modelOptions: { data: AgentModelOptionsResult | undefined; error: string | null; loading: boolean }
  roster: { data: AgentRosterPage | undefined; error: string | null; loading: boolean }
  generateAvatar(prompt: string): Promise<string | null>
  mutation: {
    busy: boolean
    clearError(): void
    confirmation: string | null
    error: string | null
    submit(command: ProfileSaveCommand): void
    confirm(): void
    declineConfirmation(): void
  }
}

export function useProfileWorkflow(options: UseProfileWorkflowOptions): UseProfileWorkflowResult {
  const agents = useApi(createAgentsApi)
  const workflow = useMemo(() => createProfileWorkflow(agents), [agents])
  const queryClient = useQueryClient()
  const action = useScopedTask()
  const rosterKey = useScopeKey('agents', ['roster'], { unscoped: true })
  const modelOptionsKey = useScopeKey('agents', ['model-options'], { unscoped: true })
  const advancedKey = useScopeKey('agents', ['profile-advanced', options.mode, options.advancedSource ?? ''], { unscoped: true })
  const avatarKey = useScopeKey('agents', ['profile-avatar', options.avatar?.name ?? ''], { unscoped: true })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const confirmationResolver = useRef<((approved: boolean) => void) | null>(null)
  const operationGeneration = useRef(0)
  const onSavedRef = useRef(options.onSaved)
  onSavedRef.current = options.onSaved

  const roster = useScopedQuery(rosterKey, {
    enabled: options.open && options.advancedOpen && options.mode !== 'edit',
    queryFn: signal => agents.list(signal),
    retry: false
  })
  const modelOptions = useScopedQuery(modelOptionsKey, {
    enabled: options.open && options.advancedOpen,
    queryFn: signal => agents.modelOptions(signal),
    retry: false
  })
  const advanced = useScopedQuery(advancedKey, {
    enabled: options.open && options.advancedOpen && Boolean(options.advancedSource),
    queryFn: signal => workflow.loadAdvanced({ mode: options.mode, source: options.advancedSource!, signal }),
    retry: false
  })
  const needsAvatarFetch = options.open && options.mode === 'edit' && Boolean(options.avatar?.hasAsset && !options.avatar.inlineImage)
  const avatarQuery = useScopedQuery(avatarKey, {
    enabled: needsAvatarFetch,
    queryFn: signal => workflow.loadAvatar({
      hasAsset: options.avatar!.hasAsset,
      inlineImage: options.avatar!.inlineImage,
      name: options.avatar!.name,
      signal
    }),
    retry: false
  })

  const invalidateCurrent = useCallback(() => {
    operationGeneration.current += 1
    const resolver = confirmationResolver.current
    confirmationResolver.current = null
    resolver?.(false)
  }, [])
  const cancelCurrent = useCallback(() => {
    invalidateCurrent()
    setBusy(false)
    setError(null)
    setConfirmation(null)
  }, [invalidateCurrent])

  useScopeReset(() => {
    cancelCurrent()
    // Cleanup can run during unmount, so invalidate pending work without
    // scheduling state updates on a component that is leaving the tree.
    return invalidateCurrent
  }, options.open, options.mode, options.avatar?.name ?? '')

  const generateAvatar = useCallback(async (prompt: string): Promise<string | null> => {
    const capturedGeneration = operationGeneration.current
    let failure: Error | null = null
    const result = await action.run(
      task => workflow.generateAvatar(prompt).then(image => {
        if (capturedGeneration !== operationGeneration.current || !task.isCurrent()) return null
        return image
      }),
      { onError: classified => { if (capturedGeneration === operationGeneration.current) failure = classified } }
    )
    if (failure) throw failure
    return result ?? null
  }, [action, workflow])

  const settleConfirmation = useCallback((approved: boolean) => {
    const resolver = confirmationResolver.current
    confirmationResolver.current = null
    setConfirmation(null)
    resolver?.(approved)
  }, [])

  const submit = useCallback((command: ProfileSaveCommand) => {
    if (busy) return
    const capturedGeneration = operationGeneration.current
    const isGenerationCurrent = () => capturedGeneration === operationGeneration.current
    setError(null)
    void action.run(task => workflow.save(command, {
      confirmModel: message => {
        if (!task.isCurrent() || !isGenerationCurrent()) return Promise.resolve(false)
        return new Promise<boolean>(resolve => {
          confirmationResolver.current = resolve
          setConfirmation(message)
        })
      },
      isCurrent: () => task.isCurrent() && isGenerationCurrent()
    }), {
      onBusy: next => { if (isGenerationCurrent()) setBusy(next) },
      onError: classified => { if (isGenerationCurrent()) setError(classified.message) }
    }).then(result => {
      if (!result || result.status !== 'saved' || !isGenerationCurrent()) return
      void queryClient.invalidateQueries({ queryKey: rosterKey })
      onSavedRef.current({ name: result.name, ...(result.warning ? { warning: result.warning } : {}) })
    })
  }, [action, busy, queryClient, rosterKey, workflow])

  let avatarBaseline: ProfileAvatarBaseline | null = null
  if (options.mode === 'edit' && options.avatar) {
    if (options.avatar.inlineImage) avatarBaseline = { image: options.avatar.inlineImage, status: 'known' }
    else if (!options.avatar.hasAsset) avatarBaseline = { image: null, status: 'known' }
    else if (!avatarQuery.isFetching) avatarBaseline = avatarQuery.error ? { status: 'unknown' } : avatarQuery.data ?? { status: 'unknown' }
  }

  return {
    advanced: {
      data: advanced.isFetching || advanced.error ? null : advanced.data ?? null,
      error: advanced.error?.message ?? null,
      loading: options.open && options.advancedOpen && Boolean(options.advancedSource) && advanced.isFetching
    },
    avatar: { baseline: avatarBaseline, loading: needsAvatarFetch && avatarQuery.isFetching },
    generateAvatar,
    modelOptions: {
      data: modelOptions.data,
      error: modelOptions.error?.message ?? null,
      loading: options.open && options.advancedOpen && modelOptions.isPending
    },
    mutation: {
      busy,
      clearError: () => setError(null),
      confirmation,
      confirm: () => settleConfirmation(true),
      declineConfirmation: () => settleConfirmation(false),
      error,
      submit
    },
    roster: {
      data: roster.data,
      error: roster.error?.message ?? null,
      loading: options.open && options.advancedOpen && options.mode !== 'edit' && roster.isPending
    }
  }
}
