/**
 * dsh-session-manager — host half.
 *
 * DeepSeek Harness ships archive/pin for sessions but no way to permanently
 * remove one, and no single page that shows what is taking up room. This
 * plugin adds both: a small JSON API here, and a Settings page in `client.js`
 * that drives it.
 *
 * Design notes
 * ------------
 * - Archive / unarchive / pin / unpin go through the host's own
 *   `workspaceRegistry` service, so ordering, events and the persisted
 *   `workspace.json` stay owned by DSH. Never hand-edited from here.
 * - There is NO delete API in DSH (checked against the live Service catalog:
 *   `sessionPersistence` exposes create/open/flush/stat/list only). Permanent
 *   deletion therefore removes the session's persisted files and then
 *   reconciles the workspace registry so the deleted id cannot linger as a
 *   dangling reference. A live session is refused, because removing files
 *   from under a running Agent corrupts the log it is appending to.
 * - Routes are exact registrations on the bare `webServer`, the same shape
 *   `dshmarket` uses. They sit outside the `/api` fence deliberately: the
 *   page is same-origin, and an exact path never collides with the fence.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-session-manager'
export const inject = []

const LOG = '[dsh-session-manager]'
const ROUTE_BASE = '/dsh-session-manager/api'
const MAX_BODY_BYTES = 1024 * 1024

/* ------------------------------------------------------------------ paths */

/** The DSH home directory this process is using. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), '.dsh')
}

/** Root of the persisted session corpus: `<home>/sessions/<cwd-slug>/<id>/`. */
export function sessionsRoot() {
  return path.join(dshHome(), 'sessions')
}

/** The durable workspace registry (workspaces, archived and pinned ids). */
export function registryPath() {
  return path.join(dshHome(), 'storages', 'workspace.json')
}

/** Projection caches keyed by session id, removed alongside a session. */
export function projectionCacheRoot() {
  return path.join(dshHome(), 'storages', 'session_projcache')
}

/* --------------------------------------------------------------- registry */

/**
 * Read the workspace registry.
 *
 * Returns `null` rather than throwing: the page must still render (and still
 * list sessions) on a fresh profile that has never written one.
 */
export function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(registryPath(), 'utf8'))
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      console.warn(LOG, 'could not read workspace registry:', messageOf(error))
    }
    return null
  }
}

/**
 * Write the registry atomically (temp file + rename), so a failed or partial
 * write can never leave the host's own bookkeeping truncated.
 */
export function writeRegistry(registry) {
  const target = registryPath()
  const temp = `${target}.session-manager.tmp`
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
    fs.renameSync(temp, target)
    return true
  } catch (error) {
    console.warn(LOG, 'could not write workspace registry:', messageOf(error))
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      /* the temp file is best-effort cleanup */
    }
    return false
  }
}

/**
 * Drop one session id from every registry list that can reference it.
 *
 * Without this a deleted session leaves an id in `archivedSessionIds` or in a
 * workspace's `sessionIds`, which surfaces later as a session that cannot be
 * opened.
 */
export function reconcileRegistry(sessionId) {
  const registry = readRegistry()
  if (!registry) return false
  let changed = false

  if (!registry.global) registry.global = {}
  for (const key of ['archivedSessionIds', 'pinnedSessionIds']) {
    const list = registry.global[key]
    if (!Array.isArray(list)) continue
    const next = list.filter((value) => value !== sessionId)
    if (next.length !== list.length) {
      registry.global[key] = next
      changed = true
    }
  }

  const workspaces = registry.tables && registry.tables.workspaces
  if (workspaces && typeof workspaces === 'object') {
    for (const workspace of Object.values(workspaces)) {
      if (!workspace || !Array.isArray(workspace.sessionIds)) continue
      const next = workspace.sessionIds.filter((value) => value !== sessionId)
      if (next.length !== workspace.sessionIds.length) {
        workspace.sessionIds = next
        changed = true
      }
    }
  }

  if (changed) writeRegistry(registry)
  return changed
}

