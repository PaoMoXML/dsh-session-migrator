/**
 * The migration service behind the browser routes.
 * @module dsh-session-migrator/lib/service
 */

import { basename, dirname, isAbsolute } from 'node:path'
import { readSessionBranches } from './branches.js'
import { readSessionNotes } from './marks.js'
import { collectSubagentSnapshots, indexSubagentSnapshots, publicCandidate, scanOlderSessions } from './scanner.js'

/** Longest session-id list accepted by one request. */
export const MAX_BATCH_SIZE = 500

/** Validate a whole-number month count; 0 means no age limit (includes this month). */
export function normalizeMonths(value) {
  const months = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(months) || months < 0 || months > 120) {
    throw new Error('months must be a whole number from 0 to 120')
  }
  return months
}

/** Normalize a requested session id list. */
export function normalizeSessionIds(value) {
  if (!Array.isArray(value)) throw new Error('sessionIds must be an array')
  if (value.length > MAX_BATCH_SIZE) throw new Error(`at most ${MAX_BATCH_SIZE} session ids are accepted per request`)
  const ids = []
  const seen = new Set()
  for (const raw of value) {
    if (typeof raw !== 'string' || raw === '' || raw.length > 200 || seen.has(raw)) continue
    seen.add(raw)
    ids.push(raw)
  }
  return ids
}

/** Normalize optional browser-supplied workspace metadata for one migration batch. */
export function normalizeWorkspaceMeta(value) {
  const result = new Map()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [sessionId, raw] of Object.entries(value)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const workspaceId = typeof raw.workspaceId === 'string' ? raw.workspaceId : null
    if (workspaceId === null) continue
    result.set(sessionId, {
      workspaceId,
      workspaceTitle: typeof raw.workspaceTitle === 'string' ? raw.workspaceTitle : null,
      workspacePath: typeof raw.workspacePath === 'string' ? raw.workspacePath : null,
      workspaceOrder: typeof raw.workspaceOrder === 'number' && Number.isFinite(raw.workspaceOrder) ? raw.workspaceOrder : null,
    })
  }
  return result
}

/** A short, path-free failure description for one session. */
function reasonOf(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/already exists|non-empty|missing|outside|not eligible|not in archive|protected/i.test(message)) return message
  return 'filesystem operation failed; see the Host log'
}

/**
 * @param {object} options - service dependencies.
 * @param {any} options.ctx - Host context (logging).
 * @param {{ list(options?: { signal?: AbortSignal }): Promise<readonly any[]> }} options.persistence
 * @param {{ list(): any[], get(id: string): any }} options.sessions
 * @param {{ readonly archivedSessionIds: readonly string[] }} options.workspaceRegistry
 * @param {{ cachedSnapshot?(header: any, keys?: readonly string[]): any } | undefined} options.projectionCache
 * @param {ReturnType<import('./store.js').createMigrateStore>} options.store
 * @param {ReturnType<import('./mover.js').createMover>} options.mover
 * @param {string} options.marksFile
 * @param {string} [options.branchesFile]
 */
