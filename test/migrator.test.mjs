/**
 * Synthetic-fixture tests for the host half. No real DSH session or profile
 * data is touched; every path is created under a fresh OS temp directory.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createMigrateStore } from '../lib/store.js'
import { createMover } from '../lib/mover.js'
import { createSessionMigrator } from '../lib/service.js'
import { scanOlderSessions, subtractMonths, summarizeWorkspaces } from '../lib/scanner.js'

const DAY = 24 * 60 * 60 * 1000

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-migrator-test-'))
  const sessionsRoot = join(root, 'sessions')
  const project = join(sessionsRoot, '--project--')
  const sessionOne = join(project, 'session-one')
  const sessionTwo = join(project, 'session-two')
  const sessionChild = join(project, 'session-child')
  await mkdir(sessionOne, { recursive: true })
  await mkdir(sessionTwo, { recursive: true })
  await mkdir(sessionChild, { recursive: true })
  await writeFile(join(sessionOne, 'session.v4.jsonl.zstd'), 'one')
  await writeFile(join(sessionTwo, 'session.v4.jsonl.zstd'), 'two')
  await writeFile(join(sessionChild, 'session.v4.jsonl.zstd'), 'child')
  const migratedAt = Date.now() - 100 * DAY
  const snapshots = [
    {
      header: { version: 4, id: 'session-one', createdAt: migratedAt, cwd: 'E:\\demo\\project', isSeeded: false },
      location: { kind: 'jsonl', path: join(sessionOne, 'session.v4.jsonl.zstd') },
      sizeBytes: 3,
    },
    {
      header: { version: 4, id: 'session-two', createdAt: migratedAt, cwd: 'E:\\demo\\project', isSeeded: false },
      location: { kind: 'jsonl', path: join(sessionTwo, 'session.v4.jsonl.zstd') },
      sizeBytes: 3,
    },
    {
      header: {
        version: 4, id: 'session-child', createdAt: migratedAt, cwd: 'E:\\demo\\project',
        isSeeded: false, origin: 'subagent', parentSession: 'session-two', delegationDepth: 1,
      },
      location: { kind: 'jsonl', path: join(sessionChild, 'session.v4.jsonl.zstd') },
      sizeBytes: 5,
    },
  ]
  const projectionCache = {
    cachedSnapshot(header) {
      if (header.id === 'session-one') return { values: { title: '带待办的会话', sessionListMetadata: { blank: false, lastPromptAt: migratedAt + DAY } } }
      if (header.id === 'session-child') return { values: { title: '子代理会话' } }
      return { values: { title: '普通会话', sessionListMetadata: { blank: false, lastPromptAt: migratedAt + 2 * DAY } } }
    },
  }
  const store = createMigrateStore({ root: join(root, 'session-migrator') })
  const mover = createMover({ store })
  const service = createSessionMigrator({
    ctx: { logger: { warn: (message) => console.warn(message) } },
    persistence: { list: async () => snapshots },
    sessions: { list: () => [], get: () => undefined },
    workspaceRegistry: {
      archivedSessionIds: ['session-one'],
      list: () => [{ id: 'workspace-demo', title: 'Demo', path: 'E:\\demo\\project', sessionIds: ['session-one', 'session-two'] }],
    },
    projectionCache,
    store,
    mover,
    marksFile: join(root, 'session-notes', 'records.json'),
  })
  return { root, sessionsRoot, sessionOne, sessionTwo, sessionChild, store, service }
}

test('subtractMonths clamps the day of month', () => {
  const result = new Date(subtractMonths(new Date(2026, 2, 31).getTime(), 1))
  assert.equal(result.getMonth(), 1)
  assert.equal(result.getDate(), 28)
})

test('scan marks protected sessions and keeps them out by default', async () => {
  const fixture = await makeFixture()
  await mkdir(join(fixture.root, 'session-notes'), { recursive: true })
  await writeFile(join(fixture.root, 'session-notes', 'records.json'), JSON.stringify({
    'session-one': { kind: 'todo', text: '记得验证', color: 'amber', done: false, updatedAt: 1 },
  }))
  const scan = await fixture.service.scan(1)
  assert.equal(scan.rows.length, 2)
  const protectedRow = scan.rows.find((row) => row.sessionId === 'session-one')
  assert.equal(protectedRow.protected, true)
  assert.equal(protectedRow.mark.text, '记得验证')
  assert.equal(protectedRow.archived, true)
  assert.equal(protectedRow.workspaceId, 'workspace-demo')
  assert.equal(protectedRow.subagentCount, 0)
  assert.equal(scan.rows.find((row) => row.sessionId === 'session-two').subagentCount, 1)
  assert.equal(scan.stats.protected, 1)
})

test('migrate refuses protected sessions unless allowed, then archive and restore preserve state', async () => {
  const fixture = await makeFixture()
  await mkdir(join(fixture.root, 'session-notes'), { recursive: true })
  await writeFile(join(fixture.root, 'session-notes', 'records.json'), JSON.stringify({
    'session-one': { kind: 'note', text: '重要备注', color: 'sky', done: false, updatedAt: 1 },
  }))

  const denied = await fixture.service.migrate({ months: 1, sessionIds: ['session-one'], allowMarked: false })
  assert.deepEqual(denied.migrated, [])
  assert.match(denied.failed[0].error, /protected/)

  const migrated = await fixture.service.migrate({ months: 1, sessionIds: ['session-one', 'session-two'], allowMarked: true })
  assert.deepEqual(migrated.migrated.sort(), ['session-one', 'session-two'])
  assert.equal(migrated.relatedMigrated, 1)
  await assert.rejects(stat(fixture.sessionOne))
  await assert.rejects(stat(fixture.sessionTwo))
  await assert.rejects(stat(fixture.sessionChild))

  const archive = await fixture.service.archive()
  assert.equal(archive.entries.length, 2)
  const one = archive.entries.find((entry) => entry.sessionId === 'session-one')
  assert.equal(one.mark.text, '重要备注')
  assert.equal(one.archived, true)
  assert.equal(one.workspaceId, 'workspace-demo')
  assert.equal(one.workspaceTitle, 'Demo')
  assert.equal(archive.entries.find((entry) => entry.sessionId === 'session-two').subagentCount, 1)
  assert.equal(archive.lastBatch.ids.length, 2)

  const restored = await fixture.service.restore({ sessionIds: ['session-one', 'session-two'] })
  assert.deepEqual(restored.restored.sort(), ['session-one', 'session-two'])
  assert.equal(restored.relatedRestored, 1)
  assert.equal((await stat(join(fixture.sessionOne, 'session.v4.jsonl.zstd'))).isFile(), true)
  assert.equal((await stat(join(fixture.sessionChild, 'session.v4.jsonl.zstd'))).isFile(), true)
  assert.equal((await fixture.service.archive()).entries.length, 0)
})

test('ordinary forks with a parentSession but no subagent origin stay root sessions', async () => {
  const old = Date.now() - 100 * DAY
  const snapshots = [
    {
      header: { version: 4, id: 'fork-parent', createdAt: old, cwd: 'E:\\demo\\project', isSeeded: false },
      location: { kind: 'jsonl', path: join(tmpdir(), 'dsh-session-migrator-fork-parent', 'session.v4.jsonl.zstd') },
      sizeBytes: 1,
    },
    {
      header: { version: 4, id: 'fork-child', createdAt: old, cwd: 'E:\\demo\\project', isSeeded: true, parentSession: 'fork-parent' },
      location: { kind: 'jsonl', path: join(tmpdir(), 'dsh-session-migrator-fork-child', 'session.v4.jsonl.zstd') },
      sizeBytes: 1,
    },
  ]
  const result = await scanOlderSessions({
    persistence: { list: async () => snapshots },
    sessions: { list: () => [], get: () => undefined },
    workspaceRegistry: { archivedSessionIds: [] },
    projectionCache: {
      cachedSnapshot: (header) => ({ values: { title: header.id, sessionListMetadata: { blank: false, lastPromptAt: old } } }),
    },
    marks: {},
    branches: {},
    months: 1,
    now: Date.now(),
  })
  assert.deepEqual(result.rows.map((row) => row.sessionId).sort(), ['fork-child', 'fork-parent'])
  assert.equal(result.rows.find((row) => row.sessionId === 'fork-parent').subagentCount, 0)
  assert.equal(result.rows.find((row) => row.sessionId === 'fork-child').orphanSubagent, false)
})

test('cascade migration does not treat an unmarked subagent as marked', async () => {
  const fixture = await makeFixture()
  const migrated = await fixture.service.migrate({ months: 1, sessionIds: ['session-two'], allowMarked: false })
  assert.deepEqual(migrated.migrated, ['session-two'])
  assert.equal(migrated.relatedMigrated, 1)
  await assert.rejects(stat(fixture.sessionTwo))
  await assert.rejects(stat(fixture.sessionChild))
})

test('scan includes live and orphan subagent sessions but excludes attached subagent, blank and no-cwd sessions', async () => {
  const fixture = await makeFixture()
  const old = Date.now() - 100 * DAY
  const snapshots = [
    { header: { version: 4, id: 'live', createdAt: old, cwd: 'E:\\x', isSeeded: false }, location: { kind: 'jsonl', path: join(fixture.sessionOne, 'x') } },
    { header: { version: 4, id: 'child', createdAt: old, cwd: 'E:\\x', isSeeded: false, origin: 'subagent' }, location: { kind: 'jsonl', path: join(fixture.sessionOne, 'x') } },
    { header: { version: 4, id: 'blank', createdAt: old, cwd: 'E:\\x', isSeeded: false }, location: { kind: 'jsonl', path: join(fixture.sessionOne, 'x') } },
    { header: { version: 4, id: 'nocwd', createdAt: old, isSeeded: false }, location: { kind: 'jsonl', path: join(fixture.sessionOne, 'x') } },
  ]
  const result = await scanOlderSessions({
    persistence: { list: async () => snapshots },
    sessions: { list: () => [{ id: 'live' }], get: () => ({ id: 'live' }) },
    workspaceRegistry: { archivedSessionIds: [] },
    projectionCache: {
      cachedSnapshot(header) {
        return { values: { title: header.id, sessionListMetadata: { blank: header.id === 'blank' } } }
      },
    },
    marks: {},
    months: 1,
    now: Date.now(),
  })
  assert.equal(result.rows.length, 2)
  assert.equal(result.rows.find((row) => row.sessionId === 'live').live, true)
  assert.equal(result.rows.find((row) => row.sessionId === 'child').orphanSubagent, true)
  assert.equal(result.stats.live, 1)
  assert.equal(result.stats.orphanSubagents, 1)
  assert.equal(result.stats.skippedLive, 0)
  assert.equal(result.stats.skippedSubagent, 0)
  assert.equal(result.stats.skippedBlank, 1)
  assert.equal(result.stats.skippedNoCwd, 1)
})

test('orphan subagent date comes from createdAt, not a rewritten file mtime', async () => {
  const fixture = await makeFixture()
  const old = Date.now() - 100 * DAY
  const location = join(fixture.sessionOne, 'orphan-child.zstd')
  await writeFile(location, 'orphan')
  const now = new Date()
  await utimes(location, now, now)
  const snapshots = [{
    header: {
      version: 4, id: 'orphan-child', createdAt: old, cwd: 'E:\\demo\\project',
      isSeeded: false, origin: 'subagent', parentSession: 'missing-parent', delegationDepth: 1,
    },
    location: { kind: 'jsonl', path: location },
    sizeBytes: 6,
  }]
  const result = await scanOlderSessions({
    persistence: { list: async () => snapshots },
    sessions: { list: () => [], get: () => undefined },
    workspaceRegistry: { archivedSessionIds: [] },
    // No sessionListMetadata: this is exactly the subagent projection shape.
    projectionCache: { cachedSnapshot: () => ({ values: { title: '孤儿子代理' } }) },
    marks: {},
    branches: {},
    months: 1,
    now: Date.now(),
  })
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].sessionId, 'orphan-child')
  assert.equal(result.rows[0].orphanSubagent, true)
  assert.equal(result.rows[0].updatedAt, old)
})

test('root session without projection metadata still uses file mtime', async () => {
  const fixture = await makeFixture()
  const old = Date.now() - 100 * DAY
  const location = join(fixture.sessionTwo, 'root-recent.zstd')
  await writeFile(location, 'root')
  const recentButOld = new Date(Date.now() - 50 * DAY)
  await utimes(location, recentButOld, recentButOld)
  const result = await scanOlderSessions({
    persistence: {
      list: async () => [{
        header: { version: 4, id: 'root-recent', createdAt: old, cwd: 'E:\\demo\\project', isSeeded: false },
        location: { kind: 'jsonl', path: location },
        sizeBytes: 4,
      }],
    },
    sessions: { list: () => [], get: () => undefined },
    workspaceRegistry: { archivedSessionIds: [] },
    projectionCache: { cachedSnapshot: () => ({ values: { title: '最近使用' } }) },
    marks: {},
    branches: {},
    months: 1,
    now: Date.now(),
  })
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].sessionId, 'root-recent')
  assert.ok(result.rows[0].updatedAt > old)
})

test('an interrupted restore index is reconciled on the next list', async () => {
  const fixture = await makeFixture()
  const migrated = await fixture.service.migrate({ months: 1, sessionIds: ['session-two'], allowMarked: true })
  assert.deepEqual(migrated.migrated, ['session-two'])
  // Simulate a restore that moved the directories but crashed before removing the index.
  const entry = await fixture.store.get('session-two')
  const childEntry = await fixture.store.get('session-child')
  const { rename } = await import('node:fs/promises')
  await rename(fixture.store.archiveDir('session-two'), entry.originalDir)
  await rename(fixture.store.archiveDir('session-child'), childEntry.originalDir)
  const archive = await fixture.service.archive()
  assert.equal(archive.entries.length, 0)
  assert.equal((await readFile(join(fixture.sessionTwo, 'session.v4.jsonl.zstd'), 'utf8')), 'two')
  assert.equal((await readFile(join(fixture.sessionChild, 'session.v4.jsonl.zstd'), 'utf8')), 'child')
})

test('chunks from one UI batch merge into one undo batch', async () => {
  const fixture = await makeFixture()
  await fixture.store.appendLastBatch('batch-1', ['session-one'], 100)
  await fixture.store.appendLastBatch('batch-1', ['session-two'], 100)
  assert.deepEqual((await fixture.store.getLastBatch()).ids, ['session-one', 'session-two'])
  await fixture.store.appendLastBatch('batch-2', ['session-three'], 200)
  assert.deepEqual((await fixture.store.getLastBatch()).ids, ['session-three'])
})

test('a custom archive root is honored and persists across the batch', async () => {
  const fixture = await makeFixture()
  const customRoot = join(fixture.root, 'custom-archive')
  const migrated = await fixture.service.migrate({
    months: 1,
    sessionIds: ['session-two'],
    allowMarked: true,
    archiveRoot: customRoot,
    batchId: 'batch-custom',
  })
  assert.deepEqual(migrated.migrated, ['session-two'])
  const entry = await fixture.store.get('session-two')
  assert.equal(entry.archiveDir, join(customRoot, 'session-two'))
  const archive = await fixture.service.archive()
  assert.equal(archive.archiveRoot, customRoot)
  await fixture.service.restore({ sessionIds: ['session-two'] })
  assert.equal((await stat(join(fixture.sessionTwo, 'session.v4.jsonl.zstd'))).isFile(), true)
})

test('months zero keeps a session active in the current month selectable', async () => {
  const now = Date.now()
  const result = await scanOlderSessions({
    persistence: {
      list: async () => [{
        header: { version: 4, id: 'current', createdAt: now - 20 * DAY, cwd: 'E:\\demo\\current', isSeeded: false },
        location: { kind: 'jsonl', path: join(tmpdir(), 'dsh-session-migrator-current', 'session.v4.jsonl.zstd') },
        sizeBytes: 1,
      }],
    },
    sessions: { list: () => [], get: () => undefined },
    workspaceRegistry: { archivedSessionIds: [] },
    projectionCache: {
      cachedSnapshot: () => ({ values: { title: '本月会话', sessionListMetadata: { blank: false, lastPromptAt: now } } }),
    },
    marks: {},
    branches: {},
    months: 0,
    now,
  })
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].sessionId, 'current')
})

/** In-memory stand-in for `ctx.workspaceRegistry` with the real mutation shape. */
function createFakeRegistry(initial = []) {
  const order = []
  const records = new Map()
  const controls = { onList: null, failDelete: null }
  let listCount = 0
  let sequence = 0

  function makeEntity(id, record) {
    const workspace = {
      id,
      path: record.path,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      sessionIds: record.sessionIds,
      async setTitle(title) {
        record.title = title
        workspace.title = title
      },
      async attachSession(sessionId) {
        if (record.sessionIds.includes(sessionId)) return
        record.sessionIds = [sessionId, ...record.sessionIds]
        workspace.sessionIds = record.sessionIds
      },
      async insertSessionBefore(sessionId, beforeSessionId) {
        const without = record.sessionIds.filter((candidate) => candidate !== sessionId)
        if (!without.includes(beforeSessionId)) throw new Error('anchor is not accounted')
        const at = without.indexOf(beforeSessionId)
        record.sessionIds = [...without.slice(0, at), sessionId, ...without.slice(at)]
        workspace.sessionIds = record.sessionIds
      },
      __addMember(sessionId) {
        if (record.sessionIds.includes(sessionId)) return
        record.sessionIds = [sessionId, ...record.sessionIds]
        workspace.sessionIds = record.sessionIds
      },
    }
    return workspace
  }

  for (const item of initial) {
    order.push(item.id)
    records.set(item.id, makeEntity(item.id, {
      path: item.path,
      title: item.title ?? '',
      createdAt: item.createdAt ?? new Date().toISOString(),
      updatedAt: item.updatedAt ?? new Date().toISOString(),
      sessionIds: [...(item.sessionIds ?? [])],
    }))
  }

  return {
    archivedSessionIds: [],
    __controls: controls,
    addMember(id, sessionId) {
      const workspace = records.get(id)
      if (workspace === undefined) return false
      workspace.__addMember(sessionId)
      return true
    },
    list() {
      listCount += 1
      if (typeof controls.onList === 'function') controls.onList(listCount)
      return order.map((id) => records.get(id))
    },
    get(id) {
      return records.get(id)
    },
    async delete(id) {
      if (controls.failDelete !== null) throw controls.failDelete
      if (!records.has(id)) return false
      records.delete(id)
      order.splice(order.indexOf(id), 1)
      return true
    },
    async create(path) {
      sequence += 1
      const id = `workspace-new-${sequence}`
      const now = new Date().toISOString()
      const entity = makeEntity(id, {
        path,
        title: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
        createdAt: now,
        updatedAt: now,
        sessionIds: [],
      })
      records.set(id, entity)
      order.unshift(id)
      return entity
    },
    async resolveByPath(path) {
      return order.map((id) => records.get(id)).find((workspace) => workspace.path === path)
    },
    async insertBefore(id, beforeId) {
      const without = order.filter((candidate) => candidate !== id)
      const at = beforeId === undefined ? without.length : without.indexOf(beforeId)
      if (at < 0) throw new Error('anchor is not registered')
      order.splice(0, order.length, ...without.slice(0, at), id, ...without.slice(at))
      return [...order]
    },
  }
}

