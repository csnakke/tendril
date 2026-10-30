import type { RemoteEntry, RemoteState } from '../preload/index'
import { settings } from './appearance'
import { icon } from './icons/index'
import { alertBox, confirmBox, errorMessage } from './messageBox'
import { openSettings } from './settingsDialog'
import { currentRoot } from './sidebar'
import { promptText } from './sshPrompt'
import { showMenu } from './tables/menu'
import { runInTerminal } from './terminal'
import { activeTransfers } from './transfersPanel'

/**
 * The explorer's Remote section: connect to a saved host (Settings › SSH) or
 * a quick user@host, browse its folders like local ones, and move files:
 * drop local files or folders on a remote folder to upload, right-click to
 * download. Port forwards of the host show as switches under the header.
 * Everything over SSH happens in the main process (main/ssh/).
 */

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T
const sectionEl = $('#remote')
const labelEl = $('#remote-connect .rh-label')
const forwardsEl = $('#remote-forwards')
const treeEl = $('#remote-tree')

let state: RemoteState = { connected: false, label: '', hostId: null, home: '', forwards: [] }
let root = ''
let selected = ''
const expanded = new Set<string>()
const cache = new Map<string, RemoteEntry[]>()

const parentOf = (p: string): string => (p === '/' ? '/' : p.replace(/\/[^/]+\/?$/, '') || '/')

function size(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

// ---- Data -----------------------------------------------------------------------------

async function load(dir: string): Promise<boolean> {
  try {
    cache.set(dir, await window.api.remoteList(dir))
    return true
  } catch (err) {
    cache.delete(dir)
    await alertBox(`Cannot open ${dir}`, errorMessage(err))
    return false
  }
}

async function setRoot(dir: string): Promise<void> {
  if (!(await load(dir))) return
  root = dir
  expanded.clear()
  for (const d of [...cache.keys()]) if (d !== dir) cache.delete(d)
  expanded.add(dir)
  select(dir)
}

async function toggle(dir: string): Promise<void> {
  if (expanded.has(dir)) {
    for (const d of [...expanded]) if (d === dir || d.startsWith(dir + '/')) expanded.delete(d)
  } else if (await load(dir)) {
    expanded.add(dir)
  }
  render()
}

function select(dir: string): void {
  selected = dir
  window.api.remoteSelect(dir)
  render()
}

async function refresh(dir?: string): Promise<void> {
  for (const d of dir ? [dir] : [...expanded]) if (expanded.has(d)) await load(d)
  render()
}

// ---- Rendering ------------------------------------------------------------------------

document.addEventListener('iconset-changed', () => render())

function render(): void {
  sectionEl.dataset.state = state.connected ? 'on' : 'off'
  labelEl.textContent = state.connected ? state.label : 'Remote'
  sectionEl.title = state.error ?? ''
  forwardsEl.replaceChildren(
    ...state.forwards.map((f) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'rf'
      b.classList.toggle('on', f.on)
      b.classList.toggle('error', !!f.error)
      b.dataset.id = f.id
      b.textContent = f.label
      b.title = f.error ?? (f.on ? 'Forwarding. Click to stop.' : 'Stopped. Click to start.')
      return b
    })
  )
  if (!state.connected) {
    treeEl.replaceChildren()
    if (state.error) {
      const p = document.createElement('div')
      p.className = 'remote-error'
      p.textContent = state.error
      treeEl.appendChild(p)
    }
    return
  }
  const ul = list(root, 0)
  if (root !== '/') {
    const li = document.createElement('li')
    li.dataset.path = parentOf(root)
    li.dataset.kind = 'up'
    li.innerHTML = `<div class="row" style="--depth:0" title="Parent folder"><span class="chevron"></span>${icon('arrow-up')}<span class="name">..</span></div>`
    ul.prepend(li)
  }
  const head = document.createElement('div')
  head.className = 'remote-path'
  // Left-to-right mark: the box is right-to-left (long paths keep their end), the path itself is not.
  head.textContent = `\u200e${root}`
  head.title = root
  treeEl.replaceChildren(head, ul)
}

function list(dir: string, depth: number): HTMLUListElement {
  const ul = document.createElement('ul')
  ul.setAttribute('role', 'group')
  const entries = cache.get(dir) ?? []
  if (!entries.length) {
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
      row.innerHTML = `<span class="chevron">${icon('chevron-right')}</span>${icon(open ? 'folder-open' : 'folder')}<span class="name"></span>`
      row.classList.toggle('active', e.path === selected)
    } else {
      row.innerHTML = `<span class="chevron"></span>${icon('file')}<span class="name"></span><span class="size">${e.size || e.mtime ? size(e.size) : ''}</span>`
    }
    row.querySelector('.name')!.textContent = e.name
    li.appendChild(row)
    if (e.isDir && expanded.has(e.path)) li.appendChild(list(e.path, depth + 1))
    ul.appendChild(li)
  }
  return ul
}

const liOf = (t: EventTarget | null): HTMLElement | null => (t as HTMLElement | null)?.closest<HTMLElement>('li[data-path]') ?? null

treeEl.addEventListener('click', (e) => {
  const li = liOf(e.target)
  if (!li || !(e.target as HTMLElement).closest('.row')) return
  const path = li.dataset.path!
  if (li.dataset.kind === 'up') void setRoot(path)
  else if (li.dataset.kind === 'dir') {
    selected = path
    window.api.remoteSelect(path)
    void toggle(path)
  }
})
treeEl.addEventListener('dblclick', (e) => {
  const li = liOf(e.target)
  if (li?.dataset.kind === 'dir') void setRoot(li.dataset.path!)
})
treeEl.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  if (!state.connected) return
  const li = liOf(e.target)
  const path = li && li.dataset.kind !== 'up' ? li.dataset.path! : root
  window.api.remoteContextMenu(path, !li || li.dataset.kind !== 'file', currentRoot())
})
window.api.onRemoteRefresh((dir) => void refresh(dir))

