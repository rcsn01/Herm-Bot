import { useEffect, useMemo, useRef, useState } from 'react'

import { useStore } from '@nanostores/react'

import { createAgentsApi } from '~/features/agents/agents-api'
import { useApi } from '~/gateway/gateway-api-hooks'
import { useScopeKey, useScopedQuery } from '~/gateway/scope-guard'

import type { GroupMember, GroupRoom } from './group-model'
import {
  $groupChats,
  adoptMirrorRoom,
  getGroupRoom,
  type GroupChatRoom
} from './group-store'
import { $groupActivity, $groupNeedsYou, $groupPrompts, type GroupActivityEntry, type GroupPrompt } from './group-engine'
import { answerGroupClarify, harvestStrandedGroupReply } from './group-turns'
import { pullGroupChatState } from './groups-sync'
import { sendToGroupChat, stopGroupThread } from './group-rounds'
import { $groups } from './groups-store'

/**
 * The desktop-mirrored group chats, from the same unscoped profiles.list RPC
 * the roster uses — react-query dedupes the fetch, so opening a room costs
 * nothing on top of the main screen.
 */
export function useGroupRooms(): GroupRoom[] {
  const api = useApi(createAgentsApi)
  const rosterKey = useScopeKey('agents', ['roster'], { unscoped: true })
  const roster = useScopedQuery(rosterKey, { queryFn: signal => api.list(signal), retry: false })
  const rooms = useMemo(() => roster.data?.groups ?? [], [roster.data])
  useEffect(() => {
    $groups.set(rooms)
  }, [rooms])
  return rooms
}

/** One room's engine state: the local coordination store, activity feed,
 *  and pending prompts, narrowed to this room's display name. */
function useGroupEngineState(name: string) {
  const rooms = useStore($groupChats)
  const activityAll = useStore($groupActivity)
  const promptsAll = useStore($groupPrompts)
  const needsYouAll = useStore($groupNeedsYou)

  return {
    room: rooms[name],
    activity: activityAll[name] ?? [],
    prompts: Object.values(promptsAll).filter(prompt => prompt.group === name),
    needsYou: Boolean(needsYouAll[name])
  }
}

const ACTIVITY_TEXT: Record<GroupActivityEntry['kind'], string> = {
  cancelled: 'cancelled',
  capped: 'round limit reached',
  delivered: 'delivered a late reply',
  failed: 'could not be reached',
  held: 'held — say “resume @name” to release',
  passed: 'passed',
  queued: '',
  replied: 'replied',
  settled: 'the room settled',
  stopped: 'stopped',
  'timed-out': 'is still working…',
  working: 'is thinking…'
}

/** The grey activity line under the log; null = nothing to show. */
function describeActivity(entry: GroupActivityEntry): null | string {
  const verb = ACTIVITY_TEXT[entry.kind]
  if (!verb) return null // 'queued' — the user bubble already shows it
  const who = entry.member && entry.member !== 'You' ? `${entry.member} ` : ''
  return `${who}${verb}`
}

/**
 * One desktop Bot Mode group chat. Reading renders from the local engine
 * store (richer than the mirror: watermarks, runtime state); sending runs
 * the desktop's round engine — bounded serial round-robin over per-member
 * hidden sessions, @mention routing, "(pass)" silence, stop holds, and
 * stranded-reply harvest.
 */
