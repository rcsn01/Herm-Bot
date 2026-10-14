import { atom } from 'nanostores'

export interface DraftOwner {
  gateway: string
  principal: string | null
  generation: number
  locked: boolean
}

export const $draftOwner = atom<DraftOwner>({ gateway: '', principal: null, generation: 0, locked: false })

/** Identity comes from the authenticated connection, never from a credential or display name. */
export function draftPrincipal(identity: unknown): string | null {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return null
  const value = identity as { org_id?: unknown; user_id?: unknown; provider?: unknown }
  if (typeof value.org_id !== 'string' || value.org_id.length > 512
    || typeof value.user_id !== 'string' || value.user_id.length === 0 || value.user_id.length > 512) return null
  if (value.org_id.length > 0) return JSON.stringify([value.org_id, value.user_id])
  // Authenticated gateway-local accounts have an explicit empty organization.
  // Include the provider and use a distinct shape from organization identities.
  if (typeof value.provider !== 'string' || value.provider.length === 0 || value.provider.length > 512) return null
  return JSON.stringify(['local', value.provider, value.user_id])
}

export function verifyDraftOwner(gateway: string, identity: unknown) {
  const principal = draftPrincipal(identity)
  const previous = $draftOwner.get()
  const changed = previous.gateway !== gateway || previous.principal !== principal || previous.locked
  $draftOwner.set({ gateway, principal, generation: previous.generation + Number(changed), locked: false })
  return changed
}

export function lockDraftOwner() {
  const previous = $draftOwner.get()
  $draftOwner.set({ ...previous, generation: previous.generation + 1, locked: true })
}

export function draftOwnerKey(owner: DraftOwner): string {
  return JSON.stringify([owner.gateway, owner.principal ?? `memory:${owner.generation}`])
}
