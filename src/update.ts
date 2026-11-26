// Daemon update. The server requests it (method "update"): either because someone clicked
// “Update” in the panel or because Auto-update is switched on for the device. The daemon does not look for updates by itself.
// It downloads the binary from its server (/download), verifies it, replaces itself and lets the
// service manager (systemd, launchd) restart it as soon as no job is running any more.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, createWriteStream, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import type { Config } from './config.ts'
import type { JobManager } from './jobs.ts'
import { log } from './log.ts'
import { DaemonError, type UpdateResult } from './protocol.ts'
import { VERSION } from './version.ts'

// After a failed attempt, Auto-update retries the same version after one hour at the earliest.
// A click in the panel (force) tries right away.
const RETRY_AFTER_MS = 60 * 60_000
const IDLE_POLL_MS = 15_000
// This is how long the reply to the server has before the daemon exits for the restart.
const RESTART_DELAY_MS = 1_500
const FETCH_TIMEOUT_MS = 20_000
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
const MAX_BINARY_BYTES = 400 * 1024 * 1024
const TMP_PREFIX = '.device-mcp.update-'
const VERSION_RE = /^\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/

interface Manifest {
  version: string
  binaries: Record<string, { sha256: string; size: number } | undefined>
}

interface FailureMemo {
  version: string
  failedAt: string
  error: string
}

