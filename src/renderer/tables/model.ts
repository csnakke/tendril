/**
 * Word-like table formatting on top of GFM pipe tables. Everything GFM cannot
 * express is written by the app as HTML comments, which GitHub/GitBook drop:
 *
 *   <!-- table: banded nowrap -->          table options, the line above the table
 *   | <!--bg:#fde8e8 fg:#b00000-->Q1 |    cell marker, first thing in the cell
 *
 * Marker keys: bg, fg (colours), span:CxR (colspan x rowspan), align. Cells
 * covered by a span stay in the source, empty, so the column count holds.
 * This module is pure string manipulation; the editor glue lives in editor.ts.
 */

export type Align = 'left' | 'center' | 'right'

export interface CellMarker {
  bg?: string
  fg?: string
  /** [colspan, rowspan]; absent means 1x1. */
  span?: [number, number]
  align?: Align
}

export interface GridCell {
  marker: CellMarker | null
  text: string
}

/** rows[0] is the header; the delimiter row is `aligns`. */
export interface Grid {
  aligns: (Align | null)[]
  rows: GridCell[][]
}

export interface Cell extends GridCell {
  row: number
  col: number
  /** Content range in the table text (marker included, padding excluded). */
  from: number
  to: number
  /** Raw segment between the pipes, and the end of the row's line. */
  segFrom: number
  segTo: number
  lineTo: number
}

export interface ParsedTable {
  grid: Grid
  cells: Cell[][]
  eol: string
}

export interface TableOptions {
  banded?: boolean
  nowrap?: boolean
}

export interface Pos {
  row: number
  col: number
}

// ---- Markers -------------------------------------------------------------------

const MARKER = /^<!--\s*([^>]*?)\s*-->/
const OPTIONS = /^<!--\s*table:\s*(.*?)\s*-->\s*$/i
const COLOUR = /^#[0-9a-f]{3,8}$/i

export function parseMarker(text: string): { marker: CellMarker; length: number } | null {
  const m = MARKER.exec(text)
  if (!m) return null
  const marker: CellMarker = {}
  let known = false
  for (const pair of m[1].split(/\s+/).filter(Boolean)) {
    const i = pair.indexOf(':')
    if (i < 0) return null
    const key = pair.slice(0, i)
    const val = pair.slice(i + 1)
    if ((key === 'bg' || key === 'fg') && COLOUR.test(val)) marker[key] = val.toLowerCase()
    else if (key === 'span' && /^\d+x\d+$/.test(val)) {
      const [c, r] = val.split('x').map(Number)
      if (c > 1 || r > 1) marker.span = [Math.max(1, c), Math.max(1, r)]
    } else if (key === 'align' && (val === 'left' || val === 'center' || val === 'right')) marker.align = val
    else return null // not one of ours: leave the comment alone
    known = true
  }
  return known ? { marker, length: m[0].length } : null
}

export function serialiseMarker(m: CellMarker | null): string {
  if (!m) return ''
  const parts: string[] = []
  if (m.bg) parts.push(`bg:${m.bg}`)
  if (m.fg) parts.push(`fg:${m.fg}`)
  if (m.span && (m.span[0] > 1 || m.span[1] > 1)) parts.push(`span:${m.span[0]}x${m.span[1]}`)
  if (m.align) parts.push(`align:${m.align}`)
  return parts.length ? `<!--${parts.join(' ')}-->` : ''
}

/** Drop empty keys so "no marker" round-trips as null. */
export function normaliseMarker(m: CellMarker | null): CellMarker | null {
  if (!m) return null
  const n = { ...m }
  if (n.span && n.span[0] <= 1 && n.span[1] <= 1) delete n.span
  return serialiseMarker(n) ? n : null
}

export function parseOptions(line: string): TableOptions | null {
  const m = OPTIONS.exec(line.trim())
  if (!m) return null
  const opts: TableOptions = {}
  for (const k of m[1].split(/\s+/).filter(Boolean)) {
    if (k === 'banded' || k === 'nowrap') opts[k] = true
  }
  return opts
}

export function serialiseOptions(opts: TableOptions): string {
  const keys = (['banded', 'nowrap'] as const).filter((k) => opts[k])
  return keys.length ? `<!-- table: ${keys.join(' ')} -->` : ''
}

// ---- Parsing -------------------------------------------------------------------

