/**
 * Browser-half smoke test: load the module factory with a tiny React stub.
 * This catches top-level reference errors and verifies the factory export shape.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

test('client module factory loads and exports apply', async () => {
  let spec
  globalThis.window = {
    __ModuleLoader__: {
      load(next) {
        spec = next
      },
    },
  }
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    head: { appendChild() {} },
  }
  const React = {
    createElement: () => ({}),
    useEffect: () => {},
    useState: (initial) => [initial, () => {}],
  }
  const requireStub = (id) => {
    if (id === 'react') return React
    throw new Error(`unexpected module: ${id}`)
  }
  await import('../client.js')
  assert.equal(typeof spec, 'object')
  assert.equal(spec.id, 'dsh-session-migrator')
  const module = spec.factory(requireStub)
  assert.equal(module.name, 'dsh-session-migrator')
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.inject, ['slots'])

  const matches = module.__test.archiveEntryMatches
  assert.equal(matches({ title: 'ePoint 会话' }, 'epoint'), true)
  assert.equal(matches({ cwd: 'E:\\EpointProject\\epoint-etrading-parent' }, 'epointproject'), true)
  assert.equal(matches({ workspaceTitle: '总控' }, '总控'), true)
  assert.equal(matches({ mark: { text: '待办：验收搜索' } }, '验收'), true)
  assert.equal(matches({ sessionId: 'session-ABC' }, 'abc'), true)
  assert.equal(matches({ title: 'ePoint' }, '不存在的词'), false)
  assert.equal(matches({ title: 'ePoint' }, '   '), true)

  const { groupRowsByWorkspace, WorkspaceMigratePanel, ArchivedWorkspaceRow } = module.__test
  const tr = (key, vars) => (vars === undefined ? key : `${key}:${JSON.stringify(vars)}`)
  const liveWorkspaces = new Map()
  liveWorkspaces.byId = new Map()
  liveWorkspaces.byPath = new Map()
  const now = Date.now()
  const archivedWorkspaces = new Map([[
    'ws-old',
    { workspaceId: 'ws-old', title: '旧工作区', order: 4, sessionCount: 2, movedAt: now },
  ]])
  const groups = groupRowsByWorkspace([
    { sessionId: 's1', updatedAt: now, workspaceId: 'ws-old', workspaceTitle: '旧工作区', workspacePath: 'E:\\old' },
  ], liveWorkspaces, tr, new Map(), archivedWorkspaces)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].label, '旧工作区')
  assert.equal(groups[0].order, 4)
  assert.equal(groups[0].archivedWorkspace, true)

  assert.doesNotThrow(() => ArchivedWorkspaceRow({
    entry: { workspaceId: 'ws-old', title: '旧工作区', path: 'E:\\old', sessionCount: 2, totalSessions: 3, movedAt: now },
    tr,
    disabled: false,
    onRestore: () => {},
  }))
  assert.doesNotThrow(() => WorkspaceMigratePanel({
    summaries: [{
      workspaceId: 'ws-live',
      title: '演示',
      path: 'E:\\demo',
      total: 2,
      live: 0,
      marked: 0,
      missing: 0,
      order: 0,
    }],
    tr,
    actionFor: () => ({ label: '迁移整个工作区', title: '迁移整个工作区', disabled: false, onClick: () => {} }),
    defaultOpen: true,
  }))

  const registered = []
  const slots = {
    inject(key, callback) {
      callback()
      return () => {}
    },
    register(options) {
      registered.push(options)
      return () => {}
    },
  }
  const locale = {
    register: () => () => {},
    bind: () => (key) => key,
    getSnapshot: () => ({ active: 'zh', locales: [], revision: 1 }),
  }
  const ctx = {
    get(name) {
      return name === 'locale' ? locale : undefined
    },
    inject(names, callback) {
      callback({ locale, effect: (fn) => { fn(); return () => {} } })
    },
    effect(fn) {
      fn()
      return () => {}
    },
    slots,
  }
  module.apply(ctx)
  assert.deepEqual(registered.map((entry) => entry.name).sort(), ['settings.section', 'settings.section.icon'])
})
