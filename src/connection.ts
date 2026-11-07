import type { Config } from './config.ts'
import type { Handler } from './handlers.ts'
import { daemonInfo } from './info.ts'
import type { JobManager } from './jobs.ts'
import { log } from './log.ts'
import { CloseCode, PROTOCOL_VERSION, type DaemonMessage, type ServerMessage } from './protocol.ts'

const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 60_000
const CONNECT_TIMEOUT_MS = 20_000

export function wsUrl(serverUrl: string) {
  const url = new URL(serverUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/daemon/ws`
  url.search = ''
  url.hash = ''
  return url.toString()
}

// Hält die Verbindung zum Server. Jobs laufen unabhängig davon weiter, nach einem Reconnect
// meldet hello den Stand aller Jobs, damit der Server nachziehen kann.
export class Connection {
  private ws: WebSocket | null = null
  private ready = false
  private attempt = 0
  private stopped = false
  private lastServerMessage = 0
  private heartbeatIntervalMs = 15_000
  private heartbeatTimeoutMs = 45_000
  private timers: Timer[] = []
  private reconnectTimer: Timer | null = null

  constructor(
    private config: Config,
    private jobs: JobManager,
    private handle: Handler,
  ) {
    jobs.on('exit', (job) => this.sendIfReady({ type: 'job_exit', job }))
  }

  start() {
    this.connect()
  }

  stop() {
    this.stopped = true
    this.clearTimers()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close(1000, 'daemon stopping')
  }

  private connect() {
    this.reconnectTimer = null
    const url = wsUrl(this.config.serverUrl)
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (err) {
      log.error(`Verbindung zu ${url} nicht möglich: ${(err as Error).message}`)
      return this.scheduleReconnect()
    }
    this.ws = ws

    const connectTimer = setTimeout(() => {
      if (this.ws === ws && !this.ready) {
        log.warn(`Keine Antwort von ${url} innerhalb von ${CONNECT_TIMEOUT_MS / 1000} s`)
        this.abandon(ws, 'connect timeout')
      }
    }, CONNECT_TIMEOUT_MS)

    ws.onopen = () => {
      this.lastServerMessage = Date.now()
      this.send(ws, {
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        token: this.config.token,
        info: daemonInfo(),
        jobs: this.jobs.summaries(),
      })
    }
    ws.onmessage = (event) => {
      if (this.ws !== ws) return
      this.lastServerMessage = Date.now()
      let msg: ServerMessage
      try {
        msg = JSON.parse(String(event.data))
      } catch {
        return log.warn('Ungültige Nachricht vom Server')
      }
      this.onMessage(ws, msg)
    }
    ws.onclose = (event) => {
      clearTimeout(connectTimer)
      if (this.ws !== ws) return
      this.ws = null
      this.onDisconnect(event.code, event.reason)
    }
    ws.onerror = () => {
      // Details kommen über onclose.
    }
  }

  private onMessage(ws: WebSocket, msg: ServerMessage) {
    switch (msg.type) {
      case 'welcome': {
        this.ready = true
        this.attempt = 0
        this.heartbeatIntervalMs = msg.heartbeatIntervalMs
        this.heartbeatTimeoutMs = msg.heartbeatTimeoutMs
        this.clearTimers()
        this.timers.push(setInterval(() => this.send(ws, { type: 'heartbeat' }), this.heartbeatIntervalMs))
        // Kommt nichts mehr vom Server (auch kein heartbeat_ack), ist die Leitung tot.
        this.timers.push(
          setInterval(() => {
            if (Date.now() - this.lastServerMessage > this.heartbeatTimeoutMs) {
              log.warn('Server antwortet nicht mehr, baue neu auf')
              this.abandon(ws, 'heartbeat timeout')
            }
          }, 5_000),
        )
        log.info(`Verbunden mit ${this.config.serverUrl} als „${msg.name}“`)
        return
      }
      case 'heartbeat_ack':
        return
      case 'request': {
        const { id, method, params } = msg
        this.handle(method, params).then(
          (result) => this.send(ws, { type: 'response', id, ok: true, result }),
          (err: Error & { code?: string }) => this.send(ws, { type: 'response', id, ok: false, error: { message: err.message, code: err.code } }),
        )
        return
      }
    }
  }

  private onDisconnect(code: number, reason: string) {
    const wasReady = this.ready
    this.ready = false
    this.clearTimers()
    if (this.stopped) return

    let delay: number | undefined
    switch (code) {
      case CloseCode.InvalidToken:
        log.error('Der Server lehnt den Geräte-Token ab (Gerät gelöscht oder Token neu erzeugt). Neuer Versuch in 5 min.')
        delay = 5 * 60_000
        break
      case CloseCode.Disabled:
        log.warn('Das Gerät ist im Panel deaktiviert. Neuer Versuch in 1 min.')
        delay = 60_000
        break
      case CloseCode.Replaced:
        log.warn('Eine andere Verbindung mit demselben Token hat diese ersetzt. Läuft der Daemon doppelt?')
        delay = 30_000
        break
      default:
        log.warn(`Verbindung ${wasReady ? 'getrennt' : 'fehlgeschlagen'} (Code ${code}${reason ? `, ${reason}` : ''})`)
    }
    this.scheduleReconnect(delay)
  }

  // Tote Verbindung: nicht auf den Close-Handshake warten, sofort neu aufbauen.
  private abandon(ws: WebSocket, reason: string) {
    if (this.ws !== ws) return
    this.ws = null
    try {
      ws.close(4000, reason)
    } catch {
      // egal
    }
    this.onDisconnect(1006, reason)
  }

  private scheduleReconnect(fixedDelay?: number) {
    if (this.stopped || this.reconnectTimer) return
    const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt)
    this.attempt = Math.min(this.attempt + 1, 16)
    // ±20 % Streuung, damit nach einem Server-Neustart nicht alle Geräte gleichzeitig anklopfen.
    const delay = Math.round((fixedDelay ?? backoff) * (0.8 + Math.random() * 0.4))
    log.info(`Neuer Verbindungsversuch in ${(delay / 1000).toFixed(1)} s`)
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  private sendIfReady(msg: DaemonMessage) {
    if (this.ready && this.ws) this.send(this.ws, msg)
  }

  private send(ws: WebSocket, msg: DaemonMessage) {
    if (ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify(msg))
    } catch (err) {
      log.warn(`Senden fehlgeschlagen: ${(err as Error).message}`)
    }
  }

  private clearTimers() {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
  }
}
