import type { GatewayApi } from '~/gateway/gateway-api'
import type { NativeDownloadOptions } from '~/native/hermes-connection'

export interface FileEntry {
  is_dir?: boolean
  is_directory?: boolean
  name: string
  path: string
  size?: number
  type?: string
}

export interface FileListing {
  entries: FileEntry[]
  parent: string | null
  path: string
}

export interface FileContent {
  content?: string
  data_url?: string
}

const MAX_UPLOAD_BYTES = 50 * 1_024 * 1_024
const MAX_DOWNLOAD_BYTES = 100 * 1_024 * 1_024
const ARTIFACTS_PATH = '.hermes/artifacts'

/**
 * Route vocabulary for remote-file work over the profile-bound Gateway API:
 * `/api/files*`, `/api/git/*`, and `/api/fs`. Owns the upload policy (JSON
 * `data_url` body, 50 MB cap, destination path joining) and profile-bound
 * download/share options; `list` normalizes the legacy `entries|files` body
 * shapes. Delegation only: no Scope capture, no classification, no retries —
 * staleness and classification stay with the GatewaySession, and view
 * generations, confirm dialogs, and rendering stay with the Projects screen.
 */
export interface FilesApi {
  /** GET /api/files?path=<enc> — normalizes the legacy entries|files body shapes. */
  list(path: string): Promise<FileListing>
  /** GET /api/files/read?path=<enc> — raw body; the screen decodes data_url for display. */
  read(path: string): Promise<FileContent>
  /** POST /api/files/upload — JSON data_url body, overwrite:false, destination joinPath(parent, file.name); 50 MB cap throws before any I/O. */
  upload(parentPath: string, file: File): Promise<void>
  /** POST /api/files/mkdir — { path: joinPath(parentPath, name) }. */
  createFolder(parentPath: string, name: string): Promise<void>
  /** DELETE /api/files — { path, recursive }. */
  remove(target: string, recursive: boolean): Promise<void>
  /** Pure: profile-bound NativeDownloadOptions for one target (filename from last segment, 100 MB cap). No I/O. */
  shareOptions(target: string): NativeDownloadOptions
  /** GET /api/fs/default-cwd — raw body. */
  defaultCwd(): Promise<{ cwd?: string }>
  /** Git review routes: GETs carry ?path=<enc>; POSTs carry { path: cwd } bodies; commit carries { message, path, push: false }. Raw bodies. */
  gitStatus(cwd: string): Promise<unknown>
  gitReviewList(cwd: string): Promise<unknown>
  gitBranches(cwd: string): Promise<unknown>
  gitStageAll(cwd: string): Promise<unknown>
  gitUnstageAll(cwd: string): Promise<unknown>
  gitPush(cwd: string): Promise<unknown>
  gitCreatePr(cwd: string): Promise<unknown>
  gitCommit(cwd: string, message: string): Promise<unknown>
  /** GET /api/files?path=.hermes/artifacts — raw body (diagnostic view stays byte-identical). */
  listArtifacts(): Promise<unknown>
}

export function createFilesApi(api: GatewayApi): FilesApi {
  const gitRead = (route: string, cwd: string) =>
    api.request<unknown>(`/api/git/${route}?path=${encodeURIComponent(cwd)}`)
  const gitWrite = (route: string, cwd: string) =>
    api.request<unknown>(`/api/git/${route}`, { body: { path: cwd }, method: 'POST' })

  return {
    async list(path: string): Promise<FileListing> {
      const body = await api.request<{ entries?: FileEntry[]; files?: FileEntry[]; parent?: null | string; path?: string }>(`/api/files?path=${encodeURIComponent(path)}`)
      return {
        entries: body.entries ?? body.files ?? [],
        parent: body.parent ?? null,
        path: body.path ?? path
      }
    },
    read: path => api.request<FileContent>(`/api/files/read?path=${encodeURIComponent(path)}`),
    async upload(parentPath: string, file: File): Promise<void> {
      // Gate BEFORE any I/O, including the FileReader pass; the message is the
      // screen's established banner text and must stay byte-identical.
      if (file.size > MAX_UPLOAD_BYTES) throw new Error('Project uploads are limited to 50 MB in this version of Hermes Mobile.')
      const dataURL = await fileToDataURL(file)
      await api.request('/api/files/upload', {
        body: { data_url: dataURL, overwrite: false, path: joinPath(parentPath, file.name) },
        method: 'POST'
      })
    },
    createFolder: (parentPath, name) =>
      api.request('/api/files/mkdir', { body: { path: joinPath(parentPath, name) }, method: 'POST' }).then(() => undefined),
    remove: (target, recursive) =>
      api.request('/api/files', { body: { path: target, recursive }, method: 'DELETE' }).then(() => undefined),
    shareOptions: target => ({
      filename: target.split('/').at(-1),
      maxBytes: MAX_DOWNLOAD_BYTES,
      path: `/api/files/download?path=${encodeURIComponent(target)}`,
      profile: api.profileKey
    }),
    defaultCwd: () => api.request<{ cwd?: string }>('/api/fs/default-cwd'),
    gitStatus: cwd => gitRead('status', cwd),
    gitReviewList: cwd => gitRead('review/list', cwd),
    gitBranches: cwd => gitRead('branches', cwd),
    gitStageAll: cwd => gitWrite('review/stage', cwd),
    gitUnstageAll: cwd => gitWrite('review/unstage', cwd),
    gitPush: cwd => gitWrite('review/push', cwd),
    gitCreatePr: cwd => gitWrite('review/create-pr', cwd),
    gitCommit: (cwd, message) =>
      api.request('/api/git/review/commit', { body: { message: message.trim(), path: cwd, push: false }, method: 'POST' }),
    // Wire-frozen: the artifacts path is sent unencoded, exactly as the screen always has.
    listArtifacts: () => api.request<unknown>(`/api/files?path=${ARTIFACTS_PATH}`)
  }
}

const joinPath = (parent: string, name: string) => parent === '.' ? name : `${parent.replace(/\/$/, '')}/${name}`

function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file.'))
    reader.onload = () => resolve(String(reader.result))
    reader.readAsDataURL(file)
  })
}