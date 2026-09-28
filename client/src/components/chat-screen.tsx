import { useStore } from '@nanostores/react'
import { IconArchive, IconArrowDown, IconDots, IconGitBranch, IconMicrophone, IconPaperclip, IconPencil, IconPlayerStop, IconSend, IconVolume } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { Badge, Button, Textarea } from '~/compat/primitives'
import { BrandMark } from '~/components/brand-mark'
import { useChatViewport } from '~/components/chat-viewport'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { TextDialog } from '~/components/ui/text-dialog'
import { useScopedTask, useScopeKey, useScopedQuery } from '~/gateway/scope-guard'
import type { ChatMediaConnection } from '~/features/chat/chat-interaction'
import { useChatInteraction } from '~/features/chat/use-chat-interaction'
import { createAgentsApi } from '~/features/agents/agents-api'
import { displayNameFor } from '~/features/agents/agent-labels'
import { BotFace } from '~/features/agents/bot-face'
import { useApi } from '~/gateway/gateway-api-hooks'
import { errorMessage } from '~/gateway/gateway-error'
import { Conversation, $chat } from '~/state/conversation'
import type { SessionUsage } from '~/lib/types'
import type { GatewayController } from '~/state/gateway-controller'
import { $connection, $preferences } from '~/state/store'

interface ChatScreenProps {
  active?: boolean
  controller: GatewayController
  conversation: Conversation
  mediaConnection?: ChatMediaConnection
}