export function createSessionMigrator(options) {
  const log = options.ctx?.logger
  /** Serializes whole migrate/restore/scan operations in this Host process. */
  let operationQueue = Promise.resolve()

  async function loadMarks() {
    const marks = await readSessionNotes(options.marksFile, (message) => log?.warn?.(message))
    if (marks === null) throw new Error('session-notes table is unreadable; migration refused')
    return marks
  }

  async function loadBranches() {
    return options.branchesFile === undefined
      ? {}
      : readSessionBranches(options.branchesFile, (message) => log?.warn?.(message))
  }

  /** Resolve a requested archive root, defaulting to the persisted setting. */
  async function resolveArchiveRoot(requested) {
    if (typeof requested === 'string' && requested.trim() !== '') {
      const value = requested.trim()
      if (!isAbsolute(value)) throw new Error('archiveRoot must be an absolute path')
      return options.store.setArchiveRoot(value)
    }
    return options.store.getArchiveRoot()
  }

  async function scan(months) {
    const safeMonths = normalizeMonths(months)
    const marks = await loadMarks()
    const branches = await loadBranches()
    const result = await scanOlderSessions({
      persistence: options.persistence,
      sessions: options.sessions,
      workspaceRegistry: options.workspaceRegistry,
      workspaces: typeof options.workspaceRegistry.list === 'function' ? options.workspaceRegistry.list() : [],
      projectionCache: options.projectionCache,
      marks,
      branches,
      months: safeMonths,
    })
    return {
      now: result.now,
      cutoff: result.cutoff,
      rows: result.rows.map(publicCandidate),
      stats: result.stats,
    }
  }

  async function migrate(request) {
    const months = normalizeMonths(request.months)
    const ids = normalizeSessionIds(request.sessionIds)
    const allowMarked = request.allowMarked === true
    const archiveRoot = await resolveArchiveRoot(request.archiveRoot)
    const workspaceMeta = normalizeWorkspaceMeta(request.workspaceMeta)
    const now = Date.now()
    const marks = await loadMarks()
    const branches = await loadBranches()
    const candidates = await scanOlderSessions({
      persistence: options.persistence,
      sessions: options.sessions,
      workspaceRegistry: options.workspaceRegistry,
      workspaces: typeof options.workspaceRegistry.list === 'function' ? options.workspaceRegistry.list() : [],
      projectionCache: options.projectionCache,
      marks,
      branches,
      months,
      now,
    })
    const byId = new Map(candidates.rows.map((row) => [row.sessionId, row]))
    const snapshots = await options.persistence.list()
    const subagentsByParent = indexSubagentSnapshots(snapshots)
    const archivedSet = new Set(options.workspaceRegistry.archivedSessionIds.map(String))
    const migrated = []
    const failed = []
    let relatedMigrated = 0
    for (const sessionId of ids) {
      const row = byId.get(sessionId)
      if (row === undefined) {
        failed.push({ sessionId, error: 'not eligible' })
        continue
      }
      if (row.mark !== null && !allowMarked) {
        failed.push({ sessionId, error: 'protected: carries a note or todo' })
        continue
      }
      if (options.sessions.get(sessionId) !== undefined) {
        failed.push({ sessionId, error: 'session became live' })
        continue
      }
      const meta = workspaceMeta.get(sessionId) ?? null
      const entry = {
        sessionId,
        title: row.title,
        cwd: row.cwd,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        archived: row.archived,
        mark: row.mark,
        subagentCount: row.subagentCount,
        workspaceId: row.workspaceId ?? meta?.workspaceId ?? null,
        workspaceTitle: row.workspaceTitle ?? meta?.workspaceTitle ?? null,
        workspacePath: row.workspacePath ?? meta?.workspacePath ?? null,
        workspaceOrder: typeof row.workspaceOrder === 'number' ? row.workspaceOrder : (meta?.workspaceOrder ?? null),
        gitBranch: row.gitBranch,
        gitBranchDetached: row.gitBranchDetached,
        gitHead: row.gitHead,
        parentSessionId: row.parentSessionId,
        origin: row.origin,
        delegationDepth: row.delegationDepth,
        isSeeded: row.isSeeded,
        sessionRoot: row.sessionRoot,
        originalDir: row.sourceDir,
        archiveDir: options.store.archiveDir(sessionId, archiveRoot),
        movedAt: Date.now(),
        sizeBytes: row.sizeBytes,
      }

      // Subagent sessions are stored as separate directories, so a parent
      // migration must move its entire descendant tree too; otherwise the
      // children become orphan root rows after their parent disappears.
      const descendants = collectSubagentSnapshots(subagentsByParent, sessionId)
      const childPlans = []
      let childBlocked = null
      for (const child of descendants) {
        const childHeader = child.header
        const childId = String(childHeader.id)
        if (marks[childId] !== undefined && !allowMarked) {
          childBlocked = `subagent ${childId} carries a note or todo`
          break
        }
        if (options.sessions.get(childId) !== undefined) {
          childBlocked = `subagent ${childId} is running`
          break
        }
        const childLocation = child.location?.path
        if (typeof childLocation !== 'string' || childLocation === '') {
          childBlocked = `subagent ${childId} has no stored location`
          break
        }
        const childSourceDir = dirname(childLocation)
        const childMeta = workspaceMeta.get(childId) ?? null
        let childCached
        try {
          childCached = options.projectionCache?.cachedSnapshot?.(childHeader, ['title'])
        } catch {
          childCached = undefined
        }
        const childValues = childCached?.values ?? {}
        const childTitle = typeof childValues.title === 'string' && childValues.title.trim() !== ''
          ? childValues.title
          : (basename(childHeader.cwd ?? '') || childId)
        const childEntry = {
          sessionId: childId,
          title: childTitle,
          cwd: childHeader.cwd ?? null,
          createdAt: childHeader.createdAt,
          updatedAt: childHeader.createdAt,
          archived: archivedSet.has(childId),
          mark: marks[childId] ?? null,
          subagentCount: 0,
          workspaceId: childMeta?.workspaceId ?? null,
          workspaceTitle: childMeta?.workspaceTitle ?? null,
          workspacePath: childMeta?.workspacePath ?? null,
          workspaceOrder: childMeta?.workspaceOrder ?? null,
          gitBranch: branches[childId]?.detached === true ? null : (branches[childId]?.branch ?? null),
          gitBranchDetached: branches[childId]?.detached === true,
          gitHead: branches[childId]?.head ?? null,
          parentSessionId: childHeader.parentSession ?? null,
          origin: 'subagent',
          delegationDepth: typeof childHeader.delegationDepth === 'number' ? childHeader.delegationDepth : 0,
          isSeeded: childHeader.isSeeded === true,
          sessionRoot: dirname(dirname(childSourceDir)),
          originalDir: childSourceDir,
          archiveDir: options.store.archiveDir(childId, archiveRoot),
          movedAt: Date.now(),
          sizeBytes: typeof child.sizeBytes === 'number' && Number.isFinite(child.sizeBytes) ? child.sizeBytes : 0,
        }
        childPlans.push({ entry: childEntry, sourceDir: childSourceDir })
      }
      if (childBlocked !== null) {
        failed.push({ sessionId, error: childBlocked })
        continue
      }
      entry.subagentCount = childPlans.length

      const moved = []
      try {
        await options.mover.migrate(entry, row.sourceDir)
        moved.push(entry)
        for (const plan of childPlans) {
          await options.mover.migrate(plan.entry, plan.sourceDir)
          moved.push(plan.entry)
        }
        migrated.push(sessionId)
        relatedMigrated += childPlans.length
      } catch (error) {
        for (const movedEntry of moved.reverse()) {
          try {
            await options.mover.restore(movedEntry)
          } catch (rollbackError) {
            log?.warn?.(`session-migrator: rollback ${movedEntry.sessionId} failed: ${String(rollbackError)}`)
          }
        }
        log?.warn?.(`session-migrator: migrate ${sessionId} failed: ${String(error)}`)
        failed.push({ sessionId, error: reasonOf(error) })
      }
    }
    if (migrated.length > 0) {
      try {
        const batchId = typeof request.batchId === 'string' && request.batchId !== '' ? request.batchId : null
        if (batchId !== null) await options.store.appendLastBatch(batchId, migrated, Date.now())
        else await options.store.setLastBatch({ ids: migrated, at: Date.now() })
      } catch (error) {
        log?.warn?.(`session-migrator: could not record the last batch: ${String(error)}`)
      }
    }
    return { migrated, failed, relatedMigrated }
  }

  async function archive() {
    const marks = await loadMarks()
    const archived = new Set(options.workspaceRegistry.archivedSessionIds.map(String))
    const liveIds = new Set(options.sessions.list().map((session) => String(session.id)))
    const entries = await options.store.list()
    const entryById = new Map(entries.map((entry) => [entry.sessionId, entry]))

    /** Whether an entry has a healthy archived subagent ancestor. */
    function hasArchivedAncestor(entry) {
      if (entry.origin !== 'subagent') return false
      let parentId = entry.parentSessionId
      const seen = new Set()
      while (typeof parentId === 'string' && !seen.has(parentId)) {
        seen.add(parentId)
        const parent = entryById.get(parentId)
        if (parent !== undefined) return parent.missing !== true
        parentId = null
      }
      return false
    }

    /** Count every healthy archived subagent below one archived parent. */
    function countArchivedChildren(entry) {
      let count = 0
      const seen = new Set()
      const walk = (parentId) => {
        if (seen.has(parentId)) return
        seen.add(parentId)
        for (const candidate of entries) {
          if (candidate.origin !== 'subagent' || candidate.parentSessionId !== parentId) continue
          count += 1
          walk(candidate.sessionId)
        }
      }
      walk(entry.sessionId)
      return count
    }

    const visibleEntries = entries.filter((entry) => entry.origin !== 'subagent' || !hasArchivedAncestor(entry))
    const visibleIds = new Set(visibleEntries.map((entry) => entry.sessionId))
    /** Map a hidden child's id to the visible parent entry that owns it. */
    function visibleRootId(entry) {
      let current = entry
      const seen = new Set()
      while (current.origin === 'subagent' && typeof current.parentSessionId === 'string' && !seen.has(current.sessionId)) {
        seen.add(current.sessionId)
        const parent = entryById.get(current.parentSessionId)
        if (parent === undefined || parent.missing === true) break
        current = parent
      }
      return current.sessionId
    }
    const lastBatch = await options.store.getLastBatch()
    const lastBatchIds = lastBatch === null
      ? []
      : [...new Set(lastBatch.ids.map((id) => entryById.get(id)).filter(Boolean).map(visibleRootId))]
        .filter((id) => visibleIds.has(id))
    return {
      archiveRoot: await options.store.getArchiveRoot(),
      defaultArchiveRoot: options.store.defaultArchiveRoot,
      lastBatch: lastBatch === null
        ? null
        : { ids: lastBatchIds, at: lastBatch.at },
      entries: visibleEntries.map((entry) => ({
        sessionId: entry.sessionId,
        title: entry.title,
        cwd: entry.cwd,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        archived: archived.has(entry.sessionId),
        mark: marks[entry.sessionId] ?? entry.mark,
        live: liveIds.has(entry.sessionId),
        orphanSubagent: entry.origin === 'subagent',
        subagentCount: countArchivedChildren(entry),
        workspaceId: entry.workspaceId,
        workspaceTitle: entry.workspaceTitle,
        workspacePath: entry.workspacePath,
        workspaceOrder: entry.workspaceOrder,
        gitBranch: entry.gitBranch,
        gitBranchDetached: entry.gitBranchDetached,
        gitHead: entry.gitHead,
        parentSessionId: entry.parentSessionId,
        origin: entry.origin,
        delegationDepth: entry.delegationDepth,
        isSeeded: entry.isSeeded,
        movedAt: entry.movedAt,
        sizeBytes: entry.sizeBytes,
        missing: entry.missing === true,
      })),
    }
  }

  async function restore(request) {
    const ids = normalizeSessionIds(request.sessionIds)
    const entries = await options.store.list()
    const entryById = new Map(entries.map((entry) => [entry.sessionId, entry]))
    const restored = []
    const restoredIds = new Set()
    const failed = []
    let relatedRestored = 0

    /** Collect the selected entry and every archived subagent below it. */
    function subtree(entry, seen = new Set()) {
      if (seen.has(entry.sessionId)) return []
      seen.add(entry.sessionId)
      const out = [entry]
      for (const candidate of entries) {
        if (candidate.origin !== 'subagent' || candidate.parentSessionId !== entry.sessionId) continue
        out.push(...subtree(candidate, seen))
      }
      return out
    }

    for (const sessionId of ids) {
      if (restoredIds.has(sessionId)) continue
      const entry = entryById.get(sessionId) ?? null
      if (entry === null) {
        failed.push({ sessionId, error: 'not in archive' })
        continue
      }
      const tree = subtree(entry)
      const missingTree = tree.filter((item) => item.missing === true)
      for (const item of missingTree) {
        failed.push({ sessionId: item.sessionId, error: 'archive files missing' })
      }
      const healthyTree = tree.filter((item) => item.missing !== true)
      let parentOk = false
      for (const item of healthyTree) {
        if (restoredIds.has(item.sessionId)) continue
        try {
          await options.mover.restore(item)
          restoredIds.add(item.sessionId)
          if (item.sessionId === sessionId) parentOk = true
          else relatedRestored += 1
        } catch (error) {
          log?.warn?.(`session-migrator: restore ${item.sessionId} failed: ${String(error)}`)
          failed.push({ sessionId: item.sessionId, error: reasonOf(error) })
        }
      }
      if (parentOk) restored.push(sessionId)
    }
    return { restored, failed, relatedRestored }
  }

  return {
    scan: (months) => serialized(() => scan(months)),
    migrate: (request) => serialized(() => migrate(request)),
    archive: () => serialized(() => archive()),
    restore: (request) => serialized(() => restore(request)),
  }

  /** Serialize whole operations so two tabs cannot move the same session at once. */
  function serialized(operation) {
    const run = operationQueue.then(operation, operation)
    operationQueue = run.then(() => undefined, () => undefined)
    return run
  }
}
