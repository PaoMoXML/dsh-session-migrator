// dsh-session-migrator — browser half.
//
// One settings section, Settings → 会话迁移. It talks to the Host half through
// four loopback-only POST routes and never folds session events itself.
//
// Only `react` is required: the page is plain createElement plus
// --dsw-alias-* theme tokens, matching the host's settings pages.

window.__ModuleLoader__.load({
  id: 'dsh-session-migrator',
  factory(require) {
    var module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState } = React

    const PACKAGE_NAME = 'dsh-session-migrator'
    const NS = 'session-migrator'
    const SCAN_ROUTE = '/session-migrator/scan'
    const MIGRATE_ROUTE = '/session-migrator/migrate'
    const ARCHIVE_ROUTE = '/session-migrator/archive'
    const RESTORE_ROUTE = '/session-migrator/restore'
    const WORKSPACE_MIGRATE_ROUTE = '/session-migrator/workspace-migrate'
    const WORKSPACE_RESTORE_ROUTE = '/session-migrator/workspace-restore'
    const MARKER = 'x-dsh-session-migrator'
    const REQUEST_TIMEOUT_MS = 600_000
    /** Host accepts at most 500 ids; stay well below the limit per request. */
    const BATCH_SIZE = 200

    const PREFER_ZH = typeof navigator !== 'undefined'
      && typeof navigator.language === 'string'
      && navigator.language.toLowerCase().startsWith('zh')

    // ── copy ───────────────────────────────────────────────────────────────
    const en = {
      'section.title': 'Session migration',
      'page.guide': 'Move old sessions out of the DSH session list. Session files stay in a local archive and can be restored at any time.',
      'tab.migrate': 'Sessions to migrate',
      'tab.archive': 'Migrated sessions',
      'migrate.title': 'Migrate old sessions',
      'migrate.before': 'Move sessions older than',
      'migrate.rangeLabel': 'Time range:',
      'migrate.monthsAgo': '{count} month(s) ago',
      'migrate.allIncludingCurrent': 'All sessions (including this month)',
      'migrate.rangeHint': 'Default: 1 month ago. 0 means no time limit, including this month.',
      'migrate.presets': 'Quick range:',
      'migrate.preset1': '1 month ago',
      'migrate.preset3': '3 months ago',
      'migrate.preset6': '6 months ago',
      'migrate.presetAll': 'All (incl. this month)',
      'migrate.unit': 'month(s)',
      'migrate.archiveRoot': 'Archive directory:',
      'migrate.archiveRootReset': 'Default',
      'migrate.archiveRootHint': 'Default: {path}. You can enter another absolute directory; it is saved when a migration runs.',
      'migrate.hint': 'Sessions with a note or todo are kept by default. Allow them explicitly before selecting any.',
      'migrate.scan': 'Scan sessions',
      'migrate.scanning': 'Scanning…',
      'migrate.rescan': 'Scan again',
      'migrate.empty': 'No sessions match this age.',
      'migrate.found': 'Found {count} session(s), {size} in total.',
      'migrate.protected': '{count} carry a note or todo and are kept by default.',
      'migrate.live': '{count} are running and cannot be migrated now.',
      'migrate.allowMarked': 'Allow selecting sessions with a note or todo',
      'migrate.selected': '{count} selected',
      'migrate.selectAll': 'Select all',
      'migrate.selectNone': 'Select none',
      'migrate.action': 'Migrate selected',
      'migrate.working': 'Migrating {done}/{total}…',
      'migrate.confirm': 'Move {count} session(s) out of the DSH session list? The files stay in the archive and can be restored.',
      'migrate.done': 'Migrated {count} session(s).',
      'migrate.related': ' Including {count} subagent(s).',
      'migrate.undo': 'Restore this batch',
      'migrate.partial': '{count} session(s) could not be migrated.',
      'archive.title': 'Migrated sessions',
      'archive.guide': 'Grouped by last activity month. Select one or more to restore; a session that was archived in DSH stays archived after restore.',
      'archive.empty': 'No session has been migrated out yet.',
      'archive.refresh': 'Refresh',
      'archive.restoreSelected': 'Restore selected',
      'archive.restoreAll': 'Restore all',
      'archive.selected': '{count} selected',
      'archive.selectAll': 'Select all',
      'archive.working': 'Restoring {done}/{total}…',
      'archive.total': '{count} session(s), {archived} archived',
      'archive.searchPlaceholder': 'Search migrated sessions by title, path, workspace, note or session id',
      'archive.searchClear': 'Clear',
      'archive.searchResult': '{count} of {total} session(s)',
      'archive.searchEmpty': 'No migrated session matches this search.',
      'archive.archived': 'Archived',
      'archive.normal': 'Not archived',
      'archive.movedAt': 'Migrated {date}',
      'archive.missing': 'Archive files missing',
      'archive.live': 'Running',
      'subagent.count': '+{count} subagent(s)',
      'subagent.orphan': 'Orphan subagent',
      'migrate.orphanSubagents': '{count} orphan subagent(s) from migrated parents are still here.',
      'archive.confirm': 'Restore {count} session(s) to DSH?',
      'archive.done': 'Restored {count} session(s). Archived sessions keep their archived state.',
      'archive.related': ' Including {count} subagent(s).',
      'archive.partial': '{count} session(s) could not be restored.',
      'archive.lastBatch': 'Last migration: {count} session(s)',
      'group.count': '{count}',
      'group.all': 'Select this month',
      'panel.noWorkspace': 'No workspace',
      'panel.deletedWorkspaceName': '{title} (deleted)',
      'workspace.count': '{count} session(s)',
      'workspace.migrateAction': 'Migrate whole workspace',
      'workspace.panelTitle': 'Migrate whole workspaces',
      'workspace.panelGuide': 'Pick a workspace to move all of its sessions at once, even those newer than the time range; its registration is then removed.',
      'workspace.migrateConfirm': 'Migrate the whole workspace “{title}”? All {count} session(s), including recent ones, leave the DSH list and the workspace registration is removed. The project directory is not moved.',
      'workspace.blockedLive': 'Has {count} running session(s)',
      'workspace.blockedMarked': 'Has {count} session(s) with a note or todo; allow them first',
      'workspace.blockedMissing': 'Has {count} session(s) whose files are missing',
      'workspace.blocked': 'Workspace “{title}” was not migrated: {count} session(s) cannot move now.',
      'workspace.membershipChanged': 'Workspace “{title}” was kept because its sessions changed during the migration.',
      'workspace.deleteFailed': 'Workspace “{title}” was kept: its registration could not be removed.',
      'workspace.vanished': 'Workspace “{title}” is no longer registered.',
      'workspace.rolledBack': ' {count} moved session(s) were put back.',
      'workspace.rollbackFailed': ' {count} session(s) could not be put back and stay in the archive.',
      'workspace.migrateDone': 'Migrated workspace “{title}” with {count} session(s).',
      'workspace.migratePartial': 'Workspace “{title}” was kept: {migrated} session(s) moved, {count} failed.',
      'workspace.missingArchives': '{count} archive file(s) missing',
      'workspace.archivedTitle': 'Migrated workspaces',
      'workspace.archivedGuide': 'Their registrations are gone and their sessions stay in the archive. Restoring a workspace recreates the registration with its original directory and title, then puts its sessions back.',
      'workspace.restoreAction': 'Restore workspace',
      'workspace.restoreConfirm': 'Restore the workspace “{title}” and its {count} session(s)? The workspace registration is recreated and its sessions return to it.',
      'workspace.restoreDone': 'Restored workspace “{title}” with {count} session(s).',
      'workspace.restoreFailed': 'Restoring workspace “{title}” failed: {count} item(s).',
      'workspace.restorePartial': '{count} session(s) or entry item(s) of the workspace could not be restored.',
      'workspace.pendingCount': '{count} session(s) to restore',
      'workspace.alreadyMigrated': '{count} already in the archive',
      'workspace.archivedAt': 'Migrated {date}',
      'workspace.groupArchived': 'Migrated workspace',
      'workspace.autoRestored': ' Recreated {count} workspace(s).',
      'branch.git': 'Git branch',
      'branch.detached': 'detached',
      'branch.unknown': 'No branch record',
      'branch.parent': 'parent {id}',
      'common.cancel': 'Cancel',
      'common.confirm': 'Confirm',
      'common.loading': 'Loading…',
      'common.error': 'Operation failed: {message}',
      'common.retry': 'Retry',
      'mark.todo': 'Todo',
      'mark.note': 'Note',
      'mark.done': 'Done',
      'mark.empty': '(no text)',
      'mark.protected': 'Kept by default',
      'time.unknown': 'Unknown time',
    }

    const zh = {
      'section.title': '会话迁移',
      'page.guide': '把旧会话移出 DSH 会话列表。会话文件会保留在本地归档目录，可随时恢复。',
      'tab.migrate': '待迁移会话',
      'tab.archive': '已迁移会话',
      'migrate.title': '迁移旧会话',
      'migrate.before': '将',
      'migrate.rangeLabel': '时间范围：',
      'migrate.monthsAgo': '{count} 个月以前',
      'migrate.allIncludingCurrent': '全部会话（含本月）',
      'migrate.rangeHint': '默认 1 个月以前；填 0 表示不限制时间（包含本月）。',
      'migrate.presets': '快捷范围：',
      'migrate.preset1': '1 个月以前',
      'migrate.preset3': '3 个月以前',
      'migrate.preset6': '6 个月以前',
      'migrate.presetAll': '全部（含本月）',
      'migrate.unit': '个月以前',
      'migrate.archiveRoot': '迁移目录：',
      'migrate.archiveRootReset': '默认目录',
      'migrate.archiveRootHint': '默认：{path}。可填写其他绝对目录；执行迁移时会保存。',
      'migrate.hint': '带备注或待办标记的会话默认保留；需要先允许，再手动勾选。',
      'migrate.scan': '扫描可迁移会话',
      'migrate.scanning': '扫描中…',
      'migrate.rescan': '重新扫描',
      'migrate.empty': '没有符合这个时间条件的会话。',
      'migrate.found': '找到 {count} 个会话，共 {size}。',
      'migrate.protected': '其中 {count} 个带备注或待办，默认保留。',
      'migrate.live': '其中 {count} 个正在运行，暂不可迁移。',
      'migrate.allowMarked': '允许选择带备注或待办标记的会话',
      'migrate.selected': '已选 {count} 个',
      'migrate.selectAll': '全选全部',
      'migrate.selectNone': '全不选',
      'migrate.action': '迁移所选',
      'migrate.working': '正在迁移 {done}/{total}…',
      'migrate.confirm': '将 {count} 个会话移出 DSH 会话列表？文件会保留在归档目录，可随时恢复。',
      'migrate.done': '已迁移 {count} 个会话。',
      'migrate.related': '其中含 {count} 个子代理。',
      'migrate.undo': '一键恢复本次迁移',
      'migrate.partial': '{count} 个会话迁移失败。',
      'archive.title': '已迁移会话',
      'archive.guide': '按最后活动月份分组。可多选恢复；在 DSH 里已归档的会话，恢复后仍保持归档状态。',
      'archive.empty': '还没有迁移出去的会话。',
      'archive.refresh': '刷新',
      'archive.restoreSelected': '恢复所选',
      'archive.restoreAll': '全部恢复',
      'archive.selected': '已选 {count} 个',
      'archive.selectAll': '全选全部',
      'archive.working': '正在恢复 {done}/{total}…',
      'archive.total': '共 {count} 个会话，其中 {archived} 个已归档',
      'archive.searchPlaceholder': '搜索已迁移会话：标题、路径、工作区、备注或会话 ID',
      'archive.searchClear': '清除',
      'archive.searchResult': '找到 {count} / {total} 个会话',
      'archive.searchEmpty': '没有匹配的已迁移会话。',
      'archive.archived': '已归档',
      'archive.normal': '未归档',
      'archive.movedAt': '迁移于 {date}',
      'archive.missing': '归档文件缺失',
      'archive.live': '运行中',
      'subagent.count': '+{count} 个子代理',
      'subagent.orphan': '子代理残留',
      'migrate.orphanSubagents': '有 {count} 个已迁移父会话的子代理仍留在会话目录。',
      'archive.confirm': '恢复 {count} 个会话到 DSH？',
      'archive.done': '已恢复 {count} 个会话。原本已归档的会话仍保持归档状态。',
      'archive.related': '其中含 {count} 个子代理。',
      'archive.partial': '{count} 个会话恢复失败。',
      'archive.lastBatch': '上次迁移：{count} 个会话',
      'group.count': '{count} 个',
      'group.all': '全选本月',
      'panel.noWorkspace': '未分组',
      'panel.deletedWorkspaceName': '{title}（已删除）',
      'workspace.count': '{count} 个会话',
      'workspace.migrateAction': '迁移整个工作区',
      'workspace.panelTitle': '整区迁移工作区',
      'workspace.panelGuide': '选一个工作区，一次迁走它的全部会话（含比时间范围更新的），随后移除该工作区登记。',
      'workspace.migrateConfirm': '迁移整个工作区「{title}」？该工作区的 {count} 个会话（含最近会话）都会移出 DSH，工作区登记也会移除；项目目录不移动。',
      'workspace.blockedLive': '有 {count} 个会话正在运行',
      'workspace.blockedMarked': '有 {count} 个会话带备注或待办，需先允许',
      'workspace.blockedMissing': '有 {count} 个会话文件缺失',
      'workspace.blocked': '工作区「{title}」未迁移：{count} 个会话当前无法迁移。',
      'workspace.membershipChanged': '工作区「{title}」在迁移过程中会话发生变化，登记已保留。',
      'workspace.deleteFailed': '工作区「{title}」保留未删除：登记无法移除。',
      'workspace.vanished': '工作区「{title}」已不在登记中。',
      'workspace.rolledBack': ' 已放回 {count} 个已移走的会话。',
      'workspace.rollbackFailed': ' 有 {count} 个会话无法放回，仍在归档目录。',
      'workspace.migrateDone': '已迁移工作区「{title}」，含 {count} 个会话。',
      'workspace.migratePartial': '工作区「{title}」保留未删除：已迁走 {migrated} 个会话，{count} 个失败。',
      'workspace.missingArchives': '{count} 个归档文件缺失',
      'workspace.archivedTitle': '已迁移工作区',
      'workspace.archivedGuide': '这些工作区登记已移除，会话仍在归档目录。恢复工作区会按原目录与原标题重建登记，再把会话挂回去。',
      'workspace.restoreAction': '恢复工作区',
      'workspace.restoreConfirm': '恢复工作区「{title}」及其 {count} 个会话？将重建工作区登记并把会话挂回该工作区。',
      'workspace.restoreDone': '已恢复工作区「{title}」，含 {count} 个会话。',
      'workspace.restoreFailed': '恢复工作区「{title}」失败：{count} 个条目。',
      'workspace.restorePartial': '该工作区有 {count} 个会话或条目恢复失败。',
      'workspace.pendingCount': '{count} 个会话待恢复',
      'workspace.alreadyMigrated': '{count} 个已在归档目录',
      'workspace.archivedAt': '迁移于 {date}',
      'workspace.groupArchived': '已迁移工作区',
      'workspace.autoRestored': ' 并重建了 {count} 个工作区。',
      'branch.git': 'Git 分支',
      'branch.detached': '分离 HEAD',
      'branch.unknown': '未记录分支',
      'branch.parent': '父会话 {id}',
      'common.cancel': '取消',
      'common.confirm': '确认',
      'common.loading': '加载中…',
      'common.error': '操作失败：{message}',
      'common.retry': '重试',
      'mark.todo': '待办',
      'mark.note': '备注',
      'mark.done': '已完成',
      'mark.empty': '（无文字）',
      'mark.protected': '默认保留',
      'time.unknown': '时间未知',
    }

    let boundT
    /** Root client context captured by apply, for services the page needs after render. */
    let pluginCtx
    function interpolate(text, vars) {
      if (vars === undefined || vars === null) return text
      let out = text
      for (const [name, value] of Object.entries(vars)) out = out.split('{' + name + '}').join(String(value))
      return out
    }
    function say(key, vars) {
      let text
      if (boundT !== undefined) text = boundT(key)
      else {
        const table = PREFER_ZH ? zh : en
        text = table[key] !== undefined ? table[key] : (en[key] !== undefined ? en[key] : key)
      }
      return interpolate(text, vars)
    }
    function translator(props) {
      const own = props !== null && props !== undefined ? props.t : undefined
      if (typeof own === 'function') return (key, vars) => interpolate(own(key), vars)
      return say
    }

    /** Date formatting language follows DSH's active locale when it is available. */
    function dateLocale() {
      try {
        const snapshot = pluginCtx !== undefined && typeof pluginCtx.get === 'function'
          ? pluginCtx.get('locale', false)?.getSnapshot?.()
          : undefined
        const active = typeof snapshot?.active === 'string' ? snapshot.active.toLowerCase() : ''
        if (active !== '') {
          const base = active.split('-')[0]
          const table = {
            zh: 'zh-CN',
            ja: 'ja-JP',
            es: 'es-ES',
            fr: 'fr-FR',
            de: 'de-DE',
            ru: 'ru-RU',
            pt: 'pt-BR',
            en: 'en-US',
          }
          return table[base] ?? active
        }
      } catch {
        // fall through to the browser language
      }
      return PREFER_ZH ? 'zh-CN' : 'en-US'
    }

    // ── workspace grouping ─────────────────────────────────────────────────
    const EMPTY_WORKSPACES = new Map()
    EMPTY_WORKSPACES.byId = new Map()
    EMPTY_WORKSPACES.byPath = new Map()
    let lastWorkspaceState
    let lastWorkspaces = EMPTY_WORKSPACES
    /** Session id → owning workspace identity and display label. */
    const SELECT_WORKSPACES = (state) => {
      if (state === lastWorkspaceState) return lastWorkspaces
      lastWorkspaceState = state
      const items = state === null || state === undefined ? undefined : state.items
      if (!Array.isArray(items)) {
        lastWorkspaces = EMPTY_WORKSPACES
        return lastWorkspaces
      }
      const owner = new Map()
      const byId = new Map()
      const byPath = new Map()
      items.forEach((workspace, index) => {
        const label = typeof workspace.title === 'string' && workspace.title.trim() !== ''
          ? workspace.title
          : (typeof workspace.path === 'string' && workspace.path.trim() !== '' ? workspace.path : null)
        const key = typeof workspace.workspaceId === 'string' ? workspace.workspaceId : `workspace:${index}`
        const catalogued = {
          key,
          label,
          order: index,
          path: typeof workspace.path === 'string' ? workspace.path : null,
        }
        byId.set(key, catalogued)
        if (typeof workspace.path === 'string' && workspace.path !== '') byPath.set(workspace.path, catalogued)
        for (const sessionId of workspace.sessionIds ?? []) owner.set(sessionId, catalogued)
      })
      owner.byId = byId
      owner.byPath = byPath
      lastWorkspaces = owner
      return owner
    }

    /** Resolve an orphan subagent's workspace from its archived parent entry. */
    function workspaceFromArchivedParent(row, workspaces, archiveById, tr) {
      let parentId = row.parentSessionId
      const seen = new Set()
      while (typeof parentId === 'string' && !seen.has(parentId)) {
        seen.add(parentId)
        const parent = archiveById?.get(parentId)
        if (parent === undefined) return null
        if (typeof parent.workspaceId === 'string' && parent.workspaceId !== '') {
          const live = workspaces.byId?.get(parent.workspaceId)
          if (live !== undefined) return live
          return {
            key: `deleted:${parent.workspaceId}`,
            label: tr('panel.deletedWorkspaceName', {
              title: parent.workspaceTitle ?? parent.workspacePath ?? parent.workspaceId,
            }),
            order: Number.MAX_SAFE_INTEGER,
          }
        }
        if (typeof parent.workspacePath === 'string') {
          const live = workspaces.byPath?.get(parent.workspacePath)
          if (live !== undefined) return live
        }
        parentId = parent.parentSessionId
      }
      return null
    }

    /** Group rows into workspace sections, each with its own month sections. */
    function groupRowsByWorkspace(rows, workspaces, tr, archiveById, archivedWorkspaces) {
      const archivedById = archivedWorkspaces ?? new Map()
      const groups = new Map()
      for (const row of rows) {
        const workspace = workspaces.get(row.sessionId) ?? null
        let key
        let label
        let order
        let archivedWorkspace = false
        if (workspace !== null) {
          key = workspace.key
          label = workspace.label
          order = workspace.order
        } else {
          // Prefer live identity, then the path recorded when the entry was
          // migrated. Never infer ownership from the session's cwd: DSH groups
          // by workspace accounting, not by directory matching.
          const catalogued = (typeof row.workspaceId === 'string' ? workspaces.byId?.get(row.workspaceId) : undefined)
            ?? (typeof row.workspacePath === 'string' ? workspaces.byPath?.get(row.workspacePath) : undefined)
            ?? (row.orphanSubagent === true
              ? workspaceFromArchivedParent(row, workspaces, archiveById, tr)
              : null)
            ?? null
          if (catalogued !== null) {
            key = catalogued.key
            label = catalogued.label
            order = catalogued.order
          } else if (typeof row.workspaceId === 'string' && row.workspaceId !== '') {
            const archived = archivedById.get(row.workspaceId)
            key = `deleted:${row.workspaceId}`
            label = archived !== undefined
              ? archived.title
              : tr('panel.deletedWorkspaceName', {
                title: row.workspaceTitle ?? row.workspacePath ?? row.workspaceId,
              })
            order = archived !== undefined ? archived.order : Number.MAX_SAFE_INTEGER
            archivedWorkspace = archived !== undefined
          } else {
            key = '\u0000none'
            label = tr('panel.noWorkspace')
            order = Number.MAX_SAFE_INTEGER
          }
        }
        if (!groups.has(key)) groups.set(key, { key, label, order, archivedWorkspace, rows: [] })
        groups.get(key).rows.push(row)
      }
      return [...groups.values()]
        .map((group) => ({
          ...group,
          months: groupRows(group.rows),
          count: group.rows.length,
        }))
        .sort((left, right) => {
          const orderDiff = (left.order ?? Number.POSITIVE_INFINITY) - (right.order ?? Number.POSITIVE_INFINITY)
          if (orderDiff !== 0) return orderDiff
          const leftLabel = left.label ?? ''
          const rightLabel = right.label ?? ''
          return leftLabel.localeCompare(rightLabel) || right.count - left.count
        })
    }

    // ── formatting ─────────────────────────────────────────────────────────
    function monthKeyOf(ms) {
      const date = new Date(ms)
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    }
    function monthLabel(key, tr) {
      const [year, month] = key.split('-').map(Number)
      if (!Number.isFinite(year) || !Number.isFinite(month)) return key
      try {
        return new Intl.DateTimeFormat(dateLocale(), { year: 'numeric', month: 'long' })
          .format(new Date(year, month - 1, 1))
      } catch {
        return key
      }
    }
    function formatDate(ms, tr) {
      if (typeof ms !== 'number' || ms <= 0) return tr('time.unknown')
      try {
        return new Intl.DateTimeFormat(dateLocale(), { year: 'numeric', month: '2-digit', day: '2-digit' })
          .format(new Date(ms))
      } catch {
        return new Date(ms).toLocaleDateString()
      }
    }
    function formatSize(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB']
      let value = bytes
      let index = 0
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024
        index += 1
      }
      return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
    }
    /** Whether one archived session matches a case-insensitive search query. */
    function archiveEntryMatches(entry, query) {
      const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
      if (needle === '') return true
      const fields = [
        entry?.title,
        entry?.cwd,
        entry?.workspaceTitle,
        entry?.workspacePath,
        entry?.mark?.text,
        entry?.sessionId,
        entry?.parentSessionId,
        entry?.gitBranch,
        entry?.gitHead,
      ]
      return fields.some((value) => typeof value === 'string' && value.toLowerCase().includes(needle))
    }

    function groupRows(rows) {
      const map = new Map()
      for (const row of rows) {
        const key = monthKeyOf(row.updatedAt)
        if (!map.has(key)) map.set(key, [])
        map.get(key).push(row)
      }
      return [...map.entries()]
        .sort((left, right) => right[0].localeCompare(left[0]))
        .map(([key, items]) => ({ key, rows: items.sort((a, b) => b.updatedAt - a.updatedAt) }))
    }

    // ── host requests ──────────────────────────────────────────────────────
    async function request(path, body) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const response = await fetch(path, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [MARKER]: '1',
          },
          body: JSON.stringify(body ?? {}),
          signal: controller.signal,
        })
        let payload = null
        try {
          payload = await response.json()
        } catch {
          payload = null
        }
        if (!response.ok || payload === null || payload.ok !== true) {
          const message = payload !== null && typeof payload.error === 'string'
            ? payload.error
            : `HTTP ${response.status}`
          throw new Error(message)
        }
        return payload.value
      } catch (error) {
        if (error?.name === 'AbortError') throw new Error('request timed out')
        throw error
      } finally {
        clearTimeout(timer)
      }
    }

    /** Fetch the optional dsh-session-branch table; absence is harmless. */
    async function requestBranchTable() {
      try {
        const response = await fetch('/session-branch/list', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-session-branch': '1' },
          body: '{}',
        })
        const payload = await response.json()
        if (!response.ok || payload === null || payload.ok !== true || payload.value === null || typeof payload.value !== 'object') return {}
        return payload.value
      } catch {
        return {}
      }
    }

    /** Merge branch records into rows from an older Host that lacks branch fields. */
    function withBranchFallback(rows, branchTable) {
      return rows.map((row) => {
        if (row.gitBranch !== null && row.gitBranch !== undefined && row.gitBranch !== '') return row
        if (row.gitBranchDetached === true) return row
        const branch = branchTable[row.sessionId]
        if (branch === undefined || branch === null) return row
        return {
          ...row,
          gitBranch: branch.detached === true ? null : (branch.branch ?? null),
          gitBranchDetached: branch.detached === true,
          gitHead: branch.head ?? null,
        }
      })
    }

    /** Refresh the host-authoritative Session list after files move. */
    function refreshSessionList(ctx) {
      try {
        const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
        if (sessions !== undefined && sessions !== null && typeof sessions.refresh === 'function') {
          void sessions.refresh()
        }
      } catch {
        // The page also offers a manual refresh path; never fail the operation for this.
      }
    }

    // ── styles ─────────────────────────────────────────────────────────────
    const STYLE_ID = 'session-migrator-style'
    const STYLESHEET_CSS = `
      [data-session-migrator="row"]:hover { background: var(--dsw-alias-bg-layer-2); }
      [data-session-migrator="row"] { transition: background 120ms ease; }
      [data-session-migrator="btn"]:disabled { opacity: .48; cursor: default; }
      [data-session-migrator="btn"]:not(:disabled):hover { filter: brightness(1.06); }
      [data-session-migrator="checkbox"] { accent-color: var(--dsw-alias-brand-primary); margin: 1px 0 0; flex: none; }
      [data-session-migrator="month-header"]:hover { background: var(--dsw-alias-bg-layer-2); }
      [data-session-migrator="page"] ::-webkit-scrollbar { width: 8px; height: 8px; }
      [data-session-migrator="page"] ::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l1); border-radius: 4px; }
    `

    function injectStyle() {
      if (typeof document === 'undefined') return () => {}
      const selector = `style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`
      const existing = document.querySelector(selector)
      if (existing !== null) {
        existing.textContent = STYLESHEET_CSS
        return () => {}
      }
      const tag = document.createElement('style')
      tag.dataset.plugin = PACKAGE_NAME
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = STYLESHEET_CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    // ── small controls ─────────────────────────────────────────────────────
    const CARD_STYLE = {
      background: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1))',
      border: '1px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l1))',
      borderRadius: '10px',
      padding: '16px',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      minWidth: 0,
    }
    const H3_STYLE = {
      margin: 0,
      fontSize: '14px',
      lineHeight: '20px',
      fontWeight: 600,
      color: 'var(--dsw-alias-label-primary)',
    }
    const GUIDE_STYLE = {
      margin: 0,
      fontSize: '12px',
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary)',
    }
    const META_STYLE = {
      fontSize: '11px',
      lineHeight: '16px',
      color: 'var(--dsw-alias-label-secondary)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      minWidth: 0,
    }
    const BADGE_BASE = {
      flex: 'none',
      fontSize: '10px',
      lineHeight: '16px',
      padding: '0 6px',
      borderRadius: '999px',
      border: '1px solid',
      whiteSpace: 'nowrap',
    }

    function buttonStyle(kind, disabled) {
      const base = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '4px',
        height: '28px',
        padding: '0 10px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '16px',
        cursor: disabled ? 'default' : 'pointer',
        whiteSpace: 'nowrap',
        flex: 'none',
      }
      if (kind === 'primary') {
        base.background = 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary))'
        base.borderColor = 'transparent'
        base.color = 'var(--dsw-alias-label-primary-foreground, #ffffff)'
      }
      if (kind === 'danger') {
        base.color = 'var(--dsw-alias-state-error-primary)'
      }
      return base
    }

    function ActionButton({ label, onClick, kind, disabled, title }) {
      return h('button', {
        type: 'button',
        'data-session-migrator': 'btn',
        title: title ?? label,
        disabled: disabled === true,
        onClick: disabled === true ? undefined : onClick,
        style: buttonStyle(kind, disabled === true),
      }, label)
    }

    function Badge({ text, tone }) {
      const color = tone === 'archived'
        ? 'var(--dsw-alias-state-warn-label)'
        : tone === 'normal'
          ? 'var(--dsw-alias-label-secondary)'
          : 'var(--dsw-alias-state-error-primary)'
      return h('span', { style: { ...BADGE_BASE, color, borderColor: color } }, text)
    }

    function MarkLine({ mark, tr }) {
      if (mark === null || mark === undefined) return null
      const done = mark.kind === 'todo' && mark.done === true
      const color = mark.kind === 'todo'
        ? 'var(--dsw-alias-state-warn-label)'
        : 'var(--dsw-alias-brand-primary)'
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0,
          fontSize: '11px', lineHeight: '16px',
        },
      },
      h('span', { style: { flex: 'none', color, fontWeight: 600 } }, tr('mark.' + mark.kind)),
      h('span', {
        title: mark.text === '' ? tr('mark.empty') : mark.text,
        style: {
          minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: 'var(--dsw-alias-label-secondary)',
          textDecoration: done ? 'line-through' : 'none',
          opacity: done ? 0.62 : 1,
        },
      }, mark.text === '' ? tr('mark.empty') : mark.text),
      done ? h('span', { style: { flex: 'none', color: 'var(--dsw-alias-label-secondary)', fontSize: '10px' } }, tr('mark.done')) : null)
    }

    function SessionRow({ row, checked, disabled, onToggle, tr, mode }) {
      const archived = row.archived === true
      const missing = row.missing === true
      const branchText = row.gitBranch !== null && row.gitBranch !== undefined && row.gitBranch !== ''
        ? `⎇ ${row.gitBranch}`
        : row.gitBranchDetached === true
          ? `⎇ ${row.gitHead ?? tr('branch.detached')}`
          : tr('branch.unknown')
      const branchColor = row.gitBranch !== null && row.gitBranch !== undefined && row.gitBranch !== ''
        ? 'var(--dsw-alias-brand-primary)'
        : 'var(--dsw-alias-label-secondary)'
      const subagentCount = typeof row.subagentCount === 'number' && row.subagentCount > 0 ? row.subagentCount : 0
      const metaParts = []
      if (typeof row.cwd === 'string' && row.cwd !== '') metaParts.push(row.cwd)
      metaParts.push(formatDate(row.updatedAt, tr))
      metaParts.push(formatSize(row.sizeBytes))
      if (mode === 'archive') metaParts.push(tr('archive.movedAt', { date: formatDate(row.movedAt, tr) }))
      if (typeof row.parentSessionId === 'string') metaParts.push(tr('branch.parent', { id: row.parentSessionId.slice(0, 18) }))
      return h('div', {
        'data-session-migrator': 'row',
        style: {
          display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '7px 8px',
          borderTop: '1px solid var(--dsw-alias-border-l1)',
          opacity: disabled ? 0.55 : 1, minWidth: 0,
        },
      },
      h('input', {
        'data-session-migrator': 'checkbox',
        type: 'checkbox',
        checked: checked === true,
        disabled: disabled === true || missing,
        onChange: () => onToggle(row.sessionId),
        'aria-label': row.title,
      }),
      h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
          h('span', {
            style: {
              minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontSize: '12px', lineHeight: '17px', color: 'var(--dsw-alias-label-primary)',
            },
            title: row.title,
          }, row.title),
          h('span', {
            style: { flex: 'none', fontSize: '10px', lineHeight: '16px', color: branchColor, whiteSpace: 'nowrap' },
            title: tr('branch.git'),
          }, branchText),
          row.live === true ? h(Badge, { text: tr('archive.live'), tone: 'archived' }) : null,
          row.orphanSubagent === true ? h(Badge, { text: tr('subagent.orphan'), tone: 'archived' }) : null,
          subagentCount > 0 ? h(Badge, { text: tr('subagent.count', { count: subagentCount }), tone: 'normal' }) : null,
          archived ? h(Badge, { text: tr('archive.archived'), tone: 'archived' }) : h(Badge, { text: tr('archive.normal'), tone: 'normal' }),
          missing ? h(Badge, { text: tr('archive.missing'), tone: 'missing' }) : null),
        h('div', { style: META_STYLE, title: metaParts.join(' · ') }, metaParts.join(' · ')),
        disabled && row.protected === true
          ? h('div', { style: { fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-state-warn-label)' } }, tr('mark.protected'))
          : null,
        h(MarkLine, { mark: row.mark, tr })))
    }

    function MonthSection({ group, tr, mode, selected, onToggle, isSelectable, onToggleGroup, defaultOpen }) {
      const [open, setOpen] = useState(defaultOpen === true)
      const selectable = group.rows.filter(isSelectable)
      const allSelected = selectable.length > 0 && selectable.every((row) => selected.has(row.sessionId))
      const archivedCount = group.rows.filter((row) => row.archived === true).length
      return h('div', {
        style: {
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: '8px',
          overflow: 'hidden',
          minWidth: 0,
        },
      },
      h('div', {
        'data-session-migrator': 'month-header',
        role: 'button',
        tabIndex: 0,
        'aria-expanded': open,
        style: {
          display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 8px',
          background: 'var(--dsw-alias-bg-layer-2)', cursor: 'pointer', minWidth: 0,
        },
        onClick: () => setOpen((value) => !value),
        onKeyDown: (event) => {
          if (event.target !== event.currentTarget) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen((value) => !value)
          }
        },
      },
        h('span', { style: { flex: 'none', color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', width: '12px' } }, open ? '▾' : '▸'),
        h('input', {
          'data-session-migrator': 'checkbox',
          type: 'checkbox',
          checked: allSelected,
          disabled: selectable.length === 0,
          onClick: (event) => event.stopPropagation(),
          onChange: () => onToggleGroup(selectable),
          'aria-label': tr('group.all'),
        }),
        h('span', { style: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, monthLabel(group.key, tr)),
        h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, tr('group.count', { count: group.rows.length })),
        archivedCount > 0
          ? h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-state-warn-label)' } }, `${tr('archive.archived')} ${archivedCount}`)
          : null),
      open
        ? h('div', null, group.rows.map((row) => h(SessionRow, {
          key: row.sessionId,
          row,
          tr,
          mode,
          checked: selected.has(row.sessionId),
          disabled: !isSelectable(row),
          onToggle,
        })))
        : null)
    }

    function WorkspaceSection({ group, tr, mode, selected, onToggle, isSelectable, onToggleGroup, defaultOpen, action }) {
      const [open, setOpen] = useState(defaultOpen === true)
      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0,
          padding: '6px 0 2px',
        },
      },
      h('div', {
        role: 'button',
        tabIndex: 0,
        'aria-expanded': open,
        style: {
          display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer',
          padding: '5px 4px', borderRadius: '6px', minWidth: 0,
        },
        onClick: () => setOpen((value) => !value),
        onKeyDown: (event) => {
          if (event.target !== event.currentTarget) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen((value) => !value)
          }
        },
      },
      h('span', { style: { flex: 'none', color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', width: '12px' } }, open ? '▾' : '▸'),
      h('span', { style: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        group.label ?? tr('panel.noWorkspace')),
      h('span', { style: { flex: 'none', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
        tr('workspace.count', { count: group.count })),
      group.archivedWorkspace === true
        ? h('span', {
          style: {
            flex: 'none', fontSize: '10px', lineHeight: '16px', padding: '0 6px',
            borderRadius: '999px', border: '1px solid var(--dsw-alias-state-warn-label)',
            color: 'var(--dsw-alias-state-warn-label)', whiteSpace: 'nowrap',
          },
        }, tr('workspace.groupArchived'))
        : null,
      action !== undefined && action !== null
        ? h('button', {
          type: 'button',
          'data-session-migrator': 'btn',
          title: action.title ?? action.label,
          disabled: action.disabled === true,
          onClick: (event) => {
            event.stopPropagation()
            if (action.disabled !== true) action.onClick()
          },
          style: {
            ...buttonStyle('primary', action.disabled === true),
            height: '24px', fontSize: '11px', padding: '0 8px', marginLeft: 'auto',
          },
        }, action.label)
        : null),
      open
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', paddingLeft: '4px' } },
          group.months.map((month) => h(MonthSection, {
            key: month.key,
            group: month,
            tr,
            mode,
            selected,
            onToggle,
            isSelectable,
            onToggleGroup,
            // Every month starts collapsed: opening either migration list must
            // not immediately reveal the most recent month's sessions.
            defaultOpen: false,
          })))
        : null)
    }

    function ArchivedWorkspaceRow({ entry, tr, disabled, onRestore }) {
      const metaParts = []
      if (typeof entry.path === 'string' && entry.path !== '') metaParts.push(entry.path)
      metaParts.push(tr('workspace.pendingCount', { count: entry.sessionCount }))
      if (typeof entry.missingSessions === 'number' && entry.missingSessions > 0) {
        metaParts.push(tr('workspace.missingArchives', { count: entry.missingSessions }))
      }
      if (typeof entry.totalSessions === 'number' && entry.totalSessions > entry.sessionCount) {
        metaParts.push(tr('workspace.count', { count: entry.totalSessions }))
      }
      metaParts.push(tr('workspace.archivedAt', { date: formatDate(entry.movedAt, tr) }))
      return h('div', {
        'data-session-migrator': 'row',
        style: {
          display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 8px',
          border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px',
          opacity: disabled ? 0.6 : 1, minWidth: 0,
        },
      },
      h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1px' } },
        h('span', {
          style: {
            fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          },
          title: entry.title,
        }, entry.title),
        h('div', { style: META_STYLE, title: metaParts.join(' · ') }, metaParts.join(' · '))),
      h(ActionButton, {
        label: tr('workspace.restoreAction'),
        disabled: disabled === true,
        onClick: onRestore,
      }))
    }

    function WorkspaceMigratePanel({ summaries, tr, actionFor, defaultOpen }) {
      const [open, setOpen] = useState(defaultOpen === true)
      if (summaries.length === 0) return null
      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column', gap: '6px', padding: '4px 0',
          borderTop: '1px solid var(--dsw-alias-border-l1)', minWidth: 0,
        },
      },
      h('div', {
        role: 'button',
        tabIndex: 0,
        'aria-expanded': open,
        style: {
          display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer',
          padding: '6px 4px', borderRadius: '6px', minWidth: 0,
        },
        onClick: () => setOpen((value) => !value),
        onKeyDown: (event) => {
          if (event.target !== event.currentTarget) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen((value) => !value)
          }
        },
      },
      h('span', { style: { flex: 'none', color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', width: '12px' } }, open ? '▾' : '▸'),
      h('span', { style: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, tr('workspace.panelTitle')),
      h('span', { style: { flex: 'none', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
        tr('workspace.count', { count: summaries.length }))),
      open
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          h('div', { style: { ...GUIDE_STYLE, fontSize: '11px' } }, tr('workspace.panelGuide')),
          summaries.map((summary) => {
            const action = actionFor(summary)
            const label = summary.title ?? summary.path ?? summary.workspaceId
            const meta = [
              summary.path,
              tr('workspace.count', { count: summary.total }),
              summary.alreadyMigrated > 0
                ? tr('workspace.alreadyMigrated', { count: summary.alreadyMigrated })
                : null,
            ].filter(Boolean).join(' · ')
            return h('div', {
              key: summary.workspaceId,
              'data-session-migrator': 'row',
              style: {
                display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 8px',
                border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px', minWidth: 0,
              },
            },
            h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1px' } },
              h('span', {
                style: {
                  fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                },
                title: label,
              }, label),
              h('div', { style: META_STYLE, title: meta }, meta),
              action.disabled === true
                ? h('div', { style: { fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-state-warn-label)' } }, action.title)
                : null),
            h(ActionButton, {
              label: action.label,
              title: action.title,
              disabled: action.disabled === true,
              onClick: action.onClick,
            }))
          }))
        : null)
    }

    // ── page ───────────────────────────────────────────────────────────────
    function MigratorPage(props) {
      const tr = translator(props)
      const workspaces = typeof props.useWorkspaces === 'function'
        ? props.useWorkspaces(SELECT_WORKSPACES)
        : EMPTY_WORKSPACES
      const [activeTab, setActiveTab] = useState('migrate')
      const [months, setMonths] = useState(1)
      const [scan, setScan] = useState(null)
      const [scanning, setScanning] = useState(false)
      const [scanError, setScanError] = useState(null)
      const [allowMarked, setAllowMarked] = useState(false)
      const [selected, setSelected] = useState(() => new Set())
      const [archive, setArchive] = useState(null)
      const [archiveLoading, setArchiveLoading] = useState(true)
      const [archiveError, setArchiveError] = useState(null)
      const [archiveRoot, setArchiveRoot] = useState('')
      const [archiveQuery, setArchiveQuery] = useState('')
      const [archiveSelected, setArchiveSelected] = useState(() => new Set())
      const [branchTable, setBranchTable] = useState({})
      const [busy, setBusy] = useState(null)
      const [progress, setProgress] = useState(null)
      const [notice, setNotice] = useState(null)
      const [confirmation, setConfirmation] = useState(null)

      async function loadArchive() {
        setArchiveLoading(true)
        setArchiveError(null)
        try {
          const value = await request(ARCHIVE_ROUTE, {})
          setArchive(value)
          if (typeof value.archiveRoot === 'string' && value.archiveRoot !== '') {
            setArchiveRoot((previous) => previous === '' ? value.archiveRoot : previous)
          }
          setArchiveSelected((previous) => {
            const present = new Set(value.entries.filter((entry) => entry.missing !== true).map((entry) => entry.sessionId))
            return new Set([...previous].filter((id) => present.has(id)))
          })
        } catch (error) {
          setArchiveError(error instanceof Error ? error.message : String(error))
        } finally {
          setArchiveLoading(false)
        }
      }

      useEffect(() => {
        void loadArchive()
        void requestBranchTable().then(setBranchTable)
      }, [])

      useEffect(() => {
        if (allowMarked) return
        setSelected((previous) => {
          const blocked = new Set((scan?.rows ?? []).filter((row) => row.protected).map((row) => row.sessionId))
          if (![...previous].some((id) => blocked.has(id))) return previous
          const next = new Set(previous)
          for (const id of blocked) next.delete(id)
          return next
        })
      }, [allowMarked, scan])

      function showError(error) {
        setNotice({ kind: 'error', text: tr('common.error', { message: error instanceof Error ? error.message : String(error) }) })
      }

      /** Readable failure details: session/workspace title first, id as a fallback. */
      function failureDetail(items) {
        const titles = new Map()
        for (const row of scan?.rows ?? []) titles.set(row.sessionId, row.title)
        for (const entry of archive?.entries ?? []) {
          if (!titles.has(entry.sessionId)) titles.set(entry.sessionId, entry.title)
        }
        const workspaceTitles = new Map()
        for (const summary of scan?.workspaces ?? []) {
          workspaceTitles.set(summary.workspaceId, summary.title ?? summary.path ?? summary.workspaceId)
        }
        for (const entry of archive?.workspaces ?? []) {
          workspaceTitles.set(entry.workspaceId, entry.title ?? entry.path ?? entry.workspaceId)
        }
        return items.map((item) => {
          const label = titles.get(item.sessionId)
            ?? (typeof item.workspaceId === 'string' ? (workspaceTitles.get(item.workspaceId) ?? item.workspaceId) : undefined)
            ?? item.sessionId
          return `${label}: ${item.error}`
        }).join('\n')
      }

      function requestWorkspaceMigrate(summary) {
        if (scanning || busy !== null) return
        setConfirmation({
          kind: 'workspaceMigrate',
          workspaceId: summary.workspaceId,
          title: summary.title ?? summary.path ?? summary.workspaceId,
          count: summary.total,
          allowMarked,
          archiveRoot,
        })
      }

      function requestWorkspaceRestore(entry) {
        if (busy !== null) return
        setConfirmation({
          kind: 'workspaceRestore',
          workspaceId: entry.workspaceId,
          title: entry.title ?? entry.path ?? entry.workspaceId,
          count: entry.sessionCount,
        })
      }

      async function runScan(nextMonths) {
        setConfirmation(null)
        setScanning(true)
        setScanError(null)
        setNotice(null)
        setScan(null)
        setSelected(new Set())
        try {
          const value = await request(SCAN_ROUTE, { months: nextMonths })
          setScan(value)
        } catch (error) {
          setScanError(error instanceof Error ? error.message : String(error))
        } finally {
          setScanning(false)
        }
      }

      function selectAll() {
        const rows = (scan?.rows ?? []).filter(scanSelectable)
        setSelected(new Set(rows.map((row) => row.sessionId)))
      }

      function selectNone() {
        setSelected(new Set())
      }

      function toggleSelected(id) {
        setSelected((previous) => {
          const next = new Set(previous)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      function toggleGroup(rows) {
        setSelected((previous) => {
          const next = new Set(previous)
          const all = rows.length > 0 && rows.every((row) => next.has(row.sessionId))
          for (const row of rows) {
            if (all) next.delete(row.sessionId)
            else next.add(row.sessionId)
          }
          return next
        })
      }

      function toggleArchiveSelected(id) {
        setArchiveSelected((previous) => {
          const next = new Set(previous)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      function scanSelectable(row) {
        return row.live !== true && (!row.protected || allowMarked)
      }

      /** The header action for one live workspace summary. */
      function workspaceActionFor(summary) {
        if (summary === undefined) return undefined
        const reasons = []
        if (summary.live > 0) reasons.push(tr('workspace.blockedLive', { count: summary.live }))
        if (summary.missing > 0) reasons.push(tr('workspace.blockedMissing', { count: summary.missing }))
        if (summary.marked > 0 && !allowMarked) reasons.push(tr('workspace.blockedMarked', { count: summary.marked }))
        const disabled = scanning || busy !== null || reasons.length > 0
        return {
          label: tr('workspace.migrateAction'),
          title: reasons.length > 0 ? reasons.join(' · ') : tr('workspace.migrateAction'),
          disabled,
          onClick: () => requestWorkspaceMigrate(summary),
        }
      }

      function requestMigrate() {
        if (scanning || busy !== null) return
        const ids = [...selected].filter((id) => {
          const row = (scan?.rows ?? []).find((entry) => entry.sessionId === id)
          return row !== undefined && row.live !== true && (!row.protected || allowMarked)
        })
        if (ids.length === 0) return
        const workspaceMeta = {}
        for (const id of ids) {
          const row = (scan?.rows ?? []).find((entry) => entry.sessionId === id)
          const workspace = workspaces.get(id)
            ?? (typeof row?.cwd === 'string' ? workspaces.byPath?.get(row.cwd) : undefined)
          if (workspace === undefined) continue
          workspaceMeta[id] = {
            workspaceId: workspace.key,
            workspaceTitle: workspace.label,
            workspacePath: workspace.path,
            workspaceOrder: workspace.order,
          }
        }
        setConfirmation({ kind: 'migrate', ids, count: ids.length, months, allowMarked, archiveRoot, workspaceMeta })
      }

      function requestRestore(ids, kind) {
        if (ids.length === 0) return
        setConfirmation({ kind, ids, count: ids.length })
      }

      async function executeConfirmation() {
        if (confirmation === null) return
        const current = confirmation
        const batchMonths = current.kind === 'migrate' && typeof current.months === 'number' ? current.months : months
        const batchAllowMarked = (current.kind === 'migrate' || current.kind === 'workspaceMigrate') && current.allowMarked === true
        const batchArchiveRoot = (current.kind === 'migrate' || current.kind === 'workspaceMigrate') && typeof current.archiveRoot === 'string'
          ? current.archiveRoot
          : archiveRoot
        const batchWorkspaceMeta = current.kind === 'migrate' && current.workspaceMeta !== null && typeof current.workspaceMeta === 'object'
          ? current.workspaceMeta
          : {}
        const batchId = `migrate-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        const progressKind = current.kind === 'migrate' || current.kind === 'workspaceMigrate' ? 'migrate' : 'restore'
        const totalUnits = Array.isArray(current.ids) ? current.ids.length : 1
        setConfirmation(null)
        setNotice(null)
        setBusy(current.kind)
        setProgress({ kind: progressKind, done: 0, total: totalUnits })
        try {
          if (current.kind === 'workspaceMigrate') {
            const result = await request(WORKSPACE_MIGRATE_ROUTE, {
              workspaceId: current.workspaceId,
              allowMarked: batchAllowMarked,
              archiveRoot: batchArchiveRoot,
              batchId,
            })
            setProgress({ kind: progressKind, done: 1, total: 1 })
            refreshSessionList(pluginCtx)
            await loadArchive()
            await runScan(months)
            if (result.blocked !== null && result.blocked !== undefined) {
              const rollbackNote = (result.rolledBack > 0 ? tr('workspace.rolledBack', { count: result.rolledBack }) : '')
                + (result.rollbackFailed > 0 ? tr('workspace.rollbackFailed', { count: result.rollbackFailed }) : '')
              const blockedText = result.blocked === 'workspace membership changed during migration'
                ? tr('workspace.membershipChanged', { title: current.title })
                : result.blocked === 'workspace registration could not be removed'
                  ? tr('workspace.deleteFailed', { title: current.title })
                  : result.blocked === 'workspace is no longer registered'
                    ? tr('workspace.vanished', { title: current.title })
                    : tr('workspace.blocked', { title: current.title, count: result.failed.length })
              setNotice({
                kind: 'error',
                text: blockedText + rollbackNote,
                detail: failureDetail(result.failed ?? []),
              })
            } else if (result.workspace === null || result.workspace === undefined) {
              setNotice({
                kind: 'partial',
                text: tr('workspace.migratePartial', {
                  title: current.title,
                  migrated: result.migrated.length,
                  count: result.failed.length,
                }),
                detail: failureDetail(result.failed ?? []),
              })
            } else {
              const suffix = result.relatedMigrated > 0 ? tr('migrate.related', { count: result.relatedMigrated }) : ''
              setNotice({
                kind: 'success',
                text: tr('workspace.migrateDone', { title: current.title, count: result.migrated.length }) + suffix,
              })
            }
          } else if (current.kind === 'workspaceRestore') {
            const result = await request(WORKSPACE_RESTORE_ROUTE, { workspaceIds: [current.workspaceId] })
            setProgress({ kind: progressKind, done: 1, total: 1 })
            refreshSessionList(pluginCtx)
            await loadArchive()
            await runScan(months)
            const restoredWorkspace = (result.workspacesRestored ?? [])[0]
            const failures = [...(result.workspaceFailures ?? []), ...(result.failed ?? [])]
            if (restoredWorkspace === undefined) {
              setNotice({
                kind: 'error',
                text: tr('workspace.restoreFailed', { title: current.title, count: failures.length }),
                detail: failureDetail(failures),
              })
            } else if (failures.length > 0) {
              setNotice({
                kind: 'partial',
                text: `${tr('workspace.restoreDone', {
                  title: restoredWorkspace.title ?? current.title,
                  count: restoredWorkspace.attached.length,
                })} ${tr('workspace.restorePartial', { count: failures.length })}`,
                detail: failureDetail(failures),
              })
            } else {
              const suffix = result.relatedRestored > 0 ? tr('archive.related', { count: result.relatedRestored }) : ''
              setNotice({
                kind: 'success',
                text: tr('workspace.restoreDone', {
                  title: restoredWorkspace.title ?? current.title,
                  count: restoredWorkspace.attached.length,
                }) + suffix,
              })
            }
          } else if (current.kind === 'migrate') {
            const migrated = []
            const failed = []
            let related = 0
            for (let offset = 0; offset < current.ids.length; offset += BATCH_SIZE) {
              const chunk = current.ids.slice(offset, offset + BATCH_SIZE)
              const result = await request(MIGRATE_ROUTE, {
                months: batchMonths,
                sessionIds: chunk,
                allowMarked: batchAllowMarked,
                archiveRoot: batchArchiveRoot,
                workspaceMeta: batchWorkspaceMeta,
                batchId,
              })
              migrated.push(...result.migrated)
              failed.push(...result.failed)
              related += result.relatedMigrated ?? 0
              setProgress({ kind: 'migrate', done: Math.min(offset + chunk.length, current.ids.length), total: current.ids.length })
            }
            refreshSessionList(pluginCtx)
            await loadArchive()
            await runScan(batchMonths)
            const suffix = related > 0 ? tr('migrate.related', { count: related }) : ''
            setNotice({
              kind: failed.length === 0 ? 'success' : 'partial',
              text: (failed.length === 0
                ? tr('migrate.done', { count: migrated.length })
                : `${tr('migrate.done', { count: migrated.length })} ${tr('migrate.partial', { count: failed.length })}`) + suffix,
              detail: failureDetail(failed),
            })
          } else {
            const restored = []
            const failed = []
            let related = 0
            let workspacesRestored = 0
            const workspaceFailures = []
            for (let offset = 0; offset < current.ids.length; offset += BATCH_SIZE) {
              const chunk = current.ids.slice(offset, offset + BATCH_SIZE)
              const result = await request(RESTORE_ROUTE, { sessionIds: chunk })
              restored.push(...result.restored)
              failed.push(...result.failed)
              related += result.relatedRestored ?? 0
              workspacesRestored += (result.workspacesRestored ?? []).length
              workspaceFailures.push(...(result.workspaceFailures ?? []))
              setProgress({ kind: 'restore', done: Math.min(offset + chunk.length, current.ids.length), total: current.ids.length })
            }
            refreshSessionList(pluginCtx)
            await loadArchive()
            if (scan !== null) await runScan(batchMonths)
            const failures = [...failed, ...workspaceFailures]
            const suffix = (related > 0 ? tr('archive.related', { count: related }) : '')
              + (workspacesRestored > 0 ? tr('workspace.autoRestored', { count: workspacesRestored }) : '')
            setNotice({
              kind: failures.length === 0 ? 'success' : 'partial',
              text: (failures.length === 0
                ? tr('archive.done', { count: restored.length })
                : `${tr('archive.done', { count: restored.length })} ${tr('archive.partial', { count: failures.length })}`) + suffix,
              detail: failureDetail(failures),
            })
          }
        } catch (error) {
          // A timeout can follow a Host that already moved some directories;
          // refresh the local views before reporting the failure.
          try {
            refreshSessionList(pluginCtx)
            await loadArchive()
            if (scan !== null) await runScan(batchMonths)
          } catch {
            // keep the original failure
          }
          showError(error)
        } finally {
          setProgress(null)
          setBusy(null)
        }
      }

      const archiveEntries = archive?.entries ?? []
      const archiveById = new Map(archiveEntries.map((entry) => [entry.sessionId, entry]))
      const workspaceSummaries = new Map((scan?.workspaces ?? []).map((summary) => [summary.workspaceId, summary]))
      const archivedWorkspaces = archive?.workspaces ?? []
      const archivedWorkspaceById = new Map(archivedWorkspaces.map((entry) => [entry.workspaceId, entry]))
      const workspaceMarkedCount = [...workspaceSummaries.values()]
        .reduce((sum, summary) => sum + (summary.marked || 0), 0)
      const showAllowMarked = (scan?.stats?.protected ?? 0) > 0 || workspaceMarkedCount > 0
      const liveWorkspaceSummaries = [...workspaceSummaries.values()]
        .sort((left, right) => left.order - right.order)
      const archiveQueryText = archiveQuery.trim()
      const searchableArchiveEntries = withBranchFallback(archiveEntries, branchTable)
      const visibleArchiveEntries = archiveQueryText === ''
        ? searchableArchiveEntries
        : searchableArchiveEntries.filter((entry) => archiveEntryMatches(entry, archiveQueryText))
      const scanWorkspaceGroups = scan === null ? [] : groupRowsByWorkspace(withBranchFallback(scan.rows, branchTable), workspaces, tr, archiveById, archivedWorkspaceById)
      const archiveWorkspaceGroups = archive === null ? [] : groupRowsByWorkspace(visibleArchiveEntries, workspaces, tr, archiveById, archivedWorkspaceById)
      const restorableArchiveEntries = archiveEntries.filter((entry) => entry.missing !== true && entry.live !== true)
      const lastBatchIds = (archive?.lastBatch?.ids ?? []).filter((id) => {
        const entry = archiveById.get(id)
        return entry !== undefined && entry.missing !== true
      })
      const selectedSize = selected.size
      const archiveSelectedCount = archiveSelected.size
      const allArchiveSelected = restorableArchiveEntries.length > 0
        && restorableArchiveEntries.every((entry) => archiveSelected.has(entry.sessionId))
      const totalScanSize = (scan?.rows ?? []).reduce((sum, row) => sum + (row.sizeBytes || 0), 0)

      const tabBar = h('div', {
        role: 'tablist',
        'aria-label': tr('section.title'),
        style: {
          display: 'flex', alignItems: 'stretch', gap: '2px',
          borderBottom: '1px solid var(--dsw-alias-border-l1)', minWidth: 0,
        },
      }, [
        { key: 'migrate', label: tr('tab.migrate'), count: scan?.rows.length ?? 0 },
        { key: 'archive', label: tr('tab.archive'), count: archiveEntries.length },
      ].map((tab) => {
        const active = activeTab === tab.key
        return h('button', {
          key: tab.key,
          type: 'button',
          role: 'tab',
          'aria-selected': active,
          onClick: () => {
            setActiveTab(tab.key)
            setConfirmation(null)
            if (tab.key === 'archive' && archive === null) void loadArchive()
          },
          style: {
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            height: '34px', padding: '0 12px', border: 'none', borderRadius: '6px 6px 0 0',
            borderBottom: active ? '2px solid var(--dsw-alias-brand-primary)' : '2px solid transparent',
            background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
            font: 'inherit', fontSize: '12px', lineHeight: '18px',
            cursor: 'pointer', whiteSpace: 'nowrap',
          },
        }, tab.label, tab.count > 0 ? h('span', {
          style: { fontSize: '10px', color: 'var(--dsw-alias-label-secondary)', fontWeight: 400 },
        }, `(${tab.count})`) : null)
      }))

      let scanBody = null
      if (scan !== null) {
        if (scan.rows.length === 0) {
          scanBody = h('div', { style: { ...GUIDE_STYLE, padding: '6px 0' } }, tr('migrate.empty'))
        } else {
          scanBody = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', fontSize: '12px' } },
              h('span', null, tr('migrate.found', { count: scan.rows.length, size: formatSize(totalScanSize) })),
              scan.stats.protected > 0
                ? h('span', { style: { color: 'var(--dsw-alias-state-warn-label)' } }, tr('migrate.protected', { count: scan.stats.protected }))
                : null,
              scan.stats.live > 0
                ? h('span', { style: { color: 'var(--dsw-alias-state-warn-label)' } }, tr('migrate.live', { count: scan.stats.live }))
                : null,
              scan.stats.orphanSubagents > 0
                ? h('span', { style: { color: 'var(--dsw-alias-state-warn-label)' } }, tr('migrate.orphanSubagents', { count: scan.stats.orphanSubagents }))
                : null),
            showAllowMarked
              ? h('label', { style: { display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
                h('input', {
                  'data-session-migrator': 'checkbox',
                  type: 'checkbox',
                  checked: allowMarked,
                  onChange: (event) => {
                    setConfirmation(null)
                    setAllowMarked(event.target.checked)
                  },
                }),
                tr('migrate.allowMarked'))
              : null,
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              scanWorkspaceGroups.map((group) => h(WorkspaceSection, {
                key: group.key,
                group,
                tr,
                mode: 'scan',
                selected,
                onToggle: toggleSelected,
                isSelectable: scanSelectable,
                onToggleGroup: toggleGroup,
                // Workspace sections also start collapsed; the user opens the
                // workspace first, then the month they want to inspect.
                defaultOpen: false,
              }))),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
              h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, tr('migrate.selected', { count: selectedSize })),
              h(ActionButton, { label: tr('migrate.selectAll'), onClick: selectAll, disabled: scanning || busy !== null }),
              h(ActionButton, { label: tr('migrate.selectNone'), onClick: selectNone, disabled: scanning || busy !== null || selectedSize === 0 }),
              h(ActionButton, {
                label: tr('migrate.action'),
                kind: 'primary',
                disabled: selectedSize === 0 || busy !== null || scanning,
                onClick: requestMigrate,
              })))
        }
      }

      let archiveBody = null
      if (archiveLoading && archive === null) {
        archiveBody = h('div', { style: GUIDE_STYLE }, tr('common.loading'))
      } else if (archive !== null && archiveEntries.length === 0 && archivedWorkspaces.length === 0) {
        archiveBody = h('div', { style: { ...GUIDE_STYLE, padding: '4px 0' } }, tr('archive.empty'))
      } else if (archive !== null) {
        archiveBody = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', fontSize: '12px' } },
            h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, tr('archive.total', {
              count: archiveEntries.length,
              archived: archiveEntries.filter((entry) => entry.archived).length,
            })),
            archiveQueryText !== ''
              ? h('span', { style: { color: 'var(--dsw-alias-brand-primary)' } }, tr('archive.searchResult', {
                count: visibleArchiveEntries.length,
                total: archiveEntries.length,
              }))
              : null,
            lastBatchIds.length > 0
              ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
                h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, tr('archive.lastBatch', { count: lastBatchIds.length })),
                h(ActionButton, {
                  label: tr('migrate.undo'),
                  disabled: busy !== null,
                  onClick: () => requestRestore(lastBatchIds, 'undo'),
                }))
              : null),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
              h('input', {
                'data-session-migrator': 'checkbox',
                type: 'checkbox',
                checked: allArchiveSelected,
                disabled: restorableArchiveEntries.length === 0,
                onChange: () => {
                  setArchiveSelected(allArchiveSelected ? new Set() : new Set(restorableArchiveEntries.map((entry) => entry.sessionId)))
                },
              }),
              tr('archive.selectAll')),
            h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, tr('archive.selected', { count: archiveSelectedCount })),
            h(ActionButton, {
              label: tr('archive.restoreSelected'),
              disabled: archiveSelectedCount === 0 || busy !== null,
              onClick: () => requestRestore([...archiveSelected], 'restore'),
            })),
          archivedWorkspaces.length > 0
            ? h('div', {
              style: {
                display: 'flex', flexDirection: 'column', gap: '6px', padding: '4px 0',
                borderTop: '1px solid var(--dsw-alias-border-l1)',
              },
            },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              h('span', { style: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, tr('workspace.archivedTitle')),
              h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
                tr('workspace.count', { count: archivedWorkspaces.length }))),
            h('div', { style: { ...GUIDE_STYLE, fontSize: '11px' } }, tr('workspace.archivedGuide')),
            archivedWorkspaces.map((entry) => h(ArchivedWorkspaceRow, {
              key: entry.workspaceId,
              entry,
              tr,
              disabled: busy !== null,
              onRestore: () => requestWorkspaceRestore(entry),
            })))
            : null,
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            archiveQueryText !== '' && visibleArchiveEntries.length === 0
              ? h('div', { style: { ...GUIDE_STYLE, padding: '4px 0' } }, tr('archive.searchEmpty'))
              : archiveWorkspaceGroups.map((group) => h(WorkspaceSection, {
              key: group.key,
              group,
              tr,
              mode: 'archive',
              selected: archiveSelected,
              onToggle: toggleArchiveSelected,
              isSelectable: (row) => row.missing !== true && row.live !== true,
              onToggleGroup: (rows) => {
                setArchiveSelected((previous) => {
                  const next = new Set(previous)
                  const all = rows.length > 0 && rows.every((row) => next.has(row.sessionId))
                  for (const row of rows) {
                    if (all) next.delete(row.sessionId)
                    else next.add(row.sessionId)
                  }
                  return next
                })
              },
              defaultOpen: false,
            }))))
      }

      const confirmationBar = confirmation === null
        ? null
        : h('div', {
          role: 'alert',
          style: {
            position: 'sticky', top: 0, zIndex: 3, display: 'flex', alignItems: 'center', gap: '10px',
            padding: '10px 12px', borderRadius: '8px',
            background: 'var(--dsw-alias-bg-overlay)', border: '1px solid var(--dsw-alias-state-warn-primary)',
            boxShadow: '0 2px 10px rgba(0,0,0,0.12)', flexWrap: 'wrap',
          },
        },
        h('span', { style: { flex: 1, minWidth: '180px', fontSize: '12px' } },
          confirmation.kind === 'migrate'
            ? tr('migrate.confirm', { count: confirmation.count })
            : confirmation.kind === 'workspaceMigrate'
              ? tr('workspace.migrateConfirm', { title: confirmation.title, count: confirmation.count })
              : confirmation.kind === 'workspaceRestore'
                ? tr('workspace.restoreConfirm', { title: confirmation.title, count: confirmation.count })
                : tr('archive.confirm', { count: confirmation.count })),
        h(ActionButton, { label: tr('common.cancel'), onClick: () => setConfirmation(null) }),
        h(ActionButton, { label: tr('common.confirm'), kind: 'primary', onClick: () => void executeConfirmation() }))

      const noticeBar = notice === null
        ? null
        : h('div', {
          role: notice.kind === 'error' ? 'alert' : 'status',
          'aria-live': notice.kind === 'error' ? 'assertive' : 'polite',
          style: {
            position: 'sticky', top: 0, zIndex: 2,
            padding: '9px 12px', borderRadius: '8px', fontSize: '12px', lineHeight: '18px',
            border: '1px solid ' + (notice.kind === 'success'
              ? 'var(--dsw-alias-state-success-primary)'
              : notice.kind === 'partial'
                ? 'var(--dsw-alias-state-warn-primary)'
                : 'var(--dsw-alias-state-error-primary)'),
            color: notice.kind === 'success'
              ? 'var(--dsw-alias-state-success-primary)'
              : notice.kind === 'partial'
                ? 'var(--dsw-alias-state-warn-label)'
                : 'var(--dsw-alias-state-error-primary)',
            background: 'var(--dsw-alias-bg-layer-1)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          },
        }, notice.text, notice.detail ? `\n${notice.detail}` : '')

      const busyBar = progress === null
        ? null
        : h('div', {
          role: 'status',
          'aria-live': 'polite',
          style: {
            position: 'sticky', top: 0, zIndex: 2,
            padding: '9px 12px', borderRadius: '8px', fontSize: '12px', lineHeight: '18px',
            border: '1px solid var(--dsw-alias-border-l1)',
            color: 'var(--dsw-alias-label-secondary)',
            background: 'var(--dsw-alias-bg-layer-1)',
          },
        }, tr(progress.kind === 'migrate' ? 'migrate.working' : 'archive.working', {
          done: progress.done,
          total: progress.total,
        }))

      const scanCard = h('section', { style: CARD_STYLE },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
          h('h3', { style: H3_STYLE }, tr('migrate.title')),
          h('p', { style: GUIDE_STYLE }, tr('migrate.hint'))),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '12px' } }, tr('migrate.rangeLabel')),
          h('input', {
            type: 'number',
            min: 0,
            max: 120,
            step: 1,
            value: months,
            onChange: (event) => {
              const value = Number(event.target.value)
              setConfirmation(null)
              setMonths(Number.isFinite(value) ? Math.min(120, Math.max(0, Math.round(value))) : 0)
              setScan(null)
              setScanError(null)
            },
            disabled: scanning || busy !== null,
            style: {
              width: '64px', height: '28px', padding: '0 8px', boxSizing: 'border-box',
              borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
              font: 'inherit', fontSize: '12px',
            },
            'aria-label': tr('migrate.rangeLabel'),
          }),
          h('span', { style: { fontSize: '12px' } }, months === 0
            ? tr('migrate.allIncludingCurrent')
            : tr('migrate.monthsAgo', { count: months })),
          h(ActionButton, {
            label: scanning ? tr('migrate.scanning') : (scan === null ? tr('migrate.scan') : tr('migrate.rescan')),
            onClick: () => void runScan(months),
            kind: 'primary',
            disabled: scanning || busy !== null,
          })),
        h('div', { style: { ...GUIDE_STYLE, fontSize: '11px' } }, tr('migrate.rangeHint')),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, tr('migrate.presets')),
          [1, 3, 6, 0].map((preset) => h(ActionButton, {
            key: `preset-${preset}`,
            label: tr(preset === 0 ? 'migrate.presetAll' : `migrate.preset${preset}`),
            disabled: scanning || busy !== null,
            onClick: () => {
              setConfirmation(null)
              setMonths(preset)
              setScan(null)
              setScanError(null)
              void runScan(preset)
            },
          }))),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '12px' } }, tr('migrate.archiveRoot')),
          h('input', {
            type: 'text',
            value: archiveRoot,
            placeholder: archive?.defaultArchiveRoot ?? '',
            onChange: (event) => {
              setConfirmation(null)
              setArchiveRoot(event.target.value)
            },
            disabled: busy !== null,
            style: {
              flex: '1 1 320px', minWidth: '220px', height: '28px', padding: '0 8px', boxSizing: 'border-box',
              borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
              font: 'inherit', fontSize: '12px',
            },
            'aria-label': tr('migrate.archiveRoot'),
          }),
          h(ActionButton, {
            label: tr('migrate.archiveRootReset'),
            onClick: () => {
              setConfirmation(null)
              setArchiveRoot(archive?.defaultArchiveRoot ?? '')
            },
            disabled: busy !== null || archive?.defaultArchiveRoot === undefined || archiveRoot === archive?.defaultArchiveRoot,
          })),
        h('div', { style: { ...GUIDE_STYLE, fontSize: '11px' } }, tr('migrate.archiveRootHint', {
          path: archive?.defaultArchiveRoot ?? '',
        })),
        scanError !== null
          ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' } }, tr('common.error', { message: scanError }))
          : null,
        scanBody,
        scan !== null
          ? h(WorkspaceMigratePanel, {
            summaries: liveWorkspaceSummaries,
            tr,
            actionFor: workspaceActionFor,
            defaultOpen: false,
          })
          : null)

      const archiveCard = h('section', { style: CARD_STYLE },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '10px', flexWrap: 'wrap' } },
          h('div', { style: { flex: 1, minWidth: '220px', display: 'flex', flexDirection: 'column', gap: '3px' } },
            h('h3', { style: H3_STYLE }, tr('archive.title')),
            h('p', { style: GUIDE_STYLE }, tr('archive.guide'))),
          h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
            h(ActionButton, { label: tr('archive.refresh'), onClick: () => void loadArchive(), disabled: archiveLoading || busy !== null }),
            h(ActionButton, {
              label: tr('archive.restoreAll'),
              kind: 'primary',
              disabled: restorableArchiveEntries.length === 0 || busy !== null,
              onClick: () => requestRestore(restorableArchiveEntries.map((entry) => entry.sessionId), 'restoreAll'),
            }))),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('input', {
            type: 'search',
            value: archiveQuery,
            placeholder: tr('archive.searchPlaceholder'),
            onChange: (event) => setArchiveQuery(event.target.value),
            disabled: archive === null || archiveEntries.length === 0 || archiveLoading,
            autoComplete: 'off',
            spellCheck: false,
            style: {
              flex: '1 1 320px', minWidth: '220px', height: '30px', padding: '0 10px',
              boxSizing: 'border-box', borderRadius: '6px',
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-base)',
              color: 'var(--dsw-alias-label-primary)',
              font: 'inherit', fontSize: '12px',
            },
            'aria-label': tr('archive.searchPlaceholder'),
          }),
          archiveQueryText !== ''
            ? h(ActionButton, { label: tr('archive.searchClear'), onClick: () => setArchiveQuery('') })
            : null),
        archiveError !== null
          ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' } },
            tr('common.error', { message: archiveError }),
            ' ',
            h('button', {
              type: 'button',
              onClick: () => void loadArchive(),
              style: { ...buttonStyle(), height: '24px', padding: '0 8px', fontSize: '11px' },
            }, tr('common.retry')))
          : null,
        archiveBody)

      return h('div', {
        'data-session-migrator': 'page',
        style: {
          display: 'flex', flexDirection: 'column', gap: '16px', padding: '8px 0 24px',
          minWidth: 0, maxWidth: '760px', boxSizing: 'border-box',
          color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: '20px',
        },
      },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('h2', { style: { margin: 0, fontSize: '18px', lineHeight: '26px', fontWeight: 600 } }, tr('section.title')),
        h('p', { style: { ...GUIDE_STYLE, fontSize: '12px' } }, tr('page.guide'))),
      tabBar,
      confirmationBar,
      busyBar,
      noticeBar,
      activeTab === 'migrate' ? scanCard : archiveCard)
    }

    // Settings nav icon: an archive box with a left-pointing return arrow.
    function MigratorIcon() {
      return h('svg', {
        width: '16',
        height: '16',
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
      },
      h('path', {
        d: 'M2.5 3.5h11v2.2h-11zM3.4 5.7h9.2v7.3H3.4z',
        stroke: 'currentColor',
        strokeWidth: '1.2',
        strokeLinejoin: 'round',
      }),
      h('path', {
        d: 'M8.8 8.2H5.9m0 0 1.5-1.5M5.9 8.2l1.5 1.5',
        stroke: 'currentColor',
        strokeWidth: '1.2',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    // ── wiring ─────────────────────────────────────────────────────────────
    const inject = ['slots']

    function apply(ctx) {
      pluginCtx = ctx
      ctx.inject(['locale'], (localeCtx) => {
        localeCtx.effect(() => {
          const disposers = []
          try {
            disposers.push(localeCtx.locale.register(NS, 'zh', zh))
          } catch {
            // namespace already has Chinese copy
          }
          try {
            disposers.push(localeCtx.locale.register(NS, 'en', en))
          } catch {
            // namespace already has English copy
          }
          let unbind = () => {}
          try {
            boundT = localeCtx.locale.bind(NS)
            unbind = () => {
              boundT = undefined
            }
          } catch {
            boundT = undefined
          }
          return () => {
            unbind()
            for (const dispose of disposers.reverse()) {
              try {
                dispose()
              } catch {
                // idempotent
              }
            }
          }
        }, 'dsh-session-migrator: dictionaries')
      })

      ctx.effect(() => injectStyle(), 'dsh-session-migrator: style')

      const hasLocale = typeof ctx.get === 'function' && ctx.get('locale', false) !== undefined
      const withLocale = hasLocale ? { locale: NS } : {}

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: PACKAGE_NAME,
        order: 60,
        label: () => say('section.title'),
        ...withLocale,
      }, MigratorPage))

      ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
        name: 'settings.section.icon',
        id: PACKAGE_NAME,
        order: 60,
      }, MigratorIcon))
    }

    module.exports = {
      name: PACKAGE_NAME,
      inject,
      apply,
      __test: { archiveEntryMatches, groupRowsByWorkspace, WorkspaceMigratePanel, ArchivedWorkspaceRow },
    }
    return module.exports
  },
})
