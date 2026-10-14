import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PrivacySettings } from './privacy-settings'
import { localPrivacy } from '~/state/local-privacy'
import { $draftOwner, draftOwnerKey } from '~/state/draft-owner'
import { $chat, emptyChatState } from '~/state/conversation'
import type { GatewayController } from '~/state/gateway-controller'

const clearLocalData = vi.fn(() => ({ complete: true, failures: [] as string[] }))
const privacyClearBlocker = vi.fn((): string | null => null)
const controller = { clearLocalData, privacyClearBlocker } as unknown as GatewayController
beforeEach(() => {
  localStorage.clear()
  localPrivacy.setHistorySaving(true)
  $chat.set(emptyChatState())
  $draftOwner.set({ gateway: 'https://gateway.test', principal: 'account-a', generation: $draftOwner.get().generation + 1, locked: false })
  clearLocalData.mockClear()
  privacyClearBlocker.mockReturnValue(null)
})
afterEach(cleanup)

it('confirms installation-wide history removal, keeps drafts, and restores focus after cancel', async () => {
  localStorage.setItem('hermes.drafts.v1:keep', 'unfinished')
  render(<PrivacySettings controller={controller} onBack={vi.fn()} />)
  const toggle = screen.getByRole('switch', { name: 'Save conversation history on this device' })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(toggle)
  expect(screen.getByText(/ALL accounts on this browser/)).toBeTruthy()
  fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
  await waitFor(() => expect(document.activeElement).toBe(toggle))
  expect(localPrivacy.historyAllowed()).toBe(true)
  fireEvent.click(toggle)
  fireEvent.click(screen.getByRole('button', { name: 'Turn off and remove saved history' }))
  expect(localPrivacy.historyAllowed()).toBe(false)
  expect(localStorage.getItem('hermes.drafts.v1:keep')).toBe('unfinished')
  expect(screen.getByRole('status').textContent).toContain('Privacy change completed')
  fireEvent.click(toggle)
  expect(localPrivacy.historyAllowed()).toBe(true)
})

it('confirms account cleanup and does nothing on Cancel', () => {
  render(<PrivacySettings controller={controller} onBack={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Clear local data' }))
  const dialog = screen.getByRole('alertdialog')
  expect(dialog.textContent).toContain('ALL profiles on https://gateway.test')
  expect(dialog.textContent).toContain('unfinished drafts')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(clearLocalData).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Clear local data' }))
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear local data' }))
  expect(clearLocalData).toHaveBeenCalledWith(draftOwnerKey($draftOwner.get()))
})

it('blocks active work and prevents confirmation after switching accounts', () => {
  const view = render(<PrivacySettings controller={controller} onBack={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Clear local data' }))
  $draftOwner.set({ ...$draftOwner.get(), principal: 'other', generation: $draftOwner.get().generation + 1 })
  view.rerender(<PrivacySettings controller={controller} onBack={vi.fn()} />)
  const confirm = within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear local data' }) as HTMLButtonElement
  expect(confirm.disabled).toBe(true)
  fireEvent.click(confirm)
  expect(clearLocalData).not.toHaveBeenCalled()
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
  privacyClearBlocker.mockReturnValue('Finish active work first.')
  view.rerender(<PrivacySettings controller={controller} onBack={vi.fn()} />)
  expect((screen.getByRole('button', { name: 'Clear local data' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByRole('status').textContent).toContain('Finish active work')
})

it('labels principal-less cleanup as memory-only and explains the group-store limitation', () => {
  $draftOwner.set({ ...$draftOwner.get(), principal: null, generation: $draftOwner.get().generation + 1 })
  render(<PrivacySettings controller={controller} onBack={vi.fn()} />)
  expect(screen.getByRole('button', { name: 'Clear current connection memory' })).toBeTruthy()
  expect(screen.getByText(/Group-room logs use separate shared local storage/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Clear current connection memory' }))
  expect(screen.getByRole('alertdialog').textContent).toContain('No persistent account data')
})

it('offers history-removal retry without re-enabling saving after a storage failure', () => {
  const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('Denied') })
  localStorage.setItem('hermes.transcript.v2:failed', 'history')
  localPrivacy.setHistorySaving(false)
  render(<PrivacySettings controller={controller} onBack={vi.fn()} />)
  expect(screen.getByRole('alert').textContent).toContain('could not be removed')
  remove.mockRestore()
  fireEvent.click(screen.getByRole('button', { name: 'Retry history removal' }))
  expect(localPrivacy.historyAllowed()).toBe(false)
  expect(localStorage.getItem('hermes.transcript.v2:failed')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('reports partial failure rather than success', () => {
  clearLocalData.mockReturnValueOnce({ complete: false, failures: ['Draft removal failed.'] })
  render(<PrivacySettings controller={controller} onBack={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Clear local data' }))
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear local data' }))
  expect(screen.getByRole('alert').textContent).toContain('Draft removal failed.')
  expect(screen.queryByText(/Privacy change completed/)).toBeNull()
})
