import { useStore } from '@nanostores/react'
import { IconMicrophone, IconPaperclip, IconPlayerStop, IconSend, IconVolume } from '@tabler/icons-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { Badge, Button, Textarea } from '~/compat/primitives'
import { HermesConnection } from '~/native/hermes-connection'
import { errorMessage, type GatewayController } from '~/state/gateway-controller'
import { $chat, $connection, $queuedPrompts } from '~/state/store'

interface SlashItem {
  display?: string
  insertText: string
  kind?: string
  meta?: string
  text: string
}

interface EditTarget {
  rowId: number
  userOrdinal: number
}

function completionInsertion(draft: string, text: string, replaceFrom: number | undefined) {
  if (typeof replaceFrom === 'number' && replaceFrom > 1 && replaceFrom <= draft.length) {
    return `${draft.slice(0, replaceFrom)}${text}`
  }
  return text.startsWith('/') ? text : `/${text}`
}

export function ChatScreen({ controller }: { controller: GatewayController }) {
  const chat = useStore($chat)
  const connection = useStore($connection)
  const queued = useStore($queuedPrompts)
  const [draft, setDraft] = useState('')
  const [attachmentRefs, setAttachmentRefs] = useState<string[]>([])
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)
  const [slashItems, setSlashItems] = useState<SlashItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const slashCompletionGeneration = useRef(0)

  useEffect(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), [chat.messages, chat.tools])
  useEffect(() => {
    slashCompletionGeneration.current += 1
    setEditTarget(null)
    setSlashItems([])
  }, [chat.runtimeSessionId])

  const userOrdinals = useMemo(() => {
    let ordinal = -1
    return chat.messages.map(message => message.role === 'user' ? ++ordinal : ordinal)
  }, [chat.messages])

  const updateDraft = (value: string) => {
    const generation = ++slashCompletionGeneration.current
    setDraft(value)
    if (!value.startsWith('/')) return setSlashItems([])
    void controller.request<{
      items?: Array<Omit<SlashItem, 'insertText'>>
      replace_from?: number
    }>('complete.slash', { text: value }).then(result => {
      if (generation !== slashCompletionGeneration.current) return
      setSlashItems((result.items ?? []).map(item => ({
        ...item,
        insertText: completionInsertion(value, item.text, result.replace_from)
      })))
    }).catch(() => {
      if (generation === slashCompletionGeneration.current) setSlashItems([])
    })
  }

  const submit = async () => {
    const combined = [draft.trim(), ...attachmentRefs].filter(Boolean).join('\n')
    if (!combined) return
    const target = editTarget
    slashCompletionGeneration.current += 1
    setDraft('')
    setAttachmentRefs([])
    setSlashItems([])
    setError(null)
    try {
      if (target) await controller.retryFrom(target.userOrdinal, target.rowId, combined)
      else await controller.send(combined)
      setEditTarget(null)
    } catch (caught) {
      setDraft(combined)
      setError(errorMessage(caught))
    }
  }

  const attach = async (files: FileList | null) => {
    if (!files) return
    setError(null)
    for (const file of Array.from(files)) {
      try {
        const result = await controller.attach(file) as { ref_text?: string; text?: string }
        setAttachmentRefs(current => [...current, result.ref_text ?? result.text ?? `@file:${file.name}`])
      } catch (caught) {
        setError(errorMessage(caught))
      }
    }
  }

  return (
    <section className="chat-screen">
      <div className="transcript" aria-live="polite">
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
                  slashCompletionGeneration.current += 1
                  setDraft(message.content)
                  setAttachmentRefs([])
                  setEditTarget({ rowId: message.rowId, userOrdinal: userOrdinals[index] })
                  setSlashItems([])
                  setError(null)
                }}
                size="micro"
                variant="text"
              >
                Edit & retry
              </Button>
            )}
            {message.role === 'assistant' && message.content && (
              <Button onClick={() => void speak(message.content).catch(caught => setError(errorMessage(caught)))} size="icon-xs" variant="ghost" aria-label="Read aloud">
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

      {chat.pendingPrompt && <PromptCard controller={controller} />}
      {(error || chat.error) && <div className="error-banner" role="alert">{error || chat.error}</div>}
      {queued.length > 0 && <div className="queue-banner">{queued.length} prompt{queued.length === 1 ? '' : 's'} queued</div>}
      {editTarget && (
        <div className="queue-banner">
          Editing an earlier message
          <Button
            aria-label="Cancel edit"
            onClick={() => {
              setDraft('')
              setEditTarget(null)
              setError(null)
            }}
            size="micro"
            variant="text"
          >
            Cancel
          </Button>
        </div>
      )}
      {attachmentRefs.length > 0 && (
        <div className="attachment-chips">
          {attachmentRefs.map((ref, index) => <button key={`${ref}-${index}`} onClick={() => setAttachmentRefs(items => items.filter((_, itemIndex) => index !== itemIndex))}>{ref}</button>)}
        </div>
      )}
      <div className="composer-wrap">
        {slashItems.length > 0 && (
          <div className="slash-popover">
            {slashItems.slice(0, 8).map((item, index) => (
              <button
                key={`${item.text}-${index}`}
                onClick={() => {
                  slashCompletionGeneration.current += 1
                  setDraft(`${item.insertText} `)
                  setSlashItems([])
                }}
              >
                <strong>{item.display ?? item.text}</strong><span>{item.meta}</span>
              </button>
            ))}
          </div>
        )}
        <div className="composer">
          <label className="icon-input" aria-label="Attach photo, PDF, or file">
            <IconPaperclip size={21} />
            <input accept="image/*,application/pdf,audio/*,*/*" multiple onChange={event => void attach(event.target.files)} type="file" />
          </label>
          <label className="icon-input" aria-label="Record audio">
            <IconMicrophone size={21} />
            <input accept="audio/*" capture="user" onChange={event => void transcribe(event.target.files?.[0], setDraft, setError)} type="file" />
          </label>
          <Textarea
            aria-label="Message Hermes"
            onChange={event => updateDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void submit()
              }
            }}
            placeholder={chat.running ? 'Queue another prompt…' : 'Message Hermes…'}
            rows={1}
            value={draft}
          />
          {chat.running ? (
            <Button aria-label="Interrupt" onClick={() => void controller.interrupt()} size="icon" variant="destructive"><IconPlayerStop size={19} /></Button>
          ) : (
            <Button aria-label="Send" disabled={!draft.trim() && attachmentRefs.length === 0} onClick={() => void submit()} size="icon"><IconSend size={19} /></Button>
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
  const title = { approval: 'Approval required', clarify: 'Hermes has a question', secret: 'Secret requested', sudo: 'Administrator password' }[pending.kind]
  const question = String(pending.payload.question ?? pending.payload.message ?? pending.payload.command ?? '')
  return (
    <form className="prompt-card" onSubmit={event => { event.preventDefault(); void controller.respond(value) }}>
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
      {(pending.kind === 'secret' || pending.kind === 'sudo') && <small>This value is sent directly and is never saved by Hermes Mobile.</small>}
    </form>
  )
}

async function speak(text: string) {
  const response = await HermesConnection.request<{ data_url: string }>({ body: { text }, method: 'POST', path: '/api/audio/speak' })
  await new Audio(response.body.data_url).play()
}

async function transcribe(file: File | undefined, setDraft: (value: string) => void, setError: (value: string) => void) {
  if (!file) return
  try {
    if (file.size > 25 * 1_024 * 1_024) throw new Error('Audio attachments are limited to 25 MB on mobile.')
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '')
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
    const response = await HermesConnection.upload<{ transcript: string }>({
      contentType: file.type,
      dataBase64: data,
      field: 'file',
      filename: file.name,
      path: '/api/audio/transcribe'
    })
    setDraft(response.body.transcript)
  } catch (caught) {
    setError(errorMessage(caught))
  }
}
