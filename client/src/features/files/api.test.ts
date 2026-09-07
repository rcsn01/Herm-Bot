import { afterEach, describe, expect, it, vi } from 'vitest'

import { createFilesApi } from './api'
import { createGatewayApi } from '~/gateway/gateway-api'
import { MemoryGateway } from '~/test/memory-gateway'

const MB = 1_024 * 1_024

function filesApiFor(gateway: MemoryGateway, profile: null | string = null) {
  return createFilesApi(createGatewayApi(gateway, profile))
}

function stubFileReader(dataURL: string) {
  vi.stubGlobal('FileReader', class {
    error: Error | null = null
    onerror: (() => void) | null = null
    onload: (() => void) | null = null
    result: string | null = null

    readAsDataURL() {
      this.result = dataURL
      queueMicrotask(() => this.onload?.())
    }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('filesApi', () => {
  it('lists a directory with the profile appended to the route and normalizes the legacy body', async () => {
    const gateway = new MemoryGateway().handle('/api/files?path=subdir&profile=default', () => ({
      files: [{ name: 'a.txt', path: 'subdir/a.txt' }],
      parent: 'subdir'
    }))
    const files = filesApiFor(gateway)

    await expect(files.list('subdir')).resolves.toEqual({
      entries: [{ name: 'a.txt', path: 'subdir/a.txt' }],
      parent: 'subdir',
      path: 'subdir'
    })
    expect(gateway.calls).toEqual([
      expect.objectContaining({ kind: 'request', value: expect.objectContaining({ path: '/api/files?path=subdir&profile=default' }) })
    ])
  })

  it('falls back to the requested path and a null parent when the body omits them', async () => {
    const gateway = new MemoryGateway().handle('/api/files?path=docs&profile=client+work%2Fios', () => ({ entries: [] }))
    const files = filesApiFor(gateway, 'client work/ios')

    await expect(files.list('docs')).resolves.toEqual({ entries: [], parent: null, path: 'docs' })
  })

  it('percent-encodes the requested path in the list route', async () => {
    const gateway = new MemoryGateway().handle('/api/files?path=hello%2Fworld&profile=default', () => ({ entries: [] }))
    const files = filesApiFor(gateway)

    await expect(files.list('hello/world')).resolves.toEqual({ entries: [], parent: null, path: 'hello/world' })
    expect(gateway.calls[0].value).toMatchObject({ path: '/api/files?path=hello%2Fworld&profile=default' })
  })

  it('reads content and data_url bodies unmodified', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/files/read?path=notes.txt&profile=default', () => ({ content: 'plain text' }))
      .handle('/api/files/read?path=picture.png&profile=default', () => ({ data_url: 'data:image/png;base64,AA==' }))
    const files = filesApiFor(gateway)

    await expect(files.read('notes.txt')).resolves.toEqual({ content: 'plain text' })
    await expect(files.read('picture.png')).resolves.toEqual({ data_url: 'data:image/png;base64,AA==' })
  })

  it('uploads the JSON data_url body to the joined destination path', async () => {
    stubFileReader('data:text/plain;base64,aGVsbG8=')
    const gateway = new MemoryGateway().handle('/api/files/upload?profile=default', value => value)
    const files = filesApiFor(gateway)
    const makeFile = () => new File(['hello'], 'hello.txt', { type: 'text/plain' })

    await files.upload('.', makeFile())
    await files.upload('docs/', makeFile())
    await files.upload('docs', makeFile())

    expect(gateway.calls.map(call => (call.value as { body: { path: string } }).body.path)).toEqual([
      'hello.txt',
      'docs/hello.txt',
      'docs/hello.txt'
    ])
    expect(gateway.calls[0].value).toMatchObject({
      body: { data_url: 'data:text/plain;base64,aGVsbG8=', overwrite: false, path: 'hello.txt' },
      method: 'POST',
      path: '/api/files/upload?profile=default'
    })
  })

  it('rejects oversized uploads before any wire I/O', async () => {
    const gateway = new MemoryGateway()
    const files = filesApiFor(gateway)
    const file = new File(['tiny'], 'big.bin', { type: 'application/octet-stream' })
    Object.defineProperty(file, 'size', { value: 50 * MB + 1 })

    await expect(files.upload('.', file)).rejects.toThrow('Project uploads are limited to 50 MB in this version of Hermes Mobile.')

    expect(gateway.calls).toEqual([])
  })

  it('creates folders with the joined path', async () => {
    const gateway = new MemoryGateway().handle('/api/files/mkdir?profile=default', value => value)
    const files = filesApiFor(gateway)

    await files.createFolder('.', 'new-folder')

    expect(gateway.calls[0].value).toMatchObject({
      body: { path: 'new-folder' },
      method: 'POST',
      path: '/api/files/mkdir?profile=default'
    })
  })

  it('removes with DELETE and a recursive body', async () => {
    const gateway = new MemoryGateway().handle('/api/files?profile=default', value => value)
    const files = filesApiFor(gateway)

    await files.remove('docs/old', true)

    expect(gateway.calls[0].value).toMatchObject({
      body: { path: 'docs/old', recursive: true },
      method: 'DELETE',
      path: '/api/files?profile=default'
    })
  })

  it('reads the default cwd route', async () => {
    const gateway = new MemoryGateway().handle('/api/fs/default-cwd?profile=default', () => ({ cwd: '/srv/project' }))

    await expect(filesApiFor(gateway).defaultCwd()).resolves.toEqual({ cwd: '/srv/project' })
  })

  it('reads git status, review list, and branches with the encoded path query', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/git/status?path=%2Fsrv%2Fproject&profile=default', () => 'status body')
      .handle('/api/git/review/list?path=%2Fsrv%2Fproject&profile=default', () => 'review body')
      .handle('/api/git/branches?path=%2Fsrv%2Fproject&profile=default', () => 'branches body')
    const files = filesApiFor(gateway)
    const cwd = '/srv/project'

    await expect(files.gitStatus(cwd)).resolves.toBe('status body')
    await expect(files.gitReviewList(cwd)).resolves.toBe('review body')
    await expect(files.gitBranches(cwd)).resolves.toBe('branches body')

    expect(gateway.calls.map(call => (call.value as { path: string }).path)).toEqual([
      '/api/git/status?path=%2Fsrv%2Fproject&profile=default',
      '/api/git/review/list?path=%2Fsrv%2Fproject&profile=default',
      '/api/git/branches?path=%2Fsrv%2Fproject&profile=default'
    ])
  })

  it('stages, unstages, pushes, and creates PRs with { path } POST bodies', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/git/review/stage?profile=default', value => value)
      .handle('/api/git/review/unstage?profile=default', value => value)
      .handle('/api/git/review/push?profile=default', value => value)
      .handle('/api/git/review/create-pr?profile=default', value => value)
    const files = filesApiFor(gateway)
    const cwd = '/srv/project'

    await files.gitStageAll(cwd)
    await files.gitUnstageAll(cwd)
    await files.gitPush(cwd)
    await files.gitCreatePr(cwd)

    expect(gateway.calls.map(call => call.value)).toEqual([
      { body: { path: cwd }, method: 'POST', path: '/api/git/review/stage?profile=default' },
      { body: { path: cwd }, method: 'POST', path: '/api/git/review/unstage?profile=default' },
      { body: { path: cwd }, method: 'POST', path: '/api/git/review/push?profile=default' },
      { body: { path: cwd }, method: 'POST', path: '/api/git/review/create-pr?profile=default' }
    ])
  })

  it('commits with the trimmed message, the cwd, and push:false', async () => {
    const gateway = new MemoryGateway().handle('/api/git/review/commit?profile=default', value => value)
    const files = filesApiFor(gateway)

    await files.gitCommit('/srv/project', '  fix the bug  ')

    expect(gateway.calls[0].value).toMatchObject({
      body: { message: 'fix the bug', path: '/srv/project', push: false },
      method: 'POST',
      path: '/api/git/review/commit?profile=default'
    })
  })

  it('builds profile-bound download options without any wire call', async () => {
    const gateway = new MemoryGateway()
    const named = filesApiFor(gateway, 'client work/ios')
    const defaults = filesApiFor(gateway, null)

    expect(named.shareOptions('docs/report.pdf')).toEqual({
      filename: 'report.pdf',
      maxBytes: 100 * MB,
      path: '/api/files/download?path=docs%2Freport.pdf',
      profile: 'client work/ios'
    })
    expect(defaults.shareOptions('notes.txt')).toEqual({
      filename: 'notes.txt',
      maxBytes: 100 * MB,
      path: '/api/files/download?path=notes.txt',
      profile: 'default'
    })
    expect(gateway.calls).toEqual([])
  })

  it('lists artifacts from the fixed unencoded artifacts path and returns the raw body', async () => {
    const payload = { entries: [{ name: 'run-1.json', path: '.hermes/artifacts/run-1.json' }], path: '.hermes/artifacts' }
    // The route string carries the path unencoded; the Gateway API's final
    // serialization (same as the native bridge's withProfile) encodes the slash.
    const gateway = new MemoryGateway().handle('/api/files?path=.hermes%2Fartifacts&profile=default', () => payload)

    await expect(filesApiFor(gateway).listArtifacts()).resolves.toEqual(payload)
    expect(gateway.calls[0].value).toMatchObject({ path: '/api/files?path=.hermes%2Fartifacts&profile=default' })
  })
})