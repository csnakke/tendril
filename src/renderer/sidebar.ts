import type { DirEntry } from '../preload/index'
import iconUrl from '../../icons/icon.png'
import { settings, updateSettings } from './appearance'
import { icon } from './icons/index'
import { alertBox, confirmBox } from './messageBox'
import { IMAGE_FILE, localUrl } from './paths'
import { showMenu } from './tables/menu'

/**
 * AppFlowy-style file explorer: header, search, "New note", then a lazily
 * expanded tree rooted at a folder whose name heads the section (its chevron
 * menu travels: parent, home, any folder, refresh; double-click a folder to
 * descend). Expanded folders are watched so the tree tracks disk changes.
 * The footer opens the system Trash; right-click › Move to Trash uses it too.
 * Graph folders (holding a `.tendril/graph.json` marker) are highlighted, and
 * clicking one shows its tag graph in the pane below (graph/pane.ts).
 */

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T
const sidebarEl = $('#sidebar')
const treeEl = $('#tree')
const rootNameEl = $('#root-name .name')
const rootPathEl = $('#root-path')
const searchEl = $<HTMLInputElement>('#sidebar-search input')
const splitEl = $('#sidebar-split')

let root: string | null = null
let activePath: string | null = null
let filter = ''
const expanded = new Set<string>()
const cache = new Map<string, DirEntry[]>()
/** Folders known to carry the graph marker, and the one whose graph is showing. */
const graphDirs = new Set<string>()
let activeGraph: string | null = null
let openFile: (path: string) => Promise<void> = async () => {}

// ---- Data ---------------------------------------------------------------------

async function load(dir: string): Promise<boolean> {
  try {
    const listing = await window.api.listDir(dir)
    cache.set(dir, listing.entries)
    markGraph(dir, listing.graph)
    for (const e of listing.entries) if (e.isDir) markGraph(e.path, !!e.graph)
    window.api.watchDir(dir)
    return true
  } catch {
    cache.delete(dir)
    return false
  }
}

function forget(dir: string): void {
  for (const d of [...expanded]) if (d === dir || d.startsWith(dir + '/') || d.startsWith(dir + '\\')) {
    expanded.delete(d)
    cache.delete(d)
    window.api.unwatchDir(d)
  }
}

export async function setRoot(dir: string): Promise<void> {
  if (!(await load(dir))) {
    await alertBox('Cannot open folder', dir)
    return
  }
  const old = root
  root = dir
  // Drop everything that isn't inside the new root; keep the new root's own state.
  // One folder at a time, not forget(): that also clears a folder's subfolders,
  // and the new root may be one of them (re-rooting into an expanded folder).
  for (const d of [...expanded]) {
    if (d === dir || d.startsWith(dir + '/') || d.startsWith(dir + '\\')) continue
    expanded.delete(d)
    cache.delete(d)
    window.api.unwatchDir(d)
  }
  if (old && old !== dir && !expanded.has(old)) {
    cache.delete(old)
    window.api.unwatchDir(old)
  }
  expanded.add(dir)
  render()
  void updateSettings({ sidebarRoot: dir })
}

async function toggle(dir: string): Promise<void> {
  if (expanded.has(dir)) {
    forget(dir)
  } else if (await load(dir)) {
    expanded.add(dir)
  }
  render()
}

window.api.onDirChanged(async (dir) => {
  if (!expanded.has(dir)) return
  if (!(await load(dir))) {
    if (dir === root) await goUp()
    else forget(dir)
  }
  render()
})

// ---- Graph folders -------------------------------------------------------------

function markGraph(dir: string, on: boolean): void {
  if (on) graphDirs.add(dir)
  else graphDirs.delete(dir)
}

/** Show a graph folder's graph in the pane below (null clears the pane). */
function selectGraph(dir: string | null): void {
  activeGraph = dir
  document.dispatchEvent(new CustomEvent('graph-folder-selected', { detail: dir }))
  render()
}

// Marked or unmarked from the context menu: highlight it, and show (or drop) its graph.
window.api.onGraphMarker((dir, enabled) => {
  markGraph(dir, enabled)
  if (enabled) selectGraph(dir)
  else if (dir === activeGraph) selectGraph(null)
  else render()
})

// ---- Rendering ----------------------------------------------------------------

document.addEventListener('iconset-changed', () => render())

function render(): void {
  if (!root) return
  rootNameEl.textContent = root.split(/[\\/]/).filter(Boolean).pop() ?? root
  rootPathEl.textContent = root
  rootPathEl.title = root
  const rootBtn = $('#root-name')
  rootBtn.classList.toggle('graph-folder', graphDirs.has(root))
  rootBtn.classList.toggle('graph-active', root === activeGraph)
  treeEl.replaceChildren(list(root, 0))
}

