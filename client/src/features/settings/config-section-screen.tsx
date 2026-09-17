import { IconChevronLeft, IconRefresh } from '@tabler/icons-react'
import { useMemo } from 'react'

import { PageShell } from '~/components/page-shell'
import { Badge, Button, Skeleton } from '~/compat/primitives'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { GatewayErrorBanner } from '~/gateway/gateway-error-banner'
import { useApi } from '~/gateway/gateway-api-hooks'
import { useScopeKey, useScopedQuery } from '~/gateway/scope-guard'
import { useStore } from '@nanostores/react'
import { $preferences } from '~/state/store'
import { sentenceCaseLabel } from '~/lib/labels'
import type { ConfigFieldSchema } from '~/lib/types'
import { createSettingsApi } from './settings-api'
import { ConfigField } from './config-field'
import { settingsBackendSection } from './settings-registry'
import { useConfigAutosave } from './use-config-autosave'

export function ConfigSectionScreen({ category, onBack }: { category: string; onBack(): void }) {
  const settings = useApi(createSettingsApi)
  const preferences = useStore($preferences)
  const profile = preferences.profile
  const entry = settingsBackendSection(category)
  const key = useScopeKey('settings', ['config'])
  const schemaKey = useScopeKey('settings', ['config', 'schema'])
  const config = useScopedQuery(key, { queryFn: signal => settings.config(signal) })
  const schema = useScopedQuery(schemaKey, { queryFn: signal => settings.schema(signal) })
  const autosave = useConfigAutosave({ category, config: config.data, queryKey: key, settings })
  const fields = useMemo(() => (entry ? entry.keys.filter(path => Boolean(schema.data?.fields[path])) : []), [entry, schema.data])

  if (!entry) return <PageShell leading={<Button aria-label="Back" onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>} title="Settings"><div className="empty-panel">This settings category is not available.</div></PageShell>
  return <PageShell actions={<><Button aria-label="Refresh settings" onClick={() => { void config.refetch(); void schema.refetch() }} size="icon-sm" variant="ghost"><IconRefresh size={18} /></Button><Badge variant="muted">{profile || 'default'}</Badge></>} eyebrow="Profile defaults" leading={<Button aria-label="Back" onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>} subtitle="These values affect new sessions. The current conversation keeps its existing prompt and tool schema." title={entry.label}>{autosave.error && <div className="error-banner" role="alert">{autosave.error}</div>}{(config.isPending || schema.isPending) && <div className="data-card"><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-14 w-full" /><Skeleton className="mt-2 h-14 w-full" /></div>}{config.error && <GatewayErrorBanner error={config.error} />}{schema.error && <GatewayErrorBanner error={schema.error} />}<div className="settings-list static">{fields.map(path => <ConfigField key={path} description={fieldLabel(path)} onChange={value => autosave.change(path, value)} schema={schema.data!.fields[path] as ConfigFieldSchema} value={autosave.valueFor(path)} />)}{config.data && schema.data && fields.length === 0 && <div className="empty-panel">This gateway does not expose editable fields for this category.</div>}</div>{category === 'voice' && <VoiceProviderResources />}</PageShell>
}

function VoiceProviderResources() {
  const settings = useApi(createSettingsApi)
  const voices = useScopedQuery(useScopeKey('settings', ['voice', 'elevenlabs']), { queryFn: signal => settings.elevenLabsVoices(signal) })
  return <section className="data-card voice-resources"><h3>Gateway voice resources</h3>{voices.isPending && <Skeleton className="h-8 w-full" />}{voices.error && <p className="muted">Voice catalog unavailable: {classifyGatewayError(voices.error).message}</p>}{voices.data && <p className="muted">{voices.data.available ? `ElevenLabs voices available: ${voices.data.voices.slice(0, 8).map(voice => voice.name).join(', ')}${voices.data.voices.length > 8 ? '…' : ''}` : 'No ElevenLabs voice catalog is configured. Audio stays on the gateway unless the selected provider supports it.'}</p>}</section>
}

function fieldLabel(path: string): string {
  const key = path.split('.').at(-1) ?? path
  return sentenceCaseLabel(key)
}
