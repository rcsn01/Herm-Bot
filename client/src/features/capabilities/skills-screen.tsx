import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { IconBook, IconChevronRight, IconPlus, IconRefresh, IconSearch } from '@tabler/icons-react'
import { useEffect, useMemo, useState } from 'react'

import { Badge, Button, Input, Skeleton } from '~/compat/primitives'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { useGateway } from '~/gateway/gateway-context'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import { currentGatewayScope, isCurrentGatewayScope, type CurrentGatewayScope } from '~/gateway/scope-guard'
import { useStore } from '@nanostores/react'
import { $preferences } from '~/state/store'
import type { SkillInfo } from '~/lib/types'
import { SkillDetail } from './skill-detail'
import { SkillHubScreen } from './skill-hub-screen'
import { skillsApi } from './skills-api'

export interface SkillsScreenProps {
  onBack?(): void
  onOpenHub?(): void
  onSelect?(skill: SkillInfo): void
  selected?: string
}

export function SkillsScreen({ onBack, onOpenHub, onSelect, selected }: SkillsScreenProps) {
  const gateway = useGateway()
  const preferences = useStore($preferences)
  const profile = preferences.profile
  const queryClient = useQueryClient()
  const queryKey = gatewayScopeKey({ connectionKey: preferences.remoteURL, profile }, 'skills', 'list')
  const screenScope = currentGatewayScope()
  const skills = useQuery({ queryFn: ({ signal }) => skillsApi.list(gateway, profile, signal), queryKey })
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
  const toggle = useMutation<unknown, unknown, { enabled: boolean; name: string }, { previous?: SkillInfo[]; scope: CurrentGatewayScope }>({
    mutationFn: ({ name, enabled }: { enabled: boolean; name: string }) => skillsApi.toggle(gateway, profile, name, enabled),
    onError: (caught, _value, context) => {
      if (!context || !isCurrentGatewayScope(context.scope)) return
      if (context.previous) queryClient.setQueryData(queryKey, context.previous)
      setError(classifyGatewayError(caught).message)
    },
    onMutate: async ({ name, enabled }) => {
      const scope = currentGatewayScope()
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData<SkillInfo[]>(queryKey)
      if (isCurrentGatewayScope(scope)) {
        queryClient.setQueryData<SkillInfo[]>(queryKey, rows => rows?.map(row => row.name === name ? { ...row, enabled } : row))
      }
      return { previous, scope }
    },
    onSettled: (_data, _error, _variables, context) => {
      if (context && isCurrentGatewayScope(context.scope)) void queryClient.invalidateQueries({ queryKey })
    },
    onSuccess: (_data, _variables, context) => {
      if (context && isCurrentGatewayScope(context.scope)) setError(null)
    }
  })

  useEffect(() => {
    setSearch('')
    setCategory('all')
    setActivation('all')
    setError(null)
  }, [preferences.remoteURL, profile])


  const selectedSkill = selected ? skills.data?.find(skill => skill.name === selected) : undefined
  if (selected && selectedSkill && onBack) return <SkillDetail onArchived={() => { if (!isCurrentGatewayScope(screenScope)) return; void queryClient.invalidateQueries({ queryKey }); onBack() }} onBack={onBack} skill={selectedSkill} />
  if (selected && skills.data && !selectedSkill) return <section className="screen page-screen"><Button onClick={onBack} variant="text">‹ Back</Button><div className="empty-panel">That skill is no longer installed.</div></section>

  return (
    <section className="screen page-screen">
      <header className="page-heading"><div><p className="eyebrow">Capabilities</p><h2>Skills</h2></div><div className="button-row"><Button aria-label="Refresh skills" onClick={() => void skills.refetch()} size="icon-sm" variant="ghost"><IconRefresh size={18} /></Button><Button onClick={onOpenHub} size="sm" variant="secondary"><IconPlus size={16} /> Skill hub</Button></div></header>
      <p className="muted">Skills are loaded for the {profile || 'default'} profile and apply to new sessions.</p>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="search-box"><IconSearch size={17} aria-hidden="true" /><Input aria-label="Search installed skills" onChange={event => setSearch(event.target.value)} placeholder="Search installed skills" value={search} /></div>
      <div className="filter-row"><label>Category<select aria-label="Skill category" onChange={event => setCategory(event.target.value)} value={category}><option value="all">All categories</option>{categories.map(value => <option key={value} value={value}>{value}</option>)}</select></label><label>Activation<select aria-label="Skill activation" onChange={event => setActivation(event.target.value as typeof activation)} value={activation}><option value="all">All</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select></label></div>
      {skills.isPending && <div className="data-card"><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-14 w-full" /><Skeleton className="mt-2 h-14 w-full" /></div>}
      {skills.error && <div className={classifyGatewayError(skills.error).kind === 'unsupported' ? 'unsupported-card' : 'error-banner'} role="alert">{classifyGatewayError(skills.error).kind === 'unsupported' ? 'Skills are unavailable on this gateway.' : classifyGatewayError(skills.error).message}</div>}
      <div className="settings-list capability-list">
        {filtered.map(skill => <article className="capability-row" key={skill.name}><button onClick={() => onSelect?.(skill)}><IconBook size={20} /><span><strong>{skill.name}</strong><small>{skill.description || skill.category || 'No description'}</small><small>{skill.category || 'Uncategorized'} · {skill.provenance || 'unknown'}{skill.usage === undefined ? '' : ` · ${skill.usage} uses`}</small></span><IconChevronRight size={18} /></button><label className="row-switch"><span className="sr-only">Enable {skill.name}</span><input checked={skill.enabled} onChange={event => toggle.mutate({ enabled: event.target.checked, name: skill.name })} type="checkbox" /></label></article>)}
        {skills.data && filtered.length === 0 && <div className="empty-panel">No installed skills match these filters.</div>}
      </div>
    </section>
  )
}

export function SkillRoute({ skill, onBack, onArchived }: { onArchived(): void; onBack(): void; skill: SkillInfo }) {
  return <SkillDetail onArchived={onArchived} onBack={onBack} skill={skill} />
}

export { SkillHubScreen }
