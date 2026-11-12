/**
 * dsh-session-manager — client half.
 *
 * Registers a "Sessions" page in Settings that lists every chat session and
 * lets the user archive, pin or permanently delete them, singly or in bulk.
 *
 * Packaging
 * ---------
 * This file is authored directly in the module-loader format DSH's web shell
 * expects: a factory that receives `require`, resolves React from the host's
 * own module table (so this package shares the shell's React instance) and
 * returns the plugin's exports. No build step, no bundler.
 *
 * Conventions followed deliberately (Harness plugin reference):
 * - no Harness Client package is imported — only React from the module table;
 * - styling uses only `--dsw-alias-*` theme tokens, so it tracks light/dark;
 * - visible text resolves through the locale service with an English fallback;
 * - the stylesheet is registered under `ctx.effect`, so it is removed on unload;
 * - `apply` contains everything: an incompatible host loses the page, not the app.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-manager',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const h = React.createElement

    const API_BASE = '/dsh-session-manager/api'
    const STYLE_ID = 'dsh-session-manager-styles'
    const NS = 'dsh-session-manager'

    /* ----------------------------------------------------------------- text */

    /**
     * English fallback dictionary.
     *
     * Also registered with the host locale service, so a host that has a
     * translation shows it. A missing translation falls back here rather than
     * rendering a raw key, because a settings page must never be unreadable.
     */
    const DICT_EN = {
      title: 'Sessions',
      subtitle: 'Archive a chat to tidy the sidebar, or delete it to remove its stored messages.',
      refresh: 'Refresh',
      search: 'Search title, workspace or id',
      selectAll: 'Select all',
      clear: 'Clear',
      selected: '{count} selected',
      empty: 'No sessions yet. Start a conversation and it will appear here.',
      noMatch: 'No sessions match this filter.',
      loading: 'Loading sessions\u2026',
      statSessions: 'Sessions',
      statArchived: 'Archived',
      statPinned: 'Pinned',
      statOnDisk: 'On disk',
      filterAll: 'All',
      filterOpen: 'Active',
      filterArchived: 'Archived',
      filterPinned: 'Pinned',
      archive: 'Archive',
      unarchive: 'Unarchive',
      pin: 'Pin',
      unpin: 'Unpin',
      delete: 'Delete',
      deleteAllArchived: 'Delete all archived ({count})',
      badgeLive: 'Running',
      badgeArchived: 'Archived',
      badgePinned: 'Pinned',
      badgeOrphan: 'Missing files',
      confirmTitle: 'Delete permanently?',
      confirmBody: 'This removes {target} and its stored messages from disk. Archiving keeps a chat; deleting cannot be undone.',
      confirmOne: 'this session',
      confirmMany: 'these {count} sessions',
      confirmDetail: 'About {size} will be freed.',
      cancel: 'Cancel',
      confirmDelete: 'Delete permanently',
      errorLoad: 'Could not load sessions: {error}',
      errorFailed: '{action} failed for {failed} of {total}: {error}',
      errorLiveBlocked: 'One of the selected sessions is running. Stop it before deleting.',
      doneArchive: 'Archived {count} session(s).',
      doneUnarchive: 'Unarchived {count} session(s).',
      donePin: 'Pinned {count} session(s).',
      doneUnpin: 'Unpinned {count} session(s).',
      doneDelete: 'Deleted {count} session(s). Removed from disk.',
      doneGeneric: 'Updated {count} session(s).',
    }

    const DICT_ZH = {
      title: '会话',
      subtitle: '归档可整理侧边栏，删除将移除已保存的消息。',
      refresh: '刷新',
      search: '搜索标题、工作区或 ID',
      selectAll: '全选',
      clear: '清除',
      selected: '已选择 {count} 项',
      empty: '还没有会话。开始对话后会显示在这里。',
      noMatch: '没有符合筛选条件的会话。',
      loading: '正在加载会话…',
      statSessions: '会话',
      statArchived: '已归档',
      statPinned: '已置顶',
      statOnDisk: '磁盘占用',
      filterAll: '全部',
      filterOpen: '进行中',
      filterArchived: '已归档',
      filterPinned: '已置顶',
      archive: '归档',
      unarchive: '取消归档',
      pin: '置顶',
      unpin: '取消置顶',
      delete: '删除',
      deleteAllArchived: '删除全部已归档（{count}）',
      badgeLive: '运行中',
      badgeArchived: '已归档',
      badgePinned: '已置顶',
      badgeOrphan: '文件缺失',
      confirmTitle: '永久删除？',
      confirmBody: '这会从磁盘移除{target}及其已保存的消息。归档只隐藏会话，删除无法撤销。',
      confirmOne: '该会话',
      confirmMany: '这 {count} 个会话',
      confirmDetail: '约可释放 {size}。',
      cancel: '取消',
      confirmDelete: '永久删除',
      errorLoad: '无法加载会话：{error}',
      errorFailed: '{action} 失败：{total} 个中有 {failed} 个，{error}',
      errorLiveBlocked: '所选会话中有正在运行的会话，请先停止再删除。',
      doneArchive: '已归档 {count} 个会话。',
      doneUnarchive: '已取消归档 {count} 个会话。',
      donePin: '已置顶 {count} 个会话。',
      doneUnpin: '已取消置顶 {count} 个会话。',
      doneDelete: '已删除 {count} 个会话，并从磁盘移除。',
      doneGeneric: '已更新 {count} 个会话。',
    }

    /** Substitute `{name}` placeholders. */
    function fill(template, values) {
      if (!values) return template
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match))
    }

    /**
     * Build a translator bound to the host locale service when one exists.
     *
     * `bound(key)` is preferred because it follows the user's live locale
     * switch; the local dictionary is the fallback for both a missing service
     * and a missing entry.
     */
    function makeTranslator(ctx) {
      let bound = null
      try {
        const locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        if (locale && typeof locale.register === 'function') {
          try { locale.register(NS, 'en', DICT_EN) } catch { /* older locale service */ }
          try { locale.register(NS, 'zh', DICT_ZH) } catch { /* older locale service */ }
        }
        if (locale && typeof locale.bind === 'function') bound = locale.bind(NS)
      } catch {
        bound = null
      }
      return (key, values) => {
        let text = null
        if (bound) {
          try {
            const translated = bound(key)
            if (typeof translated === 'string' && translated.length > 0 && translated !== key) text = translated
          } catch {
            text = null
          }
        }
        if (text === null) text = DICT_EN[key] || key
        return fill(text, values)
      }
    }

    /* --------------------------------------------------------------- styles */

    const CSS = `
.dsm-root {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 2px 24px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
  max-width: 100%;
  box-sizing: border-box;
}
.dsm-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.dsm-title { font-size: 17px; font-weight: 600; letter-spacing: -0.01em; margin: 0; }
.dsm-sub { color: var(--dsw-alias-label-secondary); margin: 2px 0 0; font-size: 12.5px; }
.dsm-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(112px, 1fr)); gap: 8px; }
.dsm-stat {
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 10px;
  padding: 10px 12px;
  display: flex; flex-direction: column; gap: 2px;
}
.dsm-stat-value { font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dsm-stat-label { color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.dsm-card {
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 12px;
  overflow: hidden;
}
.dsm-toolbar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 10px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dsm-tabs { display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
.dsm-tab {
  border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12.5px; padding: 4px 10px; border-radius: 6px; cursor: pointer;
  white-space: nowrap;
}
.dsm-tab:hover { color: var(--dsw-alias-label-primary); }
.dsm-tab[data-active='true'] {
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); font-weight: 500;
}
.dsm-search {
  flex: 1 1 180px; min-width: 140px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  border-radius: 8px; padding: 5px 9px; font: inherit; font-size: 12.5px; outline: none;
}
.dsm-search:focus { border-color: var(--dsw-alias-brand-primary); }
.dsm-btn {
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12.5px; padding: 5px 11px; border-radius: 8px;
  cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 5px;
}
.dsm-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dsm-btn:disabled { opacity: 0.45; cursor: default; }
.dsm-btn[data-variant='danger'] {
  color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-primary);
  background: transparent;
}
.dsm-btn[data-variant='danger']:hover:not(:disabled) {
  background: var(--dsw-alias-state-error-primary); color: #fff;
}
.dsm-btn[data-variant='dangerSolid'] {
  background: var(--dsw-alias-state-error-primary); border-color: transparent; color: #fff; font-weight: 500;
}
.dsm-row-action {
  border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; padding: 3px 7px; border-radius: 6px; cursor: pointer;
}
.dsm-row-action:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsm-row-action:disabled { opacity: 0.4; cursor: default; }
.dsm-row-action[data-danger='true']:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary); }
.dsm-list { display: flex; flex-direction: column; max-height: 46vh; overflow-y: auto; }
.dsm-row {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  cursor: default;
}
.dsm-row:last-child { border-bottom: 0; }
.dsm-row:hover { background: var(--dsw-alias-bg-layer-2); }
.dsm-row[data-selected='true'] { background: var(--dsw-alias-bg-layer-2); }
.dsm-check { accent-color: var(--dsw-alias-brand-primary); width: 14px; height: 14px; flex: none; cursor: pointer; }
.dsm-main { min-width: 0; flex: 1 1 auto; display: flex; flex-direction: column; gap: 1px; }
.dsm-name { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsm-meta {
  font-size: 11.5px; color: var(--dsw-alias-label-secondary);
  display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
}
.dsm-meta > span { white-space: nowrap; }
.dsm-dot { opacity: 0.45; }
.dsm-badge {
  font-size: 10.5px; padding: 1px 6px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary); white-space: nowrap; line-height: 1.6;
}
.dsm-badge[data-tone='live'] { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.dsm-badge[data-tone='archived'] { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.dsm-badge[data-tone='pinned'] { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.dsm-badge[data-tone='orphan'] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dsm-actions { display: flex; align-items: center; gap: 2px; flex: none; }
.dsm-bulk {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 12px; background: var(--dsw-alias-bg-layer-2);
  border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 12.5px;
}
.dsm-bulk-count { font-weight: 600; margin-right: 2px; }
.dsm-empty { padding: 28px 16px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 12.5px; }
.dsm-banner {
  border-radius: 9px; padding: 8px 11px; font-size: 12.5px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2);
}
.dsm-banner[data-tone='error'] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dsm-banner[data-tone='ok'] { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.dsm-overlay {
  position: fixed; inset: 0; z-index: 2147483000;
  background: rgba(0, 0, 0, 0.45);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.dsm-dialog {
  width: 100%; max-width: 420px;
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 14px; padding: 18px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
  display: flex; flex-direction: column; gap: 10px;
}
.dsm-dialog h3 { margin: 0; font-size: 15px; font-weight: 600; }
.dsm-dialog p { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12.5px; }
.dsm-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.dsm-spin {
  width: 13px; height: 13px; border-radius: 50%;
  border: 2px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-brand-primary);
  animation: dsm-rotate 0.7s linear infinite; display: inline-block;
}
@keyframes dsm-rotate { to { transform: rotate(360deg); } }
`

    /**
     * Insert the stylesheet once and hand back its removal.
     *
     * Called from `apply` under `ctx.effect`, so unloading the plugin takes the
     * styles with it instead of leaving dead CSS in the document.
     */
    function insertStyles() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.getElementById(STYLE_ID)
      if (existing) return () => {}
      const element = document.createElement('style')
      element.id = STYLE_ID
      element.textContent = CSS
      document.head.appendChild(element)
      return () => {
        try {
          element.remove()
        } catch {
          /* already detached */
        }
      }
    }

    /* ---------------------------------------------------------------- utils */

    function formatBytes(bytes) {
      if (!bytes || bytes <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB']
      let value = bytes
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
    }

    function formatDate(value) {
      if (!value) return '\u2014'
      try {
        return new Date(value).toLocaleString(undefined, {
          year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        })
      } catch {
        return new Date(value).toISOString()
      }
    }

    function shortId(id) {
      return String(id).replace(/^session-/, '').slice(0, 8)
    }

    async function requestJson(url, init) {
      const response = await fetch(url, {
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        ...init,
      })
      const text = await response.text()
      let payload = null
      if (text) {
        try {
          payload = JSON.parse(text)
        } catch {
          payload = { error: text }
        }
      }
      if (!response.ok) throw new Error((payload && payload.error) || `Request failed (${response.status})`)
      return payload
    }

    const fetchState = () => requestJson(`${API_BASE}/state`, { method: 'GET' })
    const postAction = (body) => requestJson(`${API_BASE}/action`, { method: 'POST', body: JSON.stringify(body) })

    /* ----------------------------------------------------------- components */

    function Badge(props) {
      return h('span', { className: 'dsm-badge', 'data-tone': props.tone || 'default' }, props.children)
    }

    function Stat(props) {
      return h('div', { className: 'dsm-stat' },
        h('span', { className: 'dsm-stat-value' }, props.value),
        h('span', { className: 'dsm-stat-label' }, props.label))
    }

    function SessionRow(props) {
      const { session, selected, busy, t } = props
      return h('div', { className: 'dsm-row', 'data-selected': selected ? 'true' : 'false' },
        h('input', {
          className: 'dsm-check',
          type: 'checkbox',
          checked: selected,
          disabled: busy,
          'aria-label': `${session.title}`,
          onChange: () => props.onToggle(session.id),
        }),
        h('div', { className: 'dsm-main' },
          h('div', { className: 'dsm-name', title: session.title }, session.title),
          h('div', { className: 'dsm-meta' },
            session.live ? h(Badge, { tone: 'live' }, t('badgeLive')) : null,
            session.archived ? h(Badge, { tone: 'archived' }, t('badgeArchived')) : null,
            session.pinned ? h(Badge, { tone: 'pinned' }, t('badgePinned')) : null,
            !session.onDisk ? h(Badge, { tone: 'orphan' }, t('badgeOrphan')) : null,
            h('span', null, formatDate(session.createdAt)),
            session.workspaceTitle ? h('span', { className: 'dsm-dot' }, '\u00b7') : null,
            session.workspaceTitle ? h('span', null, session.workspaceTitle) : null,
            h('span', { className: 'dsm-dot' }, '\u00b7'),
            h('span', null, formatBytes(session.bytes)),
            h('span', { className: 'dsm-dot' }, '\u00b7'),
            h('span', { title: session.id }, shortId(session.id)))),
        h('div', { className: 'dsm-actions' },
          session.archived
            ? h('button', { type: 'button', className: 'dsm-row-action', disabled: busy, onClick: () => props.onAction('unarchive', [session.id]) }, t('unarchive'))
            : h('button', {
                type: 'button',
                className: 'dsm-row-action',
                disabled: busy || session.live,
                title: session.live ? t('badgeLive') : undefined,
                onClick: () => props.onAction('archive', [session.id]),
              }, t('archive')),
          session.pinned
            ? h('button', { type: 'button', className: 'dsm-row-action', disabled: busy, onClick: () => props.onAction('unpin', [session.id]) }, t('unpin'))
            : h('button', { type: 'button', className: 'dsm-row-action', disabled: busy, onClick: () => props.onAction('pin', [session.id]) }, t('pin')),
          h('button', {
            type: 'button',
            className: 'dsm-row-action',
            'data-danger': 'true',
            disabled: busy || session.live,
            title: session.live ? t('badgeLive') : t('delete'),
            onClick: () => props.onRequestDelete([session.id]),
          }, t('delete'))))
    }

    function ConfirmDelete(props) {
      const { ids, detail, t } = props
      const count = ids.length
      const target = count === 1 ? t('confirmOne') : t('confirmMany', { count })
      return h('div', {
        className: 'dsm-overlay',
        role: 'presentation',
        onClick: (event) => { if (event.target === event.currentTarget) props.onCancel() },
      },
        h('div', { className: 'dsm-dialog', role: 'dialog', 'aria-modal': 'true' },
          h('h3', null, t('confirmTitle')),
          h('p', null, t('confirmBody', { target })),
          detail ? h('p', null, detail) : null,
          h('div', { className: 'dsm-dialog-actions' },
            h('button', { type: 'button', className: 'dsm-btn', onClick: props.onCancel }, t('cancel')),
            h('button', { type: 'button', className: 'dsm-btn', 'data-variant': 'dangerSolid', onClick: props.onConfirm }, t('confirmDelete')))))
    }

    /* ---------------------------------------------------------------- page */

    function SessionManagerSection(props) {
      const t = props && typeof props.t === 'function' ? props.t : (key) => DICT_EN[key] || key

      const [state, setState] = React.useState({ status: 'loading', data: null, error: null })
      const [tab, setTab] = React.useState('all')
      const [query, setQuery] = React.useState('')
      const [selected, setSelected] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [pendingDelete, setPendingDelete] = React.useState(null)

      const load = React.useCallback(async (opts) => {
        if (!opts || opts.spinner !== false) setState((prev) => ({ status: 'loading', data: prev.data, error: null }))
        try {
          const data = await fetchState()
          setState({ status: 'ready', data, error: null })
        } catch (error) {
          setState({ status: 'error', data: null, error: error.message || String(error) })
        }
      }, [])

      React.useEffect(() => { load() }, [load])

      const sessions = (state.data && state.data.sessions) || []
      const totals = (state.data && state.data.totals) || { count: 0, archived: 0, pinned: 0, live: 0, bytes: 0 }

      const visible = React.useMemo(() => {
        const needle = query.trim().toLowerCase()
        return sessions.filter((session) => {
          if (tab === 'archived' && !session.archived) return false
          if (tab === 'pinned' && !session.pinned) return false
          if (tab === 'open' && session.archived) return false
          if (!needle) return true
          return session.title.toLowerCase().includes(needle)
            || session.id.toLowerCase().includes(needle)
            || (session.workspaceTitle || '').toLowerCase().includes(needle)
            || (session.cwd || '').toLowerCase().includes(needle)
        })
      }, [sessions, tab, query])

      const selectedSet = React.useMemo(() => new Set(selected), [selected])

      const toggle = (id) => {
        setSelected((prev) => (prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]))
      }

      const toggleAll = () => {
        const ids = visible.map((session) => session.id)
        const all = ids.length > 0 && ids.every((id) => selectedSet.has(id))
        setSelected(all ? [] : ids)
      }

      const doneKey = {
        archive: 'doneArchive',
        unarchive: 'doneUnarchive',
        pin: 'donePin',
        unpin: 'doneUnpin',
        delete: 'doneDelete',
      }

      const runAction = async (action, ids) => {
        if (!ids || ids.length === 0) return
        setBusy(true)
        setNotice(null)
        try {
          const payload = await postAction({ action, sessionIds: ids, confirm: action === 'delete' })
          const failed = (payload.results || []).filter((result) => !result.ok)
          if (failed.length === 0) {
            setNotice({ tone: 'ok', text: t(doneKey[action] || 'doneGeneric', { count: ids.length }) })
            setSelected([])
          } else {
            setNotice({
              tone: 'error',
              text: t('errorFailed', {
                action: t(action),
                failed: failed.length,
                total: ids.length,
                error: failed[0].error || 'unknown error',
              }),
            })
          }
          await load({ spinner: false })
        } catch (error) {
          setNotice({ tone: 'error', text: error.message || String(error) })
        } finally {
          setBusy(false)
        }
      }

      const requestDelete = (ids) => {
        const targets = sessions.filter((session) => ids.includes(session.id))
        if (targets.some((session) => session.live)) {
          setNotice({ tone: 'error', text: t('errorLiveBlocked') })
          return
        }
        const bytes = targets.reduce((sum, session) => sum + (session.bytes || 0), 0)
        setPendingDelete({ ids, detail: bytes > 0 ? t('confirmDetail', { size: formatBytes(bytes) }) : null })
      }

      const confirmDelete = async () => {
        const ids = pendingDelete ? pendingDelete.ids : []
        setPendingDelete(null)
        await runAction('delete', ids)
      }

      const archivedIds = sessions.filter((session) => session.archived && !session.live).map((session) => session.id)
      const filters = [
        ['all', `${t('filterAll')}${totals.count ? ` (${totals.count})` : ''}`],
        ['open', t('filterOpen')],
        ['archived', `${t('filterArchived')}${totals.archived ? ` (${totals.archived})` : ''}`],
        ['pinned', t('filterPinned')],
      ]

      return h('div', { className: 'dsm-root' },
        h('div', { className: 'dsm-head' },
          h('div', null,
            h('h2', { className: 'dsm-title' }, t('title')),
            h('p', { className: 'dsm-sub' }, t('subtitle'))),
          h('button', { type: 'button', className: 'dsm-btn', disabled: busy, onClick: () => load() },
            busy ? h('span', { className: 'dsm-spin' }) : null,
            t('refresh'))),

        h('div', { className: 'dsm-stats' },
          h(Stat, { label: t('statSessions'), value: totals.count }),
          h(Stat, { label: t('statArchived'), value: totals.archived }),
          h(Stat, { label: t('statPinned'), value: totals.pinned }),
          h(Stat, { label: t('statOnDisk'), value: formatBytes(totals.bytes) })),

        notice ? h('div', { className: 'dsm-banner', 'data-tone': notice.tone }, notice.text) : null,
        state.status === 'error'
          ? h('div', { className: 'dsm-banner', 'data-tone': 'error' }, t('errorLoad', { error: state.error }))
          : null,

        h('div', { className: 'dsm-card' },
          h('div', { className: 'dsm-toolbar' },
            h('div', { className: 'dsm-tabs', role: 'tablist' },
              ...filters.map(([key, label]) => h('button', {
                key,
                type: 'button',
                role: 'tab',
                className: 'dsm-tab',
                'data-active': tab === key ? 'true' : 'false',
                'aria-selected': tab === key ? 'true' : 'false',
                onClick: () => setTab(key),
              }, label))),
            h('input', {
              className: 'dsm-search',
              type: 'search',
              placeholder: t('search'),
              value: query,
              onChange: (event) => setQuery(event.target.value),
              'aria-label': t('search'),
            }),
            h('button', { type: 'button', className: 'dsm-btn', disabled: busy || visible.length === 0, onClick: toggleAll },
              visible.length > 0 && visible.every((session) => selectedSet.has(session.id)) ? t('clear') : t('selectAll'))),

          selected.length > 0
            ? h('div', { className: 'dsm-bulk' },
                h('span', { className: 'dsm-bulk-count' }, t('selected', { count: selected.length })),
                h('button', { type: 'button', className: 'dsm-btn', disabled: busy, onClick: () => runAction('archive', selected) }, t('archive')),
                h('button', { type: 'button', className: 'dsm-btn', disabled: busy, onClick: () => runAction('unarchive', selected) }, t('unarchive')),
                h('button', { type: 'button', className: 'dsm-btn', disabled: busy, onClick: () => runAction('pin', selected) }, t('pin')),
                h('button', { type: 'button', className: 'dsm-btn', disabled: busy, onClick: () => runAction('unpin', selected) }, t('unpin')),
                h('button', { type: 'button', className: 'dsm-btn', 'data-variant': 'danger', disabled: busy, onClick: () => requestDelete(selected) }, t('delete')),
                archivedIds.length > 0 && selected.length === visible.filter((s) => s.archived).length
                  ? h('button', {
                      type: 'button',
                      className: 'dsm-btn',
                      'data-variant': 'danger',
                      disabled: busy,
                      onClick: () => requestDelete(archivedIds),
                    }, t('deleteAllArchived', { count: archivedIds.length }))
                  : null)
            : null,

          h('div', { className: 'dsm-list' },
            state.status === 'loading' && sessions.length === 0
              ? h('div', { className: 'dsm-empty' }, t('loading'))
              : visible.length === 0
                ? h('div', { className: 'dsm-empty' }, sessions.length === 0 ? t('empty') : t('noMatch'))
                : visible.map((session) => h(SessionRow, {
                    key: session.id,
                    session,
                    t,
                    selected: selectedSet.has(session.id),
                    busy,
                    onToggle: toggle,
                    onAction: runAction,
                    onRequestDelete: requestDelete,
                  })))),

        pendingDelete
          ? h(ConfirmDelete, {
              ids: pendingDelete.ids,
              detail: pendingDelete.detail,
              t,
              onCancel: () => setPendingDelete(null),
              onConfirm: confirmDelete,
            })
          : null)
    }

    /* --------------------------------------------------------------- mount */

    function mount(ctx) {
      const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
      if (!slots || typeof slots.register !== 'function') {
        console.warn('[dsh-session-manager] no slots service — Sessions page unavailable')
        return
      }
      const t = makeTranslator(ctx)
      const register = () => slots.register({
        name: 'settings.section',
        id: NS,
        order: 30,
        label: () => t('title'),
        locale: NS,
      }, () => h(SessionManagerSection, { t }))
      if (typeof slots.inject === 'function') slots.inject('settings.section', register)
      else register()
    }

    exports.name = NS
    exports.inject = ['slots']
    exports.apply = function apply(ctx) {
      try {
        const disposeStyles = insertStyles()
        if (typeof ctx.effect === 'function') ctx.effect(() => disposeStyles)
        mount(ctx)
      } catch (error) {
        // A throw here is a throw on the shell's boot path. Losing this page is
        // acceptable; taking the application down with it is not.
        console.error('[dsh-session-manager] mount failed; the Sessions page is missing for this session.', error)
      }
    }

    return module.exports
  },
})
