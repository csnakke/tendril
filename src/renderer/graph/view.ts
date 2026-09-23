import ForceGraph3D, { type ConfigOptions, type ForceGraph3DInstance } from '3d-force-graph'
import { CanvasTexture, NormalBlending, SRGBColorSpace, Sprite, SpriteMaterial } from 'three'
import type { GraphData, GraphNode } from '../../preload/index'
import { escapeHtml } from '../escape'

/**
 * One 3D tag graph on a WebGL canvas. The sidebar pane uses it as a small,
 * self-revolving picture (no pointer input); the zoomed overlay uses it with
 * mouse orbit/zoom and click-to-highlight.
 *
 * Nodes are glowing orbs (camera-facing sprites): notes are filled orbs, tags
 * are bright rings. Each cluster (top-level tag) takes one of the theme's
 * graph colours (`--graph-c0…`), so the graph reads as coloured groups. All
 * colours come from the theme (themes/apply.ts) and are re-read on `theme-applied`.
 */

export interface VNode extends GraphNode {
  degree: number
  /** Index into the cluster colours. */
  group: number
  x?: number
  y?: number
  z?: number
}
export interface VLink {
  source: string | VNode
  target: string | VNode
}

type Mode = 'pane' | 'overlay'

// The typings declare the constructor with default node/link types only.
const Graph3D = ForceGraph3D as unknown as new (el: HTMLElement, config?: ConfigOptions) => ForceGraph3DInstance<VNode, VLink>
type Point = { x: number; y: number; z: number }

export interface GraphViewHandlers {
  onNodeClick?: (node: VNode) => void
  onLinkClick?: (link: VLink) => void
  onBackgroundClick?: () => void
}

interface Colors {
  series: string[]
  link: string
  highlight: string
  bg: string
  dimLink: string
  /** Dark background: white-hot cores and a wider glow. */
  dark: boolean
}

// ---- Colours --------------------------------------------------------------------
// three.js takes #rrggbb; theme values may be rgb(), rgba() or 8-digit hex, so
// they are normalised through a canvas, with any alpha flattened onto the background.

const ctx = document.createElement('canvas').getContext('2d')!

function rgbOf(c: string): [number, number, number, number] | null {
  ctx.fillStyle = '#000000'
  ctx.fillStyle = c
  const v = ctx.fillStyle
  if (v.startsWith('#')) return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16), 1]
  const m = v.match(/rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/)
  return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null
}

const hex = (r: number, g: number, b: number): string => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

/** t=1 → a, t=0 → b; a's own alpha scales t. */
function mixHex(a: string, b: string, t: number): string {
  const pa = rgbOf(a), pb = rgbOf(b)
  if (!pa || !pb) return a
  const k = t * pa[3]
  return hex(pb[0] + (pa[0] - pb[0]) * k, pb[1] + (pa[1] - pb[1]) * k, pb[2] + (pa[2] - pb[2]) * k)
}

function readColors(): Colors {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback
  const bgRaw = rgbOf(v('--graph-bg', v('--bg', '#ffffff')))
  const bg = bgRaw ? hex(bgRaw[0], bgRaw[1], bgRaw[2]) : '#ffffff'
  const solid = (name: string, fallback: string): string => mixHex(v(name, fallback), bg, 1)
  const series: string[] = []
  for (let i = 0; i < 12; i++) {
    const c = css.getPropertyValue(`--graph-c${i}`).trim()
    if (c) series.push(mixHex(c, bg, 1))
  }
  if (series.length === 0) series.push(solid('--graph-note', '#0969da'), solid('--graph-tag', '#1a7f37'))
  // The theme's link colour is usually its border: lift it towards the text colour so the web shows.
  const link = mixHex(solid('--fg', '#888888'), solid('--graph-link', '#d0d7de'), 0.3)
  const lum = bgRaw ? (0.2126 * bgRaw[0] + 0.7152 * bgRaw[1] + 0.0722 * bgRaw[2]) / 255 : 1
  return { series, link, highlight: solid('--graph-highlight', '#bf8700'), bg, dimLink: mixHex(link, bg, 0.3), dark: lum < 0.5 }
}

