/**
 * Durable archive index for migrated sessions.
 *
 * Session data itself is moved as whole per-session directories by `mover.js`.
 * This store owns only the metadata needed to list and restore them:
 *
 *   $DSH_HOME/session-migrator/
 *     entries/<encoded-session-id>.json   one self-contained entry per session
 *     archive/<encoded-session-id>/       the moved session directory
 *     state.json                          last migration batch and preferences
 *
 * Every entry is a separate file, so an interrupted batch loses at most the
 * not-yet-written entries; `list()` also reconciles the index with the
 * filesystem (an entry whose archive directory is gone but whose original
 * directory exists has already been restored and is dropped).
 * @module dsh-session-migrator/lib/store
 */

import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

/** Longest session id accepted by the routes. */
const MAX_SESSION_ID_LENGTH = 200

/** Safe path segment for a session id. */
export function safeSegment(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > MAX_SESSION_ID_LENGTH) {
    throw new Error('invalid session id')
  }
  if (sessionId === '.' || sessionId === '..') throw new Error('invalid session id')
  if (/^[A-Za-z0-9._-]+$/.test(sessionId)) return sessionId
  return encodeURIComponent(sessionId).replaceAll('%', '_').slice(0, MAX_SESSION_ID_LENGTH)
}

/**
 * @typedef {object} MigratedEntry
 * @property {string} sessionId
 * @property {string} title
 * @property {string | null} cwd
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {boolean} archived
 * @property {import('./marks.js').SessionMark | null} mark
 * @property {string | null} workspaceId
 * @property {string | null} workspaceTitle
 * @property {string | null} workspacePath
 * @property {number | null} workspaceOrder
 * @property {string | null} gitBranch
 * @property {boolean} gitBranchDetached
 * @property {string | null} gitHead
 * @property {string | null} parentSessionId
 * @property {string | null} origin
 * @property {number} delegationDepth
 * @property {boolean} isSeeded
 * @property {string} sessionRoot
 * @property {string} originalDir
 * @property {string} archiveDir
 * @property {number} movedAt
 * @property {number} sizeBytes
 */

/**
 * Narrow one stored entry.
 * @param {unknown} value - parsed JSON.
 * @returns {MigratedEntry | null} the entry, or null when malformed.
 */
export function readEntry(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = /** @type {Record<string, unknown>} */ (value)
  if (typeof record.sessionId !== 'string' || record.sessionId === '' || record.sessionId.length > MAX_SESSION_ID_LENGTH) return null
  if (typeof record.originalDir !== 'string' || !isAbsolute(record.originalDir)) return null
  if (typeof record.sessionRoot !== 'string' || !isAbsolute(record.sessionRoot)) return null
  if (record.archiveDir !== undefined && (typeof record.archiveDir !== 'string' || !isAbsolute(record.archiveDir))) return null
  if (typeof record.movedAt !== 'number' || !Number.isFinite(record.movedAt)) return null
  const mark = record.mark === null || record.mark === undefined ? null : readStoredMark(record.mark)
  return {
    sessionId: record.sessionId,
    title: typeof record.title === 'string' ? record.title : '',
    cwd: typeof record.cwd === 'string' ? record.cwd : null,
    createdAt: typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : 0,
    updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
    archived: record.archived === true,
    mark,
    workspaceId: typeof record.workspaceId === 'string' ? record.workspaceId : null,
    workspaceTitle: typeof record.workspaceTitle === 'string' ? record.workspaceTitle : null,
    workspacePath: typeof record.workspacePath === 'string' ? record.workspacePath : null,
    workspaceOrder: typeof record.workspaceOrder === 'number' && Number.isFinite(record.workspaceOrder) ? record.workspaceOrder : null,
    gitBranch: typeof record.gitBranch === 'string' ? record.gitBranch : null,
    gitBranchDetached: record.gitBranchDetached === true,
    gitHead: typeof record.gitHead === 'string' ? record.gitHead : null,
    parentSessionId: typeof record.parentSessionId === 'string' ? record.parentSessionId : null,
    origin: record.origin === 'subagent' ? 'subagent' : null,
    delegationDepth: typeof record.delegationDepth === 'number' && Number.isFinite(record.delegationDepth) ? record.delegationDepth : 0,
    isSeeded: record.isSeeded === true,
    sessionRoot: record.sessionRoot,
    originalDir: record.originalDir,
    archiveDir: typeof record.archiveDir === 'string' ? record.archiveDir : '',
    movedAt: record.movedAt,
    sizeBytes: typeof record.sizeBytes === 'number' && Number.isFinite(record.sizeBytes) ? record.sizeBytes : 0,
  }
}

