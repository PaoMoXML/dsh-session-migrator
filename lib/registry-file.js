/**
 * Read-only view of the durable Workspace registry file.
 *
 * The live `ctx.workspaceRegistry` filters each entity's `sessionIds` through
 * its header index, so sessions that were moved out earlier (or whose header is
 * no longer listed) disappear from the public projection. Whole-workspace
 * statistics and preflight checks need the durable membership instead, so this
 * module reads `$DSH_HOME/storages/workspace.json` without ever writing it: all
 * mutations still go through the registry API.
 * @module dsh-session-migrator/lib/registry-file
 */

import { readFile } from 'node:fs/promises'

/**
 * @typedef {object} StoredWorkspaceRecord
 * @property {string[]} sessionIds - durable membership, including filtered ids
 * @property {string | null} path
 * @property {string | null} title
 */

/**
 * Read the durable workspace records. A missing or unreadable file yields an
 * empty map: callers fall back to the registry projection rather than failing
 * a migration on a read-only aid.
 * @param {string | undefined} file - absolute path to `workspace.json`.
 * @param {(message: string) => void} [warn] - log sink.
 * @returns {Promise<Map<string, StoredWorkspaceRecord>>} record id to record.
 */
export async function readStoredWorkspaces(file, warn = () => {}) {
  if (typeof file !== 'string' || file === '') return new Map()
  let value
  try {
    value = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`session-migrator: cannot read workspace registry ${file}: ${String(error)}`)
    return new Map()
  }
  const tables = value?.tables?.workspaces
  if (tables === null || typeof tables !== 'object' || Array.isArray(tables)) return new Map()
  const records = new Map()
  for (const [id, raw] of Object.entries(tables)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const rawSessionIds = Array.isArray(raw.sessionIds) ? raw.sessionIds : []
    const sessionIds = []
    const seen = new Set()
    for (const entry of rawSessionIds) {
      if (typeof entry !== 'string' || entry === '' || seen.has(entry)) continue
      seen.add(entry)
      sessionIds.push(entry)
    }
    records.set(id, {
      sessionIds,
      path: typeof raw.path === 'string' ? raw.path : null,
      title: typeof raw.title === 'string' ? raw.title : null,
    })
  }
  return records
}