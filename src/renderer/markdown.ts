import MarkdownIt, { type Env } from 'markdown-it'
import anchor from 'markdown-it-anchor'
import { slug } from 'github-slugger'
import githubCss from 'github-markdown-css/github-markdown-light.css?raw'
import { escapeHtml } from './escape'
import { sanitizeHtml } from './sanitize'
import { parseFrontMatter, renderProperties, renderTitleBlock, stripFrontMatter, type FrontMatter } from './frontmatter'
import { isPaged, pagesPlugin } from './pages'
import { TABLE_CSS, tablesPlugin } from './tables/plugin'
import { PRINT_CSS, pdfFontFamilies, type PdfFont } from './printStyles'
import { isTocHeading } from './headings'
import type { StateCore, Token, MarkdownIt as MarkdownItType } from 'markdown-it'

export { escapeHtml }
export { TABLE_CSS }

/** Per-render options; `resolveImage` maps a local image path to a loadable URL. */
export type RenderEnv = Env & {
  resolveImage?: (src: string) => string
  /** PDF: wrap the TOC as a contents block, images with a title as figures, front matter as a title block. */
  print?: boolean
  /** Front matter to render as the title block (print only). */
  titleBlock?: FrontMatter
}

/** Local paths (relative, or absolute like /x/a.png, C:\\x\\a.png) as opposed to http(s):, data:, … */
export const isLocalImage = (src: string): boolean => /^[a-z]:[\\/]/i.test(src) || !/^[a-z][a-z0-9+.-]*:/i.test(src)

/** Local image paths referenced by a document, in order, de-duplicated. */
export function collectImages(src: string): string[] {
  const out = new Set<string>()
  const fm = parseFrontMatter(src)
  const walk = (tokens: ReturnType<typeof md.parse>): void => {
    for (const t of tokens) {
      if (t.type === 'image') {
        const s = t.attrGet('src')
        if (typeof s === 'string' && isLocalImage(s)) out.add(s)
      }
      if (t.children) walk(t.children)
    }
  }
  walk(md.parse(fm ? stripFrontMatter(src) : src, {}))
  return [...out]
}

// Static slug + markdown-it-anchor's own "-1", "-2" dedupe reproduces GitHub's
// anchors exactly, which is what the TOC module (toc.ts) also produces.
export const md = new MarkdownIt({ html: true, linkify: true, typographer: false })
  .use(anchor, {
    slugify: (s) => slug(s),
    tabIndex: false
  })
  .use(pagesPlugin)
  .use(tablesPlugin)
  .use(printPlugin)

// Route local image paths through the caller's resolver (preview, PDF, export differ).
const defaultImage = md.renderer.rules.image!
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const t = tokens[idx]
  const src = t.attrGet('src')
  const e = env as RenderEnv | undefined
  if (typeof src === 'string' && e?.resolveImage && isLocalImage(src)) t.attrSet('src', e.resolveImage(src))
  const html = defaultImage(tokens, idx, options, env, self)
  // In print a titled image becomes a captioned figure.
  const title = t.attrGet('title')
  return e?.print && title ? `<figure>${html}<figcaption>${escapeHtml(String(title))}</figcaption></figure>` : html
}

const RE_TOC_START = /^<!--\s*toc\s*-->\s*$/i
const RE_TOC_END = /^<!--\s*tocstop\s*-->\s*$/i

/**
 * Print-only document structure: the `<!-- toc -->` block becomes
 * `<nav class="toc">` (headed "Contents" unless a Contents heading precedes
 * it) and the title block lands after the first H1, or at the top when the
 * document has none. Documents with a cover page carry their own title.
 */
function printPlugin(mdi: MarkdownItType): void {
  mdi.core.ruler.push('print_structure', (state: StateCore) => {
    const env = state.env as RenderEnv
    if (!env.print) return
    const html = (content: string): Token => {
      const t = new state.Token('html_block', '', 0)
      t.content = content
      t.block = true
      return t
    }
    const tokens = state.tokens
    let lastHeading = ''
    let inCover = false
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      if (t.type === 'page_open') inCover = String(t.attrGet('class') ?? '').includes('cover')
      if (t.type === 'heading_open' && tokens[i + 1]?.type === 'inline') lastHeading = tokens[i + 1].content
      if (t.type !== 'html_block' || !RE_TOC_START.test(t.content)) continue
      const end = tokens.findIndex((x, j) => j > i && x.type === 'html_block' && RE_TOC_END.test(x.content))
      if (end < 0) continue
      const titled = isTocHeading(lastHeading) || inCover
      tokens[i] = html(`<nav class="toc">${end > i + 1 && !titled ? '<div class="toc-title">Contents</div>' : ''}\n`)
      tokens[end] = html('</nav>\n')
      i = end
    }
    const fm = env.titleBlock
    if (!fm || tokens.some((t) => t.type === 'page_open' && String(t.attrGet('class') ?? '').includes('cover'))) return
    const h1 = tokens.findIndex((t) => t.type === 'heading_open' && t.tag === 'h1' && t.level === 0)
    const first = tokens.findIndex((t) => t.type !== 'doc_style')
    const block = renderTitleBlock(fm, { afterH1: h1 >= 0 })
    if (!block) return
    if (h1 >= 0) {
      const close = tokens.findIndex((t, j) => j > h1 && t.type === 'heading_close')
      tokens.splice(close + 1, 0, html(block))
    } else tokens.splice(Math.max(first, 0), 0, html(block))
  })
}

