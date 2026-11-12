# Changelog

Notable changes to `dsh-session-manager`. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-11-12

First public release.

### Added

- **Settings → Sessions** page listing every stored chat session with its
  title, workspace, creation time, size on disk and running/archived/pinned
  state.
- **Archive / unarchive** a session, delegated to the host's own
  `workspaceRegistry`, so ordering, events and `workspace.json` stay owned by
  DeepSeek Harness.
- **Pin / unpin** a session.
- **Permanent delete**, which removes the session's stored log and its
  projection cache, then reconciles the workspace registry so the id cannot
  dangle. Deletion is refused for a running session.
- **Bulk actions** over any selection, with per-session failure isolation.
- **Filters** (`All`, `Active`, `Archived`, `Pinned`) and **search** across
  title, workspace, working directory and session id.
- **Disk-usage reporting**: total bytes and per-session size, plus the bytes a
  pending delete will reclaim.
- **Leftover detection**: session directories present on disk but unreferenced
  by persistence or the registry are listed so they can be reclaimed.
- **`session_manager` agent tool** exposing the same operations to an agent,
  with `confirm=true` required for delete.
- Locale dictionaries for English and Chinese, with an English fallback.
- 55 automated checks across the manifest, host and client halves.

### Notes

- Deletion is irreversible; there is no trash and no restore.
- Deleting a parent session does not delete its forks; each is an independent
  log.
