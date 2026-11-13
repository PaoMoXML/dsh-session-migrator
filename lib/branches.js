/**
 * Read the session-branch plugin's Git branch table.
 *
 * That plugin owns `$DSH_HOME/session-branch/records.json`; this plugin only
 * displays the recorded branch in migration lists. A missing or malformed table
 * means "no branch recorded", never a failed scan.
 * @module dsh-session-migrator/lib/branches
 */

import { readFile } from 'node:fs/promises'

/**
 * @typedef {object} BranchRecord
 * @property {string | null} branch - branch name, or null when detached.
 * @property {boolean} detached
 * @property {string | null} head - short commit for a detached HEAD.
 */

/**
 * @param {string} file - path to session-branch records.json.
 * @param {(message: string) => void} [warn] - diagnostics sink.
 * @returns {Promise<Record<string, BranchRecord>>} session id to branch record.
 */
export async function readSessionBranches(file, warn = () => {}) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    warn(`session-migrator: cannot read the session-branch table: ${String(error)}`)
    return {}
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    warn(`session-migrator: ignoring a malformed session-branch table: ${String(error)}`)
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const table = {}
  for (const [sessionId, value] of Object.entries(parsed)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    if (typeof value.detached !== 'boolean') continue
    const branch = value.branch === null || typeof value.branch === 'string' ? value.branch : null
    const head = value.head === null || typeof value.head === 'string' ? value.head : null
    table[sessionId] = { branch, detached: value.detached, head }
  }
  return table
}
