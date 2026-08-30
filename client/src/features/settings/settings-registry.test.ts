import { describe, expect, it } from 'vitest'

import { BACKEND_SETTINGS_SECTIONS, SETTINGS_ENTRIES } from './settings-registry'

describe('settings registry', () => {
  it('keeps backend categories in the shared order and administration after them', () => {
    expect(SETTINGS_ENTRIES.slice(0, BACKEND_SETTINGS_SECTIONS.length).map(entry => entry.id)).toEqual(BACKEND_SETTINGS_SECTIONS.map(section => section.id))
    expect(SETTINGS_ENTRIES.map(entry => entry.label)).toEqual([
      'Model', 'Chat', 'Appearance', 'Workspace', 'Safety', 'Browser', 'Memory & Context', 'Voice', 'Advanced',
      'Notifications', 'Billing', 'Providers', 'Gateways', 'Keyboard Shortcuts', 'Tools & Keys', 'Plugins', 'Archived Chats', 'About'
    ])
  })
})