export function compareVersions(a: string, b: string) {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

export function parseManifest(data: unknown): Manifest {
  const m = data as Partial<Manifest> | null
  if (!m || typeof m.version !== 'string' || !VERSION_RE.test(m.version)) throw new Error('The update manifest has no valid version.')
  if (!m.binaries || typeof m.binaries !== 'object') throw new Error('The update manifest lists no binaries.')
  return { version: m.version, binaries: m.binaries }
}

export const targetKey = () => `${process.platform}-${process.arch}`

// Only a compiled binary replaces itself. With `bun run src/index.ts`, execPath would be Bun itself.
export const isCompiled = () => Bun.main.startsWith('/$bunfs/')

// The unit file and the launchd plist set DEVICE_MCP_SUPERVISED. systemd sets INVOCATION_ID for every service.
const isSupervised = () => process.env.DEVICE_MCP_SUPERVISED === '1' || !!process.env.INVOCATION_ID

export class Updater {
  private busy = false
  // Version that is already on disk and waiting for the restart.
  private staged: string | null = null
  private timers: Timer[] = []
  private memoPath: string
  private execPath: string
  private compiled: boolean
  private supervised: boolean
  private restartDelayMs: number

  // opts only for tests: a binary in a different location, without being compiled or running as a service.
  constructor(
    private config: Pick<Config, 'serverUrl'>,
    private jobs: Pick<JobManager, 'runningCount'>,
    private stateDir: string,
    private restart: () => void,
    opts: { execPath?: string; compiled?: boolean; supervised?: boolean; restartDelayMs?: number } = {},
  ) {
    this.memoPath = path.join(stateDir, 'update.json')
    this.execPath = opts.execPath ?? process.execPath
    this.compiled = opts.compiled ?? isCompiled()
    this.supervised = opts.supervised ?? isSupervised()
    this.restartDelayMs = opts.restartDelayMs ?? RESTART_DELAY_MS
    if (this.compiled) this.cleanup()
  }

  get stagedVersion() {
    return this.staged
  }

  stop() {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
  }

  // force: click in the panel. Without force (Auto-update) the waiting period after a failure applies.
  async run(opts: { force?: boolean } = {}): Promise<UpdateResult> {
    if (!this.compiled) throw new DaemonError('This daemon was not started from an installed binary and cannot update itself.', 'UPDATE_UNSUPPORTED')
    if (this.staged) return this.installed(this.staged)
    if (this.busy) throw new DaemonError('An update is already running on the device.', 'BUSY')
    this.busy = true
    let target: string | null = null
    try {
      const manifest = await this.fetchManifest()
      if (compareVersions(manifest.version, VERSION) <= 0) return { status: 'current', version: VERSION }
      const binary = manifest.binaries[targetKey()]
      if (!binary) throw new DaemonError(`The server has daemon ${manifest.version}, but no build for ${targetKey()}.`, 'NO_BUILD')
      if (!opts.force && this.failedRecently(manifest.version)) {
        throw new DaemonError(`The last update to ${manifest.version} failed less than an hour ago. Auto-update waits before the next try.`, 'UPDATE_BACKOFF')
      }
      target = manifest.version
      log.info(`Update requested: ${VERSION} → ${target}, downloading`)
      await this.install(target, binary)
      this.staged = target
      rmSync(this.memoPath, { force: true })
      const result = this.installed(target)
      this.restartWhenIdle(target)
      return result
    } catch (err) {
      const message = (err as Error).message
      if ((err as DaemonError).code !== 'UPDATE_BACKOFF') log.warn(`Update${target ? ` to ${target}` : ''} failed: ${message}`)
      if (target) this.remember({ version: target, failedAt: new Date().toISOString(), error: message })
      throw err instanceof DaemonError ? err : new DaemonError(message, 'UPDATE_FAILED')
    } finally {
      this.busy = false
    }
  }

  private installed(version: string): UpdateResult {
    const runningJobs = this.jobs.runningCount()
    return { status: 'installed', version, restart: !this.supervised ? 'manual' : runningJobs > 0 ? 'when_idle' : 'now', runningJobs }
  }

  private async fetchManifest(): Promise<Manifest> {
    const res = await fetch(`${this.config.serverUrl}/download/manifest.json`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' })
    if (res.status === 404) throw new DaemonError('The server does not ship daemon builds.', 'NO_BUILD')
    if (!res.ok) throw new Error(`manifest: HTTP ${res.status}`)
    return parseManifest(await res.json())
  }

  private async install(version: string, binary: { sha256: string; size: number }) {
    if (!Number.isInteger(binary.size) || binary.size <= 0 || binary.size > MAX_BINARY_BYTES) throw new Error('The manifest gives an implausible binary size.')
    const tmp = path.join(path.dirname(this.execPath), `${TMP_PREFIX}${process.pid}`)
    try {
      const res = await fetch(`${this.config.serverUrl}/download/device-mcp-${targetKey()}.gz`, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        redirect: 'error',
      })
      if (!res.ok || !res.body) throw new Error(`download: HTTP ${res.status}`)

      // Decompress and hash as a stream, so that a small device does not hold 100 MB in memory.
      const hash = createHash('sha256')
      let size = 0
      const meter = new Transform({
        transform(chunk: Buffer, _enc, done) {
          size += chunk.length
          if (size > binary.size) return done(new Error('The download is larger than the manifest says.'))
          hash.update(chunk)
          done(null, chunk)
        },
      })
      await pipeline(Readable.fromWeb(res.body as never), createGunzip(), meter, createWriteStream(tmp, { mode: 0o700 }))
      if (size !== binary.size) throw new Error(`The download is incomplete (${size} of ${binary.size} bytes).`)
      if (hash.digest('hex') !== binary.sha256) throw new Error('The checksum of the download does not match the manifest.')

      chmodSync(tmp, 0o755)
      const probe = spawnSync(tmp, ['--version'], { encoding: 'utf8', timeout: 20_000 })
      const reported = probe.stdout?.trim()
      if (probe.status !== 0 || reported !== version) {
        throw new Error(`The new binary does not run here or reports ${reported || 'no version'} instead of ${version}.`)
      }
      // rename replaces the file atomically; the running process keeps the old one until the restart.
      renameSync(tmp, this.execPath)
    } catch (err) {
      rmSync(tmp, { force: true })
      throw err
    }
  }

  // A restart ends running jobs, so wait until none is running any more.
  private restartWhenIdle(version: string) {
    if (!this.supervised) {
      log.info(`Daemon ${version} is installed at ${this.execPath}. Restart the daemon to use it.`)
      return
    }
    let announced = false
    const tryRestart = () => {
      const running = this.jobs.runningCount()
      if (running > 0) {
        if (!announced) log.info(`Daemon ${version} is installed. Restarting as soon as ${running === 1 ? 'the running job has' : `${running} running jobs have`} finished.`)
        announced = true
        return false
      }
      log.info(`Restarting to finish the update to ${version}`)
      this.stop()
      this.restart()
      return true
    }
    // Let the reply to the server go out first.
    this.timers.push(
      setTimeout(() => {
        if (tryRestart()) return
        this.timers.push(setInterval(tryRestart, IDLE_POLL_MS))
      }, this.restartDelayMs),
    )
  }

  private failedRecently(version: string) {
    try {
      const memo = JSON.parse(readFileSync(this.memoPath, 'utf8')) as FailureMemo
      return memo.version === version && Date.now() - Date.parse(memo.failedAt) < RETRY_AFTER_MS
    } catch {
      return false
    }
  }

  private remember(memo: FailureMemo) {
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
      writeFileSync(this.memoPath, `${JSON.stringify(memo, null, 2)}\n`, { mode: 0o600 })
    } catch {
      // Without the memo, Auto-update tries again the next time it connects.
    }
  }

  // Leftovers of aborted downloads and a memo for a version that is running by now.
  private cleanup() {
    const dir = path.dirname(this.execPath)
    try {
      for (const file of readdirSync(dir)) {
        if (!file.startsWith(TMP_PREFIX)) continue
        const full = path.join(dir, file)
        if (Date.now() - statSync(full).mtimeMs > DOWNLOAD_TIMEOUT_MS) rmSync(full, { force: true })
      }
    } catch {
      // Directory not readable: then the update will fail later too, with a clear message.
    }
    try {
      const memo = JSON.parse(readFileSync(this.memoPath, 'utf8')) as FailureMemo
      if (compareVersions(memo.version, VERSION) <= 0) rmSync(this.memoPath, { force: true })
    } catch {
      // No memo.
    }
  }
}
