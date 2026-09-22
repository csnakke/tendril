import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorSelection, Prec, type EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import {
  cellAt, cellsInRange, deleteColumn, deleteRow, insertColumn, insertRow, isCovered, mergeCells, nextCell,
  parseOptions, parseTable, prevCell, serialiseOptions, serialiseTable, setColumnAlign, setMarker, unmergeCell,
  type Align, type CellMarker, type Grid, type ParsedTable, type Pos, type TableOptions
} from './model'

/**
 * Editor side of Word-like tables: locate the table under the cursor, Tab
 * between cells, and apply model mutations as a single undoable change while
 * keeping the cursor in the same cell.
 */

export interface TableContext {
  from: number
  to: number
  text: string
  parsed: ParsedTable
  options: TableOptions
  /** Range of the `<!-- table: … -->` line (plus its line break), if present. */
  optionsRange: { from: number; to: number } | null
  /** Rectangle of selected cells (the cursor's cell when nothing is selected). */
  rect: { r1: number; c1: number; r2: number; c2: number }
  /** Cell under the cursor (selection head). */
  cursor: Pos
}

function tableNodeAt(state: EditorState, pos: number): { from: number; to: number } | null {
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state)
  for (const side of [-1, 1] as const) {
    let n: { name: string; from: number; to: number; parent: unknown } | null = tree.resolveInner(pos, side)
    while (n) {
      if (n.name === 'Table') return { from: n.from, to: n.to }
      n = n.parent as typeof n
    }
  }
  return null
}

/** The table containing the selection head, or null. */
export function tableContext(state: EditorState, at?: number): TableContext | null {
  const sel = state.selection.main
  // A selection that ends at the start of a line (a drag across a whole row,
  // triple-click, Shift+Down) ends on the previous line as far as cells go.
  const selTo = sel.to > sel.from && state.doc.lineAt(sel.to).from === sel.to ? sel.to - 1 : sel.to
  const head = at ?? (sel.head === sel.to ? selTo : sel.head)
  const anchor = sel.anchor === sel.to ? selTo : sel.anchor
  const node = tableNodeAt(state, head)
  if (!node) return null
  const text = state.sliceDoc(node.from, node.to)
  const parsed = parseTable(text)
  const cursorCell = cellAt(parsed, head - node.from)
  if (!cursorCell) return null
  const anchorInside = at === undefined && anchor >= node.from && anchor <= node.to
  const rect =
    (anchorInside ? cellsInRange(parsed, sel.from - node.from, selTo - node.from) : null) ??
    cellsInRange(parsed, head - node.from, head - node.from) ??
    { r1: cursorCell.row, c1: cursorCell.col, r2: cursorCell.row, c2: cursorCell.col }
  let options: TableOptions = {}
  let optionsRange: TableContext['optionsRange'] = null
  const line = state.doc.lineAt(node.from)
  if (line.number > 1) {
    const prev = state.doc.line(line.number - 1)
    const opts = parseOptions(prev.text)
    if (opts) {
      options = opts
      optionsRange = { from: prev.from, to: line.from }
    }
  }
  return { from: node.from, to: node.to, text, parsed, options, optionsRange, rect, cursor: { row: cursorCell.row, col: cursorCell.col } }
}