async function makeWorkspaceFixture(options = {}) {
  const extraWorkspaces = options.extraWorkspaces ?? []
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-migrator-workspace-'))
  const project = join(root, 'project')
  await mkdir(project, { recursive: true })
  const sessionsRoot = join(root, 'sessions')
  const projectSessions = join(sessionsRoot, '--project--')
  const sessionOne = join(projectSessions, 'session-one')
  const sessionTwo = join(projectSessions, 'session-two')
  await mkdir(sessionOne, { recursive: true })
  await mkdir(sessionTwo, { recursive: true })
  await writeFile(join(sessionOne, 'session.v4.jsonl.zstd'), 'one')
  await writeFile(join(sessionTwo, 'session.v4.jsonl.zstd'), 'two')
  const old = Date.now() - 100 * DAY
  const snapshots = [
    {
      header: { version: 4, id: 'session-one', createdAt: old, cwd: project, isSeeded: false },
      location: { kind: 'jsonl', path: join(sessionOne, 'session.v4.jsonl.zstd') },
      sizeBytes: 3,
    },
    {
      header: { version: 4, id: 'session-two', createdAt: old, cwd: project, isSeeded: false },
      location: { kind: 'jsonl', path: join(sessionTwo, 'session.v4.jsonl.zstd') },
      sizeBytes: 3,
    },
  ]
  let sessionChild = null
  if (options.withSubagent === true) {
    sessionChild = join(projectSessions, 'session-child')
    await mkdir(sessionChild, { recursive: true })
    await writeFile(join(sessionChild, 'session.v4.jsonl.zstd'), 'child')
    snapshots.push({
      header: {
        version: 4, id: 'session-child', createdAt: old, cwd: project,
        isSeeded: false, origin: 'subagent', parentSession: 'session-one', delegationDepth: 1,
      },
      location: { kind: 'jsonl', path: join(sessionChild, 'session.v4.jsonl.zstd') },
      sizeBytes: 5,
    })
  }
  // The real persistence listing reflects the moved directories; stat each
  // recorded location so a restored session reappears in `presentIds`.
  const persistence = {
    async list() {
      const present = []
      for (const snapshot of snapshots) {
        try {
          await stat(snapshot.location.path)
          present.push(snapshot)
        } catch {
          // the directory is in the archive
        }
      }
      return present
    },
  }
  const memberIds = ['session-one', 'session-two']
  if (options.subagentMember === true) memberIds.unshift('session-child')
  const registry = createFakeRegistry([
    { id: 'workspace-demo', title: 'Demo', path: project, sessionIds: memberIds },
    ...extraWorkspaces,
  ])
  const store = createMigrateStore({ root: join(root, 'session-migrator') })
  const mover = createMover({ store })
  const marksFile = join(root, 'session-notes', 'records.json')
  let workspaceFile
  if (Array.isArray(options.storedMembers)) {
    workspaceFile = join(root, 'storages', 'workspace.json')
    await mkdir(dirname(workspaceFile), { recursive: true })
    await writeFile(workspaceFile, JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: ['workspace-demo'], archivedSessionIds: [], pinnedSessionIds: [] },
      tables: {
        workspaces: {
          'workspace-demo': {
            path: project,
            title: 'Demo',
            sessionIds: options.storedMembers,
            createdAt: new Date(old).toISOString(),
            updatedAt: new Date(old).toISOString(),
          },
        },
      },
    }), 'utf8')
  }
  const service = createSessionMigrator({
    ctx: { logger: { warn: () => {} } },
    persistence,
    sessions: { list: () => [], get: () => undefined },
    workspaceRegistry: registry,
    projectionCache: {
      cachedSnapshot: (header) => ({
        values: { title: header.id, sessionListMetadata: { blank: false, lastPromptAt: old } },
      }),
    },
    store,
    mover,
    marksFile,
    workspaceFile,
  })
  return { root, project, sessionsRoot, sessionOne, sessionTwo, sessionChild, snapshots, store, service, registry, marksFile, workspaceFile }
}

