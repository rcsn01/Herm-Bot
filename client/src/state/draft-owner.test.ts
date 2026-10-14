import { beforeEach, expect, it } from 'vitest'

import { $draftOwner, draftPrincipal, draftOwnerKey, lockDraftOwner, verifyDraftOwner } from './draft-owner'

beforeEach(() => $draftOwner.set({ gateway: '', principal: null, generation: 0, locked: false }))

it('uses only stable organization and user IDs, never credentials or display names', () => {
  verifyDraftOwner('https://gateway.test', { org_id: 'org', user_id: 'user', email: 'private', token: 'secret' })
  expect(draftOwnerKey($draftOwner.get())).not.toMatch(/private|secret/)
  const generation = $draftOwner.get().generation
  verifyDraftOwner('https://gateway.test', { org_id: 'org', user_id: 'user', display_name: 'changed' })
  expect($draftOwner.get().generation).toBe(generation)
})

it('recognizes authenticated gateway-local users without an organization', () => {
  const identity = { org_id: '', user_id: 'local-user', provider: 'password' }
  verifyDraftOwner('https://gateway.test', identity)
  expect($draftOwner.get().principal).toBe(JSON.stringify(['local', 'password', 'local-user']))
  const generation = $draftOwner.get().generation
  verifyDraftOwner('https://gateway.test', { ...identity, email: 'changed', display_name: 'changed' })
  expect($draftOwner.get().generation).toBe(generation)
  expect(draftPrincipal({ ...identity, provider: 'other' })).not.toBe($draftOwner.get().principal)
  expect(draftPrincipal({ ...identity, user_id: 'other' })).not.toBe($draftOwner.get().principal)
  expect(draftPrincipal({ ...identity, org_id: 'local' })).not.toBe($draftOwner.get().principal)
})

it.each([
  { org_id: '', user_id: 'user' },
  { org_id: '', user_id: 'user', provider: '' },
  { org_id: '', user_id: '', provider: 'password' },
  { org_id: null, user_id: 'user', provider: 'password' },
  { org_id: '', user_id: 'user', provider: 'x'.repeat(513) }
])('rejects incomplete gateway-local identity %j', identity => {
  expect(draftPrincipal(identity)).toBeNull()
})

it('retires callbacks even when signing back into the same account', () => {
  verifyDraftOwner('https://gateway.test', { org_id: 'org', user_id: 'user' })
  const generation = $draftOwner.get().generation
  lockDraftOwner()
  verifyDraftOwner('https://gateway.test', { org_id: 'org', user_id: 'user' })
  expect($draftOwner.get().generation).toBeGreaterThan(generation)
})

it.each([null, {}, { user_id: 'user' }, { org_id: 'org', user_id: 3 }])('does not invent an account for invalid identity %j', value => {
  verifyDraftOwner('https://gateway.test', value)
  expect($draftOwner.get().principal).toBeNull()
})