/** Replace the table (and its options line) and put the cursor in `focus`, selecting its content when asked. */
export function replaceTable(view: EditorView, ctx: TableContext, grid: Grid, focus: Pos, opts?: { select?: boolean; options?: TableOptions }): void {
  const text = serialiseTable(grid, ctx.parsed.eol)
  const changes: { from: number; to: number; insert: string }[] = [{ from: ctx.from, to: ctx.to, insert: text }]
  let tableFrom = ctx.from
  if (opts?.options) {
    const line = serialiseOptions(opts.options)
    const insert = line ? line + ctx.parsed.eol : ''
    if (ctx.optionsRange) {
      changes.push({ from: ctx.optionsRange.from, to: ctx.optionsRange.to, insert })
      tableFrom = ctx.optionsRange.from + insert.length
    } else if (insert) {
      const lineStart = view.state.doc.lineAt(ctx.from).from
      changes.push({ from: lineStart, to: lineStart, insert })
      tableFrom = ctx.from + insert.length
    }
  }
  const parsed = parseTable(text)
  const row = parsed.cells[Math.min(focus.row, parsed.cells.length - 1)]
  const cell = row[Math.min(focus.col, row.length - 1)]
  // Land after the marker so typing never breaks it.
  const contentFrom = cell.from + (cell.marker ? cell.to - cell.from - cell.text.length : 0)
  const selection = opts?.select
    ? EditorSelection.range(tableFrom + contentFrom, tableFrom + cell.to)
    : EditorSelection.cursor(tableFrom + cell.to)
  view.dispatch({ changes, selection, scrollIntoView: true, userEvent: 'input.table' })
}

// ---- Tab navigation --------------------------------------------------------------

function tab(view: EditorView, forward: boolean): boolean {
  const ctx = tableContext(view.state)
  if (!ctx) return false
  const grid = ctx.parsed.grid
  const target = forward ? nextCell(grid, ctx.cursor) : prevCell(grid, ctx.cursor)
  if (target) {
    replaceTable(view, ctx, grid, target, { select: true })
    return true
  }
  if (!forward) return true
  // Tab on the last cell: a new row, cursor in its first cell (like Word).
  replaceTable(view, ctx, insertRow(grid, grid.rows.length), { row: grid.rows.length, col: 0 })
  return true
}

export const tableKeymap = Prec.high(
  keymap.of([
    { key: 'Tab', run: (v) => tab(v, true) },
    { key: 'Shift-Tab', run: (v) => tab(v, false) }
  ])
)

// ---- Commands (used by the context menu) ------------------------------------------

export const tableCommands = {
  insertRowAbove: (view: EditorView, ctx: TableContext): void =>
    replaceTable(view, ctx, insertRow(ctx.parsed.grid, Math.max(1, ctx.rect.r1)), { row: Math.max(1, ctx.rect.r1), col: ctx.cursor.col }),
  insertRowBelow: (view: EditorView, ctx: TableContext): void =>
    replaceTable(view, ctx, insertRow(ctx.parsed.grid, ctx.rect.r2 + 1), { row: ctx.rect.r2 + 1, col: ctx.cursor.col }),
  insertColumnLeft: (view: EditorView, ctx: TableContext): void =>
    replaceTable(view, ctx, insertColumn(ctx.parsed.grid, ctx.rect.c1), { row: ctx.cursor.row, col: ctx.rect.c1 }),
  insertColumnRight: (view: EditorView, ctx: TableContext): void =>
    replaceTable(view, ctx, insertColumn(ctx.parsed.grid, ctx.rect.c2 + 1), { row: ctx.cursor.row, col: ctx.rect.c2 + 1 }),
  deleteRows: (view: EditorView, ctx: TableContext): void => {
    let grid: Grid | null = ctx.parsed.grid
    for (let r = ctx.rect.r2; r >= ctx.rect.r1 && grid; r--) grid = deleteRow(grid, r) ?? grid
    if (grid) replaceTable(view, ctx, grid, { row: Math.min(ctx.rect.r1, grid.rows.length - 1), col: ctx.cursor.col })
  },
  deleteColumns: (view: EditorView, ctx: TableContext): void => {
    let grid: Grid | null = ctx.parsed.grid
    for (let c = ctx.rect.c2; c >= ctx.rect.c1 && grid; c--) grid = deleteColumn(grid, c) ?? grid
    if (grid) replaceTable(view, ctx, grid, { row: ctx.cursor.row, col: Math.min(ctx.rect.c1, grid.aligns.length - 1) })
  },
  merge: (view: EditorView, ctx: TableContext): void => {
    const grid = mergeCells(ctx.parsed.grid, ctx.rect)
    if (grid) replaceTable(view, ctx, grid, { row: ctx.rect.r1, col: ctx.rect.c1 })
  },
  unmerge: (view: EditorView, ctx: TableContext): void =>
    replaceTable(view, ctx, unmergeCell(ctx.parsed.grid, ctx.cursor), ctx.cursor),
  setMarker: (view: EditorView, ctx: TableContext, patch: Partial<CellMarker>): void =>
    replaceTable(view, ctx, setMarker(ctx.parsed.grid, ctx.rect, patch), ctx.cursor),
  setColumnAlign: (view: EditorView, ctx: TableContext, align: Align | null): void => {
    let grid = ctx.parsed.grid
    for (let c = ctx.rect.c1; c <= ctx.rect.c2; c++) grid = setColumnAlign(grid, c, align)
    replaceTable(view, ctx, grid, ctx.cursor)
  },
  setOptions: (view: EditorView, ctx: TableContext, patch: TableOptions): void =>
    replaceTable(view, ctx, ctx.parsed.grid, ctx.cursor, { options: { ...ctx.options, ...patch } })
}

