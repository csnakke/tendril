import { CORE_SCHEMA, dump, load } from 'js-yaml'

/**
 * Charts are written into the note as a fenced block of YAML:
 *
 *   ```chart
 *   type: pie3d
 *   title: Findings by severity
 *   palette: severity
 *   data:
 *     - { label: Critical, value: 2 }
 *     - { label: High, value: 5 }
 *   ```
 *
 * GitHub shows the block as readable code; Tendril draws it (svg.ts). This
 * module turns the YAML into a complete, validated spec — every option has a
 * default and every number is clamped — and back into compact YAML for the
 * chart dialog. Pure: no DOM, so it runs in the unit tests as it is.
 */

export type ChartType = 'bar3d' | 'pie3d'
export type LabelMode = 'auto' | 'value' | 'percent' | 'label' | 'none'
export type LegendPos = 'auto' | 'right' | 'bottom' | 'top' | 'none'
export type Align = 'left' | 'center' | 'right'

export interface Series {
  name: string
  values: number[]
  color?: string
}

export interface ChartOptions {
  width: number
  height: number
  /** Colour, or 'none' for transparent. */
  background: string
  font: string
  fontSize: number
  /** Colours, or 'auto' to follow the surrounding text colour (light and dark themes alike). */
  textColor: string
  titleColor: string
  align: Align
  legend: LegendPos
  labels: LabelMode
  /** Decimal places for values; -1 = as written (up to 2). */
  decimals: number
  prefix: string
  suffix: string
  /** Extrusion thickness in px. */
  depth: number
  /** Light the faces with a soft gradient. */
  gradient: boolean
  /** Thin darker outline on every face. */
  edges: boolean
  shadow: boolean
  /** One-series bars: a colour per bar instead of one for the series. */
  varyColors: boolean
  // ---- pie ----
  /** Viewing angle in degrees: 90 looks straight down, lower tilts the disc away. */
  tilt: number
  /** Where the first slice starts, degrees clockwise from 12 o'clock. */
  rotation: number
  /** Labels of the slices pulled out of the pie; ['*'] pulls out every slice. */
  explode: string[]
  explodeDistance: number
  /** Inner hole as a fraction of the radius (0 = full pie). */
  donut: number
  // ---- bar ----
  /** Direction the bars recede in, degrees above the horizontal. */
  angle: number
  /** Fraction of each category slot left empty between groups. */
  gap: number
  stacked: boolean
  horizontal: boolean
  grid: boolean
  gridColor: string
  /** Value axis range and tick step; null = automatic. */
  min: number | null
  max: number | null
  step: number | null
  valueTitle: string
  categoryTitle: string
}

export interface ChartSpec {
  type: ChartType
  title: string
  caption: string
  /** Palette name, or the list of colours given. */
  palette: string | string[]
  categories: string[]
  series: Series[]
  /** Per-category colours from the `data:` form (one series), aligned with `categories`. */
  pointColors: (string | null)[]
  options: ChartOptions
}

export type ParseResult = { spec: ChartSpec } | { error: string }

// ---- Colours --------------------------------------------------------------------

/** Word's Office palette, which the table shading swatches use too. */
export const PALETTES: Record<string, string[]> = {
  default: ['#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47', '#264478', '#9e480e', '#636363', '#997300'],
  severity: ['#c00000', '#ed7d31', '#ffc000', '#548235', '#5b9bd5', '#7f7f7f'],
  mono: ['#1f3864', '#2f5597', '#4472c4', '#8faadc', '#b4c7e7', '#dae3f3'],
  pastel: ['#a8d5ba', '#f6c28b', '#f4a6a6', '#a7c7e7', '#d7bde2', '#f9e79f', '#aed6f1', '#f5cba7'],
  vivid: ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#469990', '#9a6324'],
  earth: ['#7f5539', '#b08968', '#9c6644', '#606c38', '#283618', '#bc6c25', '#dda15e', '#a3b18a']
}
export const PALETTE_NAMES = Object.keys(PALETTES)

/** Severity names get their own colour whatever order they come in. */
const SEVERITY: Record<string, string> = {
  critical: '#c00000',
  high: '#ed7d31',
  medium: '#ffc000',
  moderate: '#ffc000',
  low: '#548235',
  info: '#5b9bd5',
  informational: '#5b9bd5',
  none: '#7f7f7f'
}

