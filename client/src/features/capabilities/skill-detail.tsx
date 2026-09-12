import { useQueryClient } from '@tanstack/react-query'
import { IconChevronLeft, IconRefresh } from '@tabler/icons-react'
import { useEffect, useState } from 'react'

import { Badge, Button, Skeleton, Textarea } from '~/compat/primitives'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { GatewayErrorBanner } from '~/gateway/gateway-error-banner'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { useApi } from '~/gateway/gateway-api-hooks'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import { useScopeKey, useScopeReset, useScopedMutation, useScopedQuery } from '~/gateway/scope-guard'
import { profileKey } from '~/gateway/profile-path'
import type { SkillInfo } from '~/lib/types'
import { createSkillsApi } from './skills-api'

export function SkillDetail({ skill, onBack, onArchived }: { skill: SkillInfo; onArchived(): void; onBack(): void }) {
  const skillsApi = useApi(createSkillsApi)
  const queryClient = useQueryClient()
  const queryKey = useScopeKey('skills', ['content', skill.name])
  const content = useScopedQuery(queryKey, { queryFn: signal => skillsApi.content(skill.name, signal) })
  const [draft, setDraft] = useState('')
  const [remove, setRemove] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (content.data) setDraft(content.data.content)
  }, [content.data])

  useScopeReset(() => {
    setDraft('')
    setRemove(false)
    setError(null)
  }, skill.name)

  const save = useScopedMutation<void, string>({
    mutationFn: nextDraft => skillsApi.updateContent(skill.name, nextDraft).then(() => undefined),
    onError: caught => setError(classifyGatewayError(caught).message),
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey })
    }
  })
  const archive = useScopedMutation<void, void>({
    mutationFn: () => skillsApi.archiveLearningNode(skill.name).then(() => undefined),
    onError: caught => setError(classifyGatewayError(caught).message),
    onSuccess: () => {
      setRemove(false)
      onArchived()
    }
  })
  const canEdit = skill.provenance === 'agent'

  return (
    <section className="screen page-screen">
      <header className="page-heading">
        <Button aria-label="Back" onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>
        <Button aria-label="Refresh skill" onClick={() => void content.refetch()} size="icon-sm" variant="ghost"><IconRefresh size={18} /></Button>
      </header>
      <div className="page-heading"><div><p className="eyebrow">Skill detail</p><h2>{skill.name}</h2></div><Badge variant="muted">{skill.provenance ?? 'unknown'}</Badge></div>
      <p className="muted">{skill.description || 'No description provided.'}</p>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {content.isPending && <div className="data-card"><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-56 w-full" /></div>}
      {content.error && <GatewayErrorBanner error={content.error} />}
      {content.data && (
        <div className="panel-stack">
          {canEdit ? <Textarea aria-label="SKILL.md" onChange={event => setDraft(event.target.value)} value={draft} /> : <pre className="file-content">{draft}</pre>}
          {canEdit && <div className="button-row"><Button disabled={save.isPending || draft === content.data.content} onClick={() => save.mutate(draft)}>Save skill</Button><Button disabled={archive.isPending} onClick={() => setRemove(true)} variant="destructive">Archive learned skill</Button></div>}
          {!canEdit && <p className="muted">Bundled and hub skills are read-only here. Learned-skill actions are not available for this provenance.</p>}
        </div>
      )}
      {remove && <ConfirmDialog confirmLabel="Archive" description={`Archive learned skill ${skill.name}? It can be restored from the skill archive.`} onCancel={() => setRemove(false)} onConfirm={() => archive.mutate()} title="Archive learned skill" />}
    </section>
  )
}

export function skillDetailQueryKey(connectionKey: string, profile: null | string, name: string) {
  return gatewayScopeKey({ connectionKey, profile: profileKey(profile) }, 'skills', 'content', name)
}
