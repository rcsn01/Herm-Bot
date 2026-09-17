import { useEffect, useRef, useState, type FormEvent } from 'react'

import { Button, Input } from '~/compat/primitives'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'

import type { AgentRosterEntry } from './agents-api'
import { ProfileAvatarPicker } from './profile-avatar-picker'
import { ProfileAdvancedFields } from './profile-advanced-fields'
import {
  emptyAdvancedProfileState,
  type EditProfileCommand,
  type ProfileAdvancedState,
  type ProfileAvatarBaseline
} from './profile-workflow'
import { useProfileWorkflow } from './use-profile-workflow'

interface EditProfileDialogProps {
  bot: AgentRosterEntry | null
  onCancel(): void
  onSaved?(name: string): void
  open: boolean
}

export function EditProfileDialog({ bot, onCancel, onSaved, open }: EditProfileDialogProps) {
  const inlineImage = bot?.meta?.image ?? bot?.avatar ?? null
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [descriptionTouched, setDescriptionTouched] = useState(false)
  const [shape, setShape] = useState('blobatar')
  const [color, setColor] = useState<null | string>(null)
  const [image, setImage] = useState<null | string>(null)
  const [avatarBaseline, setAvatarBaseline] = useState<ProfileAvatarBaseline | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [advancedState, setAdvancedState] = useState<ProfileAdvancedState>(emptyAdvancedProfileState)
  const [appearanceTouched, setAppearanceTouched] = useState(false)
  const imageTouchedRef = useRef(false)
  const advancedEditedRef = useRef(false)
  const hydratedAdvancedRef = useRef<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const profile = useProfileWorkflow({
    advancedOpen,
    advancedSource: bot?.name ?? null,
    avatar: bot ? { hasAsset: Boolean(bot.hasAvatar), inlineImage, name: bot.name } : null,
    mode: 'edit',
    onSaved: result => {
      onSaved?.(result.name)
      onCancel()
    },
    open
  })
  const busy = profile.mutation.busy

  useEffect(() => {
    if (!open || !bot) return
    imageTouchedRef.current = false
    advancedEditedRef.current = false
    hydratedAdvancedRef.current = null
    setTitle(bot.meta?.title ?? '')
    setDescription(bot.description ?? '')
    setDescriptionTouched(false)
    setShape(bot.meta?.shape ?? 'blobatar')
    setColor(bot.meta?.color ?? null)
    setImage(inlineImage)
    setAvatarBaseline(inlineImage ? { image: inlineImage, status: 'known' } : bot.hasAvatar ? null : { image: null, status: 'known' })
    setAdvancedOpen(false)
    setAdvancedState(emptyAdvancedProfileState())
    setAppearanceTouched(false)
    titleRef.current?.focus()
  }, [bot?.description, bot?.hasAvatar, bot?.meta?.color, bot?.meta?.shape, bot?.meta?.title, bot?.name, inlineImage, open])

  const workflowBaseline = profile.avatar.baseline
  const workflowBaselineImage = workflowBaseline?.status === 'known' ? workflowBaseline.image : null
  useEffect(() => {
    if (!workflowBaseline) return
    setAvatarBaseline(workflowBaseline)
    if (!imageTouchedRef.current && workflowBaseline.status === 'known') setImage(workflowBaseline.image)
  }, [workflowBaseline?.status, workflowBaselineImage])

  useEffect(() => {
    const loaded = profile.advanced.data
    if (!loaded || advancedEditedRef.current || hydratedAdvancedRef.current === loaded.source) return
    hydratedAdvancedRef.current = loaded.source
    setAdvancedState(loaded)
  }, [profile.advanced.data])

  if (!open || !bot) return null

  const changeAdvanced = (update: (previous: ProfileAdvancedState) => ProfileAdvancedState) => {
    advancedEditedRef.current = true
    setAdvancedState(update)
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || profile.avatar.loading || !avatarBaseline) return
    const command: EditProfileCommand = {
      advanced: advancedState,
      appearance: { color, created: bot.meta?.created, shape, title, touched: appearanceTouched },
      avatar: { baseline: avatarBaseline, current: image },
      description,
      descriptionTouched,
      mode: 'edit',
      name: bot.name
    }
    profile.mutation.submit(command)
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
          onGenerate={profile.generateAvatar}
          onImage={next => { imageTouchedRef.current = true; setAppearanceTouched(true); setImage(next) }}
          onShape={next => { setAppearanceTouched(true); setShape(next) }}
          shape={shape}
          title={title}
        />

        <button className="profile-advanced-toggle" onClick={() => setAdvancedOpen(value => !value)} type="button" aria-expanded={advancedOpen}>
          <span>Advanced profile settings</span><span aria-hidden>{advancedOpen ? '−' : '+'}</span>
        </button>
        {advancedOpen && <ProfileAdvancedFields
          error={profile.advanced.error}
          loading={profile.advanced.loading}
          modelOptions={profile.modelOptions.data}
          modelOptionsError={profile.modelOptions.error}
          onChange={changeAdvanced}
          state={advancedState}
        />}
        {profile.mutation.error && <p className="dialog-field-error" role="alert">{profile.mutation.error}</p>}
        <div className="button-row">
          <Button disabled={busy} onClick={onCancel} type="button" variant="secondary">Cancel</Button>
          <Button disabled={busy || profile.avatar.loading || !avatarBaseline} type="submit">{busy ? 'Saving…' : 'Save changes'}</Button>
        </div>
      </form>
      {profile.mutation.confirmation && <ConfirmDialog
        confirmLabel="Apply model"
        description={profile.mutation.confirmation}
        onCancel={profile.mutation.declineConfirmation}
        onConfirm={profile.mutation.confirm}
        title="Confirm model change"
      />}
    </div>
  )
}
