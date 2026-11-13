/**
 * The migration service behind the browser routes.
 * @module dsh-session-migrator/lib/service
 */

import { isAbsolute } from 'node:path'
import { readSessionBranches } from './branches.js'
import { readSessionNotes } from './marks.js'
import { publicCandidate, scanOlderSessions } from './scanner.js'

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
    const migrated = []
    const failed = []
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
      try {
        await options.mover.migrate(entry, row.sourceDir)
        migrated.push(sessionId)
      } catch (error) {
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
    return { migrated, failed }
  }

  async function archive() {
    const marks = await loadMarks()
    const archived = new Set(options.workspaceRegistry.archivedSessionIds.map(String))
    const entries = await options.store.list()
    const lastBatch = await options.store.getLastBatch()
    return {
      archiveRoot: await options.store.getArchiveRoot(),
      defaultArchiveRoot: options.store.defaultArchiveRoot,
      lastBatch: lastBatch === null
        ? null
        : { ids: lastBatch.ids, at: lastBatch.at },
      entries: entries.map((entry) => ({
        sessionId: entry.sessionId,
        title: entry.title,
        cwd: entry.cwd,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        archived: archived.has(entry.sessionId),
        mark: marks[entry.sessionId] ?? entry.mark,
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
    const restored = []
    const failed = []
    for (const sessionId of ids) {
      let entry
      try {
        entry = await options.store.get(sessionId)
      } catch (error) {
        failed.push({ sessionId, error: reasonOf(error) })
        continue
      }
      if (entry === null) {
        failed.push({ sessionId, error: 'not in archive' })
        continue
      }
      try {
        await options.mover.restore(entry)
        restored.push(sessionId)
      } catch (error) {
        log?.warn?.(`session-migrator: restore ${sessionId} failed: ${String(error)}`)
        failed.push({ sessionId, error: reasonOf(error) })
      }
    }
    return { restored, failed }
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