export function GroupChatScreen({ roomId }: { roomId: string }) {
  const rooms = useGroupRooms()
  const room = rooms.find(candidate => candidate.key === roomId)
  const engine = useGroupEngineState(room?.name ?? roomId)
  const [draft, setDraft] = useState('')
  const [newThreadNext, setNewThreadNext] = useState(false)
  const pulledRef = useRef<string | null>(null)

  // Adopt the mirror row locally, then pull the live projection and harvest
  // stranded replies: work that finished after a turn timeout posts late
  // into the room instead of vanishing.
  useEffect(() => {
    if (!room || pulledRef.current === room.name) return
    pulledRef.current = room.name
    adoptMirrorRoom(room)
    void pullGroupChatState().catch(() => undefined)
    const local = getGroupRoom(room.name)
    if (local.stranded && Object.keys(local.stranded).length > 0) {
      void Promise.all(room.members.map(member => harvestStrandedGroupReply(room.name, member))).catch(
        () => undefined
      )
    }
  }, [room])

  if (!room) {
    return (
      <section aria-label="Group chat" className="screen page-screen group-screen">
        <p className="muted" role="status">This group chat is not available on this gateway yet.</p>
      </section>
    )
  }

  const engineRoom: GroupChatRoom = engine.room ?? getGroupRoom(room.name)
  const targetThread = newThreadNext ? null : (latestThreadId(engineRoom.log) ?? null)

  const send = () => {
    const text = draft.trim()
    if (!text || room.members.length === 0) return
    setDraft('')
    setNewThreadNext(false)
    sendToGroupChat(room.name, room.members, text, targetThread)
  }

  return (
    <section aria-label={`Group chat ${room.name}`} className="screen page-screen group-screen">
      <div className="group-log" aria-live="polite">
        {room.members.length > 0 && (
          <p className="muted group-members">
            {room.members.length} bot{room.members.length === 1 ? '' : 's'} · {room.members.map(member => member.handle ?? member.name).join(', ')}
          </p>
        )}
        {engineRoom.log.map(entry => (
          <article
            className={`message ${entry.from.kind === 'user' ? 'user' : 'assistant'}`}
            key={entry.id ?? `${entry.at}-${entry.from.name}`}
          >
            {entry.from.kind === 'member' && (
              <div className="message-meta">
                <span>{entry.from.name}{entry.from.source ? ` · ${entry.from.source}` : ''}</span>
              </div>
            )}
            <div className="message-content">{entry.text}</div>
          </article>
        ))}
        {engine.activity.map((entry, index) => {
          const line = describeActivity(entry)
          if (!line) return null
          return (
            <p className="muted group-activity-line" key={`${entry.at}-${index}`}>{line}</p>
          )
        })}
        {engine.prompts.map(prompt => (
          <GroupPromptCard key={`${prompt.memberKey}-${prompt.requestId}`} members={engineRoom.members} prompt={prompt} />
        ))}
      </div>
      {engineRoom.running && (
        <button className="group-stop" onClick={() => void stopGroupThread(room.name, targetThread, room.members)}>
          Stop
        </button>
      )}
      <form
        className="group-composer"
        onSubmit={event => {
          event.preventDefault()
          send()
        }}
      >
        <textarea
          aria-label={`Message ${room.name}`}
          placeholder={newThreadNext ? 'New thread…' : 'Message the group…'}
          rows={2}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              send()
            }
          }}
        />
        <div className="group-composer-actions">
          <button
            className={newThreadNext ? 'group-new-thread active' : 'group-new-thread'}
            onClick={event => {
              event.preventDefault()
              setNewThreadNext(value => !value)
            }}
            title="Start a new thread with the next send"
          >
            + thread
          </button>
          <button className="group-send" disabled={!draft.trim() || room.members.length === 0}>Send</button>
        </div>
      </form>
      <p className="muted group-send-note">Sending runs the same round engine as Desktop — members reply in their own group sessions.</p>
    </section>
  )
}

/** The most recently active thread id in a room log ('legacy' counts). */
function latestThreadId(log: GroupChatRoom['log']): null | string {
  for (let i = log.length - 1; i >= 0; i--) {
    const thread = log[i]?.thread
    if (thread) return thread
  }
  return null
}

/** A clarify question or command approval blocking inside a member's
 *  session, mirrored out of its resume snapshot (#90694). */
function GroupPromptCard({ prompt, members }: { prompt: GroupPrompt; members: GroupMember[] }) {
  const member = members.find(candidate => candidate.name === prompt.member) ?? { name: prompt.member }
  const [draft, setDraft] = useState('')

  const answer = (choice?: string) => {
    void answerGroupClarify(prompt, member, choice ?? draft).catch(() => undefined)
  }

  return (
    <div className="group-prompt-card" data-kind={prompt.kind}>
      <p className="group-prompt-member">{prompt.member} needs you{prompt.kind === 'approval' ? ' to approve a command' : ''}</p>
      {prompt.kind === 'approval' && prompt.command && <pre className="group-prompt-command">{prompt.command}</pre>}
      {prompt.question && <p className="group-prompt-question">{prompt.question}</p>}
      {prompt.kind === 'clarify' && !prompt.questions?.length && (
        <input
          aria-label="Answer"
          placeholder="Type an answer…"
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              answer()
            }
          }}
        />
      )}
      {prompt.choices?.map(choice => (
        <button className="group-prompt-choice" key={choice} onClick={() => answer(choice)}>
          {choice}
        </button>
      ))}
    </div>
  )
}