test('whole-workspace migration moves every session and removes the registration', async () => {
  const fixture = await makeWorkspaceFixture()
  const scan = await fixture.service.scan(0)
  assert.equal(scan.workspaces.length, 1)
  assert.equal(scan.workspaces[0].workspaceId, 'workspace-demo')
  assert.equal(scan.workspaces[0].total, 2)
  assert.equal(scan.workspaces[0].live, 0)
  assert.equal(scan.workspaces[0].marked, 0)
  assert.equal(scan.workspaces[0].missing, 0)

  const result = await fixture.service.migrateWorkspace({ workspaceId: 'workspace-demo' })
  assert.equal(result.blocked, null)
  assert.deepEqual(result.migrated.sort(), ['session-one', 'session-two'])
  assert.equal(result.workspace.workspaceId, 'workspace-demo')
  assert.equal(fixture.registry.list().length, 0)
  await assert.rejects(stat(fixture.sessionOne))
  await assert.rejects(stat(fixture.sessionTwo))

  const archive = await fixture.service.archive()
  assert.equal(archive.workspaces.length, 1)
  assert.equal(archive.workspaces[0].sessionCount, 2)
  assert.equal(archive.entries.length, 2)
  assert.equal(archive.lastBatch.ids.length, 2)
})

test('restoring a workspace recreates the registration and reattaches its sessions', async () => {
  const fixture = await makeWorkspaceFixture()
  await fixture.service.migrateWorkspace({ workspaceId: 'workspace-demo' })

  const restored = await fixture.service.restoreWorkspace({ workspaceIds: ['workspace-demo'] })
  assert.deepEqual(restored.restored.sort(), ['session-one', 'session-two'])
  assert.equal(restored.workspaceFailures.length, 0)
  assert.equal(restored.workspacesRestored.length, 1)
  assert.equal((await stat(join(fixture.sessionOne, 'session.v4.jsonl.zstd'))).isFile(), true)

  const workspaces = fixture.registry.list()
  assert.equal(workspaces.length, 1)
  assert.equal(workspaces[0].path, fixture.project)
  assert.equal(workspaces[0].title, 'Demo')
  assert.deepEqual(workspaces[0].sessionIds, ['session-one', 'session-two'])
  assert.equal((await fixture.service.archive()).workspaces.length, 0)
})

