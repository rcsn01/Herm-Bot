import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Badge, Button, Input, Switch } from '~/compat/primitives'
import { errorMessage, type GatewayController } from '~/state/gateway-controller'
import { $chat, $connection, $preferences, savePreferences } from '~/state/store'

export function SettingsScreen({ controller }: { controller: GatewayController }) {
  const preferences = useStore($preferences)
  const connection = useStore($connection)
  const chat = useStore($chat)
  const [model, setModel] = useState(chat.info?.model ?? '')
  const [reasoning, setReasoning] = useState(chat.info?.reasoning_effort ?? '')
  const [fast, setFast] = useState(Boolean(chat.info?.fast))
  const [approvalMode, setApprovalMode] = useState(String(chat.info?.approval_mode ?? 'manual'))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => applyTheme(preferences.theme), [preferences.theme])
  const setConfig = async (key: string, value: unknown) => {
    if (!chat.runtimeSessionId) return
    setError(null)
    await controller.request('config.set', { key, session_id: chat.runtimeSessionId, value }).catch(caught => setError(errorMessage(caught)))
  }

  const profiles = (connection.status?.profiles ?? []).map(profile => typeof profile === 'string' ? profile : profile.name)
  return (
    <section className="screen page-screen">
      <header className="page-heading"><div><p className="eyebrow">Hermes Mobile</p><h2>Settings</h2></div><Badge variant="muted">{connection.authMode}</Badge></header>
      {error && <div className="error-banner">{error}</div>}
      <section className="settings-section"><h3>Connection</h3><div className="settings-list static"><div><span><strong>Gateway</strong><small>{preferences.remoteURL}</small></span><Badge>{connection.phase}</Badge></div><label><span><strong>Profile</strong><small>New and resumed chats remain profile-scoped.</small></span><select onChange={event => void controller.switchProfile(event.target.value || null).catch(caught => setError(errorMessage(caught)))} value={preferences.profile ?? ''}><option value="">Default</option>{profiles.filter(name => name !== 'default').map(name => <option key={name}>{name}</option>)}</select></label></div></section>
      <section className="settings-section"><h3>Conversation</h3><div className="settings-list static">
        <label><span><strong>Model</strong><small>Per-session model override.</small></span><Input onBlur={() => void setConfig('model', model)} onChange={event => setModel(event.target.value)} value={model} /></label>
        <label><span><strong>Reasoning effort</strong></span><select onChange={event => { setReasoning(event.target.value); void setConfig('reasoning_effort', event.target.value) }} value={reasoning}><option value="">Provider default</option><option value="none">Off</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
        <label><span><strong>Fast tier</strong><small>Use priority service tier when available.</small></span><Switch checked={fast} onCheckedChange={checked => { setFast(checked); void setConfig('fast', checked) }} /></label>
        <label><span><strong>Approval mode</strong></span><select onChange={event => { setApprovalMode(event.target.value); void setConfig('approvals.mode', event.target.value) }} value={approvalMode}><option value="manual">Manual</option><option value="smart">Smart</option><option value="off">Off</option></select></label>
      </div></section>
      <section className="settings-section"><h3>Appearance</h3><div className="settings-list static"><label><span><strong>Theme</strong><small>Follows iOS when set to System.</small></span><select onChange={event => savePreferences({ theme: event.target.value as typeof preferences.theme })} value={preferences.theme}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label></div></section>
      <section className="settings-section"><h3>iOS omissions</h3><p className="muted">Local runtime installation, Electron updates, multi-window controls, pet overlays, marketplace themes, local PTYs, OS reveal/open actions, and desktop plugin-rendered routes are intentionally hidden.</p></section>
      <Button className="touch-button" onClick={() => void controller.logout()} variant="destructive">Sign out</Button>
    </section>
  )
}

export function applyTheme(theme: 'dark' | 'light' | 'system') {
  const resolved = theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme
  document.documentElement.dataset.theme = resolved
}
