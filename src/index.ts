import { loadConfig } from './config.ts'
import { Connection } from './connection.ts'
import { createHandlers } from './handlers.ts'
import { JobManager } from './jobs.ts'
import { log } from './log.ts'
import { configPath, stateDir } from './paths.ts'
import { VERSION } from './version.ts'

const arg = process.argv[2]

if (arg === '--version' || arg === 'version') {
  console.log(VERSION)
  process.exit(0)
}

if (arg === '--help' || arg === 'help') {
  console.log(`device-mcp ${VERSION}

Daemon for device-mcp. Connects to the server and runs its requests.
Usually runs as a systemd user service: systemctl --user status device-mcp

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

log.info(`device-mcp ${VERSION} starting, server ${config.serverUrl}`)
connection.start()

let stopping = false
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1)
    stopping = true
    log.info('Daemon stopping')
    connection.stop()
    jobs.killAll()
    setTimeout(() => process.exit(0), 1_000).unref?.()
  })
}
