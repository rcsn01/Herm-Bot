import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'

import { Button, Input } from '~/compat/primitives'
import { displayNameFor } from '~/features/agents/agent-labels'
import { createAgentsApi } from '~/features/agents/agents-api'
import { useApi } from '~/gateway/gateway-api-hooks'
import { useScopeKey, useScopedQuery } from '~/gateway/scope-guard'

import type { GroupRoom } from './group-model'
import { createGroupChat, GROUP_CHAT_MAX_MEMBERS } from './group-engine'
import { useGroupRooms } from './known-rooms'

const GROUP_NAME_MAX_LENGTH = 64

interface CreateGroupChatDialogProps {
  onCancel(): void
  onCreated(room: GroupRoom): void
  open: boolean
}

export function CreateGroupChatDialog({ onCancel, onCreated, open }: CreateGroupChatDialogProps) {
  const api = useApi(createAgentsApi)
  const rosterKey = useScopeKey('agents', ['roster'], { unscoped: true })
  const roster = useScopedQuery(rosterKey, { enabled: open, queryFn: signal => api.list(signal), retry: false })
  const [name, setName] = useState('')
  const [selectedNames, setSelectedNames] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const profiles = roster.data?.entries ?? []
  const selected = useMemo(() => profiles.filter(profile => selectedNames.has(profile.name)), [profiles, selectedNames])
  const suggestedName = selected.map(displayNameFor).join(', ')
  const knownRooms = useGroupRooms(roster.data?.groups ?? [])
  const groupNames = useMemo(() => new Set(knownRooms.map(room => room.name)), [knownRooms])
  const canCreate = selected.length >= 2 && Boolean((name.trim() || suggestedName).trim())

  useEffect(() => {
    if (!open) return
    setName('')
    setSelectedNames(new Set())
    setError(null)
    nameRef.current?.focus()
  }, [open])

  const toggleProfile = (profileName: string) => {
    setError(null)
    setSelectedNames(current => {
      const next = new Set(current)
      if (next.has(profileName)) next.delete(profileName)
      else if (next.size < GROUP_CHAT_MAX_MEMBERS) next.add(profileName)
      return next
    })
  }

  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (selected.length < 2) {
      setError('Choose at least 2 bots.')
      return
    }
    const base = (name.trim() || suggestedName).slice(0, GROUP_NAME_MAX_LENGTH).trim()
    if (!base) {
      setError('Enter a group chat name.')
      return
    }

    try {
      const members = selected.map(profile => ({ name: profile.name }))
      const room = createGroupChat(base, members, groupNames)
      onCreated(room)
      onCancel()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the group chat.')
    }
  }

  if (!open) return null

  return (
    <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onCancel() }} role="presentation">
      <form aria-describedby="create-group-chat-help" aria-labelledby="create-group-chat-title" aria-modal="true" className="mobile-dialog group-create-dialog" onKeyDown={event => { if (event.key === 'Escape') onCancel() }} onSubmit={create} role="dialog">
        <h3 id="create-group-chat-title">New group chat</h3>
        <p className="dialog-help" id="create-group-chat-help">Choose 2–{GROUP_CHAT_MAX_MEMBERS} bots to share the conversation.</p>
        <label htmlFor="create-group-chat-name">Group name</label>
        <Input id="create-group-chat-name" maxLength={GROUP_NAME_MAX_LENGTH} onChange={event => { setError(null); setName(event.target.value) }} placeholder={suggestedName || 'Research team'} ref={nameRef} value={name} />
        <p className="dialog-help">Leave the name blank to use the selected bot names.</p>

        <fieldset className="group-member-fieldset">
          <legend>Choose bots ({selected.length}/{GROUP_CHAT_MAX_MEMBERS})</legend>
          {roster.isPending && <p className="dialog-help" role="status">Loading bots…</p>}
          {roster.error && <p className="dialog-field-error" role="alert">Bots could not be loaded.</p>}
          {!roster.isPending && profiles.length === 0 && <p className="dialog-help">No bots are available yet. Create a bot first.</p>}
          <div className="group-member-list">
            {profiles.map(profile => {
              const label = displayNameFor(profile)
              const checked = selectedNames.has(profile.name)
              const disabled = !checked && selected.length >= GROUP_CHAT_MAX_MEMBERS
              return (
                <label className={`group-member-option${disabled ? ' disabled' : ''}`} key={profile.name}>
                  <input aria-label={label} checked={checked} disabled={disabled} onChange={() => toggleProfile(profile.name)} type="checkbox" />
                  <span><strong>{label}</strong>{profile.description && <small>{profile.description}</small>}</span>
                </label>
              )
            })}
          </div>
        </fieldset>

        {error && <p className="dialog-field-error" role="alert">{error}</p>}
        <div className="button-row">
          <Button onClick={onCancel} type="button" variant="secondary">Cancel</Button>
          <Button disabled={!canCreate} type="submit">{selected.length ? `Create group chat (${selected.length})` : 'Create group chat'}</Button>
        </div>
      </form>
    </div>
  )
}
