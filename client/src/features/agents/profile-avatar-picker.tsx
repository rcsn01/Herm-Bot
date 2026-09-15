import { useRef, useState } from 'react'

import { Button } from '~/compat/primitives'

import { BLOB_KINDS, blobShapeString, BotFace, defaultShapeFor, isBlobShape, parseBlobShape, profileColorFor } from './bot-face'

/** The desktop picker exposes both its deterministic blobatar characters and
 * the older geometric faces. Keep the values wire-compatible with BotMeta. */
const SHAPES: readonly { label: string; value: string }[] = [
  { label: 'Auto', value: 'blobatar' },
  ...BLOB_KINDS.map(kind => ({ label: kind[0].toUpperCase() + kind.slice(1), value: `blobatar::${kind}` })),
  { label: 'Circle', value: 'circle' },
  { label: 'Squircle', value: 'squircle' },
  { label: 'Pill', value: 'pill' },
  { label: 'Triangle', value: 'triangle' },
  { label: 'Hexagon', value: 'hexagon' },
  { label: 'Cloud', value: 'cloud' },
  { label: 'Drop', value: 'drop' }
]

/** Matches the desktop's compact color-swatch treatment without importing its
 * desktop-only SDK. The null option keeps the name-derived color. */
export const PROFILE_COLORS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#f43f5e',
  '#64748b'
] as const

interface ProfileAvatarPickerProps {
  color: null | string
  image: null | string
  name: string
  onColor(color: null | string): void
  onGenerate?(prompt: string): Promise<null | string>
  onImage(image: null | string): void
  onShape(shape: string): void
  shape: string
  title?: string
}