/** The CSS names a note is likely to use; anything else must be hex. */
const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', gray: '#808080', grey: '#808080', silver: '#c0c0c0', red: '#ff0000',
  maroon: '#800000', orange: '#ffa500', gold: '#ffd700', yellow: '#ffff00', olive: '#808000', lime: '#00ff00',
  green: '#008000', teal: '#008080', cyan: '#00ffff', aqua: '#00ffff', blue: '#0000ff', navy: '#000080',
  purple: '#800080', magenta: '#ff00ff', fuchsia: '#ff00ff', pink: '#ffc0cb', brown: '#a52a2a', crimson: '#dc143c',
  coral: '#ff7f50', salmon: '#fa8072', tomato: '#ff6347', indigo: '#4b0082', violet: '#ee82ee', turquoise: '#40e0d0',
  skyblue: '#87ceeb', steelblue: '#4682b4', slategray: '#708090', darkgreen: '#006400', darkred: '#8b0000',
  darkblue: '#00008b', darkorange: '#ff8c00', lightgray: '#d3d3d3', lightgrey: '#d3d3d3', darkgray: '#a9a9a9', darkgrey: '#a9a9a9'
}

/**
 * A colour as `#rrggbb`, or null when it is not one. Everything drawn goes
 * through here, which is also what keeps a value like `red" onload="…` out of
 * the SVG's attributes.
 */
export function normColor(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  if (NAMED[s]) return NAMED[s]
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s)
  if (!m) return null
  const h = m[1]
  return h.length === 3 ? '#' + [...h].map((c) => c + c).join('') : '#' + h
}

function paletteColors(p: ChartSpec['palette']): string[] {
  if (Array.isArray(p)) {
    const list = p.map(normColor).filter((c): c is string => !!c)
    if (list.length) return list
  } else if (PALETTES[p]) return PALETTES[p]
  return PALETTES.default
}

/** Colour of point `i` of a one-series chart (pie slices, single-series bars). */
export function pointColor(spec: ChartSpec, i: number): string {
  const own = spec.pointColors[i]
  if (own) return own
  if (spec.palette === 'severity') {
    const sev = SEVERITY[(spec.categories[i] ?? '').trim().toLowerCase()]
    if (sev) return sev
  }
  const list = paletteColors(spec.palette)
  return list[i % list.length]
}

/** Colour of series `i` in a multi-series bar chart. */
export function seriesColor(spec: ChartSpec, i: number): string {
  const own = spec.series[i]?.color
  if (own) return own
  if (spec.palette === 'severity') {
    const sev = SEVERITY[(spec.series[i]?.name ?? '').trim().toLowerCase()]
    if (sev) return sev
  }
  const list = paletteColors(spec.palette)
  return list[i % list.length]
}

// ---- Defaults ---------------------------------------------------------------------

export const DEFAULT_OPTIONS: ChartOptions = {
  width: 640,
  height: 380,
  background: 'none',
  font: '',
  fontSize: 13,
  textColor: 'auto',
  titleColor: 'auto',
  align: 'center',
  legend: 'auto',
  labels: 'auto',
  decimals: -1,
  prefix: '',
  suffix: '',
  depth: 22,
  gradient: true,
  edges: true,
  shadow: true,
  varyColors: false,
  tilt: 55,
  rotation: 0,
  explode: [],
  explodeDistance: 14,
  donut: 0,
  angle: 40,
  gap: 0.3,
  stacked: false,
  horizontal: false,
  grid: true,
  gridColor: 'auto',
  min: null,
  max: null,
  step: null,
  valueTitle: '',
  categoryTitle: ''
}

/** Numbers: [min, max]; anything outside is clamped, anything unreadable falls back to the default. */
const RANGES: Partial<Record<keyof ChartOptions, [number, number]>> = {
  width: [200, 1600],
  height: [160, 1200],
  fontSize: [8, 32],
  decimals: [-1, 4],
  depth: [0, 80],
  tilt: [15, 90],
  rotation: [-360, 360],
  explodeDistance: [0, 60],
  donut: [0, 0.8],
  angle: [10, 80],
  gap: [0, 0.9]
}
/** A number option brought into its allowed range. */
export function clampOption(key: keyof ChartOptions, n: number): number {
  const r = RANGES[key]
  return r ? clamp(n, r) : n
}

const ENUMS: Partial<Record<keyof ChartOptions, readonly string[]>> = {
  align: ['left', 'center', 'right'],
  legend: ['auto', 'right', 'bottom', 'top', 'none'],
  labels: ['auto', 'value', 'percent', 'label', 'none']
}
const COLORS: (keyof ChartOptions)[] = ['textColor', 'titleColor', 'gridColor']
const TEXTS: (keyof ChartOptions)[] = ['prefix', 'suffix', 'valueTitle', 'categoryTitle']
const BOOLS: (keyof ChartOptions)[] = ['gradient', 'edges', 'shadow', 'varyColors', 'stacked', 'horizontal', 'grid']

