/**
 * Read the session-notes plugin's mark table.
 *
 * The notes plugin owns `$DSH_HOME/session-notes/records.json`; this plugin
 * only reads it to protect marked sessions from an implicit migration and to
 * show the mark text in the restore list. An absent or malformed table means
 * "no marks", never a failed migration.
 * @module dsh-session-migrator/lib/marks
 */

import { readFile } from 'node:fs/promises'

const MARK_KINDS = new Set(['todo', 'note'])

/**
 * @typedef {object} SessionMark
 * @property {'todo' | 'note'} kind
 * @property {string} text
 * @property {string} color
 * @property {boolean} done
 * @property {number} updatedAt
 */

/**
 * Narrow one stored value to the fields this plugin displays.
 * @param {unknown} value - a parsed JSON value.
 * @returns {SessionMark | null} the mark, or null when malformed.
 */
export function readMark(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = /** @type {Record<string, unknown>} */ (value)
  if (typeof record.kind !== 'string' || !MARK_KINDS.has(record.kind)) return null
  return {
    kind: record.kind,
    text: typeof record.text === 'string' ? record.text : '',
    color: typeof record.color === 'string' ? record.color : 'slate',
    done: record.kind === 'todo' && record.done === true,
    updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
  }
}

/**
 * Read the whole mark table.
 *
 * A missing file means the session-notes plugin has never written a mark and
 * is safe to treat as an empty table. A present but unreadable/malformed file
 * returns `null`: migration must not silently treat marked sessions as
 * unmarked.
 * @param {string} file - path to session-notes records.json.
 * @param {(message: string) => void} [warn] - diagnostics sink.
 * @returns {Promise<Record<string, SessionMark> | null>} session id to mark.
 */
export async function readSessionNotes(file, warn = () => {}) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    warn(`session-migrator: cannot read the session-notes table: ${String(error)}`)
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    warn(`session-migrator: refusing to treat a malformed session-notes table as empty: ${String(error)}`)
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warn('session-migrator: refusing to treat a malformed session-notes table as empty')
    return null
  }
  const table = {}
  for (const [sessionId, value] of Object.entries(parsed)) {
    const mark = readMark(value)
    if (mark !== null) table[sessionId] = mark
  }
  return table
}
