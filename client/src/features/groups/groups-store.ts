import { atom } from 'nanostores'

import type { GroupRoom } from './group-model'

/**
 * The group chats currently known from the gateway mirror. The roster
 * query syncs it so provider-free consumers (the app header) can render
 * room names without touching gateway context.
 */
export const $groups = atom<GroupRoom[]>([])