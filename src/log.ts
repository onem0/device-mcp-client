// journald adds the timestamp to the lines itself (systemd then sets JOURNAL_STREAM).
// In the terminal and in the log file on macOS (launchd) the daemon adds it.
const stamp = () => (process.env.JOURNAL_STREAM ? '' : `${new Date().toISOString()} `)

export const log = {
  info: (msg: string) => console.log(`${stamp()}${msg}`),
  warn: (msg: string) => console.warn(`${stamp()}WARN ${msg}`),
  error: (msg: string) => console.error(`${stamp()}ERROR ${msg}`),
}
