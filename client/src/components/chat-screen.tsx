import { useStore } from '@nanostores/react'
import { IconArchive, IconArrowDown, IconDots, IconGitBranch, IconMicrophone, IconPaperclip, IconPencil, IconPlayerStop, IconSend, IconVolume } from '@tabler/icons-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { Badge, Button, Textarea } from '~/compat/primitives'
import { BrandMark } from '~/components/brand-mark'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { TextDialog } from '~/components/ui/text-dialog'
import { useScopedTask } from '~/gateway/scope-guard'
import { ChatInteraction, type ChatInteractionCommands, type ChatMediaConnection } from '~/features/chat/chat-interaction'
import { errorMessage } from '~/gateway/gateway-error'
import { Conversation, $chat } from '~/state/conversation'
import type { GatewayController } from '~/state/gateway-controller'
import { $connection } from '~/state/store'

const LATEST_DISTANCE_THRESHOLD = 64
const USER_SCROLL_PAUSE_THRESHOLD = 48
const USER_SCROLL_IDLE_MS = 200

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
  // A fresh literal, not the live instances: every method must be bound so
  // `this` resolves to its owner (Conversation / GatewayController).
  const commands = useMemo<ChatInteractionCommands>(() => ({
    attach: conversation.attach.bind(conversation),
    request: controller.request.bind(controller),
    retryFrom: conversation.retryFrom.bind(conversation),
    send: conversation.send.bind(conversation)
  }), [conversation, controller])
  const interaction = useMemo(() => new ChatInteraction(commands, mediaConnection), [commands, mediaConnection])
  const interactionState = useStore(interaction.$state)
  const { attachmentRefs, draft, editTarget, error: interactionError, slashItems, submitting } = interactionState
  const [sessionActionError, setSessionActionError] = useState<string | null>(null)
  const [showSessionActions, setShowSessionActions] = useState(false)
  const [renameSession, setRenameSession] = useState(false)
  const [archiveSession, setArchiveSession] = useState(false)
  const [hasNewMessages, setHasNewMessages] = useState(false)
  const action = useScopedTask()
  const bottomRef = useRef<HTMLDivElement>(null)
  const olderMessagesRef = useRef<HTMLButtonElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const previousSessionRef = useRef<null | string>(null)
  const previousHistoryOffsetRef = useRef(0)
  const previousEntriesRef = useRef(entries)
  const previousToolsRef = useRef(chat.tools)
  const awaitingInitialHistoryRef = useRef(false)
  const followingLatestRef = useRef(true)
  const touchStartYRef = useRef<number | null>(null)
  const mouseScrollStartTopRef = useRef<number | null>(null)
  const discreteScrollDistanceRef = useRef(0)
  const pendingDisposals = useRef(new Map<ChatInteraction, symbol>())

  useEffect(() => {
    // StrictMode rehearses effect cleanup without replacing the memoized instance.
    pendingDisposals.current.delete(interaction)
    return () => {
      const disposal = Symbol('chat-interaction-disposal')
      pendingDisposals.current.set(interaction, disposal)
      queueMicrotask(() => {
        if (pendingDisposals.current.get(interaction) !== disposal) return
        pendingDisposals.current.delete(interaction)
        interaction.dispose()
      })
    }
  }, [interaction])
  useLayoutEffect(() => {
    if (!active) return
    const sessionChanged = previousSessionRef.current !== chat.runtimeSessionId
    const contentChanged = previousEntriesRef.current !== entries || previousToolsRef.current !== chat.tools
    const loadedOlder = !sessionChanged && previousHistoryOffsetRef.current > 0 && chat.historyNextOffset > previousHistoryOffsetRef.current
    previousHistoryOffsetRef.current = chat.historyNextOffset
    previousEntriesRef.current = entries
    previousToolsRef.current = chat.tools
    if (sessionChanged) {
      previousSessionRef.current = chat.runtimeSessionId
      awaitingInitialHistoryRef.current = Boolean(chat.runtimeSessionId && chat.storedSessionId && entries.length === 0)
      followingLatestRef.current = true
      touchStartYRef.current = null
      mouseScrollStartTopRef.current = null
      discreteScrollDistanceRef.current = 0
      setHasNewMessages(false)
    }
    const initialHistoryArrived = awaitingInitialHistoryRef.current && entries.length > 0
    if (!chat.runtimeSessionId || loadedOlder || (!sessionChanged && !initialHistoryArrived && chat.historyLoadingOlder)) return
    if (sessionChanged || initialHistoryArrived) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
      followingLatestRef.current = true
      setHasNewMessages(false)
      if (initialHistoryArrived) awaitingInitialHistoryRef.current = false
      return
    }
    if (!contentChanged) return
    if (followingLatestRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
    } else {
      setHasNewMessages(true)
    }
  }, [active, chat.historyLoadingOlder, chat.historyNextOffset, entries, chat.runtimeSessionId, chat.storedSessionId, chat.tools])
  useEffect(() => {
    if (!active) return
    const scroller = transcriptRef.current?.closest<HTMLElement>('.view-container')
    const bottom = bottomRef.current
    if (!scroller) return
    let intentTimer: ReturnType<typeof setTimeout> | undefined
    const pauseFollowing = () => {
      followingLatestRef.current = false
    }
    const resetDiscreteIntentSoon = () => {
      clearTimeout(intentTimer)
      intentTimer = setTimeout(() => { discreteScrollDistanceRef.current = 0 }, USER_SCROLL_IDLE_MS)
    }
    const trackWheel = (event: WheelEvent) => {
      if (event.deltaY >= 0) {
        discreteScrollDistanceRef.current = 0
        return
      }
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? scroller.clientHeight : 1
      discreteScrollDistanceRef.current += Math.abs(event.deltaY) * scale
      if (discreteScrollDistanceRef.current >= USER_SCROLL_PAUSE_THRESHOLD) pauseFollowing()
      resetDiscreteIntentSoon()
    }
    const trackKey = (event: KeyboardEvent) => {
      if (event.key === 'Home' || event.key === 'PageUp' || (event.key === ' ' && event.shiftKey)) {
        pauseFollowing()
      } else if (event.key === 'ArrowUp') {
        discreteScrollDistanceRef.current += 16
        if (discreteScrollDistanceRef.current >= USER_SCROLL_PAUSE_THRESHOLD) pauseFollowing()
      } else {
        return
      }
      resetDiscreteIntentSoon()
    }
    const startTouch = (event: TouchEvent) => {
      touchStartYRef.current = event.touches.length === 1 ? event.touches[0]?.clientY ?? null : null
    }
    const trackTouch = (event: TouchEvent) => {
      const currentY = event.touches.length === 1 ? event.touches[0]?.clientY : undefined
      const startY = touchStartYRef.current
      if (currentY === undefined || startY === null) return
      if (currentY < startY) {
        touchStartYRef.current = currentY
      } else if (currentY - startY >= USER_SCROLL_PAUSE_THRESHOLD) {
        pauseFollowing()
      }
    }
    const finishTouch = () => { touchStartYRef.current = null }
    const startPointer = (event: PointerEvent) => {
      if (event.pointerType === 'mouse') mouseScrollStartTopRef.current = scroller.scrollTop
    }
    const trackPointer = (event: PointerEvent) => {
      const startTop = mouseScrollStartTopRef.current
      if (event.pointerType === 'mouse' && startTop !== null && startTop - scroller.scrollTop >= USER_SCROLL_PAUSE_THRESHOLD) pauseFollowing()
    }
    const finishPointer = () => { mouseScrollStartTopRef.current = null }
    const resumeFollowing = () => {
      followingLatestRef.current = true
      setHasNewMessages(false)
    }
    const trackScrollPosition = () => {
      const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
      if (distanceFromBottom <= LATEST_DISTANCE_THRESHOLD) resumeFollowing()
    }
    let bottomObserver: IntersectionObserver | undefined
    if (bottom && typeof IntersectionObserver !== 'undefined') {
      bottomObserver = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) resumeFollowing()
      }, { root: scroller })
      bottomObserver.observe(bottom)
    }
    scroller.addEventListener('keydown', trackKey)
    scroller.addEventListener('pointerdown', startPointer, { passive: true })
    scroller.addEventListener('pointermove', trackPointer, { passive: true })
    scroller.addEventListener('pointercancel', finishPointer, { passive: true })
    scroller.addEventListener('pointerup', finishPointer, { passive: true })
    scroller.addEventListener('scroll', trackScrollPosition, { passive: true })
    scroller.addEventListener('touchstart', startTouch, { passive: true })
    scroller.addEventListener('touchmove', trackTouch, { passive: true })
    scroller.addEventListener('touchcancel', finishTouch, { passive: true })
    scroller.addEventListener('touchend', finishTouch, { passive: true })
    scroller.addEventListener('wheel', trackWheel, { passive: true })
    return () => {
      clearTimeout(intentTimer)
      bottomObserver?.disconnect()
      scroller.removeEventListener('keydown', trackKey)
      scroller.removeEventListener('pointerdown', startPointer)
      scroller.removeEventListener('pointermove', trackPointer)
      scroller.removeEventListener('pointercancel', finishPointer)
      scroller.removeEventListener('pointerup', finishPointer)
      scroller.removeEventListener('scroll', trackScrollPosition)
      scroller.removeEventListener('touchstart', startTouch)
      scroller.removeEventListener('touchmove', trackTouch)
      scroller.removeEventListener('touchcancel', finishTouch)
      scroller.removeEventListener('touchend', finishTouch)
      scroller.removeEventListener('wheel', trackWheel)
    }
  }, [active, chat.runtimeSessionId])

  const jumpToLatest = useCallback(() => {
    followingLatestRef.current = true
    setHasNewMessages(false)
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [])
  useEffect(() => {
    interaction.setSession(chat.runtimeSessionId)
    setSessionActionError(null)
    setShowSessionActions(false)
    setRenameSession(false)
    setArchiveSession(false)
  }, [chat.runtimeSessionId, interaction])

  const reportSessionAction = (perform: () => Promise<unknown>) => {
    void action.run(perform, { onError: error => setSessionActionError(error.message) })
  }

  const loadOlderMessages = useCallback(async () => {
    const sessionId = $chat.get().runtimeSessionId
    const scroller = transcriptRef.current?.closest<HTMLElement>('.view-container')
    const previousHeight = scroller?.scrollHeight ?? 0
    const previousTop = scroller?.scrollTop ?? 0
    try {
      await conversation.loadOlderMessages()
      if (scroller && $chat.get().runtimeSessionId === sessionId) {
        requestAnimationFrame(() => {
          if ($chat.get().runtimeSessionId !== sessionId) return
          scroller.scrollTop = previousTop + scroller.scrollHeight - previousHeight
        })
      }
    } catch (caught) {
      setSessionActionError(errorMessage(caught))
    }
  }, [conversation])

  useEffect(() => {
    const target = olderMessagesRef.current
    if (!active || !target || !chat.historyHasMore || chat.historyLoadingOlder || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadOlderMessages()
    }, { root: transcriptRef.current?.closest('.view-container') })
    observer.observe(target)
    return () => observer.disconnect()
  }, [active, chat.historyHasMore, chat.historyLoadingOlder, chat.runtimeSessionId, loadOlderMessages])

  return (
    <section className="chat-screen">
      <div className="transcript" aria-live="polite" ref={transcriptRef}>
        {chat.historyHasMore && (
          <Button className="load-earlier" disabled={chat.historyLoadingOlder} onClick={() => void loadOlderMessages()} ref={olderMessagesRef} size="sm" variant="secondary">
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
            <BrandMark small />
            <h2>What can Hermes do for you?</h2>
            <p>This conversation runs on {connection.status?.version ? `Hermes ${connection.status.version}` : 'your remote gateway'}.</p>
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
            <div className="message-meta">
              <span>{entry.kind === 'activity' ? 'Activity' : entry.author === 'assistant' ? 'Hermes' : entry.author}</span>
              {entry.streaming && <Badge variant="muted">Streaming</Badge>}
            </div>
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
        <div ref={bottomRef} />
      </div>

      {hasNewMessages && <Button aria-label="New messages. Jump to latest" className="new-messages-button" onClick={jumpToLatest} size="sm" variant="secondary">New messages <IconArrowDown size={16} /></Button>}
      {renameSession && chat.storedSessionId && <TextDialog initialValue={(chat.info as { title?: string } | null)?.title || ''} label="Session title" onCancel={() => setRenameSession(false)} onSubmit={title => { const id = chat.storedSessionId!; setRenameSession(false); setShowSessionActions(false); reportSessionAction(() => controller.renameSession(id, title)) }} title="Edit session name" />}
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
      <div className="composer-wrap">
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
          {chat.info?.usage && <ContextUsage usage={chat.info.usage as Record<string, unknown>} />}
          <div className={`session-activity ${chat.running ? 'working' : 'idle'}`} role="status" aria-live="polite">
            <span aria-hidden className="status-dot" />
            <span>{chat.running ? 'Hermes is working' : 'Ready'}</span>
          </div>
        </div>
      </div>
    </section>
  )
}

function ContextUsage({ usage }: { usage: Record<string, unknown> }) {
  const used = Number(usage.total ?? usage.total_tokens ?? 0)
  const limit = Number(usage.context_limit ?? usage.max_tokens ?? 0)
  if (!used && !limit) return null
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
  const question = String(pending.payload.question ?? pending.payload.message ?? pending.payload.command ?? '')
  return (
    <form className="prompt-card" onSubmit={event => { event.preventDefault(); void respond(value) }}>
      <strong>{title}</strong>
      {question && <p>{question}</p>}
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