/** Search matches file names; a folder stays when it is expanded and holds a match. */
function matches(e: DirEntry): boolean {
  if (!filter) return true
  if (e.name.toLowerCase().includes(filter)) return true
  return e.isDir && expanded.has(e.path) && (cache.get(e.path) ?? []).some(matches)
}

function list(dir: string, depth: number): HTMLUListElement {
  const ul = document.createElement('ul')
  ul.setAttribute('role', 'group')
  const entries = (cache.get(dir) ?? []).filter(matches)
  if (entries.length === 0 && !filter) {
    const li = document.createElement('li')
    li.className = 'empty'
    li.style.setProperty('--depth', String(depth))
    li.textContent = 'empty'
    ul.appendChild(li)
  }
  for (const e of entries) {
    const li = document.createElement('li')
    li.dataset.path = e.path
    li.dataset.kind = e.isDir ? 'dir' : 'file'
    const row = document.createElement('div')
    row.className = 'row'
    row.style.setProperty('--depth', String(depth))
    row.title = e.path
    if (e.isDir) {
      const open = expanded.has(e.path)
      li.setAttribute('aria-expanded', String(open))
      const graph = graphDirs.has(e.path)
      row.innerHTML = `<span class="chevron">${icon('chevron-right')}</span>${icon(open ? 'folder-open' : 'folder')}<span class="name"></span>${graph ? `<span class="graph-badge" title="Graph folder">${icon('graph')}</span>` : ''}`
      if (graph) {
        row.classList.add('graph-folder')
        row.classList.toggle('graph-active', e.path === activeGraph)
      }
    } else {
      if (e.path === activePath) row.classList.add('active')
      row.draggable = true // drag into the editor: images become ![name](path)
      const kind = /\.(md|markdown|txt|html?)$/i.test(e.name) ? 'file-text' : IMAGE_FILE.test(e.name) ? 'image' : 'file'
      row.innerHTML = `<span class="chevron"></span>${icon(kind)}<span class="name"></span>`
    }
    row.querySelector('.name')!.textContent = e.name
    li.appendChild(row)
    if (e.isDir && expanded.has(e.path)) li.appendChild(list(e.path, depth + 1))
    ul.appendChild(li)
  }
  return ul
}

treeEl.addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.row')
  const li = row?.parentElement
  if (!row || !li?.dataset.path) return
  if (li.dataset.kind === 'dir') {
    if (graphDirs.has(li.dataset.path)) selectGraph(li.dataset.path)
    void toggle(li.dataset.path)
  } else {
    setPeek(false)
    void openFile(li.dataset.path)
  }
})
treeEl.addEventListener('dragstart', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-kind="file"]')
  const path = li?.dataset.path
  if (!path || !e.dataTransfer) return e.preventDefault()
  e.dataTransfer.effectAllowed = 'copy'
  e.dataTransfer.setData('application/x-tendril-paths', path)
  e.dataTransfer.setData('text/uri-list', localUrl('file', path))
  e.dataTransfer.setData('text/plain', path)
})
treeEl.addEventListener('dblclick', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-kind="dir"]')
  if (li?.dataset.path) void setRoot(li.dataset.path)
})
treeEl.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-path]')
  const path = li?.dataset.path ?? root
  if (!path) return
  const isDir = !li || li.dataset.kind === 'dir'
  window.api.explorerContextMenu(path, isDir, isDir ? path : parentOf(path), path === root)
})

window.api.onTrashRequest(async (path) => {
  const name = path.split(/[\\/]/).pop() ?? path
  if (!(await confirmBox(`Move “${name}” to the Trash?`, 'You can restore it from the system Trash.', { ok: 'Move to Trash', danger: true }))) return
  try {
    await window.api.trashItem(path)
    document.dispatchEvent(new CustomEvent('file-trashed', { detail: path }))
  } catch (err) {
    await alertBox('Could not move to Trash', (err as Error).message)
  }
})

/** Folder holding `path`; a file at a filesystem root gives that root (`/`, `C:\`). */
function parentOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (i < 0) return path
  const dir = path.slice(0, i)
  if (dir === '') return path[0] // "/note.md" → "/"
  return /^[A-Za-z]:$/.test(dir) ? dir + path[i] : dir // "C:\note.md" → "C:\"
}

/** Folder new files should go to: the sidebar root. */
export function currentRoot(): string | null {
  return root
}

// ---- Navigation ---------------------------------------------------------------

