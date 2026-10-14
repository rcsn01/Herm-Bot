import { useStore } from '@nanostores/react'
import { useRef, useState } from 'react'
import { IconChevronLeft } from '@tabler/icons-react'
import { Button, Switch } from '~/compat/primitives'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { $draftOwner, draftOwnerKey } from '~/state/draft-owner'
import { $chat } from '~/state/conversation'
import { chatDrafts } from '~/features/chat/chat-drafts'
import { $groupChats, $groupPrompts } from '~/features/groups/group-engine'
import { localPrivacy, type PrivacyResult } from '~/state/local-privacy'
import type { GatewayController } from '~/state/gateway-controller'
import { SettingsPageShell } from './settings-page-shell'

export function PrivacySettings({ controller, onBack }: { controller: GatewayController; onBack(): void }) {
  const policy = useStore(localPrivacy.$state)
  const owner = useStore($draftOwner)
  useStore($chat)
  useStore(chatDrafts.$version)
  useStore($groupChats)
  useStore($groupPrompts)
  const reset = useStore(localPrivacy.$reset)
  const [confirmation, setConfirmation] = useState<{ kind: 'history' | 'clear'; owner: string } | null>(null)
  const [result, setResult] = useState<PrivacyResult | null>(null)
  const historyRef = useRef<HTMLElement>(null)
  const clearRef = useRef<HTMLButtonElement>(null)
  const blocker = controller.privacyClearBlocker()
  const close = () => {
    const target = confirmation?.kind === 'history' ? historyRef : clearRef
    setConfirmation(null)
    queueMicrotask(() => target.current?.focus())
  }
  const confirm = () => {
    if (!confirmation) return
    const outcome = confirmation.kind === 'history' ? localPrivacy.setHistorySaving(false) : controller.clearLocalData(confirmation.owner)
    setResult(outcome)
    close()
  }
  return <SettingsPageShell leading={<Button onClick={onBack} variant="text"><IconChevronLeft size={18} /> Back</Button>} title="Privacy">
    <section className="data-card">
      <h3>Conversation history</h3>
      <p>Save conversation history on this device for all accounts, gateways, and profiles. When off, visited conversations remain available only while the app is open.</p>
      <label className="toggle-field"><span><strong>Save conversation history on this device</strong><small aria-hidden="true">{policy.saveHistory ? 'On' : 'Off'}</small></span><Switch checked={policy.saveHistory} onCheckedChange={enabled => {
        setResult(null)
        if (!enabled) setConfirmation({ kind: 'history', owner: draftOwnerKey(owner) })
        else setResult(localPrivacy.setHistorySaving(true))
      }} ref={historyRef} /></label>
      <p className="muted">These controls cover regular chats. Unfinished drafts are saved separately even when history saving is off. Sign out or Clear local data removes this account’s regular-chat drafts. Remote conversations are unchanged.</p>
      <p className="muted">Group-room logs use separate shared local storage and are not removed or disabled here. Clear this site’s data through the browser for a full reset before sharing the device.</p>
      {!policy.saveHistory && <p>History saving is off. In-memory conversations are not saved on this device.</p>}
    </section>
    <section className="data-card">
      <h3>Clear local data</h3>
      <p>{owner.principal ? 'Remove this verified account’s saved history, all unfinished drafts and recovery copies, attachment metadata, and session bookmarks across every profile on this gateway.' : 'This connection has no verified persistent account identity. Only its in-memory conversation data can be cleared.'}</p>
      <p className="muted">Gateway: {owner.gateway || 'Not verified'}</p>
      {owner.principal && <p className="muted">Verified account: {owner.principal}</p>}
      <p>Remote conversations and running agents are not deleted or stopped. Sign-in, theme, other preferences, and other accounts’ data are kept. To read remote history again, explicitly open a conversation.</p>
      <Button disabled={Boolean(blocker)} onClick={() => { setResult(null); setConfirmation({ kind: 'clear', owner: draftOwnerKey(owner) }) }} ref={clearRef} variant="destructive">{owner.principal ? 'Clear local data' : 'Clear current connection memory'}</Button>
      {blocker && <p role="status">{blocker}</p>}
    </section>
    {policy.error && <><p className="error-text" role="alert">{policy.error}</p>{!policy.saveHistory && <Button onClick={() => setResult(localPrivacy.setHistorySaving(false))} variant="secondary">Retry history removal</Button>}</>}
    {result && <p className={result.complete ? 'muted' : 'error-text'} role={result.complete ? 'status' : 'alert'}>{result.complete ? 'Privacy change completed. Remote conversations and unrelated preferences are unchanged.' : `${result.failures.join(' ')} Removal may be incomplete. Retry the action, or clear this site’s data before sharing the device.`}</p>}
    {!result && reset?.owner === draftOwnerKey(owner) && <p role="status">{reset.external ? 'This account’s local conversation view was reset in another tab. Check that tab for removal results.' : 'This account’s local conversation view was reset. Run Clear local data again if removal was not confirmed.'} Remote work may continue. Open a conversation explicitly to load history again.</p>}
    {confirmation && <ConfirmDialog confirmLabel={confirmation.kind === 'history' ? 'Turn off and remove saved history' : 'Clear local data'} description={confirmation.kind === 'history'
      ? 'Turn off history saving and remove saved conversation history for ALL accounts on this browser/app installation? Drafts, remote conversations, sign-in, and other preferences are kept.'
      : owner.principal ? `Permanently discard this account’s local history, unfinished drafts, edit drafts, recovery copies, attachment metadata, and bookmarks across ALL profiles on ${owner.gateway}? Remote conversations, sign-in, preferences, and other accounts are kept. This cannot be undone.`
      : 'Discard this connection’s in-memory history, unfinished drafts, recovery copies, and bookmarks? No persistent account data, remote conversations, sign-in, or preferences will be removed.'}
      disabled={confirmation.kind === 'clear' && (Boolean(blocker) || confirmation.owner !== draftOwnerKey(owner))} onCancel={close} onConfirm={confirm} title={confirmation.kind === 'history' ? 'Turn off history saving?' : 'Clear this account’s local data?'} />}
  </SettingsPageShell>
}