export const TYPES: ChartType[] = ['bar3d', 'pie3d']
/** Accepted spellings of the two types. */
const TYPE_ALIASES: Record<string, ChartType> = { bar3d: 'bar3d', bar: 'bar3d', '3d-bar': 'bar3d', column: 'bar3d', pie3d: 'pie3d', pie: 'pie3d', '3d-pie': 'pie3d', donut: 'pie3d' }

// ---- Parsing ----------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string => (v == null ? '' : typeof v === 'object' ? '' : String(v))
function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/,/g, '')) : NaN
  return Number.isFinite(n) ? n : null
}
const clamp = (n: number, [lo, hi]: [number, number]): number => Math.min(hi, Math.max(lo, n))
/** A font family list; quotes and anything that could end the attribute are dropped. */
const safeFont = (v: unknown): string => str(v).replace(/[^\w\s,.-]/g, '').trim().slice(0, 120)

function parseOptions(raw: Record<string, unknown>): ChartOptions {
  const o: ChartOptions = { ...DEFAULT_OPTIONS, explode: [] }
  const set = o as unknown as Record<string, unknown>
  for (const [k, range] of Object.entries(RANGES) as [keyof ChartOptions, [number, number]][]) {
    const n = num(raw[k])
    if (n != null) set[k] = k === 'decimals' ? Math.round(clamp(n, range)) : clamp(n, range)
  }
  for (const [k, allowed] of Object.entries(ENUMS) as [keyof ChartOptions, readonly string[]][]) {
    const v = str(raw[k]).toLowerCase()
    if (allowed.includes(v)) set[k] = v
  }
  for (const k of COLORS) {
    const c = str(raw[k]).trim().toLowerCase() === 'auto' ? 'auto' : normColor(raw[k])
    if (c) set[k] = c
  }
  for (const k of TEXTS) if (raw[k] != null) set[k] = str(raw[k]).slice(0, 200)
  for (const k of BOOLS) if (typeof raw[k] === 'boolean') set[k] = raw[k]
  const bg = str(raw['background']).trim().toLowerCase()
  if (bg === 'none' || bg === 'transparent') o.background = 'none'
  else if (normColor(bg)) o.background = normColor(bg)!
  if (raw['font'] != null) o.font = safeFont(raw['font'])
  for (const k of ['min', 'max', 'step'] as const) {
    const n = num(raw[k])
    o[k] = n == null ? null : n
  }
  if (o.step != null && o.step <= 0) o.step = null
  if (o.min != null && o.max != null && o.min >= o.max) o.max = null
  const ex = raw['explode']
  if (ex === true) o.explode = ['*']
  else if (Array.isArray(ex)) o.explode = ex.map(str).filter(Boolean)
  else if (typeof ex === 'string' && ex) o.explode = [ex]
  return o
}

/** Parse the YAML inside a ```chart fence. */
export function parseChart(yaml: string): ParseResult {
  let raw: unknown
  try {
    raw = load(yaml, { schema: CORE_SCHEMA })
  } catch (err) {
    return { error: `Invalid YAML: ${(err as Error).message.split('\n')[0]}` }
  }
  if (!isObj(raw)) return { error: 'A chart needs `type` and `data` (see the Chart dialog, Ctrl+Alt+G).' }
  const type = TYPE_ALIASES[str(raw['type']).trim().toLowerCase()]
  if (!type) return { error: `Unknown chart type “${str(raw['type'])}”; use bar3d or pie3d.` }

  // Options may sit under `options:` or at the top level; `options:` wins.
  const options = parseOptions({ ...raw, ...(isObj(raw['options']) ? raw['options'] : {}) })

  let categories: string[] = []
  let series: Series[] = []
  let pointColors: (string | null)[] = []
  if (Array.isArray(raw['data'])) {
    // One series: [{ label, value, color }] or [[label, value]].
    const values: number[] = []
    for (const d of raw['data']) {
      const [label, value, color] = Array.isArray(d) ? [d[0], d[1], d[2]] : isObj(d) ? [d['label'] ?? d['name'], d['value'], d['color']] : [undefined, undefined, undefined]
      const n = num(value)
      if (n == null) continue
      categories.push(str(label))
      values.push(n)
      pointColors.push(normColor(color))
    }
    series = [{ name: str(raw['name']), values }]
  } else if (Array.isArray(raw['series'])) {
    categories = Array.isArray(raw['categories']) ? raw['categories'].map(str) : []
    for (const s of raw['series']) {
      if (!isObj(s)) continue
      const values = Array.isArray(s['values']) ? s['values'].map((v) => num(v) ?? 0) : []
      series.push({ name: str(s['name']), values, color: normColor(s['color']) ?? undefined })
    }
    const n = Math.max(categories.length, ...series.map((s) => s.values.length))
    while (categories.length < n) categories.push('')
    for (const s of series) while (s.values.length < n) s.values.push(0)
    pointColors = categories.map(() => null)
  }
  if (series.length === 0 || categories.length === 0) return { error: 'The chart has no data: add a `data:` list (label and value per row).' }

  const pal = raw['palette']
  const palette: ChartSpec['palette'] = Array.isArray(pal) ? pal.map(str) : typeof pal === 'string' && PALETTES[pal.trim().toLowerCase()] ? pal.trim().toLowerCase() : 'default'
  return { spec: { type, title: str(raw['title']), caption: str(raw['caption']), palette, categories, series, pointColors, options } }
}