/** Split a table row on unescaped pipes; returns [from, to) of each raw segment. */
function splitRow(line: string, offset: number): [number, number][] {
  let start = 0
  let end = line.length
  while (start < end && /\s/.test(line[start])) start++
  while (end > start && /\s/.test(line[end - 1])) end--
  if (line[start] === '|') start++
  // A trailing pipe closes the row unless it is escaped.
  if (end > start && line[end - 1] === '|' && line[end - 2] !== '\\') end--
  const segs: [number, number][] = []
  let segFrom = start
  for (let i = start; i < end; i++) {
    if (line[i] === '\\') {
      i++
      continue
    }
    if (line[i] === '|') {
      segs.push([offset + segFrom, offset + i])
      segFrom = i + 1
    }
  }
  segs.push([offset + segFrom, offset + end])
  return segs
}

function parseAlign(seg: string): Align | null {
  const s = seg.trim()
  const left = s.startsWith(':')
  const right = s.endsWith(':')
  return left && right ? 'center' : right ? 'right' : left ? 'left' : null
}

/** Parse the text of one GFM table (header, delimiter, body rows). */
export function parseTable(text: string): ParsedTable {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const offsets: number[] = []
  let off = 0
  for (const l of lines) {
    offsets.push(off)
    off += l.length + eol.length
  }
  const aligns = lines.length > 1 ? splitRow(lines[1], 0).map(([a, b]) => parseAlign(lines[1].slice(a, b))) : []
  const cells: Cell[][] = []
  const rows: GridCell[][] = []
  let row = 0
  for (let i = 0; i < lines.length; i++) {
    if (i === 1) continue
    if (i > 1 && lines[i].trim() === '') break
    const segs = splitRow(lines[i], offsets[i])
    const cellRow: Cell[] = []
    const gridRow: GridCell[] = []
    segs.forEach(([segFrom, segTo], col) => {
      let from = segFrom
      let to = segTo
      while (from < to && /\s/.test(text[from])) from++
      while (to > from && /\s/.test(text[to - 1])) to--
      if (from === to) from = to = Math.min(segFrom + 1, segTo)
      const raw = text.slice(from, to)
      const pm = parseMarker(raw)
      const cell: Cell = {
        row,
        col,
        from,
        to,
        segFrom,
        segTo,
        lineTo: offsets[i] + lines[i].length,
        marker: pm?.marker ?? null,
        text: (pm ? raw.slice(pm.length) : raw).trim()
      }
      cellRow.push(cell)
      gridRow.push({ marker: cell.marker, text: cell.text })
    })
    cells.push(cellRow)
    rows.push(gridRow)
    row++
  }
  return { grid: { aligns, rows }, cells, eol }
}

// ---- Serialising -----------------------------------------------------------------

const cellSource = (c: GridCell): string => serialiseMarker(c.marker) + c.text

/** Emit the grid as an aligned pipe table (every mutation goes through here). */
export function serialiseTable(grid: Grid, eol = '\n'): string {
  const cols = Math.max(grid.aligns.length, ...grid.rows.map((r) => r.length))
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(3, ...grid.rows.map((r) => (r[c] ? cellSource(r[c]).length : 0)))
  )
  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - s.length))
  const line = (parts: string[]): string => `| ${parts.join(' | ')} |`
  const out: string[] = []
  const rowLine = (r: GridCell[]): string => line(widths.map((w, c) => pad(r[c] ? cellSource(r[c]) : '', w)))
  out.push(rowLine(grid.rows[0] ?? []))
  out.push(
    line(
      widths.map((w, c) => {
        const a = grid.aligns[c] ?? null
        const dashes = '-'.repeat(w - (a === 'center' ? 2 : a ? 1 : 0))
        return a === 'center' ? `:${dashes}:` : a === 'right' ? `${dashes}:` : a === 'left' ? `:${dashes}` : dashes
      })
    )
  )
  for (const r of grid.rows.slice(1)) out.push(rowLine(r))
  return out.join(eol)
}

/** Normalise a possibly ragged grid to a rectangle. */
function square(grid: Grid): Grid {
  const cols = Math.max(grid.aligns.length, ...grid.rows.map((r) => r.length))
  return {
    aligns: Array.from({ length: cols }, (_, c) => grid.aligns[c] ?? null),
    rows: grid.rows.map((r) => Array.from({ length: cols }, (_, c) => r[c] ?? { marker: null, text: '' }))
  }
}

export const formatTable = (text: string): string => {
  const t = parseTable(text)
  return serialiseTable(square(t.grid), t.eol)
}

// ---- Spans -----------------------------------------------------------------------

const key = (r: number, c: number): string => `${r},${c}`

/** Map of covered cell → its anchor, for every span in the grid. */
export function coveredCells(grid: Grid): Map<string, Pos> {
  const out = new Map<string, Pos>()
  grid.rows.forEach((row, r) =>
    row.forEach((cell, c) => {
      const [cs, rs] = cell.marker?.span ?? [1, 1]
      for (let dr = 0; dr < rs; dr++)
        for (let dc = 0; dc < cs; dc++) {
          if (dr || dc) out.set(key(r + dr, c + dc), { row: r, col: c })
        }
    })
  )
  return out
}

