// Aufbereitung von Text für Claude: lange Zeilen kürzen, Steuerzeichen aus Befehlsausgaben entfernen.

export const MAX_LINE_CHARS = 2000

// CSI- und OSC-Sequenzen sowie einzelne ESC-Codes (Farben, Cursor, Titel).
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g

// Befehlsausgabe: Fortschrittsbalken mit \r auf den letzten Stand reduzieren, Farben und Steuerzeichen raus.
export function cleanOutputLine(line: string) {
  let s = line.endsWith('\r') ? line.slice(0, -1) : line
  if (s.includes('\r')) s = s.split('\r').findLast((part) => part.length > 0) ?? ''
  return s.replace(ANSI, '').replace(CONTROL, '')
}

// Dateiinhalt bleibt unverändert bis auf das Zeilenende \r.
export const cleanFileLine = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line)

export function capLine(line: string, extraBytes = 0) {
  if (line.length <= MAX_LINE_CHARS && extraBytes === 0) return { text: line, cut: false }
  const rest = line.length - Math.min(line.length, MAX_LINE_CHARS)
  const more = extraBytes > 0 ? `${rest > 0 ? `${rest} Zeichen und ` : ''}${extraBytes} Bytes` : `${rest} Zeichen`
  return { text: `${line.slice(0, MAX_LINE_CHARS)} … [+${more}]`, cut: true }
}

// Nimmt Zeilen von vorn, bis das Zeichenbudget erschöpft ist. Mindestens eine Zeile, damit es weitergeht.
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

// Wie takeLines, aber von hinten.
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