test('restoring one session of an archived workspace recreates the workspace and keeps the entry', async () => {
  const fixture = await makeWorkspaceFixture()
  await fixture.service.migrateWorkspace({ workspaceId: 'workspace-demo' })

  const first = await fixture.service.restore({ sessionIds: ['session-one'] })
  assert.equal(first.workspacesRestored.length, 1)
  let archive = await fixture.service.archive()
  assert.equal(archive.workspaces.length, 1)
  assert.equal(archive.workspaces[0].sessionCount, 1, 'one session is still archived')
  let workspaces = fixture.registry.list()
  assert.equal(workspaces.length, 1)
  assert.deepEqual(workspaces[0].sessionIds, ['session-one'])

  const second = await fixture.service.restore({ sessionIds: ['session-two'] })
  assert.equal(second.workspacesRestored.length, 1)
  archive = await fixture.service.archive()
  assert.equal(archive.workspaces.length, 0)
  workspaces = fixture.registry.list()
  assert.deepEqual(workspaces[0].sessionIds, ['session-one', 'session-two'])
})

test('whole-workspace migration is refused without moving when a session is protected', async () => {
  const fixture = await makeWorkspaceFixture()
  await mkdir(join(fixture.root, 'session-notes'), { recursive: true })
  await writeFile(fixture.marksFile, JSON.stringify({
    'session-one': { kind: 'todo', text: '保留', color: 'amber', done: false, updatedAt: 1 },
  }))

  const blocked = await fixture.service.migrateWorkspace({ workspaceId: 'workspace-demo' })
  assert.equal(blocked.blocked !== null, true)
  assert.equal(blocked.migrated.length, 0)
  assert.match(blocked.failed[0].error, /protected/)
  assert.equal(fixture.registry.list().length, 1)
  assert.equal((await stat(join(fixture.sessionOne, 'session.v4.jsonl.zstd'))).isFile(), true)

  const allowed = await fixture.service.migrateWorkspace({ workspaceId: 'workspace-demo', allowMarked: true })
  assert.equal(allowed.blocked, null)
  assert.deepEqual(allowed.migrated.sort(), ['session-one', 'session-two'])
  assert.equal(fixture.registry.list().length, 0)
})

