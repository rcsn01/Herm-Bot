import { useStore } from '@nanostores/react'
import { IconChevronLeft, IconMenu2, IconPlus, IconSearch, IconSettings } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'

import { Button, Input } from '~/compat/primitives'
import { BrandMark } from '~/components/brand-mark'
import { CreateOptionsDialog } from '~/components/create-options-dialog'
import { BotWorkspaceHeader } from '~/components/bot-workspace-header'
import { BotWorkspaceNavigation, type BotWorkspaceDestination } from '~/components/bot-workspace-navigation'
import { ChatScreen } from '~/components/chat-screen'
import { ConnectScreen } from '~/components/connect-screen'
import { MobileShell } from '~/components/mobile-shell'
import { SessionsMenu } from '~/components/sessions-menu'
import { displayNameFor } from '~/features/agents/agent-labels'
import type { AgentRosterEntry } from '~/features/agents/agents-api'
import { DeleteProfileDialog } from '~/features/agents/delete-profile-dialog'
import { EditProfileDialog } from '~/features/agents/edit-profile-dialog'
import { ProfileActionsDialog } from '~/features/agents/profile-actions-dialog'
import { CreateGroupChatDialog } from '~/features/groups/create-group-chat-dialog'
import { GroupChatScreen } from '~/features/groups/group-screen'
import { useGroupRooms } from '~/features/groups/group-engine'
import type { GroupRoom } from '~/features/groups/group-model'
import { applyTheme } from '~/features/settings/settings-screen'
import { CreateProfileDialog, PROFILE_NAME_MAX_LENGTH } from '~/features/agents/create-profile-dialog'
import { RosterScreen } from '~/features/agents/roster-screen'
import { CapabilitiesScreen } from '~/features/capabilities/capabilities-screen'
import { CronScreen } from '~/features/cron/cron-screen'
import { SettingsScreen as MobileSettingsScreen } from '~/features/settings/settings-screen'
import type { CapabilitiesRoute, CronRoute, MobileRoute, MobileTab, SettingsRoute } from '~/navigation/routes'
import { GatewayProvider } from '~/gateway/gateway-context'
import { DeepLinkCoordinator, parseHermesDeepLink } from '~/navigation/deep-links'
import { restoreInitialNavigation } from '~/navigation/initial-navigation'
import { $activeRoute, $navigation, applyPathState, popRoute, pushRoute, resetTabRoutes, setTab } from '~/navigation/navigation-store'
import { useNavigationPageController } from '~/navigation/use-navigation-page-controller'
import { ROOT_ROUTES } from '~/navigation/routes'
import { observeHermesDeepLinks } from '~/native/deep-links'
import { $chat } from '~/state/conversation'
import { GatewayController } from '~/state/gateway-controller'
import { $connection, $preferences, $profileSwitching } from '~/state/store'

const controller = new GatewayController()
const deepLinks = new DeepLinkCoordinator(controller)

const DESTINATION_TITLES = {
  capabilities: 'Capabilities',
  cron: 'Automations',
  roster: 'Hermes',
  settings: 'Settings',
  sessions: 'Sessions'
} as const

const BOT_CONFIGURATION_TITLES = {
  capabilities: 'Capabilities',
  cron: 'Automations',
  model: 'Models'
} as const

function botWorkspaceRouteTitle(destination: 'capabilities' | 'cron' | 'model', route: MobileRoute): string {
  if (route.type === 'cron-job-detail') return 'Job details'
  if (route.type === 'cron-job-editor') return route.jobId ? 'Edit job' : 'New job'
  if (route.type === 'cron-blueprints') return 'Blueprints'
  if (route.type === 'capabilities-section') return route.section === 'mcp' ? 'MCP' : route.section === 'skills' ? 'Skills' : 'Tools'
  if (route.type === 'capability-detail') {
    if (route.capabilityId === 'skills-hub') return 'Skill hub'
    if (route.capabilityId === 'mcp-catalog') return 'MCP catalog'
    if (route.capabilityId === 'mcp:new') return 'Add server'
    if (route.capabilityId.startsWith('skill:')) return route.capabilityId.slice(6) || 'Skill'
    if (route.capabilityId.startsWith('toolset:')) return route.capabilityId.slice(8) || 'Toolset'
    if (route.capabilityId.startsWith('mcp:')) return route.capabilityId.slice(4) || 'MCP server'
  }
  return BOT_CONFIGURATION_TITLES[destination]
}

