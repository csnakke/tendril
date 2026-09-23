import { CORE_SCHEMA, load } from 'js-yaml'

/**
 * YAML front matter ("properties"): a `---` block at the very top of the file,
 * the Obsidian/Jekyll convention. Shared so the main process can read tags for
 * the graph with the same rules the renderer uses for display.
 */

export interface FrontMatter {
  data: Record<string, unknown>
  /** 0-based line range of the block, fences included (end is inclusive). */
  start: number
  end: number
  /** Parse error message, if the YAML was invalid. */
  error?: string
}

const OPEN = /^---\s*$/
const CLOSE = /^(---|\.\.\.)\s*$/

export function parseFrontMatter(src: string): FrontMatter | null {
  const lines = src.split(/\r?\n/)
  if (!OPEN.test(lines[0] ?? '')) return null
  for (let i = 1; i < lines.length; i++) {
    if (!CLOSE.test(lines[i])) continue
    const yaml = lines.slice(1, i).join('\n')
    try {
      const value = load(yaml, { schema: CORE_SCHEMA })
      const data = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
      return { data, start: 0, end: i }
    } catch (err) {
      return { data: {}, start: 0, end: i, error: (err as Error).message }
    }
  }
  return null
}
