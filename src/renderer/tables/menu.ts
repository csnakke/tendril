import type { EditorView } from '@codemirror/view'
import { deleteTable, insertTable, tableCapabilities, tableCommands, tableContext, type TableContext } from './editor'
import type { Align } from './model'
import { tablePicker } from './picker'
import { openImageDialog } from '../images'
import { chartAt } from '../charts/editor'
import { openChartDialog, saveChartSvgAt } from '../charts/dialog'

/**
 * Word-style right-click menu for the editor: Cut/Copy/Paste everywhere,
 * Insert Table outside a table, and the table layout/design commands inside
 * one. An in-app menu (not Electron's native one) so colour swatches and the
 * table-size grid can be shown inline.
 */

export interface MenuItem {
  label?: string
  sep?: boolean
  disabled?: boolean
  checked?: boolean
  run?: () => void
  sub?: MenuItem[] | ((close: () => void) => HTMLElement)
}
type Item = MenuItem

let open: HTMLElement | null = null

function close(): void {
  open?.remove()
  open = null
  document.removeEventListener('mousedown', onOutside, true)
  document.removeEventListener('keydown', onKey, true)
  window.removeEventListener('blur', close)
  window.removeEventListener('resize', close)
}
const onOutside = (e: MouseEvent): void => {
  if (open && !open.contains(e.target as Node)) close()
}
const onKey = (e: KeyboardEvent): void => {
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}

/** Show a floating element at (x, y); it closes on outside click, Escape, blur, resize. */
export function showPopup(el: HTMLElement, x: number, y: number): void {
  close()
  document.body.appendChild(el)
  open = el
  clamp(el, x, y)
  document.addEventListener('mousedown', onOutside, true)
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', close)
  window.addEventListener('resize', close)
}

export const closePopup = close

/** A plain in-app menu at (x, y), e.g. for a dropdown button. */
export function showMenu(items: MenuItem[], x: number, y: number): void {
  showPopup(build(items, close), x, y)
}

/** Keep a fixed-position box inside the viewport. */
function clamp(el: HTMLElement, x: number, y: number): void {
  el.style.left = `${x}px`
  el.style.top = `${y}px`
  const r = el.getBoundingClientRect()
  if (r.right > innerWidth - 8) el.style.left = `${Math.max(8, x - r.width)}px`
  if (r.bottom > innerHeight - 8) el.style.top = `${Math.max(8, innerHeight - 8 - r.height)}px`
}

function build(items: Item[], done: () => void): HTMLElement {
  const menu = document.createElement('div')
  menu.className = 'ctx-menu'
  for (const it of items) {
    if (it.sep) {
      menu.appendChild(Object.assign(document.createElement('div'), { className: 'ctx-sep' }))
      continue
    }
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'ctx-item' + (it.sub ? ' has-sub' : '')
    row.disabled = !!it.disabled
    row.innerHTML = `<span class="ctx-check">${it.checked ? '✓' : ''}</span><span class="ctx-label"></span>${it.sub ? '<span class="ctx-arrow">›</span>' : ''}`
    row.querySelector('.ctx-label')!.textContent = it.label ?? ''
    if (it.sub) {
      const sub = typeof it.sub === 'function' ? it.sub(done) : build(it.sub, done)
      sub.classList.add('ctx-sub')
      row.appendChild(sub)
      row.addEventListener('mouseenter', () => {
        // Flip to the left when the submenu would leave the window.
        sub.classList.remove('flip')
        if (sub.getBoundingClientRect().right > innerWidth - 8) sub.classList.add('flip')
      })
    } else if (it.run) {
      const run = it.run
      row.addEventListener('click', () => {
        done()
        run()
      })
    }
    menu.appendChild(row)
  }
  return menu
}

// ---- Colours (Word's Office palette) -----------------------------------------------

const THEME = ['#ffffff', '#000000', '#e7e6e6', '#44546a', '#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47']
const STANDARD = ['#c00000', '#ff0000', '#ffc000', '#ffff00', '#92d050', '#00b050', '#00b0f0', '#0070c0', '#002060', '#7030a0']