test('a workspace holding already-migrated sessions is archived without blocking on their missing files', async () => {
  const fixture = await makeWorkspaceFixture()
  const first = await fixture.service.migrate({ months: 1, sessionIds: ['session-one'], allowMarked: true })
  assert.deepEqual(first.migrated, ['session-one'])

  const scan = await fixture.service.scan(0)
  assert.equal(scan.workspaces[0].total, 2)
  assert.equal(scan.workspaces[0].alreadyMigrated, 1)
  assert.equal(scan.workspaces[0].missing, 0)

  const result = await fixture.service.migrateWorkspace({ workspaceId: 'workspace-demo' })
  assert.equal(result.blocked, null)
  assert.deepEqual(result.migrated, ['session-two'])
  assert.equal(fixture.registry.list().length, 0)

  const archive = await fixture.service.archive()
  assert.equal(archive.workspaces.length, 1)
  assert.equal(archive.workspaces[0].sessionCount, 2)

  const restored = await fixture.service.restoreWorkspace({ workspaceIds: ['workspace-demo'] })
  assert.deepEqual(restored.restored.sort(), ['session-one', 'session-two'])
  assert.deepEqual(fixture.registry.list()[0].sessionIds, ['session-one', 'session-two'])
})

test('workspace summary counts a subagent note or todo', () => {
  const old = Date.now() - 100 * DAY
  const snapshots = [
    { header: { version: 4, id: 'root', createdAt: old, cwd: 'E:\\demo', isSeeded: false }, location: { kind: 'jsonl', path: 'root.zstd' } },
    {
      header: {
        version: 4, id: 'child', createdAt: old, cwd: 'E:\\demo',
        isSeeded: false, origin: 'subagent', parentSession: 'root',
      },
      location: { kind: 'jsonl', path: 'child.zstd' },
    },
  ]
  const summary = summarizeWorkspaces({
    workspaces: [{ id: 'workspace-demo', title: 'Demo', path: 'E:\\demo', sessionIds: ['root'] }],
    snapshots,
    sessions: { list: () => [] },
    marks: { child: { kind: 'todo', text: '子代理待办', color: 'amber', done: false, updatedAt: 1 } },
  })
  assert.equal(summary[0].marked, 1)
})

