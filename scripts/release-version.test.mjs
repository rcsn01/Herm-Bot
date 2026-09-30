import test from 'node:test'
import assert from 'node:assert/strict'
import { compareSemver, latestVersionTag, parseSemver } from './release-version.mjs'

test('parseSemver accepts stable and prerelease versions', () => {
  assert.ok(parseSemver('0.1.0'))
  assert.ok(parseSemver('2.4.1-rc.2'))
})

test('parseSemver rejects invalid versions and numeric prerelease leading zeroes', () => {
  for (const version of ['01.2.3', '1.2', '1.2.3-', '1.2.3-alpha..1', '1.2.3-01']) {
    assert.equal(parseSemver(version), null, version)
  }
})

test('compareSemver follows numeric and prerelease ordering', () => {
  assert.equal(compareSemver('1.2.3', '1.2.4'), -1)
  assert.equal(compareSemver('1.0.0', '1.0.0-rc.1'), 1)
  assert.equal(compareSemver('1.0.0-rc.2', '1.0.0-rc.10'), -1)
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-beta'), -1)
})

test('latestVersionTag ignores invalid/non-release tags and chooses semantic maximum', () => {
  assert.equal(
    latestVersionTag(['release-1.0.0', 'v1.0.0', 'v1.2.0-rc.1', 'v1.1.9', 'vbroken']),
    'v1.2.0-rc.1',
  )
  assert.equal(latestVersionTag(['unrelated']), null)
})