// ---- Orbs -------------------------------------------------------------------------

type OrbKind = 'note' | 'tag'

/**
 * A radial-gradient disc: glowing core and coloured rim (note), or a bright
 * ring (tag). Drawn with normal blending over the links, so an orb hides the
 * web behind it; on a dark background the outer glow gives it its shine.
 */
function orbTexture(color: string, kind: OrbKind, dark: boolean): CanvasTexture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d')!
  const c = rgbOf(color) ?? [128, 128, 128, 1]
  const rgba = (rgb: readonly number[], a: number): string => `rgba(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])}, ${a})`
  const toward = (t: number, to: number): number[] => [0, 1, 2].map((i) => c[i] + (to - c[i]) * t)
  const core = dark ? [255, 255, 255] : toward(0.55, 255)
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  if (kind === 'note') {
    // Hot core → tinted body → saturated rim → soft outer glow.
    grad.addColorStop(0, rgba(core, 1))
    grad.addColorStop(0.1, rgba(core, 0.95))
    grad.addColorStop(0.32, rgba(toward(dark ? 0.45 : 0.4, 255), 1))
    grad.addColorStop(0.55, rgba(c, 1))
    grad.addColorStop(0.68, rgba(toward(0.12, dark ? 255 : 0), 1))
    grad.addColorStop(0.74, rgba(c, dark ? 0.5 : 0.35))
    grad.addColorStop(0.86, rgba(c, dark ? 0.16 : 0.08))
    grad.addColorStop(1, rgba(c, 0))
  } else {
    grad.addColorStop(0, rgba(c, dark ? 0.12 : 0.18))
    grad.addColorStop(0.5, rgba(c, dark ? 0.3 : 0.35))
    grad.addColorStop(0.62, rgba(toward(0.3, 255), 1))
    grad.addColorStop(0.7, rgba(c, 1))
    grad.addColorStop(0.78, rgba(c, 0.55))
    grad.addColorStop(1, rgba(c, 0))
  }
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  return tex
}

/**
 * Cluster of each node: its top-level tag (a note takes that of its first
 * tag). Groups are numbered by size, so the biggest gets the first colour.
 */
function assignGroups(data: GraphData): Map<string, number> {
  const top = (tag: string): string => tag.split('/')[0]
  const size = new Map<string, number>()
  for (const n of data.nodes) for (const t of n.tags ?? []) size.set(top(t), (size.get(top(t)) ?? 0) + 1)
  const order = [...size.keys()].sort((a, b) => size.get(b)! - size.get(a)! || a.localeCompare(b))
  const index = new Map(order.map((k, i) => [k, i]))
  const out = new Map<string, number>()
  for (const n of data.nodes) {
    if (n.kind === 'tag') out.set(n.id, index.get(top(n.id.slice(2))) ?? 0)
    else {
      // The first tag written is the note's main one.
      const first = n.tags?.[0]
      out.set(n.id, first ? index.get(top(first)) ?? 0 : 0)
    }
  }
  return out
}

// ---- View -----------------------------------------------------------------------

export class GraphView {
  private fg: ForceGraph3DInstance<VNode, VLink>
  private colors = readColors()
  private neighbours = new Map<string, Set<string>>()
  private nodesById = new Map<string, VNode>()
  /** What is lit: a node and its neighbours, or one link and its two ends. */
  private focus: { center: string | null; nodes: Set<string>; links: Set<VLink> } | null = null
  private resize: ResizeObserver
  private raf = 0
  private angle = 0
  private radius = 220
  private target: Point = { x: 0, y: 0, z: 0 }
  private frames = 0
  private paused = false
  /** Overlay: frame the whole graph once its layout has settled, unless the user already picked something. */
  private fitOnSettle = false
  private onTheme = (): void => this.recolor()
  private sprites = new Map<string, Sprite>()
  private textures = new Map<string, CanvasTexture>()
  private relSize: number

