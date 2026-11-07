// journald versieht die Zeilen mit Zeitstempel, im Terminal hilft er trotzdem.
const stamp = () => (process.stderr.isTTY ? `${new Date().toISOString()} ` : '')

export const log = {
  info: (msg: string) => console.log(`${stamp()}${msg}`),
  warn: (msg: string) => console.warn(`${stamp()}WARN ${msg}`),
  error: (msg: string) => console.error(`${stamp()}ERROR ${msg}`),
}