const hex = (n: number): string => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')
function mixWith(colour: string, target: number, t: number): string {
  const c = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16))
  return '#' + c.map((v) => hex(v + (target - v) * t)).join('')
}
/** Word's five tint/shade rows under each theme colour. */
function shades(colour: string): string[] {
  const l = [1, 3, 5].reduce((s, i) => s + parseInt(colour.slice(i, i + 2), 16), 0) / 765
  if (l > 0.9) return [0.05, 0.15, 0.25, 0.35, 0.5].map((t) => mixWith(colour, 0, t))
  if (l < 0.1) return [0.5, 0.35, 0.25, 0.15, 0.05].map((t) => mixWith(colour, 255, t))
  return [mixWith(colour, 255, 0.8), mixWith(colour, 255, 0.6), mixWith(colour, 255, 0.4), mixWith(colour, 0, 0.25), mixWith(colour, 0, 0.5)]
}

function swatches(current: string | undefined, pick: (colour: string | undefined) => void): (close: () => void) => HTMLElement {
  return (done) => {
    const box = document.createElement('div')
    box.className = 'ctx-menu swatch-menu'
    const grid = (title: string, rows: string[][]): void => {
      const h = document.createElement('div')
      h.className = 'swatch-title'
      h.textContent = title
      box.appendChild(h)
      const g = document.createElement('div')
      g.className = 'swatch-grid'
      for (const row of rows)
        for (const c of row) {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = 'swatch' + (c === current ? ' active' : '')
          b.style.background = c
          b.title = c
          b.addEventListener('click', () => {
            done()
            pick(c)
          })
          g.appendChild(b)
        }
      box.appendChild(g)
    }
    const themeRows = [THEME, ...Array.from({ length: 5 }, (_, i) => THEME.map((c) => shades(c)[i]))]
    grid('Theme colours', themeRows)
    grid('Standard colours', [STANDARD])
    const foot = document.createElement('div')
    foot.className = 'swatch-foot'
    const none = document.createElement('button')
    none.type = 'button'
    none.className = 'ctx-item'
    none.innerHTML = `<span class="ctx-check">${current ? '' : '✓'}</span><span class="ctx-label">No colour</span>`
    none.addEventListener('click', () => {
      done()
      pick(undefined)
    })
    const custom = document.createElement('button')
    custom.type = 'button'
    custom.className = 'ctx-item'
    custom.innerHTML = '<span class="ctx-check"></span><span class="ctx-label">More colours…</span>'
    const input = document.createElement('input')
    input.type = 'color'
    input.value = current ?? '#ffffff'
    input.className = 'swatch-input'
    input.addEventListener('change', () => pick(input.value))
    custom.addEventListener('click', () => {
      done()
      // The picker must stay in the document while it is open.
      document.body.appendChild(input)
      input.addEventListener('change', () => input.remove(), { once: true })
      input.click()
    })
    foot.append(none, custom)
    box.appendChild(foot)
    return box
  }
}

// ---- Menu ----------------------------------------------------------------------------

function clipboardItems(view: EditorView): Item[] {
  const sel = view.state.selection.main
  const text = view.state.sliceDoc(sel.from, sel.to)
  const copy = (): void => void navigator.clipboard.writeText(text)
  return [
    { label: 'Cut', disabled: sel.empty, run: () => { copy(); view.dispatch(view.state.replaceSelection('')) } },
    { label: 'Copy', disabled: sel.empty, run: copy },
    { label: 'Paste', run: () => void navigator.clipboard.readText().then((t) => { if (t) view.dispatch(view.state.replaceSelection(t)) }) }
  ]
}

const insertTableItem = (view: EditorView): Item => ({
  label: 'Insert Table',
  sub: (done) => tablePicker((c, r) => { done(); insertTable(view, c, r) })
})

