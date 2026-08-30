import { useStore } from '@nanostores/react'
import { IconChevronRight, IconDownload, IconFile, IconFolder, IconGitBranch, IconRefresh, IconTrash, IconUpload } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'

import { Badge, Button, Input, Tabs, TabsContent, TabsList, TabsTrigger } from '~/compat/primitives'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { TextDialog } from '~/components/ui/text-dialog'
import { currentGatewayScope, isCurrentGatewayScope } from '~/gateway/scope-guard'
import { profileKey } from '~/gateway/profile-path'
import { HermesConnection, type NativeRequestOptions } from '~/native/hermes-connection'
import { PlatformActions } from '~/native/platform-actions'
import { errorMessage } from '~/state/gateway-controller'
import { $preferences } from '~/state/store'

interface FileEntry {
  is_dir?: boolean
  is_directory?: boolean
  name: string
  path: string
  size?: number
  type?: string
}

const platformActions = new PlatformActions()

export function FilesScreen() {
  const preferences = useStore($preferences)
  const scopeIdentity = `${preferences.remoteURL}:${profileKey(preferences.profile)}`
  return (
    <section className="screen page-screen">
      <header className="page-heading"><div><p className="eyebrow">Remote workspace</p><h2>Projects</h2></div><Badge variant="muted">Gateway files</Badge></header>
      <Tabs defaultValue="files">
        <TabsList><TabsTrigger value="files">Files</TabsTrigger><TabsTrigger value="git">Git</TabsTrigger><TabsTrigger value="artifacts">Artifacts</TabsTrigger></TabsList>
        <TabsContent value="files"><FileBrowser key={`files:${scopeIdentity}`} /></TabsContent>
        <TabsContent value="git"><GitPanel key={`git:${scopeIdentity}`} /></TabsContent>
        <TabsContent value="artifacts"><ArtifactsPanel key={`artifacts:${scopeIdentity}`} /></TabsContent>
      </Tabs>
    </section>
  )
}

