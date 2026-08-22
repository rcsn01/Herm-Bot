import { useStore } from '@nanostores/react'
import { IconAdjustments, IconFolder, IconMessageCircle, IconServer, IconStack2 } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'

import { Badge, Button } from '~/compat/primitives'
import { ChatScreen } from '~/components/chat-screen'
import { ConnectScreen } from '~/components/connect-screen'
import { FilesScreen } from '~/components/files-screen'
import { RemoteScreen } from '~/components/remote-screen'
import { SessionsScreen } from '~/components/sessions-screen'
import { applyTheme, SettingsScreen } from '~/components/settings-screen'
import { GatewayController } from '~/state/gateway-controller'
import { $chat, $connection, $preferences, $view, type MobileView } from '~/state/store'

const controller = new GatewayController()

const NAV: Array<{ icon: typeof IconMessageCircle; label: string; view: MobileView }> = [
  { icon: IconMessageCircle, label: 'Chat', view: 'chat' },
  { icon: IconStack2, label: 'Sessions', view: 'sessions' },
  { icon: IconServer, label: 'Remote', view: 'remote' },
  { icon: IconFolder, label: 'Projects', view: 'files' },
  { icon: IconAdjustments, label: 'Settings', view: 'settings' }
]

export function App() {
  const connection = useStore($connection)
  const preferences = useStore($preferences)
  const view = useStore($view)
  const chat = useStore($chat)
  const [refreshing, setRefreshing] = useState(false)
  const pullStart = useRef<number | null>(null)

  useEffect(() => {
    applyTheme(preferences.theme)
    void controller.initialize()
    return () => controller.dispose()
  }, [])

  if (connection.phase === 'unsupported') {
    return <main className="blocking-screen"><div className="brand-mark">!</div><h1>Update remote Hermes</h1><p>{connection.error}</p><Button onClick={() => void controller.connect()}>Check again</Button></main>
  }
  if (connection.phase !== 'connected') return <ConnectScreen controller={controller} />

  const refresh = async () => {
    setRefreshing(true)
    await Promise.allSettled([controller.reconcileHistory(), controller.refreshSessions()])
    setRefreshing(false)
  }

  return (
    <div
      className="mobile-shell"
      onTouchEnd={event => {
        const start = pullStart.current
        pullStart.current = null
        if (start !== null && event.changedTouches[0].clientY - start > 90 && scrollY <= 0) void refresh()
      }}
      onTouchStart={event => { if (scrollY <= 0) pullStart.current = event.touches[0].clientY }}
    >
      <header className="app-header">
        <div className="header-title"><span className={`connection-dot ${chat.running ? 'busy' : ''}`} /><div><strong>{view === 'chat' ? ((chat.info as { title?: string } | null)?.title || 'New conversation') : NAV.find(item => item.view === view)?.label}</strong><small>{preferences.profile || 'default'} profile</small></div></div>
        <Button onClick={() => $view.set('settings')} size="icon-sm" variant="ghost" aria-label="Open settings"><Badge variant="muted">{chat.info?.model?.split('/').at(-1) || 'Hermes'}</Badge></Button>
      </header>
      {refreshing && <div className="refresh-indicator">Refreshing from gateway…</div>}
      <main className="view-container">
        {view === 'chat' && <ChatScreen controller={controller} />}
        {view === 'sessions' && <SessionsScreen controller={controller} />}
        {view === 'remote' && <RemoteScreen />}
        {view === 'files' && <FilesScreen />}
        {view === 'settings' && <SettingsScreen controller={controller} />}
      </main>
      <nav className="bottom-nav" aria-label="Main navigation">
        {NAV.map(item => <button aria-current={view === item.view ? 'page' : undefined} key={item.view} onClick={() => $view.set(item.view)}><item.icon size={21} /><span>{item.label}</span></button>)}
      </nav>
    </div>
  )
}