/* ------------------------------------------------------------------ files */

/** Every name a session's on-disk entry may use (`id` and its `session-` twin). */
export function idCandidates(sessionId) {
  const bare = sessionId.replace(/^session-/, '')
  return [...new Set([sessionId, bare, `session-${bare}`])]
}

/** Recursively list a directory's regular files with their sizes. */
async function listFiles(dir) {
  const files = []
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFiles(target)))
    } else if (entry.isFile()) {
      try {
        const stat = await fsp.stat(target)
        files.push({ path: target, bytes: stat.size })
      } catch {
        /* a file that vanished between readdir and stat is simply absent */
      }
    }
  }
  return files
}

/**
 * Index `<sessions>/<cwd-slug>/<session-id>/` by session id.
 *
 * The corpus is one directory per workspace-slug, one directory per session,
 * so a single level of nesting is enough to find every candidate.
 */
export async function indexSessions() {
  const index = new Map()
  let groups
  try {
    groups = await fsp.readdir(sessionsRoot(), { withFileTypes: true })
  } catch {
    return index
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue
    const groupDir = path.join(sessionsRoot(), group.name)
    let entries
    try {
      entries = await fsp.readdir(groupDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(groupDir, entry.name)
      index.set(entry.name, { dir, groupDir, group: group.name, files: await listFiles(dir) })
    }
  }
  return index
}

/** Locate one session's files, trying both spellings of its id. */
export function locate(sessionId, index) {
  for (const candidate of idCandidates(sessionId)) {
    const entry = index.get(candidate)
    if (!entry) continue
    return {
      dir: entry.dir,
      groupDir: entry.groupDir,
      bytes: entry.files.reduce((total, file) => total + file.bytes, 0),
      fileCount: entry.files.length,
    }
  }
  return null
}

/* ------------------------------------------------------------------ state */

/** Total bytes and file count of a list of index entries. */
function entryBytes(entry) {
  return entry.files.reduce((total, file) => total + file.bytes, 0)
}

/**
 * Build the page's complete state in one pass.
 *
 * Titles come from `sessionQuery.readTitleSnapshots` (the host's own folded
 * titles, so they match the sidebar). Metadata falls back to the registry and
 * then to the directory itself, which keeps every session visible even when
 * one source is unavailable.
 */
export async function collectState(host) {
  const registry = readRegistry()
  const global = (registry && registry.global) || {}
  const archived = new Set(Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds : [])
  const pinned = new Set(Array.isArray(global.pinnedSessionIds) ? global.pinnedSessionIds : [])

  const workspaces = []
  const workspaceBySession = new Map()
  const tables = (registry && registry.tables && registry.tables.workspaces) || {}
  for (const [id, value] of Object.entries(tables)) {
    const workspace = {
      id,
      title: (value && (value.title || value.path)) || id,
      path: (value && value.path) || '',
      sessionIds: value && Array.isArray(value.sessionIds) ? value.sessionIds : [],
    }
    workspaces.push(workspace)
    for (const sessionId of workspace.sessionIds) workspaceBySession.set(sessionId, workspace)
  }

  // Live-preferred records: the authoritative list of what DSH knows about.
  const sessionQuery = host.get('sessionQuery')
  let records = []
  if (sessionQuery && typeof sessionQuery.listSessions === 'function') {
    try {
      records = await sessionQuery.listSessions()
    } catch (error) {
      warn(host, `could not list sessions: ${messageOf(error)}`)
    }
  }

  const recordById = new Map()
  const ids = []
  const seen = new Set()
  const pushId = (id) => {
    if (!id || seen.has(id)) return
    seen.add(id)
    ids.push(id)
  }
  for (const record of records) {
    const header = record && record.header
    if (!header || !header.id) continue
    recordById.set(header.id, record)
    pushId(header.id)
  }
  // Sessions the registry still references but persistence no longer reports
  // stay visible, so the user can clean them up rather than lose track.
  for (const sessionId of workspaceBySession.keys()) pushId(sessionId)
  for (const sessionId of archived) pushId(sessionId)
  for (const sessionId of pinned) pushId(sessionId)

  // Session directories on disk that nothing references any more are the whole
  // point of a cleanup page: without them a user can never reclaim that space.
  const index = await indexSessions()
  for (const sessionId of index.keys()) pushId(sessionId)

  const titles = new Map()
  if (sessionQuery && typeof sessionQuery.readTitleSnapshots === 'function' && ids.length > 0) {
    try {
      const observations = await sessionQuery.readTitleSnapshots(ids)
      for (const observation of observations) {
        if (observation && observation.status === 'fulfilled') {
          const title = observation.value && observation.value.title
          if (title && title.title) titles.set(observation.sessionId, title.title)
        }
      }
    } catch (error) {
      warn(host, `could not read titles: ${messageOf(error)}`)
    }
  }

  const sessions = ids.map((id) => {
    const record = recordById.get(id)
    const header = record ? record.header : null
    const workspace = workspaceBySession.get(id)
    const located = locate(id, index)
    return {
      id,
      title: titles.get(id) || 'Untitled session',
      cwd: (header && header.cwd) || (workspace && workspace.path) || '',
      createdAt: (header && header.createdAt) || null,
      parentSession: (header && header.parentSession) || null,
      origin: (header && header.origin) || null,
      agentPreset: (header && header.agentPreset) || null,
      workspaceId: workspace ? workspace.id : null,
      workspaceTitle: workspace ? workspace.title : null,
      archived: archived.has(id),
      pinned: pinned.has(id),
      live: Boolean(record && record.live),
      persisted: record ? Boolean(record.persisted) : Boolean(located),
      bytes: located ? located.bytes : 0,
      fileCount: located ? located.fileCount : 0,
      onDisk: Boolean(located),
    }
  })

  // Newest first; sessions with no timestamp (registry leftovers) sort last.
  sessions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))

  const totals = {
    count: sessions.length,
    archived: sessions.filter((session) => session.archived).length,
    pinned: sessions.filter((session) => session.pinned).length,
    live: sessions.filter((session) => session.live).length,
    onDisk: sessions.filter((session) => session.onDisk).length,
    bytes: sessions.reduce((sum, session) => sum + session.bytes, 0),
  }

  return { sessions, workspaces, totals, sessionsRoot: sessionsRoot(), generatedAt: Date.now() }
}

