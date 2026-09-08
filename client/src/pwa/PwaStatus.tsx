import { useStore } from '@nanostores/react'

import { $chat } from '~/state/conversation'

import { activatePwaUpdate, $pwa, dismissPwaMessage, installPwa } from './lifecycle'
import './pwa.css'

export function PwaStatus() {
  const pwa = useStore($pwa)
  const chat = useStore($chat)
  const reloadBlocked = chat.running || Boolean(chat.pendingPrompt)

  if (!pwa.offline && !pwa.updateAvailable && !pwa.installPrompt && !pwa.error) return null

  return (
    <aside className="pwa-status" aria-label="App status">
      {pwa.offline ? <span role="status">Offline. Reconnect to use your gateway.</span> : null}
      {pwa.error ? <span role="status">{pwa.error}</span> : null}
      {pwa.updateAvailable ? (
        <span>
          <span>Update ready</span>
          <button
            type="button"
            disabled={reloadBlocked || pwa.updating || pwa.offline}
            title={reloadBlocked ? 'Finish the active turn or approval first' : undefined}
            onClick={() => void activatePwaUpdate()}
          >
            {pwa.updating ? 'Updating…' : reloadBlocked ? 'Update after turn' : 'Update'}
          </button>
        </span>
      ) : null}
      {pwa.installPrompt ? <button type="button" onClick={() => void installPwa()}>Install app</button> : null}
      {pwa.error || pwa.installPrompt ? <button type="button" onClick={dismissPwaMessage}>Dismiss</button> : null}
    </aside>
  )
}

export function PwaInstallHelp() {
  return (
    <section className="pwa-install-help" aria-labelledby="pwa-install-help-title">
      <h3 id="pwa-install-help-title">Install on iPhone or iPad</h3>
      <p>Open Hermes in Safari, tap Share, then choose Add to Home Screen.</p>
    </section>
  )
}
