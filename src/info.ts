import { readFileSync } from 'node:fs'
import os from 'node:os'
import type { DaemonInfo } from './protocol.ts'
import { VERSION } from './version.ts'

function osName() {
  try {
    const match = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(readFileSync('/etc/os-release', 'utf8'))
    if (match?.[1]) return match[1]
  } catch {
    // Kein /etc/os-release, z. B. auf macOS beim Entwickeln.
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
