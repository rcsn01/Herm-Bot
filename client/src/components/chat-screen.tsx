import { useStore } from '@nanostores/react'
import { IconArchive, IconDots, IconGitBranch, IconMicrophone, IconPaperclip, IconPencil, IconPlayerStop, IconSend, IconVolume } from '@tabler/icons-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { Badge, Button, Textarea } from '~/compat/primitives'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { TextDialog } from '~/components/ui/text-dialog'
import { currentGatewayScope, isCurrentGatewayScope } from '~/gateway/scope-guard'
import { ChatInteraction, type ChatMediaConnection } from '~/features/chat/chat-interaction'
import { HermesConnection } from '~/native/hermes-connection'
import { errorMessage, type GatewayController } from '~/state/gateway-controller'
import { $chat, $connection, $queuedPrompts } from '~/state/store'

interface ChatScreenProps {
  controller: GatewayController
  mediaConnection?: ChatMediaConnection
}

export function ChatScreen({ controller, mediaConnection = HermesConnection }: ChatScreenProps) {
  const chat = useStore($chat)
  const connection = useStore($connection)
  const queued = useStore($queuedPrompts)
  const interaction = useMemo(() => new ChatInteraction(controller, mediaConnection), [controller, mediaConnection])
  const interactionState = useStore(interaction.$state)
  const { attachmentRefs, draft, editTarget, error: interactionError, slashItems, submitting } = interactionState
  const [sessionActionError, setSessionActionError] = useState<string | null>(null)
  const [showSessionActions, setShowSessionActions] = useState(false)
  const [renameSession, setRenameSession] = useState(false)
  const [archiveSession, setArchiveSession] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
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
  useEffect(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), [chat.messages, chat.tools])
  useEffect(() => {
    interaction.setSession(chat.runtimeSessionId)
    setSessionActionError(null)
    setShowSessionActions(false)
    setRenameSession(false)
    setArchiveSession(false)
  }, [chat.runtimeSessionId, interaction])

  const reportSessionAction = (action: () => Promise<unknown>) => {
    const scope = currentGatewayScope()
    void action().catch(caught => {
      if (isCurrentGatewayScope(scope)) setSessionActionError(errorMessage(caught))
    })
  }

  const userOrdinals = useMemo(() => {
    let ordinal = -1
    return chat.messages.map(message => message.role === 'user' ? ++ordinal : ordinal)
  }, [chat.messages])

  return (
    <section className="chat-screen">
      <div className="transcript" aria-live="polite">
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
        {chat.messages.length === 0 && (
          <div className="empty-chat">
            <div className="brand-mark small">H</div>
            <h2>What can Hermes do for you?</h2>
            <p>This conversation runs on {connection.status?.version ? `Hermes ${connection.status.version}` : 'your remote gateway'}.</p>
          </div>
        )}
        {chat.messages.map((message, index) => (
          <article className={`message ${message.role}`} key={message.id}>
            <div className="message-meta">
              <span>{message.role === 'assistant' ? 'Hermes' : message.role}</span>
              {message.streaming && <Badge variant="muted">Streaming</Badge>}
            </div>
            {message.reasoning && <details><summary>Reasoning</summary><pre>{message.reasoning}</pre></details>}
            <div className="message-content"><ReactMarkdown components={{ a: ({ children, ...props }) => <a {...props} rel="noreferrer noopener" target="_blank">{children}</a> }} remarkPlugins={[remarkGfm]} skipHtml>{message.content || (message.streaming ? '…' : '')}</ReactMarkdown></div>
            {message.role === 'user' && (
              <Button
                disabled={chat.running || message.rowId === undefined}
                onClick={() => {
                  if (message.rowId === undefined || chat.running) return
                  interaction.beginEdit({ content: message.content, rowId: message.rowId, userOrdinal: userOrdinals[index] })
                }}
                size="micro"
                variant="text"
              >
                Edit & retry
              </Button>
            )}
            {message.role === 'assistant' && message.content && (
              <Button onClick={() => void interaction.speak(message.content)} size="icon-xs" variant="ghost" aria-label="Read aloud">
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
        {chat.info?.usage && <ContextUsage usage={chat.info.usage as Record<string, unknown>} />}
        <div ref={bottomRef} />
      </div>

      {renameSession && chat.storedSessionId && <TextDialog initialValue={(chat.info as { title?: string } | null)?.title || ''} label="Session title" onCancel={() => setRenameSession(false)} onSubmit={title => { const id = chat.storedSessionId!; setRenameSession(false); setShowSessionActions(false); reportSessionAction(() => controller.renameSession(id, title)) }} title="Edit session name" />}
      {archiveSession && chat.storedSessionId && <ConfirmDialog confirmLabel="Archive" description="Archive this session? It will be removed from the active Sessions list." onCancel={() => setArchiveSession(false)} onConfirm={() => { const id = chat.storedSessionId!; setArchiveSession(false); setShowSessionActions(false); reportSessionAction(() => controller.archiveSession(id)) }} title="Archive session" />}
      {chat.pendingPrompt && <PromptCard controller={controller} />}
      {(sessionActionError || interactionError || chat.error) && <div className="error-banner" role="alert">{sessionActionError || interactionError || chat.error}</div>}
      {queued.length > 0 && <div className="queue-banner">{queued.length} prompt{queued.length === 1 ? '' : 's'} queued</div>}
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
            <Button aria-label="Interrupt" onClick={() => void controller.interrupt()} size="icon" variant="destructive"><IconPlayerStop size={19} /></Button>
          ) : (
            <Button aria-label="Send" disabled={submitting || (!draft.trim() && attachmentRefs.length === 0)} onClick={() => void interaction.submit()} size="icon"><IconSend size={19} /></Button>
          )}
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

function PromptCard({ controller }: { controller: GatewayController }) {
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
      await controller.respond(next)
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
          <Button onClick={() => void controller.respond('deny', 'deny')} type="button" variant="secondary">Deny</Button>
          <Button onClick={() => void controller.respond('allow', 'allow')} type="button">Allow once</Button>
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
