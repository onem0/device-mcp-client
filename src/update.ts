// Auto-Update: Der Server liefert unter /download/manifest.json die Version seiner Daemon-Binaries.
// Ist sie neuer, lädt der Daemon sein Binary, prüft es, ersetzt sich selbst und lässt sich vom
// Service-Manager (systemd, launchd) neu starten, sobald kein Job mehr läuft.

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
import { VERSION } from './version.ts'

const CHECK_EVERY_MS = 6 * 60 * 60_000
// Nach einem fehlgeschlagenen Versuch dieselbe Version frühestens nach einer Stunde erneut probieren.
const RETRY_AFTER_MS = 60 * 60_000
const IDLE_POLL_MS = 15_000
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

// Nur ein kompiliertes Binary ersetzt sich selbst. Mit `bun run src/index.ts` wäre execPath Bun selbst.
export const isCompiled = () => Bun.main.startsWith('/$bunfs/')

// Die Unit-Datei und die launchd-plist setzen DEVICE_MCP_SUPERVISED. INVOCATION_ID setzt systemd für jeden Service.
const isSupervised = () => process.env.DEVICE_MCP_SUPERVISED === '1' || !!process.env.INVOCATION_ID

export class Updater {
  private busy = false
  // Version, die schon auf der Platte liegt und auf den Neustart wartet.
  private staged: string | null = null
  private timers: Timer[] = []
  private noBuildWarned = false
  private memoPath: string
  private execPath: string
  private compiled: boolean
  private supervised: boolean

  // opts nur für Tests: ein Binary an anderer Stelle, ohne kompiliert oder als Service zu laufen.
  constructor(
    private config: Pick<Config, 'serverUrl' | 'autoUpdate'>,
    private jobs: Pick<JobManager, 'runningCount'>,
    private stateDir: string,
    private restart: () => void,
    opts: { execPath?: string; compiled?: boolean; supervised?: boolean } = {},
  ) {
    this.memoPath = path.join(stateDir, 'update.json')
    this.execPath = opts.execPath ?? process.execPath
    this.compiled = opts.compiled ?? isCompiled()
    this.supervised = opts.supervised ?? isSupervised()
  }

  get enabled() {
    return this.config.autoUpdate && process.env.DEVICE_MCP_NO_UPDATE !== '1' && this.compiled
  }

  get stagedVersion() {
    return this.staged
  }

  start() {
    if (!this.enabled) {
      if (!this.config.autoUpdate) log.info('Auto-update is turned off (autoUpdate: false in the config)')
      return
    }
    this.cleanup()
    const timer = setInterval(() => void this.check(), CHECK_EVERY_MS)
    timer.unref?.()
    this.timers.push(timer)
  }

  stop() {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
  }

  // Nach jedem Verbindungsaufbau: Ein neuer Server bringt meist einen neuen Daemon mit.
  // Etwas Streuung, damit nach einem Deploy nicht alle Geräte gleichzeitig laden.
  checkSoon() {
    if (!this.enabled || this.staged) return
    const timer = setTimeout(() => void this.check(), 5_000 + Math.random() * 15_000)
    timer.unref?.()
    this.timers.push(timer)
  }

  async check() {
    if (!this.enabled || this.busy || this.staged) return
    this.busy = true
    let target: string | null = null
    try {
      const manifest = await this.fetchManifest()
      if (!manifest || compareVersions(manifest.version, VERSION) <= 0) return
      const binary = manifest.binaries[targetKey()]
      if (!binary) {
        if (!this.noBuildWarned) log.warn(`The server has daemon ${manifest.version}, but no build for ${targetKey()}. Staying on ${VERSION}.`)
        this.noBuildWarned = true
        return
      }
      if (this.failedRecently(manifest.version)) return
      target = manifest.version
      log.info(`Update available: ${VERSION} → ${target}, downloading`)
      await this.install(target, binary)
      this.staged = target
      rmSync(this.memoPath, { force: true })
      this.restartWhenIdle(target)
    } catch (err) {
      const message = (err as Error).message
      log.warn(`Update${target ? ` to ${target}` : ' check'} failed: ${message}`)
      if (target) this.remember({ version: target, failedAt: new Date().toISOString(), error: message })
    } finally {
      this.busy = false
    }
  }

  private async fetchManifest(): Promise<Manifest | null> {
    const res = await fetch(`${this.config.serverUrl}/download/manifest.json`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' })
    // Ältere Server kennen kein Manifest.
    if (res.status === 404) return null
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

      // Im Strom entpacken und hashen, damit ein kleines Gerät nicht 100 MB im Speicher hält.
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
      const probe = spawnSync(tmp, ['--version'], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, DEVICE_MCP_NO_UPDATE: '1' } })
      const reported = probe.stdout?.trim()
      if (probe.status !== 0 || reported !== version) {
        throw new Error(`The new binary does not run here or reports ${reported || 'no version'} instead of ${version}.`)
      }
      // rename ersetzt die Datei atomar; der laufende Prozess behält die alte bis zum Neustart.
      renameSync(tmp, this.execPath)
    } catch (err) {
      rmSync(tmp, { force: true })
      throw err
    }
  }

  // Ein Neustart beendet laufende Jobs, deshalb warten, bis keiner mehr läuft.
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
    if (tryRestart()) return
    const timer = setInterval(tryRestart, IDLE_POLL_MS)
    this.timers.push(timer)
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
      // Ohne Merkzettel wird beim nächsten Verbindungsaufbau erneut versucht.
    }
  }

  // Reste abgebrochener Downloads und ein Merkzettel für eine Version, die inzwischen läuft.
  private cleanup() {
    const dir = path.dirname(this.execPath)
    try {
      for (const file of readdirSync(dir)) {
        if (!file.startsWith(TMP_PREFIX)) continue
        const full = path.join(dir, file)
        if (Date.now() - statSync(full).mtimeMs > DOWNLOAD_TIMEOUT_MS) rmSync(full, { force: true })
      }
    } catch {
      // Ordner nicht lesbar: dann scheitert später auch das Update mit einer klaren Meldung.
    }
    try {
      const memo = JSON.parse(readFileSync(this.memoPath, 'utf8')) as FailureMemo
      if (compareVersions(memo.version, VERSION) <= 0) rmSync(this.memoPath, { force: true })
    } catch {
      // Kein Merkzettel.
    }
  }
}
