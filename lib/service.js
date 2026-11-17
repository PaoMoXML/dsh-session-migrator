/**
 * The migration service behind the browser routes.
 * @module dsh-session-migrator/lib/service
 */

import { basename, dirname, isAbsolute } from 'node:path'
import { stat } from 'node:fs/promises'
import { readSessionBranches } from './branches.js'
import { readSessionNotes } from './marks.js'
import { readStoredWorkspaces } from './registry-file.js'
import {
  collectSubagentSnapshots,
  indexSubagentSnapshots,
  publicCandidate,
  scanOlderSessions,
  summarizeWorkspaces,
} from './scanner.js'
import {
  normalizeWorkspaceId,
  normalizeWorkspaceIds,
  restoreWorkspaceRegistration,
  snapshotWorkspace,
} from './workspace.js'

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
  if (/already exists|non-empty|missing|outside|not eligible|not in archive|protected|running|migratable/i.test(message)) return message
  return 'filesystem operation failed; see the Host log'
}

/** Whether a path exists as a directory. */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Shape one archived workspace for the browser.
 * @param {import('./store.js').ArchivedWorkspace} entry - stored entry.
 * @param {number} [missingSessions] - members whose archive directory is gone.
 * @returns {object} browser-facing workspace.
 */
function publicWorkspace(entry, missingSessions = 0) {
  return {
    workspaceId: entry.workspaceId,
    title: entry.title,
    path: entry.path,
    order: entry.order,
    sessionCount: entry.pending.length,
    totalSessions: entry.sessionIds.length,
    missingSessions,
    movedAt: entry.movedAt,
  }
}

