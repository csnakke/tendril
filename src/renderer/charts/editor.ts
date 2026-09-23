import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { isChartInfo, SVG_END, SVG_START } from './plugin'

/**
 * Editor side of charts: find the ```chart block under the cursor (or at a
 * line the preview points at), and write a chart back as one undoable change.
 */

export interface ChartBlock {
  /** Whole fence, opening line start to closing line end. */
  from: number
  to: number
  /** The YAML between the fences (without the final line break). */
  yaml: string
  bodyFrom: number
  bodyTo: number
  /** 1-based position among the document's charts, for default file names. */
  index: number
  /** The `<!-- chart-svg -->` region right below, if any. */
  svgRegion: { from: number; to: number } | null
}

function tree(state: EditorState): ReturnType<typeof syntaxTree> {
  return ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state)
}

/** Every chart fence in the document, in order. */
export function chartBlocks(state: EditorState): ChartBlock[] {
  const out: ChartBlock[] = []
  tree(state).iterate({
    enter: (n) => {
      if (n.name !== 'FencedCode') return
      const info = n.node.getChild('CodeInfo')
      if (!info || !isChartInfo(state.sliceDoc(info.from, info.to))) return false
      const open = state.doc.lineAt(n.from)
      const last = state.doc.lineAt(n.to)
      // An unclosed fence runs to the end of the document; its body then ends there too.
      const closed = last.number > open.number && /^\s*(`{3,}|~{3,})\s*$/.test(last.text)
      const bodyFrom = Math.min(open.to + 1, state.doc.length)
      const bodyTo = closed ? Math.max(bodyFrom, last.from - 1) : n.to
      out.push({
        from: open.from,
        to: last.to,
        yaml: state.sliceDoc(bodyFrom, bodyTo),
        bodyFrom,
        bodyTo,
        index: out.length + 1,
        svgRegion: closed ? svgRegionAfter(state, last.number) : null
      })
      return false
    }
  })
  return out
}

/** A `<!-- chart-svg -->` … `<!-- /chart-svg -->` region starting on the line after `line`. */
function svgRegionAfter(state: EditorState, line: number): { from: number; to: number } | null {
  if (line >= state.doc.lines) return null
  const start = state.doc.line(line + 1)
  if (start.text.trim() !== SVG_START) return null
  for (let l = line + 2; l <= Math.min(state.doc.lines, line + 6); l++) {
    const end = state.doc.line(l)
    if (end.text.trim() === SVG_END) return { from: start.from, to: end.to }
  }
  return null
}

/** The chart block containing `pos`, or null. */
export function chartAt(state: EditorState, pos: number): ChartBlock | null {
  return chartBlocks(state).find((b) => pos >= b.from && pos <= b.to) ?? null
}

/** The chart block whose fence opens on 0-based `line` (what the preview's data-line holds). */
export function chartAtLine(state: EditorState, line: number): ChartBlock | null {
  if (line < 0 || line >= state.doc.lines) return null
  return chartAt(state, state.doc.line(line + 1).from)
}

const body = (yaml: string): string => yaml.replace(/\s+$/, '')

/** Replace a chart's YAML, keeping its fences. */
export function replaceChart(view: EditorView, block: ChartBlock, yaml: string): ChartBlock | null {
  // An empty fence has no line break of its own before the closing one.
  const nl = view.state.sliceDoc(block.bodyTo, block.bodyTo + 1) === '\n' ? '' : '\n'
  view.dispatch({ changes: { from: block.bodyFrom, to: block.bodyTo, insert: body(yaml) + nl }, userEvent: 'input.chart' })
  return chartAt(view.state, block.from)
}

/** Insert a new chart at the cursor, on lines of its own with a blank line around it. */
export function insertChart(view: EditorView, yaml: string): ChartBlock | null {
  const { state } = view
  const line = state.doc.lineAt(state.selection.main.head)
  // Inside a line: go after it. On an empty line: use it.
  const at = line.text.trim() ? line.to : line.from
  const before = at === 0 ? '' : state.sliceDoc(Math.max(0, at - 2), at)
  const lead = at === 0 || before.endsWith('\n\n') ? '' : before.endsWith('\n') || !line.text.trim() ? '\n' : '\n\n'
  const after = state.sliceDoc(at, at + 2)
  const trail = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : at >= state.doc.length ? '\n' : '\n\n'
  const text = `${lead}\`\`\`chart\n${body(yaml)}\n\`\`\`${trail}`
  const start = at + lead.length
  view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: start }, scrollIntoView: true, userEvent: 'input.chart' })
  return chartAt(view.state, start)
}

/** Put (or refresh) the image link to the chart's SVG right below its fence. */
export function setSvgRegion(view: EditorView, block: ChartBlock, alt: string, rel: string): void {
  const safeAlt = alt.replace(/[[\]\\\n]/g, ' ').trim() || 'Chart'
  const region = `${SVG_START}\n![${safeAlt}](${rel.replace(/ /g, '%20')})\n${SVG_END}`
  const change = block.svgRegion
    ? { from: block.svgRegion.from, to: block.svgRegion.to, insert: region }
    : { from: block.to, insert: '\n' + region }
  view.dispatch({ changes: change, userEvent: 'input.chart' })
}
