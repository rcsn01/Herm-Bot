const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?$/

export function parseSemver(version) {
  const match = SEMVER_PATTERN.exec(version)
  if (!match) return null

  const prerelease = match[4] ? match[4].split('.') : []
  if (
    prerelease.some(
      (identifier) =>
        identifier.length === 0 ||
        !/^[0-9A-Za-z-]+$/.test(identifier) ||
        (/^[0-9]+$/.test(identifier) && identifier.length > 1 && identifier[0] === '0'),
    )
  ) {
    return null
  }

  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: prerelease.map((identifier) => ({
      value: identifier,
      numeric: /^[0-9]+$/.test(identifier),
    })),
  }
}

export function compareSemver(left, right) {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (!a || !b) throw new Error('compareSemver requires valid semantic versions.')

  for (const part of ['major', 'minor', 'patch']) {
    if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1
  }

  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0
    return a.prerelease.length === 0 ? 1 : -1
  }

  const sharedLength = Math.min(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < sharedLength; index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart.value === rightPart.value) continue
    if (leftPart.numeric && rightPart.numeric) {
      return BigInt(leftPart.value) < BigInt(rightPart.value) ? -1 : 1
    }
    if (leftPart.numeric !== rightPart.numeric) return leftPart.numeric ? -1 : 1
    return leftPart.value < rightPart.value ? -1 : 1
  }

  if (a.prerelease.length === b.prerelease.length) return 0
  return a.prerelease.length < b.prerelease.length ? -1 : 1
}

export function latestVersionTag(tags) {
  let latest = null

  for (const tag of tags) {
    if (!tag.startsWith('v')) continue
    const version = tag.slice(1)
    if (!parseSemver(version)) continue
    if (!latest || compareSemver(version, latest.slice(1)) > 0) latest = tag
  }

  return latest
}