/** Body HTML: front-matter properties block (if any) followed by the document; in print, a title block instead. */
export function renderBody(src: string, env: RenderEnv = {}): string {
  const fm = parseFrontMatter(src)
  const body = fm ? stripFrontMatter(src) : src
  // Sanitized here rather than at each caller: preview, template preview, HTML
  // export and the PDF printer all come through this one function.
  if (env.print) return sanitizeHtml(md.render(body, { ...env, titleBlock: fm ?? undefined }))
  return sanitizeHtml((fm ? renderProperties(fm) : '') + md.render(body, env))
}

export interface ExportFont {
  family: string
  css: string
}

export interface StandaloneOptions {
  /** `pdf` prints as a document (print stylesheet, title block, contents); `html` keeps the GitHub look. */
  mode?: 'html' | 'pdf'
  pdfFont?: PdfFont
}

/** Self-contained HTML for export; the PDF is printed from a `pdf`-mode document. */
export function renderStandaloneHtml(src: string, title: string, font?: ExportFont, env: RenderEnv = {}, opts: StandaloneOptions = {}): string {
  if (opts.mode === 'pdf') return renderPrintHtml(src, title, font, env, opts.pdfFont ?? 'editor')
  const fontCss = font?.family
    ? `${font.css}
.markdown-body { font-family: "${font.family}", ${EXPORT_FONT_FALLBACK}; }
.markdown-body :is(code, pre, kbd, samp, tt) { font-family: "${font.family}", ${EXPORT_CODE_FALLBACK}; }`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Nothing in an exported note needs to run; images are embedded as data: URIs. -->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(title)}</title>
<style>
${githubCss}
${fontCss}
body { margin: 0; background: #fff; }
.markdown-body { box-sizing: border-box; max-width: 900px; margin: 0 auto; padding: 32px; }
${PROPERTIES_CSS}
${PAGES_CSS}
${TABLE_CSS}
@media print {
  .markdown-body { max-width: none; padding: 0; }
  a { color: inherit; }
  h1, h2, h3, h4, h5, h6 { break-after: avoid; }
  pre, table, img { break-inside: avoid; }
  .markdown-body .page { break-after: page; }
  .markdown-body .page:last-child { break-after: auto; }
}
</style>
</head>
<body>
<article class="markdown-body${isPaged(src) ? ' paged' : ''}">
${renderBody(src, env)}
</article>
</body>
</html>
`
}

function renderPrintHtml(src: string, title: string, font: ExportFont | undefined, env: RenderEnv, pdfFont: PdfFont): string {
  const fam = pdfFontFamilies(pdfFont, font?.family ?? '')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
${font?.css ?? ''}
${PRINT_CSS}
.markdown-body { --doc-font: ${fam.text}; --code-font: ${fam.code}; }
${PROPERTIES_CSS}
${PAGES_CSS}
${TABLE_CSS}
@media print {
  .markdown-body .page { break-after: page; }
  .markdown-body .page:last-child { break-after: auto; }
}
</style>
</head>
<body>
<article class="markdown-body${isPaged(src) ? ' paged' : ''}">
${renderBody(src, { ...env, print: true })}
</article>
</body>
</html>
`
}

const EXPORT_FONT_FALLBACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif'
const EXPORT_CODE_FALLBACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/** Shared by the preview stylesheet and exports so both look the same. */
export const PROPERTIES_CSS = `
.markdown-body .properties { width: auto; min-width: 50%; margin: 0 0 24px; font-size: 0.9em; border-collapse: collapse; }
.markdown-body .properties th, .markdown-body .properties td { padding: 4px 12px; border: none; border-bottom: 1px solid rgba(128, 128, 128, 0.25); text-align: left; vertical-align: top; }
.markdown-body .properties th { font-weight: 500; color: rgba(128, 128, 128, 0.95); width: 1%; white-space: nowrap; }
.markdown-body .properties tr { background: transparent !important; }
.markdown-body .properties .tag { display: inline-block; padding: 0 8px; border-radius: 10px; background: rgba(128, 128, 128, 0.18); font-size: 0.9em; }
.markdown-body .properties .empty { color: rgba(128, 128, 128, 0.7); }
.markdown-body .properties.error { padding: 8px 12px; border-left: 3px solid #e5534b; color: #e5534b; }
`

export const PAGES_CSS = `
.markdown-body .page { position: relative; }
.markdown-body .page.cover { display: flex; flex-direction: column; justify-content: center; min-height: 240mm; text-align: center; }
.markdown-body .page.cover h1 { border: none; font-size: 2.6em; margin-bottom: 0.2em; }
.markdown-body .page.cover h2, .markdown-body .page.cover h3 { border: none; font-weight: 400; color: rgba(128, 128, 128, 0.95); }
`
