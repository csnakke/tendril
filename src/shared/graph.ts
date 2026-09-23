/**
 * The tag graph of one folder: every note with front-matter `tags` links to
 * its tags, and a nested tag (`web/xss`) links to its parent (`web`). Pure
 * data shaping, shared by the main-process scanner and the tests.
 */

export type GraphNodeKind = 'note' | 'tag'

export interface GraphNode {
  /** `n:<path>` for notes, `t:<tag>` for tags. */
  id: string
  kind: GraphNodeKind
  label: string
  /** Notes only: absolute path of the file. */
  path?: string
  /** Notes only: the note's normalised tags. */
  tags?: string[]
}

export interface GraphLink {
  source: string
  target: string
}

export interface GraphData {
  /** The graph folder this was built from. */
  dir: string
  nodes: GraphNode[]
  links: GraphLink[]
  /** True when the note cap cut the scan short. */
  truncated: boolean
}

/** What a folder's marker file (`.tendril/graph.json`) may say. */
export interface GraphConfig {
  version: number
  /** Include notes in subfolders too. */
  recursive: boolean
  /** Folder or file names (or paths relative to the graph folder) to leave out. */
  exclude: string[]
}

export const MARKER_DIR = '.tendril'
export const MARKER_FILE = 'graph.json'
export const DEFAULT_GRAPH_CONFIG: GraphConfig = { version: 1, recursive: false, exclude: [] }

export const MAX_NOTES = 2000
export const MAX_NOTE_BYTES = 2 * 1024 * 1024

/** Folders the scanner never enters, besides dot-folders and the images folder. */
export const SKIP_DIRS = new Set(['node_modules', 'assets'])

export const NOTE_FILE = /\.(md|markdown)$/i

/** Marker contents → config; anything unreadable falls back to the defaults. */
export function parseGraphConfig(text: string | null): GraphConfig {
  if (!text) return { ...DEFAULT_GRAPH_CONFIG }
  try {
    const raw = JSON.parse(text) as Partial<GraphConfig>
    return {
      version: typeof raw.version === 'number' ? raw.version : DEFAULT_GRAPH_CONFIG.version,
      recursive: raw.recursive === true,
      exclude: Array.isArray(raw.exclude) ? raw.exclude.filter((e): e is string => typeof e === 'string' && e.trim() !== '').map((e) => e.trim()) : []
    }
  } catch {
    return { ...DEFAULT_GRAPH_CONFIG }
  }
}

/** One tag as written → its canonical form, or '' when nothing is left. */
export function normaliseTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '')
}

/** Front-matter `tags` (a list, or a comma-separated string) → unique canonical tags. */
export function normaliseTags(value: unknown): string[] {
  let raw: unknown[]
  if (Array.isArray(value)) raw = value
  else if (typeof value === 'string') raw = value.split(',')
  else if (typeof value === 'number') raw = [value]
  else return []
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string' && typeof v !== 'number') continue
    const tag = normaliseTag(String(v))
    if (tag && !out.includes(tag)) out.push(tag)
  }
  return out
}

/** `a/b/c` → `['a', 'a/b']`: the ancestors a nested tag links up through. */
export function parentTags(tag: string): string[] {
  const parts = tag.split('/')
  return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

export interface NoteTags {
  path: string
  title: string
  tags: string[]
}

/** Notes with tags → nodes and links. Notes without tags are left out. */
export function buildGraphData(dir: string, notes: NoteTags[], truncated = false): GraphData {
  const nodes: GraphNode[] = []
  const links: GraphLink[] = []
  const tagIds = new Set<string>()
  const linked = new Set<string>()
  const addTag = (tag: string): string => {
    const id = `t:${tag}`
    if (!tagIds.has(id)) {
      tagIds.add(id)
      nodes.push({ id, kind: 'tag', label: `#${tag}` })
      // A nested tag hangs off its parent, so `web/xss` and `web/sqli` cluster under `web`.
      const parents = parentTags(tag)
      if (parents.length) link(id, addTag(parents[parents.length - 1]))
    }
    return id
  }
  const link = (source: string, target: string): void => {
    const key = `${source}\u0000${target}`
    if (linked.has(key)) return
    linked.add(key)
    links.push({ source, target })
  }
  for (const n of notes) {
    if (n.tags.length === 0) continue
    const id = `n:${n.path}`
    nodes.push({ id, kind: 'note', label: n.title, path: n.path, tags: n.tags })
    for (const tag of n.tags) link(id, addTag(tag))
  }
  return { dir, nodes, links, truncated }
}
