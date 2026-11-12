/**
 * Host-half verification for dsh-session-manager.
 *
 * Runs against a throwaway DSH home, so it never touches the real session
 * corpus. Exercises the contract the Settings page depends on:
 *   - state listing (titles, archive/pin flags, workspace mapping, byte sizes)
 *   - archive / pin actions reaching the workspace registry
 *   - permanent deletion removing files AND reconciling the registry
 *   - refusal to delete a running session
 *
 *   node test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsm-home-'))
process.env.DSH_HOME = home

const sessionsRoot = path.join(home, 'sessions')
const groupDir = path.join(sessionsRoot, '--D-PROJECTS-Demo--')
const storageDir = path.join(home, 'storages')
const cacheDir = path.join(storageDir, 'session_projcache')

const SESSION_A = 'session-aaaaaaaa-1111-2222-3333-444444444444'
const SESSION_B = 'session-bbbbbbbb-1111-2222-3333-444444444444'
const SESSION_LIVE = 'session-cccccccc-1111-2222-3333-444444444444'
const SESSION_ORPHAN = 'session-dddddddd-1111-2222-3333-444444444444'

async function writeSession(id, bytes) {
  const dir = path.join(groupDir, id)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(bytes, 7))
  return dir
}

const dirA = await writeSession(SESSION_A, 2048)
const dirB = await writeSession(SESSION_B, 1024)
const dirLive = await writeSession(SESSION_LIVE, 512)
// A session left on disk that neither persistence nor the registry references:
// the leftovers a cleanup page exists to surface.
const dirOrphan = await writeSession(SESSION_ORPHAN, 4096)

await fsp.mkdir(cacheDir, { recursive: true })
await fsp.writeFile(path.join(cacheDir, `${SESSION_A}.json`), '{}')

const registry = {
  unit: { name: 'workspace', version: 2 },
  global: {
    initialized: true,
    workspaceIds: ['ws-1'],
    archivedSessionIds: [SESSION_B],
    pinnedSessionIds: [SESSION_A],
  },
  tables: {
    workspaces: {
      'ws-1': {
        path: 'D:\\PROJECTS\\Demo',
        title: 'Demo',
        sessionIds: [SESSION_A, SESSION_B, SESSION_LIVE],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    },
  },
}
await fsp.mkdir(storageDir, { recursive: true })
await fsp.writeFile(path.join(storageDir, 'workspace.json'), JSON.stringify(registry, null, 2))

const plugin = await import('./index.js')

/* ------------------------------------------------------------ fake host */

const archiveCalls = []
const pinCalls = []
const unarchiveCalls = []
const unpinCalls = []

const records = [
  { header: { id: SESSION_A, createdAt: 1_700_000_000_000, cwd: 'D:\\PROJECTS\\Demo' }, live: false, persisted: true },
  { header: { id: SESSION_B, createdAt: 1_700_000_100_000, cwd: 'D:\\PROJECTS\\Demo' }, live: false, persisted: true },
  { header: { id: SESSION_LIVE, createdAt: 1_700_000_200_000, cwd: 'D:\\PROJECTS\\Demo' }, live: true, persisted: true },
]

const host = {
  get(name) {
    if (name === 'sessionQuery') {
      return {
        listSessions: async () => records,
        readTitleSnapshots: async (ids) => ids.map((sessionId) => ({
          sessionId,
          status: 'fulfilled',
          value: { session: { id: sessionId }, title: { title: `Title of ${sessionId.slice(8, 16)}` } },
        })),
      }
    }
    if (name === 'sessions') {
      return { get: (id) => (id === SESSION_LIVE ? { id } : undefined) }
    }
    if (name === 'workspaceRegistry') {
      return {
        archiveSession: async (id, options) => { archiveCalls.push({ id, options }) },
        unarchiveSession: async (id) => { unarchiveCalls.push(id) },
        pinSession: async (id) => { pinCalls.push(id) },
        unpinSession: async (id) => { unpinCalls.push(id) },
      }
    }
    return undefined
  },
}

const failures = []
let passed = 0
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`  PASS  ${name}`) })
    .catch((error) => {
      failures.push({ name, error })
      console.error(`  FAIL  ${name}\n        ${error.message}`)
    })
}

/* ---------------------------------------------------------------- tests */

console.log('\ndsh-session-manager — host contract\n')

await check('lists every persisted session plus registry-only ids', async () => {
  const state = await plugin.collectState(host)
  const ids = state.sessions.map((session) => session.id)
  assert.equal(state.sessions.length, 4, `expected 4 sessions, got ${state.sessions.length}`)
  for (const id of [SESSION_A, SESSION_B, SESSION_LIVE, SESSION_ORPHAN]) assert.ok(ids.includes(id), `missing ${id}`)
})

await check('newest-first ordering', async () => {
  const state = await plugin.collectState(host)
  const ordered = state.sessions.filter((s) => s.createdAt)
  for (let i = 1; i < ordered.length; i += 1) {
    assert.ok(ordered[i - 1].createdAt >= ordered[i].createdAt, 'sessions are not newest-first')
  }
})

