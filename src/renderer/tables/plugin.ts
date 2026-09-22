import type { MarkdownIt, StateCore, Token } from 'markdown-it'
import { parseMarker, parseOptions, type CellMarker } from './model'

/**
 * markdown-it side of the table markers (see model.ts): the `<!-- table: … -->`
 * line becomes classes on the table, cell markers become colspan/rowspan and
 * inline styles, and cells covered by a span are dropped from the output.
 */

const OPTIONS_BLOCK = /^<!--\s*table:/i

function cellStyle(m: CellMarker): string {
  const s: string[] = []
  if (m.bg) s.push(`background-color:${m.bg}`)
  if (m.fg) s.push(`color:${m.fg}`)
  if (m.align) s.push(`text-align:${m.align}`)
  return s.join(';')
}

export function tablesPlugin(md: MarkdownIt): void {
  md.core.ruler.push('tables_format', (state: StateCore) => {
    const tokens = state.tokens
    const out: Token[] = []
    let row = -1
    let col = 0
    let covered = new Map<string, boolean>()
    let skipping = 0 // > 0 while inside a covered cell's tokens
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      if (t.type === 'table_open') {
        row = -1
        covered = new Map()
        const prev = out[out.length - 1]
        if (prev?.type === 'html_block' && OPTIONS_BLOCK.test(prev.content)) {
          const opts = parseOptions(prev.content)
          out.pop()
          const classes = [opts?.banded && 'banded', opts?.nowrap && 'nowrap'].filter(Boolean)
          if (classes.length) t.attrJoin('class', classes.join(' '))
        }
        out.push(t)
        continue
      }
      if (t.type === 'tr_open') {
        row++
        col = 0
        out.push(t)
        continue
      }
      if (t.type === 'th_open' || t.type === 'td_open') {
        const c = col++
        if (covered.get(`${row},${c}`)) {
          skipping = 1
          continue
        }
        const inline = tokens[i + 1]
        const first = inline?.type === 'inline' ? inline.children?.[0] : undefined
        const pm = first?.type === 'html_inline' ? parseMarker(first.content) : null
        if (pm && inline.children) {
          inline.children.shift()
          const next = inline.children[0]
          if (next?.type === 'text') next.content = next.content.replace(/^\s+/, '')
          const m = pm.marker
          const [cs, rs] = m.span ?? [1, 1]
          if (cs > 1) t.attrSet('colspan', String(cs))
          if (rs > 1) t.attrSet('rowspan', String(rs))
          for (let dr = 0; dr < rs; dr++) for (let dc = 0; dc < cs; dc++) if (dr || dc) covered.set(`${row + dr},${c + dc}`, true)
          const style = cellStyle(m)
          if (style) t.attrSet('style', style)
        }
        out.push(t)
        continue
      }
      if (skipping) {
        if (t.type === 'th_close' || t.type === 'td_close') skipping = 0
        continue
      }
      out.push(t)
    }
    state.tokens = out
  })
}

/** Shared by the preview stylesheet and exports so both look the same. */
export const TABLE_CSS = `
.markdown-body table.banded thead th { background-color: var(--accent, #2f6fb3); color: var(--bg, #fff); border-color: var(--accent, #2f6fb3); }
.markdown-body table.banded tbody tr { background-color: transparent; }
.markdown-body table.banded tbody tr:nth-child(odd) { background-color: color-mix(in srgb, var(--accent, #2f6fb3) 12%, transparent); }
.markdown-body table.nowrap :is(th, td) { white-space: nowrap; }
`
