/**
 * Resolve the Harness home the same way the Host does: the DSH_HOME override
 * wins, then `~/.dsh`.
 * @module dsh-session-migrator/lib/home
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Environment variable that overrides the Harness home. */
const DSH_HOME_ENV = 'DSH_HOME'

/**
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @param {string} [home] - platform home (test seam).
 * @returns {string} the absolute Harness home.
 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const raw = env[DSH_HOME_ENV]
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  return join(home, '.dsh')
}
