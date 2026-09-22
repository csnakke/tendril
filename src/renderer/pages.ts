import type { MarkdownIt, StateCore, Token } from 'markdown-it'

/**
 * Report layout markers, all plain HTML comments so the file stays valid
 * Markdown everywhere else:
 *
 *   <!-- cover -->  …  <!-- /cover -->   cover page (its own page)
 *   <!-- pagebreak -->                     start a new page
 *   <style> … </style>                     document styles, scoped to the preview
 *
 * A document using cover/pagebreak renders "paged": every page becomes
 * `<section class="page">`, shown as sheets in the preview and split with
 * `break-after: page` in PDF export.
 */

export const PAGEBREAK = '<!-- pagebreak -->'
export const COVER_START = '<!-- cover -->'
export const COVER_END = '<!-- /cover -->'

const RE_PAGEBREAK = /^<!--\s*pagebreak\s*-->\s*$/i
const RE_COVER_START = /^<!--\s*cover\s*-->\s*$/i
const RE_COVER_END = /^<!--\s*\/cover\s*-->\s*$/i
const RE_STYLE = /^<style\b[^>]*>([\s\S]*?)<\/style>\s*$/i

/** Markers count only at the start of a top-level line (not inside quotes/lists). */
export function isPaged(src: string): boolean {
  return /^<!--\s*(pagebreak|cover)\s*-->\s*$/im.test(src)
}

/** Rewrite a document `<style>` so it can only affect the rendered body. */
export function scopeCss(css: string): string {
  // @page / @font-face must stay top-level; everything else nests under the body.
  const top: string[] = []
  const rest = css.replace(/@(page|font-face)\b[^{]*\{[^{}]*\}/g, (m) => {
    top.push(m)
    return ''
  })
  return `${top.join('\n')}\n.markdown-body {\n${rest}\n}`
}

export function pagesPlugin(md: MarkdownIt): void {
  // Markers must be their own HTML block; a marker right after raw HTML (no
  // blank line) would otherwise be swallowed into that block.
  md.core.ruler.before('block', 'pages_markers', (state: StateCore) => {
    state.src = state.src.replace(/^(<!--\s*(?:pagebreak|cover|\/cover)\s*-->)[ \t]*$/gim, '\n$1\n')
  })
  md.core.ruler.push('pages', (state: StateCore) => {
    const paged = state.tokens.some(
      (t: Token) => t.type === 'html_block' && t.level === 0 && (RE_PAGEBREAK.test(t.content) || RE_COVER_START.test(t.content))
    )
    if (!paged && !state.tokens.some((t: Token) => t.type === 'html_block' && RE_STYLE.test(t.content))) return
    const out: Token[] = []
    const styles: Token[] = []
    let inCover = false
    let inPage = false
    const open = (cls: string): void => {
      const t = new state.Token('page_open', 'section', 1)
      t.attrSet('class', cls)
      t.block = true
      out.push(t)
      inPage = true
    }
    const close = (): void => {
      if (!inPage) return
      out.push(new state.Token('page_close', 'section', -1))
      inPage = false
    }
    if (paged) open('page')
    for (const t of state.tokens) {
      if (t.type === 'html_block' && t.level === 0) {
        const m = RE_STYLE.exec(t.content)
        if (m) {
          const s = new state.Token('doc_style', 'style', 0)
          s.content = scopeCss(m[1])
          s.block = true
          styles.push(s)
          continue
        }
        if (RE_PAGEBREAK.test(t.content)) {
          close()
          open('page')
          continue
        }
        if (RE_COVER_START.test(t.content)) {
          close()
          open('page cover')
          inCover = true
          continue
        }
        if (RE_COVER_END.test(t.content)) {
          if (inCover) {
            close()
            inCover = false
            open('page')
          }
          continue
        }
      }
      out.push(t)
    }
    close()
    // Drop pages left empty by a leading cover or a trailing page break.
    for (let i = out.length - 2; i >= 0; i--) {
      if (out[i].type === 'page_open' && out[i + 1].type === 'page_close') out.splice(i, 2)
    }
    // Document styles live outside the pages so they never occupy one.
    state.tokens = [...styles, ...out]
  })
  md.renderer.rules.page_open = (tokens: Token[], i: number) => `<section class="${tokens[i].attrGet('class')}">\n`
  md.renderer.rules.page_close = () => '</section>\n'
  md.renderer.rules.doc_style = (tokens: Token[], i: number) => `<style>${tokens[i].content}</style>\n`
}
