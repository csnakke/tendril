import type { ITheme } from '@xterm/xterm'
import type { ThemePalette } from '../../preload/index'
import { graphPalette } from './graph'

/**
 * The terminal's colours from the palette on screen. Chrome colours give the
 * background, text, cursor and selection. The 16 ANSI colours are picked from
 * the theme's own accent colours (graph series, syntax, accent) by hue, so red
 * is the theme's red wherever it sits in its lists; a hue the theme lacks
 * falls back to a standard one blended toward the theme.
 */

type Rgb = [number, number, number]

function parse(color: string): Rgb | null {
  const c = color.trim()
  let m = c.match(/^#([0-9a-f]{3,8})$/i)
  if (m) {
    let h = m[1]
    if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((x) => x + x).join('')
    if (h.length !== 6 && h.length !== 8) return null
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }
  m = c.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i)
  return m ? [+m[1], +m[2], +m[3]] : null
}

const hex = ([r, g, b]: Rgb): string => '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')

/** a·t + b·(1−t), on parsed colours; `a` alone when either does not parse. */
function blend(a: string, b: string, t: number): string {
  const pa = parse(a), pb = parse(b)
  if (!pa || !pb) return a
  return hex([0, 1, 2].map((i) => pb[i] + (pa[i] - pb[i]) * t) as Rgb)
}

function hsl([r, g, b]: Rgb): { h: number; s: number; l: number } {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255]
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === rr ? ((gg - bb) / d + (gg < bb ? 6 : 0)) : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4
  return { h: h * 60, s, l }
}

const HUES = { red: 0, yellow: 50, green: 120, cyan: 185, blue: 220, magenta: 295 } as const
type Hue = keyof typeof HUES

/** xterm's defaults, for a hue the theme has no colour near. */
const STANDARD: Record<Hue, string> = {
  red: '#cd3131', yellow: '#e5e510', green: '#0dbc79', cyan: '#11a8cd', blue: '#2472c8', magenta: '#bc3fbc'
}

const hueGap = (a: number, b: number): number => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))

function candidates(p: ThemePalette): { color: string; h: number }[] {
  const s = p.syntax ?? {}
  const all = [...graphPalette(p).series, p.accent, p.linkColor, s.heading, s.emphasis, s.link, s.code, s.keyword, s.string, s.quote]
  const out: { color: string; h: number }[] = []
  for (const color of all) {
    if (!color) continue
    const rgb = parse(color)
    if (!rgb) continue
    const { h, s: sat } = hsl(rgb)
    // Greys and near-greys say nothing about hue.
    if (sat < 0.25) continue
    out.push({ color: hex(rgb), h })
  }
  return out
}

function pick(hue: Hue, pool: { color: string; h: number }[], p: ThemePalette): string {
  let best: { color: string; gap: number } | null = null
  for (const c of pool) {
    const gap = hueGap(c.h, HUES[hue])
    if (gap <= 30 && (!best || gap < best.gap)) best = { color: c.color, gap }
  }
  return best?.color ?? blend(STANDARD[hue], p.fg, 0.8)
}

export function terminalTheme(p: ThemePalette, mode: 'light' | 'dark'): ITheme {
  const pool = candidates(p)
  const base = Object.fromEntries((Object.keys(HUES) as Hue[]).map((h) => [h, pick(h, pool, p)])) as Record<Hue, string>
  // Bright variants lean toward the text colour: lighter on dark themes, darker on light ones.
  const bright = (c: string): string => blend(c, p.fg, 0.75)
  const dark = mode === 'dark'
  return {
    background: p.bg,
    foreground: p.fg,
    cursor: p.accent,
    cursorAccent: p.bg,
    selectionBackground: p.selection,
    selectionForeground: p.fg,
    selectionInactiveBackground: p.hover,
    scrollbarSliderBackground: blend(p.muted, p.bg, 0.3),
    scrollbarSliderHoverBackground: blend(p.muted, p.bg, 0.5),
    scrollbarSliderActiveBackground: blend(p.muted, p.bg, 0.6),
    black: dark ? blend(p.fg, p.bg, 0.15) : p.fg,
    brightBlack: p.muted,
    white: dark ? blend(p.fg, p.bg, 0.85) : p.muted,
    brightWhite: dark ? p.fg : blend(p.fg, p.bg, 0.3),
    red: base.red, brightRed: bright(base.red),
    green: base.green, brightGreen: bright(base.green),
    yellow: base.yellow, brightYellow: bright(base.yellow),
    blue: base.blue, brightBlue: bright(base.blue),
    magenta: base.magenta, brightMagenta: bright(base.magenta),
    cyan: base.cyan, brightCyan: bright(base.cyan)
  }
}
