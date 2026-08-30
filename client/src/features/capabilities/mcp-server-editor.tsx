import { useEffect, useState } from 'react'

import { Button, Input, Textarea } from '~/compat/primitives'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { useGateway } from '~/gateway/gateway-context'
import { currentGatewayScope, isCurrentGatewayScope } from '~/gateway/scope-guard'
import { useStore } from '@nanostores/react'
import { $preferences } from '~/state/store'
import { mcpApi, type McpServerConfig, type McpServerSummary } from './mcp-api'

export function McpServerEditor({ server, onCancel, onSaved }: { onCancel(): void; onSaved(): void; server?: McpServerSummary }) {
  const gateway = useGateway()
  const preferences = useStore($preferences)
  const profile = preferences.profile
  const [name, setName] = useState(server?.name ?? '')
  const [transport, setTransport] = useState<'stdio' | 'url'>(server?.url ? 'url' : 'stdio')
  const [url, setUrl] = useState(server?.url ?? '')
  const [command, setCommand] = useState(server?.command ?? '')
  const [args, setArgs] = useState(server?.args.join('\n') ?? '')
  const [auth, setAuth] = useState(server?.auth ?? '')
  const [envText, setEnvText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const parseEnv = (): Record<string, string> => Object.fromEntries(envText.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const index = line.indexOf('=')
    return index < 0 ? [line, ''] : [line.slice(0, index).trim(), line.slice(index + 1)]
  }))
  const config = (): McpServerConfig => ({
    ...(transport === 'url' ? { url: url.trim() } : { args: args.split('\n').map(value => value.trim()).filter(Boolean), command: command.trim() }),
    ...(auth.trim() ? { auth: auth.trim() } : {}),
    ...(Object.keys(parseEnv()).length > 0 ? { env: parseEnv() } : {})
  })

  useEffect(() => {
    setName(server?.name ?? '')
    setTransport(server?.url ? 'url' : 'stdio')
    setUrl(server?.url ?? '')
    setCommand(server?.command ?? '')
    setArgs(server?.args.join('\n') ?? '')
    setAuth(server?.auth ?? '')
    setEnvText('')
    setError(null)
    setSaving(false)
  }, [preferences.remoteURL, profile, server?.name])

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    const scope = currentGatewayScope()
    const draft = config()
    // Environment values are only needed to construct this request. Never
    // retain them in component state after a submit, including validation or
    // network failures.
    setEnvText('')
    setError(null)
    if (!name.trim()) { setError('A server name is required.'); return }
    if (transport === 'url' && !url.trim()) { setError('A server URL is required.'); return }
    if (transport === 'stdio' && !command.trim()) { setError('A stdio command is required.'); return }
    setSaving(true)
    try {
      if (server) await mcpApi.update(gateway, profile, server.name, draft)
      else await mcpApi.add(gateway, profile, { ...draft, name: name.trim() })
      if (!isCurrentGatewayScope(scope)) return
      onSaved()
    } catch (caught) {
      if (isCurrentGatewayScope(scope)) setError(classifyGatewayError(caught).message)
    } finally {
      if (isCurrentGatewayScope(scope)) setSaving(false)
    }
  }

  return <form className="panel-stack data-card" onSubmit={save}><header className="page-heading"><div><p className="eyebrow">MCP</p><h3>{server ? 'Edit server' : 'Add server'}</h3></div></header>{error && <div className="error-banner" role="alert">{error}</div>}<label className="config-field"><span>Name</span><Input disabled={Boolean(server)} onChange={event => setName(event.target.value)} value={name} /></label><label className="config-field"><span>Transport</span><select onChange={event => setTransport(event.target.value as typeof transport)} value={transport}><option value="url">URL</option><option value="stdio">stdio</option></select></label>{transport === 'url' ? <label className="config-field"><span>URL</span><Input onChange={event => setUrl(event.target.value)} placeholder="https://example.test/mcp" type="url" value={url} /></label> : <><label className="config-field"><span>Command</span><Input onChange={event => setCommand(event.target.value)} placeholder="npx" value={command} /></label><label className="config-field"><span>Arguments (one per line)</span><Textarea onChange={event => setArgs(event.target.value)} value={args} /></label></>}<label className="config-field"><span>Authentication mode</span><Input onChange={event => setAuth(event.target.value)} placeholder="oauth (optional)" value={auth} /></label><label className="config-field"><span>Environment variables (KEY=value, one per line)</span><Textarea autoComplete="off" onChange={event => setEnvText(event.target.value)} placeholder="Values are kept only while this form is open." value={envText} /></label><div className="button-row"><Button disabled={saving} type="submit">{saving ? 'Saving…' : server ? 'Save changes' : 'Add server'}</Button><Button onClick={onCancel} type="button" variant="secondary">Cancel</Button></div></form>
}