/** Read only the display fields of a stored mark. */
function readStoredMark(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = /** @type {Record<string, unknown>} */ (value)
  if (record.kind !== 'todo' && record.kind !== 'note') return null
  return {
    kind: record.kind,
    text: typeof record.text === 'string' ? record.text : '',
    color: typeof record.color === 'string' ? record.color : 'slate',
    done: record.kind === 'todo' && record.done === true,
    updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
  }
}

/** Write JSON atomically (temporary file in the same directory, then rename). */
async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value), 'utf8')
    await rename(temporary, file)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch {
      // already gone
    }
    throw error
  }
}

/** Read one JSON file, or undefined. */
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
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
 * Open the archive index.
 * @param {{ root: string, warn?: (message: string) => void }} options - `root` is `$DSH_HOME/session-migrator`.
 */
export function createMigrateStore(options) {
  const root = options.root
  const entriesDir = join(root, 'entries')
  const defaultArchiveRoot = join(root, 'archive')
  const stateFile = join(root, 'state.json')
  const warn = options.warn ?? (() => {})

  /** Serializes read-modify-write batches in this process. */
  let queue = Promise.resolve()
  /** Entry-file path for one session id. */
  const entryFile = (sessionId) => join(entriesDir, `${safeSegment(sessionId)}.json`)
  /** Archive directory for one session id under a chosen root. */
  const archiveDir = (sessionId, archiveRoot = defaultArchiveRoot) => join(archiveRoot, safeSegment(sessionId))

  /** Normalize a configured archive root; absolute paths only. */
  function normalizeRoot(value) {
    if (typeof value !== 'string' || value.trim() === '' || !isAbsolute(value.trim())) return null
    return value.trim()
  }

  /** Read the configured archive root, falling back to the default. */
  async function configuredRoot() {
    try {
      const value = await readJson(stateFile)
      return normalizeRoot(value?.archiveRoot) ?? defaultArchiveRoot
    } catch {
      return defaultArchiveRoot
    }
  }

  /**
   * Read one entry file.
   * @param {string} file - entry file path.
   * @returns {Promise<MigratedEntry | null>} the entry, or null when missing/malformed.
   */
  async function readEntryFile(file) {
    try {
      return readEntry(await readJson(file))
    } catch (error) {
      warn(`session-migrator: cannot read archive entry ${file}: ${String(error)}`)
      return null
    }
  }

  return {
    root,
    entriesDir,
    defaultArchiveRoot,
    archiveDir,
    configuredRoot,

    /**
     * List every usable archive entry, reconciling the index with the
     * filesystem. A missing archive directory whose original directory is
     * present is a completed restore whose index deletion was interrupted; it
     * is removed and omitted.
     * @returns {Promise<Array<MigratedEntry & { missing?: boolean }>>} entries.
     */
    async list() {
      let names = []
      try {
        names = await readdir(entriesDir)
      } catch (error) {
        if (error?.code !== 'ENOENT') warn(`session-migrator: cannot list archive entries: ${String(error)}`)
        return []
      }
      const entries = []
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const file = join(entriesDir, name)
        const entry = await readEntryFile(file)
        if (entry === null) continue
        const entryArchiveDir = entry.archiveDir !== '' ? entry.archiveDir : archiveDir(entry.sessionId)
        const hasArchive = await isDirectory(entryArchiveDir)
        const hasOriginal = await isDirectory(entry.originalDir)
        if (!hasArchive && hasOriginal) {
          // Restore moved the directory back but the index removal was interrupted.
          try {
            await unlink(file)
          } catch {
            // another process may have cleaned it already
          }
          continue
        }
        entries.push(hasArchive ? { ...entry, archiveDir: entryArchiveDir } : { ...entry, archiveDir: entryArchiveDir, missing: true })
      }
      entries.sort((left, right) => right.movedAt - left.movedAt)
      return entries
    },

    /**
     * Insert or replace one entry.
     * @param {MigratedEntry} entry - the entry.
     * @returns {Promise<void>} completion.
     */
    put(entry) {
      const change = async () => {
        await writeJsonAtomic(entryFile(entry.sessionId), entry)
      }
      const result = queue.then(change, change)
      queue = result.then(() => undefined, () => undefined)
      return result
    },

    /**
     * Remove one entry file.
     * @param {string} sessionId - session id.
     * @returns {Promise<void>} completion.
     */
    remove(sessionId) {
      const change = async () => {
        try {
          await unlink(entryFile(sessionId))
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      }
      const result = queue.then(change, change)
      queue = result.then(() => undefined, () => undefined)
      return result
    },

    /**
     * Read one entry.
     * @param {string} sessionId - session id.
     * @returns {Promise<MigratedEntry | null>} the entry, or null.
     */
    async get(sessionId) {
      return readEntryFile(entryFile(sessionId))
    },

    /**
     * The archive root currently configured in `state.json`, or the default.
     * @returns {Promise<string>} absolute archive root.
     */
    async getArchiveRoot() {
      return configuredRoot()
    },

    /**
     * Persist a user-selected archive root.
     * @param {string} value - absolute directory path.
     * @returns {Promise<string>} the normalized root.
     */
    async setArchiveRoot(value) {
      const normalized = normalizeRoot(value)
      if (normalized === null) throw new Error('archiveRoot must be an absolute path')
      let previous = {}
      try {
        const state = await readJson(stateFile)
        if (state !== null && typeof state === 'object' && !Array.isArray(state)) previous = state
      } catch {
        // a corrupt state file is replaced by this explicit setting
      }
      await writeJsonAtomic(stateFile, { ...previous, archiveRoot: normalized })
      return normalized
    },

    /**
     * Record the last successful migration batch for the one-click undo button.
     * @param {{ ids: string[], at: number }} batch - batch data.
     * @returns {Promise<void>} completion.
     */
    async setLastBatch(batch) {
      let previous = {}
      try {
        const value = await readJson(stateFile)
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) previous = value
      } catch {
        // a corrupt state file is replaced by this explicit batch
      }
      await writeJsonAtomic(stateFile, { ...previous, lastBatch: batch })
    },

    /**
     * Append a chunk to one logical UI batch. Multiple 200-session requests
     * made by the same click share a `batchId`, so the one-click undo covers
     * the whole operation rather than only its last chunk.
     * @param {string} batchId - id generated by the browser for one operation.
     * @param {string[]} ids - successfully migrated sessions in this chunk.
     * @param {number} at - operation start time.
     * @returns {Promise<void>} completion.
     */
    async appendLastBatch(batchId, ids, at) {
      let state = {}
      let previous = null
      try {
        const value = await readJson(stateFile)
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          state = value
          previous = value.lastBatch ?? null
        }
      } catch (error) {
        warn(`session-migrator: cannot read the previous batch: ${String(error)}`)
      }
      const previousIds = previous !== null && previous.batchId === batchId && Array.isArray(previous.ids)
        ? previous.ids
        : []
      const merged = [...new Set([...previousIds.filter((id) => typeof id === 'string'), ...ids])]
      await writeJsonAtomic(stateFile, { ...state, lastBatch: { batchId, ids: merged, at } })
    },

    /**
     * Read the last migration batch, if any.
     * @returns {Promise<{ ids: string[], at: number, batchId?: string } | null>} the batch.
     */
    async getLastBatch() {
      try {
        const value = await readJson(stateFile)
        const batch = value?.lastBatch
        if (batch === null || batch === undefined) return null
        if (!Array.isArray(batch.ids) || typeof batch.at !== 'number') return null
        return {
          ids: batch.ids.filter((id) => typeof id === 'string'),
          at: batch.at,
          ...(typeof batch.batchId === 'string' ? { batchId: batch.batchId } : {}),
        }
      } catch (error) {
        warn(`session-migrator: cannot read archive state: ${String(error)}`)
        return null
      }
    },
  }
}