/* ---------------------------------------------------------------- actions */

/**
 * Permanently delete one session.
 *
 * Refuses a live session: its Agent still holds the append-only log open, and
 * unlinking it would corrupt the next write. Stop the session first.
 */
export async function deleteSession(host, sessionId) {
  const sessionsService = host.get('sessions')
  if (sessionsService && typeof sessionsService.get === 'function') {
    let live
    try {
      live = sessionsService.get(sessionId)
    } catch {
      live = undefined
    }
    if (live) {
      throw new Error('This session is running. Stop it before deleting.')
    }
  }

  const index = await indexSessions()
  const located = locate(sessionId, index)
  const removed = []

  if (located) {
    await fsp.rm(located.dir, { recursive: true, force: true })
    removed.push(located.dir)
  }

  // A session's projection cache is keyed by its id and is dead weight once
  // the log is gone.
  try {
    const cacheEntries = await fsp.readdir(projectionCacheRoot())
    for (const entry of cacheEntries) {
      const matches = idCandidates(sessionId).some(
        (candidate) => entry === candidate || entry.startsWith(`${candidate}.`),
      )
      if (!matches) continue
      const target = path.join(projectionCacheRoot(), entry)
      await fsp.rm(target, { recursive: true, force: true })
      removed.push(target)
    }
  } catch {
    /* no cache directory on this profile */
  }

  reconcileRegistry(sessionId)

  return { removed, onDisk: Boolean(located) }
}

/**
 * Run one action against many sessions, isolating per-session failures so a
 * single stubborn session cannot abort a bulk operation.
 */
