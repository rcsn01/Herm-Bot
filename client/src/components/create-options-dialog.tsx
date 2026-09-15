import { IconRobot, IconUsers } from '@tabler/icons-react'
import { useEffect, useRef } from 'react'

import { Button } from '~/compat/primitives'

interface CreateOptionsDialogProps {
  onCancel(): void
  onNewBot(): void
  onNewGroup(): void
  open: boolean
}

export function CreateOptionsDialog({ onCancel, onNewBot, onNewGroup, open }: CreateOptionsDialogProps) {
  const firstOptionRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (open) firstOptionRef.current?.focus()
  }, [open])

  if (!open) return null

  return (
    <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onCancel() }} role="presentation">
      <section aria-describedby="create-options-help" aria-labelledby="create-options-title" aria-modal="true" className="mobile-dialog create-options-dialog" onKeyDown={event => { if (event.key === 'Escape') onCancel() }} role="dialog" tabIndex={-1}>
        <h3 id="create-options-title">Create new</h3>
        <p className="dialog-help" id="create-options-help">Choose what you want to add to your roster.</p>
        <div className="create-options-list">
          <Button aria-label="New bot" className="create-option" onClick={onNewBot} ref={firstOptionRef} type="button" variant="secondary">
            <IconRobot aria-hidden="true" size={22} />
            <span><strong>New bot</strong><small>Create a profile with its own memory and chat.</small></span>
          </Button>
          <Button aria-label="New group chat" className="create-option" onClick={onNewGroup} type="button" variant="secondary">
            <IconUsers aria-hidden="true" size={22} />
            <span><strong>New group chat</strong><small>Choose multiple bots for a shared conversation.</small></span>
          </Button>
        </div>
        <div className="button-row"><Button onClick={onCancel} type="button" variant="text">Cancel</Button></div>
      </section>
    </div>
  )
}
