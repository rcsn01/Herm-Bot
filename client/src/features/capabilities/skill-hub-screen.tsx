import { useQuery, useQueryClient } from '@tanstack/react-query'
import { IconChevronLeft, IconSearch, IconShieldCheck } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'

import { Badge, Button, Input, Skeleton, Textarea } from '~/compat/primitives'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { useApi, useGatewayApi } from '~/gateway/gateway-api-hooks'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import { beginScopedTask, useScopedMutation } from '~/gateway/scope-guard'
import { useStore } from '@nanostores/react'
import { $preferences } from '~/state/store'
import { createSkillsApi, runSkillHubAction, type SkillHubPreview, type SkillHubScanResult } from './skills-api'

export function SkillHubScreen({ onBack }: { onBack(): void }) {
  const api = useGatewayApi()
  const skillsApi = useApi(createSkillsApi)
  const preferences = useStore($preferences)
  const profile = preferences.profile
  const queryClient = useQueryClient()
  const scopeKey = gatewayScopeKey({ connectionKey: preferences.remoteURL, profile }, 'skills', 'hub')
  const sources = useQuery({ queryFn: ({ signal }) => skillsApi.hubSources(signal), queryKey: [...scopeKey, 'sources'] })
  const [term, setTerm] = useState('')
  const [source, setSource] = useState('all')
  const [submitted, setSubmitted] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [preview, setPreview] = useState<SkillHubPreview | null>(null)
  const [scan, setScan] = useState<SkillHubScanResult | null>(null)
  const previewTarget = useRef<string | null>(null)
  const scanTarget = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const search = useQuery({
    enabled: submitted.trim().length > 0,
    queryFn: ({ signal }) => skillsApi.hubSearch(submitted, source, 20, signal),
    queryKey: [...scopeKey, 'search', submitted, source]
  })
  const previewMutation = useScopedMutation<SkillHubPreview, string>({
    mutationFn: identifier => skillsApi.hubPreview(identifier),
    onError: caught => setError(classifyGatewayError(caught).message),
    onSuccess: (value, identifier) => {
      if (previewTarget.current === identifier) {
        setPreview(value)
        setError(null)
      }
    }
  })
  const scanMutation = useScopedMutation<SkillHubScanResult, string>({
    mutationFn: identifier => skillsApi.hubScan(identifier),
    onError: caught => setError(classifyGatewayError(caught).message),
    onSuccess: (value, identifier) => {
      if (scanTarget.current === identifier) {
        setScan(value)
        setError(null)
      }
    }
  })
  const [install, setInstall] = useState<{ identifier: string; name: string } | null>(null)
  const installMutation = useScopedMutation<Awaited<ReturnType<typeof runSkillHubAction>>, string>({
    mutationFn: identifier => {
      const task = beginScopedTask()
      return runSkillHubAction(api, signal => skillsApi.hubInstall(identifier, signal), undefined, () => task.isCurrent())
    },
    onError: caught => setError(classifyGatewayError(caught).message),
    onSuccess: () => {
      setInstall(null)
      setError(null)
      void queryClient.invalidateQueries({ queryKey: scopeKey })
    }
  })

  useEffect(() => {
    setTerm('')
    setSource('all')
    setSubmitted('')
    setSelected(null)
    setPreview(null)
    setScan(null)
    previewTarget.current = null
    scanTarget.current = null
    setInstall(null)
    setError(null)
  }, [preferences.remoteURL, profile])

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setSubmitted(term.trim())
    setPreview(null)
    setScan(null)
  }

  return (
    <section className="screen page-screen">
      <header className="page-heading"><Button aria-label="Back" onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button><Badge variant="muted">45s network limit</Badge></header>
      <p className="eyebrow">Skills</p><h2>Skill hub</h2>
      <p className="muted">Preview and scan a skill before installing it into the selected profile.</p>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <form className="search-box" onSubmit={submit}><IconSearch size={17} aria-hidden="true" /><Input aria-label="Search skill hub" onChange={event => setTerm(event.target.value)} placeholder="Search skills" value={term} /><Button type="submit" variant="text">Search</Button></form>
      <label className="inline-field">Source<select aria-label="Skill hub source" onChange={event => setSource(event.target.value)} value={source}><option value="all">All sources</option>{sources.data?.sources.filter(item => item.searchable !== false).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      {sources.isPending && <Skeleton className="mt-3 h-20 w-full" />}
      {search.isFetching && <Skeleton className="mt-3 h-20 w-full" />}
      {search.error && <div className="error-banner" role="alert">{classifyGatewayError(search.error).message}</div>}
      <div className="settings-list capability-list">
        {search.data?.results.map(result => (
          <article className="hub-result" key={result.identifier}>
            <div><strong>{result.name}</strong><small>{result.description || result.identifier}</small><small>{result.source} · {result.trust_level || 'community'}</small></div>
            <div className="button-row"><Button disabled={previewMutation.isPending} onClick={() => { previewTarget.current = result.identifier; setSelected(result.identifier); previewMutation.mutate(result.identifier) }} size="sm" variant="secondary">Preview</Button><Button disabled={scanMutation.isPending} onClick={() => { scanTarget.current = result.identifier; setSelected(result.identifier); scanMutation.mutate(result.identifier) }} size="sm" variant="secondary"><IconShieldCheck size={15} /> Scan</Button><Button disabled={installMutation.isPending} onClick={() => setInstall({ identifier: result.identifier, name: result.name })} size="sm">Install</Button></div>
          </article>
        ))}
        {search.data && search.data.results.length === 0 && <div className="empty-panel">No hub skills match this search.</div>}
      </div>
      {preview && <section className="data-card"><header className="page-heading"><div><h3>{preview.name}</h3><p className="muted">{preview.files.length} files · {preview.source}</p></div><Button onClick={() => setPreview(null)} variant="text">Close</Button></header><pre className="file-content">{preview.skill_md || 'No SKILL.md content was returned.'}</pre></section>}
      {scan && <section className={`data-card scan-result ${scan.policy === 'block' ? 'scan-blocked' : ''}`}><h3>Security scan: {scan.verdict}</h3><p>{scan.summary || scan.policy_reason || 'No findings were reported.'}</p>{scan.findings.length > 0 && <ul>{scan.findings.map((finding, index) => <li key={`${finding.file}-${index}`}>{finding.severity}: {finding.description} ({finding.file}{finding.line ? `:${finding.line}` : ''})</li>)}</ul>}</section>}
      {selected && install && <ConfirmDialog confirmLabel="Install" description={`Install ${install.name} into the ${profile || 'default'} profile? Review its SKILL.md and scan result first.`} onCancel={() => setInstall(null)} onConfirm={() => installMutation.mutate(install.identifier)} title="Install skill" />}
    </section>
  )
}