export function isCovered(grid: Grid, p: Pos): boolean {
  return coveredCells(grid).has(key(p.row, p.col))
}

/** The anchor cell that owns `p` (itself unless covered). */
export function anchorOf(grid: Grid, p: Pos): Pos {
  return coveredCells(grid).get(key(p.row, p.col)) ?? p
}

// ---- Navigation ------------------------------------------------------------------

/** Next cell in reading order, skipping covered cells; null past the last cell. */
export function nextCell(grid: Grid, p: Pos): Pos | null {
  const covered = coveredCells(grid)
  let { row, col } = p
  for (;;) {
    col++
    if (col >= (grid.rows[row]?.length ?? 0)) {
      row++
      col = 0
      if (row >= grid.rows.length) return null
    }
    if (!covered.has(key(row, col))) return { row, col }
  }
}

export function prevCell(grid: Grid, p: Pos): Pos | null {
  const covered = coveredCells(grid)
  let { row, col } = p
  for (;;) {
    col--
    if (col < 0) {
      row--
      if (row < 0) return null
      col = (grid.rows[row]?.length ?? 1) - 1
    }
    if (!covered.has(key(row, col))) return { row, col }
  }
}

export function cellAt(t: ParsedTable, offset: number): Cell | null {
  for (const row of t.cells) {
    for (let i = 0; i < row.length; i++) {
      const c = row[i]
      // A cell owns everything from the pipe before it to the pipe after it
      // (the last cell also owns the trailing pipe and line end).
      const end = i === row.length - 1 ? c.lineTo : c.segTo
      if (offset >= c.segFrom - 1 && offset <= end) return c
    }
  }
  return null
}

/** Bounding rectangle of the cells touched by [from, to], span-expanded. */
export function cellsInRange(t: ParsedTable, from: number, to: number): { r1: number; c1: number; r2: number; c2: number } | null {
  const a = cellAt(t, Math.min(from, to))
  const b = cellAt(t, Math.max(from, to))
  if (!a || !b) return null
  let r1 = Math.min(a.row, b.row), r2 = Math.max(a.row, b.row)
  let c1 = Math.min(a.col, b.col), c2 = Math.max(a.col, b.col)
  // Grow until every span inside the rectangle is fully inside it.
  const covered = coveredCells(t.grid)
  for (let changed = true; changed; ) {
    changed = false
    for (let r = r1; r <= r2; r++)
      for (let c = c1; c <= c2; c++) {
        const anchor = covered.get(key(r, c)) ?? { row: r, col: c }
        const [cs, rs] = t.grid.rows[anchor.row]?.[anchor.col]?.marker?.span ?? [1, 1]
        const nr1 = Math.min(r1, anchor.row), nc1 = Math.min(c1, anchor.col)
        const nr2 = Math.max(r2, anchor.row + rs - 1), nc2 = Math.max(c2, anchor.col + cs - 1)
        if (nr1 !== r1 || nc1 !== c1 || nr2 !== r2 || nc2 !== c2) {
          r1 = nr1; c1 = nc1; r2 = nr2; c2 = nc2
          changed = true
        }
      }
  }
  return { r1, c1, r2, c2 }
}

// ---- Mutations (all return a new grid) --------------------------------------------

const clone = (grid: Grid): Grid => ({
  aligns: [...grid.aligns],
  rows: grid.rows.map((r) => r.map((c) => ({ marker: c.marker ? { ...c.marker } : null, text: c.text })))
})

const setCell = (grid: Grid, p: Pos, patch: Partial<CellMarker>): void => {
  const cell = grid.rows[p.row]?.[p.col]
  if (!cell) return
  const next: CellMarker = { ...(cell.marker ?? {}) }
  for (const [k, v] of Object.entries(patch) as [keyof CellMarker, unknown][]) {
    if (v === undefined) delete next[k]
    else (next as Record<string, unknown>)[k] = v
  }
  cell.marker = normaliseMarker(next)
}

/** Apply a marker patch (undefined values clear the key) to every anchor cell in the rectangle. */
export function setMarker(grid: Grid, rect: { r1: number; c1: number; r2: number; c2: number }, patch: Partial<CellMarker>): Grid {
  const g = square(clone(grid))
  const covered = coveredCells(g)
  for (let r = rect.r1; r <= rect.r2; r++)
    for (let c = rect.c1; c <= rect.c2; c++) if (!covered.has(key(r, c))) setCell(g, { row: r, col: c }, patch)
  return g
}