function readImage(file: File): Promise<null | string> {
  return new Promise(resolve => {
    const reader = new FileReader()
    reader.onload = () => {
      const source = typeof reader.result === 'string' ? reader.result : null
      if (!source || typeof Image === 'undefined') {
        resolve(source)
        return
      }
      const image = new Image()
      image.onload = () => {
        // profiles.set_asset caps decoded images at 2 MB. A bounded canvas
        // keeps normal phone photos below that limit before they cross the
        // gateway boundary, while retaining transparency in WebP-capable
        // browsers.
        const maxDimension = 512
        const scale = Math.min(1, maxDimension / image.naturalWidth, maxDimension / image.naturalHeight)
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
        const context = canvas.getContext('2d')
        if (!context) {
          resolve(source)
          return
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/webp', 0.86))
      }
      image.onerror = () => resolve(null)
      image.src = source
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

function shapeLabel(shape: string): string {
  if (shape === 'blobatar') return 'Auto character'
  if (isBlobShape(shape)) {
    const { kind } = parseBlobShape(shape, undefined)
    return kind ? `${kind[0].toUpperCase()}${kind.slice(1)} character` : 'Auto character'
  }
  return shape[0] ? `${shape[0].toUpperCase()}${shape.slice(1)} face` : 'Character'
}

export function ProfileAvatarPicker({
  color,
  image,
  name,
  onColor,
  onGenerate,
  onImage,
  onShape,
  shape,
  title
}: ProfileAvatarPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [tab, setTab] = useState<'character' | 'generate' | 'upload'>('character')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const previewName = name.trim() || 'agent'
  const previewColor = color || profileColorFor(previewName)
  const blobMode = isBlobShape(shape)
  const blobSelection = parseBlobShape(shape, previewName)
  const shapeOptions = blobMode
    ? [
        { label: 'Auto', value: blobShapeString(blobSelection.seedPart, '') },
        ...BLOB_KINDS.map(kind => ({ label: kind[0].toUpperCase() + kind.slice(1), value: blobShapeString(blobSelection.seedPart, kind) }))
      ]
    : SHAPES.filter(option => !option.value.startsWith('blobatar:'))

  const chooseFile = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type.toLowerCase())) {
      setError('Choose a PNG, JPEG, or WebP image.')
      return
    }
    if (file.size > 15_000_000) {
      setError('Images must be 15 MB or smaller.')
      return
    }
    const data = await readImage(file)
    if (!data) {
      setError('That image could not be read.')
      return
    }
    onImage(data)
  }

  const generate = async () => {
    if (!onGenerate || busy) return
    const value = prompt.trim() || [title, name].filter(Boolean).join(' ')
    if (!value) {
      setError('Describe the avatar first.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const generated = await onGenerate(value)
      if (!generated) throw new Error('The image service returned no image.')
      onImage(generated)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Avatar generation failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label="Avatar" className="profile-avatar-picker">
      <div className="profile-avatar-preview" aria-label={`Avatar preview: ${image ? 'uploaded image' : shapeLabel(shape)}`}>
        {image
          ? <img alt="" className="profile-avatar-preview-image" src={image} />
          : <BotFace color={previewColor} name={previewName} shape={shape} size={72} />}
      </div>
      <div aria-label="Avatar type" className="profile-avatar-tabs" role="tablist">
        <button aria-selected={tab === 'character'} onClick={() => setTab('character')} role="tab" type="button">Character</button>
        <button aria-selected={tab === 'generate'} disabled={!onGenerate} onClick={() => setTab('generate')} role="tab" type="button">Generate</button>
        <button aria-selected={tab === 'upload'} onClick={() => setTab('upload')} role="tab" type="button">Upload</button>
      </div>

      {tab === 'character' && (
        <div className="profile-avatar-character">
          <div aria-label="Choose a character" className="profile-shape-grid" role="group">
            {shapeOptions.map(option => (
              <button
                aria-label={option.label}
                aria-pressed={!image && shape === option.value}
                className={!image && shape === option.value ? 'selected' : ''}
                key={option.value}
                onClick={() => {
                  setError(null)
                  onImage(null)
                  onShape(option.value)
                }}
                title={option.label}
                type="button"
              >
                <BotFace color={previewColor} name={previewName} shape={option.value} size={38} />
              </button>
            ))}
          </div>
          {!isBlobShape(shape) && <div aria-label="Choose a color" className="profile-color-swatches" role="group">
            <button
              aria-label="Match name color"
              aria-pressed={!color}
              className={!color ? 'selected match-name' : 'match-name'}
              onClick={() => onColor(null)}
              title="Match name color"
              type="button"
            >
              <span style={{ background: previewColor }} />
            </button>
            {PROFILE_COLORS.map(value => (
              <button
                aria-label={value}
                aria-pressed={color === value}
                className={color === value ? 'selected' : ''}
                key={value}
                onClick={() => onColor(value)}
                title={value}
                type="button"
              >
                <span style={{ background: value }} />
              </button>
            ))}
          </div>}
          {blobMode && (
            <>
              <div className="profile-avatar-picker-actions">
                <Button onClick={() => { onImage(null); onShape(blobShapeString(Math.random().toString(36).slice(2, 10), blobSelection.kind)) }} size="sm" type="button" variant="text">Randomize</Button>
                <Button onClick={() => onShape(blobShapeString(blobSelection.seedPart ? '' : previewName, blobSelection.kind))} size="sm" type="button" variant="text">{blobSelection.seedPart ? 'Unlock face' : 'Lock face'}</Button>
              </div>
              <p className="dialog-help">{blobSelection.seedPart ? 'Face locked — renaming will not change it.' : 'Face follows the profile name.'}</p>
            </>
          )}
          <Button onClick={() => onShape(blobMode ? defaultShapeFor(previewName) : 'blobatar')} size="sm" type="button" variant="text">{blobMode ? 'Use classic shapes' : 'Use blob characters'}</Button>
        </div>
      )}

      {tab === 'generate' && (
        <div className="profile-avatar-generate">
          <textarea aria-label="Avatar description" onChange={event => setPrompt(event.target.value)} placeholder="Describe the avatar…" value={prompt} />
          <Button disabled={busy || !onGenerate} onClick={() => void generate()} type="button" variant="secondary">
            {busy ? 'Generating…' : 'Generate avatar'}
          </Button>
        </div>
      )}

      {tab === 'upload' && (
        <div className="profile-avatar-upload">
          <input accept="image/png,image/jpeg,image/webp" className="profile-avatar-file-input" id={`profile-avatar-file-${previewName}`} onChange={event => { void chooseFile(event.target.files?.[0]); event.currentTarget.value = '' }} ref={inputRef} type="file" />
          <Button onClick={() => inputRef.current?.click()} type="button" variant="secondary">Choose an image…</Button>
          <p className="dialog-help">PNG, JPEG, or WebP up to 15 MB. Images are resized for the gateway.</p>
        </div>
      )}

      {image && <Button className="profile-avatar-remove" onClick={() => onImage(null)} size="sm" type="button" variant="text">Remove image</Button>}
      {error && <p className="dialog-field-error" role="alert">{error}</p>}
    </section>
  )
}
