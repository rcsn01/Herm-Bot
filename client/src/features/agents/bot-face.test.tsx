import { blobatar as blobatarSvg } from 'blobatar/blob'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  appearanceFor,
  BLOB_KIND_TRAIT,
  BotFace,
  defaultShapeFor,
  hashString,
  isBlobShape,
  isDarkColor,
  parseBlobShape,
  profileColorFor
} from './bot-face'

const SHAPES = ['circle', 'squircle', 'pill', 'triangle', 'hexagon', 'cloud', 'drop']

describe('classic desktop bot face derivation', () => {
  it('hashes names the way the desktop does', () => {
    expect(hashString('work')).toBe(3655441)
  })

  it('derives the same shape and color for the same name, forever', () => {
    for (const name of ['default', 'work', 'Searcher', 'food-bot']) {
      expect(defaultShapeFor(name)).toBe(defaultShapeFor(name))
      expect(profileColorFor(name)).toBe(profileColorFor(name))
    }
  })

  it('pins the desktop derivation for a known name', () => {
    expect(defaultShapeFor('work')).toBe('drop')
    expect(profileColorFor('work')).toBe('hsl(1 68% 58%)')
  })

  it('stays inside the seven desktop shapes and the hsl profile palette', () => {
    for (const name of ['a', 'b', 'c', 'hermes', 'research', 'ops', 'food', 'travel']) {
      expect(SHAPES).toContain(defaultShapeFor(name))
      expect(profileColorFor(name)).toMatch(/^hsl\(\d{1,3} 68% 58%\)$/)
    }
  })

  it('flips eye color on dark bodies only', () => {
    expect(isDarkColor('#8d6748')).toBe(true)
    expect(isDarkColor('#f5f5f4')).toBe(false)
    expect(isDarkColor('#8b5cf6')).toBe(false)
    expect(isDarkColor('hsl(1 68% 58%)')).toBe(false)
  })
})

describe('blobatar shape strings (desktop port)', () => {
  it('parses the four desktop shape string forms', () => {
    expect(parseBlobShape('blobatar', 'work')).toEqual({ kind: '', seed: 'work', seedPart: '' })
    expect(parseBlobShape('blobatar:abc', 'work')).toEqual({ kind: '', seed: 'abc', seedPart: 'abc' })
    expect(parseBlobShape('blobatar:abc:boxy', 'work')).toEqual({ kind: 'boxy', seed: 'abc', seedPart: 'abc' })
    expect(parseBlobShape('blobatar::sun', 'work')).toEqual({ kind: 'sun', seed: 'work', seedPart: '' })
  })

  it('drops unknown silhouettes and keeps unnamed bots on a fixed seed', () => {
    expect(parseBlobShape('blobatar::nope', 'work').kind).toBe('')
    expect(parseBlobShape(null, 'work')).toEqual({ kind: '', seed: 'work', seedPart: '' })
    expect(parseBlobShape('blobatar', undefined).seed).toBe('agent')
  })

  it('recognizes blob shape strings only', () => {
    expect(isBlobShape('blobatar')).toBe(true)
    expect(isBlobShape('blobatar:abc:boxy')).toBe(true)
    expect(isBlobShape('squircle')).toBe(false)
    expect(isBlobShape('')).toBe(false)
    expect(isBlobShape(null)).toBe(false)
    expect(isBlobShape(undefined)).toBe(false)
  })

  it('pins the desktop silhouette trait table', () => {
    expect(BLOB_KIND_TRAIT.round).toBe(0.11)
    expect(BLOB_KIND_TRAIT.organic).toBe(0.35)
    expect(BLOB_KIND_TRAIT.boxy).toBe(0.54)
    expect(BLOB_KIND_TRAIT.capsule).toBe(0.65)
    expect(BLOB_KIND_TRAIT.nub).toBe(0.745)
    expect(BLOB_KIND_TRAIT.cloud).toBe(0.825)
    expect(BLOB_KIND_TRAIT.droplet).toBe(0.8875)
    expect(BLOB_KIND_TRAIT.hexagon).toBe(0.9325)
    expect(BLOB_KIND_TRAIT.sun).toBe(0.965)
    expect(BLOB_KIND_TRAIT.triangle).toBe(0.99)
  })

  it('lands each silhouette trait center inside its gen2 band', () => {
    // Band thresholds frozen per blobatar major (desktop avatar.tsx comment,
    // blob.js band table): round <0.22, organic <0.48, boxy <0.6, capsule
    // <0.7, nub <0.79, cloud <0.86, droplet <0.915, hexagon <0.95, sun <0.98.
    const edges: Array<[string, number]> = [
      ['round', 0.22],
      ['organic', 0.48],
      ['boxy', 0.6],
      ['capsule', 0.7],
      ['nub', 0.79],
      ['cloud', 0.86],
      ['droplet', 0.915],
      ['hexagon', 0.95],
      ['sun', 0.98],
      ['triangle', 1]
    ]
    let lower = 0
    for (const [kind, edge] of edges) {
      const center = BLOB_KIND_TRAIT[kind]
      expect(center).toBeGreaterThanOrEqual(lower)
      expect(center).toBeLessThan(edge)
      lower = edge
    }
  })
})