function FileBrowser() {
  const [path, setPath] = useState('.')
  const [parent, setParent] = useState<string | null>(null)
  const [draftPath, setDraftPath] = useState('.')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [content, setContent] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<{ path: string; recursive: boolean } | null>(null)
  const viewGeneration = useRef(0)

  const load = async (nextPath = path) => {
    const requestGeneration = ++viewGeneration.current
    const scope = currentGatewayScope()
    setError(null); setContent(null)
    try {
      const response = await scopedRequest<{ entries?: FileEntry[]; files?: FileEntry[]; parent?: string | null; path?: string }>({ path: `/api/files?path=${encodeURIComponent(nextPath)}` })
      if (requestGeneration !== viewGeneration.current || !isCurrentGatewayScope(scope)) return
      const resolvedPath = response.body.path ?? nextPath
      setPath(resolvedPath); setDraftPath(resolvedPath); setParent(response.body.parent ?? null); setEntries(response.body.entries ?? response.body.files ?? [])
    } catch (caught) {
      if (requestGeneration === viewGeneration.current && isCurrentGatewayScope(scope)) setError(errorMessage(caught))
    }
  }
  useEffect(() => {
    void load('.')
    return () => { ++viewGeneration.current }
  }, [])

  const open = async (entry: FileEntry) => {
    if (isDirectory(entry)) return load(entry.path)
    const requestGeneration = ++viewGeneration.current
    const scope = currentGatewayScope()
    try {
      const response = await scopedRequest<{ content?: string; data_url?: string }>({ path: `/api/files/read?path=${encodeURIComponent(entry.path)}` })
      let decoded = response.body.content
      if (decoded === undefined && response.body.data_url) decoded = await fetch(response.body.data_url).then(item => item.text())
      if (requestGeneration !== viewGeneration.current || !isCurrentGatewayScope(scope)) return
      setSelectedPath(entry.path)
      setContent(decoded ?? JSON.stringify(response.body, null, 2) ?? '')
    } catch (caught) {
      if (requestGeneration === viewGeneration.current && isCurrentGatewayScope(scope)) setError(errorMessage(caught))
    }
  }

  const upload = async (file: File | undefined) => {
    if (!file) return
    const scope = currentGatewayScope()
    try {
      if (file.size > 50 * 1_024 * 1_024) throw new Error('Project uploads are limited to 50 MB in this version of Hermes Mobile.')
      const destination = joinPath(path, file.name)
      const dataURL = await fileToDataURL(file)
      if (!isCurrentGatewayScope(scope)) return
      await scopedRequest({
        body: { data_url: dataURL, overwrite: false, path: destination },
        method: 'POST',
        path: '/api/files/upload'
      })
      if (isCurrentGatewayScope(scope)) await load(path)
    } catch (caught) { if (isCurrentGatewayScope(scope)) setError(errorMessage(caught)) }
  }

  const createFolder = async (name: string) => {
    const scope = currentGatewayScope()
    try {
      await scopedRequest({ body: { path: joinPath(path, name) }, method: 'POST', path: '/api/files/mkdir' })
      if (isCurrentGatewayScope(scope)) await load(path)
    } catch (caught) { if (isCurrentGatewayScope(scope)) setError(errorMessage(caught)) }
  }

  const remove = async (target: string, recursive: boolean) => {
    const scope = currentGatewayScope()
    try {
      await scopedRequest({ body: { path: target, recursive }, method: 'DELETE', path: '/api/files' })
      if (!isCurrentGatewayScope(scope)) return
      setContent(null); setSelectedPath(null); await load(path)
    } catch (caught) { if (isCurrentGatewayScope(scope)) setError(errorMessage(caught)) }
  }

  const share = async (target: string) => {
    const scope = currentGatewayScope()
    try {
      await platformActions.downloadAndShare({ filename: target.split('/').at(-1), maxBytes: 100 * 1_024 * 1_024, path: `/api/files/download?path=${encodeURIComponent(target)}`, profile: profileKey($preferences.get().profile) })
    } catch (caught) {
      if (isCurrentGatewayScope(scope)) setError(errorMessage(caught))
    }
  }

  return (
    <div className="panel-stack">
      <form className="path-bar" onSubmit={event => { event.preventDefault(); void load(draftPath) }}><Input onChange={event => setDraftPath(event.target.value)} value={draftPath} /><Button size="icon-sm" type="submit"><IconRefresh size={17} /></Button></form>
      <div className="button-row">
        <label className="file-action"><IconUpload size={17} /> Upload<input onChange={event => void upload(event.target.files?.[0])} type="file" /></label>
        <Button onClick={() => setCreatingFolder(true)} variant="secondary">New folder</Button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {content !== null ? <><div className="button-row"><Button onClick={() => { setContent(null); setSelectedPath(null) }} variant="text">‹ Back to {path}</Button>{selectedPath && <><Button onClick={() => void share(selectedPath)} variant="secondary"><IconDownload size={16} /> Share</Button><Button onClick={() => setRemoveTarget({ path: selectedPath, recursive: false })} variant="destructive"><IconTrash size={16} /> Delete</Button></>}</div><pre className="file-content">{content}</pre></> : (
        <div className="file-list">
          {parent && <button onClick={() => void load(parent)}><IconFolder size={19} /><span>..</span></button>}
          {entries.map(entry => <div className="file-row" key={entry.path}><button onClick={() => void open(entry)}>{isDirectory(entry) ? <IconFolder size={19} /> : <IconFile size={19} />}<span><strong>{entry.name}</strong>{entry.size !== undefined && <small>{formatBytes(entry.size)}</small>}</span><IconChevronRight size={17} /></button><Button aria-label={`Delete ${entry.name}`} onClick={() => setRemoveTarget({ path: entry.path, recursive: isDirectory(entry) })} size="icon-sm" variant="ghost"><IconTrash size={16} /></Button></div>)}
          {entries.length === 0 && <div className="empty-panel">This folder is empty.</div>}
        </div>
      )}
      {creatingFolder && <TextDialog label="Folder name" onCancel={() => setCreatingFolder(false)} onSubmit={name => { setCreatingFolder(false); void createFolder(name) }} title="New folder" />}
      {removeTarget && <ConfirmDialog confirmLabel="Delete" description={`Delete ${removeTarget.path}${removeTarget.recursive ? ' and everything inside it' : ''}?`} onCancel={() => setRemoveTarget(null)} onConfirm={() => { const target = removeTarget; setRemoveTarget(null); void remove(target.path, target.recursive) }} title={removeTarget.recursive ? 'Delete folder' : 'Delete file'} />}
    </div>
  )
}

interface GitMutation {
  body: Record<string, unknown>
  description: string
  label: string
  path: string
}

