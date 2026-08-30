import { useStore } from '@nanostores/react'
import { useState } from 'react'
import { IconAdjustments, IconArchive, IconBell, IconBrain, IconBrowser, IconChevronLeft, IconChevronRight, IconCloud, IconCode, IconCoin, IconDeviceDesktop, IconInfoCircle, IconKey, IconLock, IconMessage, IconMoodSmile, IconNetwork, IconPalette, IconPlug, IconRobot, IconServer, IconSettings, IconShield, IconSpeakerphone, IconTools, IconUser, IconUsers, IconWorld } from '@tabler/icons-react'

import { Badge, Button } from '~/compat/primitives'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import type { GatewayController } from '~/state/gateway-controller'
import { $connection, $preferences, savePreferences } from '~/state/store'
import type { SettingsRoute, SettingsAdministrationPage, SettingsCategory } from '~/navigation/routes'
import type { ThemeMode } from '~/lib/types'
import { ModelsScreen } from '~/features/models/models-screen'
import { ConfigSectionScreen } from './config-section-screen'
import { SettingsPageShell } from './settings-page-shell'
import { SETTINGS_ENTRIES, type SettingsEntry } from './settings-registry'
import { SettingsAdministrationScreen } from './settings-administration-screen'
import { MemorySettings } from './memory-settings'

const ICONS: Record<string, typeof IconSettings> = {
  about: IconInfoCircle,
  advanced: IconAdjustments,
  appearance: IconPalette,
  'archived-chats': IconArchive,
  billing: IconCoin,
  browser: IconWorld,
  chat: IconMessage,
  gateway: IconCloud,
  keyboard: IconCode,
  'keyboard-shortcuts': IconCode,
  memory: IconBrain,
  model: IconRobot,
  notifications: IconBell,
  plugins: IconPlug,
  providers: IconNetwork,
  safety: IconShield,
  'tools-keys': IconKey,
  voice: IconSpeakerphone,
  workspace: IconWorld
}

export function SettingsScreen({ controller, onBack, onNavigate, route }: { controller: GatewayController; onBack(): void; onNavigate(route: SettingsRoute): void; route: SettingsRoute }) {
  const preferences = useStore($preferences)
  const connection = useStore($connection)
  const profiles = (connection.status?.profiles ?? []).map(profile => typeof profile === 'string' ? profile : profile.name)
  const [confirmSignOut, setConfirmSignOut] = useState(false)

  if (route.type === 'settings-category') {
    if (route.category === 'model') return <ModelsScreen onBack={onBack} />
    if (route.category === 'appearance') return <AppearanceSettings onBack={onBack} />
    if (route.category === 'memory') return <MemorySettings onBack={onBack} />
    if (route.category === 'notifications') return <NotificationsSettings onBack={onBack} />
    if (route.category === 'keyboard-shortcuts') return <KeyboardShortcutsSettings onBack={onBack} />
    if (route.category === 'about') return <AboutSettings onBack={onBack} />
    return <ConfigSectionScreen category={route.category} onBack={onBack} />
  }
  if (route.type === 'settings-administration') return <SettingsAdministrationScreen controller={controller} onBack={onBack} page={route.page} />

  return <SettingsPageShell subtitle="Profile defaults, mobile preferences, and gateway administration." title="Settings"><section className="settings-section"><h3>Connection</h3><div className="settings-list static"><div><span><strong>Gateway</strong><small>{preferences.remoteURL}</small></span><Badge>{connection.phase}</Badge></div><label><span><strong>Profile</strong><small>All remote settings and capability requests use this profile.</small></span><select onChange={event => void controller.switchProfile(event.target.value || null).catch(() => undefined)} value={preferences.profile ?? ''}><option value="">Default</option>{profiles.filter(name => name !== 'default').map(name => <option key={name} value={name}>{name}</option>)}</select></label></div></section><div className="settings-list capability-list">{SETTINGS_ENTRIES.map(entry => <SettingsRow entry={entry} key={`${entry.kind}:${entry.id}`} onClick={() => navigateEntry(entry, onNavigate)} />)}</div><Button className="touch-button" onClick={() => setConfirmSignOut(true)} variant="destructive">Sign out</Button>{confirmSignOut && <ConfirmDialog confirmLabel="Sign out" description="Sign out of this gateway? The remote agent keeps running, but this device will clear its active session." onCancel={() => setConfirmSignOut(false)} onConfirm={() => { setConfirmSignOut(false); void controller.logout().catch(() => undefined) }} title="Sign out" />}</SettingsPageShell>
}

function navigateEntry(entry: SettingsEntry, onNavigate: (route: SettingsRoute) => void) {
  if (entry.kind === 'config' || entry.kind === 'local') onNavigate({ category: entry.id as SettingsCategory, tab: 'settings', type: 'settings-category' })
  else onNavigate({ page: entry.id as SettingsAdministrationPage, tab: 'settings', type: 'settings-administration' })
}

function SettingsRow({ entry, onClick }: { entry: SettingsEntry; onClick(): void }) {
  const Icon = ICONS[entry.id] ?? IconSettings
  return <button onClick={onClick}><Icon size={20} /><span><strong>{entry.label}</strong><small>{entry.description}</small></span><IconChevronRight size={18} /></button>
}

function AppearanceSettings({ onBack }: { onBack(): void }) {
  const preferences = useStore($preferences)
  return <SettingsPageShell title="Appearance"><Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button><div className="settings-list static"><label><span><strong>Theme</strong><small>System follows the iOS appearance.</small></span><select onChange={event => savePreferences({ theme: event.target.value as typeof preferences.theme })} value={preferences.theme}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label></div></SettingsPageShell>
}

function NotificationsSettings({ onBack }: { onBack(): void }) {
  return <SettingsPageShell title="Notifications"><Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button><div className="data-card"><h3>Foreground notifications</h3><p className="muted">Hermes Mobile can report activity while it is open. APNs and background execution are not implemented, so this screen does not present unavailable native controls.</p></div></SettingsPageShell>
}

function KeyboardShortcutsSettings({ onBack }: { onBack(): void }) {
  return <SettingsPageShell title="Keyboard Shortcuts"><Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button><div className="data-card"><h3>Implemented mobile commands</h3><ul><li>Send and stop from the composer</li><li>Open the navigation drawer</li><li>Pull to refresh the active screen</li></ul><p className="muted">Rebinding is unsupported on iOS. Mobile does not reuse the Desktop renderer keybinding registry.</p></div></SettingsPageShell>
}

export function applyTheme(theme: ThemeMode) {
  const resolved = theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme
  document.documentElement.dataset.theme = resolved
}

export function AboutSettings({ onBack }: { onBack(): void }) {
  const connection = useStore($connection)
  return <SettingsPageShell title="About"><Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button><div className="settings-list static"><div><span><strong>Mobile app</strong><small>Hermes Mobile</small></span><Badge>iOS</Badge></div><div><span><strong>Gateway contract</strong><small>{connection.status?.version || 'Unknown'}</small></span><Badge>{connection.phase}</Badge></div></div><div className="data-card"><p>Remote diagnostics remain available through Gateway administration. Hermes runtime updates are not offered as an iOS app update.</p></div></SettingsPageShell>
}
