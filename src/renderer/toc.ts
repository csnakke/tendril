import GithubSlugger from 'github-slugger'
import { extractHeadings, isTocHeading, splitLines, type Heading } from './headings'

export const TOC_START = '<!-- toc -->'
export const TOC_END = '<!-- tocstop -->'

export interface TocOptions {
  /** Inclusive heading levels to list; default 2..3 mirrors Word's 3-level TOC. */
  minLevel?: number
  maxLevel?: number
}

/**
 * Build a nested `- [text](#slug)` list. Slugs use github-slugger so they match
 * GitHub/GitBook anchors, including "-1", "-2" for duplicates. The slugger must
 * see every heading (not just listed ones) for dedupe to match the renderer.
 */
export function buildToc(headings: Heading[], opts: TocOptions = {}): string {
  const min = opts.minLevel ?? 2
  const max = opts.maxLevel ?? 3
  const slugger = new GithubSlugger()
  const lines: string[] = []
  for (const h of headings) {
    const slug = slugger.slug(h.plain)
    if (h.level < min || h.level > max || isTocHeading(h.plain)) continue
    const indent = '  '.repeat(h.level - min)
    lines.push(`${indent}- [${unlink(h.text)}](#${slug})`)
  }
  return lines.join('\n')
}

/** A link inside a heading keeps its text in the TOC entry (a link cannot nest in a link). */
const unlink = (text: string): string => text.replace(/(^|[^!\\])\[([^\]]*)\]\([^)]*\)/g, '$1$2')

/** Replace the block between the markers, or insert one at `cursorLine` when absent. */
export function upsertToc(src: string, toc: string, cursorLine = 0): string {
  const { lines, eol } = splitLines(src)
  const block = [TOC_START, ...toc.split('\n'), TOC_END].join(eol)
  const start = src.indexOf(TOC_START)
  const end = src.indexOf(TOC_END, start)
  if (start !== -1 && end !== -1) {
    return src.slice(0, start) + block + src.slice(end + TOC_END.length)
  }
  const at = Math.min(Math.max(cursorLine, 0), lines.length)
  lines.splice(at, 0, block, '')
  return lines.join(eol)
}

export function updateToc(src: string, opts: TocOptions = {}, cursorLine = 0): string {
  return upsertToc(src, buildToc(extractHeadings(src), opts), cursorLine)
}

export const hasToc = (src: string): boolean => src.includes(TOC_START) && src.includes(TOC_END, src.indexOf(TOC_START))

/** Remove the TOC block, markers included, along with the blank line that separated it from what follows. */
export function removeToc(src: string): string {
  const { lines, eol } = splitLines(src)
  const start = lines.findIndex((l) => l.includes(TOC_START))
  const end = lines.findIndex((l, i) => i >= start && l.includes(TOC_END))
  if (start < 0 || end < 0) return src
  let count = end - start + 1
  // Don't leave two blank lines behind (or one at the top of the document).
  if (lines[end + 1]?.trim() === '' && (start === 0 || lines[start - 1].trim() === '')) count++
  lines.splice(start, count)
  return lines.join(eol)
}

/** The toolbar's toggle: insert a TOC at the cursor, or remove the one the document has. */
export function toggleToc(src: string, cursorLine = 0): string {
  return hasToc(src) ? removeToc(src) : updateToc(src, {}, cursorLine)
}