/**
 * @param {object} options - service dependencies.
 * @param {any} options.ctx - Host context (logging).
 * @param {{ list(options?: { signal?: AbortSignal }): Promise<readonly any[]> }} options.persistence
 * @param {{ list(): any[], get(id: string): any }} options.sessions
 * @param {{
 *   readonly archivedSessionIds: readonly string[],
 *   list(): any[],
 *   get?(id: string): any,
 *   delete?(id: string): Promise<boolean>,
 *   create?(path: string, title?: string): Promise<any>,
 *   resolveByPath?(path: string): Promise<any>,
 *   insertBefore?(id: string, beforeId?: string): Promise<readonly string[]>,
 * }} options.workspaceRegistry
 * @param {{ cachedSnapshot?(header: any, keys?: readonly string[]): any } | undefined} options.projectionCache
 * @param {ReturnType<import('./store.js').createMigrateStore>} options.store
 * @param {ReturnType<import('./mover.js').createMover>} options.mover
 * @param {string} options.marksFile
 * @param {string} [options.branchesFile]
 * @param {string} [options.workspaceFile] - durable registry file, read-only
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

  /** The ordered Workspace registry entities; an absent method is an empty list. */
  function registryWorkspaces() {
    try {
      return typeof options.workspaceRegistry.list === 'function' ? options.workspaceRegistry.list() : []
    } catch (error) {
      log?.warn?.(`session-migrator: cannot list workspaces: ${String(error)}`)
      return []
    }
  }

  /** Durable workspace records from the registry file (a read-only aid). */
  async function storedWorkspaceRecords() {
    return readStoredWorkspaces(options.workspaceFile, (message) => log?.warn?.(message))
  }

  /** Archived session ids grouped by the workspace id recorded at migration. */
  function archivedByWorkspace(entries) {
    const grouped = new Map()
    for (const entry of entries) {
      const workspaceId = entry.workspaceId
      if (typeof workspaceId !== 'string' || workspaceId === '') continue
      if (!grouped.has(workspaceId)) grouped.set(workspaceId, [])
      grouped.get(workspaceId).push(entry.sessionId)
    }
    return grouped
  }

  /**
   * Complete membership of one workspace: the live registry projection, the
   * durable registry record (which still holds members the projection filters
   * out) and the sessions this plugin already archived for it.
   */
  function memberIdsOf(workspace, records, archivedIdsByWorkspace) {
    const workspaceId = String(workspace.id)
    const ids = []
    const seen = new Set()
    const sources = [
      workspace.sessionIds ?? [],
      records.get(workspaceId)?.sessionIds ?? [],
      archivedIdsByWorkspace.get(workspaceId) ?? [],
    ]
    for (const source of sources) {
      for (const raw of source) {
        const id = String(raw)
        if (seen.has(id)) continue
        seen.add(id)
        ids.push(id)
      }
    }
    return ids
  }

  /** Whether two id lists contain exactly the same ids (order ignored). */
  function sameIdSet(left, right) {
    if (left.length !== right.length) return false
    const known = new Set(left)
    return right.every((id) => known.has(id))
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

  /** One persistence-backed scan with the current marks and branches. */
  async function scanCandidates(settings) {
    return scanOlderSessions({
      persistence: options.persistence,
      sessions: options.sessions,
      workspaceRegistry: options.workspaceRegistry,
      workspaces: registryWorkspaces(),
      projectionCache: options.projectionCache,
      marks: settings.marks,
      branches: settings.branches,
      months: settings.months,
      includeBlank: settings.includeBlank === true,
      ...(settings.now === undefined ? {} : { now: settings.now }),
    })
  }

  async function scan(months) {
    const safeMonths = normalizeMonths(months)
    const marks = await loadMarks()
    const branches = await loadBranches()
    const result = await scanCandidates({ months: safeMonths, marks, branches })
    const entries = await options.store.list()
    const archivedIds = new Set(entries.map((entry) => entry.sessionId))
    const workspaces = registryWorkspaces()
    const records = await storedWorkspaceRecords()
    const byWorkspace = archivedByWorkspace(entries)
    const membership = new Map()
    for (const workspace of workspaces) {
      membership.set(String(workspace.id), memberIdsOf(workspace, records, byWorkspace))
    }
    return {
      now: result.now,
      cutoff: result.cutoff,
      rows: result.rows.map(publicCandidate),
      stats: result.stats,
      workspaces: summarizeWorkspaces({
        workspaces,
        sessionIdsByWorkspace: membership,
        snapshots: result.snapshots,
        sessions: options.sessions,
        marks,
        archivedIds,
      }),
    }
  }

  /**
   * Preflight blocks for a whole-workspace migration. `sessionIds` is the
   * complete durable membership; already-archived sessions are skipped and an
   * attached subagent whose ancestor is a member is covered by that ancestor's
   * cascade instead of being a separate target.
   * @param {any} plan - month-zero, blank-including scan result.
   * @param {string[]} sessionIds - complete membership.
   * @param {ReadonlySet<string>} archivedIds - sessions already in the archive.
   * @param {Record<string, import('./marks.js').SessionMark>} marks - note/todo table.
   * @param {boolean} allowMarked - whether marked sessions may move.
   * @returns {{ blocks: Array<{ sessionId: string, error: string }>, covered: Set<string> }} blocks and cascade-covered members.
   */
  function workspaceBlocks(plan, sessionIds, archivedIds, marks, allowMarked) {
    const byId = new Map(plan.rows.map((row) => [row.sessionId, row]))
    const headers = new Map(plan.snapshots.map((snapshot) => [String(snapshot.header.id), snapshot.header]))
    const subagentsByParent = indexSubagentSnapshots(plan.snapshots)
    const membership = new Set(sessionIds)
    const blocks = []
    const covered = new Set()

    /** First ancestor that is both a member and an actual migration target. */
    function coveringAncestor(id) {
      let current = headers.get(id)?.parentSession
      const seen = new Set([id])
      while (typeof current === 'string' && !seen.has(current)) {
        seen.add(current)
        if (membership.has(current) && byId.has(current)) return current
        current = headers.get(current)?.parentSession
      }
      return null
    }

    for (const sessionId of sessionIds) {
      if (archivedIds.has(sessionId)) continue
      if (headers.get(sessionId)?.origin === 'subagent') {
        if (coveringAncestor(sessionId) !== null) {
          covered.add(sessionId)
          continue
        }
        blocks.push({ sessionId, error: 'subagent member has no parent session inside this workspace' })
        continue
      }
      if (options.sessions.get(sessionId) !== undefined) {
        blocks.push({ sessionId, error: 'session is running' })
        continue
      }
      if (marks[sessionId] !== undefined && !allowMarked) {
        blocks.push({ sessionId, error: 'protected: carries a note or todo' })
        continue
      }
      const row = byId.get(sessionId)
      if (row === undefined) {
        blocks.push({ sessionId, error: 'session files are missing or the session is not migratable' })
        continue
      }
      for (const child of collectSubagentSnapshots(subagentsByParent, sessionId)) {
        const childId = String(child.header.id)
        if (marks[childId] !== undefined && !allowMarked) {
          blocks.push({ sessionId, error: `subagent ${childId} carries a note or todo` })
          break
        }
        if (options.sessions.get(childId) !== undefined) {
          blocks.push({ sessionId, error: `subagent ${childId} is running` })
          break
        }
        const childLocation = child.location?.path
        if (typeof childLocation !== 'string' || childLocation === '') {
          blocks.push({ sessionId, error: `subagent ${childId} has no stored location` })
          break
        }
      }
    }
    return { blocks, covered }
  }

  /**
   * Move one normalized session id list, cascading the subagent trees and
   * recording the undo batch. Used by both the ordinary and the whole-workspace
   * migration paths.
   * @param {string[]} ids - unique session ids.
   * @param {{ months: number, allowMarked: boolean, archiveRoot: string, workspaceMeta?: Map<string, object>, batchId?: string | null, includeBlank?: boolean, now?: number }} settings - batch settings.
   * @returns {Promise<{ migrated: string[], failed: Array<{ sessionId: string, error: string }>, relatedMigrated: number }>} result.
   */
  async function migrateIds(ids, settings) {
    const now = settings.now ?? Date.now()
    const marks = await loadMarks()
    const branches = await loadBranches()
    const candidates = await scanCandidates({
      months: settings.months,
      marks,
      branches,
      includeBlank: settings.includeBlank === true,
      now,
    })
    const byId = new Map(candidates.rows.map((row) => [row.sessionId, row]))
    const snapshots = candidates.snapshots
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
      if (row.mark !== null && !settings.allowMarked) {
        failed.push({ sessionId, error: 'protected: carries a note or todo' })
        continue
      }
      if (options.sessions.get(sessionId) !== undefined) {
        failed.push({ sessionId, error: 'session became live' })
        continue
      }
      const meta = settings.workspaceMeta?.get(sessionId) ?? null
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
        archiveDir: options.store.archiveDir(sessionId, settings.archiveRoot),
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
        if (marks[childId] !== undefined && !settings.allowMarked) {
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
        const childMeta = settings.workspaceMeta?.get(childId) ?? null
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
          archiveDir: options.store.archiveDir(childId, settings.archiveRoot),
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
        const batchId = typeof settings.batchId === 'string' && settings.batchId !== '' ? settings.batchId : null
        if (batchId !== null) await options.store.appendLastBatch(batchId, migrated, Date.now())
        else await options.store.setLastBatch({ ids: migrated, at: Date.now() })
      } catch (error) {
        log?.warn?.(`session-migrator: could not record the last batch: ${String(error)}`)
      }
    }
    return { migrated, failed, relatedMigrated }
  }

  async function migrate(request) {
    const months = normalizeMonths(request.months)
    const ids = normalizeSessionIds(request.sessionIds)
    const allowMarked = request.allowMarked === true
    const archiveRoot = await resolveArchiveRoot(request.archiveRoot)
    const workspaceMeta = normalizeWorkspaceMeta(request.workspaceMeta)
    const result = await migrateIds(ids, {
      months,
      allowMarked,
      archiveRoot,
      workspaceMeta,
      batchId: typeof request.batchId === 'string' && request.batchId !== '' ? request.batchId : null,
      includeBlank: false,
    })
    return result
  }

  /**
   * Put an interrupted whole-workspace migration back: restore every archived
   * directory that belongs to the given root sessions (children first).
   * @param {string[]} rootIds - root session ids moved by this operation.
   * @returns {Promise<{ restored: string[], failed: Array<{ sessionId: string, error: string }> }>} rollback result.
   */
  async function rollbackMovedSessions(rootIds) {
    const restored = []
    const failed = []
    if (rootIds.length === 0) return { restored, failed }
    const entries = await options.store.list()
    const entryById = new Map(entries.map((entry) => [entry.sessionId, entry]))
    const childrenByParent = new Map()
    for (const entry of entries) {
      if (typeof entry.parentSessionId !== 'string') continue
      if (!childrenByParent.has(entry.parentSessionId)) childrenByParent.set(entry.parentSessionId, [])
      childrenByParent.get(entry.parentSessionId).push(entry)
    }
    const targets = []
    const seen = new Set()
    const collect = (id) => {
      if (seen.has(id)) return
      seen.add(id)
      const entry = entryById.get(id)
      if (entry === undefined) return
      for (const child of childrenByParent.get(id) ?? []) collect(child.sessionId)
      targets.push(entry)
    }
    for (const id of rootIds) collect(id)
    for (const entry of targets) {
      try {
        await options.mover.restore(entry)
        restored.push(entry.sessionId)
      } catch (error) {
        log?.warn?.(`session-migrator: rollback ${entry.sessionId} failed: ${String(error)}`)
        failed.push({ sessionId: entry.sessionId, error: reasonOf(error) })
      }
    }
    return { restored, failed }
  }

  /**
   * Abort a whole-workspace migration after session directories moved: restore
   * them, then drop the restore recipe. When a directory cannot be put back the
   * recipe is kept (even though the registration is still live) because it is
   * the only record that can reattach those sessions later.
   * @param {{ entry: import('./store.js').ArchivedWorkspace, movedIds: string[], reasons: Array<{ sessionId: string, error: string }>, blocked: string }} input - abort inputs.
   * @returns {Promise<object>} browser-facing failure result.
   */
  async function abortWorkspaceMigration(input) {
    const rollback = await rollbackMovedSessions(input.movedIds)
    if (rollback.failed.length === 0) {
      await options.store.removeWorkspace(input.entry.workspaceId).catch(() => {})
    } else {
      await options.store.putWorkspace(input.entry).catch((error) => {
        log?.warn?.(`session-migrator: could not keep the restore recipe for ${input.entry.workspaceId}: ${String(error)}`)
      })
    }
    return {
      workspace: null,
      migrated: [],
      failed: [...input.reasons, ...rollback.failed],
      relatedMigrated: 0,
      blocked: input.blocked,
      rolledBack: rollback.restored.length,
      rollbackFailed: rollback.failed.length,
    }
  }

  /**
   * Move every session of one workspace out, then remove the workspace
   * registration and remember how to recreate it. The workspace stays when any
   * session is blocked or fails, so the registry never points at a partial
   * workspace; the project directory itself is never touched.
   * @param {{ workspaceId: string, allowMarked?: boolean, archiveRoot?: string, batchId?: string }} request - browser request.
   * @returns {Promise<object>} migration result plus the archived workspace, when removed.
   */
  async function migrateWorkspace(request) {
    const workspaceId = normalizeWorkspaceId(request.workspaceId)
    const allowMarked = request.allowMarked === true
    const archiveRoot = await resolveArchiveRoot(request.archiveRoot)
    const batchId = typeof request.batchId === 'string' && request.batchId !== '' ? request.batchId : null
    const workspaces = registryWorkspaces()
    const order = workspaces.findIndex((workspace) => String(workspace.id) === workspaceId)
    if (order < 0) throw new Error('workspace not found or already migrated')
    const workspace = workspaces[order]
    const archiveEntries = await options.store.list()
    const archivedIds = new Set(archiveEntries.map((entry) => entry.sessionId))
    const records = await storedWorkspaceRecords()
    const byWorkspace = archivedByWorkspace(archiveEntries)
    const sessionIds = memberIdsOf(workspace, records, byWorkspace)
    const marks = await loadMarks()
    const branches = await loadBranches()
    const plan = await scanCandidates({ months: 0, marks, branches, includeBlank: true })
    const onDisk = new Set(plan.snapshots.map((snapshot) => String(snapshot.header.id)))
    // A broken archive entry whose session is not on disk cannot return; keep
    // it out of the recipe so the entry can still finish and disappear.
    const brokenIds = new Set(archiveEntries.filter((entry) => entry.missing === true).map((entry) => entry.sessionId))
    const recipeIds = sessionIds.filter((sessionId) => !brokenIds.has(sessionId) || onDisk.has(sessionId))
    // The restore recipe is built before the destructive step. Sessions already
    // in the archive are carried; broken archive entries are not, because their
    // files cannot return.
    const carried = archiveEntries
      .filter((entry) => entry.missing !== true
        && (entry.workspaceId === workspaceId || recipeIds.includes(entry.sessionId)))
      .map((entry) => entry.sessionId)
    const entry = {
      ...snapshotWorkspace(workspace, order, workspaces.map((candidate) => String(candidate.id)), carried, recipeIds),
      movedAt: Date.now(),
    }
    const preflight = workspaceBlocks(plan, recipeIds, archivedIds, marks, allowMarked)
    if (preflight.blocks.length > 0) {
      return {
        workspace: null,
        migrated: [],
        failed: preflight.blocks,
        relatedMigrated: 0,
        blocked: 'workspace has sessions that cannot be migrated now',
        rolledBack: 0,
        rollbackFailed: 0,
      }
    }

    const pendingIds = recipeIds.filter((sessionId) => !archivedIds.has(sessionId) && !preflight.covered.has(sessionId))
    let result = { migrated: [], failed: [], relatedMigrated: 0 }
    if (pendingIds.length > 0) {
      result = await migrateIds(pendingIds, {
        months: 0,
        allowMarked,
        archiveRoot,
        batchId,
        includeBlank: true,
      })
    }
    if (result.failed.length > 0) {
      // Sessions that did move stay in the archive; retrying the workspace
      // picks them up from there instead of moving them twice.
      return {
        workspace: null,
        migrated: result.migrated,
        failed: result.failed,
        relatedMigrated: result.relatedMigrated,
        blocked: null,
        rolledBack: 0,
        rollbackFailed: 0,
      }
    }

    /** Complete membership as it is durably recorded right now. */
    async function membershipSnapshot() {
      const list = registryWorkspaces()
      const current = list.find((candidate) => String(candidate.id) === workspaceId)
      if (current === undefined) return null
      const freshEntries = await options.store.list()
      return memberIdsOf(current, await storedWorkspaceRecords(), archivedByWorkspace(freshEntries))
    }

    const afterMove = await membershipSnapshot()
    if (afterMove === null) {
      return abortWorkspaceMigration({
        entry,
        movedIds: result.migrated,
        reasons: [{ sessionId: workspaceId, error: 'workspace is no longer registered' }],
        blocked: 'workspace is no longer registered',
      })
    }
    if (!sameIdSet(afterMove, sessionIds)) {
      return abortWorkspaceMigration({
        entry,
        movedIds: result.migrated,
        reasons: [{ sessionId: workspaceId, error: 'workspace membership changed during migration' }],
        blocked: 'workspace membership changed during migration',
      })
    }

    await options.store.putWorkspace(entry)
    try {
      if (typeof options.workspaceRegistry.delete !== 'function') throw new Error('workspace registry cannot delete registrations')
      // Re-check immediately before the destructive step: an attach between the
      // first check and this one would otherwise vanish with the record.
      const finalIds = await membershipSnapshot()
      if (finalIds === null || !sameIdSet(finalIds, sessionIds)) {
        return abortWorkspaceMigration({
          entry,
          movedIds: result.migrated,
          reasons: [{ sessionId: workspaceId, error: 'workspace membership changed during migration' }],
          blocked: 'workspace membership changed during migration',
        })
      }
      await options.workspaceRegistry.delete(workspaceId)
    } catch (error) {
      const stillRegistered = registryWorkspaces().some((candidate) => String(candidate.id) === workspaceId)
      if (!stillRegistered) {
        // The delete committed but its bookkeeping reported a failure: the
        // workspace is gone and the recipe is the correct final state.
        log?.warn?.(`session-migrator: workspace ${workspaceId} was deleted but reported ${String(error)}`)
        return {
          workspace: publicWorkspace(entry),
          migrated: result.migrated,
          failed: [],
          relatedMigrated: result.relatedMigrated,
          blocked: null,
          rolledBack: 0,
          rollbackFailed: 0,
        }
      }
      return abortWorkspaceMigration({
        entry,
        movedIds: result.migrated,
        reasons: [{ sessionId: workspaceId, error: reasonOf(error) }],
        blocked: 'workspace registration could not be removed',
      })
    }

    return {
      workspace: publicWorkspace(entry),
      migrated: result.migrated,
      failed: [],
      relatedMigrated: result.relatedMigrated,
      blocked: null,
      rolledBack: 0,
      rollbackFailed: 0,
    }
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

    // A workspace entry whose registration is still present means the delete
    // step failed or the process died between the recipe write and the delete.
    // Keep the recipe when any of its sessions actually moved (it is the only
    // record that can reattach them); discard it only when nothing moved.
    const registeredIds = new Set(registryWorkspaces().map((workspace) => String(workspace.id)))
    const archivedSessionIds = new Set(entries.map((entry) => entry.sessionId))
    const missingSessionIds = new Set(entries.filter((entry) => entry.missing === true).map((entry) => entry.sessionId))
    const workspaces = []
    for (const entry of await options.store.listWorkspaces()) {
      const live = registeredIds.has(entry.workspaceId)
      if (live && !entry.pending.some((sessionId) => archivedSessionIds.has(sessionId))) {
        await options.store.removeWorkspace(entry.workspaceId).catch(() => {})
        continue
      }
      if (live) continue
      workspaces.push(publicWorkspace(
        entry,
        entry.sessionIds.filter((sessionId) => missingSessionIds.has(sessionId)).length,
      ))
    }

    const lastBatch = await options.store.getLastBatch()
    const lastBatchIds = lastBatch === null
      ? []
      : [...new Set(lastBatch.ids.map((id) => entryById.get(id)).filter(Boolean).map(visibleRootId))]
        .filter((id) => visibleIds.has(id))
    return {
      archiveRoot: await options.store.getArchiveRoot(),
      defaultArchiveRoot: options.store.defaultArchiveRoot,
      workspaces,
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

  /**
   * Move session trees back. Internal so both the ordinary restore and the
   * workspace restore can use it without triggering each other recursively.
   * @param {string[]} ids - session ids to restore.
   * @returns {Promise<{ restored: string[], failed: Array<{ sessionId: string, error: string }>, relatedRestored: number, restoredIds: Set<string> }>} result.
   */
  async function restoreIds(ids) {
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
    return { restored, failed, relatedRestored, restoredIds }
  }

  /**
   * Recreate one archived workspace registration and attach its sessions that
   * are on disk again. The entry shrinks to the sessions still in the archive
   * and disappears once none remain.
   * @param {import('./store.js').ArchivedWorkspace} entry - archived workspace.
   * @returns {Promise<object>} restore result.
   */
  async function restoreWorkspaceEntry(entry) {
    if (!(await isDirectory(entry.path))) throw new Error('workspace directory is missing')
    const storeEntries = await options.store.list()
    const healthyIds = new Set(storeEntries.filter((item) => item.missing !== true).map((item) => item.sessionId))
    const presentIds = new Set((await options.persistence.list()).map((snapshot) => String(snapshot.header.id)))
    const registration = await restoreWorkspaceRegistration({
      registry: options.workspaceRegistry,
      entry,
      presentIds,
    })
    const attached = new Set(registration.attached)
    const pending = new Set()
    for (const sessionId of entry.pending) {
      if (attached.has(sessionId)) continue
      // Broken archive entries cannot come back; a session already on disk
      // only needs the registration retry, not another directory move.
      if (healthyIds.has(sessionId) || presentIds.has(sessionId)) pending.add(sessionId)
    }
    // An attach failure on a session that is already back on disk keeps the
    // entry alive so an explicit workspace restore can retry it.
    for (const item of registration.skipped) pending.add(item.sessionId)
    if (pending.size === 0) {
      await options.store.removeWorkspace(entry.workspaceId)
    } else {
      await options.store.putWorkspace({ ...entry, pending: [...pending] })
    }
    return { ...registration, originalWorkspaceId: entry.workspaceId, remaining: pending.size }
  }

  /** Restore archived workspaces touched by the given restored session ids. */
  async function autoRestoreWorkspaces(restoredIds) {
    const restored = []
    const failures = []
    if (restoredIds.size === 0) return { restored, failures }
    for (const entry of await options.store.listWorkspaces()) {
      if (!entry.pending.some((sessionId) => restoredIds.has(sessionId))) continue
      try {
        restored.push(await restoreWorkspaceEntry(entry))
      } catch (error) {
        log?.warn?.(`session-migrator: restore workspace ${entry.workspaceId} failed: ${String(error)}`)
        failures.push({ workspaceId: entry.workspaceId, error: reasonOf(error) })
      }
    }
    return { restored, failures }
  }

  async function restore(request) {
    const ids = normalizeSessionIds(request.sessionIds)
    const result = await restoreIds(ids)
    const auto = await autoRestoreWorkspaces(result.restoredIds)
    return {
      restored: result.restored,
      failed: result.failed,
      relatedRestored: result.relatedRestored,
      workspacesRestored: auto.restored,
      workspaceFailures: auto.failures,
    }
  }

  /**
   * Restore whole archived workspaces: their remaining sessions first, then
   * each registration. Workspaces with no session left are still recreated.
   * @param {{ workspaceIds: string[] }} request - browser request.
   * @returns {Promise<object>} restore result.
   */
  async function restoreWorkspace(request) {
    const ids = normalizeWorkspaceIds(request.workspaceIds)
    const entries = await options.store.listWorkspaces()
    const byId = new Map(entries.map((entry) => [entry.workspaceId, entry]))
    const workspaceFailures = []
    const targets = []
    for (const workspaceId of ids) {
      const entry = byId.get(workspaceId)
      if (entry === undefined) workspaceFailures.push({ workspaceId, error: 'not in archive' })
      else targets.push(entry)
    }
    const sessionIds = await (async () => {
      const storeEntries = await options.store.list()
      const healthyIds = new Set(storeEntries.filter((item) => item.missing !== true).map((item) => item.sessionId))
      const presentIds = new Set((await options.persistence.list()).map((snapshot) => String(snapshot.header.id)))
      return [...new Set(targets.flatMap((entry) => entry.pending))]
        .filter((sessionId) => healthyIds.has(sessionId) && !presentIds.has(sessionId))
    })()
    const sessionResult = sessionIds.length > 0
      ? await restoreIds(sessionIds)
      : { restored: [], failed: [], relatedRestored: 0, restoredIds: new Set() }
    const workspacesRestored = []
    for (const entry of targets) {
      try {
        workspacesRestored.push(await restoreWorkspaceEntry(entry))
      } catch (error) {
        log?.warn?.(`session-migrator: restore workspace ${entry.workspaceId} failed: ${String(error)}`)
        // The directory may be gone while its sessions did come back; shrink
        // the recipe to what still needs a retry instead of reporting those
        // sessions as failures next time.
        const healthyNow = new Set((await options.store.list())
          .filter((item) => item.missing !== true)
          .map((item) => item.sessionId))
        const presentNow = new Set((await options.persistence.list()).map((snapshot) => String(snapshot.header.id)))
        const nextPending = [...new Set(entry.pending)]
          .filter((sessionId) => healthyNow.has(sessionId) || presentNow.has(sessionId))
        if (nextPending.length === 0) {
          await options.store.removeWorkspace(entry.workspaceId).catch(() => {})
        } else {
          await options.store.putWorkspace({ ...entry, pending: nextPending }).catch(() => {})
        }
        workspaceFailures.push({ workspaceId: entry.workspaceId, error: reasonOf(error) })
      }
    }
    return {
      restored: sessionResult.restored,
      failed: sessionResult.failed,
      relatedRestored: sessionResult.relatedRestored,
      workspacesRestored,
      workspaceFailures,
    }
  }

  return {
    scan: (months) => serialized(() => scan(months)),
    migrate: (request) => serialized(() => migrate(request)),
    archive: () => serialized(() => archive()),
    restore: (request) => serialized(() => restore(request)),
    migrateWorkspace: (request) => serialized(() => migrateWorkspace(request)),
    restoreWorkspace: (request) => serialized(() => restoreWorkspace(request)),
  }

  /** Serialize whole operations so two tabs cannot move the same session at once. */
  function serialized(operation) {
    const run = operationQueue.then(operation, operation)
    operationQueue = run.then(() => undefined, () => undefined)
    return run
  }
}