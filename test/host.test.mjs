/**
 * Host-entry smoke test: wire the real index.js against a fake Cordis context
 * and exercise the archive route through a real Node request/response pair.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { apply } from '../index.js'

async function call(handler, { method = 'POST', headers = {}, body = '{}' } = {}) {
  const request = new PassThrough()
  request.method = method
  request.headers = { host: '127.0.0.1:3080', ...headers }
  request.socket = { remoteAddress: '127.0.0.1' }
  const response = new PassThrough()
  response.headers = {}
  response.writeHead = (status, responseHeaders) => {
    response.status = status
    Object.assign(response.headers, responseHeaders ?? {})
  }
  const chunks = []
  response.on('data', (chunk) => chunks.push(chunk))
  const finished = new Promise((resolve) => response.on('end', resolve))
  const handling = handler(request, response)
  request.end(body)
  await handling
  await finished
  return { status: response.status, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
}

test('host entry registers the six routes and fences the archive route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-migrator-host-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const routes = new Map()
  const fakeCtx = {
    logger: { warn: () => {} },
    inject(names, callback) {
      const serviceCtx = {
        get(name, strict = true) {
          if (name === 'sessionProjectionCache') return undefined
          if (strict === false) return undefined
          return undefined
        },
        effect(fn) {
          const cleanup = fn()
          return typeof cleanup === 'function' ? cleanup : () => {}
        },
        sessionPersistence: { list: async () => [] },
        sessions: { list: () => [], get: () => undefined },
        workspaceRegistry: { archivedSessionIds: [], list: () => [] },
        webServer: {
          register(route) {
            routes.set(route.path, route.handler)
            return () => {}
          },
        },
      }
      callback(serviceCtx)
    },
  }
  try {
    apply(fakeCtx)
    assert.deepEqual([...routes.keys()].sort(), [
      '/session-migrator/archive',
      '/session-migrator/migrate',
      '/session-migrator/restore',
      '/session-migrator/scan',
      '/session-migrator/workspace-migrate',
      '/session-migrator/workspace-restore',
    ])
    const denied = await call(routes.get('/session-migrator/archive'), { headers: {} })
    assert.equal(denied.status, 403)
    const accepted = await call(routes.get('/session-migrator/archive'), {
      headers: { 'x-dsh-session-migrator': '1' },
    })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.body.ok, true)
    assert.deepEqual(accepted.body.value.entries, [])
    await mkdir(join(root, 'session-migrator'), { recursive: true })
    await writeFile(join(root, 'session-migrator', 'state.json'), '{"lastBatch":{"ids":[],"at":1}}', 'utf8')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
})