export function ChatScreen({ active = true, controller, conversation, mediaConnection = controller.gateway }: ChatScreenProps) {
  const chat = useStore($chat)
  const connection = useStore($connection)
  const entries = chat.transcript.entries
  const { interaction, state: interactionState } = useChatInteraction({ conversation, mediaConnection })
  const { attachmentRefs, draft, editTarget, error: interactionError, slashItems, submitting } = interactionState
  const [sessionActionError, setSessionActionError] = useState<string | null>(null)
  const [showSessionActions, setShowSessionActions] = useState(false)
  const [renameSession, setRenameSession] = useState(false)
  const [archiveSession, setArchiveSession] = useState(false)
  const onLoadOlder = useCallback(() => conversation.loadOlderMessages(), [conversation])
  const onLoadOlderError = useCallback((error: unknown) => {
    setSessionActionError(errorMessage(error))
  }, [])
  const viewport = useChatViewport({
    active,
    content: { entries, tools: chat.tools },
    history: {
      hasMore: chat.historyHasMore,
      loadingOlder: chat.historyLoadingOlder,
      nextOffset: chat.historyNextOffset
    },
    onLoadOlder,
    onLoadOlderError,
    session: {
      runtimeSessionId: chat.runtimeSessionId,
      storedSessionId: chat.storedSessionId
    }
  })
  const action = useScopedTask()

  useEffect(() => {
    setSessionActionError(null)
    setShowSessionActions(false)
    setRenameSession(false)
    setArchiveSession(false)
  }, [chat.runtimeSessionId, chat.storedSessionId])

  const reportSessionAction = (perform: () => Promise<unknown>) => {
    void action.run(perform, { onError: error => setSessionActionError(error.message) })
  }

  return (
    <section className="chat-screen">
      <div className="transcript" aria-live="polite" ref={viewport.transcriptRef}>
        {chat.historyHasMore && (
          <Button className="load-earlier" disabled={chat.historyLoadingOlder} onClick={() => void viewport.loadOlderMessages()} ref={viewport.olderMessagesRef} size="sm" variant="secondary">
            {chat.historyLoadingOlder ? 'Loading earlier messages…' : 'Load earlier messages'}
          </Button>
        )}
        {chat.storedSessionId && (
          <div className="session-management">
            <Button aria-expanded={showSessionActions} onClick={() => setShowSessionActions(value => !value)} size="sm" variant="secondary"><IconDots size={17} /> Session options</Button>
            {showSessionActions && <div className="session-management-actions">
              <Button onClick={() => setRenameSession(true)} size="sm" variant="ghost"><IconPencil size={16} /> Edit name</Button>
              <Button onClick={() => setArchiveSession(true)} size="sm" variant="ghost"><IconArchive size={16} /> Archive</Button>
              <Button onClick={() => { setShowSessionActions(false); reportSessionAction(() => controller.branchSession()) }} size="sm" variant="ghost"><IconGitBranch size={16} /> Branch</Button>
            </div>}
          </div>
        )}
        {entries.length === 0 && (
          <div className="empty-chat">
            {connection.phase === 'connecting' ? (
              <>
                <BrandMark small />
                <h2>Connecting…</h2>
                <p role="status">Setting up the conversation.</p>
              </>
            ) : (
              <EmptyChat />
            )}
          </div>
        )}
        {entries.map(entry => entry.kind === 'cron-instructions' ? (
          <article className="message collapsed-message cron-instructions-message" key={entry.id}>
            <details>
              <summary>Cron job instructions</summary>
              <pre>{entry.content}</pre>
            </details>
          </article>
        ) : entry.kind === 'tool-output' ? (
          <article className="message tool collapsed-message" key={entry.id}>
            <details>
              <summary>Tool output</summary>
              <pre>{entry.content || 'No output'}</pre>
            </details>
          </article>
        ) : (
          <article className={`message ${entry.author}${entry.kind === 'activity' ? ' timeline-event' : ''}`} key={entry.id}>
            {/* Bubbles identify their speaker by side, so no author caption —
              the meta row only carries non-positional markers (Activity is an
              event kind, Streaming is a delivery state). */}
            {(entry.kind === 'activity' || entry.streaming) && (
              <div className="message-meta">
                <span>{entry.kind === 'activity' ? 'Activity' : null}</span>
                {entry.streaming && <Badge variant="muted">Streaming</Badge>}
              </div>
            )}
            {entry.reasoning && <details><summary>Reasoning</summary><pre>{entry.reasoning}</pre></details>}
            <div className="message-content"><ReactMarkdown components={{ a: ({ children, ...props }) => <a {...props} rel="noreferrer noopener" target="_blank">{children}</a> }} remarkPlugins={[remarkGfm]} skipHtml>{entry.content || (entry.streaming ? '…' : '')}</ReactMarkdown></div>
            {entry.author === 'user' && (
              <Button
                disabled={chat.running || !entry.editTarget}
                onClick={() => {
                  if (!entry.editTarget || chat.running) return
                  interaction.beginEdit({ content: entry.content, rowId: entry.editTarget.rowId })
                }}
                size="micro"
                variant="text"
              >
                Edit & retry
              </Button>
            )}
            {entry.author === 'assistant' && entry.content && (
              <Button onClick={() => void interaction.speak(entry.content)} size="icon-xs" variant="ghost" aria-label="Read aloud">
                <IconVolume size={16} />
              </Button>
            )}
          </article>
        ))}
        {chat.tools.length > 0 && (
          <section className="tool-timeline">
            <p className="eyebrow">Tool activity</p>
            {chat.tools.map(tool => (
              <details key={tool.id} open={tool.status !== 'complete'}>
                <summary><span className={`status-dot ${tool.status}`} />{tool.name}<span>{tool.status}</span></summary>
                {tool.detail && <pre>{tool.detail}</pre>}
              </details>
            ))}
          </section>
        )}
        <div ref={viewport.bottomRef} />
      </div>

      {viewport.hasNewMessages && <Button aria-label="New messages. Jump to latest" className="new-messages-button" onClick={viewport.jumpToLatest} size="sm" variant="secondary">New messages <IconArrowDown size={16} /></Button>}
      {renameSession && chat.storedSessionId && <TextDialog initialValue={chat.info?.title || ''} label="Session title" onCancel={() => setRenameSession(false)} onSubmit={title => { const id = chat.storedSessionId!; setRenameSession(false); setShowSessionActions(false); reportSessionAction(() => controller.renameSession(id, title)) }} title="Edit session name" />}
      {archiveSession && chat.storedSessionId && <ConfirmDialog confirmLabel="Archive" description="Archive this session? It will be removed from the active Sessions list." onCancel={() => setArchiveSession(false)} onConfirm={() => { const id = chat.storedSessionId!; setArchiveSession(false); setShowSessionActions(false); reportSessionAction(() => controller.archiveSession(id)) }} title="Archive session" />}
      {chat.pendingPrompt && <PromptCard conversation={conversation} />}
      {(sessionActionError || interactionError || chat.error) && <div className="error-banner" role="alert">{sessionActionError || interactionError || chat.error}</div>}
      {editTarget && (
        <div className="queue-banner">
          Editing an earlier message
          <Button
            aria-label="Cancel edit"
            onClick={() => interaction.cancelEdit()}
            size="micro"
            variant="text"
          >
            Cancel
          </Button>
        </div>
      )}
      {attachmentRefs.length > 0 && (
        <div className="attachment-chips">
          {attachmentRefs.map((ref, index) => <button key={`${ref}-${index}`} onClick={() => interaction.removeAttachment(index)}>{ref}</button>)}
        </div>
      )}
      <div className="composer-wrap" ref={viewport.composerRef}>
        {slashItems.length > 0 && (
          <div className="slash-popover">
            {slashItems.slice(0, 8).map((item, index) => (
              <button
                key={`${item.text}-${index}`}
                onClick={() => interaction.chooseCompletion(index)}
              >
                <strong>{item.display ?? item.text}</strong><span>{item.meta}</span>
              </button>
            ))}
          </div>
        )}
        <div className="composer">
          <label className="icon-input" aria-label="Attach photo, PDF, or file">
            <IconPaperclip size={21} />
            <input accept="image/*,application/pdf,audio/*,*/*" multiple onChange={event => void interaction.attach(event.target.files)} type="file" />
          </label>
          <label className="icon-input" aria-label="Record audio">
            <IconMicrophone size={21} />
            <input accept="audio/*" capture="user" onChange={event => void interaction.transcribe(event.target.files?.[0])} type="file" />
          </label>
          <Textarea
            aria-label="Message Hermes"
            onChange={event => interaction.updateDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void interaction.submit()
              }
            }}
            placeholder={chat.running ? 'Queue another prompt…' : 'Message Hermes…'}
            rows={1}
            value={draft}
          />
          {chat.running ? (
            <Button aria-label="Interrupt" onClick={() => void conversation.interrupt()} size="icon" variant="destructive"><IconPlayerStop size={19} /></Button>
          ) : (
            <Button aria-label="Send" disabled={submitting || (!draft.trim() && attachmentRefs.length === 0)} onClick={() => void interaction.submit()} size="icon"><IconSend size={19} /></Button>
          )}
        </div>
        <div className="composer-meta">
          {chat.info?.usage && <ContextUsage usage={chat.info.usage} />}
          <div className={`session-activity ${chat.running ? 'working' : 'idle'}`} role="status" aria-live="polite">
            <span aria-hidden className="status-dot" />
            <span>{chat.running ? 'Hermes is working' : 'Ready'}</span>
          </div>
        </div>
      </div>
    </section>
  )
}

