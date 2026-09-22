/**
 * Stylesheet for PDF export: a printed document rather than a web page.
 * Points, not pixels; a text face for prose and the editor's monospace only
 * for code; headings kept with what follows; tables that repeat their header
 * row on every page; code that wraps instead of clipping.
 */

export type PdfFont = 'editor' | 'sans' | 'serif'

export const SANS_STACK = '"Segoe UI", -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif'
export const SERIF_STACK = 'Georgia, "Times New Roman", Times, serif'
export const CODE_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/** Body and code families for the chosen option; `editor` is the embedded editor font when one is set. */
export function pdfFontFamilies(choice: PdfFont, editorFamily: string): { text: string; code: string } {
  const editor = editorFamily ? `"${editorFamily}", ` : ''
  const text = choice === 'serif' ? SERIF_STACK : choice === 'sans' || !editorFamily ? SANS_STACK : `${editor}${SANS_STACK}`
  return { text, code: `${editor}${CODE_STACK}` }
}

export const PRINT_CSS = `
html { font-size: 11pt; }
body { margin: 0; background: #fff; }
.markdown-body {
  box-sizing: border-box;
  font-family: var(--doc-font);
  font-size: 11pt;
  line-height: 1.5;
  color: #1a1a1a;
  orphans: 3;
  widows: 3;
}
.markdown-body :is(h1, h2, h3, h4, h5, h6) { font-weight: 700; line-height: 1.25; margin: 0; break-after: avoid; page-break-after: avoid; }
.markdown-body h1 { font-size: 20pt; margin: 0 0 12pt; padding-bottom: 5pt; border-bottom: 1.25pt solid #1a1a1a; }
.markdown-body h2 { font-size: 15pt; margin: 20pt 0 8pt; }
.markdown-body h3 { font-size: 12.5pt; margin: 16pt 0 6pt; }
.markdown-body h4 { font-size: 11.5pt; margin: 12pt 0 4pt; }
.markdown-body h5 { font-size: 11pt; margin: 10pt 0 4pt; }
.markdown-body h6 { font-size: 11pt; font-weight: 600; font-style: italic; color: #444; margin: 10pt 0 4pt; }
.markdown-body :is(h1, h2, h3) + :is(h2, h3, h4) { margin-top: 8pt; }
.markdown-body p { margin: 0 0 8pt; }
.markdown-body a { color: inherit; text-decoration: underline; text-decoration-color: #999; text-underline-offset: 2px; }
.markdown-body :is(ul, ol) { margin: 0 0 8pt; padding-left: 20pt; }
.markdown-body li { margin: 2pt 0; }
.markdown-body li > :is(ul, ol) { margin-bottom: 0; }
.markdown-body blockquote { margin: 8pt 0 10pt; padding: 2pt 12pt; border-left: 2pt solid #999; color: #444; }
.markdown-body blockquote > :last-child { margin-bottom: 0; }
.markdown-body hr { border: none; border-top: 0.75pt solid #999; margin: 14pt 0; }
.markdown-body :is(code, kbd, samp, tt) { font-family: var(--code-font); font-size: 9.5pt; background: #f3f3f3; padding: 1pt 3pt; border-radius: 2pt; }
.markdown-body pre {
  font-family: var(--code-font);
  font-size: 9pt;
  line-height: 1.45;
  margin: 0 0 10pt;
  padding: 8pt 10pt;
  background: #f6f6f6;
  border: 0.5pt solid #ddd;
  border-radius: 3pt;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  break-inside: avoid;
}
.markdown-body pre code { font-size: inherit; background: none; padding: 0; border-radius: 0; }
.markdown-body table { width: 100%; border-collapse: collapse; margin: 0 0 12pt; font-size: 10pt; line-height: 1.35; }
.markdown-body thead { display: table-header-group; }
.markdown-body tr { break-inside: avoid; page-break-inside: avoid; }
.markdown-body th { text-align: left; font-weight: 600; background: #f0f0f0; border-bottom: 1pt solid #333; padding: 4pt 6pt; vertical-align: bottom; }
.markdown-body td { border-bottom: 0.5pt solid #ccc; padding: 4pt 6pt; vertical-align: top; }
.markdown-body img { display: block; max-width: 100%; height: auto; margin: 8pt auto; break-inside: avoid; }
.markdown-body figure { margin: 8pt 0 12pt; break-inside: avoid; text-align: center; }
.markdown-body figcaption { font-size: 9.5pt; color: #555; margin-top: 4pt; }
.markdown-body :is(strong, b) { font-weight: 700; }

/* Title block (from front matter) and contents. */
.markdown-body .doc-title { margin: 0 0 18pt; }
.markdown-body .doc-title.after-h1 { margin: -8pt 0 16pt; }
.markdown-body .doc-title .subtitle { font-size: 13pt; color: #555; margin: 0 0 4pt; }
.markdown-body .doc-title .byline { font-size: 10.5pt; color: #444; }
.markdown-body .doc-title .meta { font-size: 9pt; color: #777; margin-top: 3pt; }
.markdown-body .doc-title .meta span + span::before { content: " · "; color: #bbb; }
.markdown-body .doc-title .meta b { font-weight: 600; color: #666; }
.markdown-body .toc { margin: 0 0 16pt; break-inside: avoid; }
.markdown-body .toc-title { font-size: 12.5pt; font-weight: 700; margin: 0 0 6pt; }
.markdown-body .toc ul { list-style: none; margin: 0; padding: 0; }
.markdown-body .toc ul ul { padding-left: 16pt; }
.markdown-body .toc li { margin: 1.5pt 0; }
.markdown-body .toc a { text-decoration: none; color: inherit; }

/* Cover pages: keep the template's own styles, but without the h1 rule. */
.markdown-body .page.cover h1 { border: none; }
`