// ---- Writing ----------------------------------------------------------------------

/** The spec as compact YAML (defaults left out), for the fence body. */
export function serializeChart(spec: ChartSpec): string {
  const opt = { schema: CORE_SCHEMA, lineWidth: 120, noRefs: true, quotingType: '"' } as const
  /** One value on a single line, `{ a: 1 }` / `[1, 2]` style. */
  const flow = (v: unknown): string => dump(v, { ...opt, flowLevel: 0 }).trim().replace(/^\{(.*)\}$/, '{ $1 }')

  const head: Record<string, unknown> = { type: spec.type }
  if (spec.title) head['title'] = spec.title
  if (spec.caption) head['caption'] = spec.caption
  const lines = [dump(head, opt).trimEnd()]
  if (Array.isArray(spec.palette)) lines.push(`palette: ${flow(spec.palette)}`)
  else if (spec.palette !== 'default') lines.push(`palette: ${spec.palette}`)

  const single = spec.series.length === 1 && (spec.type === 'pie3d' || !spec.series[0].name)
  if (single) {
    lines.push('data:')
    spec.categories.forEach((label, i) => {
      const d: Record<string, unknown> = { label, value: spec.series[0].values[i] ?? 0 }
      if (spec.pointColors[i]) d['color'] = spec.pointColors[i]
      lines.push(`  - ${flow(d)}`)
    })
  } else {
    lines.push(`categories: ${flow(spec.categories)}`, 'series:')
    for (const s of spec.series) {
      const d: Record<string, unknown> = { name: s.name, values: s.values }
      if (s.color) d['color'] = s.color
      lines.push(`  - ${flow(d)}`)
    }
  }

  const opts: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(spec.options) as [keyof ChartOptions, unknown][]) {
    const def = DEFAULT_OPTIONS[k]
    if (Array.isArray(v) ? v.length === 0 : v === def) continue
    // Options that only mean something for the other chart type are left out.
    if (spec.type === 'pie3d' && BAR_ONLY.has(k)) continue
    if (spec.type === 'bar3d' && PIE_ONLY.has(k)) continue
    opts[k] = v
  }
  if (Object.keys(opts).length) lines.push(dump({ options: opts }, { ...opt, flowLevel: 2 }).trimEnd())
  return lines.join('\n') + '\n'
}

export const PIE_ONLY = new Set<keyof ChartOptions>(['tilt', 'rotation', 'explode', 'explodeDistance', 'donut'])
export const BAR_ONLY = new Set<keyof ChartOptions>(['varyColors', 'angle', 'gap', 'stacked', 'horizontal', 'grid', 'gridColor', 'min', 'max', 'step', 'valueTitle', 'categoryTitle'])

/** A starting chart for the dialog. */
export function sampleChart(type: ChartType): ChartSpec {
  const spec = (parseChart(type === 'pie3d' ? SAMPLE_PIE : SAMPLE_BAR) as { spec: ChartSpec }).spec
  return spec
}

const SAMPLE_PIE = `type: pie3d
title: Findings by severity
palette: severity
data:
  - { label: Critical, value: 2 }
  - { label: High, value: 5 }
  - { label: Medium, value: 9 }
  - { label: Low, value: 6 }
  - { label: Info, value: 3 }
`

const SAMPLE_BAR = `type: bar3d
title: Findings by category
data:
  - { label: Authentication, value: 4 }
  - { label: Configuration, value: 7 }
  - { label: Injection, value: 3 }
  - { label: Cryptography, value: 2 }
  - { label: Exposure, value: 5 }
`

/** Format a value the way the chart shows it. */
export function formatValue(v: number, o: Pick<ChartOptions, 'decimals' | 'prefix' | 'suffix'>): string {
  const a = Math.abs(v)
  const n = o.decimals >= 0 ? a.toFixed(o.decimals) : String(Math.round(a * 100) / 100)
  // The sign goes in front of a currency prefix: -$4, not $-4.
  return `${v < 0 && Number(n) !== 0 ? '-' : ''}${o.prefix}${n}${o.suffix}`
}