await check('titles, archive and pin flags come from the host', async () => {
  const state = await plugin.collectState(host)
  const a = state.sessions.find((s) => s.id === SESSION_A)
  const b = state.sessions.find((s) => s.id === SESSION_B)
  assert.match(a.title, /^Title of /)
  assert.equal(a.pinned, true, 'A should be pinned')
  assert.equal(b.archived, true, 'B should be archived')
  assert.equal(a.archived, false)
})

await check('workspace mapping and byte sizes', async () => {
  const state = await plugin.collectState(host)
  const a = state.sessions.find((s) => s.id === SESSION_A)
  assert.equal(a.workspaceTitle, 'Demo')
  assert.equal(a.bytes, 2048, `expected 2048 bytes, got ${a.bytes}`)
  assert.equal(a.onDisk, true)
  assert.equal(state.totals.bytes, 2048 + 1024 + 512 + 4096)
  assert.equal(state.totals.archived, 1)
  assert.equal(state.totals.pinned, 1)
  assert.equal(state.totals.live, 1)
})

await check('an unreferenced leftover on disk is still listed', async () => {
  const state = await plugin.collectState(host)
  const orphan = state.sessions.find((s) => s.id === SESSION_ORPHAN)
  assert.ok(orphan, 'orphaned session directory was not listed')
  assert.equal(orphan.onDisk, true)
  assert.equal(orphan.bytes, 4096)
  assert.equal(orphan.workspaceId, null)
})

await check('deleting a leftover removes it from disk', async () => {
  const result = await plugin.performAction(host, 'delete', [SESSION_ORPHAN], {})
  assert.equal(result[0].ok, true, `delete failed: ${result[0].error}`)
  assert.equal(fs.existsSync(dirOrphan), false, 'orphan directory still exists')
})

await check('deleting a session removes its files and projection cache', async () => {
  const result = await plugin.performAction(host, 'delete', [SESSION_A], {})
  assert.equal(result[0].ok, true, `delete failed: ${result[0].error}`)
  assert.equal(fs.existsSync(dirA), false, 'session directory still exists')
  assert.equal(fs.existsSync(path.join(cacheDir, `${SESSION_A}.json`)), false, 'projection cache still exists')
})

await check('deleting reconciles the workspace registry', async () => {
  const after = JSON.parse(await fsp.readFile(path.join(storageDir, 'workspace.json'), 'utf8'))
  assert.equal(after.global.pinnedSessionIds.includes(SESSION_A), false, 'id still pinned')
  assert.equal(after.global.archivedSessionIds.includes(SESSION_A), false, 'id still archived')
  assert.equal(after.tables.workspaces['ws-1'].sessionIds.includes(SESSION_A), false, 'id still in workspace')
})

await check('archive reaches the registry with stopActivity', async () => {
  const result = await plugin.performAction(host, 'archive', [SESSION_B], {})
  assert.equal(result[0].ok, true, `archive failed: ${result[0].error}`)
  assert.equal(archiveCalls.length, 1)
  assert.equal(archiveCalls[0].id, SESSION_B)
  assert.equal(archiveCalls[0].options.stopActivity, true)
})

await check('unarchive / pin / unpin reach the registry', async () => {
  await plugin.performAction(host, 'unarchive', [SESSION_B], {})
  await plugin.performAction(host, 'pin', [SESSION_B], {})
  await plugin.performAction(host, 'unpin', [SESSION_B], {})
  assert.deepEqual(unarchiveCalls, [SESSION_B])
  assert.deepEqual(pinCalls, [SESSION_B])
  assert.deepEqual(unpinCalls, [SESSION_B])
})

await check('a live session cannot be deleted', async () => {
  const result = await plugin.performAction(host, 'delete', [SESSION_LIVE], {})
  assert.equal(result[0].ok, false, 'live session deletion should fail')
  assert.match(result[0].error, /running/i)
  assert.equal(fs.existsSync(dirLive), true, 'live session files must survive')
})

await check('bulk actions isolate per-session failures', async () => {
  const result = await plugin.performAction(host, 'delete', [SESSION_B, SESSION_LIVE], {})
  assert.equal(result.length, 2)
  assert.equal(result[0].ok, true, `B should delete: ${result[0].error}`)
  assert.equal(result[1].ok, false, 'live session should be refused')
  assert.equal(fs.existsSync(dirB), false)
  assert.equal(fs.existsSync(dirLive), true)
})

await check('registry references survive a failed (live) delete', async () => {
  const after = JSON.parse(await fsp.readFile(path.join(storageDir, 'workspace.json'), 'utf8'))
  assert.equal(after.tables.workspaces['ws-1'].sessionIds.includes(SESSION_LIVE), true)
})

await check('deleting an unknown id is reported, not thrown', async () => {
  const result = await plugin.performAction(host, 'delete', ['session-does-not-exist'], {})
  assert.equal(result[0].ok, true, 'unknown-id delete should be a no-op success')
})

await check('state still renders with no registry and no sessionQuery', async () => {
  await fsp.rm(path.join(storageDir, 'workspace.json'), { force: true })
  const bare = { get: () => undefined }
  const state = await plugin.collectState(bare)
  assert.ok(Array.isArray(state.sessions))
  assert.equal(state.totals.count, state.sessions.length)
})

/* --------------------------------------------------------------- report */

await fsp.rm(home, { recursive: true, force: true })

console.log('')
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed\n`)
  process.exitCode = 1
} else {
  console.log(`${passed} checks passed — host contract verified\n`)
}
