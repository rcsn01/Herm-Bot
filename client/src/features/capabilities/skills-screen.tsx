import { useQueryClient } from '@tanstack/react-query'
import { IconBook, IconChevronLeft, IconChevronRight, IconPlus, IconRefresh, IconSearch } from '@tabler/icons-react'
import { useMemo, useState } from 'react'

import { PageShell } from '~/components/page-shell'
import { Button, Input, Skeleton } from '~/compat/primitives'
import { GatewayErrorBanner } from '~/gateway/gateway-error-banner'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { useApi } from '~/gateway/gateway-api-hooks'
import { beginScopedTask, useScopeKey, useScopeReset, useScopedMutation, useScopedQuery } from '~/gateway/scope-guard'
import { useStore } from '@nanostores/react'
import { $preferences } from '~/state/store'
import type { SkillInfo } from '~/lib/types'
import { SkillDetail } from './skill-detail'
import { SkillHubScreen } from './skill-hub-screen'
import { createSkillsApi } from './skills-api'

export interface SkillsScreenProps {
  onBack?(): void
  onOpenHub?(): void
  onSelect?(skill: SkillInfo): void
  selected?: string
}

export function SkillsScreen({ onBack, onOpenHub, onSelect, selected }: SkillsScreenProps) {
  const skillsApi = useApi(createSkillsApi)
  const preferences = useStore($preferences)
  const profile = preferences.profile
  const queryClient = useQueryClient()
  const queryKey = useScopeKey('skills', ['list'])
  const skills = useScopedQuery(queryKey, { queryFn: signal => skillsApi.list(signal) })
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [activation, setActivation] = useState<'all' | 'disabled' | 'enabled'>('all')
  const [error, setError] = useState<string | null>(null)
  const categories = useMemo(() => [...new Set((skills.data ?? []).map(skill => skill.category).filter(Boolean))].sort(), [skills.data])
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return (skills.data ?? []).filter(skill =>
      (!term || `${skill.name} ${skill.description}`.toLowerCase().includes(term)) &&
      (category === 'all' || skill.category === category) &&
      (activation === 'all' || (activation === 'enabled' && skill.enabled) || (activation === 'disabled' && !skill.enabled))
    )
  }, [activation, category, search, skills.data])
  const toggle = useScopedMutation<unknown, { enabled: boolean; name: string }, SkillInfo[]>({
    mutationFn: ({ name, enabled }) => skillsApi.toggle(name, enabled),
    optimistic: {
      queryKey,
      apply: (rows, { name, enabled }) => rows?.map(row => row.name === name ? { ...row, enabled } : row)
    },
    onError: caught => setError(classifyGatewayError(caught).message),
    onSuccess: () => setError(null)
  })

  useScopeReset(() => {
    setSearch('')
    setCategory('all')
    setActivation('all')
    setError(null)
  })


  const selectedSkill = selected ? skills.data?.find(skill => skill.name === selected) : undefined
  if (selected && selectedSkill && onBack) return <SkillDetail onArchived={() => { const task = beginScopedTask(); if (!task.isCurrent()) return; void queryClient.invalidateQueries({ queryKey }); onBack() }} onBack={onBack} skill={selectedSkill} />
  if (selected && skills.data && !selectedSkill) return <PageShell leading={<Button aria-label="Back" onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>} title="Skills"><div className="empty-panel">That skill is no longer installed.</div></PageShell>

  return (
    <PageShell
      actions={<div className="button-row"><Button aria-label="Refresh skills" onClick={() => void skills.refetch()} size="icon-sm" variant="ghost"><IconRefresh size={18} /></Button><Button onClick={onOpenHub} size="sm" variant="secondary"><IconPlus size={16} /> Skill hub</Button></div>}
      eyebrow="Capabilities"
      leading={onBack && <Button aria-label="Back" onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>}
      subtitle={`Skills are loaded for the ${profile || 'default'} profile and apply to new sessions.`}
      title="Skills"
    >
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="search-box"><IconSearch size={17} aria-hidden="true" /><Input aria-label="Search installed skills" onChange={event => setSearch(event.target.value)} placeholder="Search installed skills" value={search} /></div>
      <div className="filter-row"><label>Category<select aria-label="Skill category" onChange={event => setCategory(event.target.value)} value={category}><option value="all">All categories</option>{categories.map(value => <option key={value} value={value}>{value}</option>)}</select></label><label>Activation<select aria-label="Skill activation" onChange={event => setActivation(event.target.value as typeof activation)} value={activation}><option value="all">All</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select></label></div>
      {skills.isPending && <div className="data-card"><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-14 w-full" /><Skeleton className="mt-2 h-14 w-full" /></div>}
      {skills.error && <GatewayErrorBanner error={skills.error} unsupportedText="Skills are unavailable on this gateway." />}
      <div className="settings-list capability-list">
        {filtered.map(skill => <article className="capability-row" key={skill.name}><button onClick={() => onSelect?.(skill)}><IconBook size={20} /><span><strong>{skill.name}</strong><small>{skill.description || skill.category || 'No description'}</small><small>{skill.category || 'Uncategorized'} · {skill.provenance || 'unknown'}{skill.usage === undefined ? '' : ` · ${skill.usage} uses`}</small></span><IconChevronRight size={18} /></button><label className="row-switch"><span className="sr-only">Enable {skill.name}</span><input checked={skill.enabled} onChange={event => toggle.mutate({ enabled: event.target.checked, name: skill.name })} type="checkbox" /></label></article>)}
        {skills.data && filtered.length === 0 && <div className="empty-panel">No installed skills match these filters.</div>}
      </div>
    </PageShell>
  )
}

export function SkillRoute({ skill, onBack, onArchived }: { onArchived(): void; onBack(): void; skill: SkillInfo }) {
  return <SkillDetail onArchived={onArchived} onBack={onBack} skill={skill} />
}

export { SkillHubScreen }
