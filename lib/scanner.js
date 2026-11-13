/**
 * Build the list of sessions that the migration UI may move.
 *
 * Visibility deliberately mirrors the shipped Session list: a session is a
 * candidate only when it has a cwd, is not a subagent child, is not currently
 * live in this Host, and is not blank. Recency uses the same
 * `sessionListMetadata.lastPromptAt` value the shipped list shows; without a
 * cached projection it falls back to the header's creation time.
 * @module dsh-session-migrator/lib/scanner
 */

import { basename, dirname } from 'node:path'
import { stat } from 'node:fs/promises'

/**
 * Subtract calendar months from an instant, clamping the day of month.
 * @param {number} now - epoch milliseconds.
 * @param {number} months - positive whole months.
 * @returns {number} the cutoff instant.
 */
export function subtractMonths(now, months) {
  const date = new Date(now)
  const day = date.getDate()
  date.setDate(1)
  date.setMonth(date.getMonth() - months)
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  date.setDate(Math.min(day, lastDay))
  return date.getTime()
}

/**
 * @typedef {object} Candidate
 * @property {string} sessionId
 * @property {string} title
 * @property {string | null} cwd
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {boolean} archived
 * @property {boolean} protected
 * @property {import('./marks.js').SessionMark | null} mark
 * @property {string | null} workspaceId
 * @property {string | null} workspaceTitle
 * @property {string | null} workspacePath
 * @property {number | null} workspaceOrder
 * @property {string | null} gitBranch
 * @property {boolean} gitBranchDetached
 * @property {string | null} gitHead
 * @property {string | null} parentSessionId
 * @property {'subagent' | null} origin
 * @property {number} delegationDepth
 * @property {boolean} isSeeded
 * @property {number} sizeBytes
 * @property {string} sourceDir
 * @property {string} sessionRoot
 */

/**
 * Collect every older, visible session.
 * @param {object} input - discovery inputs.
 * @param {{ list(options?: { signal?: AbortSignal }): Promise<readonly any[]> }} input.persistence - session persistence service.
 * @param {{ list(): any[], get(id: string): any }} input.sessions - live session store.
 * @param {{ readonly archivedSessionIds: readonly string[] }} input.workspaceRegistry - workspace registry.
 * @param {{ cachedSnapshot?(header: any, keys?: readonly string[]): { values?: Record<string, any> } | undefined } | undefined} input.projectionCache - projection cache.
 * @param {Record<string, import('./marks.js').SessionMark>} input.marks - session-notes table.
 * @param {Record<string, import('./branches.js').BranchRecord>} [input.branches] - session-branch table.
 * @param {readonly any[]} [input.workspaces] - ordered Workspace registry entries.
 * @param {number} input.months - age threshold in calendar months; 0 means no age limit.
 * @param {number} [input.now] - clock seam.
 * @returns {Promise<{ now: number, cutoff: number, rows: Candidate[], stats: object }>} scan result.
 */
