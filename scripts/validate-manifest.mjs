/**
 * Validate the package manifest against the DeepSeek Harness bundle contract.
 *
 * Catches the mistakes that make an installed plugin invisible rather than
 * broken: a missing `dsh.client` declaration, an `exports["./client"]` that
 * does not resolve, a `files` list that omits a runtime file (which drops that
 * file from a packed release), or malformed locale metadata.
 *
 *   node scripts/validate-manifest.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const failures = []
let passed = 0

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`  FAIL  ${name}\n        ${error.message}`)
  }
}

const manifestPath = path.join(root, 'package.json')
check('package.json parses', () => {
  JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
})

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

check('has name, version, description, license', () => {
  assert.equal(typeof manifest.name, 'string')
  assert.ok(manifest.name.length > 0, 'name is empty')
  assert.match(manifest.version, /^\d+\.\d+\.\d+/, 'version is not semver')
  assert.ok(manifest.description && manifest.description.length > 20, 'description is too short to be useful')
  assert.ok(manifest.license, 'missing license')
})

check('is an ESM package', () => {
  assert.equal(manifest.type, 'module', 'type must be "module" for an ESM host half')
})

check('declares the bundle patch', () => {
  assert.ok(manifest.dsh && manifest.dsh.bundle, 'missing dsh.bundle')
  assert.equal(typeof manifest.dsh.bundle.patch, 'string')
})

check('bundle patch exists on disk', () => {
  const patch = path.join(root, manifest.dsh.bundle.patch)
  assert.ok(fs.existsSync(patch), `missing ${manifest.dsh.bundle.patch}`)
  const text = fs.readFileSync(patch, 'utf8')
  assert.match(text, /insert:/, 'patch has no insert list')
})

check('declares a web client half', () => {
  assert.ok(manifest.dsh.client, 'missing dsh.client')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(Array.isArray(manifest.dsh.client.inject), 'dsh.client.inject must be an array')
})

check('exports["./client"] resolves to a real file', () => {
  const exported = manifest.exports && manifest.exports['./client']
  assert.ok(exported, 'missing exports["./client"]')
  const target = typeof exported === 'string' ? exported : exported.default
  assert.equal(typeof target, 'string')
  assert.ok(fs.existsSync(path.join(root, target)), `exports["./client"] points at missing ${target}`)
})

check('main entry exists', () => {
  const main = manifest.main || (manifest.exports && manifest.exports['.'])
  assert.ok(main, 'no main or exports["."]')
  const target = typeof main === 'string' ? main : main.default
  assert.ok(fs.existsSync(path.join(root, target)), `entry points at missing ${target}`)
})

check('every declared file exists', () => {
  for (const entry of manifest.files || []) {
    if (entry.includes('*')) {
      // Glob entries: require at least one match in the containing directory.
      const dir = path.join(root, path.dirname(entry))
      const pattern = path.basename(entry).replace(/\./g, '\\.').replace(/\*/g, '.*')
      const matches = fs.existsSync(dir) && fs.readdirSync(dir).some((name) => new RegExp(`^${pattern}$`).test(name))
      assert.ok(matches, `no files match "${entry}"`)
      continue
    }
    assert.ok(fs.existsSync(path.join(root, entry)), `files lists missing "${entry}"`)
  }
})

check('runtime files are covered by the files list', () => {
  const listed = new Set(manifest.files || [])
  for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg']) {
    assert.ok(listed.has(required), `files omits runtime file "${required}" — a packed release would drop it`)
  }
})

check('icon is a small valid SVG', () => {
  const icon = path.join(root, 'icon.svg')
  assert.ok(fs.existsSync(icon), 'missing icon.svg')
  const size = fs.statSync(icon).size
  assert.ok(size < 256 * 1024, `icon is ${size} bytes; the limit is 256 KiB`)
  const text = fs.readFileSync(icon, 'utf8').trim()
  assert.match(text, /^<svg[\s>]/, 'icon.svg does not start with <svg')
  assert.match(text, /<\/svg>\s*$/, 'icon.svg does not end with </svg>')
})

check('locale metadata supplies title and description', () => {
  const localeDir = path.join(root, 'locale')
  assert.ok(fs.existsSync(localeDir), 'missing locale/ directory')
  const files = fs.readdirSync(localeDir).filter((name) => name.endsWith('.json'))
  assert.ok(files.length > 0, 'locale/ contains no JSON files')
  for (const file of files) {
    const dict = JSON.parse(fs.readFileSync(path.join(localeDir, file), 'utf8'))
    assert.ok(dict.meta, `${file} has no meta block`)
    assert.ok(dict.meta.title, `${file} has no meta.title`)
    assert.ok(dict.meta.description, `${file} has no meta.description`)
  }
})

check('English locale is present', () => {
  assert.ok(fs.existsSync(path.join(root, 'locale', 'en.json')), 'missing locale/en.json')
})

check('exports locale and icon resources', () => {
  const exported = manifest.exports || {}
  assert.ok(exported['./locale/*.json'], 'missing exports["./locale/*.json"]')
  assert.ok(exported['./icon'], 'missing exports["./icon"]')
})

check('patch row id matches the package name', () => {
  const patch = fs.readFileSync(path.join(root, manifest.dsh.bundle.patch), 'utf8')
  assert.match(patch, new RegExp(manifest.name), 'patch does not reference the package name')
})

console.log('')
if (failures.length > 0) {
  console.error(`${failures.length} of ${failures.length + passed} checks failed\n`)
  process.exitCode = 1
} else {
  console.log(`${passed} checks passed — manifest is publishable\n`)
}