describe('default appearance', () => {
  it('renders bots as blobatar faces that follow their name', () => {
    expect(appearanceFor('work').shape).toBe('blobatar')
    expect(appearanceFor('work')).toEqual(appearanceFor('work'))
  })

  it('keeps the violet squircle for the primary default profile', () => {
    expect(appearanceFor('default')).toEqual({ color: '#8b5cf6', shape: 'squircle' })
    expect(appearanceFor('Default')).toEqual({ color: '#8b5cf6', shape: 'squircle' })
  })

  it('honors a stored blob pick with its seed and silhouette', () => {
    expect(appearanceFor('work', { shape: 'blobatar:abc:boxy' }).shape).toBe('blobatar:abc:boxy')
  })

  it('honors a stored classic pick with its stored color', () => {
    expect(appearanceFor('work', { color: '#123456', shape: 'circle' })).toEqual({ color: '#123456', shape: 'circle' })
  })

  it('renders a stored color alone as the classic name shape', () => {
    expect(appearanceFor('work', { color: '#123456' })).toEqual({ color: '#123456', shape: 'drop' })
  })

  it('falls back to the name-face for unknown stored shapes', () => {
    expect(appearanceFor('work', { shape: 'weird' }).shape).toBe('blobatar')
  })
})

describe('BotFace rendering', () => {
  /** jsdom re-serializes innerHTML (self-closing tags get expanded), so the
   *  library's markup is round-tripped through the same serializer before
   *  comparing. */
  function libraryMarkup(...args: Parameters<typeof blobatarSvg>): string {
    const probe = document.createElement('span')
    probe.innerHTML = blobatarSvg(...args)
    return probe.innerHTML
  }

  it('renders the blobatar name-face inline, identical to the library', () => {
    const { container } = render(<BotFace name="work" />)
    expect(container.querySelector('span.bot-face')?.innerHTML).toBe(libraryMarkup('work', { size: 52 }))
  })

  it('renders stored blob picks with the library, honoring seed and silhouette', () => {
    const { container } = render(<BotFace name="work" shape="blobatar:abc:boxy" />)
    expect(container.querySelector('span.bot-face')?.innerHTML).toBe(
      libraryMarkup('abc', { size: 52, traits: { shape: BLOB_KIND_TRAIT.boxy } })
    )
  })

  it('renders a pinned silhouette on the name seed', () => {
    const { container } = render(<BotFace name="work" shape="blobatar::sun" />)
    expect(container.querySelector('span.bot-face')?.innerHTML).toBe(
      libraryMarkup('work', { size: 52, traits: { shape: BLOB_KIND_TRAIT.sun } })
    )
  })

  it('renders the primary default profile as the violet squircle', () => {
    const { container } = render(<BotFace name="default" />)
    const svg = container.querySelector('svg.bot-face')
    expect(svg).not.toBeNull()
    expect(svg?.querySelector('path')?.getAttribute('fill')).toBe('#8b5cf6')
  })

  it('renders a stored classic pick in its stored color', () => {
    const { container } = render(<BotFace color="#123456" name="work" shape="circle" />)
    expect(container.querySelector('svg.bot-face path')?.getAttribute('fill')).toBe('#123456')
  })
})