/**
 * The four HTTP routes the browser half uses.
 *
 * All routes are loopback-only (or a live paired remote-web-ui device), require
 * a same-origin custom header, and answer only POST. They move whole session
 * directories, so a cross-site form must never reach them.
 * @module dsh-session-migrator/lib/route
 */

import { isLoopbackRequest } from './loopback.js'

export const SCAN_ROUTE = '/session-migrator/scan'
export const MIGRATE_ROUTE = '/session-migrator/migrate'
export const ARCHIVE_ROUTE = '/session-migrator/archive'
export const RESTORE_ROUTE = '/session-migrator/restore'

/** Header a same-origin client must set; cross-site forms cannot. */
export const REQUEST_MARKER = 'x-dsh-session-migrator'

/** Body cap for every route. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
}

/**
 * Build all four handlers.
 * @param {any} ctx - Host web context.
 * @param {{ scan(months: number): Promise<any>, migrate(request: object): Promise<any>, archive(): Promise<any>, restore(request: object): Promise<any> }} service - migration service.
 * @returns {Array<{ path: string, handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> }>} routes.
 */
export function createHandlers(ctx, service) {
  return [
    { path: SCAN_ROUTE, handler: createJsonHandler(ctx, (body) => service.scan(body.months)) },
    { path: MIGRATE_ROUTE, handler: createJsonHandler(ctx, (body) => service.migrate(body)) },
    { path: ARCHIVE_ROUTE, handler: createJsonHandler(ctx, () => service.archive()) },
    { path: RESTORE_ROUTE, handler: createJsonHandler(ctx, (body) => service.restore(body)) },
  ]
}

/**
 * One JSON endpoint.
 * @param {any} ctx - Host web context.
 * @param {(body: any) => Promise<any>} run - business operation.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} the handler.
 */
function createJsonHandler(ctx, run) {
  return async (req, res) => {
    if (!isAllowed(ctx, req)) {
      writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    if (req.headers[REQUEST_MARKER] === undefined) {
      writeJson(res, 403, { ok: false, error: 'forbidden: missing request marker' })
      return
    }
    const body = await readBody(req)
    if (body.status === 'tooLarge') {
      writeJson(res, 413, { ok: false, error: 'body too large' })
      return
    }
    if (body.status === 'invalid') {
      writeJson(res, 400, { ok: false, error: 'body must be JSON' })
      return
    }
    try {
      const value = await run(body.value ?? {})
      writeJson(res, 200, { ok: true, value })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/must be|at most|invalid|required|unreadable|refused/i.test(message)) {
        writeJson(res, 400, { ok: false, error: message })
        return
      }
      ctx.logger?.warn?.(`session-migrator: route failed: ${String(error)}`)
      writeJson(res, 500, { ok: false, error: 'internal error' })
    }
  }
}

/**
 * Loopback always passes; a live paired device passes when that plugin is
 * loaded. The pairing service is read ONLY through `ctx.get`: a Cordis context
 * throws on a plain property read of an uninjected service.
 */
function isAllowed(ctx, request) {
  if (isLoopbackRequest(request)) return true
  const pairing = typeof ctx.get === 'function' ? ctx.get('remoteWebUiPairing', false) : undefined
  return pairing !== undefined && pairing !== null && typeof pairing.isPairedDevice === 'function'
    ? pairing.isPairedDevice(request) === true
    : false
}

/**
 * Read one request body under the cap.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {Promise<{status: 'ok', value: any} | {status: 'invalid'} | {status: 'tooLarge'}>} body.
 */
async function readBody(req) {
  let size = 0
  let tooLarge = false
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      tooLarge = true
      continue
    }
    chunks.push(chunk)
  }
  if (tooLarge) return { status: 'tooLarge' }
  try {
    return { status: 'ok', value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { status: 'invalid' }
  }
}

/** Write one JSON envelope. */
function writeJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}
