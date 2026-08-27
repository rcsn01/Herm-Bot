import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const derived = path.join(root, 'build', 'DerivedData')
const app = path.join(derived, 'Build', 'Products', 'Release-iphoneos', 'App.app')
const outputDir = path.resolve(root, '../output')
const output = path.join(outputDir, 'Hermes-Mobile.ipa')
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: 'inherit' })

run('npm', ['run', 'build'])
run('npx', ['cap', 'sync', 'ios'])
run('xcodebuild', [
  '-project', 'ios/App/App.xcodeproj',
  '-scheme', 'App',
  '-configuration', 'Release',
  '-sdk', 'iphoneos',
  '-derivedDataPath', derived,
  'CODE_SIGNING_ALLOWED=NO',
  'CODE_SIGNING_REQUIRED=NO',
  'CODE_SIGN_IDENTITY='
])

if (!existsSync(path.join(app, 'App')) || !existsSync(path.join(app, 'Info.plist'))) {
  throw new Error(`unsigned app is incomplete: ${app}`)
}

mkdirSync(outputDir, { recursive: true })
const staging = mkdtempSync(path.join(tmpdir(), 'hermes-mobile-ipa-'))
mkdirSync(path.join(staging, 'Payload'))
run('ditto', [app, path.join(staging, 'Payload', 'Hermes Mobile.app')])
const temporaryIpa = path.join(staging, 'Hermes-Mobile.ipa')
run('ditto', ['-c', '-k', '--norsrc', '--noextattr', '--keepParent', 'Payload', temporaryIpa], staging)
rmSync(output, { force: true })
renameSync(temporaryIpa, output)
rmSync(staging, { recursive: true, force: true })
console.log(`Created unsigned IPA: ${output}`)
