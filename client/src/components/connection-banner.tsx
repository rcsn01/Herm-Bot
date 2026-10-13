import { useStore } from '@nanostores/react'
import { Button } from '~/compat/primitives'
import { $connection, $gatewayReady } from '~/state/store'
import { $networkStatus } from '~/state/network-status'
import { $chat } from '~/state/conversation'

export function ConnectionBanner({ onRetry }: { onRetry(): unknown }) {
  const connection = useStore($connection)
  const network = useStore($networkStatus)
  const chat = useStore($chat)
  const ready = useStore($gatewayReady)
  const recovering = connection.phase === 'connecting' || connection.phase === 'reconnecting'
  const message = network.status === 'offline' ? 'Device offline. You can read saved conversations and prepare drafts.'
    : chat.availability === 'synchronizing' ? 'Updating this conversation…'
    : recovering ? 'Reconnecting to Hermes…'
    : connection.errorKind === 'server' ? 'Gateway unavailable. Saved conversations remain available.'
    : 'Cannot reach Hermes.'
  return <div className="connection-banner" hidden={ready && chat.availability === 'live'}>
    <span aria-live="polite" role="status">{ready && chat.availability === 'live' ? '' : message}</span>
    {(!ready || chat.availability !== 'live') && !recovering && network.status !== 'offline' && connection.errorKind !== 'auth' && <Button onClick={onRetry} size="sm" variant="secondary">Retry</Button>}
  </div>
}