export function App() {
  const connection = useStore($connection)
  const preferences = useStore($preferences)
  const profileSwitching = useStore($profileSwitching)
  const navigation = useStore($navigation)
  const activeRoute = useStore($activeRoute)
  const activeGroupId = routeForGroupRoom(activeRoute)
  const groups = useGroupRooms()
  const activeGroup = activeGroupId ? groups.find(room => room.key === activeGroupId) ?? null : null
  const chat = useStore($chat)
  const [refreshing, setRefreshing] = useState(false)
  const [rosterQuery, setRosterQuery] = useState('')
  const [createOptionsOpen, setCreateOptionsOpen] = useState(false)
  const [createProfileOpen, setCreateProfileOpen] = useState(false)
  const [createGroupOpen, setCreateGroupOpen] = useState(false)
  const [duplicateOptions, setDuplicateOptions] = useState<{ initialCloneAll: boolean; initialCloneFrom: string; initialColor: null | string; initialDescription: string; initialImage: null | string; initialName: string; initialShape: string; initialTitle: string } | null>(null)
  const [editingProfile, setEditingProfile] = useState<AgentRosterEntry | null>(null)
  const [actionsProfile, setActionsProfile] = useState<AgentRosterEntry | null>(null)
  const [deletingProfile, setDeletingProfile] = useState<AgentRosterEntry | null>(null)
  const [profileNotice, setProfileNotice] = useState<string | null>(null)
  const [returnTab, setReturnTab] = useState<MobileTab | null>(null)
  const initialNavigationRestoredRef = useRef(false)
  const menuOriginRef = useRef<MobileTab | null>(null)
  const menuOriginStackRef = useRef<MobileRoute[] | null>(null)
  const returnStackRef = useRef<MobileRoute[] | null>(null)
  const navigationPage = useNavigationPageController({
    onDismissed: intent => {
      const origin = menuOriginRef.current
      const originStack = menuOriginStackRef.current
      menuOriginRef.current = null
      menuOriginStackRef.current = null
      if (intent.type === 'tab') {
        if (origin === intent.tab) return
        setReturnTab(origin)
        returnStackRef.current = originStack
        openDestination(intent.tab)
      } else if (intent.type === 'model') {
        const originRoute = originStack?.at(-1)
        if (origin === 'settings' && originRoute?.type === 'settings-category' && originRoute.category === 'model') return
        setReturnTab(origin)
        returnStackRef.current = originStack
        openModelSettings()
      }
    }
  })
  const navigationPageOpen = navigationPage.isOpen

  useEffect(() => {
    applyTheme(preferences.theme)
  }, [preferences.theme])

  // A screen URL is an optional cold-start input only. Once the app is
  // running, route state stays in memory and never grows browser history.
  useEffect(() => {
    if (initialNavigationRestoredRef.current) return
    initialNavigationRestoredRef.current = true
    const pathname = window.location.pathname
    restoreInitialNavigation(pathname)
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
  const clearMenuReturn = () => {
    setReturnTab(null)
    returnStackRef.current = null
  }
  const openAgent = (profile: null | string) => {
    // Enter the destination first; the wire work (profile switch, session
    // resume) streams into the already-visible chat shell.
    clearMenuReturn()
    setTab('sessions')
    void controller.openProfile(profile)
  }
  /** In-app back pops the active in-memory route stack; at its root the
   *  caller's destination fallback runs instead. */
  const goBackOr = (fallback: () => void) => {
    if (popRoute(navigation.activeTab) === undefined) fallback()
  }
  const exitDestination = (fallback: MobileTab = 'roster') => {
    const destination = returnTab ?? fallback
    const returnStack = returnStackRef.current
    const reopenMenu = returnTab !== null && returnStack !== null
    clearMenuReturn()
    if (returnStack) applyPathState(destination, returnStack)
    else setTab(destination)
    if (reopenMenu) {
      menuOriginRef.current = destination
      menuOriginStackRef.current = returnStack
      navigationPage.openNavigationPage()
    }
  }
  const backToRoster = () => {
    clearMenuReturn()
    setTab('roster')
  }
  const closeCreateProfile = () => {
    setCreateProfileOpen(false)
    setDuplicateOptions(null)
  }
  const openCreateProfile = () => {
    setDuplicateOptions(null)
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
    // The dialog already wrote the room into the engine store; the published
    // known-rooms view picks the name up on the next publish tick.
    setCreateOptionsOpen(false)
    setCreateGroupOpen(false)
    pushRoute('roster', { roomId: room.key, tab: 'roster', type: 'group-room' })
  }
  const openSettingsFrom = () => {
    closeCreateProfile()
    setCreateOptionsOpen(false)
    setCreateGroupOpen(false)
    clearMenuReturn()
    resetTabRoutes('settings')
    setTab('settings')
  }
  const openNavigationPage = () => {
    menuOriginRef.current = navigation.activeTab
    menuOriginStackRef.current = [...navigation.stacks[navigation.activeTab]] as MobileRoute[]
    navigationPage.openNavigationPage()
  }
  const selectBotWorkspaceDestination = (destination: BotWorkspaceDestination) => {
    if (destination === 'sessions') {
      openNavigationPage()
      return
    }
    if (destination === 'model') openModelSettings()
    else openDestination(destination)
  }
  const nestedRoute = navigation.stacks[navigation.activeTab].length > 1
  const activeBotConfiguration = activeBotConfigurationDestination(navigation.activeTab, activeRoute)
  const modelReturnsToSurface = navigation.activeTab === 'settings' && activeRoute.type === 'settings-category' && activeRoute.category === 'model' && returnTab
  const backDestinationLabel = nestedRoute && !modelReturnsToSurface
    ? 'Back'
    : returnTab
      ? 'Back to menu'
      : 'Back to bots'
  const botName = displayNameFor({ name: preferences.profile || 'default' })
  const headerTitle = DESTINATION_TITLES[navigation.activeTab]
  /** Chat shows the current session beneath the bot identity. */
  const headerSubtitle = (chat.info as { title?: string } | null)?.title || 'New conversation'
  const foregroundVisible = navigation.activeTab !== 'roster' || Boolean(activeGroupId)
  const foregroundDismissible = navigation.activeTab === 'sessions' || Boolean(activeGroupId)
  const backFromForeground = () => {
    if (activeGroupId) {
      if (popRoute('roster') === undefined) backToRoster()
      return
    }
    if (navigation.activeTab === 'sessions') {
      backToRoster()
      return
    }
    if (navigation.activeTab === 'settings' && activeRoute.type === 'settings-category' && activeRoute.category === 'model' && returnTab) {
      exitDestination()
      return
    }
    if (popRoute(navigation.activeTab) === undefined) exitDestination()
  }
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
    const source = actionsProfile
    const suffix = '-2'
    const initialName = `${source.name.slice(0, Math.max(1, PROFILE_NAME_MAX_LENGTH - suffix.length))}${suffix}`
    setDuplicateOptions({
      initialCloneAll: true,
      initialCloneFrom: source.name,
      initialColor: source.meta?.color ?? null,
      initialDescription: source.description ?? '',
      initialImage: source.meta?.image ?? source.avatar ?? null,
      initialName,
      initialShape: source.meta?.shape ?? 'blobatar',
      initialTitle: source.meta?.title ? `${source.meta.title} (copy)` : ''
    })
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
  const foregroundHeader = !foregroundVisible
    ? null
    : activeBotConfiguration
      ? <BotWorkspaceHeader backLabel={backDestinationLabel} botName={botName} onBack={backFromForeground} subtitle={botWorkspaceRouteTitle(activeBotConfiguration, activeRoute)} />
      : (
          <header className="app-header">
            {activeGroupId ? (
              <>
                <Button aria-label="Back to bots" className="header-back-button" onClick={backFromForeground} variant="ghost"><IconChevronLeft className="size-6" /></Button>
                <div aria-level={1} className="header-title" role="heading"><div><strong>{activeGroup?.name ?? 'Group chat'}</strong></div></div>
              </>
            ) : (
              <Button aria-label={backDestinationLabel} className="header-back-button" onClick={backFromForeground} variant="ghost"><IconChevronLeft className="size-6" /></Button>
            )}
            {navigation.activeTab === 'sessions' ? (
              <div className="header-bot-button">
                <div><strong>{botName}</strong><small>{reconnecting ? 'Reconnecting…' : headerSubtitle}</small></div>
              </div>
            ) : inProfile ? (
              <div aria-level={1} className="header-title" role="heading"><div><strong>{headerTitle}</strong></div></div>
            ) : null}
            {inProfile && (
              <Button aria-controls="sessions-menu" aria-expanded={navigationPageOpen} aria-label="Open navigation" className="header-menu-button" onClick={openNavigationPage} variant="ghost"><IconMenu2 className="size-6" /></Button>
            )}
          </header>
        )
  const foregroundContent = (
    <>
      <div aria-hidden={navigation.activeTab !== 'sessions'} className={navigation.activeTab === 'sessions' ? '' : 'mounted-view-hidden'}>
        <ChatScreen active={navigation.activeTab === 'sessions'} controller={controller} conversation={controller.conversation} />
      </div>
      {activeGroupId && <GroupChatScreen roomId={activeGroupId} />}
      {navigation.activeTab === 'capabilities' && <CapabilitiesScreen onBack={() => goBackOr(() => exitDestination('sessions'))} onNavigate={route => pushRoute('capabilities', route)} route={routeForCapabilities(activeRoute)} />}
      {navigation.activeTab === 'cron' && <CronScreen onBack={() => goBackOr(() => exitDestination('sessions'))} onNavigate={route => pushRoute('cron', route)} onOpenSession={async sessionId => { await controller.resumeSession(sessionId); clearMenuReturn(); setTab('sessions') }} route={routeForCron(activeRoute)} />}
      {navigation.activeTab === 'settings' && <MobileSettingsScreen controller={controller} onBack={() => goBackOr(() => exitDestination())} onNavigate={route => pushRoute('settings', route)} route={routeForSettings(activeRoute)} showModelBack={!returnTab} />}
    </>
  )

  return (
    <GatewayProvider gateway={controller.gateway}>
      <MobileShell
        navigationPage={navigationPageOpen || inProfile ? <SessionsMenu controller={controller} onDismissRequest={navigationPage.requestDismiss} open={navigationPageOpen} /> : null}
        navigationPageOpen={navigationPageOpen}
        foreground={foregroundContent}
        foregroundDismissible={foregroundDismissible}
        foregroundHeader={foregroundHeader}
        foregroundNavigation={activeBotConfiguration ? <BotWorkspaceNavigation active={activeBotConfiguration} onSelect={selectBotWorkspaceDestination} /> : null}
        foregroundVisible={foregroundVisible}
        onDismissForeground={() => {
          // A committed swipe always dismisses the whole foreground to the
          // fixed roster. It changes only the in-memory route state.
          if (activeGroupId) resetTabRoutes('roster')
          if (navigation.activeTab === 'sessions' || activeGroupId) setTab('roster')
        }}
        onRefresh={refresh}
        reconnecting={reconnecting}
        refreshing={refreshing}
        roster={<RosterScreen onManageAgent={manageAgent} onOpenAgent={openAgent} onOpenGroup={roomId => pushRoute('roster', { roomId, tab: 'roster', type: 'group-room' })} query={rosterQuery} />}
        rosterHeader={rosterHeader}
      />
      <CreateOptionsDialog onCancel={() => setCreateOptionsOpen(false)} onNewBot={chooseCreateBot} onNewGroup={chooseCreateGroup} open={createOptionsOpen} />
      {createGroupOpen && <CreateGroupChatDialog onCancel={() => setCreateGroupOpen(false)} onCreated={openCreatedGroup} open />}
      {createProfileOpen && <CreateProfileDialog
        initialCloneAll={duplicateOptions?.initialCloneAll}
        initialCloneFrom={duplicateOptions?.initialCloneFrom}
        initialColor={duplicateOptions?.initialColor}
        initialDescription={duplicateOptions?.initialDescription}
        initialImage={duplicateOptions?.initialImage}
        initialName={duplicateOptions?.initialName}
        initialShape={duplicateOptions?.initialShape}
        initialTitle={duplicateOptions?.initialTitle}
        onCancel={closeCreateProfile}
        onCreated={(name, warning) => setProfileNotice(warning || `Created profile ${name}.`)}
        open
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

function activeBotConfigurationDestination(tab: MobileTab, route: MobileRoute): 'capabilities' | 'cron' | 'model' | null {
  if (tab === 'capabilities' || tab === 'cron') return tab
  if (tab === 'settings' && route.type === 'settings-category' && route.category === 'model') return 'model'
  return null
}

function routeForCapabilities(route: ReturnType<typeof $activeRoute.get>): CapabilitiesRoute {
  return route.tab === 'capabilities' ? route : ROOT_ROUTES.capabilities
}

function routeForGroupRoom(route: ReturnType<typeof $activeRoute.get>): string | null {
  return route.tab === 'roster' && route.type === 'group-room' ? route.roomId : null
}

function routeForCron(route: ReturnType<typeof $activeRoute.get>): CronRoute {
  return route.tab === 'cron' ? route : ROOT_ROUTES.cron
}

function routeForSettings(route: ReturnType<typeof $activeRoute.get>): SettingsRoute {
  return route.tab === 'settings' ? route : ROOT_ROUTES.settings
}

function openDestination(tab: MobileTab) {
  resetTabRoutes(tab)
  setTab(tab)
}

function openModelSettings() {
  setTab('settings')
  const current = $navigation.get().stacks.settings.at(-1)
  if (current?.type === 'settings-category' && current.category === 'model') return
  resetTabRoutes('settings')
  pushRoute('settings', { category: 'model', tab: 'settings', type: 'settings-category' })
}
