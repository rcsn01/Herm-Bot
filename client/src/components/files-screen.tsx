import { useStore } from '@nanostores/react'
import { IconChevronRight, IconDownload, IconFile, IconFolder, IconGitBranch, IconRefresh, IconTrash, IconUpload } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'

import { Badge, Button, Input, Tabs, TabsContent, TabsList, TabsTrigger } from '~/compat/primitives'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { TextDialog } from '~/components/ui/text-dialog'
import { useScopedTask } from '~/gateway/scope-guard'
import { profileKey } from '~/gateway/profile-path'
import { useApi } from '~/gateway/gateway-api-hooks'
import { PlatformActions } from '~/native/platform-actions'
import { createFilesApi, type FileEntry, type FilesApi } from '~/features/files/api'
import { $preferences } from '~/state/store'

const platformActions = new PlatformActions()

export function FilesScreen() {
  const preferences = useStore($preferences)
  const scopeIdentity = `${preferences.remoteURL}:${profileKey(preferences.profile)}`
  const api = useApi(createFilesApi)
  return (
    <section className="screen page-screen">
      <header className="page-heading"><div><p className="eyebrow">Remote workspace</p><h2>Projects</h2></div><Badge variant="muted">Gateway files</Badge></header>
      <Tabs defaultValue="files">
        <TabsList><TabsTrigger value="files">Files</TabsTrigger><TabsTrigger value="git">Git</TabsTrigger><TabsTrigger value="artifacts">Artifacts</TabsTrigger></TabsList>
        <TabsContent value="files"><FileBrowser api={api} key={`files:${scopeIdentity}`} /></TabsContent>
        <TabsContent value="git"><GitPanel api={api} key={`git:${scopeIdentity}`} /></TabsContent>
        <TabsContent value="artifacts"><ArtifactsPanel api={api} key={`artifacts:${scopeIdentity}`} /></TabsContent>
      </Tabs>
    </section>
  )
}

