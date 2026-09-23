import type { GraphData } from '../../preload/index'
import { renderCard } from './card'
import { GraphView, type VNode } from './view'

/**
 * The zoomed graph: a large stage over the dimmed window. No auto-revolve;
 * the mouse orbits (drag), pans (right-drag) and zooms (wheel).
 *   node click → fly to it, light its neighbours, show its card; a note also
 *                opens in the editor behind the dim.
 *   edge click → light that edge and its two ends; nothing else.
 *   empty space → clear the highlight.
 * Esc, the close button or a click on the dim closes it.
 */

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T
const overlayEl = $('#graph-overlay')
const stageEl = $('#graph-overlay .go-stage')
const canvasEl = $('#graph-overlay .go-canvas')
const cardEl = $('#graph-overlay .go-card')
const titleEl = $('#graph-overlay .go-title')
const countEl = $('#graph-overlay .go-count')

let view: GraphView | null = null
let openNote: (path: string) => void = () => {}

export function isOverlayOpen(): boolean {
  return view !== null
}

export function openOverlay(data: GraphData, seed: Map<string, { x: number; y: number; z: number }>, open: (path: string) => void): void {
  if (view) return update(data)
  openNote = open
  overlayEl.hidden = false
  cardEl.hidden = true
  describe(data)
  view = new GraphView(canvasEl, 'overlay', {
    onNodeClick: (n) => pick(n.id),
    onLinkClick: (l) => {
      cardEl.hidden = true
      view?.highlightLink(l)
    },
    onBackgroundClick: () => {
      cardEl.hidden = true
      view?.clearHighlight()
    }
  })
  view.setData(data, seed)
  // Start from afar and close in: the "zoom" into the graph.
  requestAnimationFrame(() => {
    overlayEl.classList.add('open')
    view?.zoomToFit(700)
  })
  window.addEventListener('keydown', onKey, true)
  document.dispatchEvent(new CustomEvent('graph-overlay', { detail: true }))
}

/** New data for the open overlay (the folder changed on disk). */
export function update(data: GraphData): void {
  if (!view) return
  describe(data)
  view.setData(data, view.positions())
}

export function closeOverlay(): void {
  if (!view) return
  window.removeEventListener('keydown', onKey, true)
  view.dispose()
  view = null
  overlayEl.classList.remove('open')
  overlayEl.hidden = true
  document.dispatchEvent(new CustomEvent('graph-overlay', { detail: false }))
}

function describe(data: GraphData): void {
  titleEl.textContent = data.dir.split(/[\\/]/).filter(Boolean).pop() ?? data.dir
  titleEl.title = data.dir
  const notes = data.nodes.filter((n) => n.kind === 'note').length
  countEl.textContent = `${notes} note${notes === 1 ? '' : 's'} · ${data.nodes.length - notes} tag${data.nodes.length - notes === 1 ? '' : 's'}${data.truncated ? ' · capped' : ''}`
}

/** A node was chosen, on the canvas or in the card. */
function pick(id: string): void {
  const n: VNode | undefined = view?.node(id)
  if (!view || !n) return
  view.highlightNode(id)
  view.flyTo(id)
  renderCard(cardEl, n, view.neighboursOf(id), (x) => view!.colorOf(x), pick)
  if (n.kind === 'note' && n.path) openNote(n.path)
}

function onKey(e: KeyboardEvent): void {
  // A message box (e.g. "Discard unsaved changes?") owns Escape while it is up.
  if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return
  e.preventDefault()
  e.stopPropagation()
  closeOverlay()
}

overlayEl.addEventListener('click', (e) => {
  if (!stageEl.contains(e.target as Node)) closeOverlay()
})
$('#graph-overlay .go-close').addEventListener('click', () => closeOverlay())
