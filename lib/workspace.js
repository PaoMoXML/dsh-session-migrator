/**
 * DSH workspace-registration migration helpers.
 *
 * A workspace is a record in `$DSH_HOME/storages/workspace.json` that owns a
 * project directory and accounts the sessions started for it. The registry is
 * only mutated through `ctx.workspaceRegistry`, never by editing that file:
 * the running registry caches the record set and would overwrite an external
 * write on its next mutation.
 *
 * Archived workspace entries are written by `store.js`; this module recreates
 * the registration on restore and re-attaches the restored sessions. The
 * project directory itself is never moved.
 * @module dsh-session-migrator/lib/workspace
 */

/** Longest workspace id or session id accepted here. */
const MAX_ID_LENGTH = 200

/** Longest workspace-id list accepted by one request. */
export const MAX_WORKSPACE_BATCH = 200

/**
 * Validate one workspace id.
 * @param {unknown} value - raw id.
 * @returns {string} the id.
 */
export function normalizeWorkspaceId(value) {
  if (typeof value !== 'string' || value === '' || value.length > MAX_ID_LENGTH) {
    throw new Error('workspaceId must be a non-empty id')
  }
  if (value === '.' || value === '..') throw new Error('workspaceId must be a non-empty id')
  return value
}

/**
 * Normalize a requested workspace-id list.
 * @param {unknown} value - raw list.
 * @returns {string[]} unique valid ids, in request order.
 */
export function normalizeWorkspaceIds(value) {
  if (!Array.isArray(value)) throw new Error('workspaceIds must be an array')
  if (value.length > MAX_WORKSPACE_BATCH) throw new Error(`at most ${MAX_WORKSPACE_BATCH} workspace ids are accepted per request`)
  const ids = []
  const seen = new Set()
  for (const raw of value) {
    if (typeof raw !== 'string' || raw === '' || raw.length > MAX_ID_LENGTH) continue
    if (raw === '.' || raw === '..' || seen.has(raw)) continue
    seen.add(raw)
    ids.push(raw)
  }
  return ids
}

/**
 * Capture the durable facts needed to recreate one workspace registration
 * later. `workspaceIds` is a full order snapshot so a restore can find a
 * still-present successor even after unrelated workspaces came and went.
 * @param {any} workspace - registry entity.
 * @param {number} order - index in the registry order.
 * @param {readonly string[]} workspaceIds - the whole registry order.
 * @param {string[]} extraSessionIds - sessions of this workspace already in
 *   the archive from earlier migrations.
 * @param {readonly string[]} [baseSessionIds] - membership override; defaults
 *   to the registry projection.
 * @returns {Omit<import('./store.js').ArchivedWorkspace, 'movedAt'>} snapshot.
 */
export function snapshotWorkspace(workspace, order, workspaceIds, extraSessionIds = [], baseSessionIds = workspace.sessionIds ?? []) {
  const sessionIds = []
  const seen = new Set()
  for (const id of [...baseSessionIds, ...extraSessionIds]) {
    const value = String(id)
    if (seen.has(value)) continue
    seen.add(value)
    sessionIds.push(value)
  }
  return {
    workspaceId: String(workspace.id),
    path: workspace.path,
    title: typeof workspace.title === 'string' ? workspace.title : '',
    sessionIds,
    pending: [...sessionIds],
    order,
    workspaceIds: workspaceIds.map(String),
    createdAt: typeof workspace.createdAt === 'string' ? workspace.createdAt : null,
    updatedAt: typeof workspace.updatedAt === 'string' ? workspace.updatedAt : null,
  }
}

/**
 * Pick the id that a recreated workspace should be inserted before: the first
 * still-present successor from the migration-time order. Undefined means the
 * registry should append it.
 * @param {{ order: number, workspaceIds: string[] }} entry - archived entry.
 * @param {readonly string[]} currentIds - current registry order.
 * @param {string} workspaceId - the recreated workspace id.
 * @returns {string | undefined} anchor id.
 */
export function orderAnchor(entry, currentIds, workspaceId) {
  const start = Number.isFinite(entry.order) ? entry.order + 1 : 0
  const known = new Set(currentIds.map(String))
  for (let index = start; index < entry.workspaceIds.length; index += 1) {
    const candidate = String(entry.workspaceIds[index])
    if (candidate !== workspaceId && known.has(candidate)) return candidate
  }
  return undefined
}

/**
 * Recreate one workspace registration and attach the sessions that are back on
 * disk. Reuses a registration that already owns the same directory, so a
 * partial restore or a manually recreated workspace is never duplicated.
 * @param {object} input - restore inputs.
 * @param {any} input.registry - `ctx.workspaceRegistry`.
 * @param {import('./store.js').ArchivedWorkspace} input.entry - archived entry.
 * @param {ReadonlySet<string>} input.presentIds - session ids currently stored.
 * @returns {Promise<{ workspaceId: string, created: boolean, title: string, path: string, attached: string[], skipped: Array<{ sessionId: string, error: string }> }>} result.
 */
export async function restoreWorkspaceRegistration(input) {
  const registry = input.registry
  const entry = input.entry
  if (typeof registry?.create !== 'function') throw new Error('workspace registry cannot create registrations')
  const resolve = typeof registry.resolveByPath === 'function'
    ? async () => registry.resolveByPath(entry.path)
    : async () => undefined

  let workspace = await resolve()
  let created = false
  if (workspace === undefined) {
    workspace = await registry.create(entry.path)
    created = true
  }
  const workspaceId = String(workspace.id)

  if (entry.title !== '' && workspace.title !== entry.title && typeof workspace.setTitle === 'function') {
    await workspace.setTitle(entry.title)
  }

  if (created && typeof registry.insertBefore === 'function') {
    const currentIds = typeof registry.list === 'function' ? registry.list().map((item) => String(item.id)) : []
    await registry.insertBefore(workspaceId, orderAnchor(entry, currentIds, workspaceId))
  }

  const attached = []
  const skipped = []
  const wanted = entry.sessionIds.filter((id) => input.presentIds.has(id))
  // attachSession prepends, so walk backwards to leave the recorded order.
  for (const sessionId of [...wanted].reverse()) {
    try {
      if (typeof workspace.attachSession !== 'function') throw new Error('workspace registry cannot attach sessions')
      await workspace.attachSession(sessionId)
      attached.push(sessionId)
    } catch (error) {
      skipped.push({
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  attached.reverse()

  // A reused registration may already account other sessions. Moving the
  // recorded ids back into registry order (right to left) keeps the restored
  // workspace looking like the one that left. A fresh registration is already
  // in recorded order from the reverse attach above.
  if (!created && wanted.length > 1 && typeof workspace.insertSessionBefore === 'function') {
    const attachedSet = new Set(attached)
    const ordered = wanted.filter((id) => attachedSet.has(id))
    for (let index = ordered.length - 2; index >= 0; index -= 1) {
      try {
        await workspace.insertSessionBefore(ordered[index], ordered[index + 1])
      } catch {
        // Ordering is cosmetic; a registration write race must not fail restore.
      }
    }
  }

  return {
    workspaceId,
    created,
    title: typeof workspace.title === 'string' ? workspace.title : entry.title,
    path: entry.path,
    attached,
    skipped,
  }
}