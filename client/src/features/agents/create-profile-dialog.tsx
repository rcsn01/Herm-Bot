import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type FormEvent } from 'react'

import { Button, Input } from '~/compat/primitives'
import { classifyGatewayError } from '~/gateway/gateway-error'
import { useApi } from '~/gateway/gateway-api-hooks'
import { useScopeKey, useScopedQuery, useScopedTask } from '~/gateway/scope-guard'

import {
  botMetaForProfile,
  createAgentsApi,
  isSuccessfulProfileConfiguration,
  type AgentProfileConfigureInput,
  type AgentProfileCreateInput
} from './agents-api'
import { ProfileAvatarPicker } from './profile-avatar-picker'
import {
  advancedStateFromDescribe,
  emptyAdvancedProfileState,
  enabledToolsetNames,
  ProfileAdvancedFields,
  type ProfileAdvancedState
} from './profile-advanced-fields'

export const PROFILE_NAME_MAX_LENGTH = 63

const PROFILE_NAME_PATTERN = /^[a-z0-9_-]+$/
const RESERVED_PROFILE_NAMES = new Set(['default', 'hermes', 'root', 'sudo', 'test', 'tmp'])
const FRESH_PROFILE = '__fresh__'

export function validateProfileName(value: string): string | null {
  const name = value.trim()
  if (!name) return 'Enter a profile name.'
  if (name.length > PROFILE_NAME_MAX_LENGTH) return `Profile names must be ${PROFILE_NAME_MAX_LENGTH} characters or fewer.`
  if (!PROFILE_NAME_PATTERN.test(name)) return 'Use lowercase letters, numbers, hyphens, and underscores only.'
  if (RESERVED_PROFILE_NAMES.has(name)) return 'That profile name is reserved. Choose another name.'
  return null
}

interface CreateProfileDialogProps {
  initialCloneAll?: boolean
  initialCloneFrom?: string
  initialColor?: null | string
  initialDescription?: string
  initialImage?: null | string
  initialName?: string
  initialShape?: string
  initialTitle?: string
  onCancel(): void
  onCreated?(name: string, warning?: string): void
  open: boolean
}

interface CreateResult {
  warning?: string
}

function describeError(caught: unknown): string {
  return classifyGatewayError(caught).message
}

