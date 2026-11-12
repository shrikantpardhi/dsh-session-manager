# dsh-session-manager

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin that adds a **Sessions**
page to Settings, where you can **archive**, **pin** and **permanently delete**
chat sessions — one at a time or in bulk — and see how much disk space they
occupy.

DeepSeek Harness has no delete-session command. This plugin adds one.

> **Screenshot:** the Sessions page lives in **Settings → Sessions**. Add a
> screenshot at `docs/screenshot.png` to render it here; until then this line
> stands in for it.

## What you get

| Capability | What it does |
|---|---|
| **Archive / unarchive** | Hides a chat from the sidebar without deleting it. Uses the harness's own archive ordering and events. |
| **Pin / unpin** | Keeps a chat at the top of its list. |
| **Delete** | Removes the session's stored log and projection cache from disk, then reconciles the workspace registry. **Irreversible.** |
| **Bulk actions** | Select any number of rows and archive, pin or delete them together. One failure does not abort the rest. |
| **Filters and search** | `All`, `Active`, `Archived`, `Pinned`, plus search over title, workspace, working directory and session id. |
| **Disk usage** | Total size, per-session size, and how many bytes a pending delete will reclaim. |
| **Leftover cleanup** | Lists session folders that exist on disk but are unreferenced by the registry, so they can be reclaimed. |
| **Agent tool** | A `session_manager` tool exposes the same operations to an agent, with `confirm=true` required for delete. |

## Requirements

| | |
|---|---|
| DeepSeek Harness | a version that ships the `settings.section` slot and the `dsh.client` bundle contract |
| Node.js | `^22.19.0` or `>=24` |
| Profile | the desktop or web profile — a UI plugin needs the web shell |

## Install

Installing a plugin is a profile change: it applies to every session in that
profile and survives restarts.

### From a local checkout (recommended for development)

```bash
git clone https://github.com/shrikantpardhi/dsh-session-manager.git
cd dsh-session-manager
```

Then, in a Harness session, install the bundle by absolute path:

```text
plugin_manager
  action:  install_bundle
  target:  <absolute path to dsh-session-manager>
```

`install_bundle` performs the package installation and bundle selection for
you. **Do not** hand-edit the profile's `package.json` or `cordis.patch.yml`,
and do not run a package manager inside the profile directory — the installer
owns those files, and manual edits can desynchronise the bundle from its rows.

### From npm

```bash
npm install --global dsh-session-manager
```

Then install that directory as a bundle with `install_bundle`, pointing
`target` at it.

### After installing

**Restart the host.** The host half's routes and the client half's bundle entry
are both composed at boot, so an already-running host will not serve the page
even though the package is on disk. Then open **Settings → Sessions**.

To confirm the host half is live before restarting, the plugin serves:

```text
GET /dsh-session-manager/api/health
→ {"ok":true,"plugin":"dsh-session-manager","version":"1.0.0"}
```

### Uninstall

```text
plugin_manager
  action:  remove_bundle
  target:  dsh-session-manager
```

Your sessions are untouched; only the page and the tool disappear.

## How deletion works, and why it is careful

Archive and pin delegate to the harness's `workspaceRegistry`, so the harness
keeps owning ordering, events and `workspace.json`. Deletion is the only
hand-rolled path, because **the harness exposes no delete API** — its session
persistence service offers only `create`, `open`, `flush`, `stat` and `list`.

Deleting therefore has to do three things safely:

1. **Refuse a running session.** A live agent holds that session's append-only
   log open; deleting it would corrupt an in-flight conversation. The row's
   delete control is disabled and the server rejects the request.
2. **Require explicit confirmation.** The HTTP action requires `confirm: true`,
   and the UI asks before sending. The dialog states the session count and the
   bytes that will be freed.
3. **Reconcile the registry.** After removing the files, the id is stripped
   from `global.archivedSessionIds`, `global.pinnedSessionIds` and the owning
   workspace's `sessionIds`. The registry is written atomically (temp file then
   rename), so a crash mid-write cannot truncate it.

Bulk deletion is isolated per session: one failure is reported while the rest
proceed.

### What deletion does not do

- It does **not** delete forked sessions. A fork is an independent log; removing
  a parent leaves its forks in place.
- It does **not** touch anything outside the session's own directory and its
  projection-cache entries.
- There is **no trash and no undo**. Archive first if you are unsure.

## Where your data lives

Everything the page reads and writes stays under `$DSH_HOME` (usually `~/.dsh`):

```text
$DSH_HOME/
├── sessions/<cwd-slug>/<session-id>/session.v4.jsonl.zstd   # the session log
└── storages/
    ├── workspace.json                                       # archived / pinned / membership
    └── session_projcache/                                   # derived projection cache
```

The projection cache is derived data and is removed with the session.

## Security

- **No network access.** The plugin makes no outbound requests; the browser half
  only calls this plugin's own endpoints.
- **Same-origin only.** Endpoints are registered under
  `/dsh-session-manager/api` and are called with `credentials: 'same-origin'`.
- **Local file access only**, limited to the session and registry paths above.
- **No dependencies.** Nothing is bundled, minified or fetched at runtime, so
  there is no supply chain beyond Node itself.

## Architecture

Two halves, one package:

| Half | File | Role |
|---|---|---|
| Host | `index.js` | Registers three HTTP routes and the `session_manager` tool. Reads the filesystem and the workspace registry. |
| Client | `client.js` | Registers the `settings.section` slot. Renders the page with React resolved from the host's own module table. |

The client half is authored directly in the module-loader format the harness
expects — a `window.__ModuleLoader__.load({ id, factory })` wrapper whose
factory receives `require`. **There is no build step:** what you read is what
runs.

Routes:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/dsh-session-manager/api/state` | Sessions, totals, flags |
| `POST` | `/dsh-session-manager/api/action` | `{ action, sessionIds, confirm? }` |
| `GET` | `/dsh-session-manager/api/health` | Liveness and version |

Design notes:

- **The page and the tool share one code path** (`performAction`), so the two
  callers cannot drift apart.
- **Styling uses only `--dsw-alias-*` theme tokens**, so it follows light and
  dark themes and survives token renames.
- **No harness client package is imported** — only `react` from the module table.
- **`apply` never throws.** A failed mount loses the page, never the application.

## Development

```bash
npm run check     # syntax + manifest validation + both test suites
npm test          # 15 host checks + 10 client checks
npm run validate  # manifest is publishable
```

The test suites are dependency-free (plain assertions, no framework) and use a
temporary `$DSH_HOME`, so they never touch real sessions.

`npm run validate` enforces the publishing contract: a resolvable
`exports["./client"]`, a complete `files` list, locale metadata, and an icon
within size limits. CI runs it on Node 22 and 24 across Linux and Windows.

## Contributing

Issues and pull requests are welcome. Please run `npm run check` before opening
a PR. A screenshot of the Sessions page in light and dark themes, on your
platform, is a genuinely useful contribution.

## License

[MIT](LICENSE) © Shrikant Pardhi

Not affiliated with DeepSeek. DeepSeek Harness is a product of DeepSeek.
