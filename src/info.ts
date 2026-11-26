import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import type { DaemonInfo } from './protocol.ts'
import { VERSION } from './version.ts'

let cachedOs: string | null = null

function osName() {
  return (cachedOs ??= detectOs())
}

function detectOs() {
  if (process.platform === 'darwin') {
    try {
      const version = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 5_000 }).stdout?.trim()
      if (version) return `macOS ${version}`
    } catch {
      // Ohne sw_vers bleibt es bei "Darwin".
    }
    return 'macOS'
  }
  try {
    const match = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(readFileSync('/etc/os-release', 'utf8'))
    if (match?.[1]) return match[1]
  } catch {
    // Kein /etc/os-release.
  }
  return os.type()
}

export const daemonInfo = (): DaemonInfo => ({
  hostname: os.hostname(),
  os: osName(),
  kernel: os.release(),
  arch: process.arch,
  username: os.userInfo().username,
  homeDir: os.homedir(),
  version: VERSION,
})