  constructor(private el: HTMLElement, private mode: Mode, handlers: GraphViewHandlers = {}) {
    const overlay = mode === 'overlay'
    this.fg = new Graph3D(el, { controlType: 'orbit', rendererConfig: { antialias: overlay, alpha: false, powerPreference: overlay ? 'high-performance' : 'low-power' } })
      .showNavInfo(false)
      .enableNavigationControls(overlay)
      .enablePointerInteraction(overlay)
      .nodeId('id')
      .nodeRelSize(this.relSize = overlay ? 4 : 5)
      .nodeVal((n) => (n.kind === 'tag' ? 2 + n.degree * 0.6 : 1 + n.degree * 0.35))
      .nodeThreeObject((n) => this.makeOrb(n))
      .nodeLabel((n) => (overlay ? `<div class="graph-tip ${n.kind}">${escapeHtml(n.label)}</div>` : ''))
      .linkOpacity(overlay ? 0.55 : 0.5)
      .linkDirectionalParticleWidth(2.2)
      .linkDirectionalParticleSpeed(0.006)
      .cooldownTicks(overlay ? 200 : 120)
      .onNodeClick((n) => handlers.onNodeClick?.(n))
      .onLinkClick((l) => handlers.onLinkClick?.(l))
      .onBackgroundClick(() => handlers.onBackgroundClick?.())
      .onEngineStop(() => {
        if (!this.fitOnSettle) return
        this.fitOnSettle = false
        if (!this.focus) this.zoomToFit(600)
      })
    this.fitOnSettle = overlay
    // Stronger repulsion and longer links: a round cloud instead of a tight star around the busiest tags.
    ;(this.fg.d3Force('charge') as unknown as { strength(v: number): void } | undefined)?.strength(-45)
    ;(this.fg.d3Force('link') as unknown as { distance(v: number): void } | undefined)?.distance(26)
    this.applyAccessors()
    this.resize = new ResizeObserver(() => this.fit())
    this.resize.observe(el)
    this.fit()
    document.addEventListener('theme-applied', this.onTheme)
  }

  /** Replace the data; nodes that already had a place (`seed`) start there, so a refresh doesn't jump. */
  setData(data: GraphData, seed?: Map<string, Point>): void {
    this.neighbours.clear()
    this.nodesById.clear()
    const degree = new Map<string, number>()
    for (const l of data.links) {
      degree.set(l.source, (degree.get(l.source) ?? 0) + 1)
      degree.set(l.target, (degree.get(l.target) ?? 0) + 1)
      this.adj(l.source).add(l.target)
      this.adj(l.target).add(l.source)
    }
    const groups = assignGroups(data)
    const nodes: VNode[] = data.nodes.map((n) => ({ ...n, degree: degree.get(n.id) ?? 0, group: groups.get(n.id) ?? 0, ...(seed?.get(n.id) ?? {}) }))
    for (const n of nodes) this.nodesById.set(n.id, n)
    const links: VLink[] = data.links.map((l) => ({ source: l.source, target: l.target }))
    const center = this.focus?.center
    this.focus = null
    this.sprites.clear()
    this.fg.graphData({ nodes, links })
    // Keep a lit node lit if it survived the refresh.
    if (center && this.nodesById.has(center)) this.highlightNode(center)
    else this.applyAccessors()
  }

  node(id: string): VNode | undefined {
    return this.nodesById.get(id)
  }

  neighboursOf(id: string): VNode[] {
    return [...(this.neighbours.get(id) ?? [])].map((n) => this.nodesById.get(n)!).filter(Boolean)
  }

  /** Current layout, to seed another view of the same graph. */
  positions(): Map<string, Point> {
    const out = new Map<string, Point>()
    for (const n of this.fg.graphData().nodes) if (n.x !== undefined) out.set(n.id, { x: n.x, y: n.y ?? 0, z: n.z ?? 0 })
    return out
  }