function FileBrowser({ api }: { api: FilesApi }) {
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
  const action = useScopedTask()

  const load = async (nextPath = path) => {
    const requestGeneration = ++viewGeneration.current
    setError(null); setContent(null)
    await action.run(async task => {
      const listing = await api.list(nextPath)
      if (requestGeneration !== viewGeneration.current || !task.isCurrent()) return
      setPath(listing.path); setDraftPath(listing.path); setParent(listing.parent); setEntries(listing.entries)
    }, {
      // A superseded request (Request epoch) never repaints the error banner.
      onError: error => { if (requestGeneration === viewGeneration.current) setError(error.message) }
    })
  }
  useEffect(() => {
    void load('.')
    return () => { ++viewGeneration.current }
  }, [])

  const open = async (entry: FileEntry) => {
    if (isDirectory(entry)) return load(entry.path)
    const requestGeneration = ++viewGeneration.current
    await action.run(async task => {
      const body = await api.read(entry.path)
      let decoded = body.content
      if (decoded === undefined && body.data_url) decoded = await fetch(body.data_url).then(item => item.text())
      if (requestGeneration !== viewGeneration.current || !task.isCurrent()) return
      setSelectedPath(entry.path)
      setContent(decoded ?? JSON.stringify(body, null, 2) ?? '')
    }, {
      onError: error => { if (requestGeneration === viewGeneration.current) setError(error.message) }
    })
  }

  const upload = async (file: File | undefined) => {
    if (!file) return
    await action.run(async task => {
      await api.upload(path, file)
      if (task.isCurrent()) await load(path)
    }, { onError: error => setError(error.message) })
  }

  const createFolder = async (name: string) => {
    await action.run(async task => {
      await api.createFolder(path, name)
      if (task.isCurrent()) await load(path)
    }, { onError: error => setError(error.message) })
  }

  const remove = async (target: string, recursive: boolean) => {
    await action.run(async task => {
      await api.remove(target, recursive)
      if (!task.isCurrent()) return
      setContent(null); setSelectedPath(null); await load(path)
    }, { onError: error => setError(error.message) })
  }

  const share = async (target: string) => {
    await action.run(() => platformActions.downloadAndShare(api.shareOptions(target)), { onError: error => setError(error.message) })
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
  clearsMessage?: boolean
  perform: () => Promise<unknown>
}

interface ConfirmableGitMutation extends GitMutation {
  description: string
  label: string
}

function GitPanel({ api }: { api: FilesApi }) {
  const [cwd, setCwd] = useState('.')
  const [data, setData] = useState<unknown>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirmMutation, setConfirmMutation] = useState<ConfirmableGitMutation | null>(null)
  const [mutating, setMutating] = useState(false)
  const requestGeneration = useRef(0)
  const action = useScopedTask()
  const load = async (read: (cwd: string) => Promise<unknown> = api.gitStatus) => {
    const generation = ++requestGeneration.current
    setError(null)
    await action.run(async task => {
      const body = await read(cwd)
      if (generation === requestGeneration.current && task.isCurrent()) setData(body)
    }, {
      onError: error => { if (generation === requestGeneration.current) setError(error.message) }
    })
  }
  const mutate = async (mutation: GitMutation) => {
    await action.run(async task => {
      setError(null)
      const body = await mutation.perform()
      if (!task.isCurrent()) return
      setData(body)
      if (mutation.clearsMessage) setMessage('')
      await load()
    }, { onBusy: setMutating, onError: error => setError(error.message) })
  }
  const askForConfirmation = (mutation: ConfirmableGitMutation) => {
    if (!mutating) setConfirmMutation(mutation)
  }
  useEffect(() => {
    void action.run(async task => {
      const body = await api.defaultCwd()
      if (task.isCurrent() && body.cwd) setCwd(body.cwd)
    })
  }, [action])
  return <div className="panel-stack"><label>Project path<Input onChange={event => setCwd(event.target.value)} value={cwd} /></label><div className="button-row"><Button disabled={mutating} onClick={() => void load()}>Status</Button><Button disabled={mutating} onClick={() => void load(api.gitReviewList)} variant="secondary">Review</Button><Button disabled={mutating} onClick={() => void load(api.gitBranches)} variant="secondary"><IconGitBranch size={16} /> Branches</Button></div><div className="button-row"><Button disabled={mutating} onClick={() => void mutate({ perform: () => api.gitStageAll(cwd) })} variant="secondary">Stage all</Button><Button disabled={mutating} onClick={() => void mutate({ perform: () => api.gitUnstageAll(cwd) })} variant="secondary">Unstage all</Button><Button disabled={mutating} onClick={() => void askForConfirmation({ description: 'Push the current project changes to its configured remote?', label: 'Push changes', perform: () => api.gitPush(cwd) })} variant="secondary">Push</Button><Button disabled={mutating} onClick={() => void askForConfirmation({ description: 'Create a pull request from the current project state?', label: 'Create pull request', perform: () => api.gitCreatePr(cwd) })} variant="secondary">Create PR</Button></div><label>Commit message<Input onChange={event => setMessage(event.target.value)} value={message} /></label><Button disabled={mutating || !message.trim()} onClick={() => void askForConfirmation({ clearsMessage: true, description: 'Create a commit from the staged changes in this project?', label: 'Commit staged changes', perform: () => api.gitCommit(cwd, message) })}>Commit staged changes</Button>{error && <div className="error-banner">{error}</div>}{data !== null && <pre className="file-content">{JSON.stringify(data, null, 2)}</pre>}{confirmMutation && <ConfirmDialog confirmLabel={confirmMutation.label} description={confirmMutation.description} onCancel={() => setConfirmMutation(null)} onConfirm={() => { const mutation = confirmMutation; setConfirmMutation(null); void mutate(mutation) }} title="Confirm Git action" />}</div>
}

function ArtifactsPanel({ api }: { api: FilesApi }) {
  const [data, setData] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)
  const requestGeneration = useRef(0)
  const action = useScopedTask()
  const load = async () => {
    const generation = ++requestGeneration.current
    setError(null)
    await action.run(async task => {
      const body = await api.listArtifacts()
      if (generation === requestGeneration.current && task.isCurrent()) setData(body)
    }, {
      onError: error => { if (generation === requestGeneration.current) setError(error.message) }
    })
  }
  return <div className="panel-stack"><p>Browse files produced by remote agent runs without invoking local reveal/open actions.</p><Button onClick={() => void load()}>Load artifacts</Button>{error && <div className="unsupported-card">Artifacts are unavailable: {error}</div>}{data !== null && <pre className="file-content">{JSON.stringify(data, null, 2)}</pre>}</div>
}

const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
const isDirectory = (entry: FileEntry) => Boolean(entry.is_directory ?? entry.is_dir ?? entry.type === 'directory')