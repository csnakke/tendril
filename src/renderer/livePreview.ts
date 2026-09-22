import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { StateField, type EditorState, type Range } from '@codemirror/state'
import { PropertiesWidget } from './propertiesWidget'
import { parseMarker, parseOptions } from './tables/model'
import { safeDecodeURI } from './paths'

/**
 * Obsidian-style live preview: Markdown renders in place, except on lines
 * that hold the cursor/selection, which show their raw source so the markup
 * can be edited. Styling classes (headings, emphasis, …) always apply; only
 * the *hiding* of markers is suspended on active lines.
 */

class TextWidget extends WidgetType {
  constructor(private text: string, private cls: string) {
    super()
  }
  eq(o: TextWidget): boolean {
    return o.text === this.text && o.cls === this.cls
  }
  toDOM(): HTMLElement {
    const s = document.createElement('span')
    s.className = this.cls
    s.textContent = this.text
    return s
  }
  ignoreEvent(): boolean {
    return false
  }
}

class HrWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const s = document.createElement('span')
    s.className = 'lp-hr'
    return s
  }
}

class CheckboxWidget extends WidgetType {
  constructor(private checked: boolean, private pos: number) {
    super()
  }
  eq(o: CheckboxWidget): boolean {
    return o.checked === this.checked && o.pos === this.pos
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'lp-task'
    box.checked = this.checked
    box.addEventListener('mousedown', (e) => e.preventDefault())
    box.addEventListener('click', () => {
      // TaskMarker is "[ ]" / "[x]": flip the character between the brackets.
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? ' ' : 'x' } })
    })
    return box
  }
  ignoreEvent(): boolean {
    return false
  }
}

/** An image rendered in place of its `![alt](src)` source; a click lands the cursor on it. */
class ImageWidget extends WidgetType {
  constructor(private src: string, private alt: string, private title: string) {
    super()
  }
  eq(o: ImageWidget): boolean {
    return o.src === this.src && o.alt === this.alt && o.title === this.title
  }
  toDOM(): HTMLElement {
    const box = document.createElement('span')
    box.className = 'lp-image'
    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    if (this.title) img.title = this.title
    img.draggable = false
    img.addEventListener('error', () => {
      box.classList.add('broken')
      box.textContent = this.alt || 'image'
    })
    box.appendChild(img)
    return box
  }
  ignoreEvent(): boolean {
    return false
  }
}

const bullet = Decoration.replace({ widget: new TextWidget('•', 'lp-bullet') })
const hr = Decoration.replace({ widget: new HrWidget() })
const hide = Decoration.replace({})
const pagebreak = Decoration.replace({ widget: new TextWidget('', 'lp-pagebreak') })
const label = (text: string): Decoration => Decoration.replace({ widget: new TextWidget(text, 'lp-label') })

const RE_PAGEBREAK = /^<!--\s*pagebreak\s*-->\s*$/i
const RE_COVER_START = /^<!--\s*cover\s*-->\s*$/i
const RE_COVER_END = /^<!--\s*\/cover\s*-->\s*$/i

/** 0-based line range of a leading `---` YAML block, scanning at most 200 lines. */
function frontMatterRange(state: EditorState): { from: number; to: number } | null {
  if (state.doc.lines < 2 || !/^---\s*$/.test(state.doc.line(1).text)) return null
  for (let n = 2; n <= Math.min(state.doc.lines, 200); n++) {
    const line = state.doc.line(n)
    if (/^(---|\.\.\.)\s*$/.test(line.text)) return { from: 0, to: line.to }
  }
  return null
}

const HEADING = /^ATXHeading([1-6])$/
const MARKS: Record<string, string> = {
  Emphasis: 'lp-em',
  StrongEmphasis: 'lp-strong',
  Strikethrough: 'lp-strike',
  InlineCode: 'lp-code',
  Link: 'lp-link',
  Image: 'lp-link',
  Comment: 'lp-comment',
  HTMLTag: 'lp-comment',
  Autolink: 'lp-link',
  URL: 'lp-url'
}
// Marker nodes hidden on inactive lines (with an optional following space).
const HIDDEN: Record<string, boolean> = {
  HeaderMark: true,
  EmphasisMark: false,
  StrikethroughMark: false,
  CodeMark: false,
  LinkMark: false,
  QuoteMark: true,
  CodeInfo: false
}