function tableItems(view: EditorView, ctx: TableContext): Item[] {
  const cap = tableCapabilities(ctx)
  const cell = ctx.parsed.grid.rows[ctx.cursor.row]?.[ctx.cursor.col]
  const colAlign = ctx.parsed.grid.aligns[ctx.cursor.col] ?? null
  const alignItem = (label: string, align: Align | null): Item => ({
    label,
    checked: colAlign === align,
    run: () => tableCommands.setColumnAlign(view, ctx, align)
  })
  return [
    {
      label: 'Insert',
      sub: [
        { label: 'Insert Columns to the Left', run: () => tableCommands.insertColumnLeft(view, ctx) },
        { label: 'Insert Columns to the Right', run: () => tableCommands.insertColumnRight(view, ctx) },
        { label: 'Insert Rows Above', run: () => tableCommands.insertRowAbove(view, ctx), disabled: ctx.rect.r1 === 0 },
        { label: 'Insert Rows Below', run: () => tableCommands.insertRowBelow(view, ctx) }
      ]
    },
    {
      label: 'Delete',
      sub: [
        { label: 'Delete Columns', run: () => tableCommands.deleteColumns(view, ctx), disabled: ctx.parsed.grid.aligns.length <= 1 },
        { label: 'Delete Rows', run: () => tableCommands.deleteRows(view, ctx), disabled: ctx.rect.r1 === 0 },
        { label: 'Delete Table', run: () => deleteTable(view, ctx) }
      ]
    },
    { sep: true },
    { label: 'Merge and Center', run: () => tableCommands.merge(view, ctx), disabled: !cap.canMerge },
    { label: 'Split Cells', run: () => tableCommands.unmerge(view, ctx), disabled: !cap.canUnmerge },
    { sep: true },
    { label: 'Shading', sub: swatches(cell?.marker?.bg, (bg) => tableCommands.setMarker(view, ctx, { bg })) },
    { label: 'Font Color', sub: swatches(cell?.marker?.fg, (fg) => tableCommands.setMarker(view, ctx, { fg })) },
    {
      label: 'Align Column',
      sub: [alignItem('Default', null), alignItem('Align Left', 'left'), alignItem('Center', 'center'), alignItem('Align Right', 'right')]
    },
    { sep: true },
    { label: 'Banded Rows', checked: !!ctx.options.banded, run: () => tableCommands.setOptions(view, ctx, { banded: !ctx.options.banded }) },
    { label: 'Wrap Text', checked: !ctx.options.nowrap, run: () => tableCommands.setOptions(view, ctx, { nowrap: !ctx.options.nowrap }) }
  ]
}

/** Toolbar / Edit menu entry point: the size grid under the toolbar button. */
export function openInsertTablePicker(view: EditorView, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect()
  const picker = tablePicker((c, r) => {
    close()
    insertTable(view, c, r)
  })
  picker.classList.add('ctx-menu')
  showPopup(picker, r.left, r.bottom + 4)
}

/** `promptMe` opens the AI prompt bar; it lives outside this module because the bar builds on showPopup. */
export function installTableMenu(view: EditorView, promptMe: () => void): void {
  view.dom.addEventListener('contextmenu', (e) => {
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
    if (pos == null) return
    e.preventDefault()
    const sel = view.state.selection.main
    if (pos < sel.from || pos > sel.to) view.dispatch({ selection: { anchor: pos } })
    const ctx = tableContext(view.state)
    const chart = chartAt(view.state, pos)
    const picture: Item = { label: 'Insert Picture…', run: openImageDialog }
    const prompt: Item = { label: 'Prompt Me…', run: promptMe }
    const insertChart: Item = { label: 'Insert Chart…', run: () => openChartDialog(view) }
    const items = ctx
      ? [...clipboardItems(view), { sep: true }, prompt, { sep: true }, picture, { sep: true }, ...tableItems(view, ctx)]
      : chart
        ? [
            ...clipboardItems(view),
            { sep: true },
            { label: 'Edit Chart…', run: () => openChartDialog(view, chart.from) },
            { label: 'Save Chart as SVG to assets/', run: () => void saveChartSvgAt(view, chart.from) }
          ]
        : [...clipboardItems(view), { sep: true }, prompt, { sep: true }, insertTableItem(view), picture, insertChart]
    showPopup(build(items, close), e.clientX, e.clientY)
  })
  view.scrollDOM.addEventListener('scroll', close)
}
