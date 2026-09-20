import { useStore } from '@nanostores/react'
import { IconChevronLeft, IconMenu2, IconPlus, IconSearch, IconSettings } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'

import { Button, Input } from '~/compat/primitives'
import { BrandMark } from '~/components/brand-mark'
import { CreateOptionsDialog } from '~/components/create-options-dialog'
import { BotWorkspaceHeader } from '~/components/bot-workspace-header'
import { BotWorkspaceNavigation } from '~/components/bot-workspace-navigation'
import { ChatScreen } from '~/components/chat-screen'
import { ConnectScreen } from '~/components/connect-screen'
import { MobileShell } from '~/components/mobile-shell'
import { SessionsMenu } from '~/components/sessions-menu'
import { displayNameFor } from '~/features/agents/agent-labels'
import type { AgentRosterEntry } from '~/features/agents/agents-api'
import { duplicateProfileSeed, type ProfileCreateSeed } from '~/features/agents/profile-workflow'
import { DeleteProfileDialog } from '~/features/agents/delete-profile-dialog'
import { EditProfileDialog } from '~/features/agents/edit-profile-dialog'
import { ProfileActionsDialog } from '~/features/agents/profile-actions-dialog'
import { CreateGroupChatDialog } from '~/features/groups/create-group-chat-dialog'
import { GroupChatScreen } from '~/features/groups/group-screen'
import { useKnownRooms } from '~/features/groups/group-engine'
import type { GroupRoom } from '~/features/groups/group-model'
import { applyTheme } from '~/features/settings/settings-screen'
import { CreateProfileDialog } from '~/features/agents/create-profile-dialog'
import { RosterScreen } from '~/features/agents/roster-screen'
import { CapabilitiesScreen } from '~/features/capabilities/capabilities-screen'
import { CronScreen } from '~/features/cron/cron-screen'
import { SettingsScreen as MobileSettingsScreen } from '~/features/settings/settings-screen'
import { GatewayProvider } from '~/gateway/gateway-context'
import { DeepLinkCoordinator, parseHermesDeepLink } from '~/navigation/deep-links'
import { $activeRoute, $navigation } from '~/navigation/navigation-store'
import { useWorkspaceNavigation } from '~/navigation/use-workspace-navigation'
import { groupIdFromRoute, restoreWorkspacePath } from '~/navigation/workspace-navigation'
import { observeHermesDeepLinks } from '~/native/deep-links'
import { $chat } from '~/state/conversation'
import { GatewayController } from '~/state/gateway-controller'
import { $connection, $preferences, $profileSwitching } from '~/state/store'

const controller = new GatewayController()
const deepLinks = new DeepLinkCoordinator(controller)