/**
 * Merge and Center: the top-left cell spans the rectangle, texts are joined,
 * covered cells are emptied. A merge across the header/body boundary is
 * invalid HTML and is refused (null).
 */
export function mergeCells(grid: Grid, rect: { r1: number; c1: number; r2: number; c2: number }): Grid | null {
  const { r1, c1, r2, c2 } = rect
  if (r1 === r2 && c1 === c2) return null
  if (r1 === 0 && r2 > 0) return null
  const g = square(clone(grid))
  const texts: string[] = []
  for (let r = r1; r <= r2; r++)
    for (let c = c1; c <= c2; c++) {
      const cell = g.rows[r][c]
      if (cell.text) texts.push(cell.text)
      cell.text = ''
      if (r !== r1 || c !== c1) cell.marker = null
    }
  const anchor = g.rows[r1][c1]
  anchor.text = texts.join(' ')
  setCell(g, { row: r1, col: c1 }, { span: [c2 - c1 + 1, r2 - r1 + 1], align: 'center' })
  return g
}

export function unmergeCell(grid: Grid, p: Pos): Grid {
  const g = square(clone(grid))
  setCell(g, anchorOf(g, p), { span: undefined, align: undefined })
  return g
}

const emptyRow = (cols: number): GridCell[] => Array.from({ length: cols }, () => ({ marker: null, text: '' }))

/** Insert an empty body row at index `at` (1 = right after the header). */
export function insertRow(grid: Grid, at: number): Grid {
  const g = square(clone(grid))
  at = Math.max(1, Math.min(at, g.rows.length))
  // A span straddling the insertion point grows to include the new row.
  g.rows.forEach((row, r) =>
    row.forEach((cell) => {
      const span = cell.marker?.span
      if (span && r < at && r + span[1] > at) cell.marker!.span = [span[0], span[1] + 1]
    })
  )
  g.rows.splice(at, 0, emptyRow(g.aligns.length))
  return g
}

export function deleteRow(grid: Grid, r: number): Grid | null {
  if (r < 1 || r >= grid.rows.length) return null
  const g = square(clone(grid))
  const covered = coveredCells(g)
  g.rows[r].forEach((cell, c) => {
    // Deleting an anchor row hands the span to the row below.
    const span = cell.marker?.span
    if (span && span[1] > 1 && g.rows[r + 1]) {
      g.rows[r + 1][c].marker = normaliseMarker({ ...cell.marker, span: [span[0], span[1] - 1] })
      g.rows[r + 1][c].text = cell.text
    }
    const anchor = covered.get(key(r, c))
    if (anchor && anchor.row !== r) {
      const a = g.rows[anchor.row][anchor.col]
      const [cs, rs] = a.marker!.span!
      a.marker = normaliseMarker({ ...a.marker, span: [cs, rs - 1] })
    }
  })
  g.rows.splice(r, 1)
  return g
}

export function insertColumn(grid: Grid, at: number): Grid {
  const g = square(clone(grid))
  at = Math.max(0, Math.min(at, g.aligns.length))
  g.rows.forEach((row) =>
    row.forEach((cell, c) => {
      const span = cell.marker?.span
      if (span && c < at && c + span[0] > at) cell.marker!.span = [span[0] + 1, span[1]]
    })
  )
  g.aligns.splice(at, 0, null)
  for (const row of g.rows) row.splice(at, 0, { marker: null, text: '' })
  return g
}

export function deleteColumn(grid: Grid, c: number): Grid | null {
  if (grid.aligns.length <= 1 || c < 0 || c >= grid.aligns.length) return null
  const g = square(clone(grid))
  const covered = coveredCells(g)
  g.rows.forEach((row, r) => {
    const cell = row[c]
    const span = cell.marker?.span
    if (span && span[0] > 1 && row[c + 1]) {
      row[c + 1].marker = normaliseMarker({ ...cell.marker, span: [span[0] - 1, span[1]] })
      row[c + 1].text = cell.text
    }
    const anchor = covered.get(key(r, c))
    if (anchor && anchor.col !== c) {
      const a = g.rows[anchor.row][anchor.col]
      const [cs, rs] = a.marker!.span!
      a.marker = normaliseMarker({ ...a.marker, span: [cs - 1, rs] })
    }
  })
  g.aligns.splice(c, 1)
  for (const row of g.rows) row.splice(c, 1)
  // Spans reduced to 1x1 lose their centring only if nothing else set it; keep it simple: leave align.
  return g
}

export function setColumnAlign(grid: Grid, c: number, align: Align | null): Grid {
  const g = square(clone(grid))
  if (c >= 0 && c < g.aligns.length) g.aligns[c] = align
  return g
}
