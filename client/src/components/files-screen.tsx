import { IconChevronRight, IconDownload, IconFile, IconFolder, IconGitBranch, IconRefresh, IconTrash, IconUpload } from '@tabler/icons-react'
import { useEffect, useState } from 'react'

import { Badge, Button, Input, Tabs, TabsContent, TabsList, TabsTrigger } from '~/compat/primitives'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { TextDialog } from '~/components/ui/text-dialog'
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
  return (
    <section className="screen page-screen">
      <header className="page-heading"><div><p className="eyebrow">Remote workspace</p><h2>Projects</h2></div><Badge variant="muted">Gateway files</Badge></header>
      <Tabs defaultValue="files">
        <TabsList><TabsTrigger value="files">Files</TabsTrigger><TabsTrigger value="git">Git</TabsTrigger><TabsTrigger value="artifacts">Artifacts</TabsTrigger></TabsList>
        <TabsContent value="files"><FileBrowser /></TabsContent>
        <TabsContent value="git"><GitPanel /></TabsContent>
        <TabsContent value="artifacts"><ArtifactsPanel /></TabsContent>
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

  const load = async (nextPath = path) => {
    setError(null); setContent(null)
    try {
      const response = await scopedRequest<{ entries?: FileEntry[]; files?: FileEntry[]; parent?: string | null; path?: string }>({ path: `/api/files?path=${encodeURIComponent(nextPath)}` })
      const resolvedPath = response.body.path ?? nextPath
      setPath(resolvedPath); setDraftPath(resolvedPath); setParent(response.body.parent ?? null); setEntries(response.body.entries ?? response.body.files ?? [])
    } catch (caught) { setError(errorMessage(caught)) }
  }
  useEffect(() => { void load('.') }, [])

  const open = async (entry: FileEntry) => {
    if (isDirectory(entry)) return load(entry.path)
    try {
      const response = await scopedRequest<{ content?: string; data_url?: string }>({ path: `/api/files/read?path=${encodeURIComponent(entry.path)}` })
      let decoded = response.body.content
      if (decoded === undefined && response.body.data_url) decoded = await fetch(response.body.data_url).then(item => item.text())
      setSelectedPath(entry.path)
      setContent(decoded ?? JSON.stringify(response.body, null, 2) ?? '')
    } catch (caught) { setError(errorMessage(caught)) }
  }

  const upload = async (file: File | undefined) => {
    if (!file) return
    try {
      if (file.size > 50 * 1_024 * 1_024) throw new Error('Project uploads are limited to 50 MB in this version of Hermes Mobile.')
      const destination = joinPath(path, file.name)
      await scopedRequest({
        body: { data_url: await fileToDataURL(file), overwrite: false, path: destination },
        method: 'POST',
        path: '/api/files/upload'
      })
      await load(path)
    } catch (caught) { setError(errorMessage(caught)) }
  }

  const createFolder = async (name: string) => {
    try {
      await scopedRequest({ body: { path: joinPath(path, name) }, method: 'POST', path: '/api/files/mkdir' })
      await load(path)
    } catch (caught) { setError(errorMessage(caught)) }
  }

  const remove = async (target: string, recursive: boolean) => {
    try {
      await scopedRequest({ body: { path: target, recursive }, method: 'DELETE', path: '/api/files' })
      setContent(null); setSelectedPath(null); await load(path)
    } catch (caught) { setError(errorMessage(caught)) }
  }

  return (
    <div className="panel-stack">
      <form className="path-bar" onSubmit={event => { event.preventDefault(); void load(draftPath) }}><Input onChange={event => setDraftPath(event.target.value)} value={draftPath} /><Button size="icon-sm" type="submit"><IconRefresh size={17} /></Button></form>
      <div className="button-row">
        <label className="file-action"><IconUpload size={17} /> Upload<input onChange={event => void upload(event.target.files?.[0])} type="file" /></label>
        <Button onClick={() => setCreatingFolder(true)} variant="secondary">New folder</Button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {content !== null ? <><div className="button-row"><Button onClick={() => { setContent(null); setSelectedPath(null) }} variant="text">‹ Back to {path}</Button>{selectedPath && <><Button onClick={() => void platformActions.downloadAndShare({ filename: selectedPath.split('/').at(-1), maxBytes: 100 * 1_024 * 1_024, path: `/api/files/download?path=${encodeURIComponent(selectedPath)}`, profile: $preferences.get().profile }).catch(caught => setError(errorMessage(caught)))} variant="secondary"><IconDownload size={16} /> Share</Button><Button onClick={() => setRemoveTarget({ path: selectedPath, recursive: false })} variant="destructive"><IconTrash size={16} /> Delete</Button></>}</div><pre className="file-content">{content}</pre></> : (
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

function GitPanel() {
  const [cwd, setCwd] = useState('.')
  const [data, setData] = useState<unknown>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const load = async (suffix = '/api/git/status') => {
    setError(null)
    try { setData((await scopedRequest({ path: `${suffix}?path=${encodeURIComponent(cwd)}` })).body) }
    catch (caught) { setError(errorMessage(caught)) }
  }
  const mutate = async (path: string, body: Record<string, unknown>) => {
    setError(null)
    try { setData((await scopedRequest({ body, method: 'POST', path })).body); await load() }
    catch (caught) { setError(errorMessage(caught)) }
  }
  useEffect(() => {
    void scopedRequest<{ cwd?: string }>({ path: '/api/fs/default-cwd' })
      .then(response => { if (response.body.cwd) setCwd(response.body.cwd) })
      .catch(() => undefined)
  }, [])
  return <div className="panel-stack"><label>Project path<Input onChange={event => setCwd(event.target.value)} value={cwd} /></label><div className="button-row"><Button onClick={() => void load()}>Status</Button><Button onClick={() => void load('/api/git/review/list')} variant="secondary">Review</Button><Button onClick={() => void load('/api/git/branches')} variant="secondary"><IconGitBranch size={16} /> Branches</Button></div><div className="button-row"><Button onClick={() => void mutate('/api/git/review/stage', { path: cwd })} variant="secondary">Stage all</Button><Button onClick={() => void mutate('/api/git/review/unstage', { path: cwd })} variant="secondary">Unstage all</Button><Button onClick={() => void mutate('/api/git/review/push', { path: cwd })} variant="secondary">Push</Button><Button onClick={() => void mutate('/api/git/review/create-pr', { path: cwd })} variant="secondary">Create PR</Button></div><label>Commit message<Input onChange={event => setMessage(event.target.value)} value={message} /></label><Button disabled={!message.trim()} onClick={() => void mutate('/api/git/review/commit', { message: message.trim(), path: cwd, push: false })}>Commit staged changes</Button>{error && <div className="error-banner">{error}</div>}{data !== null && <pre className="file-content">{JSON.stringify(data, null, 2)}</pre>}</div>
}

function ArtifactsPanel() {
  const [data, setData] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)
  return <div className="panel-stack"><p>Browse files produced by remote agent runs without invoking local reveal/open actions.</p><Button onClick={() => void scopedRequest({ path: '/api/files?path=.hermes/artifacts' }).then(response => setData(response.body)).catch(caught => setError(errorMessage(caught)))}>Load artifacts</Button>{error && <div className="unsupported-card">Artifacts are unavailable: {error}</div>}{data !== null && <pre className="file-content">{JSON.stringify(data, null, 2)}</pre>}</div>
}

function scopedRequest<T = unknown>(options: NativeRequestOptions) {
  return HermesConnection.request<T>({ ...options, profile: $preferences.get().profile })
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