export function App() {
  const connection = useStore($connection)
  const preferences = useStore($preferences)
  const profileSwitching = useStore($profileSwitching)
  const navigation = useStore($navigation)
  const activeRoute = useStore($activeRoute)
  const activeGroupId = groupIdFromRoute(activeRoute)
  const groups = useKnownRooms()
  const activeGroup = activeGroupId ? groups.find(room => room.key === activeGroupId) ?? null : null
  const chat = useStore($chat)
  const [refreshing, setRefreshing] = useState(false)
  const [rosterQuery, setRosterQuery] = useState('')
  const [createOptionsOpen, setCreateOptionsOpen] = useState(false)
  const [createProfileOpen, setCreateProfileOpen] = useState(false)
  const [createGroupOpen, setCreateGroupOpen] = useState(false)
  const [createProfileSeed, setCreateProfileSeed] = useState<ProfileCreateSeed | null>(null)
  const [editingProfile, setEditingProfile] = useState<AgentRosterEntry | null>(null)
  const [actionsProfile, setActionsProfile] = useState<AgentRosterEntry | null>(null)
  const [deletingProfile, setDeletingProfile] = useState<AgentRosterEntry | null>(null)
  const [profileNotice, setProfileNotice] = useState<string | null>(null)
  const initialNavigationRestoredRef = useRef(false)
  const workspace = useWorkspaceNavigation()

  useEffect(() => {
    applyTheme(preferences.theme)
  }, [preferences.theme])

  // A screen URL is an optional cold-start input only. Once the app is
  // running, route state stays in memory and never grows browser history.
  useEffect(() => {
    if (initialNavigationRestoredRef.current) return
    initialNavigationRestoredRef.current = true
    const pathname = window.location.pathname
    restoreWorkspacePath(pathname)
    if (pathname !== '/' && !parseHermesDeepLink(window.location.href)) {
      history.replaceState(null, '', '/')
    }
  }, [])

  useEffect(() => {
    void controller.initialize()
    return () => controller.dispose()
  }, [])

  useEffect(() => observeHermesDeepLinks(rawURL => deepLinks.accept(rawURL)), [])
  useEffect(() => {
    deepLinks.setReady(connection.phase === 'connected')
    return () => deepLinks.setReady(false)
  }, [connection.phase])

  const reconnecting = connection.phase === 'reconnecting' && Boolean(chat.runtimeSessionId)
  // The sessions menu belongs to profile surfaces only; the main screen is
  // the roster, so it has no menu button or sessions menu.
  const inProfile = navigation.activeTab !== 'roster'

  if (connection.phase === 'unsupported') {
    return <main className="blocking-screen"><div className="brand-mark letter">!</div><h1>Update remote Hermes</h1><p>{connection.error}</p><Button onClick={() => void controller.connect().catch(() => undefined)}>Check again</Button></main>
  }
  // The full-screen takeover is for cold boot and lost transports. A roster
  // tap (a profile switch) renders the destination shell in place instead —
  // the chat screen shows its own inline connecting state.
  const switchingConnect = connection.phase === 'connecting' && profileSwitching
  if (connection.phase === 'connecting' && !profileSwitching || (connection.phase === 'reconnecting' && !reconnecting)) {
    return <main aria-label="Connecting to Hermes" className="blocking-screen startup-screen"><BrandMark small /><p role="status">Connecting…</p></main>
  }
  if (connection.phase !== 'connected' && !reconnecting && !switchingConnect) return <ConnectScreen controller={controller} />

  const refresh = async () => {
    setRefreshing(true)
    await Promise.allSettled([controller.conversation.reconcileHistory(), controller.refreshSessions()])
    setRefreshing(false)
  }
  const openAgent = (profile: null | string) => {
    // Enter the destination first; the wire work (profile switch, session
    // resume) streams into the already-visible chat shell.
    workspace.openChatSurface()
    void controller.openProfile(profile)
  }
  const closeCreateProfile = () => {
    setCreateProfileOpen(false)
    setCreateProfileSeed(null)
  }
  const openCreateProfile = () => {
    setCreateProfileSeed(null)
    setCreateOptionsOpen(true)
  }
  const chooseCreateBot = () => {
    setCreateOptionsOpen(false)
    setCreateProfileOpen(true)
  }
  const chooseCreateGroup = () => {
    setCreateOptionsOpen(false)
    setCreateGroupOpen(true)
  }
  const openCreatedGroup = (room: GroupRoom) => {
    // The dialog already wrote the room into the engine store; the projection
    // reads $groupChats directly, so the header name resolves on the same
    // commit — no publish tick.
    setCreateOptionsOpen(false)
    setCreateGroupOpen(false)
    workspace.openGroupRoom(room.key)
  }
  const openSettingsFrom = () => {
    closeCreateProfile()
    setCreateOptionsOpen(false)
    setCreateGroupOpen(false)
    workspace.openSettings()
  }
  const botName = displayNameFor({ name: preferences.profile || 'default' })
  /** Chat shows the current session beneath the bot identity. */
  const headerSubtitle = (chat.info as { title?: string } | null)?.title || 'New conversation'
  const manageAgent = (agent: AgentRosterEntry) => {
    setActionsProfile(agent)
    setProfileNotice(null)
  }
  const editAgent = () => {
    if (!actionsProfile) return
    setEditingProfile(actionsProfile)
    setActionsProfile(null)
  }
  const duplicateAgent = () => {
    if (!actionsProfile) return
    setCreateProfileSeed(duplicateProfileSeed(actionsProfile))
    setActionsProfile(null)
    setCreateProfileOpen(true)
  }
  const deleteAgent = () => {
    if (!actionsProfile || actionsProfile.isDefault) return
    setDeletingProfile(actionsProfile)
    setActionsProfile(null)
  }
  const rosterHeader = (
    <header className="app-header">
      <div className="header-search">
        <IconSearch aria-hidden size={17} />
        <Input aria-label="Search bots" onChange={event => setRosterQuery(event.target.value)} placeholder="Search bots" type="search" value={rosterQuery} />
      </div>
      <div className="header-actions">
        <Button aria-label="Create profile" className="header-add-button" onClick={openCreateProfile} variant="ghost"><IconPlus aria-hidden="true" className="size-6" /></Button>
        <Button aria-label="Open settings" className="header-gear-button" onClick={openSettingsFrom} variant="ghost"><IconSettings aria-hidden="true" className="size-6" /></Button>
      </div>
      {profileNotice && <p className="profile-notice" role="status">{profileNotice}</p>}
    </header>
  )
  const foregroundHeader = !workspace.foregroundVisible
    ? null
    : workspace.header.destination
      ? <BotWorkspaceHeader backLabel={workspace.header.backLabel} botName={botName} onBack={workspace.back} subtitle={workspace.header.title} />
      : (
          <header className="app-header">
            {activeGroupId ? (
              <>
                <Button aria-label="Back to bots" className="header-back-button" onClick={workspace.back} variant="ghost"><IconChevronLeft className="size-6" /></Button>
                <div aria-level={1} className="header-title" role="heading"><div><strong>{activeGroup?.name ?? 'Group chat'}</strong></div></div>
              </>
            ) : (
              <Button aria-label={workspace.header.backLabel} className="header-back-button" onClick={workspace.back} variant="ghost"><IconChevronLeft className="size-6" /></Button>
            )}
            {navigation.activeTab === 'sessions' ? (
              <div className="header-bot-button">
                <div><strong>{botName}</strong><small>{reconnecting ? 'Reconnecting…' : headerSubtitle}</small></div>
              </div>
            ) : inProfile ? (
              <div aria-level={1} className="header-title" role="heading"><div><strong>{workspace.header.title}</strong></div></div>
            ) : null}
            {inProfile && (
              <Button aria-controls="sessions-menu" aria-expanded={workspace.menuOpen} aria-label="Open navigation" className="header-menu-button" onClick={workspace.openMenu} variant="ghost"><IconMenu2 className="size-6" /></Button>
            )}
          </header>
        )
  const foregroundContent = (
    <>
      <div aria-hidden={navigation.activeTab !== 'sessions'} className={navigation.activeTab === 'sessions' ? '' : 'mounted-view-hidden'}>
        <ChatScreen active={navigation.activeTab === 'sessions'} controller={controller} conversation={controller.conversation} />
      </div>
      {activeGroupId && <GroupChatScreen roomId={activeGroupId} />}
      {navigation.activeTab === 'capabilities' && <CapabilitiesScreen workspace={workspace.screen('capabilities')} />}
      {navigation.activeTab === 'cron' && <CronScreen onOpenSession={async sessionId => { await controller.resumeSession(sessionId); workspace.openChatSurface() }} workspace={workspace.screen('cron')} />}
      {navigation.activeTab === 'settings' && <MobileSettingsScreen controller={controller} workspace={workspace.screen('settings')} />}
    </>
  )

  return (
    <GatewayProvider gateway={controller.gateway}>
      <MobileShell
        navigationPage={workspace.menuOpen || inProfile ? <SessionsMenu controller={controller} onDismissRequest={workspace.dismissMenu} open={workspace.menuOpen} /> : null}
        navigationPageOpen={workspace.menuOpen}
        foreground={foregroundContent}
        foregroundDismissible={workspace.foregroundDismissible}
        foregroundHeader={foregroundHeader}
        foregroundNavigation={workspace.header.destination ? <BotWorkspaceNavigation active={workspace.header.destination} onSelect={workspace.openWorkspaceDestination} /> : null}
        foregroundVisible={workspace.foregroundVisible}
        onDismissForeground={workspace.dismissForeground}
        onRefresh={refresh}
        reconnecting={reconnecting}
        refreshing={refreshing}
        roster={<RosterScreen onManageAgent={manageAgent} onOpenAgent={openAgent} onOpenGroup={workspace.openGroupRoom} query={rosterQuery} />}
        rosterHeader={rosterHeader}
      />
      <CreateOptionsDialog onCancel={() => setCreateOptionsOpen(false)} onNewBot={chooseCreateBot} onNewGroup={chooseCreateGroup} open={createOptionsOpen} />
      {createGroupOpen && <CreateGroupChatDialog onCancel={() => setCreateGroupOpen(false)} onCreated={openCreatedGroup} open />}
      {createProfileOpen && <CreateProfileDialog
        onCancel={closeCreateProfile}
        onCreated={(name, warning) => setProfileNotice(warning || `Created profile ${name}.`)}
        open
        seed={createProfileSeed}
      />}
      <ProfileActionsDialog bot={actionsProfile} onCancel={() => setActionsProfile(null)} onDelete={deleteAgent} onDuplicate={duplicateAgent} onEdit={editAgent} />
      {editingProfile && <EditProfileDialog bot={editingProfile} onCancel={() => setEditingProfile(null)} onSaved={name => setProfileNotice(`Updated profile ${name}.`)} open />}
      {deletingProfile && <DeleteProfileDialog bot={deletingProfile} onCancel={() => setDeletingProfile(null)} onDeleted={name => {
        if (preferences.profile === name) void controller.openProfile(null)
        setProfileNotice(`Deleted profile ${name}.`)
      }} open />}
    </GatewayProvider>
  )
}
