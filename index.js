/**
 * dsh-session-migrator — move old sessions out of the DSH session list and
 * restore them later.
 *
 * The Host half owns the filesystem move and the archive index. The browser
 * half is a settings page under Settings → 会话迁移.
 *
 * Data layout, all under `$DSH_HOME/session-migrator/`:
 *   entries/<id>.json      one archive entry per migrated session
 *   workspaces/<id>.json   one restore entry per migrated workspace
 *   archive/<id>/          the whole original session directory
 *   state.json             last migration batch
 *
 * A session that was archived in DSH before migration stays archived after
 * restore because its id remains in `archivedSessionIds`. A workspace
 * registration is removed through `ctx.workspaceRegistry` when its whole set of
 * sessions is migrated, and recreated from `workspaces/<id>.json` on restore;
 * the project directory itself is never moved.
 * @module dsh-session-migrator
 */

import { join } from 'node:path'
import { resolveDshHome } from './lib/home.js'
import { createMigrateStore } from './lib/store.js'
import { createMover } from './lib/mover.js'
import { createSessionMigrator } from './lib/service.js'
import { createHandlers } from './lib/route.js'

export const name = 'dsh-session-migrator'

/**
 * Host entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host root context.
 */
export function apply(ctx) {
  const home = resolveDshHome()
  const store = createMigrateStore({
    root: join(home, 'session-migrator'),
    warn: (message) => ctx.logger?.warn?.(message),
  })

  ctx.inject(['sessionPersistence', 'sessions', 'workspaceRegistry', 'webServer'], (serviceCtx) => {
    const projectionCache = typeof serviceCtx.get === 'function'
      ? serviceCtx.get('sessionProjectionCache', false)
      : undefined
    const mover = createMover({
      store,
      warn: (message) => ctx.logger?.warn?.(message),
    })
    const service = createSessionMigrator({
      ctx: serviceCtx,
      persistence: serviceCtx.sessionPersistence,
      sessions: serviceCtx.sessions,
      workspaceRegistry: serviceCtx.workspaceRegistry,
      projectionCache,
      store,
      mover,
      marksFile: join(home, 'session-notes', 'records.json'),
      branchesFile: join(home, 'session-branch', 'records.json'),
      workspaceFile: join(home, 'storages', 'workspace.json'),
    })

    for (const route of createHandlers(serviceCtx, service)) {
      serviceCtx.effect(
        () => serviceCtx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
        `dsh-session-migrator: ${route.path}`,
      )
    }
  })
}
