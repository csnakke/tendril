import type { GraphData } from '../../preload/index'
import { settings, updateSettings } from '../appearance'
import { errorMessage } from '../messageBox'
import { closeOverlay, isOverlayOpen, openOverlay, update as updateOverlay } from './overlay'
import { GraphView } from './view'

/**
 * The graph pane under the explorer. Empty until a graph folder is clicked in
 * the tree (sidebar.ts sends `graph-folder-selected`); then that folder's tag
 * graph revolves on its own, with no mouse input. A click zooms it into the
 * overlay. It stops drawing whenever it can't be seen.
 */

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T
const paneEl = $('#graph-pane')
const canvasEl = $('#graph-pane .gp-canvas')
const emptyEl = $('#graph-pane .gp-empty')
const titleEl = $('#graph-pane .gp-title')
const countEl = $('#graph-pane .gp-count')
const splitEl = $('#graph-split')
const switchEl = $<HTMLInputElement>('#graph-switch input')

let dir: string | null = null
let data: GraphData | null = null
let view: GraphView | null = null
let loading = 0
let openNote: (path: string) => void = () => {}

function showEmpty(message: string, hint = ''): void {
  emptyEl.replaceChildren(message)
  if (hint) {
    const small = document.createElement('small')
    small.textContent = hint
    emptyEl.append(document.createElement('br'), small)
  }
  paneEl.dataset.state = 'empty'
  closeOverlay()
  view?.dispose()
  view = null
}

async function load(folder: string): Promise<void> {
  const seq = ++loading
  titleEl.textContent = folder.split(/[\\/]/).filter(Boolean).pop() ?? folder
  titleEl.title = folder
  let next: GraphData
  try {
    next = await window.api.buildGraph(folder)
  } catch (err) {
    if (seq !== loading) return
    data = null
    countEl.textContent = ''
    return showEmpty('Could not build the graph.', errorMessage(err))
  }
  if (seq !== loading) return // a newer folder was picked meanwhile
  data = next
  const notes = next.nodes.filter((n) => n.kind === 'note').length
  countEl.textContent = notes ? `${notes} note${notes === 1 ? '' : 's'}` : ''
  if (notes === 0) {
    return showEmpty('No tagged notes here yet.', 'Add tags: [a, b] to a note’s properties.')
  }
  paneEl.dataset.state = 'graph'
  const seed = view?.positions()
  view ??= new GraphView(canvasEl, 'pane')
  view.setData(next, seed)
  if (isOverlayOpen()) updateOverlay(next)
  sync()
}

function clear(): void {
  loading++
  dir = null
  data = null
  titleEl.textContent = 'Graph'
  titleEl.title = ''
  countEl.textContent = ''
  showEmpty('Click a graph folder to show its graph.', 'Right-click a folder › Enable Graph Here')
}

// ---- Visibility --------------------------------------------------------------------
// Revolve only while the pane is on screen: sidebar and pane open, window
// focused, no overlay on top, and a canvas with a size.

let focused = document.hasFocus()

function visible(): boolean {
  return !!view && focused && !document.hidden && !isOverlayOpen() && canvasEl.offsetWidth > 0 && canvasEl.offsetHeight > 0
}

function sync(): void {
  if (!view) return
  if (visible()) {
    view.resume()
    view.startRevolve()
  } else {
    view.pause()
  }
}

new ResizeObserver(sync).observe(canvasEl)
window.addEventListener('focus', () => {
  focused = true
  sync()
})
window.addEventListener('blur', () => {
  focused = false
  sync()
})
document.addEventListener('visibilitychange', sync)
document.addEventListener('graph-overlay', sync)

// ---- Pane open / height -------------------------------------------------------------

function applyOpen(open: boolean): void {
  document.documentElement.dataset.graphPane = open ? 'open' : 'closed'
  switchEl.checked = open
  sync()
}

export function toggleGraphPane(): void {
  const open = !settings().graphPaneOpen
  applyOpen(open)
  void updateSettings({ graphPaneOpen: open })
}

switchEl.addEventListener('change', () => {
  if (switchEl.checked !== settings().graphPaneOpen) toggleGraphPane()
})

splitEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  e.preventDefault()
  splitEl.setPointerCapture(e.pointerId)
  const startY = e.clientY
  const startH = paneEl.getBoundingClientRect().height
  const max = Math.max(160, (paneEl.parentElement?.getBoundingClientRect().height ?? 600) - 200)
  let height = startH
  const move = (ev: PointerEvent): void => {
    height = Math.min(max, Math.max(120, startH - (ev.clientY - startY)))
    document.documentElement.style.setProperty('--graph-h', `${height}px`)
  }
  const up = (): void => {
    splitEl.removeEventListener('pointermove', move)
    splitEl.removeEventListener('pointerup', up)
    void updateSettings({ graphPaneHeight: Math.round(height) })
  }
  splitEl.addEventListener('pointermove', move)
  splitEl.addEventListener('pointerup', up)
})

// ---- Events -------------------------------------------------------------------------

document.addEventListener('graph-folder-selected', (e) => {
  const folder = (e as CustomEvent<string | null>).detail
  if (!folder) return clear()
  if (folder === dir && data) return
  dir = folder
  void load(folder)
})

window.api.onGraphChanged((changed) => {
  if (changed === dir) void load(changed)
})

canvasEl.addEventListener('click', () => {
  if (data && view) openOverlay(data, view.positions(), openNote)
})

export function initGraphPane(open: (path: string) => void): void {
  openNote = open
  const s = settings()
  document.documentElement.style.setProperty('--graph-h', `${s.graphPaneHeight}px`)
  applyOpen(s.graphPaneOpen)
  clear()
}
