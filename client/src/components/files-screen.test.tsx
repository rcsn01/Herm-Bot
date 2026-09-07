import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FilesScreen } from './files-screen'
import { GatewayProvider } from '~/gateway/gateway-context'
import { $preferences } from '~/state/store'
import { MemoryGateway } from '~/test/memory-gateway'

vi.mock('~/compat/primitives', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({ children, ...props }: ComponentProps<'button'> & { size?: string; variant?: string }) => <button {...props}>{children}</button>,
  Input: (props: ComponentProps<'input'>) => <input {...props} />,
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children, ...props }: ComponentProps<'button'> & { value?: string }) => <button {...props}>{children}</button>
}))

vi.mock('~/components/ui/confirm-dialog', () => ({
  ConfirmDialog: ({ confirmLabel, onCancel, onConfirm, title }: { confirmLabel: string; onCancel(): void; onConfirm(): void; title: string }) => (
    <div role="dialog"><h2>{title}</h2><button onClick={onConfirm}>{confirmLabel}</button><button onClick={onCancel}>Cancel</button></div>
  )
}))

vi.mock('~/components/ui/text-dialog', () => ({
  TextDialog: ({ onCancel, onSubmit, title }: { onCancel(): void; onSubmit(value: string): void; title: string }) => (
    <div role="dialog"><h2>{title}</h2><button onClick={() => onSubmit('new-folder')}>Create</button><button onClick={onCancel}>Cancel</button></div>
  )
}))

const originalPreferences = $preferences.get()

function listPath(path: string, profile = 'default') {
  return `/api/files?path=${encodeURIComponent(path)}&profile=${profile}`
}

function readPath(path: string, profile = 'default') {
  return `/api/files/read?path=${encodeURIComponent(path)}&profile=${profile}`
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

let gateway: MemoryGateway

beforeEach(() => {
  gateway = new MemoryGateway().handle('/api/fs/default-cwd?profile=default', () => ({ cwd: '.' }))
  $preferences.set({ ...originalPreferences, profile: null, remoteURL: 'https://gateway.example' })
})

afterEach(() => {
  cleanup()
  $preferences.set(originalPreferences)
})

function renderFilesScreen() {
  return render(
    <GatewayProvider gateway={gateway}>
      <FilesScreen />
    </GatewayProvider>
  )
}

describe('FilesScreen', () => {
  it('loads, uploads, and removes a project file through the gateway', async () => {
    const file = { name: 'hello.txt', path: 'hello.txt', size: 12 }
    gateway
      .handle(listPath('.'), () => ({ entries: [file], path: '.' }))
      .handle(readPath('hello.txt'), () => ({ content: 'hello content' }))
      .handle('/api/files/upload?profile=default', () => ({ ok: true }))
      .handle('/api/files?profile=default', value => {
        expect((value as { method?: string }).method).toBe('DELETE')
        return { ok: true }
      })

    const { container } = renderFilesScreen()
    expect(await screen.findByText('hello.txt')).not.toBeNull()

    fireEvent.click(screen.getAllByRole('button', { name: /hello\.txt/ })[0])
    expect(await screen.findByText('hello content')).not.toBeNull()

    const input = container.querySelector('input[type="file"]')
    expect(input).not.toBeNull()
    fireEvent.change(input!, { target: { files: [new File(['upload'], 'upload.txt', { type: 'text/plain' })] } })
    await waitFor(() => expect(gateway.calls.some(call => (call.value as { path?: string }).path === '/api/files/upload?profile=default')).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: 'Delete hello.txt' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(gateway.calls.some(call => call.kind === 'request' && (call.value as { method?: string }).method === 'DELETE')).toBe(true))
  })

  it('discards a file response after the gateway scope changes', async () => {
    const pendingRead = deferred<{ content: string }>()
    gateway
      .handle(listPath('.'), () => ({ entries: [{ name: 'stale.txt', path: 'stale.txt' }], path: '.' }))
      .handle(readPath('stale.txt'), () => pendingRead.promise)
      .handle(listPath('.', 'other'), () => ({ entries: [], path: '.' }))

    renderFilesScreen()
    await screen.findByText('stale.txt')
    fireEvent.click(screen.getAllByRole('button', { name: /stale\.txt/ })[0])

    $preferences.set({ ...$preferences.get(), remoteURL: 'https://other-gateway.example' })
    pendingRead.resolve({ content: 'stale response' })

    await waitFor(() => expect(screen.queryByText('stale response')).toBeNull())
  })

  it('keeps the newest directory listing when navigation requests overlap', async () => {
    const first = deferred<{ entries: Array<{ name: string; path: string }>; path: string }>()
    const second = deferred<{ entries: Array<{ name: string; path: string }>; path: string }>()
    gateway
      .handle(listPath('.'), () => ({ entries: [], path: '.' }))
      .handle(listPath('first'), () => first.promise)
      .handle(listPath('second'), () => second.promise)

    const { container } = renderFilesScreen()
    await screen.findByText('This folder is empty.')
    const pathInput = container.querySelector('.path-bar input') as HTMLInputElement
    const form = pathInput.closest('form')!
    fireEvent.change(pathInput, { target: { value: 'first' } })
    fireEvent.submit(form)
    fireEvent.change(pathInput, { target: { value: 'second' } })
    fireEvent.submit(form)

    second.resolve({ entries: [{ name: 'second.txt', path: 'second.txt' }], path: 'second' })
    await screen.findByText('second.txt')
    first.resolve({ entries: [{ name: 'first.txt', path: 'first.txt' }], path: 'first' })

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(screen.queryByText('first.txt')).toBeNull()
    expect(screen.getByText('second.txt')).not.toBeNull()
  })

  it('blocks an oversized upload with the cap message before any upload request', async () => {
    gateway.handle(listPath('.'), () => ({ entries: [], path: '.' }))

    const { container } = renderFilesScreen()
    await screen.findByText('This folder is empty.')

    const file = new File(['tiny'], 'big.bin', { type: 'application/octet-stream' })
    Object.defineProperty(file, 'size', { value: 50 * 1_024 * 1_024 + 1 })
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } })

    await screen.findByText('Project uploads are limited to 50 MB in this version of Hermes Mobile.')
    expect(gateway.calls.some(call => call.kind === 'request' && (call.value as { path?: string }).path === '/api/files/upload?profile=default')).toBe(false)
  })
})
