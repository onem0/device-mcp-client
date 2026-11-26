// journald versieht die Zeilen selbst mit Zeitstempel (systemd setzt dann JOURNAL_STREAM).
// Im Terminal und in der Logdatei unter macOS (launchd) schreibt der Daemon ihn dazu.
const stamp = () => (process.env.JOURNAL_STREAM ? '' : `${new Date().toISOString()} `)

export const log = {
  info: (msg: string) => console.log(`${stamp()}${msg}`),
  warn: (msg: string) => console.warn(`${stamp()}WARN ${msg}`),
  error: (msg: string) => console.error(`${stamp()}ERROR ${msg}`),
}
