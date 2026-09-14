import { useQueryClient } from '@tanstack/react-query'
import { IconChevronLeft, IconRefresh } from '@tabler/icons-react'
import { useMemo, useRef, useState } from 'react'

import { PageShell } from '~/components/page-shell'
import { Badge, Button, Skeleton } from '~/compat/primitives'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { GatewayErrorBanner } from '~/gateway/gateway-error-banner'
import { useApi } from '~/gateway/gateway-api-hooks'
import { useScopeKey, useScopedQuery, useScopeReset } from '~/gateway/scope-guard'
import { useStore } from '@nanostores/react'
import { $preferences } from '~/state/store'
import { getConfigValue, setConfigValue } from '~/features/models/helpers'
import type { ConfigFieldSchema, HermesConfigRecord } from '~/lib/types'
import { createSettingsApi } from './settings-api'
import { ConfigField } from './config-field'
import { settingsBackendSection } from './settings-registry'

const SAVE_DELAY_MS = 450

type PendingConfigSave = {
  controller?: AbortController
  generation: number
  path: string
  previous: unknown
  ready: boolean
  revision: number
  value: unknown
}

export function ConfigSectionScreen({ category, onBack }: { category: string; onBack(): void }) {
  const settings = useApi(createSettingsApi)
  const preferences = useStore($preferences)
  const profile = preferences.profile
  const entry = settingsBackendSection(category)
  const queryClient = useQueryClient()
  const key = useScopeKey('settings', ['config'])
  const schemaKey = useScopeKey('settings', ['config', 'schema'])
  const config = useScopedQuery(key, { queryFn: signal => settings.config(signal) })
  const schema = useScopedQuery(schemaKey, { queryFn: signal => settings.schema(signal) })
  const [drafts, setDrafts] = useState<Record<string, unknown>>({})
  const [error, setError] = useState<string | null>(null)
  const timers = useRef(new Map<string, number>())
  const pending = useRef(new Map<string, PendingConfigSave>())
  const active = useRef<PendingConfigSave | null>(null)
  const revisions = useRef(new Map<string, number>())
  const generation = useRef(0)
  const scopeRef = useRef({ category, profile, remoteURL: preferences.remoteURL, settings })
  scopeRef.current = { category, profile, remoteURL: preferences.remoteURL, settings }
  const fields = useMemo(() => (entry ? entry.keys.filter(path => Boolean(schema.data?.fields[path])) : []), [entry, schema.data])

  const isCurrentScope = (save: PendingConfigSave) => {
    const scope = scopeRef.current
    return save.generation === generation.current && scope.category === category && scope.settings === settings && scope.profile === profile && scope.remoteURL === preferences.remoteURL
  }

  const removeDraft = (path: string) => setDrafts(current => {
    const next = { ...current }
    delete next[path]
    return next
  })

  const drain = () => {
    if (active.current) return
    const next = [...pending.current.values()].find(item => item.ready)
    if (!next || !isCurrentScope(next)) return
    pending.current.delete(next.path)
    active.current = next
    const controller = new AbortController()
    next.controller = controller
    queryClient.setQueryData<HermesConfigRecord>(key, current => current ? setConfigValue(current, next.path, next.value) : current)
    void settings.savePartial(setConfigValue({}, next.path, next.value), controller.signal).then(result => {
      if (controller.signal.aborted || !result.ok) throw new Error(result.ok ? 'Configuration save was cancelled.' : 'The gateway rejected this setting.')
      if (!isCurrentScope(next)) return
      const newer = revisions.current.get(next.path) !== next.revision || pending.current.has(next.path)
      if (!newer) {
        removeDraft(next.path)
        setError(null)
        void queryClient.invalidateQueries({ queryKey: key })
      }
    }).catch(caught => {
      if (controller.signal.aborted || !isCurrentScope(next)) return
      const newer = revisions.current.get(next.path) !== next.revision || pending.current.has(next.path)
      if (newer) return
      queryClient.setQueryData<HermesConfigRecord>(key, current => current ? setConfigValue(current, next.path, next.previous) : current)
      removeDraft(next.path)
      setError(classifyGatewayError(caught).message)
    }).finally(() => {
      if (active.current === next) active.current = null
      if (isCurrentScope(next)) drain()
    })
  }

  const reset = () => {
    generation.current += 1
    setDrafts({})
    setError(null)
    for (const timer of timers.current.values()) window.clearTimeout(timer)
    timers.current.clear()
    pending.current.clear()
    active.current?.controller?.abort()
    active.current = null
    revisions.current.clear()
    return () => {
      for (const timer of timers.current.values()) window.clearTimeout(timer)
      timers.current.clear()
      pending.current.clear()
      active.current?.controller?.abort()
      active.current = null
    }
  }
  useScopeReset(reset, category, settings)

  const valueFor = (path: string) => Object.prototype.hasOwnProperty.call(drafts, path) ? drafts[path] : getConfigValue(config.data, path)
  const save = (path: string, value: unknown) => {
    const revision = (revisions.current.get(path) ?? 0) + 1
    revisions.current.set(path, revision)
    const activeForPath = active.current?.path === path ? active.current : null
    const queued = pending.current.get(path)
    const currentConfig = queryClient.getQueryData<HermesConfigRecord>(key) ?? config.data
    const previous = queued?.previous ?? activeForPath?.previous ?? getConfigValue(currentConfig, path)
    const next: PendingConfigSave = { generation: generation.current, path, previous, ready: false, revision, value }
    pending.current.set(path, next)
    setDrafts(current => ({ ...current, [path]: value }))
    queryClient.setQueryData<HermesConfigRecord>(key, current => current ? setConfigValue(current, path, value) : current)
    const oldTimer = timers.current.get(path)
    if (oldTimer !== undefined) window.clearTimeout(oldTimer)
    const scheduledGeneration = generation.current
    const timer = window.setTimeout(() => {
      timers.current.delete(path)
      const current = pending.current.get(path)
      if (!current || current.revision !== revision || current.generation !== scheduledGeneration || !isCurrentScope(current)) return
      current.ready = true
      drain()
    }, SAVE_DELAY_MS)
    timers.current.set(path, timer)
  }

  if (!entry) return <PageShell leading={<Button onClick={onBack} variant="text">‹ Back</Button>} title="Settings"><div className="empty-panel">This settings category is not available.</div></PageShell>
  return <PageShell actions={<><Button aria-label="Refresh settings" onClick={() => { void config.refetch(); void schema.refetch() }} size="icon-sm" variant="ghost"><IconRefresh size={18} /></Button><Badge variant="muted">{profile || 'default'}</Badge></>} eyebrow="Profile defaults" leading={<Button aria-label="Back" onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>} subtitle="These values affect new sessions. The current conversation keeps its existing prompt and tool schema." title={entry.label}>{error && <div className="error-banner" role="alert">{error}</div>}{(config.isPending || schema.isPending) && <div className="data-card"><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-14 w-full" /><Skeleton className="mt-2 h-14 w-full" /></div>}{config.error && <GatewayErrorBanner error={config.error} />}{schema.error && <GatewayErrorBanner error={schema.error} />}<div className="settings-list static">{fields.map(path => <ConfigField key={path} description={fieldLabel(path)} onChange={value => save(path, value)} schema={schema.data!.fields[path] as ConfigFieldSchema} value={valueFor(path)} />)}{config.data && schema.data && fields.length === 0 && <div className="empty-panel">This gateway does not expose editable fields for this category.</div>}</div>{category === 'voice' && <VoiceProviderResources />}</PageShell>
}

function VoiceProviderResources() {
  const settings = useApi(createSettingsApi)
  const voices = useScopedQuery(useScopeKey('settings', ['voice', 'elevenlabs']), { queryFn: signal => settings.elevenLabsVoices(signal) })
  return <section className="data-card voice-resources"><h3>Gateway voice resources</h3>{voices.isPending && <Skeleton className="h-8 w-full" />}{voices.error && <p className="muted">Voice catalog unavailable: {classifyGatewayError(voices.error).message}</p>}{voices.data && <p className="muted">{voices.data.available ? `ElevenLabs voices available: ${voices.data.voices.slice(0, 8).map(voice => voice.name).join(', ')}${voices.data.voices.length > 8 ? '…' : ''}` : 'No ElevenLabs voice catalog is configured. Audio stays on the gateway unless the selected provider supports it.'}</p>}</section>
}

function fieldLabel(path: string): string {
  const key = path.split('.').at(-1) ?? path
  return key.replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase())
}
