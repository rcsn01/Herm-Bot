import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import { IconChevronLeft } from '@tabler/icons-react'
import { Button } from '~/compat/primitives'
import { $gatewayReady } from '~/state/store'
import { $networkStatus } from '~/state/network-status'
import { $draftOwner } from '~/state/draft-owner'
import { $webPush, disableWebPush, enableWebPush, refreshWebPushState, sendTestNotification, webPushEnvironment } from '~/pwa/push'
import { SettingsPageShell } from './settings-page-shell'

export function NotificationsSettings({ onBack }: { onBack(): void }) {
  const push = useStore($webPush)
  const ready = useStore($gatewayReady)
  const network = useStore($networkStatus)
  const owner = useStore($draftOwner)
  const environment = webPushEnvironment()
  const available = ready && network.status !== 'offline' && !owner.locked
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!available || environment !== 'supported') return
    const refresh = () => { if (document.visibilityState === 'visible') void refreshWebPushState() }
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [available, environment, owner.generation])
  useEffect(() => {
    if (push.retryAt <= Date.now()) return
    const timer = setTimeout(() => setNow(Date.now()), push.retryAt - Date.now() + 10)
    return () => clearTimeout(timer)
  }, [push.retryAt])
  const action = (work: () => Promise<void>) => { if ($gatewayReady.get() && $networkStatus.get().status !== 'offline' && !$draftOwner.get().locked) void work() }
  const blocked = !available || push.busy
  const registration = !available ? 'Could not verify while disconnected' : ({ unknown: 'Not verified', checking: 'Checking', missing: 'Not registered for this account', confirmed: 'Registered for this account' }[push.registration])
  const local = { unknown: 'Not checked', checking: 'Checking', missing: 'No local subscription', present: 'Present on this device', expired: 'Expired; disable then enable again', incompatible: 'Old key; disable and enable again' }[push.local]
  return <SettingsPageShell leading={<Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>} title="Notifications">
    <section className="data-card" aria-labelledby="notification-setup-title"><h3 id="notification-setup-title">This device</h3>
      {environment === 'native' ? <p>Web Push is available in a supported browser or installed PWA. Native app notifications require APNs support, which is not configured here.</p> : environment === 'install-ios' ? <p>On iPhone or iPad, open Hermes in Safari, tap Share, then Add to Home Screen. Open the installed app and tap Enable notifications. Web Push requires a supported iOS/iPadOS version.</p> : environment === 'insecure' ? <p>Notifications require a secure HTTPS connection and a supported browser.</p> : environment === 'unsupported' ? <p>This browser does not expose the required Web Push APIs. Try a supported browser. On iPhone or iPad, use the installed Home Screen app.</p> : <>
        <p>Permission, a local subscription, and registration with this account are separate setup steps. They do not guarantee OS delivery.</p>
        <dl className="notification-facts"><dt>Browser permission</dt><dd>{push.permission === 'default' ? 'Not requested or dismissed' : push.permission === 'denied' ? 'Blocked' : push.permission}</dd><dt>Local subscription</dt><dd>{local}</dd><dt>Server registration</dt><dd>{registration}</dd><dt>Automatic task delivery</dt><dd>Not checked. A test uses the relay directly; it does not verify the completion bridge or every bot.</dd></dl>
        {!available && <p role="status">Reconnect and verify your account to check server registration or change notification setup. Local facts may be from the last check.</p>}
        {push.permission === 'denied' && <p>Notifications are blocked. Allow this site or installed app in browser/OS notification settings, then return and refresh status. Repeated permission requests cannot unblock it.</p>}
        <div className="notification-actions"><Button disabled={blocked} onClick={() => action(refreshWebPushState)} variant="outline">Refresh status</Button>
          <Button disabled={blocked || push.permission === 'denied' || push.local === 'expired' || push.local === 'incompatible'} onClick={() => action(enableWebPush)}>{push.registration === 'confirmed' ? 'Recheck registration' : push.local === 'present' ? 'Repair registration' : 'Enable notifications'}</Button>
          <Button disabled={blocked || push.local === 'missing' || push.local === 'unknown'} onClick={() => action(disableWebPush)} variant="outline">Disable notifications</Button></div>
        <p className="muted">Disabling removes the subscription; it does not reset browser permission. Installation is optional in browsers that support Web Push without it.</p>
      </>}
    </section>
    {environment === 'supported' && <section className="data-card" aria-labelledby="notification-test-title"><h3 id="notification-test-title">Test background notifications</h3><p>Sends one fixed, nonsensitive notification to this device only. No conversation content is included. Tap it to open Hermes normally.</p>
      <Button disabled={blocked || !push.enabled || push.retryAt > now} onClick={() => action(sendTestNotification)}>{push.test === 'sending' ? 'Submitting test…' : push.retryAt > now ? 'Wait before another test' : 'Send test notification'}</Button>
      <div role="status" aria-live="polite" aria-atomic="true">{push.test === 'accepted' ? 'Test accepted by the push service. Check this device’s notifications; delivery is not confirmed.' : push.test === 'expired' ? 'The push service reports this registration expired. Disable and enable notifications again.' : push.test === 'unknown' ? 'Test outcome is unknown. It may still arrive. Wait before retrying.' : push.busy ? 'Checking or updating notification setup…' : ''}</div>
      <p className="muted">Try with the app backgrounded. If nothing appears, check connectivity, OS notification settings and Focus/Do Not Disturb. A closed app, force-stop, battery policy or OS restrictions may affect delivery.</p>
    </section>}
    {push.error && environment === 'supported' && <p role="alert" className="error-text">{push.error}</p>}
  </SettingsPageShell>
}
