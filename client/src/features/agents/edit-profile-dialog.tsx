import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type FormEvent } from 'react'

import { Button, Input } from '~/compat/primitives'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { useApi } from '~/gateway/gateway-api-hooks'
import { beginScopedTask, useScopeKey, useScopedTask } from '~/gateway/scope-guard'

import {
  botMetaForProfile,
  createAgentsApi,
  isSuccessfulCliResult,
  isSuccessfulProfileConfiguration,
  type AgentRosterEntry
} from './agents-api'
import { ProfileAvatarPicker } from './profile-avatar-picker'
import {
  advancedStateFromDescribe,
  emptyAdvancedProfileState,
  enabledToolsetNames,
  ProfileAdvancedFields,
  type ProfileAdvancedState
} from './profile-advanced-fields'

interface EditProfileDialogProps {
  bot: AgentRosterEntry | null
  onCancel(): void
  onSaved?(name: string): void
  open: boolean
}

interface SaveResult {
  confirmMessage?: string
}

export function EditProfileDialog({ bot, onCancel, onSaved, open }: EditProfileDialogProps) {
  const agents = useApi(createAgentsApi)
  const queryClient = useQueryClient()
  const rosterKey = useScopeKey('agents', ['roster'], { unscoped: true })
  const task = useScopedTask()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [descriptionTouched, setDescriptionTouched] = useState(false)
  const [shape, setShape] = useState('blobatar')
  const [color, setColor] = useState<null | string>(null)
  const [image, setImage] = useState<null | string>(null)
  const [initialImage, setInitialImage] = useState<null | string>(null)
  const [initialHadAsset, setInitialHadAsset] = useState(false)
  const [assetLoaded, setAssetLoaded] = useState(true)
  const [assetLoadFailed, setAssetLoadFailed] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [advancedLoading, setAdvancedLoading] = useState(false)
  const [advancedError, setAdvancedError] = useState<string | null>(null)
  const [advancedState, setAdvancedState] = useState<ProfileAdvancedState>(emptyAdvancedProfileState)
  const [appearanceTouched, setAppearanceTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingConfirmation, setPendingConfirmation] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open || !bot) return
    const nextImage = bot.meta?.image ?? bot.avatar ?? null
    setTitle(bot.meta?.title ?? '')
    setDescription(bot.description ?? '')
    setDescriptionTouched(false)
    setShape(bot.meta?.shape ?? 'blobatar')
    setColor(bot.meta?.color ?? null)
    setImage(nextImage)
    setInitialImage(nextImage)
    setInitialHadAsset(Boolean(nextImage || bot.hasAvatar))
    setAssetLoaded(Boolean(nextImage || !bot.hasAvatar))
    setAssetLoadFailed(false)
    setAdvancedOpen(false)
    setAdvancedLoading(false)
    setAdvancedError(null)
    setAdvancedState(emptyAdvancedProfileState())
    setAppearanceTouched(false)
    setBusy(false)
    setError(null)
    setPendingConfirmation(null)
    titleRef.current?.focus()
  }, [bot?.avatar, bot?.description, bot?.hasAvatar, bot?.meta?.color, bot?.meta?.image, bot?.meta?.shape, bot?.meta?.title, bot?.name, open])

  useEffect(() => {
    if (!open || !bot || assetLoaded || assetLoadFailed) return
    const scopeTask = beginScopedTask()
    const controller = new AbortController()
    setAssetLoaded(false)
    void agents.getAsset(bot.name, controller.signal).then(result => {
      if (!scopeTask.isCurrent()) return
      if (result.found && result.data) {
        setImage(result.data)
        setInitialImage(result.data)
        setInitialHadAsset(true)
      } else {
        setInitialHadAsset(false)
      }
    }).catch(() => {
      if (scopeTask.isCurrent()) setAssetLoadFailed(true)
    }).finally(() => {
      if (scopeTask.isCurrent()) setAssetLoaded(true)
    })
    return () => controller.abort()
  }, [agents, assetLoadFailed, assetLoaded, bot, open])

  useEffect(() => {
    if (!open || !bot || !advancedOpen) return
    const source = bot.name
    let cancelled = false
    setAdvancedLoading(true)
    setAdvancedError(null)
    setAdvancedState(emptyAdvancedProfileState())
    void Promise.all([
      agents.describe(source),
      agents.mcpCatalog(source).catch(() => null)
    ]).then(([described, catalog]) => {
      if (!cancelled) setAdvancedState(advancedStateFromDescribe(described, catalog, source))
    }).catch(caught => {
      if (!cancelled) setAdvancedError(classifyGatewayError(caught).message)
    }).finally(() => {
      if (!cancelled) setAdvancedLoading(false)
    })
    return () => { cancelled = true }
  }, [advancedOpen, agents, bot, open])

  if (!open || !bot) return null

  const changeAdvanced = (update: (previous: ProfileAdvancedState) => ProfileAdvancedState) => setAdvancedState(update)
  const generateAvatar = async (prompt: string): Promise<null | string> => {
    const result = await agents.generateAvatar(prompt)
    if (result.success === false) throw new Error(result.error || 'The image service rejected the request.')
    return result.image_data || result.image || null
  }

  const save = (confirmModel = false) => {
    if (!bot || busy || !assetLoaded) return
    setError(null)
    void task.run<SaveResult>(async () => {
      const profileName = bot.name
      const configuration: Parameters<typeof agents.configure>[0] = { name: profileName }
      if (descriptionTouched) configuration.description = description.trim()
      if (advancedState.dirtySoul) configuration.soul = advancedState.soul
      if (advancedState.dirtySkills) configuration.disabled_skills = advancedState.skills.filter(item => item.enabled === false).map(item => item.name)
      if (advancedState.dirtyToolsets) configuration.enabled_toolsets = enabledToolsetNames(advancedState.toolsets)
      if (advancedState.dirtyMcp) configuration.enabled_mcp_servers = advancedState.mcp.filter(item => item.enabled !== false).map(item => item.name)

      if (advancedState.dirtyModel) {
        if (advancedState.provider && advancedState.model) {
          configuration.provider = advancedState.provider.trim()
          configuration.model = advancedState.model.trim()
          if (confirmModel) configuration.confirm_expensive_model = true
        } else if (advancedState.provider || advancedState.model) {
          throw new Error('Choose both a model provider and model, or leave both empty to inherit.')
        } else {
          const result = await agents.clearModel(profileName)
          if (!isSuccessfulCliResult(result)) throw new Error(result.hint || 'The inherited model could not be restored.')
        }
      }

      if (Object.keys(configuration).length > 1) {
        const result = await agents.configure(configuration)
        if (result.confirm_required && !confirmModel) return { confirmMessage: result.confirm_message || 'This model may use paid or external resources. Continue?' }
        if (!isSuccessfulProfileConfiguration(result)) throw new Error('The gateway did not save the profile configuration.')
      }

      if (appearanceTouched) {
        const result = await agents.configure({
          name: profileName,
          ui_meta: { 'hermes-bots': botMetaForProfile({ color, created: bot.meta?.created, image, shape, title }) }
        })
        if (!isSuccessfulProfileConfiguration(result)) throw new Error('The profile appearance could not be saved.')
      }

      const hadSavedAsset = Boolean(initialImage || (initialHadAsset && !assetLoadFailed))
      if (image) {
        if (image !== initialImage) {
          const result = await agents.setAsset(profileName, { data: image })
          if (result.ok === false) throw new Error('The avatar image could not be saved.')
        }
      } else if (hadSavedAsset && (appearanceTouched || initialImage !== null)) {
        const result = await agents.setAsset(profileName, { clear: true })
        if (result.ok === false) throw new Error('The avatar image could not be removed.')
      }
      return {}
    }, {
      onBusy: setBusy,
      onError: classified => setError(classified.message),
      onSettled: () => undefined
    }).then(result => {
      if (!result) return
      if (result.confirmMessage) {
        setPendingConfirmation(result.confirmMessage)
        return
      }
      void queryClient.invalidateQueries({ queryKey: rosterKey })
      onSaved?.(bot.name)
      onCancel()
    })
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    save()
  }

  return (
    <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onCancel() }} role="presentation">
      <form
        aria-busy={busy}
        aria-describedby="edit-profile-description-hint"
        aria-labelledby="edit-profile-title"
        aria-modal="true"
        className="mobile-dialog profile-editor-dialog"
        onKeyDown={event => { if (event.key === 'Escape' && !busy) onCancel() }}
        onSubmit={submit}
        role="dialog"
      >
        <h3 id="edit-profile-title">Edit profile</h3>
        <p className="dialog-help" id="edit-profile-description-hint">Changes apply to <strong>{bot.name}</strong>. The active conversation will not switch.</p>
        <label htmlFor="edit-profile-title-input">Title</label>
        <Input id="edit-profile-title-input" onChange={event => { setAppearanceTouched(true); setTitle(event.target.value) }} placeholder="Optional display title" ref={titleRef} value={title} />
        <label htmlFor="edit-profile-description-input">Description</label>
        <textarea id="edit-profile-description-input" onChange={event => { setDescriptionTouched(true); setDescription(event.target.value) }} placeholder="Optional profile description" value={description} />
        <ProfileAvatarPicker
          color={color}
          image={image}
          name={bot.name}
          onColor={next => { setAppearanceTouched(true); setColor(next) }}
          onGenerate={generateAvatar}
          onImage={next => { setAppearanceTouched(true); setImage(next) }}
          onShape={next => { setAppearanceTouched(true); setShape(next) }}
          shape={shape}
          title={title}
        />

        <button className="profile-advanced-toggle" onClick={() => setAdvancedOpen(value => !value)} type="button" aria-expanded={advancedOpen}>
          <span>Advanced profile settings</span><span aria-hidden>{advancedOpen ? '−' : '+'}</span>
        </button>
        {advancedOpen && <ProfileAdvancedFields api={agents} error={advancedError} loading={advancedLoading} onChange={changeAdvanced} state={advancedState} />}
        {error && <p className="dialog-field-error" role="alert">{error}</p>}
        <div className="button-row">
          <Button disabled={busy} onClick={onCancel} type="button" variant="secondary">Cancel</Button>
          <Button disabled={busy || !assetLoaded} type="submit">{busy ? 'Saving…' : 'Save changes'}</Button>
        </div>
      </form>
      {pendingConfirmation && <ConfirmDialog confirmLabel="Apply model" description={pendingConfirmation} onCancel={() => setPendingConfirmation(null)} onConfirm={() => { setPendingConfirmation(null); save(true) }} title="Confirm model change" />}
    </div>
  )
}
