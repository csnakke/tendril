import { watch, type FSWatcher } from 'node:fs'
import { promises as fs } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { parseFrontMatter } from '../shared/frontmatter'
import {
  DEFAULT_GRAPH_CONFIG, MARKER_DIR, MARKER_FILE, MAX_NOTES, MAX_NOTE_BYTES, NOTE_FILE, SKIP_DIRS,
  buildGraphData, normaliseTags, parseGraphConfig, type GraphConfig, type GraphData, type NoteTags
} from '../shared/graph'

/**
 * Per-folder tag graphs. The explorer can browse the whole disk, so a graph is
 * opt-in: only a folder holding `.tendril/graph.json` is ever scanned, and only
 * the notes inside it. Nothing here follows symlinks or leaves that folder.
 */

const markerPath = (dir: string): string => join(dir, MARKER_DIR, MARKER_FILE)

export async function isGraphFolder(dir: string): Promise<boolean> {
  return fs.stat(markerPath(dir)).then((s) => s.isFile(), () => false)
}

export async function readGraphConfig(dir: string): Promise<GraphConfig> {
  return parseGraphConfig(await fs.readFile(markerPath(dir), 'utf8').catch(() => null))
}

/** Mark a folder as a graph folder; an existing marker (and its settings) is kept. */
export async function enableGraph(dir: string): Promise<void> {
  if (await isGraphFolder(dir)) return
  await fs.mkdir(join(dir, MARKER_DIR), { recursive: true })
  await fs.writeFile(markerPath(dir), JSON.stringify(DEFAULT_GRAPH_CONFIG, null, 2) + '\n', 'utf8')
}

/** Remove the marker; `.tendril/` goes too when nothing else lives in it. */
export async function disableGraph(dir: string): Promise<void> {
  await fs.rm(markerPath(dir), { force: true })
  await fs.rmdir(join(dir, MARKER_DIR)).catch(() => {})
  cache.delete(resolve(dir))
}

function excluded(rel: string, name: string, exclude: string[]): boolean {
  const posix = rel.split('\\').join('/')
  return exclude.some((e) => {
    const x = e.replace(/^\.\//, '').replace(/\/+$/, '')
    return x === name || x === posix || posix.startsWith(x + '/')
  })
}

/** Title shown for a note: front-matter `title`, else the file name. */
function noteTitle(data: Record<string, unknown>, file: string): string {
  const t = data['title']
  if (typeof t === 'string' && t.trim()) return t.trim()
  return basename(file).replace(NOTE_FILE, '')
}

/**
 * Read the tagged notes of a graph folder. Skips dot-folders, the images
 * folder, `node_modules`, symlinks, files over the size cap, and stops at the
 * note cap.
 */
export async function scanGraphFolder(dir: string, opts: { assetsFolder?: string } = {}): Promise<GraphData> {
  dir = resolve(dir)
  if (!(await isGraphFolder(dir))) throw new Error('Not a graph folder')
  const config = await readGraphConfig(dir)
  const skip = new Set(SKIP_DIRS)
  if (opts.assetsFolder) skip.add(opts.assetsFolder)
  const notes: NoteTags[] = []
  let seen = 0
  let truncated = false

  const walk = async (folder: string): Promise<void> => {
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => [])
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (truncated) return
      if (e.isSymbolicLink() || e.name.startsWith('.')) continue
      const path = join(folder, e.name)
      const rel = relative(dir, path)
      if (excluded(rel, e.name, config.exclude)) continue
      if (e.isDirectory()) {
        if (config.recursive && !skip.has(e.name)) await walk(path)
        continue
      }
      if (!e.isFile() || !NOTE_FILE.test(e.name)) continue
      if (seen >= MAX_NOTES) {
        truncated = true
        return
      }
      seen++
      const size = await fs.stat(path).then((s) => s.size, () => Infinity)
      if (size > MAX_NOTE_BYTES) continue
      const text = await fs.readFile(path, 'utf8').catch(() => '')
      const fm = parseFrontMatter(text)
      if (!fm || fm.error) continue
      const tags = normaliseTags(fm.data['tags'])
      if (tags.length) notes.push({ path, title: noteTitle(fm.data, path), tags })
    }
  }
  await walk(dir)
  return buildGraphData(dir, notes, truncated)
}

// ---- Cache & change notification ---------------------------------------------
// One graph is on screen at a time; its folder is watched so edits to a note's
// tags (or a new note) redraw it. Anything else is scanned fresh on request.

const cache = new Map<string, GraphData>()
let watched: { dir: string; watcher: FSWatcher; timer?: NodeJS.Timeout } | null = null

export async function buildGraph(dir: string, opts: { assetsFolder?: string; onChange: (dir: string) => void }): Promise<GraphData> {
  dir = resolve(dir)
  const hit = cache.get(dir)
  const data = hit ?? (await scanGraphFolder(dir, opts))
  cache.set(dir, data)
  if (watched?.dir !== dir) await watchGraph(dir, opts.onChange)
  return data
}

async function watchGraph(dir: string, onChange: (dir: string) => void): Promise<void> {
  unwatchGraph()
  const { recursive } = await readGraphConfig(dir)
  try {
    const watcher = watch(dir, { persistent: false, recursive }, () => {
      if (!watched) return
      clearTimeout(watched.timer)
      watched.timer = setTimeout(() => {
        cache.delete(dir)
        onChange(dir)
      }, 300)
    })
    watcher.on('error', () => unwatchGraph())
    watched = { dir, watcher }
  } catch {
    /* unwatchable: the graph still shows, it just won't live-update */
  }
}

export function unwatchGraph(): void {
  if (!watched) return
  clearTimeout(watched.timer)
  watched.watcher.close()
  watched = null
}

export function forgetGraph(dir: string): void {
  dir = resolve(dir)
  cache.delete(dir)
  if (watched?.dir === dir) unwatchGraph()
}