  // ---- Highlight ------------------------------------------------------------------

  highlightNode(id: string): void {
    const nodes = new Set([id, ...(this.neighbours.get(id) ?? [])])
    const links = new Set(this.fg.graphData().links.filter((l) => endId(l.source) === id || endId(l.target) === id))
    this.focus = { center: id, nodes, links }
    this.applyAccessors()
  }

  highlightLink(link: VLink): void {
    this.focus = { center: null, nodes: new Set([endId(link.source), endId(link.target)]), links: new Set([link]) }
    this.applyAccessors()
  }

  clearHighlight(): void {
    if (!this.focus) return
    this.focus = null
    this.applyAccessors()
  }

  /**
   * Swing the camera to a node. It closes in along the current line of sight,
   * so it never flies through the rest of the graph to get there.
   */
  flyTo(id: string, ms = 900): void {
    const n = this.nodesById.get(id)
    if (!n || n.x === undefined) return
    const p = { x: n.x, y: n.y ?? 0, z: n.z ?? 0 }
    const cam = this.fg.cameraPosition()
    const d = { x: cam.x - p.x, y: cam.y - p.y, z: cam.z - p.z }
    const len = Math.hypot(d.x, d.y, d.z) || 1
    const dist = 150
    this.fg.cameraPosition({ x: p.x + (d.x / len) * dist, y: p.y + (d.y / len) * dist, z: p.z + (d.z / len) * dist }, p, ms)
  }

  zoomToFit(ms = 700): void {
    this.fg.zoomToFit(ms, 30)
  }

  private adj(id: string): Set<string> {
    let s = this.neighbours.get(id)
    if (!s) this.neighbours.set(id, (s = new Set()))
    return s
  }

  /** A node's cluster colour (for the card's dots). */
  colorOf(id: string): string {
    const n = this.nodesById.get(id)
    const s = this.colors.series
    return s[(n?.group ?? 0) % s.length]
  }

  private recolor(): void {
    this.colors = readColors()
    for (const t of this.textures.values()) t.dispose()
    this.textures.clear()
    this.applyAccessors()
  }

  private texture(color: string, kind: OrbKind): CanvasTexture {
    const key = `${kind}|${color}|${this.colors.dark}`
    let t = this.textures.get(key)
    if (!t) this.textures.set(key, (t = orbTexture(color, kind, this.colors.dark)))
    return t
  }

  private makeOrb(n: VNode): Sprite {
    const sprite = new Sprite(new SpriteMaterial({ transparent: true, depthWrite: false, blending: NormalBlending }))
    sprite.renderOrder = 20 // after the links (three-forcegraph draws them at 10), so orbs sit on top of the web
    this.sprites.set(n.id, sprite)
    this.styleOrb(n, sprite)
    return sprite
  }

  /** Colour, size and fade of one orb for the current theme and highlight. */
  private styleOrb(n: VNode, sprite: Sprite): void {
    const c = this.colors
    const f = this.focus
    const lit = f && (f.center === n.id || (f.center === null && f.nodes.has(n.id)))
    const dimmed = f && !f.nodes.has(n.id)
    const m = sprite.material
    m.map = this.texture(lit ? c.highlight : this.colorOf(n.id), n.kind)
    m.opacity = dimmed ? 0.14 : 1
    // The sphere three-forcegraph would draw has radius cbrt(val) * relSize; the orb's rim sits at ~70% of the sprite.
    const val = n.kind === 'tag' ? 2 + n.degree * 0.6 : 1 + n.degree * 0.35
    const size = Math.cbrt(val) * this.relSize * 2.9 * (lit && f?.center === n.id ? 1.35 : 1)
    sprite.scale.set(size, size, 1)
  }