test('whole-workspace migration covers an attached subagent member through its parent', async () => {
  const fixture = await makeWorkspaceFixture({ withSubagent: true, subagentMember: true })
  const result = await fixture.service.migrateWorkspace({ workspaceId: 'workspace-demo' })
  assert.equal(result.blocked, null)
  assert.deepEqual(result.migrated.sort(), ['session-one', 'session-two'])
  assert.equal(result.relatedMigrated, 1)
  assert.equal(fixture.registry.list().length, 0)
  await assert.rejects(stat(fixture.sessionChild))

  const archive = await fixture.service.archive()
  assert.equal(archive.workspaces.length, 1)
  assert.equal(archive.workspaces[0].sessionCount, 3)

  const restored = await fixture.service.restoreWorkspace({ workspaceIds: ['workspace-demo'] })
  // The attached subagent is a member, so an explicit workspace restore reports
  // it too (through the parent's cascade) and attaches it back.
  assert.deepEqual(restored.restored.sort(), ['session-child', 'session-one', 'session-two'])
  assert.equal(restored.workspaceFailures.length, 0)
  assert.deepEqual(
    [...fixture.registry.list()[0].sessionIds].sort(),
    ['session-child', 'session-one', 'session-two'],
  )
})

test('a failing registration delete rolls the moved sessions back', async () => {
  const fixture = await makeWorkspaceFixture()
  fixture.registry.__controls.failDelete = new Error('delete exploded')

  const result = await fixture.service.migrateWorkspace({ workspaceId: 'workspace-demo' })
  assert.equal(result.workspace, null)
  assert.equal(result.blocked, 'workspace registration could not be removed')
  assert.equal(result.rolledBack, 2)
  assert.equal(result.rollbackFailed, 0)
  assert.equal(fixture.registry.list().length, 1)
  assert.equal((await fixture.service.archive()).workspaces.length, 0)
  assert.equal((await stat(join(fixture.sessionOne, 'session.v4.jsonl.zstd'))).isFile(), true)
  assert.equal((await stat(join(fixture.sessionTwo, 'session.v4.jsonl.zstd'))).isFile(), true)
})

