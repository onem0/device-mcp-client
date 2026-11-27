// Terminal screens for Claude: mark highlighted text (selection in menus, reverse video) and clean raw pane output.

export const MARK_OPEN = '⟦'
export const MARK_CLOSE = '⟧'
// A background that covers more than this share of the screen is a surface (window, dialog), not a highlight.
const SURFACE_SHARE = 0.2

const SGR = /\x1b\[([0-9;:]*)m/y
// Everything else that can turn up in capture-pane -e: other CSI, OSC (hyperlinks), single ESC codes.
const OTHER_ESC = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/y

interface Style {
  fg: string
  bg: string
  reverse: boolean
}

interface Cell {
  ch: string
  key: string
}

const plain = (): Style => ({ fg: 'default', bg: 'default', reverse: false })

function applySgr(style: Style, params: string) {
  const parts = params === '' ? ['0'] : params.split(';')
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    // Colon form 38:2::r:g:b or 38:5:n in one parameter.
    if (part.includes(':')) {
      const [head, ...rest] = part.split(':')
      if (head === '38') style.fg = `x${rest.join(':')}`
      else if (head === '48') style.bg = `x${rest.join(':')}`
      continue
    }
    const n = Number(part || '0')
    if (n === 0) Object.assign(style, plain())
    else if (n === 7) style.reverse = true
    else if (n === 27) style.reverse = false
    else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) style.fg = String(n)
    else if (n === 39) style.fg = 'default'
    else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) style.bg = String(n)
    else if (n === 49) style.bg = 'default'
    else if (n === 38 || n === 48) {
      // 38;5;n or 38;2;r;g;b
      const mode = parts[i + 1]
      const take = mode === '5' ? 2 : mode === '2' ? 4 : 1
      const value = `x${parts.slice(i + 1, i + 1 + take).join(':')}`
      if (n === 38) style.fg = value
      else style.bg = value
      i += take
    }
  }
}

// The background the eye sees: with reverse video that is the foreground colour.
const visualBg = (s: Style) => (s.reverse ? `fg:${s.fg}` : `bg:${s.bg}`)

function parseLine(line: string, style: Style): Cell[] {
  const cells: Cell[] = []
  let i = 0
  while (i < line.length) {
    if (line.charCodeAt(i) === 0x1b) {
      SGR.lastIndex = i
      const sgr = SGR.exec(line)
      if (sgr) {
        applySgr(style, sgr[1]!)
        i = SGR.lastIndex
        continue
      }
      OTHER_ESC.lastIndex = i
      if (OTHER_ESC.exec(line)) {
        i = OTHER_ESC.lastIndex
        continue
      }
      i++
      continue
    }
    const code = line.codePointAt(i)!
    const ch = String.fromCodePoint(code)
    i += ch.length
    if (code < 0x20 || code === 0x7f) continue
    cells.push({ ch, key: visualBg(style) })
  }
  return cells
}

// Text with highlighted runs wrapped in ⟦…⟧. Input is capture-pane -e output (SGR codes, one screen line per line).
export function markHighlights(raw: string): string {
  const style = plain()
  const rows = raw.split('\n').map((line) => parseLine(line, style))
  const counts = new Map<string, number>()
  let total = 0
  for (const row of rows) {
    for (const cell of row) {
      counts.set(cell.key, (counts.get(cell.key) ?? 0) + 1)
      total++
    }
  }
  let dominant = 'bg:default'
  let best = -1
  for (const [key, n] of counts) {
    if (n > best) {
      best = n
      dominant = key
    }
  }
  const highlighted = (key: string) => key !== dominant && (counts.get(key) ?? 0) <= total * SURFACE_SHARE

  return rows
    .map((row) => {
      let out = ''
      let i = 0
      while (i < row.length) {
        if (!highlighted(row[i]!.key)) {
          out += row[i]!.ch
          i++
          continue
        }
        let j = i
        while (j < row.length && highlighted(row[j]!.key)) j++
        const run = row
          .slice(i, j)
          .map((c) => c.ch)
          .join('')
        const lead = /^\s*/.exec(run)![0]
        const core = run.trim()
        if (!core) out += run
        else out += `${lead}${MARK_OPEN}${core}${MARK_CLOSE}${run.slice(lead.length + core.length)}`
        i = j
      }
      return out.replace(/\s+$/, '')
    })
    .join('\n')
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

// Raw bytes a program wrote into the pane (pipe-pane) → text a pattern can be matched against.
export const cleanPaneOutput = (raw: string) => raw.replace(ANSI, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(CONTROL, '')
