import { parseFrontMatter, type FrontMatter } from '../shared/frontmatter'
import { escapeHtml } from './escape'

// Parsing lives in shared/ so the main process (graph) reads tags the same way.
export { parseFrontMatter, type FrontMatter }

/** Blank out the front matter lines so line numbers stay stable for the parser. */
export function stripFrontMatter(src: string): string {
  const fm = parseFrontMatter(src)
  if (!fm) return src
  const lines = src.split(/(\r?\n)/) // keep separators
  // lines[] alternates content, separator; content index k lives at 2k.
  for (let l = fm.start; l <= fm.end; l++) lines[l * 2] = ''
  return lines.join('')
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '<span class="empty">—</span>'
  if (Array.isArray(v)) return v.map((x) => `<span class="tag">${escapeHtml(String(x))}</span>`).join(' ')
  if (v instanceof Date) return escapeHtml(v.toISOString().slice(0, 10))
  if (typeof v === 'object') return `<code>${escapeHtml(JSON.stringify(v))}</code>`
  if (typeof v === 'boolean') return `<input type="checkbox" disabled${v ? ' checked' : ''}>`
  const s = String(v)
  if (/^https?:\/\/\S+$/.test(s)) return `<a href="${escapeHtml(s)}">${escapeHtml(s)}</a>`
  return escapeHtml(s)
}

const TITLE_KEYS = new Set(['title', 'subtitle', 'author', 'authors', 'date'])

const asText = (v: unknown): string =>
  Array.isArray(v) ? v.map(String).join(', ') : v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)

/**
 * Document title block for PDF export: title (unless the body already opens
 * with an H1), subtitle, author and date as a byline, and the remaining
 * properties as a small meta line. Nothing is rendered without front matter.
 */
export function renderTitleBlock(fm: FrontMatter, opts: { afterH1: boolean }): string {
  if (fm.error) return `<div class="properties error">Invalid properties: ${escapeHtml(fm.error)}</div>`
  const d = fm.data
  const title = asText(d['title'])
  const subtitle = asText(d['subtitle'])
  const byline = [asText(d['author'] ?? d['authors']), asText(d['date'])].filter(Boolean).join(' · ')
  const meta = Object.entries(d)
    .filter(([k, v]) => !TITLE_KEYS.has(k) && v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `<span><b>${escapeHtml(k)}</b> ${escapeHtml(asText(v))}</span>`)
    .join('')
  const parts = [
    !opts.afterH1 && title ? `<h1>${escapeHtml(title)}</h1>` : '',
    subtitle ? `<div class="subtitle">${escapeHtml(subtitle)}</div>` : '',
    byline ? `<div class="byline">${escapeHtml(byline)}</div>` : '',
    meta ? `<div class="meta">${meta}</div>` : ''
  ].filter(Boolean)
  return parts.length ? `<header class="doc-title${opts.afterH1 ? ' after-h1' : ''}">${parts.join('')}</header>\n` : ''
}

/** Obsidian-style key/value block shown at the top of the preview and exports. */
export function renderProperties(fm: FrontMatter): string {
  if (fm.error) return `<div class="properties error">Invalid properties: ${escapeHtml(fm.error)}</div>`
  const rows = Object.entries(fm.data)
  if (rows.length === 0) return ''
  return (
    '<table class="properties"><tbody>' +
    rows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${formatValue(v)}</td></tr>`).join('') +
    '</tbody></table>'
  )
}