test('a membership change during migration is rolled back instead of leaving a half-empty workspace', async () => {
  const fixture = await makeWorkspaceFixture()
  fixture.registry.__controls.onList = (count) => {
    if (count === 4) fixture.registry.addMember('workspace-demo', 'session-late')
  }

  const result = await fixture.service.migrateWorkspace({ workspaceId: 'workspace-demo' })
  assert.equal(result.blocked, 'workspace membership changed during migration')
  assert.equal(result.rolledBack, 2)
  assert.equal(result.rollbackFailed, 0)
  assert.equal(fixture.registry.list().length, 1)
  assert.equal((await fixture.service.archive()).workspaces.length, 0)
  assert.equal((await stat(join(fixture.sessionOne, 'session.v4.jsonl.zstd'))).isFile(), true)
  assert.deepEqual(
    [...fixture.registry.list()[0].sessionIds].sort(),
    ['session-late', 'session-one', 'session-two'],
  )
})

test('a broken archive entry is left out of the workspace recipe', async () => {
  const fixture = await makeWorkspaceFixture()
  await fixture.service.migrate({ months: 1, sessionIds: ['session-one'], allowMarked: true })
  // Simulate an externally lost archive directory without deleting anything.
  await rename(fixture.store.archiveDir('session-one'), join(fixture.root, 'lost-session-one'))

  const result = await fixture.service.migrateWorkspace({ workspaceId: 'workspace-demo' })
  assert.equal(result.blocked, null)
  assert.deepEqual(result.migrated, ['session-two'])
  const archive = await fixture.service.archive()
  assert.equal(archive.workspaces.length, 1)
  assert.equal(archive.workspaces[0].sessionCount, 1)
  const broken = archive.entries.find((entry) => entry.sessionId === 'session-one')
  assert.equal(broken.missing, true)

  const restored = await fixture.service.restoreWorkspace({ workspaceIds: ['workspace-demo'] })
  assert.equal(restored.workspaceFailures.length, 0)
  assert.equal((await fixture.service.archive()).workspaces.length, 0)
  assert.deepEqual(fixture.registry.list()[0].sessionIds, ['session-two'])
})

