/**
 * Move whole per-session directories between the live sessions root and the
 * plugin archive, with the archive index written before the move.
 * @module dsh-session-migrator/lib/mover
 */

import { mkdir, rename, rmdir, stat, readdir } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

/** Whether a path exists (any type). */
async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Whether a path exists and is a directory. */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Whether a directory exists and contains at least one entry. */
async function isNonEmptyDirectory(path) {
  try {
    return (await readdir(path)).length > 0
  } catch {
    return false
  }
}

/**
 * Create the mover.
 * @param {{ store: ReturnType<import('./store.js').createMigrateStore>, warn?: (message: string) => void }} options
 */
export function createMover(options) {
  const store = options.store
  const warn = options.warn ?? (() => {})

  /** Guard that a directory is strictly under its recorded session root. */
  function assertInsideRoot(path, root) {
    const target = resolve(path)
    const base = resolve(root)
    if (!target.startsWith(base + sep) || target === base) {
      throw new Error('session directory is outside its recorded root')
    }
  }

  return {
    /**
     * Move one session directory into the archive.
     * @param {import('./store.js').MigratedEntry} entry - metadata to persist.
     * @param {string} sourceDir - current session directory.
     * @returns {Promise<string>} the archive directory.
     */
    async migrate(entry, sourceDir) {
      const target = entry.archiveDir !== '' ? entry.archiveDir : store.archiveDir(entry.sessionId)
      assertInsideRoot(sourceDir, entry.sessionRoot)
      if (resolve(target).startsWith(resolve(entry.sessionRoot) + sep)) throw new Error('archive directory must be outside the sessions root')
      if (!(await isDirectory(sourceDir))) throw new Error('session directory is missing')
      if (await pathExists(target)) throw new Error('archive directory already exists for this session')
      // Persist metadata first: a crash before the rename leaves an entry whose
      // archive is absent and whose original is present, which list() drops.
      await store.put(entry)
      try {
        await mkdir(dirname(target), { recursive: true })
        await rename(sourceDir, target)
      } catch (error) {
        await store.remove(entry.sessionId).catch(() => {})
        throw error
      }
      return target
    },

    /**
     * Move one archived session directory back to its original location.
     * @param {import('./store.js').MigratedEntry} entry - archive entry.
     * @returns {Promise<string>} the restored directory.
     */
    async restore(entry) {
      const source = entry.archiveDir !== '' ? entry.archiveDir : store.archiveDir(entry.sessionId)
      assertInsideRoot(entry.originalDir, entry.sessionRoot)
      if (!(await isDirectory(source))) throw new Error('archived session directory is missing')
      if (await pathExists(entry.originalDir)) {
        if (!(await isDirectory(entry.originalDir))) throw new Error('a file already exists at the original session path')
        if (await isNonEmptyDirectory(entry.originalDir)) throw new Error('a non-empty directory already exists at the original session path')
        // An earlier interrupted restore can leave an empty project/session shell.
        await rmdir(entry.originalDir)
      }
      await mkdir(dirname(entry.originalDir), { recursive: true })
      await rename(source, entry.originalDir)
      try {
        await store.remove(entry.sessionId)
      } catch (error) {
        // The rename already succeeded. The reconciliation in list() removes
        // this stale entry on the next load; losing the index update is safe.
        warn(`session-migrator: restored ${entry.sessionId} but could not remove its index entry: ${String(error)}`)
      }
      return entry.originalDir
    },
  }
}
