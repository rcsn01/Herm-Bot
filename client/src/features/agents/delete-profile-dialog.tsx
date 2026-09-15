import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { Button } from '~/compat/primitives'
import { useApi } from '~/gateway/gateway-api-hooks'
import { useScopeKey, useScopedTask } from '~/gateway/scope-guard'

import { createAgentsApi, isSuccessfulCliResult, type AgentRosterEntry } from './agents-api'

interface DeleteProfileDialogProps {
  bot: AgentRosterEntry | null
  onCancel(): void
  onDeleted?(name: string): void
  open: boolean
}

export function DeleteProfileDialog({ bot, onCancel, onDeleted, open }: DeleteProfileDialogProps) {
  const agents = useApi(createAgentsApi)
  const queryClient = useQueryClient()
  const rosterKey = useScopeKey('agents', ['roster'], { unscoped: true })
  const task = useScopedTask()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (open && bot) cancelRef.current?.focus() }, [bot, open])
  if (!open || !bot) return null

  const remove = () => {
    if (bot.isDefault) {
      setError('The default profile cannot be deleted.')
      return
    }
    setError(null)
    void task.run(async () => {
      const result = await agents.delete(bot.name)
      if (!isSuccessfulCliResult(result)) {
        throw new Error(result.hint || 'The profile could not be deleted.')
      }
      return result
    }, {
      onBusy: setBusy,
      onError: classified => setError(classified.message),
      onSettled: () => undefined
    }).then(result => {
      if (!result) return
      void queryClient.invalidateQueries({ queryKey: rosterKey })
      onDeleted?.(bot.name)
      onCancel()
    })
  }

  return (
    <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onCancel() }} role="presentation">
      <section aria-describedby="delete-profile-description" aria-labelledby="delete-profile-title" aria-modal="true" className="mobile-dialog" onKeyDown={event => { if (event.key === 'Escape' && !busy) onCancel() }} role="alertdialog" tabIndex={-1}>
        <h3 id="delete-profile-title">Delete profile?</h3>
        <p id="delete-profile-description">Delete <strong>{bot.name}</strong> and its local configuration? This cannot be undone.</p>
        {error && <p className="dialog-field-error" role="alert">{error}</p>}
        <div className="button-row">
          <Button disabled={busy} onClick={onCancel} ref={cancelRef} type="button" variant="secondary">Cancel</Button>
          <Button disabled={busy} onClick={remove} type="button" variant="destructive">{busy ? 'Deleting…' : 'Delete profile'}</Button>
        </div>
      </section>
    </div>
  )
}