export async function performAction(host, action, sessionIds, options = {}) {
  const registry = host.get('workspaceRegistry')
  const results = []

  for (const sessionId of sessionIds) {
    try {
      if (action === 'delete') {
        const outcome = await deleteSession(host, sessionId)
        results.push({ id: sessionId, ok: true, removed: outcome.removed })
        continue
      }

      if (!registry) throw new Error('The workspace registry service is unavailable.')

      if (action === 'archive') {
        await registry.archiveSession(sessionId, { stopActivity: options.stopActivity !== false })
      } else if (action === 'unarchive') {
        await registry.unarchiveSession(sessionId)
      } else if (action === 'pin') {
        await registry.pinSession(sessionId)
      } else if (action === 'unpin') {
        await registry.unpinSession(sessionId)
      } else {
        throw new Error(`Unknown action: ${action}`)
      }
      results.push({ id: sessionId, ok: true })
    } catch (error) {
      results.push({ id: sessionId, ok: false, error: messageOf(error) })
    }
  }

  return results
}

/* ------------------------------------------------------------------ http */

function messageOf(error) {
  if (!error) return 'unknown error'
  if (typeof error === 'string') return error
  return error.message || String(error)
}

function warn(host, message) {
  if (host.logger && typeof host.logger.warn === 'function') host.logger.warn(`${LOG} ${message}`)
  else console.warn(LOG, message)
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Length', Buffer.byteLength(body))
  response.end(body)
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large.')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  return JSON.parse(text)
}

/* ----------------------------------------------------------------- mount */

/**
 * Register this plugin's routes.
 *
 * Split out from `apply` so it can be exercised directly by tests without a
 * Cordis context.
 */
export function mount(ctx) {
  const host = {
    get(service) {
      try {
        return ctx.get(service)
      } catch {
        return undefined
      }
    },
    logger: undefined,
  }

  const webServer = host.get('webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    console.warn(LOG, 'no webServer service in this composition — the Sessions page cannot load data')
    return () => {}
  }

  const disposers = []

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${ROUTE_BASE}/state`,
    handler: async (request, response) => {
      try {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return sendJson(response, 405, { error: 'Method not allowed.' })
        }
        const state = await collectState(host)
        return sendJson(response, 200, state)
      } catch (error) {
        console.warn(LOG, 'state request failed:', messageOf(error))
        return sendJson(response, 500, { error: messageOf(error) })
      }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${ROUTE_BASE}/action`,
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') {
          return sendJson(response, 405, { error: 'Method not allowed.' })
        }
        const body = await readBody(request)
        const action = String(body.action || '')
        const sessionIds = Array.isArray(body.sessionIds)
          ? body.sessionIds.map((value) => String(value)).filter(Boolean)
          : []
        if (sessionIds.length === 0) {
          return sendJson(response, 400, { error: 'sessionIds is required.' })
        }
        if (action === 'delete' && body.confirm !== true) {
          return sendJson(response, 400, { error: 'Deleting requires confirm: true.' })
        }
        const results = await performAction(host, action, sessionIds, body)
        const failures = results.filter((result) => !result.ok)
        return sendJson(response, 200, {
          action,
          ok: failures.length === 0,
          failed: failures.length,
          results,
        })
      } catch (error) {
        console.warn(LOG, 'action request failed:', messageOf(error))
        return sendJson(response, 500, { error: messageOf(error) })
      }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${ROUTE_BASE}/health`,
    handler: (request, response) => {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' })
      return sendJson(response, 200, { ok: true, plugin: name, version: '1.0.0' })
    },
  }))

  // Diagnostic: report what the boot graph thinks of this package's client half.
  // The Settings page cannot appear until `clientModules` has composed an entry
  // for it, and that composition happens at boot — this makes the difference
  // between "restart required" and "declaration wrong" visible instead of a
  // guess. Read-only.
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${ROUTE_BASE}/diagnostics`,
    handler: (request, response) => {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' })
      try {
        const clientModules = host.get('clientModules')
        if (!clientModules || typeof clientModules.graph !== 'function') {
          return sendJson(response, 200, { clientModules: false, note: 'no clientModules service in this composition' })
        }
        const graph = clientModules.graph()
        const entries = (graph.entries || []).map((entry) => ({
          id: entry.id,
          url: entry.url,
          rev: entry.rev,
          inject: entry.inject || [],
        }))
        const mine = entries.filter((entry) => entry.id === name)
        return sendJson(response, 200, {
          clientModules: true,
          graphRev: graph.rev,
          totalEntries: entries.length,
          registered: mine.length > 0,
          entries: mine,
          clientPath: typeof clientModules.clientPath === 'function' ? clientModules.clientPath(name) || null : null,
        })
      } catch (error) {
        return sendJson(response, 500, { error: messageOf(error) })
      }
    },
  }))

  // Agent-facing face of the same operations. The Settings page and this tool
  // call `performAction`, so the two callers cannot drift apart.
  registerTool(host, disposers)

  const dispose = () => {
    for (const off of disposers) {
      try {
        if (typeof off === 'function') off()
      } catch {
        /* an already-released route is not an error */
      }
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => dispose)
  }

  console.log(LOG, `mounted at ${ROUTE_BASE}`)
  return dispose
}

