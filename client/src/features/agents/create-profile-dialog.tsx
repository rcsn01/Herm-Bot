import { useEffect, useRef, useState, type FormEvent } from 'react'

import { Button, Input } from '~/compat/primitives'

import { ProfileAvatarPicker } from './profile-avatar-picker'
import { ProfileAdvancedFields } from './profile-advanced-fields'
import {
  emptyAdvancedProfileState,
  PROFILE_NAME_MAX_LENGTH,
  suggestDuplicateProfileName,
  validateProfileName,
  type CreateProfileCommand,
  type ProfileAdvancedState,
  type ProfileCreateSeed
} from './profile-workflow'
import { useProfileWorkflow } from './use-profile-workflow'

const FRESH_PROFILE = '__fresh__'

interface CreateProfileDialogProps {
  onCancel(): void
  onCreated?(name: string, warning?: string): void
  open: boolean
  seed?: ProfileCreateSeed | null
}

export { PROFILE_NAME_MAX_LENGTH, validateProfileName } from './profile-workflow'

export function CreateProfileDialog({ onCancel, onCreated, open, seed = null }: CreateProfileDialogProps) {
  const mode = seed ? 'duplicate' as const : 'create' as const
  const initialCloneFrom = seed?.cloneFrom ?? ''
  const initialName = seed?.name ?? ''
  const [name, setName] = useState(initialName)
  const [title, setTitle] = useState(seed?.title ?? '')
  const [description, setDescription] = useState(seed?.description ?? '')
  const [descriptionTouched, setDescriptionTouched] = useState(Boolean(seed))
  const [shape, setShape] = useState(seed?.shape ?? 'blobatar')
  const [color, setColor] = useState<null | string>(seed?.color ?? null)
  const [image, setImage] = useState<null | string>(seed?.image ?? null)
  const [appearanceTouched, setAppearanceTouched] = useState(Boolean(seed?.title || seed?.image || seed?.color || seed?.shape && seed.shape !== 'blobatar'))
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(seed))
  const [cloneFrom, setCloneFrom] = useState(initialCloneFrom)
  const [cloneAll, setCloneAll] = useState(seed?.cloneAll ?? false)
  const [noSkills, setNoSkills] = useState(false)
  const [shareAuth, setShareAuth] = useState(true)
  const [shareAuthTouched, setShareAuthTouched] = useState(false)
  const [mirrorCredentials, setMirrorCredentials] = useState(true)
  const [mirrorCredentialsTouched, setMirrorCredentialsTouched] = useState(false)
  const [advancedTouched, setAdvancedTouched] = useState(Boolean(seed?.cloneFrom || seed?.cloneAll))
  const [advancedState, setAdvancedState] = useState<ProfileAdvancedState>(emptyAdvancedProfileState)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const nameEditedRef = useRef(false)
  const hydratedSourceRef = useRef<string | null>(null)
  const advancedEditedRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const advancedSource = cloneFrom || 'default'
  const profile = useProfileWorkflow({
    advancedOpen,
    advancedSource,
    avatar: null,
    mode,
    onSaved: result => {
      onCreated?.(result.name, result.warning)
      onCancel()
    },
    open
  })
  const busy = profile.mutation.busy
  const error = submitError || profile.mutation.error
  const dialogTitleId = 'create-profile-dialog-title'
  const nameHintId = 'create-profile-name-hint'
  const nameErrorId = 'create-profile-name-error'

  useEffect(() => {
    if (!open) return
    nameEditedRef.current = false
    hydratedSourceRef.current = null
    advancedEditedRef.current = false
    setName(initialName)
    setTitle(seed?.title ?? '')
    setDescription(seed?.description ?? '')
    setDescriptionTouched(Boolean(seed))
    setShape(seed?.shape ?? 'blobatar')
    setColor(seed?.color ?? null)
    setImage(seed?.image ?? null)
    setAppearanceTouched(Boolean(seed?.title || seed?.image || seed?.color || seed?.shape && seed.shape !== 'blobatar'))
    setAdvancedOpen(Boolean(seed))
    setCloneFrom(initialCloneFrom)
    setCloneAll(seed?.cloneAll ?? false)
    setNoSkills(false)
    setShareAuth(true)
    setShareAuthTouched(false)
    setMirrorCredentials(true)
    setMirrorCredentialsTouched(false)
    setAdvancedTouched(Boolean(seed?.cloneFrom || seed?.cloneAll))
    setAdvancedState(emptyAdvancedProfileState())
    setSubmitError(null)
    inputRef.current?.focus()
  }, [initialCloneFrom, initialName, open, seed?.cloneAll, seed?.color, seed?.description, seed?.image, seed?.shape, seed?.title])

  useEffect(() => {
    hydratedSourceRef.current = null
    advancedEditedRef.current = false
    setAdvancedState(emptyAdvancedProfileState())
  }, [advancedSource])

  useEffect(() => {
    const loaded = profile.advanced.data
    if (!loaded || advancedEditedRef.current || hydratedSourceRef.current === loaded.source) return
    hydratedSourceRef.current = loaded.source
    setAdvancedState(loaded)
  }, [profile.advanced.data])

  useEffect(() => {
    if (!open || !seed || !profile.roster.data || nameEditedRef.current) return
    setName(suggestDuplicateProfileName(seed.cloneFrom, profile.roster.data.entries.map(entry => entry.name)))
  }, [open, profile.roster.data, seed])

  if (!open) return null

  const validationError = name.length > 0 ? validateProfileName(name) : null
  const cloneProfiles = (profile.roster.data?.entries ?? []).filter(entry => entry.name !== name.trim())
  const changeAdvanced = (update: (previous: ProfileAdvancedState) => ProfileAdvancedState) => {
    advancedEditedRef.current = true
    setAdvancedTouched(true)
    setAdvancedState(update)
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextError = validateProfileName(name)
    if (nextError) {
      setSubmitError(nextError)
      return
    }
    setSubmitError(null)
    const command: CreateProfileCommand = {
      advanced: advancedState,
      advancedTouched,
      appearance: { color, shape, title, touched: appearanceTouched },
      cloneAll,
      cloneFrom,
      description,
      descriptionTouched,
      image,
      mirrorCredentials,
      mirrorCredentialsTouched,
      mode,
      name: name.trim(),
      noSkills,
      shareAuth,
      shareAuthTouched
    }
    profile.mutation.submit(command)
  }

  return (
    <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onCancel() }} role="presentation">
      <form
        aria-busy={busy}
        aria-describedby={`${nameHintId}${validationError || error ? ` ${nameErrorId}` : ''}`}
        aria-labelledby={dialogTitleId}
        aria-modal="true"
        className="mobile-dialog profile-create-dialog profile-editor-dialog"
        onKeyDown={event => { if (event.key === 'Escape' && !busy) onCancel() }}
        onSubmit={submit}
        role="dialog"
      >
        <h3 id={dialogTitleId}>{mode === 'duplicate' ? 'Duplicate profile' : 'Create profile'}</h3>
        <p className="dialog-help">{mode === 'duplicate' ? `Create a copy of ${seed?.cloneFrom}.` : 'Create a fresh Hermes profile. It will not switch the active bot.'}</p>
        <label htmlFor="create-profile-name">Profile name</label>
        <Input
          aria-describedby={`${nameHintId}${validationError || error ? ` ${nameErrorId}` : ''}`}
          aria-invalid={Boolean(validationError || error)}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          id="create-profile-name"
          maxLength={PROFILE_NAME_MAX_LENGTH}
          onChange={event => { nameEditedRef.current = true; setName(event.target.value); setSubmitError(null); profile.mutation.clearError() }}
          ref={inputRef}
          spellCheck={false}
          value={name}
        />
        <p className="dialog-help" id={nameHintId}>Use lowercase letters, numbers, hyphens, and underscores.</p>

        <label htmlFor="create-profile-title">Title</label>
        <Input id="create-profile-title" onChange={event => { setAppearanceTouched(true); setTitle(event.target.value) }} placeholder="Optional display title" value={title} />
        <label htmlFor="create-profile-description">Description</label>
        <textarea id="create-profile-description" onChange={event => { setDescriptionTouched(true); setDescription(event.target.value) }} placeholder="Optional profile description" value={description} />

        <ProfileAvatarPicker
          color={color}
          image={image}
          name={name}
          onColor={next => { setAppearanceTouched(true); setColor(next) }}
          onGenerate={profile.generateAvatar}
          onImage={next => { setAppearanceTouched(true); setImage(next) }}
          onShape={next => { setAppearanceTouched(true); setShape(next) }}
          shape={shape}
          title={title}
        />

        <button className="profile-advanced-toggle" onClick={() => { setAdvancedOpen(value => !value); setAdvancedTouched(true) }} type="button" aria-expanded={advancedOpen}>
          <span>Advanced profile settings</span><span aria-hidden>{advancedOpen ? '−' : '+'}</span>
        </button>
        {advancedOpen && (
          <div className="profile-create-advanced">
            <label htmlFor="create-profile-clone">Clone configuration from</label>
            <select id="create-profile-clone" onChange={event => { setCloneFrom(event.target.value === FRESH_PROFILE ? '' : event.target.value); setAdvancedTouched(true) }} value={cloneFrom || FRESH_PROFILE}>
              <option value={FRESH_PROFILE}>Start with gateway defaults</option>
              {cloneProfiles.map(entry => <option key={entry.name} value={entry.name}>{entry.name}{entry.isDefault ? ' (default)' : ''}</option>)}
            </select>
            {profile.roster.loading && <p className="dialog-help" role="status">Loading profiles…</p>}
            {profile.roster.error && <p className="dialog-help">Existing profiles could not be loaded; enter the source name only if you know it.</p>}
            <label className="dialog-checkbox"><input checked={cloneAll} onChange={event => { setCloneAll(event.target.checked); setAdvancedTouched(true) }} type="checkbox" /><span>Clone all configuration and capabilities</span></label>
            <label className="dialog-checkbox"><input checked={noSkills} onChange={event => { setNoSkills(event.target.checked); setAdvancedTouched(true) }} type="checkbox" /><span>Skip bundled skills</span></label>
            <label className="dialog-checkbox"><input checked={shareAuth} onChange={event => { setShareAuth(event.target.checked); setShareAuthTouched(true); setAdvancedTouched(true) }} type="checkbox" /><span>Share keys and accounts with the launch profile</span></label>
            <label className="dialog-checkbox"><input checked={mirrorCredentials} onChange={event => { setMirrorCredentials(event.target.checked); setMirrorCredentialsTouched(true); setAdvancedTouched(true) }} type="checkbox" /><span>Mirror launch-profile credentials</span></label>
            <ProfileAdvancedFields
              disabledSkills={noSkills}
              error={profile.advanced.error}
              loading={profile.advanced.loading}
              modelOptions={profile.modelOptions.data}
              modelOptionsError={profile.modelOptions.error}
              onChange={changeAdvanced}
              state={advancedState}
            />
          </div>
        )}

        {(validationError || error) && <p className="dialog-field-error" id={nameErrorId} role="alert">{error || validationError}</p>}
        <div className="button-row">
          <Button disabled={busy} onClick={onCancel} type="button" variant="secondary">Cancel</Button>
          <Button disabled={busy || Boolean(validateProfileName(name))} type="submit">{busy ? (mode === 'duplicate' ? 'Duplicating…' : 'Creating…') : (mode === 'duplicate' ? 'Duplicate profile' : 'Create profile')}</Button>
        </div>
      </form>
    </div>
  )
}
