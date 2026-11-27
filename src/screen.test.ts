import { describe, expect, test } from 'bun:test'
import { cleanPaneOutput, markHighlights } from './screen.ts'

const ESC = '\x1b'

describe('markHighlights', () => {
  test('reverse video is marked, plain text stays', () => {
    const screen = ['  Install', `  ${ESC}[7mUpdate${ESC}[27m   `, '  Remove', '  Quit'].join('\n')
    expect(markHighlights(screen)).toBe(['  Install', '  ⟦Update⟧', '  Remove', '  Quit'].join('\n'))
  })

  test('a small background run on a coloured surface is marked, the surface is not', () => {
    // Blue surface everywhere, the selected item on red.
    const line = (text: string) => `${ESC}[44m${text.padEnd(30)}${ESC}[0m`
    const screen = [line('  Select a mode:'), line('  normal'), `${ESC}[44m  ${ESC}[41mexpert${ESC}[44m${' '.repeat(22)}${ESC}[0m`, line('  safe')].join('\n')
    const out = markHighlights(screen).split('\n')
    expect(out[0]).toBe('  Select a mode:')
    expect(out[2]).toBe('  ⟦expert⟧')
  })

  test('256 and true colour backgrounds, other escapes are ignored', () => {
    const filler = Array.from({ length: 10 }, (_, i) => `candidate number ${i}`)
    const screen = [`${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\ text`, `> ${ESC}[48;5;236mcurrent line${ESC}[49m`, `  ${ESC}[48;2;10;20;30mtrue${ESC}[0m`, ...filler].join('\n')
    const out = markHighlights(screen).split('\n')
    expect(out[0]).toBe('link text')
    expect(out[1]).toBe('> ⟦current line⟧')
    expect(out[2]).toBe('  ⟦true⟧')
    expect(out[3]).toBe('candidate number 0')
  })

  test('without any styling the text is unchanged', () => {
    expect(markHighlights('a\nb  \nc')).toBe('a\nb\nc')
  })
})

describe('cleanPaneOutput', () => {
  test('strips colours and turns carriage returns into line breaks', () => {
    expect(cleanPaneOutput(`${ESC}[32mok${ESC}[0m\r\n10%\r50%\rdone\x07`)).toBe('ok\n10%\n50%\ndone')
  })
})
