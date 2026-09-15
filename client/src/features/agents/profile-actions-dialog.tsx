import { useEffect, useRef } from 'react'

import { Button } from '~/compat/primitives'

import type { AgentRosterEntry } from './agents-api'

interface ProfileActionsDialogProps {
  bot: AgentRosterEntry | null
  onCancel(): void
  onDelete(): void
  onDuplicate(): void
  onEdit(): void
}

export function ProfileActionsDialog({ bot, onCancel, onDelete, onDuplicate, onEdit }: ProfileActionsDialogProps) {
  const firstActionRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (bot) firstActionRef.current?.focus() }, [bot])
  if (!bot) return null
  return (
    <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onCancel() }} role="presentation">
      <section aria-labelledby="profile-actions-title" aria-modal="true" className="mobile-dialog profile-actions-dialog" onKeyDown={event => { if (event.key === 'Escape') onCancel() }} role="dialog" tabIndex={-1}>
        <h3 id="profile-actions-title">{bot.meta?.title || bot.name}</h3>
        <p className="dialog-help">Manage this profile without switching the active conversation.</p>
        <div className="profile-action-list">
          <Button onClick={onEdit} ref={firstActionRef} type="button" variant="secondary">Edit profile</Button>
          <Button onClick={onDuplicate} type="button" variant="secondary">Duplicate profile</Button>
          {!bot.isDefault && <Button onClick={onDelete} type="button" variant="destructive">Delete profile</Button>}
        </div>
        <div className="button-row"><Button onClick={onCancel} type="button" variant="text">Cancel</Button></div>
      </section>
    </div>
  )
}
