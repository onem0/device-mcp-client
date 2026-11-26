import { loadConfig } from './config.ts'
import { Connection } from './connection.ts'
import { createHandlers } from './handlers.ts'
import { JobManager } from './jobs.ts'
import { log } from './log.ts'
import { configPath, stateDir } from './paths.ts'
import { Updater } from './update.ts'
import { VERSION } from './version.ts'

const arg = process.argv[2]

if (arg === '--version' || arg === 'version') {
  console.log(VERSION)
  process.exit(0)
}

if (arg === '--help' || arg === 'help') {
  console.log(`device-mcp ${VERSION}

Daemon for device-mcp. Connects to the server and runs its requests.
${
  process.platform === 'darwin'
    ? 'Usually runs as a launchd agent: launchctl print gui/$(id -u)/dev.onemo.device-mcp'
    : 'Usually runs as a systemd user service: systemctl --user status device-mcp'
}
Updates itself when the server ships a newer daemon (turn off with "autoUpdate": false in the config).

Config:    ${configPath()}
Jobs/logs: ${stateDir()}/jobs
Uninstall: device-mcp-uninstall`)
  process.exit(0)
}

let config
try {
  config = loadConfig()
} catch (err) {
  log.error((err as Error).message)
  process.exit(1)
}

const jobs = new JobManager(stateDir())
jobs.init()
const connection = new Connection(config, jobs, createHandlers(jobs))

let stopping = false
function shutdown(reason: string) {
  if (stopping) process.exit(1)
  stopping = true
  log.info(reason)
  updater.stop()
  connection.stop()
  jobs.killAll()
  setTimeout(() => process.exit(0), 1_000).unref?.()
}

// Nach einem Update beendet sich der Daemon, systemd bzw. launchd startet das neue Binary.
const updater = new Updater(config, jobs, stateDir(), () => shutdown('Daemon stopping for the update'))
connection.onReady = () => updater.checkSoon()

log.info(`device-mcp ${VERSION} starting, server ${config.serverUrl}`)
updater.start()
connection.start()

for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => shutdown('Daemon stopping'))