  /** Restyle orbs in place and re-set link accessors (how three-forcegraph is told to repaint links). */
  private applyAccessors(): void {
    const c = this.colors
    const f = this.focus
    for (const [id, sprite] of this.sprites) {
      const n = this.nodesById.get(id)
      if (n) this.styleOrb(n, sprite)
    }
    const overlay = this.mode === 'overlay'
    this.fg
      .backgroundColor(c.bg)
      .linkColor((l) => (!f ? c.link : f.links.has(l) ? c.highlight : c.dimLink))
      .linkWidth((l) => (f?.links.has(l) ? 1.2 : 0))
      // Light flowing along the lit links, like a pulse through the web.
      .linkDirectionalParticles((l) => (overlay && f?.links.has(l) ? 3 : 0))
      .linkDirectionalParticleColor(() => c.highlight)
  }

  // ---- Size, revolve, pause --------------------------------------------------------

  // clientWidth/Height, not getBoundingClientRect: the overlay opens with a
  // scale transition, and the canvas must take its final, unscaled size.
  private fit(): void {
    const { clientWidth: width, clientHeight: height } = this.el
    if (width < 2 || height < 2) return
    this.fg.width(width).height(height)
  }

  /**
   * Auto-revolve (sidebar pane): orbit the graph's centre at a distance that
   * keeps it all in view, re-measured as the layout settles.
   */
  startRevolve(): void {
    if (this.raf) return
    const step = (): void => {
      if (this.frames++ % 15 === 0) this.measure()
      this.angle += 0.0035
      const r = this.radius
      this.fg.cameraPosition(
        { x: this.target.x + r * Math.sin(this.angle), y: this.target.y + r * 0.28, z: this.target.z + r * Math.cos(this.angle) },
        this.target
      )
      this.raf = requestAnimationFrame(step)
    }
    this.raf = requestAnimationFrame(step)
  }

  stopRevolve(): void {
    cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private measure(): void {
    const nodes = this.fg.graphData().nodes.filter((n) => n.x !== undefined)
    if (nodes.length === 0) return
    const c = { x: 0, y: 0, z: 0 }
    for (const n of nodes) {
      c.x += n.x!
      c.y += n.y ?? 0
      c.z += n.z ?? 0
    }
    c.x /= nodes.length
    c.y /= nodes.length
    c.z /= nodes.length
    let reach = 10
    for (const n of nodes) reach = Math.max(reach, Math.hypot(n.x! - c.x, (n.y ?? 0) - c.y, (n.z ?? 0) - c.z))
    // Fit the sphere in the narrower field of view (the pane is usually taller than wide).
    const { clientWidth: width, clientHeight: height } = this.el
    const vHalf = (40 / 2) * (Math.PI / 180)
    const hHalf = Math.atan(Math.tan(vHalf) * (width / Math.max(1, height)))
    // `reach` is the farthest node; a force layout is mostly nearer than that, so frame a bit tighter.
    const want = (reach * 0.8 + 6) / Math.sin(Math.min(vHalf, hHalf))
    // Ease towards the new framing so the orbit never jumps.
    this.radius += (want - this.radius) * 0.35
    this.target = { x: this.target.x + (c.x - this.target.x) * 0.35, y: this.target.y + (c.y - this.target.y) * 0.35, z: this.target.z + (c.z - this.target.z) * 0.35 }
  }

  pause(): void {
    if (this.paused) return
    this.paused = true
    this.stopRevolve()
    this.fg.pauseAnimation()
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.fg.resumeAnimation()
  }

  dispose(): void {
    this.stopRevolve()
    for (const t of this.textures.values()) t.dispose()
    for (const s of this.sprites.values()) s.material.dispose()
    this.resize.disconnect()
    document.removeEventListener('theme-applied', this.onTheme)
    const renderer = this.fg.renderer()
    this.fg._destructor()
    renderer.dispose()
    renderer.forceContextLoss()
    this.el.replaceChildren()
  }
}

export function endId(end: string | VNode): string {
  return typeof end === 'string' ? end : end.id
}
