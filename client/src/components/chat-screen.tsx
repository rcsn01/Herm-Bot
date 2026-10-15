import { useStore } from '@nanostores/react'
import { IconArchive, IconArrowDown, IconDots, IconGitBranch, IconMicrophone, IconPaperclip, IconPencil, IconPlayerStop, IconSend, IconVolume } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MessageMarkdown } from '~/components/message-markdown'

import { Badge, Button, Textarea } from '~/compat/primitives'
import { BrandMark } from '~/components/brand-mark'
import { AgentActivity } from '~/components/agent-activity'
import { groupAgentActivity } from '~/transcript/agent-activity'
import { useChatViewport } from '~/components/chat-viewport'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { TextDialog } from '~/components/ui/text-dialog'
import { useScopedTask, useScopeKey, useScopedQuery } from '~/gateway/scope-guard'
import type { ChatMediaConnection } from '~/features/chat/chat-interaction'
import { chatDrafts } from '~/features/chat/chat-drafts'
import { draftOwnerKey, $draftOwner } from '~/state/draft-owner'
import { useChatInteraction } from '~/features/chat/use-chat-interaction'
import { createAgentsApi } from '~/features/agents/agents-api'
import { displayNameFor } from '~/features/agents/agent-labels'
import { BotFace } from '~/features/agents/bot-face'
import { useApi } from '~/gateway/gateway-api-hooks'
import { errorMessage } from '~/gateway/gateway-error'
import { Conversation, $chat } from '~/state/conversation'
import type { SessionUsage } from '~/lib/types'
import type { GatewayController } from '~/state/gateway-controller'
import { $gatewayReady, $connection, $preferences, $profileSwitching, $sessionSelecting } from '~/state/store'

interface ChatScreenProps {
  active?: boolean
  controller: GatewayController
  conversation: Conversation
  mediaConnection?: ChatMediaConnection
}