function EmptyChat() {
  const preferences = useStore($preferences)
  const api = useApi(createAgentsApi)
  const rosterKey = useScopeKey('agents', ['roster'], { unscoped: true })
  const roster = useScopedQuery(rosterKey, { queryFn: signal => api.list(signal), retry: false })
  const profileName = preferences.profile || 'default'
  const profile = roster.data?.entries.find(entry => entry.name === profileName)
  const image = profile?.meta?.image ?? profile?.avatar
  const displayName = displayNameFor({ name: profileName })

  return (
    <>
      <div aria-hidden="true" className="empty-chat-avatar">
        {image
          ? <img alt="" src={image} />
          : <BotFace color={profile?.meta?.color} name={profileName} shape={profile?.meta?.shape} size={64} />}
      </div>
      <h2>What can {displayName} do for you?</h2>
    </>
  )
}

function ContextUsage({ usage }: { usage: SessionUsage }) {
  const { used, limit } = usage
  return <div className="context-usage"><span>Context</span><progress max={limit || used || 1} value={used} /><span>{used.toLocaleString()}{limit ? ` / ${limit.toLocaleString()}` : ''}</span></div>
}

function PromptCard({ conversation }: { conversation: Conversation }) {
  const pending = useStore($chat).pendingPrompt!
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const sensitive = pending.kind === 'secret' || pending.kind === 'sudo'
  useEffect(() => {
    setValue('')
    setError(null)
  }, [pending.requestId])
  const respond = async (next: string) => {
    if (sensitive) setValue('')
    try {
      await conversation.respond(next)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      if (sensitive) setValue('')
    }
  }
  const title = { approval: 'Approval required', clarify: 'Hermes has a question', secret: 'Secret requested', sudo: 'Administrator password' }[pending.kind]
  return (
    <form className="prompt-card" onSubmit={event => { event.preventDefault(); void respond(value) }}>
      <strong>{title}</strong>
      {pending.question && <p>{pending.question}</p>}
      {pending.kind === 'approval' ? (
        <div className="prompt-actions">
          <Button onClick={() => void conversation.respond('deny', 'deny')} type="button" variant="secondary">Deny</Button>
          <Button onClick={() => void conversation.respond('allow', 'allow')} type="button">Allow once</Button>
        </div>
      ) : (
        <>
          <input autoComplete="off" onChange={event => setValue(event.target.value)} type={pending.kind === 'clarify' ? 'text' : 'password'} value={value} />
          <Button type="submit">Respond</Button>
        </>
      )}
      {error && <div className="error-banner" role="alert">{error}</div>}
      {sensitive && <small>This value is sent directly and is never saved by Hermes Mobile.</small>}
    </form>
  )
}