function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>()
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number
    const b = state.doc.lineAt(r.to).number
    for (let l = a; l <= b; l++) lines.add(l)
  }
  return lines
}

/** Maps an image path as written in the note to a URL the editor can load. */
export type ImageResolver = (src: string) => string

function build(view: EditorView, resolveImage: ImageResolver): DecorationSet {
  const { state } = view
  const active = activeLines(state)
  const isActive = (from: number, to = from): boolean => {
    const a = state.doc.lineAt(from).number
    const b = state.doc.lineAt(to).number
    for (let l = a; l <= b; l++) if (active.has(l)) return true
    return false
  }
  const decos: Range<Decoration>[] = []
  const lineClasses = new Map<number, Set<string>>()
  const addLine = (pos: number, cls: string): void => {
    const line = state.doc.lineAt(pos)
    let set = lineClasses.get(line.from)
    if (!set) lineClasses.set(line.from, (set = new Set()))
    set.add(cls)
  }
  const eachLine = (from: number, to: number, cls: string): void => {
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos)
      addLine(line.from, cls)
      pos = line.to + 1
    }
  }
  const tree = syntaxTree(state)

  // Front matter shows raw (styled) while the cursor is inside; otherwise the
  // block widget from `propertiesField` replaces it.
  const fm = frontMatterRange(state)
  if (fm && isActive(fm.from, fm.to)) eachLine(fm.from, fm.to, 'lp-frontmatter')

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name
        // The Markdown parser reads "key: value" + "---" as a setext heading; skip it.
        if (fm && node.from <= fm.to && name !== 'Document') return false
        if (name === 'CommentBlock' || name === 'HTMLBlock') {
          // Marker lines are matched per line: raw HTML swallows a following
          // marker into the same block when no blank line separates them.
          for (let pos = node.from; pos <= node.to; ) {
            const line = state.doc.lineAt(pos)
            const to = Math.min(line.to, node.to)
            const text = state.sliceDoc(line.from, to)
            const opts = name === 'CommentBlock' ? parseOptions(text) : null
            const marker = RE_PAGEBREAK.test(text) ? pagebreak : RE_COVER_START.test(text) ? label('Cover page') : RE_COVER_END.test(text) ? label('End of cover')
              : opts ? label(['Table', opts.banded && 'banded rows', opts.nowrap && 'no wrap'].filter(Boolean).join(' · ')) : null
            if (marker && !active.has(line.number)) decos.push(marker.range(line.from, to))
            else if (line.from < to) decos.push(Decoration.mark({ class: marker || name === 'CommentBlock' ? 'lp-comment' : 'lp-html' }).range(line.from, to))
            pos = line.to + 1
          }
          return false
        }
        const h = HEADING.exec(name)
        if (h) {
          addLine(node.from, `lp-h${h[1]}`)
          return
        }
        if (name === 'SetextHeading1' || name === 'SetextHeading2') {
          addLine(node.from, name === 'SetextHeading1' ? 'lp-h1' : 'lp-h2')
          return
        }
        if (name === 'Blockquote') {
          eachLine(node.from, node.to, 'lp-quote')
          return
        }
        if (name === 'FencedCode' || name === 'CodeBlock') {
          eachLine(node.from, node.to, 'lp-codeblock')
          return
        }
        if (name === 'Image' && !isActive(node.from, node.to)) {
          // Inline image `![alt](src "title")`: shown rendered until the line is edited.
          const url = node.node.getChild('URL')
          const marks = node.node.getChildren('LinkMark')
          if (url && marks.length >= 2) {
            const alt = state.sliceDoc(marks[0].to, marks[1].from)
            const title = node.node.getChild('LinkTitle')
            const src = resolveImage(safeDecodeURI(state.sliceDoc(url.from, url.to)))
            decos.push(Decoration.replace({ widget: new ImageWidget(src, alt, title ? state.sliceDoc(title.from + 1, title.to - 1) : '') }).range(node.from, node.to))
            return false
          }
        }
        if (name === 'HorizontalRule') {
          if (!isActive(node.from)) decos.push(hr.range(node.from, node.to))
          return
        }
        if (name === 'ListMark') {
          const text = state.sliceDoc(node.from, node.to)
          if (/^[-*+]$/.test(text) && !isActive(node.from)) decos.push(bullet.range(node.from, node.to))
          return
        }
        if (name === 'TaskMarker') {
          if (!isActive(node.from)) {
            const checked = /x/i.test(state.sliceDoc(node.from, node.to))
            decos.push(Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }).range(node.from, node.to))
          }
          return
        }
        if (name in HIDDEN) {
          if (isActive(node.from)) return
          let end = node.to
          if (HIDDEN[name] && state.sliceDoc(end, end + 1) === ' ') end++
          // A closing fence line: hide the whole line's content, keep the line.
          if (node.from < end) decos.push(hide.range(node.from, end))
          return
        }
        if (name === 'URL' || name === 'LinkTitle') {
          // Inside a link/image the destination is hidden; bare autolinks stay.
          const parent = node.node.parent?.name
          if ((parent === 'Link' || parent === 'Image') && !isActive(node.from)) decos.push(hide.range(node.from, node.to))
          else if (node.from < node.to) decos.push(Decoration.mark({ class: 'lp-url' }).range(node.from, node.to))
          return
        }
        if (name === 'Comment' && node.node.parent?.name === 'TableCell') {
          // A cell marker: hidden while the cursor is elsewhere, and the cell
          // text takes the marker's colours so shading shows while editing.
          const cell = node.node.parent
          const pm = parseMarker(state.sliceDoc(node.from, node.to))
          if (pm && node.from === cell.from) {
            const contentFrom = Math.min(cell.to, node.to + (state.sliceDoc(node.to, node.to + 1) === ' ' ? 1 : 0))
            if (!isActive(node.from)) decos.push(hide.range(node.from, contentFrom))
            const style = [pm.marker.bg && `background-color:${pm.marker.bg}`, pm.marker.fg && `color:${pm.marker.fg}`].filter(Boolean).join(';')
            if (style && contentFrom < cell.to) decos.push(Decoration.mark({ class: 'lp-cell', attributes: { style } }).range(contentFrom, cell.to))
            if (isActive(node.from)) decos.push(Decoration.mark({ class: 'lp-comment' }).range(node.from, node.to))
            return
          }
        }
        const cls = MARKS[name]
        if (cls && node.from < node.to) decos.push(Decoration.mark({ class: cls }).range(node.from, node.to))
      }
    })
  }

  for (const [pos, classes] of lineClasses) decos.push(Decoration.line({ class: [...classes].join(' ') }).range(pos))
  return Decoration.set(decos, true)
}