export function ChatScreen({ active = true, controller, conversation, mediaConnection = controller.gateway }: ChatScreenProps) {
  const chat = useStore($chat)
  const connection = useStore($connection)
  const selecting = useStore($sessionSelecting)
  const profileSwitching = useStore($profileSwitching)
  const owner = useStore($draftOwner)
  const ready = useStore($gatewayReady)
  const localReady = Boolean(chat.storedSessionId || chat.runtimeSessionId) && !selecting && !profileSwitching && !owner.locked
  const composerReady = ready && localReady && chat.availability === 'live'
  useStore(chatDrafts.$version)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const entries = chat.transcript.entries
  const displayItems = useMemo(() => groupAgentActivity(entries), [entries])
  const { interaction, state: interactionState } = useChatInteraction({ active, conversation, mediaConnection })
  const { attachmentRefs, attachments, uploading, transcribing, pendingTranscript, playback, submissionFeedback, stopping, stopFeedback, draft, editTarget, error: interactionError, slashItems, submitting } = interactionState
  const messageRef = useRef<HTMLTextAreaElement>(null)
  const draftRecord = interaction.record()
  const otherDrafts = chatDrafts.list().filter(record => record.key !== draftRecord?.key)
  const editValid = !editTarget || chat.availability === 'live' && entries.some(entry => entry.rowId === editTarget.rowId && 'editTarget' in entry && entry.editTarget)
  const copyDraft = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setRecoveryError('Copied draft text.') }
    catch { setRecoveryError('Could not copy. Select the recovered text and copy it manually.') }
  }
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
      hasMore: composerReady && chat.historyHasMore,
      loadingOlder: chat.historyLoadingOlder,
      nextOffset: chat.historyNextOffset
    },
    onLoadOlder,
    onLoadOlderError,
    conversationIdentity: JSON.stringify([draftOwnerKey(owner), $preferences.get().profile, chat.storedSessionId ?? chat.runtimeSessionId]),
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
          <Button className="load-earlier" disabled={!composerReady || chat.historyLoadingOlder} onClick={() => void viewport.loadOlderMessages()} ref={viewport.olderMessagesRef} size="sm" variant="secondary">
            {chat.historyLoadingOlder ? 'Loading earlier messages…' : 'Load earlier messages'}
          </Button>
        )}
        {chat.storedSessionId && (
          <div className="session-management">
            <Button disabled={!composerReady} aria-expanded={showSessionActions} onClick={() => setShowSessionActions(value => !value)} size="sm" variant="secondary"><IconDots size={17} /> Session options</Button>
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
        {displayItems.map(item => {
          if (item.kind === 'agent-activity') return <AgentActivity key={item.id} steps={item.steps} />
          const entry = item.entry
          return entry.kind === 'cron-instructions' ? (
            <article className="message collapsed-message cron-instructions-message" key={entry.id}>
              <details>
                <summary>Cron job instructions</summary>
                <pre>{entry.content}</pre>
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
              <div className="message-content"><MessageMarkdown content={entry.content || (entry.streaming ? '…' : '')} /></div>
              {entry.author === 'user' && (
                <Button
                  disabled={!composerReady || chat.running || !entry.editTarget}
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
                <Button disabled={!composerReady || playback.messageId === entry.id && ['generating', 'playing', 'paused'].includes(playback.status)} onClick={() => void interaction.speak(entry.content, entry.id)} size="icon-xs" variant="ghost" aria-label="Read aloud">
                  <IconVolume size={16} />
                </Button>
              )}
            </article>
          )
        })}
        {chat.tools.length > 0 && (
          <AgentActivity hasSessionError={Boolean(chat.error)} key={`tools:${chat.runtimeSessionId ?? chat.storedSessionId ?? 'current'}`} running={chat.running} tools={chat.tools} />
        )}
      {draftRecord?.recoveries.map(item => <details className="data-card draft-recovery" key={item.id}>
        <summary>{item.status === 'pending' ? 'Message submission pending' : item.status === 'uncertain' ? 'Delivery not confirmed. Check the conversation before sending again.' : item.status === 'conflict' ? 'Another draft was preserved' : 'Failed message preserved'}</summary>
        <pre>{item.content.text}</pre>
        {item.content.attachments.map((file, index) => <p key={index}>{file.name}</p>)}
        <Button onClick={() => void copyDraft(item.content.text)} size="sm" variant="text">Copy recovered text</Button>
        {item.status !== 'pending' && <>
          <Button onClick={() => interaction.recover(item.id)} size="sm" variant="text">Restore draft</Button>
          <Button onClick={() => interaction.discard(item.id)} size="sm" variant="text">Discard recovered message</Button>
        </>}
      </details>)}
      {otherDrafts.length > 0 && <details className="data-card draft-recovery">
        <summary>Other unfinished messages ({otherDrafts.length})</summary>
        {otherDrafts.map(record => <details key={record.key}>
          <summary>{record.profile === null ? 'Default profile' : `Profile ${record.profile}`} · {record.provisional ? 'Unlinked draft' : `Conversation ${record.conversation}`}</summary>
          <pre>{record.content.text}</pre>
          {record.content.normal && <pre>{record.content.normal.text}</pre>}
          {record.content.attachments.map((file, index) => <p key={index}>{file.name}. Select this file again after recovery.</p>)}
          <Button onClick={() => void copyDraft(record.content.text)} size="sm" variant="text">Copy draft text</Button>
          {record.recoveries.map(item => <div key={item.id}>
            <p>{item.status === 'pending' ? 'Submission pending' : 'Check the conversation before sending recovered text.'}</p><pre>{item.content.text}</pre>
            <Button onClick={() => void copyDraft(item.content.text)} size="sm" variant="text">Copy recovered text</Button>
          </div>)}
          {!record.recoveries.some(item => item.status === 'pending') && <Button onClick={() => chatDrafts.discard(record.key)} size="sm" variant="text">Discard this draft</Button>}
        </details>)}
      </details>}
        <div ref={viewport.bottomRef} />
      </div>

      {viewport.hasNewMessages && <Button aria-label="New messages. Jump to latest" className="new-messages-button" onClick={viewport.jumpToLatest} size="sm" variant="secondary">New messages <IconArrowDown size={16} /></Button>}
      {renameSession && chat.storedSessionId && <TextDialog disabled={!composerReady} initialValue={chat.info?.title || ''} label="Session title" onCancel={() => setRenameSession(false)} onSubmit={title => { const id = chat.storedSessionId!; setRenameSession(false); setShowSessionActions(false); reportSessionAction(() => controller.renameSession(id, title)) }} title="Edit session name" />}
      {archiveSession && chat.storedSessionId && <ConfirmDialog disabled={!composerReady} confirmLabel="Archive" description="Archive this session? It will be removed from the active Sessions list." onCancel={() => setArchiveSession(false)} onConfirm={() => { const id = chat.storedSessionId!; setArchiveSession(false); setShowSessionActions(false); reportSessionAction(() => controller.archiveSession(id)) }} title="Archive session" />}
      {chat.pendingPrompt && <PromptCard conversation={conversation} />}
      <div className="composer-wrap" ref={viewport.composerRef}>
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
      {attachments.length > 0 && <div className="composer-attachments" aria-label="Attachments">
        {attachments.map(file => <div className="composer-file" key={file.id}>
          {file.preview && <img alt={`Preview of ${file.name}`} src={file.preview} onError={() => interaction.previewFailed(file.id)} />}
          <div className="composer-file-info"><span className="composer-file-name" title={file.name}>{file.name}</span>
            <span>{Math.ceil(file.size / 1024)} KB · {({ waiting: 'Waiting', uploading: 'Uploading…', ready: 'Ready', failed: 'Failed. Select again or remove.', reattach: 'Select again' })[file.status]}</span>
            {file.error && <span className="error-text">{file.error}</span>}
          </div>
          <Button aria-label={`Remove attachment ${file.name}`} onClick={() => { interaction.removeAttachment(file.id); messageRef.current?.focus() }} size="sm" variant="ghost">Remove</Button>
        </div>)}
      </div>}
      <div className="composer-activity">
        {uploading && <p role="status">Uploading attachments… {attachments.filter(file => file.status === 'ready').length} of {attachments.length} ready.</p>}
        {transcribing && <div><span role="status">Transcribing audio…</span> <Button onClick={() => { interaction.cancelTranscription(); messageRef.current?.focus() }} size="sm" variant="text">Cancel transcription</Button></div>}
        {pendingTranscript && <div className="pending-transcript"><p role="status">Your draft changed. The transcript was not inserted.</p><pre>{pendingTranscript}</pre>
          <Button onClick={() => interaction.useTranscript()} size="sm" variant="text">Insert transcript</Button>
          <Button onClick={() => void copyDraft(pendingTranscript)} size="sm" variant="text">Copy transcript</Button>
          <Button onClick={() => interaction.dismissTranscript()} size="sm" variant="text">Discard transcript</Button>
        </div>}
        {submissionFeedback && <p role="status">{submissionFeedback}</p>}
        {stopFeedback && <p role="status">{stopFeedback}</p>}
        {playback.messageId && <div className="composer-playback" role="group" aria-label="Read-aloud controls">
          <span role="status">{({ idle: 'Audio stopped.', generating: 'Generating speech…', playing: 'Reading message aloud.', paused: 'Audio paused.', ended: 'Audio finished.', error: 'Audio unavailable.' })[playback.status]}</span>
          {['playing', 'paused'].includes(playback.status) && <Button onClick={() => { if (playback.status === 'playing') interaction.playback.pause(); else void interaction.playback.resume() }} size="sm" variant="text">{playback.status === 'playing' ? 'Pause audio' : 'Resume audio'}</Button>}
          <Button onClick={() => { interaction.playback.stop(); messageRef.current?.focus() }} size="sm" variant="text">Stop audio</Button>
          {playback.error && <p role="alert">{playback.error}</p>}
        </div>}
      </div>
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
        <div className="draft-feedback">
          {!localReady ? <p role="status">Selecting the conversation…</p> : !composerReady ? <p role="status">{chat.availability === 'synchronizing' ? 'Updating this conversation. You can prepare your draft.' : 'Local conversation. You can prepare a draft while Hermes is unavailable.'}</p> : draft ? <p role="status">Connected. Your draft has not been sent.</p> : null}
      {(!owner.principal && !owner.locked) && <p className="composer-meta">Restart recovery unavailable. This gateway has not provided an account identity.</p>}
      {(draft || attachmentRefs.length > 0 || interaction.unsaved()) && <p className="composer-meta" role="status">{interaction.saved() ? 'Saved on this device.' : 'Not saved on this device. Copy your text before closing.'}</p>}
      {interaction.needsReattachment() && !uploading && <p role="alert">Select the attached files again or remove them before sending. Files are not stored on this device.</p>}
      {!editValid && <p role="alert">{chat.availability !== 'live' ? 'Reconnect to validate the edited message before retrying. Your text is preserved.' : 'The edited message is not available for retry. Your text is preserved. Copy it or cancel the edit.'}</p>}
      {recoveryError && <p role="status">{recoveryError}</p>}
      {(draft || attachmentRefs.length > 0) && <div className="composer-meta">
        <Button onClick={() => void copyDraft(draft)} size="micro" variant="text">Copy draft</Button>
        <Button onClick={() => interaction.discard()} size="micro" variant="text">Discard draft</Button>
        {!interaction.saved() && <Button onClick={() => chatDrafts.flush()} size="micro" variant="text">Try saving again</Button>}
      </div>}
        </div>
        <div className="composer">
          <label className="icon-input" aria-label="Attach photo, PDF, or file">
            <IconPaperclip size={21} />
            <input accept="image/*,application/pdf,audio/*,*/*" disabled={!composerReady || uploading} multiple onChange={event => { void interaction.attach(event.target.files); event.target.value = '' }} type="file" />
          </label>
          <label className="icon-input" aria-label="Record audio">
            <IconMicrophone size={21} />
            <input accept="audio/*" capture="user" disabled={!composerReady || transcribing} onChange={event => { void interaction.transcribe(event.target.files?.[0]); event.target.value = '' }} type="file" />
          </label>
          <Textarea
            aria-label="Message Hermes"
            ref={messageRef}
            disabled={!localReady}
            autoCapitalize="sentences"
            autoComplete="off"
            autoCorrect="on"
            spellCheck
            onChange={event => interaction.updateDraft(event.target.value)}
            onKeyDown={event => {
              if (composerReady && event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault()
                void interaction.submit()
              }
            }}
            placeholder={chat.running ? 'Queue another prompt…' : 'Message Hermes…'}
            rows={1}
            value={draft}
          />
          <div className="composer-send-actions">
            <Button aria-label={chat.running ? 'Queue' : 'Send'} disabled={!composerReady || submitting || transcribing || !editValid || Boolean(editTarget && chat.running) || interaction.needsReattachment() || (!draft.trim() && attachmentRefs.length === 0)} onClick={() => void interaction.submit()} size="sm"><IconSend size={19} />{chat.running ? 'Queue' : 'Send'}</Button>
            {chat.running && <Button disabled={!composerReady || stopping} aria-label="Stop Hermes" onClick={() => void interaction.interrupt()} size="sm" variant="destructive"><IconPlayerStop size={19} />Stop</Button>}
          </div>
        </div>
        <div className="composer-meta">
          {chat.info?.usage && <ContextUsage usage={chat.info.usage} />}
          {chat.info && (
            <div className="composer-model" role="group" aria-label={composerReady ? 'Session model and effort' : 'Last-known session model and effort'}>
              <span className="composer-model-name" title={`Model: ${chat.info.model ?? 'unavailable'}`}>{chat.info.model ?? 'Model unavailable'}</span>
              <span aria-hidden="true">·</span>
              <span className="composer-model-effort" title={`Reasoning effort: ${chat.info.reasoningEffort ?? 'unavailable'}`}>{chat.info.reasoningEffort ?? 'Effort unavailable'}</span>
            </div>
          )}
          <div className={`session-activity ${chat.running ? 'working' : 'idle'}`} role="status" aria-live="polite">
            <span aria-hidden className="status-dot" />
            <span>{!composerReady ? 'Status unavailable' : chat.running ? 'Hermes is working' : 'Ready'}</span>
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
  const ready = useStore($gatewayReady)
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
          <Button disabled={!ready} onClick={() => void conversation.respond('deny', 'deny')} type="button" variant="secondary">Deny</Button>
          <Button disabled={!ready} onClick={() => void conversation.respond('allow', 'allow')} type="button">Allow once</Button>
        </div>
      ) : (
        <>
          <input autoComplete="off" onChange={event => setValue(event.target.value)} type={pending.kind === 'clarify' ? 'text' : 'password'} value={value} />
          <Button disabled={!ready} type="submit">Respond</Button>
        </>
      )}
      {error && <div className="error-banner" role="alert">{error}</div>}
      {sensitive && <small>This value is sent directly and is never saved by Hermes Mobile.</small>}
    </form>
  )
}