async function goUp(): Promise<void> {
  if (!root) return
  const { parent } = await window.api.listDir(root).catch(() => ({ parent: null }))
  if (parent) await setRoot(parent)
}

async function refresh(): Promise<void> {
  for (const d of expanded) await load(d)
  render()
}

const rootMenuBtn = $('#root-menu')
rootMenuBtn.addEventListener('click', () => {
  const r = rootMenuBtn.getBoundingClientRect()
  showMenu(
    [
      { label: 'Parent Folder', run: () => void goUp() },
      { label: 'Home Folder', run: () => void window.api.homeDir().then(setRoot) },
      { label: 'Open Folder…', run: () => void window.api.pickDir(root).then((d) => (d ? setRoot(d) : undefined)) },
      { sep: true },
      { label: 'Refresh', run: () => void refresh() },
      { label: 'Reveal in File Manager', run: () => root && void window.api.showInFolder(root) }
    ],
    r.left,
    r.bottom + 2
  )
})
// The folder name folds the whole tree away, like a section header.
$('#root-name').addEventListener('click', () => {
  sidebarEl.dataset.folded = String(sidebarEl.dataset.folded !== 'true')
  if (root && graphDirs.has(root)) selectGraph(root)
})

searchEl.addEventListener('input', () => {
  filter = searchEl.value.trim().toLowerCase()
  render()
})
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    searchEl.value = ''
    filter = ''
    render()
    searchEl.blur()
  }
})
$('#sidebar-new').addEventListener('click', () => document.dispatchEvent(new CustomEvent('new-note', { detail: root })))
$('#sidebar-trash').addEventListener('click', () => void window.api.openTrash())
$<HTMLImageElement>('#sidebar .sb-logo').src = iconUrl

// ---- Visibility & width -------------------------------------------------------

function applyOpen(open: boolean): void {
  document.documentElement.dataset.sidebar = open ? 'open' : 'closed'
  setPeek(false)
  $('#toolbar button[data-cmd="toggleSidebar"]').classList.toggle('active', open)
}

export function toggleSidebar(): void {
  const open = !settings().sidebarOpen
  applyOpen(open)
  void updateSettings({ sidebarOpen: open })
}

$('#sidebar-collapse').addEventListener('click', () => settings().sidebarOpen && toggleSidebar())
$('#sidebar-expand').addEventListener('click', () => !settings().sidebarOpen && toggleSidebar())

// Peek: hovering the collapsed rail floats the sidebar over the editor until
// the pointer leaves it (or a file is opened).
function setPeek(on: boolean): void {
  document.documentElement.dataset.sidebarPeek = String(on)
}
$('#sidebar-rail').addEventListener('pointerenter', () => setPeek(true))
sidebarEl.addEventListener('pointerleave', () => setPeek(false))
$('#sidebar-rail').addEventListener('pointerleave', (e) => {
  // Leaving the rail into the peeked sidebar keeps it open; anywhere else closes it.
  if (!sidebarEl.contains(e.relatedTarget as Node | null)) setPeek(false)
})

splitEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  e.preventDefault()
  splitEl.setPointerCapture(e.pointerId)
  const startX = e.clientX
  const startW = sidebarEl.getBoundingClientRect().width
  let width = startW
  const move = (ev: PointerEvent): void => {
    width = Math.min(600, Math.max(140, startW + ev.clientX - startX))
    document.documentElement.style.setProperty('--sidebar-w', `${width}px`)
  }
  const up = (): void => {
    splitEl.removeEventListener('pointermove', move)
    splitEl.removeEventListener('pointerup', up)
    void updateSettings({ sidebarWidth: Math.round(width) })
  }
  splitEl.addEventListener('pointermove', move)
  splitEl.addEventListener('pointerup', up)
})

// ---- Public -------------------------------------------------------------------

/**
 * The explorer follows the editor: whenever a file is opened (or saved under a
 * new name), the tree shows that file's folder with the file highlighted. An
 * untitled document leaves the tree where it is.
 */
export function sidebarFileOpened(path: string | null): void {
  activePath = path
  const dir = path ? parentOf(path) : null
  if (dir && dir !== root) {
    void setRoot(dir)
    return
  }
  render()
}

export async function initSidebar(open: (path: string) => Promise<void>): Promise<void> {
  openFile = open
  const s = settings()
  document.documentElement.style.setProperty('--sidebar-w', `${s.sidebarWidth}px`)
  applyOpen(s.sidebarOpen)
  if (root) return // a file opened before init already chose a root
  const start = s.sidebarRoot ?? (await window.api.homeDir())
  const ok = await load(start)
  if (root) return
  if (!ok) return setRoot(await window.api.homeDir())
  root = start
  expanded.add(start)
  render()
}
