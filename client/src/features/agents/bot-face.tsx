/**
 * Bot avatars ported from the Hermes desktop so every bot renders the same
 * icon on both surfaces. Two modes, matching desktop botAppearance:
 *
 * - blobatar (the desktop's default for new agents, and the PWA default for
 *   named bots): the blobatar library — pinned to 2.0.0, the exact version
 *   the desktop pins — draws the whole face (soft body, eyes, its own
 *   name-derived OKLCh palette) from the bot's name or a stored seed. Shape
 *   strings follow the desktop vocabulary: 'blobatar', 'blobatar:<seed>',
 *   'blobatar:<seed>:<kind>', 'blobatar::<kind>'.
 * - classic geometric: seven name-derived shapes (circle, squircle, pill,
 *   triangle, hexagon, cloud, drop) with the desktop's per-profile color and
 *   the idle face (two eyes with light glints, no mouth) — rendered for the
 *   primary "default" profile (violet squircle) and whenever a stored
 *   classic pick is supplied.
 *
 * Sources, kept faithful:
 * - hermes-agent apps/desktop/src/plugins/hermes-bots/avatar.tsx (main):
 *   BLOB_KINDS/BLOB_KIND_TRAIT/parseBlobShape/blobMarkup, botAppearance and
 *   the geometric BotFace it falls back to.
 * - Per-profile color: apps/desktop/src/lib/profile-color.ts
 *   (profileColor: hsl(hash % 360 68% 58%) for named profiles).
 *
 * The PWA cannot read the desktop's local bot-meta storage, so bots without
 * a stored pick render the blobatar name-face — the desktop's default for
 * new agents.
 */
import { blobatar as blobatarSvg, type BlobatarOptions } from 'blobatar/blob'

export type BotShape = 'circle' | 'cloud' | 'drop' | 'hexagon' | 'pill' | 'squircle' | 'triangle'

const AVATAR_SHAPES: readonly BotShape[] = ['circle', 'squircle', 'pill', 'triangle', 'hexagon', 'cloud', 'drop']

/** Same string hash the desktop uses for shape and profile hue. */
export function hashString(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  return hash
}

export function defaultShapeFor(name: string): BotShape {
  return AVATAR_SHAPES[hashString(name) % AVATAR_SHAPES.length]
}

/** Desktop SDK profileColor: named profiles get a stable hue at 68%/58%. */
export function profileColorFor(name: string): string {
  const key = name.trim()
  return `hsl(${hashString(key) % 360} 68% 58%)`
}

// ── blobatar shapes mode (the desktop's default for new agents) ─────────────
// Ported from hermes-agent apps/desktop/src/plugins/hermes-bots/avatar.tsx
// (main). Shape strings: 'blobatar' (the face follows the bot's name),
// 'blobatar:<seed>' (seed locked), 'blobatar:<seed>:<kind>' (one of the ten
// silhouettes pinned), 'blobatar::<kind>' (silhouette pinned, seed follows
// the name). Colors come from the library's own name-derived palette
// (contrast-guaranteed) — the classic color swatches don't apply.

export const BLOB_KINDS: readonly string[] = [
  'round',
  'organic',
  'boxy',
  'capsule',
  'nub',
  'cloud',
  'droplet',
  'hexagon',
  'sun',
  'triangle'
]

// Trait positions at the center of each silhouette band. Band thresholds are
// frozen per blobatar major (gen2: 0.22 / 0.48 / 0.60 / 0.70 / 0.79 / 0.86 /
// 0.915 / 0.95 / 0.98).
export const BLOB_KIND_TRAIT: Record<string, number> = {
  round: 0.11,
  organic: 0.35,
  boxy: 0.54,
  capsule: 0.65,
  nub: 0.745,
  cloud: 0.825,
  droplet: 0.8875,
  hexagon: 0.9325,
  sun: 0.965,
  triangle: 0.99
}

export function isBlobShape(shape: null | string | undefined): boolean {
  return shape === 'blobatar' || (typeof shape === 'string' && shape.startsWith('blobatar:'))
}

/** Build the desktop-compatible blobatar shape string. An empty seed follows
 * the profile name; an empty kind leaves the silhouette on automatic mode. */
export function blobShapeString(seedPart: string, kind: string): string {
  if (kind) return `blobatar:${seedPart}:${kind}`
  return seedPart ? `blobatar:${seedPart}` : 'blobatar'
}