export async function scanOlderSessions(input) {
  const now = input.now ?? Date.now()
  const cutoff = input.months === 0 ? Number.POSITIVE_INFINITY : subtractMonths(now, input.months)
  const archived = new Set(input.workspaceRegistry.archivedSessionIds.map(String))
  const live = new Set(input.sessions.list().map((session) => String(session.id)))
  const workspaceBySession = new Map()
  ;(input.workspaces ?? []).forEach((workspace, index) => {
    const workspaceId = typeof workspace.id === 'string'
      ? workspace.id
      : (typeof workspace.workspaceId === 'string' ? workspace.workspaceId : null)
    if (workspaceId === null) return
    for (const sessionId of workspace.sessionIds ?? []) {
      workspaceBySession.set(String(sessionId), {
        workspaceId,
        workspaceTitle: typeof workspace.title === 'string' ? workspace.title : null,
        workspacePath: typeof workspace.path === 'string' ? workspace.path : null,
        workspaceOrder: index,
      })
    }
  })
  const snapshots = await input.persistence.list()
  const rows = []
  const stats = {
    total: snapshots.length,
    older: 0,
    protected: 0,
    archived: 0,
    skippedLive: 0,
    skippedSubagent: 0,
    skippedBlank: 0,
    skippedNoCwd: 0,
    skippedNoLocation: 0,
  }
  for (const snapshot of snapshots) {
    const header = snapshot.header
    const sessionId = String(header.id)
    if (header.cwd === undefined) {
      stats.skippedNoCwd += 1
      continue
    }
    if (live.has(sessionId)) {
      stats.skippedLive += 1
      continue
    }
    if (header.origin === 'subagent') {
      stats.skippedSubagent += 1
      continue
    }
    const location = snapshot.location?.path
    if (typeof location !== 'string' || location === '') {
      stats.skippedNoLocation += 1
      continue
    }
    let cached
    try {
      cached = input.projectionCache?.cachedSnapshot?.(header, ['title', 'sessionListMetadata'])
    } catch {
      cached = undefined
    }
    const values = cached?.values ?? {}
    const metadata = values.sessionListMetadata
    let updatedAt = Math.max(
      header.createdAt,
      typeof metadata?.lastPromptAt === 'number' && Number.isFinite(metadata.lastPromptAt) ? metadata.lastPromptAt : 0,
    )
    // A missing projection cache row must not make a recently used but
    // long-created session look ancient. The session file's mtime is a cheap
    // last-write witness and is only consulted when the cache has no value.
    if (typeof metadata?.lastPromptAt !== 'number') {
      try {
        updatedAt = Math.max(updatedAt, (await stat(location)).mtimeMs)
      } catch {
        // keep the header-derived time
      }
    }
    if (updatedAt >= cutoff) continue
    if (metadata?.blank === true) {
      stats.skippedBlank += 1
      continue
    }
    const mark = input.marks[sessionId] ?? null
    const branch = input.branches?.[sessionId] ?? null
    const workspace = workspaceBySession.get(sessionId) ?? null
    const title = typeof values.title === 'string' && values.title.trim() !== ''
      ? values.title
      : (basename(header.cwd) || sessionId)
    const sourceDir = dirname(location)
    rows.push({
      sessionId,
      title,
      cwd: header.cwd,
      createdAt: header.createdAt,
      updatedAt,
      archived: archived.has(sessionId),
      protected: mark !== null,
      mark,
      workspaceId: workspace?.workspaceId ?? null,
      workspaceTitle: workspace?.workspaceTitle ?? null,
      workspacePath: workspace?.workspacePath ?? null,
      workspaceOrder: workspace?.workspaceOrder ?? null,
      gitBranch: branch?.detached === true ? null : (branch?.branch ?? null),
      gitBranchDetached: branch?.detached === true,
      gitHead: branch?.head ?? null,
      parentSessionId: header.parentSession ?? null,
      origin: header.origin ?? null,
      delegationDepth: typeof header.delegationDepth === 'number' ? header.delegationDepth : 0,
      isSeeded: header.isSeeded === true,
      sizeBytes: typeof snapshot.sizeBytes === 'number' && Number.isFinite(snapshot.sizeBytes) ? snapshot.sizeBytes : 0,
      sourceDir,
      sessionRoot: dirname(dirname(sourceDir)),
    })
  }
  stats.older = rows.length
  stats.protected = rows.filter((row) => row.protected).length
  stats.archived = rows.filter((row) => row.archived).length
  rows.sort((left, right) => right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId))
  return { now, cutoff, rows, stats }
}

/**
 * Shape one candidate for the browser. Internal filesystem fields stay on the
 * Host; the UI needs only display data and the id.
 * @param {Candidate} row - scan row.
 * @returns {object} the browser-facing row.
 */
export function publicCandidate(row) {
  return {
    sessionId: row.sessionId,
    title: row.title,
    cwd: row.cwd,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archived: row.archived,
    protected: row.protected,
    mark: row.mark,
    workspaceId: row.workspaceId,
    workspaceTitle: row.workspaceTitle,
    workspacePath: row.workspacePath,
    workspaceOrder: row.workspaceOrder,
    gitBranch: row.gitBranch,
    gitBranchDetached: row.gitBranchDetached,
    gitHead: row.gitHead,
    parentSessionId: row.parentSessionId,
    origin: row.origin,
    delegationDepth: row.delegationDepth,
    isSeeded: row.isSeeded,
    sizeBytes: row.sizeBytes,
  }
}
