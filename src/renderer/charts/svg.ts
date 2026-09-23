import { escapeHtml } from '../escape'
import { formatValue, pointColor, seriesColor, type ChartOptions, type ChartSpec } from './model'
import { darken, lighten, onColor } from './shade'

/**
 * Charts drawn as static SVG. No script and no WebGL: the same markup serves
 * the preview, the self-contained HTML export (whose CSP runs nothing), the
 * PDF (vector, so it prints sharp) and the optional .svg file in assets/.
 *
 * "3D" is an oblique projection. A bar is an extruded box — front, lighter
 * top, darker side — in front of a back wall and floor; a pie is a tilted
 * disc whose slices have side walls, painted back to front.
 *
 * Every piece of text is escaped and every colour has been normalised to
 * #rrggbb (model.ts), so nothing from the YAML reaches the markup unchecked.
 */

export interface RenderOptions {
  /** A file of its own (assets/*.svg): xmlns, explicit font and colours, opaque background. */
  standalone?: boolean
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

interface LegendItem {
  label: string
  color: string
}

const STANDALONE_FONT = '-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif'
const STANDALONE_TEXT = '#24292f'

/** Two decimals are plenty for coordinates and keep the markup short. */
const f = (n: number): string => String(Math.round(n * 100) / 100)
const esc = (s: string): string => escapeHtml(s)
/** Rough text width; the charts only need it for layout, not for exact fitting. */
const textW = (s: string, size: number): number => s.length * size * 0.6

/** A short, stable id prefix so two charts in one document never share gradient ids. */
function uid(spec: ChartSpec): string {
  const s = JSON.stringify(spec)
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return 'tc' + (h >>> 0).toString(36)
}

/** 'auto' follows the surrounding text colour; faint strokes are that colour at low opacity. */
const ink = (c: string): string => (c === 'auto' ? 'currentColor' : c)

/**
 * Translucency only ever as a group's `opacity`. Chromium's PDF output lets a
 * `stroke-opacity` / `fill-opacity` (or an rgba colour) leak into the next
 * gradient fill, which then prints see-through; a group is its own
 * transparency group and leaks nothing.
 */
const faintGroup = (opacity: number, body: string): string => (body ? `<g opacity="${opacity}">${body}</g>` : '')

class Gradients {
  private defs = new Map<string, string>()
  constructor(private id: string, private on: boolean) {}
  /** Vertical gradient from `top` to `bottom`, or a flat fill when gradients are off. */
  fill(top: string, bottom: string): string {
    if (!this.on || top === bottom) return bottom
    const key = `${top}${bottom}`
    let id = this.defs.get(key)
    if (!id) {
      id = `${this.id}-g${this.defs.size}`
      this.defs.set(key, id)
    }
    return `url(#${id})`
  }
  markup(): string {
    if (this.defs.size === 0) return ''
    const out = [...this.defs].map(
      ([key, id]) =>
        `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${key.slice(0, 7)}"/><stop offset="1" stop-color="${key.slice(7)}"/></linearGradient>`
    )
    return `<defs>${out.join('')}</defs>`
  }
}

function text(x: number, y: number, s: string, o: { size: number; fill: string; anchor?: 'start' | 'middle' | 'end'; weight?: number; rotate?: number; italic?: boolean; baseline?: 'middle' }): string {
  const attrs = [`x="${f(x)}"`, `y="${f(y)}"`, `font-size="${f(o.size)}"`, `fill="${o.fill}"`]
  if (o.anchor && o.anchor !== 'start') attrs.push(`text-anchor="${o.anchor}"`)
  if (o.weight) attrs.push(`font-weight="${o.weight}"`)
  if (o.italic) attrs.push('font-style="italic"')
  if (o.baseline) attrs.push('dominant-baseline="middle"')
  if (o.rotate) attrs.push(`transform="rotate(${f(o.rotate)} ${f(x)} ${f(y)})"`)
  return `<text ${attrs.join(' ')}>${esc(s)}</text>`
}

const poly = (pts: [number, number][], fill: string, stroke: string): string =>
  `<path d="M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}Z" fill="${fill}"${stroke}/>`

// ---- Frame: title, caption, legend -------------------------------------------------

interface Frame {
  plot: Box
  parts: string[]
}

function legendItems(spec: ChartSpec): LegendItem[] {
  if (spec.type === 'pie3d') return spec.categories.map((label, i) => ({ label, color: pointColor(spec, i) }))
  if (spec.series.length > 1) return spec.series.map((s, i) => ({ label: s.name || `Series ${i + 1}`, color: seriesColor(spec, i) }))
  if (barVaries(spec)) return spec.categories.map((label, i) => ({ label, color: pointColor(spec, i) }))
  return [{ label: spec.series[0].name || spec.title || 'Value', color: seriesColor(spec, 0) }]
}

function legendPos(spec: ChartSpec): ChartOptions['legend'] {
  const l = spec.options.legend
  if (l !== 'auto') return l
  if (spec.type === 'pie3d') return 'right'
  return spec.series.length > 1 ? 'bottom' : 'none'
}

/** Title on top, caption at the bottom, the legend on its side; what is left is the plot. */
function frame(spec: ChartSpec): Frame {
  const o = spec.options
  const fs = o.fontSize
  const pad = 12
  const parts: string[] = []
  const box: Box = { x: pad, y: pad, w: o.width - 2 * pad, h: o.height - 2 * pad }
  const tx = o.align === 'left' ? box.x : o.align === 'right' ? box.x + box.w : box.x + box.w / 2
  const anchor = o.align === 'left' ? 'start' : o.align === 'right' ? 'end' : 'middle'

  if (spec.title) {
    const ts = fs * 1.35
    parts.push(text(tx, box.y + ts * 0.85, spec.title, { size: ts, fill: ink(o.titleColor), anchor, weight: 600 }))
    box.y += ts * 1.5
    box.h -= ts * 1.5
  }
  if (spec.caption) {
    const cs = fs * 0.9
    parts.push(text(tx, box.y + box.h - cs * 0.2, spec.caption, { size: cs, fill: ink(o.textColor), anchor, italic: true }))
    box.h -= cs * 1.7
  }

  const pos = legendPos(spec)
  const items = pos === 'none' ? [] : legendItems(spec)
  if (items.length) {
    const sw = fs * 0.85
    const lineH = fs * 1.55
    const itemW = (it: LegendItem): number => sw + 6 + textW(it.label, fs) + 16
    const swatch = (x: number, y: number, it: LegendItem): string =>
      `<rect x="${f(x)}" y="${f(y - sw / 2)}" width="${f(sw)}" height="${f(sw)}" rx="2" fill="${it.color}"/>` +
      text(x + sw + 6, y, it.label, { size: fs, fill: ink(o.textColor), baseline: 'middle' })
    if (pos === 'right') {
      const w = Math.min(box.w * 0.38, Math.max(...items.map(itemW)))
      const x = box.x + box.w - w + 8
      const top = box.y + Math.max(0, (box.h - items.length * lineH) / 2) + lineH / 2
      items.forEach((it, i) => parts.push(swatch(x, top + i * lineH, it)))
      box.w -= w
    } else {
      // Rows of items, centred, wrapping as needed.
      const rows: LegendItem[][] = [[]]
      let used = 0
      for (const it of items) {
        if (used + itemW(it) > box.w && rows[rows.length - 1].length) {
          rows.push([])
          used = 0
        }
        rows[rows.length - 1].push(it)
        used += itemW(it)
      }
      const h = rows.length * lineH + 4
      const y0 = pos === 'top' ? box.y + lineH / 2 : box.y + box.h - h + lineH / 2 + 4
      rows.forEach((row, r) => {
        const rowW = row.reduce((s, it) => s + itemW(it), 0) - 16
        let x = box.x + (box.w - rowW) / 2
        for (const it of row) {
          parts.push(swatch(x, y0 + r * lineH, it))
          x += itemW(it)
        }
      })
      if (pos === 'top') box.y += h
      box.h -= h
    }
  }
  return { plot: box, parts }
}

// ---- Entry point -------------------------------------------------------------------

export function renderChartSvg(spec: ChartSpec, opts: RenderOptions = {}): string {
  const o = spec.options
  const grads = new Gradients(uid(spec), o.gradient)
  const { plot, parts } = frame(spec)
  const body = spec.type === 'pie3d' ? pie3d(spec, plot, grads) : bar3d(spec, plot, grads)
  const font = o.font || (opts.standalone ? STANDALONE_FONT : '')
  const attrs = [
    ...(opts.standalone ? ['xmlns="http://www.w3.org/2000/svg"'] : []),
    'class="chart-svg"',
    `viewBox="0 0 ${o.width} ${o.height}"`,
    `width="${o.width}"`,
    `height="${o.height}"`,
    'role="img"',
    `aria-label="${esc(spec.title || (spec.type === 'pie3d' ? '3D pie chart' : '3D bar chart'))}"`,
    ...(font ? [`font-family="${esc(font)}"`] : []),
    // In a file of its own there is no surrounding text colour to follow.
    ...(opts.standalone ? [`color="${STANDALONE_TEXT}"`] : [])
  ]
  const bg = o.background !== 'none' ? o.background : opts.standalone ? '#ffffff' : null
  const back = bg ? `<rect width="${o.width}" height="${o.height}" rx="6" fill="${bg}"/>` : ''
  return `<svg ${attrs.join(' ')}>${grads.markup()}${back}${body}${parts.join('')}</svg>`
}

// ---- Pie ----------------------------------------------------------------------------

const TAU = Math.PI * 2

/** Parts of [a, b] where sin(θ) has the given sign: the front (> 0) or back (< 0) of the disc. */
function halves(a: number, b: number, front: boolean): [number, number][] {
  const out: [number, number][] = []
  for (let k = Math.floor(a / TAU) - 1; k <= Math.ceil(b / TAU) + 1; k++) {
    const lo = k * TAU + (front ? 0 : Math.PI)
    const hi = lo + Math.PI
    const s = Math.max(a, lo)
    const e = Math.min(b, hi)
    if (e - s > 1e-6) out.push([s, e])
  }
  return out
}

function percentText(v: number, total: number, decimals: number): string {
  const p = total > 0 ? (v / total) * 100 : 0
  const d = decimals >= 0 ? decimals : p < 10 && p !== Math.round(p) ? 1 : 0
  return `${p.toFixed(d)}%`
}

function pie3d(spec: ChartSpec, plot: Box, grads: Gradients): string {
  const o = spec.options
  const fs = o.fontSize
  const values = spec.series[0].values.map((v) => Math.max(0, v))
  const total = values.reduce((s, v) => s + v, 0)
  if (total <= 0) return text(plot.x + plot.w / 2, plot.y + plot.h / 2, 'No positive values to chart', { size: fs, fill: ink(o.textColor), anchor: 'middle' })

  const tilt = (o.tilt * Math.PI) / 180
  const squash = Math.sin(tilt)
  const exploded = (label: string): boolean => o.explode.includes('*') || o.explode.includes(label)
  const anyExploded = spec.categories.some((c, i) => values[i] > 0 && exploded(c))
  const e = anyExploded ? o.explodeDistance : 0
  const mode = o.labels === 'auto' ? 'percent' : o.labels
  const labelOf = (i: number): string =>
    mode === 'percent' ? percentText(values[i], total, o.decimals) : mode === 'value' ? formatValue(values[i], o) : spec.categories[i]
  const outsideAll = mode === 'label'
  const maxLabel = mode === 'none' ? 0 : Math.max(...values.map((_, i) => textW(labelOf(i), fs)))
  const mh = mode === 'none' ? 4 : Math.min(plot.w * 0.28, maxLabel + 22)
  const mv = mode === 'none' ? 4 : fs * 1.8

  // Radius from the room left: across is 2rx, down is 2ry plus the wall.
  const dz = o.depth * Math.cos(tilt)
  const rx = Math.max(20, Math.min((plot.w - 2 * mh - 2 * e) / 2, (plot.h - 2 * mv - 2 * e * squash - dz) / (2 * squash)))
  const ry = rx * squash
  const ri = rx * o.donut
  const riy = ri * squash
  const cx = plot.x + plot.w / 2
  const cy = plot.y + (plot.h - (2 * ry + dz)) / 2 + ry

  interface Slice {
    i: number
    a: number
    b: number
    ox: number
    oy: number
    color: string
  }
  const slices: Slice[] = []
  let acc = ((o.rotation - 90) * Math.PI) / 180
  values.forEach((v, i) => {
    if (v <= 0) return
    const a = acc
    const b = acc + (v / total) * TAU
    acc = b
    const m = (a + b) / 2
    const d = exploded(spec.categories[i]) ? e : 0
    slices.push({ i, a, b, ox: d * Math.cos(m), oy: d * Math.sin(m) * squash, color: pointColor(spec, i) })
  })

  const P = (s: Slice, t: number, r: number, drop = 0): [number, number] => [cx + s.ox + r * Math.cos(t), cy + s.oy + r * squash * Math.sin(t) + drop]
  const pt = ([x, y]: [number, number]): string => `${f(x)} ${f(y)}`
  const stroke = (c: string): string => (o.edges ? ` stroke="${darken(c, 0.25)}" stroke-width="0.7" stroke-linejoin="round"` : '')
  const arc = (r: number, ryy: number, large: boolean, sweep: boolean, to: [number, number]): string =>
    `A${f(r)} ${f(ryy)} 0 ${large ? 1 : 0} ${sweep ? 1 : 0} ${pt(to)}`

  const out: string[] = []
  if (o.shadow) {
    // A ring under a donut: the floor shows through its hole.
    const sy = cy + dz + ry * 0.08
    const ring = (r: number, rr: number, sweep: 0 | 1): string =>
      `M${f(cx - r)} ${f(sy)}A${f(r)} ${f(rr)} 0 1 ${sweep} ${f(cx + r)} ${f(sy)}A${f(r)} ${f(rr)} 0 1 ${sweep} ${f(cx - r)} ${f(sy)}Z`
    const hole = ri > 0 ? ring(Math.max(1, ri - 4), Math.max(1, riy - 3), 0) : ''
    out.push(faintGroup(0.12, `<path d="${ring(rx + e + 4, ry + e * squash + 3, 1)}${hole}" fill="#000" fill-rule="evenodd"/>`))
  }

  // Side walls, sorted back to front by how near their middle is.
  const walls: { key: number; svg: string }[] = []
  for (const s of slices) {
    const wallFill = grads.fill(darken(s.color, 0.12), darken(s.color, 0.38))
    // Outer wall: only the front half of the rim is ever seen.
    for (const [a, b] of halves(s.a, s.b, true)) {
      const d = `M${pt(P(s, a, rx))}${arc(rx, ry, false, true, P(s, b, rx))}L${pt(P(s, b, rx, dz))}${arc(rx, ry, false, false, P(s, a, rx, dz))}Z`
      walls.push({ key: Math.sin((a + b) / 2) * rx + s.oy, svg: `<path d="${d}" fill="${wallFill}"${stroke(s.color)}/>` })
    }
    // Inner wall of a donut: only its back half shows through the hole.
    if (ri > 0) {
      for (const [a, b] of halves(s.a, s.b, false)) {
        const d = `M${pt(P(s, a, ri))}${arc(ri, riy, false, true, P(s, b, ri))}L${pt(P(s, b, ri, dz))}${arc(ri, riy, false, false, P(s, a, ri, dz))}Z`
        walls.push({ key: Math.sin((a + b) / 2) * ri + s.oy - rx, svg: `<path d="${d}" fill="${darken(s.color, 0.45)}"${stroke(s.color)}/>` })
      }
    }
    // Cut faces at the slice's two edges, where they face the viewer.
    if (slices.length > 1) {
      for (const [t, visible] of [[s.a, Math.cos(s.a) < 0], [s.b, Math.cos(s.b) > 0]] as [number, boolean][]) {
        if (!visible) continue
        const pts: [number, number][] = [P(s, t, ri), P(s, t, rx), P(s, t, rx, dz), P(s, t, ri, dz)]
        walls.push({ key: Math.sin(t) * (rx + ri) * 0.5 + s.oy, svg: poly(pts, darken(s.color, 0.3), stroke(s.color)) })
      }
    }
  }
  walls.sort((p, q) => p.key - q.key)
  out.push(...walls.map((w) => w.svg))

  // Tops last: nothing below the disc can hide them.
  for (const s of slices) {
    const span = s.b - s.a
    const fill = grads.fill(lighten(s.color, 0.22), s.color)
    let d: string
    if (span >= TAU - 1e-6) {
      const m = s.a + Math.PI
      d = `M${pt(P(s, s.a, rx))}${arc(rx, ry, false, true, P(s, m, rx))}${arc(rx, ry, false, true, P(s, s.a, rx))}Z`
      if (ri > 0) d += `M${pt(P(s, s.a, ri))}${arc(ri, riy, false, false, P(s, m, ri))}${arc(ri, riy, false, false, P(s, s.a, ri))}Z`
    } else {
      const large = span > Math.PI
      d = ri > 0
        ? `M${pt(P(s, s.a, ri))}L${pt(P(s, s.a, rx))}${arc(rx, ry, large, true, P(s, s.b, rx))}L${pt(P(s, s.b, ri))}${arc(ri, riy, large, false, P(s, s.a, ri))}Z`
        : `M${pt(P(s, s.a, 0))}L${pt(P(s, s.a, rx))}${arc(rx, ry, large, true, P(s, s.b, rx))}Z`
    }
    out.push(`<path d="${d}" fill="${fill}" fill-rule="evenodd"${stroke(s.color)}/>`)
  }

  if (mode !== 'none') out.push(...pieLabels(spec, slices, { cx, cy, rx, ry, ri, dz, squash, e }, labelOf, outsideAll))
  return out.join('')
}

function pieLabels(
  spec: ChartSpec,
  slices: { i: number; a: number; b: number; ox: number; oy: number; color: string }[],
  g: { cx: number; cy: number; rx: number; ry: number; ri: number; dz: number; squash: number; e: number },
  labelOf: (i: number) => string,
  outsideAll: boolean
): string[] {
  const o = spec.options
  const fs = o.fontSize
  const out: string[] = []
  const outside: { side: 1 | -1; x0: number; y0: number; y: number; label: string }[] = []
  for (const s of slices) {
    const m = (s.a + s.b) / 2
    const label = labelOf(s.i)
    const inR = g.ri > 0 ? (g.ri + g.rx) / 2 : g.rx * 0.62
    const fitsInside = !outsideAll && s.b - s.a > 0.38 && textW(label, fs) < (s.b - s.a) * inR * 0.9 + fs
    if (fitsInside) {
      const x = g.cx + s.ox + inR * Math.cos(m)
      const y = g.cy + s.oy + inR * g.squash * Math.sin(m)
      out.push(text(x, y, label, { size: fs, fill: onColor(s.color), anchor: 'middle', baseline: 'middle', weight: 600 }))
      continue
    }
    const side: 1 | -1 = Math.cos(m) >= 0 ? 1 : -1
    const x0 = g.cx + s.ox + g.rx * Math.cos(m)
    const y0 = g.cy + s.oy + g.ry * Math.sin(m) + (Math.sin(m) > 0 ? g.dz * 0.5 : 0)
    outside.push({ side, x0, y0, y: g.cy + s.oy + (g.ry + fs * 0.8) * Math.sin(m) + (Math.sin(m) > 0 ? g.dz : 0), label })
  }
  // Keep outside labels on each side from overlapping: walk down, pushing apart.
  for (const side of [1, -1] as const) {
    const list = outside.filter((l) => l.side === side).sort((p, q) => p.y - q.y)
    for (let k = 1; k < list.length; k++) list[k].y = Math.max(list[k].y, list[k - 1].y + fs * 1.2)
    for (const l of list) {
      const xl = g.cx + side * (g.rx + g.e + fs * 0.9)
      const line = `<path d="M${f(l.x0)} ${f(l.y0)}L${f(xl)} ${f(l.y)}L${f(xl + side * 6)} ${f(l.y)}" fill="none" stroke="${ink(o.textColor)}" stroke-width="0.8"/>`
      out.push(faintGroup(0.5, line), text(xl + side * 9, l.y, l.label, { size: fs, fill: ink(o.textColor), anchor: side > 0 ? 'start' : 'end', baseline: 'middle' }))
    }
  }
  return out
}

// ---- Bar ----------------------------------------------------------------------------

/** One-series bars in a colour each: asked for, given per point, or implied by the severity palette. */
function barVaries(spec: ChartSpec): boolean {
  if (spec.series.length !== 1) return false
  return spec.options.varyColors || spec.pointColors.some(Boolean) || spec.palette === 'severity'
}

/** A "nice" tick step (1, 2, 2.5 or 5 × 10^n) for about `count` intervals. */
export function niceStep(range: number, count = 5): number {
  if (!(range > 0)) return 1
  const raw = range / count
  const pow = 10 ** Math.floor(Math.log10(raw))
  const n = raw / pow
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow
}

export interface Scale {
  lo: number
  hi: number
  step: number
  ticks: number[]
}

/** Axis range over the data (stacked: the stacks' extents), honouring min/max/step when given. */
export function barScale(spec: ChartSpec): Scale {
  const o = spec.options
  let dmin = 0
  let dmax = 0
  const n = spec.categories.length
  for (let c = 0; c < n; c++) {
    if (o.stacked) {
      let pos = 0
      let neg = 0
      for (const s of spec.series) {
        const v = s.values[c] ?? 0
        if (v >= 0) pos += v
        else neg += v
      }
      dmax = Math.max(dmax, pos)
      dmin = Math.min(dmin, neg)
    } else {
      for (const s of spec.series) {
        dmax = Math.max(dmax, s.values[c] ?? 0)
        dmin = Math.min(dmin, s.values[c] ?? 0)
      }
    }
  }
  const lo0 = o.min ?? dmin
  let hi0 = o.max ?? dmax
  if (hi0 <= lo0) hi0 = lo0 + 1
  let step = o.step ?? niceStep(hi0 - lo0)
  // Counts (findings, items) read oddly on a 2.5 grid: whole data, whole ticks.
  const whole = spec.series.every((s) => s.values.every(Number.isInteger))
  if (o.step == null && whole && !Number.isInteger(step)) step = Math.max(1, Math.floor(step))
  const lo = o.min ?? Math.floor(lo0 / step + 1e-9) * step
  const hi = o.max ?? Math.ceil(hi0 / step - 1e-9) * step
  const ticks: number[] = []
  for (let t = Math.ceil(lo / step - 1e-9) * step, k = 0; t <= hi + step * 1e-6 && k < 60; t += step, k++) ticks.push(Math.round(t * 1e9) / 1e9 || 0)
  return { lo, hi: hi > lo ? hi : lo + step, step, ticks }
}

/** Decimals the tick step itself needs (2.5 → 1, 0.25 → 2). */
function tickDecimals(step: number): number {
  return Math.min(4, (String(Math.round(step * 1e6) / 1e6).split('.')[1] ?? '').length)
}

function bar3d(spec: ChartSpec, plot: Box, grads: Gradients): string {
  const o = spec.options
  const fs = o.fontSize
  const hz = o.horizontal
  const n = spec.categories.length
  const m = spec.series.length
  const sc = barScale(spec)
  const td = o.decimals >= 0 ? o.decimals : tickDecimals(sc.step)
  const tickText = (v: number): string => formatValue(v, { decimals: td, prefix: o.prefix, suffix: o.suffix })
  const grid = ink(o.gridColor)
  const txt = ink(o.textColor)

  // Depth vector: up and to the right.
  const ang = (o.angle * Math.PI) / 180
  const D = o.depth
  const dx = D * Math.cos(ang)
  const dy = -D * Math.sin(ang)

  const tickW = Math.max(...sc.ticks.map((t) => textW(tickText(t), fs)))
  const catW = Math.max(...spec.categories.map((c) => textW(c, fs)))
  const vTitle = o.valueTitle ? fs * 1.6 : 0
  const cTitle = o.categoryTitle ? fs * 1.6 : 0

  // Front plane of the plot area: [x0, x1] × [y0, y1].
  let x0: number, x1: number, y0: number, y1: number
  let rotateCats = false
  if (!hz) {
    x0 = plot.x + vTitle + tickW + 8
    x1 = plot.x + plot.w - dx - 6
    const slot = (x1 - x0) / n
    rotateCats = catW > slot * 0.95
    const catH = rotateCats ? Math.min(plot.h * 0.32, catW * 0.6 + fs) : fs * 1.6
    y0 = plot.y - dy + fs * 0.9
    y1 = plot.y + plot.h - catH - cTitle
  } else {
    x0 = plot.x + cTitle + Math.min(catW, plot.w * 0.3) + 10
    x1 = plot.x + plot.w - dx - tickW / 2 - 6
    y0 = plot.y - dy + 4
    y1 = plot.y + plot.h - fs * 1.6 - vTitle
  }
  if (x1 - x0 < 40 || y1 - y0 < 40) return text(plot.x + plot.w / 2, plot.y + plot.h / 2, 'Chart too small for its labels', { size: fs, fill: txt, anchor: 'middle' })

  // Value → coordinate along the value axis.
  const span = sc.hi - sc.lo
  const vy = (v: number): number => y1 - ((Math.min(Math.max(v, sc.lo), sc.hi) - sc.lo) / span) * (y1 - y0)
  const vx = (v: number): number => x0 + ((Math.min(Math.max(v, sc.lo), sc.hi) - sc.lo) / span) * (x1 - x0)
  const base = Math.min(Math.max(0, sc.lo), sc.hi)

  const out: string[] = []
  const face = (d: string): string => `<path d="${d}" fill="${grid}"/>`

  // Walls and floor, then the grid on them.
  if (o.grid) {
    const floorY = hz ? y1 : vy(base)
    out.push(faintGroup(0.06, face(`M${f(x0 + dx)} ${f(y0 + dy)}L${f(x1 + dx)} ${f(y0 + dy)}L${f(x1 + dx)} ${f(y1 + dy)}L${f(x0 + dx)} ${f(y1 + dy)}Z`)))
    out.push(faintGroup(0.1, face(`M${f(x0)} ${f(y0)}L${f(x0 + dx)} ${f(y0 + dy)}L${f(x0 + dx)} ${f(y1 + dy)}L${f(x0)} ${f(y1)}Z`)))
    out.push(faintGroup(0.14, face(`M${f(x0)} ${f(floorY)}L${f(x1)} ${f(floorY)}L${f(x1 + dx)} ${f(floorY + dy)}L${f(x0 + dx)} ${f(floorY + dy)}Z`)))
    const line = (ax: number, ay: number, bx: number, by: number): string => `M${f(ax)} ${f(ay)}L${f(bx)} ${f(by)}`
    const lines: string[] = []
    for (const t of sc.ticks) {
      if (!hz) {
        const y = vy(t)
        lines.push(line(x0, y, x0 + dx, y + dy), line(x0 + dx, y + dy, x1 + dx, y + dy))
      } else {
        const x = vx(t)
        lines.push(line(x, y1, x + dx, y1 + dy), line(x + dx, y1 + dy, x + dx, y0 + dy))
      }
    }
    out.push(faintGroup(0.45, `<path d="${lines.join('')}" stroke="${grid}" stroke-width="0.8" fill="none"/>`))
  }
  // Tick labels.
  for (const t of sc.ticks) {
    if (!hz) out.push(text(x0 - 6, vy(t), tickText(t), { size: fs * 0.92, fill: txt, anchor: 'end', baseline: 'middle' }))
    else out.push(text(vx(t), y1 + fs * 1.2, tickText(t), { size: fs * 0.92, fill: txt, anchor: 'middle' }))
  }
  // Category labels.
  const slot = ((hz ? y1 - y0 : x1 - x0) / n)
  spec.categories.forEach((c, i) => {
    if (!hz) {
      const x = x0 + slot * (i + 0.5)
      if (rotateCats) out.push(text(x, y1 + fs * 1.1, c, { size: fs, fill: txt, anchor: 'end', rotate: -35 }))
      else out.push(text(x, y1 + fs * 1.25, c, { size: fs, fill: txt, anchor: 'middle' }))
    } else {
      out.push(text(x0 - 8, y0 + slot * (i + 0.5), c, { size: fs, fill: txt, anchor: 'end', baseline: 'middle' }))
    }
  })
  // Axis titles.
  if (o.valueTitle) {
    if (!hz) out.push(text(plot.x + fs * 0.9, (y0 + y1) / 2, o.valueTitle, { size: fs, fill: txt, anchor: 'middle', rotate: -90, weight: 600 }))
    else out.push(text((x0 + x1) / 2, plot.y + plot.h - fs * 0.3, o.valueTitle, { size: fs, fill: txt, anchor: 'middle', weight: 600 }))
  }
  if (o.categoryTitle) {
    if (!hz) out.push(text((x0 + x1) / 2, plot.y + plot.h - fs * 0.3, o.categoryTitle, { size: fs, fill: txt, anchor: 'middle', weight: 600 }))
    else out.push(text(plot.x + fs * 0.9, (y0 + y1) / 2, o.categoryTitle, { size: fs, fill: txt, anchor: 'middle', rotate: -90, weight: 600 }))
  }

  // Bars: each a box from value `from` to `to`, `ddx/ddy` deep, inset into the frame.
  const k = 0.78
  const bdx = dx * k
  const bdy = dy * k
  const ix = dx * (1 - k) * 0.5
  const iy = dy * (1 - k) * 0.5
  const stroke = (c: string): string => (o.edges ? ` stroke="${darken(c, 0.3)}" stroke-width="0.6" stroke-linejoin="round"` : '')
  const mode = o.labels === 'auto' ? 'value' : o.labels
  const varies = barVaries(spec)

  interface Seg {
    // Rectangle of the front face.
    ax: number
    ay: number
    bx: number
    by: number
    color: string
    label: string
    /** Where the label goes: past the end of the bar, or inside it (stacked). */
    inside: boolean
    negative: boolean
    order: number
  }
  const segs: Seg[] = []
  const groupW = slot * (1 - o.gap)
  for (let c = 0; c < n; c++) {
    let pos = 0
    let neg = 0
    const catTotal = spec.series.reduce((s, se) => s + Math.abs(se.values[c] ?? 0), 0)
    for (let si = 0; si < m; si++) {
      const v = spec.series[si].values[c] ?? 0
      const seriesTotal = spec.series[si].values.reduce((s, x) => s + Math.abs(x), 0)
      let from: number, to: number
      if (o.stacked) {
        from = v >= 0 ? pos : neg
        to = from + v
        if (v >= 0) pos = to
        else neg = to
      } else {
        from = base
        to = v
      }
      const w = o.stacked ? groupW : groupW / m
      const off = (hz ? y0 : x0) + slot * c + (slot - groupW) / 2 + (o.stacked ? 0 : w * si)
      const color = varies ? pointColor(spec, c) : seriesColor(spec, si)
      const pct = o.stacked ? (catTotal ? (Math.abs(v) / catTotal) * 100 : 0) : seriesTotal ? (Math.abs(v) / seriesTotal) * 100 : 0
      const label =
        mode === 'value' ? formatValue(v, o) : mode === 'percent' ? `${pct.toFixed(o.decimals >= 0 ? o.decimals : 0)}%` : mode === 'label' ? (m > 1 ? spec.series[si].name : spec.categories[c]) : ''
      const seg: Seg = hz
        ? { ax: Math.min(vx(from), vx(to)), bx: Math.max(vx(from), vx(to)), ay: off, by: off + w, color, label, inside: o.stacked && m > 1, negative: v < 0, order: 0 }
        : { ax: off, bx: off + w, ay: Math.min(vy(from), vy(to)), by: Math.max(vy(from), vy(to)), color, label, inside: o.stacked && m > 1, negative: v < 0, order: 0 }
      // Paint order (see the module comment): vertical bars left to right and
      // bottom up; horizontal ones bottom up and left to right.
      seg.order = hz ? -seg.by * 1e4 + seg.ax : seg.ax * 1e4 - seg.by
      if (v !== 0 || !o.stacked) segs.push(seg)
    }
  }
  segs.sort((p, q) => p.order - q.order)
  const labels: string[] = []
  for (const s of segs) {
    const ax = s.ax + ix
    const bx = s.bx + ix
    const ay = s.ay + iy
    const by = s.by + iy
    const front = grads.fill(lighten(s.color, 0.12), darken(s.color, 0.08))
    out.push(`<path d="M${f(ax)} ${f(ay)}L${f(bx)} ${f(ay)}L${f(bx)} ${f(by)}L${f(ax)} ${f(by)}Z" fill="${front}"${stroke(s.color)}/>`)
    out.push(poly([[ax, ay], [ax + bdx, ay + bdy], [bx + bdx, ay + bdy], [bx, ay]], lighten(s.color, 0.28), stroke(s.color)))
    out.push(poly([[bx, ay], [bx + bdx, ay + bdy], [bx + bdx, by + bdy], [bx, by]], darken(s.color, 0.28), stroke(s.color)))
    if (!s.label) continue
    if (s.inside) {
      const big = hz ? bx - ax > textW(s.label, fs * 0.9) + 4 : by - ay > fs
      if (big) labels.push(text((ax + bx) / 2, (ay + by) / 2, s.label, { size: fs * 0.9, fill: onColor(s.color), anchor: 'middle', baseline: 'middle', weight: 600 }))
    } else if (!hz) {
      const y = s.negative ? by + fs * 1.1 : ay + bdy - 4
      labels.push(text((ax + bx) / 2 + bdx / 2, y, s.label, { size: fs * 0.9, fill: txt, anchor: 'middle', weight: 600 }))
    } else {
      const x = s.negative ? ax - 4 : bx + bdx + 4
      labels.push(text(x, (ay + by) / 2 + bdy / 2, s.label, { size: fs * 0.9, fill: txt, anchor: s.negative ? 'end' : 'start', baseline: 'middle', weight: 600 }))
    }
  }
  out.push(...labels)
  // Zero line when the axis crosses it.
  if (sc.lo < 0 && sc.hi > 0) {
    out.push(!hz
      ? faintGroup(0.6, `<path d="M${f(x0)} ${f(vy(0))}L${f(x1)} ${f(vy(0))}" stroke="${txt}" stroke-width="1"/>`)
      : faintGroup(0.6, `<path d="M${f(vx(0))} ${f(y0)}L${f(vx(0))} ${f(y1)}" stroke="${txt}" stroke-width="1"/>`))
  }
  return out.join('')
}
