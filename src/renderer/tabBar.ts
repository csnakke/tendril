import { icon } from './icons/index'

/**
 * The strip of open documents above the editor. It only draws and reports
 * clicks: main.ts owns the tabs themselves.
 *
 * Click selects, middle-click or × closes, double-click on the empty strip or
 * "+" opens a new tab, and tabs can be dragged into another order. A tab with
 * unsaved changes shows a dot in place of its × until hovered.
 */

export interface TabItem {
  id: number
  title: string
  path: string | null
  dirty: boolean
}

export interface TabBarHandlers {
  select: (id: number) => void
  close: (id: number) => void
  create: () => void
  /** Move tab `id` so it sits at `index` of the list without it. */
  move: (id: number, index: number) => void
}

const bar = document.getElementById('tabbar') as HTMLElement
let handlers: TabBarHandlers
let items: TabItem[] = []
let activeId = -1
let dragId: number | null = null

const tabOf = (target: EventTarget | null): HTMLElement | null => (target as Element | null)?.closest<HTMLElement>('.tab') ?? null
const idOf = (el: HTMLElement): number => Number(el.dataset.id)

export function renderTabs(next: TabItem[], active: number): void {
  items = next
  activeId = active
  const nodes = items.map((t) => {
    const el = document.createElement('div')
    el.className = 'tab'
    el.classList.toggle('active', t.id === active)
    el.classList.toggle('dirty', t.dirty)
    el.dataset.id = String(t.id)
    el.draggable = true
    el.setAttribute('role', 'tab')
    el.setAttribute('aria-selected', String(t.id === active))
    el.title = t.path ?? t.title
    const name = el.appendChild(document.createElement('span'))
    name.className = 'tab-name'
    name.textContent = t.title
    const close = el.appendChild(document.createElement('button'))
    close.type = 'button'
    close.className = 'tab-close'
    close.title = 'Close'
    close.setAttribute('aria-label', `Close ${t.title}`)
    close.innerHTML = icon('x')
    return el
  })
  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'tab-new'
  add.title = 'New tab'
  add.textContent = '+'
  bar.replaceChildren(...nodes, add)
  bar.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function clearDropMarks(): void {
  bar.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'))
}

export function initTabBar(h: TabBarHandlers): void {
  handlers = h
  bar.addEventListener('click', (e) => {
    const target = e.target as Element
    if (target.closest('.tab-new')) return handlers.create()
    const tab = tabOf(target)
    if (!tab) return
    if (target.closest('.tab-close')) handlers.close(idOf(tab))
    else handlers.select(idOf(tab))
  })
  // Middle button: no autoscroll cursor on press, close on release.
  bar.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault()
  })
  bar.addEventListener('auxclick', (e) => {
    const tab = tabOf(e.target)
    if (e.button === 1 && tab) handlers.close(idOf(tab))
  })
  bar.addEventListener('dblclick', (e) => {
    if (e.target === bar) handlers.create()
  })
  // Vertical wheel scrolls a crowded strip sideways.
  bar.addEventListener('wheel', (e) => {
    if (e.deltaY && !e.deltaX) {
      bar.scrollLeft += e.deltaY
      e.preventDefault()
    }
  }, { passive: false })

  bar.addEventListener('dragstart', (e) => {
    const tab = tabOf(e.target)
    if (!tab || !e.dataTransfer) return
    dragId = idOf(tab)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/x-tendril-tab', String(dragId))
  })
  bar.addEventListener('dragover', (e) => {
    const tab = tabOf(e.target)
    if (dragId === null || !tab) return
    e.preventDefault()
    clearDropMarks()
    const r = tab.getBoundingClientRect()
    tab.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after')
  })
  bar.addEventListener('dragleave', (e) => {
    if (!bar.contains(e.relatedTarget as Node | null)) clearDropMarks()
  })
  bar.addEventListener('drop', (e) => {
    const tab = tabOf(e.target)
    const from = dragId
    clearDropMarks()
    if (from === null || !tab) return
    e.preventDefault()
    const r = tab.getBoundingClientRect()
    const after = e.clientX >= r.left + r.width / 2
    const rest = items.filter((t) => t.id !== from)
    const at = rest.findIndex((t) => t.id === idOf(tab))
    if (at >= 0) handlers.move(from, at + (after ? 1 : 0))
  })
  bar.addEventListener('dragend', () => {
    dragId = null
    clearDropMarks()
  })

  document.addEventListener('iconset-changed', () => renderTabs(items, activeId))
}