/** Remove the whole table (and its options line) and the blank line that separated it. */
export function deleteTable(view: EditorView, ctx: TableContext): void {
  const doc = view.state.doc
  let from = ctx.optionsRange?.from ?? doc.lineAt(ctx.from).from
  let to = doc.lineAt(ctx.to).to
  const after = doc.lineAt(ctx.to).number < doc.lines ? doc.line(doc.lineAt(ctx.to).number + 1) : null
  if (after && after.text.trim() === '') to = after.to
  else if (from > 0) from -= 1
  view.dispatch({ changes: { from, to }, selection: { anchor: Math.min(from, doc.length) }, scrollIntoView: true, userEvent: 'delete.table' })
}

/** Insert an empty cols x rows table (header row counted, like Word) at the cursor. */
export function insertTable(view: EditorView, cols: number, rows: number): void {
  cols = Math.max(1, Math.min(cols, 50))
  rows = Math.max(1, Math.min(rows, 200))
  const grid: Grid = {
    aligns: Array.from({ length: cols }, () => null),
    rows: [
      Array.from({ length: cols }, (_, c) => ({ marker: null, text: `Column ${c + 1}` })),
      ...Array.from({ length: rows - 1 }, () => Array.from({ length: cols }, () => ({ marker: null, text: '' })))
    ]
  }
  const table = serialiseTable(grid)
  const doc = view.state.doc
  const line = doc.lineAt(view.state.selection.main.head)
  // Tables need a blank line on both sides to be their own block.
  const prev = line.number > 1 ? doc.line(line.number - 1) : null
  const next = line.number < doc.lines ? doc.line(line.number + 1) : null
  let from: number, to: number, insert: string
  if (line.text.trim() === '') {
    from = line.from
    to = line.to
    insert = (prev && prev.text.trim() !== '' ? '\n' : '') + table + (next && next.text.trim() !== '' ? '\n' : '')
  } else {
    from = to = line.to
    insert = '\n\n' + table + (next && next.text.trim() !== '' ? '\n' : '')
  }
  const tableFrom = from + insert.indexOf('|')
  const first = parseTable(table).cells[0][0]
  view.dispatch({
    changes: { from, to, insert },
    selection: EditorSelection.range(tableFrom + first.from, tableFrom + first.to),
    scrollIntoView: true,
    userEvent: 'input.table'
  })
  view.focus()
}

/** What the menu can offer for this selection. */
export function tableCapabilities(ctx: TableContext): { canMerge: boolean; canUnmerge: boolean; multi: boolean } {
  const { rect, parsed, cursor } = ctx
  const multi = rect.r1 !== rect.r2 || rect.c1 !== rect.c2
  const anchorSpan = parsed.grid.rows[cursor.row]?.[cursor.col]?.marker?.span
  return {
    multi,
    canMerge: multi && !(rect.r1 === 0 && rect.r2 > 0),
    canUnmerge: !!anchorSpan || isCovered(parsed.grid, cursor)
  }
}
