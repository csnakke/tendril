import type { MarkdownIt, StateCore } from 'markdown-it'
import { escapeHtml } from '../escape'
import { parseChart } from './model'
import { renderChartSvg } from './svg'

/**
 * markdown-it side of charts: a ```chart fence renders as the chart itself,
 * and a `<!-- chart-svg -->` … `<!-- /chart-svg -->` region (the optional
 * image link "Save as SVG" writes for viewers without Tendril) is dropped,
 * since the live chart right above it already shows the same thing.
 */

export const CHART_INFO = 'chart'
export const SVG_START = '<!-- chart-svg -->'
export const SVG_END = '<!-- /chart-svg -->'
const RE_SVG_START = /^<!--\s*chart-svg\s*-->\s*$/i
const RE_SVG_END = /^<!--\s*\/chart-svg\s*-->\s*$/i

export const isChartInfo = (info: string): boolean => info.trim().split(/\s+/)[0]?.toLowerCase() === CHART_INFO

/** The figure for one chart fence; `line` is the fence's 0-based source line, for the preview to map back. */
export function renderChartBlock(yaml: string, line?: number): string {
  const r = parseChart(yaml)
  const at = line != null ? ` data-line="${line}"` : ''
  if ('error' in r) return `<div class="chart-error"${at}>Chart: ${escapeHtml(r.error)}</div>\n`
  return `<figure class="chart chart-${r.spec.options.align}"${at}>${renderChartSvg(r.spec)}</figure>\n`
}

export function chartsPlugin(md: MarkdownIt): void {
  const fallback = md.renderer.rules.fence!
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const t = tokens[idx]
    if (!isChartInfo(t.info)) return fallback(tokens, idx, options, env, self)
    return renderChartBlock(t.content, t.map?.[0])
  }

  md.core.ruler.push('chart_svg_region', (state: StateCore) => {
    const tokens = state.tokens
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'html_block' || !RE_SVG_START.test(tokens[i].content)) continue
      const end = tokens.findIndex((x, j) => j > i && x.type === 'html_block' && RE_SVG_END.test(x.content))
      if (end < 0) continue
      tokens.splice(i, end - i + 1)
      i--
    }
  })
}

/** Shared by the preview and exports. */
export const CHART_CSS = `
/* Print the shaded faces as drawn, even where a browser prints backgrounds in economy mode. */
.markdown-body figure.chart { margin: 1em 0; text-align: center; break-inside: avoid; page-break-inside: avoid; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.markdown-body figure.chart-left { text-align: left; }
.markdown-body figure.chart-right { text-align: right; }
.markdown-body figure.chart svg { display: inline-block; max-width: 100%; height: auto; overflow: visible; }
.markdown-body .chart-error { margin: 1em 0; padding: 8px 12px; border-left: 3px solid #e5534b; color: #e5534b; font-size: 0.9em; }
`
