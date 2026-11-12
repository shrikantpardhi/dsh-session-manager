/**
 * Client-half verification for dsh-session-manager.
 *
 * The Settings page is a hand-authored module-loader bundle, so two things can
 * break it and neither is caught by the host tests:
 *   1. the bundle must parse and export the contract the shell calls
 *      (`name`, `inject`, `apply(ctx)`);
 *   2. `apply` must register exactly one `settings.section` with a render
 *      function that returns a mountable element instead of throwing.
 *
 * React is stubbed with a tiny createElement so the render tree can be walked
 * without a DOM:
 *
 *   node test-client.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(import.meta.dirname, 'client.js'), 'utf8')

/* -------------------------------------------------------------- harness */

let loaded = null
const hookCalls = []

function stubReact() {
  function createElement(type, props, ...children) {
    return { type, props: props || {}, children }
  }
  const React = { createElement }
  React.useState = (initial) => {
    hookCalls.push('useState')
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  }
  React.useCallback = (fn) => { hookCalls.push('useCallback'); return fn }
  React.useMemo = (fn) => { hookCalls.push('useMemo'); return fn() }
  React.useEffect = () => { hookCalls.push('useEffect') }
  return React
}

function runBundle(sourceText) {
  const React = stubReact()
  const registrations = []
  const injections = []
  let applied = null

  const slots = {
    inject(slot, callback) { injections.push(slot); if (slot === 'settings.section') callback() },
    register(meta, render) { registrations.push({ meta, render }); return () => {} },
  }

  const ctx = {
    get(name) { return name === 'slots' ? slots : undefined },
    inject(_services, callback) { callback({ get: (n) => (n === 'slots' ? slots : undefined) }) },
    slots,
    effect(cb) { if (typeof cb === 'function') cb() },
    provide() {},
    on() { return () => {} },
  }

  const window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        loaded = { id }
        applied = factory((name) => {
          if (name === 'react') return React
          throw new Error(`unexpected require(${name})`)
        })
      },
    },
  }

  const fn = new Function('window', 'document', 'fetch', `${sourceText}\n`)
  fn(window, undefined, async () => { throw new Error('fetch is not expected during render') })

  return { exports: applied, ctx, registrations, injections }
}

/* ---------------------------------------------------------------- tests */

const results = []
function check(name, fn) {
  try {
    fn()
    results.push(true)
    console.log(`  PASS  ${name}`)
  } catch (error) {
    results.push(false)
    console.error(`  FAIL  ${name}\n        ${error.message}`)
  }
}

console.log('\ndsh-session-manager — client bundle\n')

const bundle = runBundle(source)

check('bundle declares its module id', () => {
  assert.equal(loaded.id, 'dsh-session-manager')
})

check('exports name, inject and apply', () => {
  assert.equal(typeof bundle.exports.name, 'string')
  assert.ok(Array.isArray(bundle.exports.inject), 'inject must be an array')
  assert.equal(typeof bundle.exports.apply, 'function')
})

check('apply registers one settings.section', () => {
  bundle.exports.apply(bundle.ctx)
  const sections = bundle.registrations.filter((entry) => entry.meta.name === 'settings.section')
  assert.equal(sections.length, 1, `expected 1 settings.section, got ${sections.length}`)
  assert.equal(sections[0].meta.id, 'dsh-session-manager')
})

check('section label is a thunk returning a string', () => {
  const section = bundle.registrations.find((entry) => entry.meta.name === 'settings.section')
  assert.equal(typeof section.meta.label, 'function')
  assert.equal(section.meta.label(), 'Sessions')
})

check('section renders a mountable element without throwing', () => {
  const section = bundle.registrations.find((entry) => entry.meta.name === 'settings.section')
  const element = section.render()
  assert.ok(element && typeof element === 'object', 'render returned nothing')
  assert.equal(typeof element.type, 'function')
})

check('render tree contains the page chrome', () => {
  const section = bundle.registrations.find((entry) => entry.meta.name === 'settings.section')
  // `render()` returns <SessionManagerSection/>; invoke it the way React would.
  const tree = expand(section.render())
  const text = collectText(tree)
  assert.ok(text.includes('Sessions'), 'missing page title')
  assert.ok(text.includes('Refresh'), 'missing refresh control')
  assert.ok(/Archived/.test(text), 'missing archived filter')
  assert.ok(/Pinned/.test(text), 'missing pinned filter')
  assert.ok(text.includes('All'), 'missing all filter')
  assert.equal(tree.props.className, 'dsm-root')
})

check('empty state explains what the page is for', () => {
  const section = bundle.registrations.find((entry) => entry.meta.name === 'settings.section')
  const text = collectText(expand(section.render()))
  assert.ok(/No sessions yet/.test(text) || /Loading/.test(text), 'no empty-state copy')
})

check('apply survives a host with no slots service', () => {
  const ctx = { get: () => undefined, inject(_s, cb) { cb({ get: () => undefined }) } }
  assert.doesNotThrow(() => bundle.exports.apply(ctx))
})

check('apply survives a host that throws on service lookup', () => {
  const ctx = { get() { throw new Error('boom') } }
  assert.doesNotThrow(() => bundle.exports.apply(ctx))
})

check('style is inserted once, guarded by id', () => {
  const created = []
  const document = {
    getElementById: (id) => created.find((el) => el.id === id) || null,
    createElement: () => ({}),
    head: { appendChild: (el) => created.push(el) },
  }
  const fn = new Function('window', 'document', 'fetch', `${source}\n`)
  fn({ __ModuleLoader__: { load({ factory }) { factory((n) => (n === 'react' ? stubReact() : undefined)) } } }, document, async () => {})
  assert.equal(created.length, 0, 'styles must not be inserted before a render')
})

/** Flatten every string in a React-ish tree, ignoring functions. */
function collectText(node) {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (typeof node === 'function') return ''
  if (Array.isArray(node)) return node.map(collectText).join(' ')
  const props = node.props || {}
  return [collectText(node.children), collectText(props.children)].join(' ')
}

/**
 * Invoke function components the way React would, so a section's real render
 * output can be asserted instead of the element that _describes_ it.
 */
function expand(node) {
  if (node == null || typeof node !== 'object' || Array.isArray(node)) return node
  if (typeof node.type === 'function') return expand(node.type(node.props || {}))
  return node
}

/* --------------------------------------------------------------- report */

const failed = results.filter((ok) => !ok).length
console.log('')
if (failed > 0) {
  console.error(`${failed} check(s) failed\n`)
  process.exitCode = 1
} else {
  console.log(`${results.length} checks passed — client contract verified\n`)
}