export interface ParsedBlobShape {
  /** A BlobKind when the silhouette is pinned, else empty. */
  kind: string
  /** The seed actually rendered — the pinned one, else the bot's name. */
  seed: string
  /** The pinned seed alone, empty when the face follows the name. */
  seedPart: string
}

export function parseBlobShape(shape: null | string | undefined, name: string | undefined): ParsedBlobShape {
  const parts = typeof shape === 'string' ? shape.split(':') : []
  const seedPart = parts[1] || ''
  const kind = BLOB_KINDS.includes(parts[2]) ? parts[2] : ''

  return {
    seed: seedPart || name || 'agent',
    seedPart,
    kind
  }
}

/** Static SVG markup for a blob face, drawn entirely by the library. */
function blobMarkup(shape: null | string | undefined, name: string, size: number): string | null {
  const { seed, kind } = parseBlobShape(shape, name)

  const opts: BlobatarOptions = { size }
  if (kind) {
    opts.traits = {
      shape: BLOB_KIND_TRAIT[kind]
    }
  }

  try {
    return blobatarSvg(seed, opts)
  } catch {
    return null
  }
}

export interface BotAppearance {
  color: string
  shape: string
}

export interface BotStoredAppearance {
  color?: null | string
  shape?: null | string
}

/** Desktop botAppearance: the primary "default" profile gets a fixed violet
 *  squircle unless the user customized it; everyone else renders their stored
 *  pick, falling back to the blobatar name-face (new-agent default) when no
 *  pick is visible to the PWA. */
export function appearanceFor(name: string, stored?: BotStoredAppearance | null): BotAppearance {
  const storedShape = stored?.shape || ''
  const storedColor = stored?.color || ''

  if (name.trim().toLowerCase() === 'default' && !storedShape && !storedColor) {
    return { color: '#8b5cf6', shape: 'squircle' }
  }

  if (!storedShape) {
    return storedColor
      ? { color: storedColor, shape: defaultShapeFor(name) }
      : { color: profileColorFor(name), shape: 'blobatar' }
  }

  if (isBlobShape(storedShape) || (AVATAR_SHAPES as readonly string[]).includes(storedShape)) {
    return { color: storedColor || profileColorFor(name), shape: storedShape }
  }

  return { color: storedColor || profileColorFor(name), shape: 'blobatar' }
}

/** Perceptual luminance — eyes flip warm on dark bodies. hsl() strings read as light. */
export function isDarkColor(color: string): boolean {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return false
  const n = parseInt(color.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 110
}

type Point = readonly [number, number]

function cubicAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t
  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
  ]
}

function svgArc(x1: number, y1: number, rx: number, ry: number, fa: number, fs: number, x2: number, y2: number) {
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  let rx2 = rx * rx
  let ry2 = ry * ry
  const lam = (dx * dx) / rx2 + (dy * dy) / ry2
  if (lam > 1) {
    const s = Math.sqrt(lam)
    rx *= s
    ry *= s
    rx2 = rx * rx
    ry2 = ry * ry
  }
  const num = rx2 * ry2 - rx2 * dy * dy - ry2 * dx * dx
  const den = rx2 * dy * dy + ry2 * dx * dx
  let sq = Math.sqrt(Math.max(0, num / den))
  if (fa === fs) {
    sq = -sq
  }
  const cx = sq * (rx * dy / ry) + (x1 + x2) / 2
  const cy = sq * (-ry * dx / rx) + (y1 + y2) / 2
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const n = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1
    let a = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / n)))
    if (ux * vy - uy * vx < 0) {
      a = -a
    }
    return a
  }
  const theta1 = ang(1, 0, (x1 - cx) / rx, (y1 - cy) / ry)
  let dtheta = ang((x1 - cx) / rx, (y1 - cy) / ry, (x2 - cx) / rx, (y2 - cy) / ry)
  if (!fs && dtheta > 0) {
    dtheta -= Math.PI * 2
  }
  if (fs && dtheta < 0) {
    dtheta += Math.PI * 2
  }
  return { cx, cy, rx, ry, theta1, dtheta }
}

function sampleArc(arc: ReturnType<typeof svgArc>, n: number): Point[] {
  const pts: Point[] = []
  for (let i = 0; i < n; i++) {
    const th = arc.theta1 + arc.dtheta * (i / n)
    pts.push([arc.cx + arc.rx * Math.cos(th), arc.cy + arc.ry * Math.sin(th)])
  }
  return pts
}