/**
 * Register the agent-facing tool for these operations.
 *
 * Deletion is destructive and irreversible, so the tool requires an explicit
 * `confirm: true` and refuses live sessions — the same two guards the page
 * enforces. Listing is read-only and free of side effects.
 */
function registerTool(host, disposers) {
  const tools = host.get('tools')
  if (!tools || typeof tools.register !== 'function') return

  try {
    disposers.push(tools.register({
      name: 'session_manager',
      description:
        'List, archive, pin or permanently delete DeepSeek Harness chat sessions. '
        + 'action=list returns every session with title, workspace, size and flags. '
        + 'action=archive|unarchive|pin|unpin|delete applies to sessionIds. '
        + 'Deleting is permanent and requires confirm=true; a running session is refused.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'archive', 'unarchive', 'pin', 'unpin', 'delete'],
            description: 'Operation to perform. Use list first to discover session ids.',
          },
          sessionIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Session ids the action applies to. Required for every action except list.',
          },
          confirm: {
            type: 'boolean',
            description: 'Must be true to delete. Deleting removes the stored messages from disk.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const action = String((args && args.action) || '')
        if (action === 'list') {
          const state = await collectState(host)
          return {
            sessions: state.sessions.map((session) => ({
              id: session.id,
              title: session.title,
              bytes: session.bytes,
              archived: session.archived,
              pinned: session.pinned,
              live: session.live,
              workspace: session.workspaceTitle,
            })),
            totals: state.totals,
          }
        }

        const sessionIds = Array.isArray(args && args.sessionIds)
          ? args.sessionIds.map((value) => String(value)).filter(Boolean)
          : []
        if (sessionIds.length === 0) throw new Error('sessionIds is required for this action.')
        if (action === 'delete' && !(args && args.confirm === true)) {
          throw new Error('Deleting is permanent; pass confirm=true to proceed.')
        }

        const results = await performAction(host, action, sessionIds, args || {})
        const failures = results.filter((result) => !result.ok)
        return { action, ok: failures.length === 0, results }
      },
    }))
  } catch (error) {
    console.warn(LOG, 'could not register the session_manager tool:', messageOf(error))
  }
}

export function apply(ctx) {
  try {
    if (typeof ctx.inject === 'function') {
      // `tools` is optional: a profile without it still gets the Settings page.
      ctx.inject(['webServer'], (scoped) => {
        try {
          mount(scoped)
        } catch (error) {
          console.error(LOG, 'mount failed:', messageOf(error))
        }
      })
      return
    }
    mount(ctx)
  } catch (error) {
    // A throw here would be a throw inside the host's own bootstrap; losing
    // this page must never take the application with it.
    console.error(LOG, 'apply failed:', messageOf(error))
  }
}
