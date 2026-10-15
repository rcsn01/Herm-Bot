import { useStore } from '@nanostores/react'
import { currentGatewayScope } from '~/gateway/scope-guard'
import { $draftOwner, draftOwnerKey } from '~/state/draft-owner'
import { localPrivacy } from '~/state/local-privacy'
import { $preferences } from '~/state/store'

/** Remount private discovery UI even when the same owner returns after a reset. */
export function useDiscoveryIdentity(): string {
  const owner = useStore($draftOwner)
  const preferences = useStore($preferences)
  useStore(localPrivacy.$reset)
  return JSON.stringify([draftOwnerKey(owner), owner.generation, owner.locked,
    preferences.remoteURL, preferences.profile, currentGatewayScope().generation,
    localPrivacy.revision(draftOwnerKey(owner))])
}
