import { watch, type FSWatcher } from 'node:fs'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

export interface DirListing {
  path: string
  /** null at a filesystem root. */
  parent: string | null
  entries: DirEntry[]
}

/** Directories first, then files, both case-insensitively by name. */
export async function listDir(dir: string): Promise<DirListing> {
  dir = resolve(dir)
  const dirents = await fs.readdir(dir, { withFileTypes: true })
  const entries = await Promise.all(
    dirents.map(async (d): Promise<DirEntry> => {
      const path = join(dir, d.name)
      let isDir = d.isDirectory()
      if (d.isSymbolicLink()) isDir = await fs.stat(path).then((s) => s.isDirectory(), () => false)
      return { name: d.name, path, isDir }
    })
  )
  entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  const parent = dirname(dir)
  return { path: dir, parent: parent === dir ? null : parent, entries }
}

// ---- Change notification -----------------------------------------------------
// One non-recursive watcher per directory the sidebar has expanded; changes are
// debounced so a burst of writes (save, extract, …) yields one refresh.

const watchers = new Map<string, FSWatcher>()
const pending = new Map<string, NodeJS.Timeout>()

export function watchDir(dir: string, onChange: (dir: string) => void): void {
  if (watchers.has(dir)) return
  try {
    const w = watch(dir, { persistent: false }, () => {
      clearTimeout(pending.get(dir))
      pending.set(dir, setTimeout(() => {
        pending.delete(dir)
        onChange(dir)
      }, 150))
    })
    w.on('error', () => unwatchDir(dir))
    watchers.set(dir, w)
  } catch {
    /* unreadable or vanished directory: the listing itself reports the error */
  }
}

export function unwatchDir(dir: string): void {
  watchers.get(dir)?.close()
  watchers.delete(dir)
  clearTimeout(pending.get(dir))
  pending.delete(dir)
}

export function unwatchAll(): void {
  for (const dir of [...watchers.keys()]) unwatchDir(dir)
}