/** Block decorations must come from state, not a view plugin. */
function propertiesDecorations(state: EditorState): DecorationSet {
  const fm = frontMatterRange(state)
  if (!fm) return Decoration.none
  const active = activeLines(state)
  const last = state.doc.lineAt(fm.to)
  for (let l = 1; l <= last.number; l++) if (active.has(l)) return Decoration.none
  const first = state.doc.line(1)
  const yamlFrom = Math.min(first.to + 1, last.from)
  const yamlTo = Math.max(yamlFrom, last.from - 1)
  const widget = new PropertiesWidget(state.sliceDoc(yamlFrom, yamlTo), yamlFrom, yamlTo)
  return Decoration.set([Decoration.replace({ widget, block: true }).range(first.from, last.to)])
}

const propertiesField = StateField.define<DecorationSet>({
  create: propertiesDecorations,
  update(value, tr) {
    return tr.docChanged || tr.selection ? propertiesDecorations(tr.state) : value
  },
  provide: (f) => EditorView.decorations.from(f)
})

export function livePreview(resolveImage: ImageResolver = (s) => s) {
  return [propertiesField, inlinePlugin(resolveImage)]
}

function inlinePlugin(resolveImage: ImageResolver) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = build(view, resolveImage)
      }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.selectionSet || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
          this.decorations = build(u.view, resolveImage)
        }
      }
    },
    { decorations: (v) => v.decorations }
  )
}