function GitPanel() {
  const [cwd, setCwd] = useState('.')
  const [data, setData] = useState<unknown>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirmMutation, setConfirmMutation] = useState<GitMutation | null>(null)
  const [mutating, setMutating] = useState(false)
  const requestGeneration = useRef(0)
  const load = async (suffix = '/api/git/status') => {
    const generation = ++requestGeneration.current
    const scope = currentGatewayScope()
    setError(null)
    try {
      const response = await scopedRequest({ path: `${suffix}?path=${encodeURIComponent(cwd)}` })
      if (generation === requestGeneration.current && isCurrentGatewayScope(scope)) setData(response.body)
    } catch (caught) {
      if (generation === requestGeneration.current && isCurrentGatewayScope(scope)) setError(errorMessage(caught))
    }
  }
  const mutate = async (path: string, body: Record<string, unknown>) => {
    const scope = currentGatewayScope()
    setMutating(true)
    setError(null)
    try {
      const response = await scopedRequest({ body, method: 'POST', path })
      if (!isCurrentGatewayScope(scope)) return
      setData(response.body)
      if (path.endsWith('/commit')) setMessage('')
      await load()
    } catch (caught) {
      if (isCurrentGatewayScope(scope)) setError(errorMessage(caught))
    } finally {
      if (isCurrentGatewayScope(scope)) setMutating(false)
    }
  }
  const askForConfirmation = (mutation: GitMutation) => {
    if (!mutating) setConfirmMutation(mutation)
  }
  useEffect(() => {
    const scope = currentGatewayScope()
    void scopedRequest<{ cwd?: string }>({ path: '/api/fs/default-cwd' })
      .then(response => { if (isCurrentGatewayScope(scope) && response.body.cwd) setCwd(response.body.cwd) })
      .catch(() => undefined)
  }, [])
  return <div className="panel-stack"><label>Project path<Input onChange={event => setCwd(event.target.value)} value={cwd} /></label><div className="button-row"><Button disabled={mutating} onClick={() => void load()}>Status</Button><Button disabled={mutating} onClick={() => void load('/api/git/review/list')} variant="secondary">Review</Button><Button disabled={mutating} onClick={() => void load('/api/git/branches')} variant="secondary"><IconGitBranch size={16} /> Branches</Button></div><div className="button-row"><Button disabled={mutating} onClick={() => void mutate('/api/git/review/stage', { path: cwd })} variant="secondary">Stage all</Button><Button disabled={mutating} onClick={() => void mutate('/api/git/review/unstage', { path: cwd })} variant="secondary">Unstage all</Button><Button disabled={mutating} onClick={() => askForConfirmation({ body: { path: cwd }, description: 'Push the current project changes to its configured remote?', label: 'Push changes', path: '/api/git/review/push' })} variant="secondary">Push</Button><Button disabled={mutating} onClick={() => askForConfirmation({ body: { path: cwd }, description: 'Create a pull request from the current project state?', label: 'Create pull request', path: '/api/git/review/create-pr' })} variant="secondary">Create PR</Button></div><label>Commit message<Input onChange={event => setMessage(event.target.value)} value={message} /></label><Button disabled={mutating || !message.trim()} onClick={() => askForConfirmation({ body: { message: message.trim(), path: cwd, push: false }, description: 'Create a commit from the staged changes in this project?', label: 'Commit staged changes', path: '/api/git/review/commit' })}>Commit staged changes</Button>{error && <div className="error-banner">{error}</div>}{data !== null && <pre className="file-content">{JSON.stringify(data, null, 2)}</pre>}{confirmMutation && <ConfirmDialog confirmLabel={confirmMutation.label} description={confirmMutation.description} onCancel={() => setConfirmMutation(null)} onConfirm={() => { const mutation = confirmMutation; setConfirmMutation(null); void mutate(mutation.path, mutation.body) }} title="Confirm Git action" />}</div>
}

function ArtifactsPanel() {
  const [data, setData] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)
  const requestGeneration = useRef(0)
  const load = async () => {
    const generation = ++requestGeneration.current
    const scope = currentGatewayScope()
    setError(null)
    try {
      const response = await scopedRequest({ path: '/api/files?path=.hermes/artifacts' })
      if (generation === requestGeneration.current && isCurrentGatewayScope(scope)) setData(response.body)
    } catch (caught) {
      if (generation === requestGeneration.current && isCurrentGatewayScope(scope)) setError(errorMessage(caught))
    }
  }
  return <div className="panel-stack"><p>Browse files produced by remote agent runs without invoking local reveal/open actions.</p><Button onClick={() => void load()}>Load artifacts</Button>{error && <div className="unsupported-card">Artifacts are unavailable: {error}</div>}{data !== null && <pre className="file-content">{JSON.stringify(data, null, 2)}</pre>}</div>
}

function scopedRequest<T = unknown>(options: NativeRequestOptions) {
  return HermesConnection.request<T>({ ...options, profile: profileKey($preferences.get().profile) })
}

const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
const isDirectory = (entry: FileEntry) => Boolean(entry.is_directory ?? entry.is_dir ?? entry.type === 'directory')
const joinPath = (parent: string, name: string) => parent === '.' ? name : `${parent.replace(/\/$/, '')}/${name}`

function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file.'))
    reader.onload = () => resolve(String(reader.result))
    reader.readAsDataURL(file)
  })
}