/** Same outline as the old GitHub drop path, so it stays a fat water drop. */
function sampleDropRing(steps: number): Point[] {
  const pts: Point[] = []
  const n = Math.max(8, Math.floor(steps / 3))

  for (let i = 0; i < n; i++) {
    pts.push(cubicAt([20, 3], [20, 3], [6, 20], [6, 27], i / n))
  }

  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI
    pts.push([20 - 14 * Math.cos(t), 27 + 13.5 * Math.sin(t)])
  }

  for (let i = 1; i <= n; i++) {
    pts.push(cubicAt([34, 27], [34, 20], [20, 3], [20, 3], i / n))
  }

  return pts
}

/** Outline of a face in a 40x40 box, sampled from the desktop's formulas. */
function sampleFaceRing(shape: BotShape, steps = 52): Point[] {
  const pts: Point[] = []

  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2 - Math.PI / 2
    const c = Math.cos(a)
    const s = Math.sin(a)
    let rx = 16
    let ry = 16

    if (shape === 'circle') {
      rx = ry = 16.2
    } else if (shape === 'squircle') {
      const p = 5
      const d = Math.pow(Math.abs(c) ** p + Math.abs(s) ** p, 1 / p) || 1
      rx = ry = 16.2 / d
    } else if (shape === 'pill') {
      const d = Math.pow(Math.abs(c) ** 8 + Math.abs(s / 0.72) ** 8, 1 / 8) || 1
      rx = ry = 16 / d
    } else if (shape === 'triangle') {
      const u = (a + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2)
      const sector = (u / (Math.PI * 2 / 3)) % 1
      rx = ry = 13.5 / Math.max(0.42, Math.cos((sector - 0.5) * 1.9))
    } else if (shape === 'hexagon') {
      const seg = Math.PI / 3
      const hex = Math.cos(seg / 2) / Math.cos(a - seg * Math.round(a / seg))
      rx = ry = 16.2 * hex
    } else {
      rx = ry = 16.2
    }

    pts.push([20 + rx * c, 20 + ry * s])
  }

  return pts
}

function ringToPath(pts: Point[]): string {
  if (!pts.length) {
    return ''
  }
  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`
  for (let i = 1; i < pts.length; i++) {
    d += `L${pts[i][0].toFixed(2)} ${pts[i][1].toFixed(2)}`
  }
  return d + 'Z'
}

const CLOUD_PATH = 'M11 32 a7.5 7.5 0 0 1 -1 -14.9 A9.5 9.5 0 0 1 29 12.5 A7 7 0 0 1 30 32 Z'

function bodyPath(shape: BotShape): string {
  if (shape === 'cloud') return CLOUD_PATH
  if (shape === 'drop') return ringToPath(sampleDropRing(52))
  return ringToPath(sampleFaceRing(shape))
}

export interface BotFaceProps {
  color?: null | string
  name: string
  shape?: null | string
  size?: number
}

/**
 * Render order mirrors the desktop BotFace: a blob shape string inlines the
 * library's whole-face markup; anything else falls to the classic geometric
 * face (the violet squircle for the primary "default" profile). If the
 * library ever fails to produce markup, the classic name-derived face keeps
 * a deterministic icon on screen.
 */
export function BotFace({ color, name, shape, size = 52 }: BotFaceProps) {
  const appearance = appearanceFor(name, { color, shape })

  if (isBlobShape(appearance.shape)) {
    const markup = blobMarkup(appearance.shape, name, size)
    if (markup) {
      return (
        <span
          aria-hidden="true"
          className="bot-face"
          dangerouslySetInnerHTML={{ __html: markup }}
          style={{ display: 'block', height: size, lineHeight: 0, width: size }}
        />
      )
    }
  }

  const classicShape: BotShape = isBlobShape(appearance.shape) ? defaultShapeFor(name) : (appearance.shape as BotShape)
  const eyeFill = isDarkColor(appearance.color) ? 'rgba(232,220,195,0.95)' : 'rgba(0,0,0,0.85)'
  return (
    <svg
      aria-hidden="true"
      className="bot-face"
      height={size}
      style={{ display: 'block', overflow: 'visible' }}
      viewBox="0 0 40 44"
      width={size}
    >
      <path d={bodyPath(classicShape)} fill={appearance.color} />
      <ellipse cx="15.4" cy="17.2" fill={eyeFill} rx="2.2" ry="2.3" />
      <ellipse cx="24.6" cy="17.2" fill={eyeFill} rx="2.2" ry="2.3" />
      <circle cx="14.8" cy="16.5" fill="rgba(255,255,255,0.85)" r="0.65" />
      <circle cx="24" cy="16.5" fill="rgba(255,255,255,0.85)" r="0.65" />
    </svg>
  )
}