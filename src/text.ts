// Preparing text for Claude: truncate long lines, remove control characters from command output.

export const MAX_LINE_CHARS = 2000

// CSI and OSC sequences as well as single ESC codes (colours, cursor, title).
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g

// Command output: reduce progress bars using \r to their last state, strip colours and control characters.
export function cleanOutputLine(line: string) {
  let s = line.endsWith('\r') ? line.slice(0, -1) : line
  if (s.includes('\r')) s = s.split('\r').findLast((part) => part.length > 0) ?? ''
  return s.replace(ANSI, '').replace(CONTROL, '')
}

// File content stays unchanged except for the line ending \r.
export const cleanFileLine = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line)

export function capLine(line: string, extraBytes = 0) {
  if (line.length <= MAX_LINE_CHARS && extraBytes === 0) return { text: line, cut: false }
  const rest = line.length - Math.min(line.length, MAX_LINE_CHARS)
  const more = extraBytes > 0 ? `${rest > 0 ? `${rest} chars and ` : ''}${extraBytes} bytes` : `${rest} chars`
  return { text: `${line.slice(0, MAX_LINE_CHARS)} … [+${more}]`, cut: true }
}

// Takes lines from the front until the character budget is used up. At least one line, so that progress is made.
export function takeLines(lines: string[], budget: number) {
  const out: string[] = []
  let used = 0
  for (const line of lines) {
    if (out.length > 0 && used + line.length + 1 > budget) break
    out.push(line)
    used += line.length + 1
  }
  return out
}

// Like takeLines, but from the end.
export function takeLinesFromEnd(lines: string[], budget: number) {
  const out: string[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (out.length > 0 && used + line.length + 1 > budget) break
    out.push(line)
    used += line.length + 1
  }
  return out.reverse()
}