test('retrying a workspace restore after the project directory returns does not report restored sessions', async () => {
  const fixture = await makeWorkspaceFixture()
  await fixture.service.migrateWorkspace({ workspaceId: 'workspace-demo' })
  const movedProject = join(fixture.root, 'project-moved')
  await rename(fixture.project, movedProject)

  const first = await fixture.service.restoreWorkspace({ workspaceIds: ['workspace-demo'] })
  assert.deepEqual(first.restored.sort(), ['session-one', 'session-two'])
  assert.equal(first.failed.length, 0)
  assert.equal(first.workspaceFailures.length, 1)
  assert.match(first.workspaceFailures[0].error, /directory is missing/)
  assert.equal((await fixture.service.archive()).workspaces.length, 1)

  await rename(movedProject, fixture.project)
  const second = await fixture.service.restoreWorkspace({ workspaceIds: ['workspace-demo'] })
  assert.equal(second.failed.length, 0)
  assert.equal(second.workspaceFailures.length, 0)
  assert.equal(second.workspacesRestored.length, 1)
  assert.equal((await fixture.service.archive()).workspaces.length, 0)
  assert.deepEqual(
    [...fixture.registry.list()[0].sessionIds].sort(),
    ['session-one', 'session-two'],
  )
})

test('the durable workspace record contributes members the registry projection filters out', async () => {
  const fixture = await makeWorkspaceFixture({
    storedMembers: ['session-one', 'session-two', 'session-persisted-missing'],
  })
  const scan = await fixture.service.scan(0)
  assert.equal(scan.workspaces[0].total, 3)
  assert.equal(scan.workspaces[0].missing, 1)
  assert.equal(scan.workspaces[0].alreadyMigrated, 0)

  const blocked = await fixture.service.migrateWorkspace({ workspaceId: 'workspace-demo' })
  assert.equal(blocked.blocked, 'workspace has sessions that cannot be migrated now')
  assert.equal(blocked.migrated.length, 0)
  assert.equal(blocked.failed.length, 1)
  assert.equal(blocked.failed[0].sessionId, 'session-persisted-missing')
  assert.equal(fixture.registry.list().length, 1)
  assert.equal((await stat(join(fixture.sessionOne, 'session.v4.jsonl.zstd'))).isFile(), true)
})

test('a workspace with no sessions can still be archived and restored', async () => {
  const emptyPath = join(tmpdir(), `dsh-session-migrator-empty-${process.pid}`)
  await mkdir(emptyPath, { recursive: true })
  const fixture = await makeWorkspaceFixture({
    extraWorkspaces: [{ id: 'workspace-empty', title: 'Empty', path: emptyPath, sessionIds: [] }],
  })

  const migrated = await fixture.service.migrateWorkspace({ workspaceId: 'workspace-empty' })
  assert.equal(migrated.blocked, null)
  assert.deepEqual(migrated.migrated, [])
  assert.equal(fixture.registry.list().length, 1)

  const restored = await fixture.service.restoreWorkspace({ workspaceIds: ['workspace-empty'] })
  assert.equal(restored.workspaceFailures.length, 0)
  assert.equal(restored.workspacesRestored.length, 1)
  assert.equal(fixture.registry.list().length, 2)
  assert.equal((await fixture.service.archive()).workspaces.length, 0)
})
