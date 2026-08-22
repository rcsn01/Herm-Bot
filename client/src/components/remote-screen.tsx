import { IconChevronRight, IconRefresh } from '@tabler/icons-react'
import { useState } from 'react'

import { Badge, Button, Input, Skeleton, Textarea } from '~/compat/primitives'
import { HermesConnection } from '~/native/hermes-connection'
import { errorMessage } from '~/state/gateway-controller'

interface RemoteSurface {
  description: string
  path: string
  title: string
}

interface RemoteGroup {
  label: string
  surfaces: RemoteSurface[]
}

const GROUPS: RemoteGroup[] = [
  { label: 'Agent', surfaces: [
    ['Models & providers', '/api/model/info', 'Model catalog, selection, auxiliary models and provider status.'],
    ['Provider credentials', '/api/env', 'Redacted provider and service credential state.'],
    ['Configuration', '/api/config', 'Profile-scoped Hermes configuration.'],
    ['Memory', '/api/memory', 'Memory provider, status, and maintenance.'],
    ['Skills', '/api/skills', 'Installed skills and activation state.'],
    ['Toolsets', '/api/tools/toolsets', 'Toolset availability and model assignments.'],
    ['MCP servers', '/api/mcp/servers', 'Configured MCP servers and catalog state.'],
    ['Computer use', '/api/tools/computer-use/status', 'Remote computer-use capability and permissions.'],
    ['Plugins', '/api/dashboard/plugins', 'Enabled remote plugins; desktop-rendered plugin routes are omitted.']
  ].map(([title, path, description]) => ({ title, path, description })) },
  { label: 'Operations', surfaces: [
    ['Messaging', '/api/messaging/platforms', 'Telegram, Discord, Slack, and other remote channels.'],
    ['Cron', '/api/cron/jobs', 'Scheduled jobs and recent runs.'],
    ['Profiles & souls', '/api/profiles', 'Profiles, souls, and profile-scoped routing.'],
    ['Agents', '/api/agents', 'Remote agents and delegated work.'],
    ['Learning', '/api/learning/graph', 'Starmap and learning graph.'],
    ['Analytics', '/api/analytics/usage', 'Usage totals, models, and skills.'],
    ['Logs', '/api/logs', 'Remote Hermes logs.'],
    ['Maintenance', '/api/status', 'Health, version, update support, and gateway lifecycle.'],
    ['Backups', '/api/ops/backup', 'Backup and import capability.']
  ].map(([title, path, description]) => ({ title, path, description })) }
]

export function RemoteScreen() {
  const [selected, setSelected] = useState<RemoteSurface | null>(null)
  const [value, setValue] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = async (surface: RemoteSurface) => {
    setSelected(surface)
    setLoading(true)
    setError(null)
    setValue(null)
    try {
      const response = await HermesConnection.request({ path: surface.path })
      setValue(response.body)
    } catch (caught) {
      const message = errorMessage(caught)
      setError(/404|not found|unsupported/i.test(message) ? `This gateway does not support ${surface.title}.` : message)
    } finally {
      setLoading(false)
    }
  }

  if (selected) {
    return (
      <section className="screen page-screen">
        <header className="page-heading">
          <Button onClick={() => setSelected(null)} variant="text">‹ Remote</Button>
          <Button aria-label="Refresh" onClick={() => void load(selected)} size="icon-sm" variant="ghost"><IconRefresh size={18} /></Button>
        </header>
        <h2>{selected.title}</h2><p className="muted">{selected.description}</p>
        {loading && <div className="data-card"><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-40 w-full" /></div>}
        {error && <div className="unsupported-card"><strong>Unavailable</strong><p>{error}</p></div>}
        {value !== null && <DataView value={value} />}
        <AdminAction surface={selected} onResult={setValue} />
      </section>
    )
  }

  return (
    <section className="screen page-screen">
      <header className="page-heading"><div><p className="eyebrow">Single remote gateway</p><h2>Remote</h2></div><Badge variant="muted">Administration</Badge></header>
      {GROUPS.map(group => (
        <section className="remote-group" key={group.label}>
          <h3>{group.label}</h3>
          <div className="settings-list">
            {group.surfaces.map(surface => (
              <button key={surface.path} onClick={() => void load(surface)}>
                <span><strong>{surface.title}</strong><small>{surface.description}</small></span><IconChevronRight size={18} />
              </button>
            ))}
          </div>
        </section>
      ))}
    </section>
  )
}

function AdminAction({ onResult, surface }: { onResult: (value: unknown) => void; surface: RemoteSurface }) {
  const [expanded, setExpanded] = useState(false)
  const [method, setMethod] = useState('GET')
  const [path, setPath] = useState(surface.path)
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const execute = async () => {
    setError(null); setBusy(true)
    try {
      const payload = body.trim() ? JSON.parse(body) as unknown : undefined
      const response = await HermesConnection.request({ body: payload, method, path })
      onResult(response.body)
    } catch (caught) { setError(errorMessage(caught)) }
    finally { setBusy(false) }
  }

  if (!expanded) return <Button onClick={() => setExpanded(true)} variant="secondary">Manage this surface</Button>
  return (
    <section className="admin-action">
      <div className="page-heading"><h3>Remote API action</h3><Button onClick={() => setExpanded(false)} size="micro" variant="text">Hide</Button></div>
      <p className="muted">Use the gateway’s authenticated REST operations for create, update, test, import, maintenance, and delete actions.</p>
      <div className="api-path-row"><select aria-label="HTTP method" onChange={event => setMethod(event.target.value)} value={method}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(item => <option key={item}>{item}</option>)}</select><Input aria-label="API path" onChange={event => setPath(event.target.value)} value={path} /></div>
      <Textarea aria-label="JSON request body" onChange={event => setBody(event.target.value)} placeholder={'Optional JSON body, for example {"enabled": true}'} rows={5} value={body} />
      {error && <div className="error-banner" role="alert">{error}</div>}
      <Button disabled={busy || !path.startsWith('/api/')} onClick={() => void execute()}>{busy ? 'Sending…' : `${method} request`}</Button>
    </section>
  )
}

function DataView({ value }: { value: unknown }) {
  if (Array.isArray(value)) return <div className="data-card"><p>{value.length} items</p>{value.map((item, index) => <DataRow key={index} value={item} />)}</div>
  if (typeof value === 'object' && value !== null) return <div className="data-card">{Object.entries(value).map(([key, item]) => <DataRow key={key} label={key} value={item} />)}</div>
  return <div className="data-card"><pre>{String(value)}</pre></div>
}

function DataRow({ label, value }: { label?: string; value: unknown }) {
  const shown = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '—')
  return <details className="data-row" open={shown.length < 120}><summary>{label ?? 'Item'}</summary><pre>{shown}</pre></details>
}
