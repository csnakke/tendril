import type { ThemePalette } from '../../preload/index'

export interface GraphColors {
  note: string
  tag: string
  link: string
  highlight: string
  bg: string
  folder: string
  /** Cluster colours, one per top-level tag (repeating when there are more tags). */
  series: string[]
}

export const MAX_SERIES = 12

/**
 * The graph's colours for a palette. A theme may set any of them; the rest
 * come from its chrome colours so an older or imported theme still gets a
 * graph that belongs to it.
 */
export function graphPalette(p: ThemePalette): GraphColors {
  const tag = p.graphTag ?? p.syntax?.code ?? p.linkColor ?? p.muted
  const note = p.graphNote ?? p.accent
  // Without a set of its own, a theme's distinct syntax colours make a good one.
  const s = p.syntax ?? {}
  const derived = [note, tag, s.emphasis, s.heading, s.link, s.string, s.keyword, s.quote]
  const series = (p.graphColors?.length ? p.graphColors : derived)
    .filter((c, i, all): c is string => !!c && all.indexOf(c) === i)
    .slice(0, MAX_SERIES)
  return {
    note,
    tag,
    link: p.graphLink ?? p.border,
    highlight: p.graphHighlight ?? p.syntax?.emphasis ?? p.fg,
    bg: p.graphBg ?? p.bg,
    folder: p.graphFolder ?? p.graphTag ?? p.accent,
    series
  }
}