export function CreateProfileDialog({
  initialCloneAll = false,
  initialCloneFrom = '',
  initialColor = null,
  initialDescription = '',
  initialImage = null,
  initialName = '',
  initialShape = 'blobatar',
  initialTitle = '',
  onCancel,
  onCreated,
  open
}: CreateProfileDialogProps) {
  const agents = useApi(createAgentsApi)
  const queryClient = useQueryClient()
  const rosterKey = useScopeKey('agents', ['roster'], { unscoped: true })
  const [name, setName] = useState(initialName)
  const [title, setTitle] = useState(initialTitle)
  const [description, setDescription] = useState(initialDescription)
  const [descriptionTouched, setDescriptionTouched] = useState(Boolean(initialCloneFrom))
  const [shape, setShape] = useState(initialShape)
  const [color, setColor] = useState<null | string>(initialColor)
  const [image, setImage] = useState<null | string>(initialImage)
  const [appearanceTouched, setAppearanceTouched] = useState(Boolean(initialTitle || initialImage || initialColor || initialShape !== 'blobatar'))
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(initialCloneFrom))
  const [cloneFrom, setCloneFrom] = useState(initialCloneFrom)
  const [cloneAll, setCloneAll] = useState(initialCloneAll)
  const [noSkills, setNoSkills] = useState(false)
  const [shareAuth, setShareAuth] = useState(true)
  const [shareAuthTouched, setShareAuthTouched] = useState(false)
  const [mirrorCredentials, setMirrorCredentials] = useState(true)
  const [mirrorCredentialsTouched, setMirrorCredentialsTouched] = useState(false)
  const [advancedTouched, setAdvancedTouched] = useState(Boolean(initialCloneFrom || initialCloneAll))
  const [advancedLoading, setAdvancedLoading] = useState(false)
  const [advancedError, setAdvancedError] = useState<string | null>(null)
  const [advancedState, setAdvancedState] = useState<ProfileAdvancedState>(emptyAdvancedProfileState)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameEditedRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const task = useScopedTask()
  const profiles = useScopedQuery(rosterKey, {
    enabled: open && advancedOpen,
    queryFn: signal => agents.list(signal),
    retry: false
  })
  const dialogTitleId = 'create-profile-dialog-title'
  const nameHintId = 'create-profile-name-hint'
  const nameErrorId = 'create-profile-name-error'

  useEffect(() => {
    if (!open) return
    nameEditedRef.current = false
    setName(initialName)
    setTitle(initialTitle)
    setDescription(initialDescription)
    setDescriptionTouched(Boolean(initialCloneFrom))
    setShape(initialShape)
    setColor(initialColor)
    setImage(initialImage)
    setAppearanceTouched(Boolean(initialTitle || initialImage || initialColor || initialShape !== 'blobatar'))
    setAdvancedOpen(Boolean(initialCloneFrom))
    setCloneFrom(initialCloneFrom)
    setCloneAll(initialCloneAll)
    setNoSkills(false)
    setShareAuth(true)
    setShareAuthTouched(false)
    setMirrorCredentials(true)
    setMirrorCredentialsTouched(false)
    setAdvancedTouched(Boolean(initialCloneFrom || initialCloneAll))
    setAdvancedLoading(false)
    setAdvancedError(null)
    setAdvancedState(emptyAdvancedProfileState())
    setError(null)
    // The dialog is mounted before the focus effect runs, including when it
    // is opened from the roster header.
    inputRef.current?.focus()
  }, [initialCloneAll, initialCloneFrom, initialColor, initialDescription, initialImage, initialName, initialShape, initialTitle, open])

  useEffect(() => {
    if (!open || !initialCloneFrom || !profiles.data || nameEditedRef.current || name !== initialName) return
    const existing = new Set(profiles.data.entries.map(profile => profile.name))
    if (!existing.has(name)) return
    for (let number = 2; number < 100; number += 1) {
      const suffix = `-${number}`
      const candidate = `${initialCloneFrom.slice(0, Math.max(1, PROFILE_NAME_MAX_LENGTH - suffix.length))}${suffix}`
      if (!existing.has(candidate)) {
        setName(candidate)
        return
      }
    }
  }, [initialCloneFrom, initialName, name, open, profiles.data])

  useEffect(() => {
    if (!open || !advancedOpen) return
    const source = cloneFrom || 'default'
    let cancelled = false
    setAdvancedLoading(true)
    setAdvancedError(null)
    setAdvancedState(emptyAdvancedProfileState())
    void Promise.all([
      agents.describe(source),
      agents.mcpCatalog(source).catch(() => null)
    ]).then(([described, catalog]) => {
      if (cancelled) return
      setAdvancedState(advancedStateFromDescribe(described, catalog, source, false))
    }).catch(caught => {
      if (cancelled) return
      setAdvancedError(describeError(caught))
    }).finally(() => {
      if (!cancelled) setAdvancedLoading(false)
    })
    return () => { cancelled = true }
  }, [advancedOpen, agents, cloneFrom, open])

  if (!open) return null

  const validationError = name.length > 0 ? validateProfileName(name) : null
  const cloneProfiles = (profiles.data?.entries ?? []).filter(profile => profile.name !== name.trim())
  const changeAdvanced = (update: (previous: ProfileAdvancedState) => ProfileAdvancedState) => {
    setAdvancedTouched(true)
    setAdvancedState(update)
  }

  const generateAvatar = async (prompt: string): Promise<null | string> => {
    const result = await agents.generateAvatar(prompt)
    if (result.success === false) throw new Error(result.error || 'The image service rejected the request.')
    return result.image_data || result.image || null
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextError = validateProfileName(name)
    if (nextError) {
      setError(nextError)
      return
    }
    if (advancedState.dirtyModel && Boolean(advancedState.provider) !== Boolean(advancedState.model)) {
      setError('Choose both a model provider and model, or leave both empty to inherit.')
      return
    }
    setError(null)
    void task.run(async () => {
      const profileName = name.trim()
      const payload: AgentProfileCreateInput = { name: profileName }
      if (descriptionTouched || description.trim()) payload.description = description.trim()
      if (advancedTouched) {
        if (cloneFrom) payload.clone_from = cloneFrom
        if (cloneFrom && cloneAll) payload.clone_all = true
        if (noSkills) payload.no_skills = true
        if (shareAuthTouched || (advancedTouched && !initialCloneFrom)) payload.share_auth = shareAuth
        if (mirrorCredentialsTouched) payload.mirror_credentials = mirrorCredentials
        if (advancedState.dirtyModel && advancedState.provider && advancedState.model) {
          payload.provider = advancedState.provider.trim()
          payload.model = advancedState.model.trim()
        }
        if (advancedState.dirtySoul) payload.soul = advancedState.soul
      }
      const created = await agents.create(payload)
      if (created.ok === false) throw new Error('The gateway did not create the profile.')

      const warnings: string[] = []
      const bestEffort = async (label: string, operation: () => Promise<{ applied?: Record<string, unknown>; ok?: boolean }>) => {
        try {
          const result = await operation()
          if (!isSuccessfulProfileConfiguration(result)) warnings.push(label)
        } catch {
          warnings.push(label)
        }
      }
      const advancedConfiguration: AgentProfileConfigureInput = { name: profileName }
      if (advancedState.dirtySkills) advancedConfiguration.disabled_skills = advancedState.skills.filter(item => item.enabled === false).map(item => item.name)
      if (advancedState.dirtyToolsets) advancedConfiguration.enabled_toolsets = enabledToolsetNames(advancedState.toolsets)
      if (advancedState.dirtyMcp) advancedConfiguration.enabled_mcp_servers = advancedState.mcp.filter(item => item.enabled !== false).map(item => item.name)
      if (Object.keys(advancedConfiguration).length > 1) {
        await bestEffort('advanced settings', () => agents.configure(advancedConfiguration))
      }
      if (appearanceTouched) {
        await bestEffort('appearance', () => agents.configure({
          name: profileName,
          ui_meta: { 'hermes-bots': botMetaForProfile({ color, created: initialCloneFrom ? undefined : Date.now(), image, shape, title }) }
        }))
      }
      if (image) {
        await bestEffort('avatar image', () => agents.setAsset(profileName, { data: image }))
      }
      return { warning: warnings.length > 0 ? `Profile created, but ${warnings.join(' and ')} could not be saved.` : undefined }
    }, {
      onBusy: nextBusy => { setBusy(nextBusy); if (nextBusy) setError(null) },
      onError: classified => setError(classified.message),
      onSettled: () => undefined
    }).then(result => {
      if (!result) return
      void queryClient.invalidateQueries({ queryKey: rosterKey })
      onCreated?.(name.trim(), result.warning)
      onCancel()
    })
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
        <h3 id={dialogTitleId}>{initialCloneFrom ? 'Duplicate profile' : 'Create profile'}</h3>
        <p className="dialog-help">{initialCloneFrom ? `Create a copy of ${initialCloneFrom}.` : 'Create a fresh Hermes profile. It will not switch the active bot.'}</p>
        <label htmlFor="create-profile-name">Profile name</label>
        <Input
          aria-describedby={`${nameHintId}${validationError || error ? ` ${nameErrorId}` : ''}`}
          aria-invalid={Boolean(validationError || error)}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          id="create-profile-name"
          maxLength={PROFILE_NAME_MAX_LENGTH}
          onChange={event => { nameEditedRef.current = true; setName(event.target.value); setError(null) }}
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
          onGenerate={generateAvatar}
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
              {cloneProfiles.map(profile => <option key={profile.name} value={profile.name}>{profile.name}{profile.isDefault ? ' (default)' : ''}</option>)}
            </select>
            {profiles.isPending && <p className="dialog-help" role="status">Loading profiles…</p>}
            {profiles.error && <p className="dialog-help">Existing profiles could not be loaded; enter the source name only if you know it.</p>}
            <label className="dialog-checkbox"><input checked={cloneAll} onChange={event => { setCloneAll(event.target.checked); setAdvancedTouched(true) }} type="checkbox" /><span>Clone all configuration and capabilities</span></label>
            <label className="dialog-checkbox"><input checked={noSkills} onChange={event => { setNoSkills(event.target.checked); setAdvancedTouched(true) }} type="checkbox" /><span>Skip bundled skills</span></label>
            <label className="dialog-checkbox"><input checked={shareAuth} onChange={event => { setShareAuth(event.target.checked); setShareAuthTouched(true); setAdvancedTouched(true) }} type="checkbox" /><span>Share keys and accounts with the launch profile</span></label>
            <label className="dialog-checkbox"><input checked={mirrorCredentials} onChange={event => { setMirrorCredentials(event.target.checked); setMirrorCredentialsTouched(true); setAdvancedTouched(true) }} type="checkbox" /><span>Mirror launch-profile credentials</span></label>
            <ProfileAdvancedFields api={agents} disabledSkills={noSkills} error={advancedError} loading={advancedLoading} onChange={changeAdvanced} state={advancedState} />
          </div>
        )}

        {(validationError || error) && <p className="dialog-field-error" id={nameErrorId} role="alert">{error || validationError}</p>}
        <div className="button-row">
          <Button disabled={busy} onClick={onCancel} type="button" variant="secondary">Cancel</Button>
          <Button disabled={busy || Boolean(validateProfileName(name))} type="submit">{busy ? (initialCloneFrom ? 'Duplicating…' : 'Creating…') : (initialCloneFrom ? 'Duplicate profile' : 'Create profile')}</Button>
        </div>
      </form>
    </div>
  )
}