// ---- Upload by drag and drop -----------------------------------------------------------

/** The remote folder a drop lands in: the folder under the pointer, a file's folder, else the root. */
function dropDir(target: EventTarget | null): string {
  const li = liOf(target)
  if (!li || li.dataset.kind === 'up') return root
  return li.dataset.kind === 'dir' ? li.dataset.path! : parentOf(li.dataset.path!)
}

const accepts = (dt: DataTransfer | null): boolean =>
  !!dt && (dt.types.includes('Files') || dt.types.includes('application/x-tendril-paths') || dt.types.includes('application/x-tendril-dir'))

treeEl.addEventListener('dragover', (e) => {
  if (!state.connected || !accepts(e.dataTransfer)) return
  e.preventDefault()
  e.dataTransfer!.dropEffect = 'copy'
  const dir = dropDir(e.target)
  treeEl.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'))
  treeEl.querySelector(`li[data-path="${CSS.escape(dir)}"][data-kind="dir"] > .row`)?.classList.add('drop-target')
  treeEl.classList.toggle('drop-root', dir === root)
})
treeEl.addEventListener('dragleave', (e) => {
  if (treeEl.contains(e.relatedTarget as Node | null)) return
  treeEl.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'))
  treeEl.classList.remove('drop-root')
})
treeEl.addEventListener('drop', (e) => {
  if (!state.connected || !accepts(e.dataTransfer)) return
  e.preventDefault()
  const dt = e.dataTransfer!
  const dir = dropDir(e.target)
  treeEl.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'))
  treeEl.classList.remove('drop-root')
  const paths = new Set<string>()
  for (const line of `${dt.getData('application/x-tendril-paths')}\n${dt.getData('application/x-tendril-dir')}`.split('\n')) if (line) paths.add(line)
  for (const f of [...dt.files]) {
    const p = window.api.pathForFile(f)
    if (p) paths.add(p)
  }
  if (paths.size) void window.api.remoteUpload([...paths], dir).catch((err) => alertBox('Could not upload', errorMessage(err)))
})

// ---- Header: connect, terminal, refresh, disconnect, forwards ----------------------------

async function connect(target: { hostId: string } | { quick: string }, label: string): Promise<void> {
  if (state.connected && activeTransfers() > 0 && !(await confirmBox(`Disconnect from ${state.label}?`, 'Transfers in progress stop; they can be resumed later.', { ok: 'Disconnect' }))) return
  sectionEl.dataset.state = 'connecting'
  labelEl.textContent = `Connecting to ${label}…`
  try {
    await window.api.remoteConnect(target)
  } catch (err) {
    render()
    await alertBox(`Could not connect to ${label}`, errorMessage(err))
  }
}

$('#remote-connect').addEventListener('click', () => {
  const r = $('#remote-connect').getBoundingClientRect()
  const hosts = settings().sshHosts ?? []
  showMenu(
    [
      ...hosts.map((h) => ({ label: `${h.name}  (${h.user}@${h.hostname}${h.port === 22 ? '' : `:${h.port}`})`, checked: state.hostId === h.id, run: () => void connect({ hostId: h.id }, h.name) })),
      ...(hosts.length ? [{ sep: true }] : []),
      {
        label: 'Quick Connect…',
        run: () =>
          void promptText('Quick connect', 'Uses your own SSH keys and agent (and ~/.ssh/config). Save a host in Settings › SSH to keep its key and password in pass.', 'user@host or user@host:port', 'Connect').then(
            (spec) => {
              if (spec) void connect({ quick: spec }, spec)
            }
          )
      },
      { label: 'Manage Hosts…', run: () => openSettings('ssh') },
      ...(state.connected ? [{ sep: true }, { label: `Disconnect from ${state.label}`, run: () => void disconnect() }] : [])
    ],
    r.left,
    r.bottom + 2
  )
})

async function disconnect(): Promise<void> {
  if (activeTransfers() > 0 && !(await confirmBox(`Disconnect from ${state.label}?`, 'Transfers in progress stop; they can be resumed later.', { ok: 'Disconnect' }))) return
  window.api.remoteDisconnect()
}

$('#remote-disconnect').addEventListener('click', () => void disconnect())
$('#remote-refresh').addEventListener('click', () => void refresh())
$('#remote-terminal').addEventListener('click', async () => {
  try {
    await runInTerminal(await window.api.remoteShellCommand())
  } catch (err) {
    await alertBox('Could not open a shell', errorMessage(err))
  }
})
forwardsEl.addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button.rf')
  const f = state.forwards.find((x) => x.id === b?.dataset.id)
  if (!f) return
  try {
    await window.api.remoteForward(f.id, !f.on)
  } catch (err) {
    await alertBox(`Could not ${f.on ? 'stop' : 'start'} the forward`, errorMessage(err))
  }
})

function applyState(next: RemoteState): void {
  const fresh = next.connected && (!state.connected || next.label !== state.label || next.home !== state.home)
  state = next
  if (!next.connected) {
    root = ''
    selected = ''
    expanded.clear()
    cache.clear()
  }
  if (fresh) void setRoot(next.home)
  else render()
}

// A finished upload shows up in its folder without a manual refresh.
const seenDone = new Set<number>()
window.api.onTransfers((list) => {
  for (const t of list) {
    if (t.state !== 'done' || seenDone.has(t.id)) continue
    seenDone.add(t.id)
    if (t.direction === 'up' && state.connected && t.host === state.label && expanded.has(t.dest)) void refresh(t.dest)
  }
})

window.api.onRemoteState(applyState)
void window.api.remoteState().then(applyState)
