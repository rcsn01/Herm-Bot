#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { compareSemver, latestVersionTag, parseSemver } from './release-version.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
process.chdir(root)

const args = new Set(process.argv.slice(2))
if (args.has('--help')) {
  console.log('Usage: node scripts/release-images.mjs [--dry-run]')
  console.log('Builds both Docker images, tags the current main commit, and waits for GHCR publication.')
  process.exit(0)
}
for (const arg of args) {
  if (arg !== '--dry-run') fail(`Unknown option: ${arg}`)
}

const clientVersion = await readPackageVersion('client')
const relayVersion = await readPackageVersion('web-push-relay')
const version = clientVersion
if (!parseSemver(version)) fail('client/package.json must contain a valid semantic version.')
if (relayVersion !== version) {
  fail('client and web-push-relay package manifests must have the same version.')
}

const tag = `v${version}`
if (args.has('--dry-run')) {
  console.log(`Hermes Mobile release dry run for ${tag}`)
  console.log('No Git, Docker, or GitHub commands will run; nothing will be built, tagged, pushed, or published.')
  console.log('Actual flow: preflight -> local Docker builds -> annotated tag -> push tag -> GHCR images -> GitHub Release')
  process.exit(0)
}

requireCommand('git', ['--version'], 'Install Git before creating a release.')
requireCommand('docker', ['--version'], 'Install Docker before creating a release.')
requireCommand('gh', ['--version'], 'Install GitHub CLI before creating a release.')
run('gh', ['auth', 'status'], 'Authenticate GitHub CLI first with `gh auth login`.')
const repository = capture('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])

if (capture('git', ['branch', '--show-current']) !== 'main') {
  fail('Releases must be created from the main branch.')
}
if (capture('git', ['status', '--porcelain'])) {
  fail('Commit all working-tree changes before creating a release.')
}

run('git', ['fetch', 'origin', 'main', '--tags'], 'Unable to refresh origin/main and release tags.')
const commit = capture('git', ['rev-parse', 'HEAD'])
if (commit !== capture('git', ['rev-parse', 'origin/main'])) {
  fail('Local main must exactly match origin/main. Push or pull before releasing.')
}

const tags = capture('git', ['tag', '--list', 'v*']).split('\n').filter(Boolean)
if (tags.includes(tag)) fail(`Tag ${tag} already exists.`)
const latestTag = latestVersionTag(tags)
if (latestTag && compareSemver(version, latestTag.slice(1)) <= 0) {
  fail(`Version ${version} must be greater than the latest release ${latestTag}. Bump both package.json versions first.`)
}
if (succeeds('gh', ['release', 'view', tag, '--repo', repository])) {
  fail(`GitHub Release ${tag} already exists.`)
}

console.log(`Building Hermes Mobile ${version} Docker images locally...`)
const localCheckTag = `release-check-${Date.now()}-${process.pid}`
run('docker', ['build', '--pull', '--tag', `hermes-mobile-pwa:${localCheckTag}`, '.'], 'PWA Docker build failed. No release was started.')
run(
  'docker',
  ['build', '--pull', '--tag', `hermes-mobile-web-push-relay:${localCheckTag}`, './web-push-relay'],
  'Web Push relay Docker build failed. No release was started.',
)

run('git', ['tag', '-a', tag, '-m', `Hermes Mobile ${version}`], `Unable to create tag ${tag}.`)
run(
  'git',
  ['push', 'origin', `refs/tags/${tag}:refs/tags/${tag}`],
  `Unable to push tag ${tag}. The tag remains local; inspect it before retrying.`,
)

console.log(`Waiting for the image publication workflow for ${tag}...`)
const runId = await findWorkflowRun(commit)
if (!runId) {
  fail(`Tag ${tag} was pushed, but its workflow run was not found. Check: gh run list --workflow release-images.yml --commit ${commit}`)
}
run('gh', ['run', 'watch', runId, '--exit-status'], `Image release workflow ${runId} failed.`)
run('gh', ['release', 'view', tag, '--repo', repository], `Published images, but GitHub Release ${tag} was not found.`)
console.log(`Published Hermes Mobile ${version}.`)

async function findWorkflowRun(commitSha) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = spawnSync(
      'gh',
      [
        'run',
        'list',
        '--workflow',
        'release-images.yml',
        '--event',
        'push',
        '--commit',
        commitSha,
        '--limit',
        '1',
        '--json',
        'databaseId',
        '--jq',
        '.[0].databaseId // empty',
      ],
      { cwd: root, encoding: 'utf8' },
    )
    if (!result.error && result.status === 0 && result.stdout.trim()) return result.stdout.trim()
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return null
}

async function readPackageVersion(directory) {
  const packageJson = JSON.parse(await readFile(join(root, directory, 'package.json'), 'utf8'))
  const packageLock = JSON.parse(await readFile(join(root, directory, 'package-lock.json'), 'utf8'))
  const lockVersion = packageLock.packages?.['']?.version ?? packageLock.version
  if (lockVersion !== packageJson.version) {
    fail(`${directory}/package.json and package-lock.json versions must match.`)
  }
  return packageJson.version
}

function capture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, encoding: 'utf8' })
  if (result.error || result.status !== 0) fail(`Command failed: ${command} ${commandArgs.join(' ')}`)
  return result.stdout.trim()
}

function succeeds(command, commandArgs) {
  return spawnSync(command, commandArgs, { cwd: root, stdio: 'ignore' }).status === 0
}

function requireCommand(command, commandArgs, message) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'ignore' })
  if (result.error || result.status !== 0) fail(message)
}

function run(command, commandArgs, message) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit' })
  if (result.error || result.status !== 0) fail(message)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
