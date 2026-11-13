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
    useState: () => [null, () => {}],
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
