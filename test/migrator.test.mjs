/**
 * Synthetic-fixture tests for the host half. No real DSH session or profile
 * data is touched; every path is created under a fresh OS temp directory.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMigrateStore } from '../lib/store.js'
import { createMover } from '../lib/mover.js'
import { createSessionMigrator } from '../lib/service.js'
import { scanOlderSessions, subtractMonths } from '../lib/scanner.js'

const DAY = 24 * 60 * 60 * 1000

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-migrator-test-'))
  const sessionsRoot = join(root, 'sessions')
  const project = join(sessionsRoot, '--project--')
  const sessionOne = join(project, 'session-one')
  const sessionTwo = join(project, 'session-two')
  await mkdir(sessionOne, { recursive: true })
  await mkdir(sessionTwo, { recursive: true })
  await writeFile(join(sessionOne, 'session.v4.jsonl.zstd'), 'one')
  await writeFile(join(sessionTwo, 'session.v4.jsonl.zstd'), 'two')
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
  ]
  const projectionCache = {
    cachedSnapshot(header) {
      if (header.id === 'session-one') return { values: { title: '带待办的会话', sessionListMetadata: { blank: false, lastPromptAt: migratedAt + DAY } } }
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
  return { root, sessionsRoot, sessionOne, sessionTwo, store, service }
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
  await assert.rejects(stat(fixture.sessionOne))
  await assert.rejects(stat(fixture.sessionTwo))

  const archive = await fixture.service.archive()
  assert.equal(archive.entries.length, 2)
  const one = archive.entries.find((entry) => entry.sessionId === 'session-one')
  assert.equal(one.mark.text, '重要备注')
  assert.equal(one.archived, true)
  assert.equal(one.workspaceId, 'workspace-demo')
  assert.equal(one.workspaceTitle, 'Demo')
  assert.equal(archive.lastBatch.ids.length, 2)

  const restored = await fixture.service.restore({ sessionIds: ['session-one', 'session-two'] })
  assert.deepEqual(restored.restored.sort(), ['session-one', 'session-two'])
  assert.equal((await stat(join(fixture.sessionOne, 'session.v4.jsonl.zstd'))).isFile(), true)
  assert.equal((await fixture.service.archive()).entries.length, 0)
})

test('scan skips live, subagent, blank and no-cwd sessions', async () => {
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
  assert.equal(result.rows.length, 0)
  assert.equal(result.stats.skippedLive, 1)
  assert.equal(result.stats.skippedSubagent, 1)
  assert.equal(result.stats.skippedBlank, 1)
  assert.equal(result.stats.skippedNoCwd, 1)
})

test('an interrupted restore index is reconciled on the next list', async () => {
  const fixture = await makeFixture()
  const migrated = await fixture.service.migrate({ months: 1, sessionIds: ['session-two'], allowMarked: true })
  assert.deepEqual(migrated.migrated, ['session-two'])
  // Simulate a restore that moved the directory but crashed before removing the index.
  const entry = await fixture.store.get('session-two')
  const { rename } = await import('node:fs/promises')
  await rename(fixture.store.archiveDir('session-two'), entry.originalDir)
  const archive = await fixture.service.archive()
  assert.equal(archive.entries.length, 0)
  assert.equal((await readFile(join(fixture.sessionTwo, 'session.v4.jsonl.zstd'), 'utf8')), 'two')
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
