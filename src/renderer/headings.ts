import MarkdownIt from 'markdown-it'
import { stripFrontMatter } from './frontmatter'

export interface Heading {
  level: number
  /** Inline content as written in the source. */
  text: string
  /** Text and inline code only, marks and link targets dropped: what markdown-it-anchor slugs. */
  plain: string
  /** 0-based source line of the heading (first line for setext). */
  line: number
}

/** The TOC's own heading is never listed or numbered (same as Word). */
export function isTocHeading(text: string): boolean {
  return /^(table of )?contents$/i.test(text.trim())
}

const parser = new MarkdownIt()

/** Split on either line ending and remember which one to put back. */
export function splitLines(src: string): { lines: string[]; eol: string } {
  return { lines: src.split(/\r?\n/), eol: src.includes('\r\n') ? '\r\n' : '\n' }
}

/** Walk block tokens so headings inside fenced code / HTML blocks are ignored. */
export function extractHeadings(src: string): Heading[] {
  const tokens = parser.parse(stripFrontMatter(src), {})
  const out: Heading[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type !== 'heading_open' || !t.map) continue
    const inline = tokens[i + 1]?.type === 'inline' ? tokens[i + 1] : null
    const plain = (inline?.children ?? []).filter((c) => c.type === 'text' || c.type === 'code_inline').map((c) => c.content).join('')
    out.push({ level: Number(t.tag.slice(1)), text: inline?.content ?? '', plain, line: t.map[0] })
  }
  return out
}
