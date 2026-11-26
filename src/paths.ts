import os from 'node:os'
import path from 'node:path'

export const home = () => os.homedir()

export const configPath = () =>
  process.env.DEVICE_MCP_CONFIG || path.join(process.env.XDG_CONFIG_HOME || path.join(home(), '.config'), 'device-mcp', 'config.json')

export const stateDir = () =>
  process.env.DEVICE_MCP_STATE_DIR || path.join(process.env.XDG_STATE_HOME || path.join(home(), '.local', 'state'), 'device-mcp')

// Paths from Claude: absolute, with ~, or relative to the user's home directory.
export function resolveUserPath(input: string) {
  const p = input.trim()
  if (p === '~') return home()
  if (p.startsWith('~/')) return path.join(home(), p.slice(2))
  if (path.isAbsolute(p)) return path.normalize(p)
  return path.resolve(home(), p)
}
