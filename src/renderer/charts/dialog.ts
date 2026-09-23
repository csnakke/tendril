import type { EditorView } from '@codemirror/view'
import { saveAsset } from '../images'
import { alertBox, errorMessage } from '../messageBox'
import { sanitizeHtml } from '../sanitize'
import { chartAt, chartBlocks, insertChart, replaceChart, setSvgRegion, type ChartBlock } from './editor'
import {
  clampOption, DEFAULT_OPTIONS, parseChart, PALETTE_NAMES, pointColor, sampleChart, seriesColor, serializeChart,
  type ChartOptions, type ChartSpec, type ChartType
} from './model'
import { renderChartSvg } from './svg'

/**
 * Insert / Edit Chart: a data grid and every style option on the left, the
 * chart as it will render on the right. It writes the ```chart block; the
 * YAML stays hand-editable, and this dialog reads back whatever is there.
 */

const dialog = document.getElementById('chartbox') as HTMLDialogElement
const $ = <T extends HTMLElement>(sel: string): T => dialog.querySelector(sel) as T
const form = $<HTMLElement>('.cb-form')
const canvas = $<HTMLElement>('.cb-canvas')
const okBtn = $<HTMLButtonElement>('.cb-ok')
const titleEl = $<HTMLElement>('#chartbox-title')

let view: EditorView
let target: ChartBlock | null = null
let spec: ChartSpec = sampleChart('bar3d')

// ---- Opening, applying -------------------------------------------------------------

/** Open on the chart at `pos` (default: the cursor), or on a new one. */
export function openChartDialog(v: EditorView, pos = v.state.selection.main.head): void {
  view = v
  target = chartAt(v.state, pos)
  let notice = ''
  if (target) {
    const r = parseChart(target.yaml)
    if ('spec' in r) spec = r.spec
    else {
      spec = sampleChart('bar3d')
      notice = `The chart's YAML could not be read (${r.error}). Updating replaces it with this one.`
    }
  } else spec = sampleChart('bar3d')
  titleEl.textContent = target ? 'Edit chart' : 'Insert chart'
  okBtn.textContent = target ? 'Update' : 'Insert'
  buildForm(notice)
  refresh()
  dialog.showModal()
}

/** Spec as it will be written: a pie keeps only its first series. */
function forWriting(s: ChartSpec): ChartSpec {
  return s.type === 'pie3d' && s.series.length > 1 ? { ...s, series: [s.series[0]] } : s
}

/** Write the chart into the note; answers the block it now occupies. */
function apply(): ChartBlock | null {
  const yaml = serializeChart(forWriting(spec))
  const block = target ? replaceChart(view, target, yaml) : insertChart(view, yaml)
  dialog.close()
  view.focus()
  return block
}

const slug = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

/** Render the chart as a standalone .svg into assets/ and link it below the fence. */
async function exportSvg(v: EditorView, block: ChartBlock, s: ChartSpec): Promise<void> {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n${renderChartSvg(forWriting(s), { standalone: true })}\n`
  const name = `chart-${slug(s.title) || block.index}.svg`
  const data = new TextEncoder().encode(svg)
  const rel = await saveAsset(name, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, true)
  if (!rel) return
  // Saving an untitled note (and its TOC refresh) may have moved the block: find it again.
  const now = chartBlocks(v.state)[block.index - 1]
  if (now) setSvgRegion(v, now, s.title || `Chart ${block.index}`, rel)
}

/** Right-click › Save Chart as SVG: the chart at `pos`, as it is written. */
export async function saveChartSvgAt(v: EditorView, pos: number): Promise<void> {
  const block = chartAt(v.state, pos)
  if (!block) return
  const r = parseChart(block.yaml)
  if ('error' in r) return alertBox('Cannot save the chart', r.error)
  try {
    await exportSvg(v, block, r.spec)
  } catch (err) {
    await alertBox('Could not save the chart as SVG', errorMessage(err))
  }
}

okBtn.addEventListener('click', () => void apply())
$('.cb-cancel').addEventListener('click', () => dialog.close())
$('.cb-close').addEventListener('click', () => dialog.close())
$('.cb-svg').addEventListener('click', async () => {
  const s = spec
  const block = apply()
  if (!block) return
  try {
    await exportSvg(view, block, s)
  } catch (err) {
    await alertBox('Could not save the chart as SVG', errorMessage(err))
  }
})
dialog.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    void apply()
  }
})
dialog.querySelectorAll<HTMLButtonElement>('[data-type]').forEach((b) =>
  b.addEventListener('click', () => {
    spec.type = b.dataset.type as ChartType
    buildForm()
    refresh()
  })
)

// ---- Preview ----------------------------------------------------------------------

let frame = 0
function refresh(): void {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => {
    canvas.innerHTML = sanitizeHtml(`<figure class="chart chart-${spec.options.align}">${renderChartSvg(forWriting(spec))}</figure>`)
  })
}

// ---- Small builders ----------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props)
  e.append(...children)
  return e
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const row = el('label', { className: 'cb-field' }, el('span', { className: 'cb-label', textContent: label }), control)
  if (hint) row.title = hint
  return row
}

function section(title: string, ...rows: HTMLElement[]): HTMLElement {
  return el('section', { className: 'cb-section' }, el('h3', { textContent: title }), ...rows)
}

/**
 * A colour swatch: click to pick, right-click to go back to automatic.
 * `current` null means automatic (shown in `fallback`).
 */
function swatch(current: string | null, fallback: string, onChange: (c: string | null) => void, autoWord = 'automatic'): HTMLElement {
  const b = el('button', { type: 'button', className: 'cb-swatch' })
  let shown = current
  const paint = (c: string | null): void => {
    shown = c
    b.style.background = c ?? fallback
    b.classList.toggle('auto', !c)
    b.title = `${c ?? autoWord} — click to choose, right-click for ${autoWord}`
  }
  paint(current)
  const input = el('input', { type: 'color', className: 'cb-color-input' })
  b.addEventListener('click', () => {
    input.value = shown ?? (/^#[0-9a-f]{6}$/i.test(fallback) ? fallback : '#4472c4')
    input.click()
  })
  input.addEventListener('input', () => {
    paint(input.value)
    onChange(input.value)
  })
  b.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    paint(null)
    onChange(null)
  })
  return el('span', { className: 'cb-swatch-wrap' }, b, input)
}

function textInput(value: string, onInput: (v: string) => void, placeholder = ''): HTMLInputElement {
  const i = el('input', { type: 'text', value, placeholder, spellcheck: false, autocomplete: 'off' })
  i.addEventListener('input', () => onInput(i.value))
  return i
}

function select<T extends string | number>(value: T, options: [T, string][], onChange: (v: T) => void): HTMLSelectElement {
  const s = el('select')
  for (const [v, label] of options) s.append(el('option', { value: String(v), textContent: label, selected: v === value }))
  s.addEventListener('change', () => onChange(options.find(([v]) => String(v) === s.value)![0]))
  return s
}

// ---- Option controls ----------------------------------------------------------------

type OptKey = keyof ChartOptions

function setOpt<K extends OptKey>(k: K, v: ChartOptions[K]): void {
  spec.options[k] = v
  refresh()
}

function range(k: OptKey, min: number, max: number, step: number, unit = ''): HTMLElement {
  const value = spec.options[k] as number
  const out = el('output', { textContent: fmt(value) + unit })
  const r = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) })
  r.addEventListener('input', () => {
    out.textContent = fmt(Number(r.value)) + unit
    setOpt(k, Number(r.value) as never)
  })
  return el('span', { className: 'cb-range' }, r, out)
}
const fmt = (n: number): string => String(Math.round(n * 100) / 100)

function numberInput(k: OptKey, nullable = false): HTMLInputElement {
  const v = spec.options[k] as number | null
  const i = el('input', { type: 'number', value: v == null ? '' : String(v), placeholder: nullable ? 'auto' : '' })
  i.addEventListener('change', () => {
    const t = i.value.trim()
    if (t === '' && nullable) return setOpt(k, null as never)
    const n = Number(t)
    if (!Number.isFinite(n)) return
    const c = clampOption(k, n)
    if (c !== n) i.value = String(c)
    setOpt(k, c as never)
  })
  return i
}

function check(k: OptKey, label: string, hint?: string): HTMLElement {
  const c = el('input', { type: 'checkbox', checked: !!spec.options[k] })
  c.addEventListener('change', () => setOpt(k, c.checked as never))
  const row = el('label', { className: 'cb-check' }, c, el('span', { textContent: label }))
  if (hint) row.title = hint
  return row
}

function textOpt(k: OptKey, placeholder = ''): HTMLInputElement {
  return textInput(String(spec.options[k] ?? ''), (v) => setOpt(k, v as never), placeholder)
}

/** Colour option with an automatic value ('auto' follows the text colour, 'none' is transparent). */
function colorOpt(k: OptKey, autoValue: 'auto' | 'none', fallback: string): HTMLElement {
  const v = String(spec.options[k])
  return swatch(v === autoValue ? null : v, fallback, (c) => setOpt(k, (c ?? autoValue) as never), autoValue === 'none' ? 'none' : 'automatic')
}

// ---- Form ----------------------------------------------------------------------------

function buildForm(notice = ''): void {
  dialog.querySelectorAll<HTMLButtonElement>('[data-type]').forEach((b) => b.classList.toggle('active', b.dataset.type === spec.type))
  const pie = spec.type === 'pie3d'
  const parts: HTMLElement[] = []
  if (notice) parts.push(el('div', { className: 'cb-notice', textContent: notice }))

  parts.push(
    section(
      'Chart',
      field('Title', textInput(spec.title, (v) => ((spec.title = v), refresh()), 'Findings by severity')),
      field('Caption', textInput(spec.caption, (v) => ((spec.caption = v), refresh()), 'Optional note under the chart')),
      field(
        'Palette',
        select(
          Array.isArray(spec.palette) ? '(custom)' : spec.palette,
          [...(Array.isArray(spec.palette) ? [['(custom)', 'Custom (from YAML)'] as [string, string]] : []), ...PALETTE_NAMES.map((p) => [p, cap(p)] as [string, string])],
          (v) => {
            if (v === '(custom)') return
            spec.palette = v
            buildForm()
            refresh()
          }
        ),
        'Severity colours Critical/High/Medium/Low/Info by name, whatever their order'
      )
    )
  )
  parts.push(dataSection())
  parts.push(
    section(
      'Labels & legend',
      field(
        'Data labels',
        select(spec.options.labels, [['auto', pie ? 'Auto (percent)' : 'Auto (value)'], ['value', 'Value'], ['percent', 'Percent'], ['label', pie ? 'Name (outside)' : 'Series / category name'], ['none', 'None']], (v) => setOpt('labels', v))
      ),
      field('Legend', select(spec.options.legend, [['auto', 'Auto'], ['right', 'Right'], ['bottom', 'Bottom'], ['top', 'Top'], ['none', 'None']], (v) => setOpt('legend', v))),
      field('Decimals', select(spec.options.decimals, [[-1, 'Auto'], [0, '0'], [1, '1'], [2, '2'], [3, '3'], [4, '4']], (v) => setOpt('decimals', v))),
      field('Prefix', textOpt('prefix', 'e.g. $')),
      field('Suffix', textOpt('suffix', 'e.g. %, k, h'))
    )
  )
  parts.push(
    section(
      '3D',
      field('Depth', range('depth', 0, 80, 1, ' px')),
      ...(pie
        ? [
            field('Tilt', range('tilt', 15, 90, 1, '°'), '90° looks straight down'),
            field('Rotation', range('rotation', -180, 180, 1, '°'), 'Where the first slice starts, clockwise from 12 o\'clock'),
            field('Donut hole', range('donut', 0, 0.8, 0.05)),
            field('Explode by', range('explodeDistance', 0, 60, 1, ' px'), 'Tick “Pull out” on a slice in the data grid')
          ]
        : [field('Angle', range('angle', 10, 80, 1, '°'), 'Direction the bars recede in'), field('Bar gap', range('gap', 0, 0.9, 0.05))]),
      el('div', { className: 'cb-checks' }, check('gradient', 'Gradient'), check('edges', 'Edges'), ...(pie ? [check('shadow', 'Shadow')] : []))
    )
  )
  if (!pie) {
    parts.push(
      section(
        'Bars & axes',
        el(
          'div',
          { className: 'cb-checks' },
          check('stacked', 'Stacked'),
          check('horizontal', 'Horizontal'),
          check('grid', 'Walls & grid'),
          ...(spec.series.length === 1 ? [check('varyColors', 'Colour per bar')] : [])
        ),
        field('Grid colour', colorOpt('gridColor', 'auto', '#d0d7de')),
        el('div', { className: 'cb-trio' }, field('Min', numberInput('min', true)), field('Max', numberInput('max', true)), field('Step', numberInput('step', true))),
        field('Value axis title', textOpt('valueTitle')),
        field('Category axis title', textOpt('categoryTitle'))
      )
    )
  }
  parts.push(
    section(
      'Size & text',
      el('div', { className: 'cb-trio' }, field('Width', numberInput('width')), field('Height', numberInput('height')), field('Font size', numberInput('fontSize'))),
      field('Font', textOpt('font', 'Document font')),
      field('Align', select(spec.options.align, [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']], (v) => setOpt('align', v))),
      el(
        'div',
        { className: 'cb-colors' },
        field('Text', colorOpt('textColor', 'auto', 'currentColor')),
        field('Title', colorOpt('titleColor', 'auto', 'currentColor')),
        field('Background', colorOpt('background', 'none', 'transparent'))
      ),
      el('button', { type: 'button', className: 'cb-link', textContent: 'Reset style options', onclick: resetStyle })
    )
  )
  form.replaceChildren(...parts)
}

function resetStyle(): void {
  spec.options = { ...DEFAULT_OPTIONS, explode: spec.options.explode }
  buildForm()
  refresh()
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

// ---- Data grid -------------------------------------------------------------------------

function dataSection(): HTMLElement {
  const pie = spec.type === 'pie3d'
  const series = pie ? spec.series.slice(0, 1) : spec.series
  const pointColours = pie || spec.series.length === 1
  const table = el('table', { className: 'cb-grid' })

  // Header: series names (and their colours) over the value columns.
  const head = el('tr', {}, el('th', { className: 'cb-move' }), el('th', { textContent: 'Label' }))
  series.forEach((s, si) => {
    const name = textInput(s.name, (v) => ((s.name = v), refresh()), series.length > 1 ? `Series ${si + 1}` : 'Value')
    const cell = el('th', { className: 'cb-series' }, name)
    if (!pointColours) cell.append(swatch(s.color ?? null, seriesColor(spec, si), (c) => ((s.color = c ?? undefined), refresh())))
    if (series.length > 1)
      cell.append(el('button', { type: 'button', className: 'cb-x', title: 'Remove series', textContent: '×', onclick: () => removeSeries(si) }))
    head.append(cell)
  })
  if (pointColours) head.append(el('th', { textContent: 'Colour' }))
  if (pie) head.append(el('th', { textContent: 'Pull out' }))
  head.append(el('th'))
  table.append(el('thead', {}, head))

  const tbody = el('tbody')
  spec.categories.forEach((label, r) => {
    const row = el('tr')
    row.append(
      el(
        'td',
        { className: 'cb-move' },
        el('button', { type: 'button', title: 'Move up', textContent: '▲', disabled: r === 0, onclick: () => moveRow(r, -1) }),
        el('button', { type: 'button', title: 'Move down', textContent: '▼', disabled: r === spec.categories.length - 1, onclick: () => moveRow(r, 1) })
      )
    )
    const labelIn = textInput(label, (v) => {
      const old = spec.categories[r]
      spec.categories[r] = v
      // A pulled-out slice stays pulled out when renamed.
      spec.options.explode = spec.options.explode.map((x) => (x === old ? v : x))
      refresh()
    })
    labelIn.addEventListener('paste', pasteGrid)
    row.append(el('td', {}, labelIn))
    series.forEach((s) => {
      const v = el('input', { type: 'text', inputMode: 'decimal', value: String(s.values[r] ?? 0), className: 'cb-num' })
      v.addEventListener('input', () => {
        const n = Number(v.value.replace(/,/g, ''))
        v.classList.toggle('bad', v.value.trim() !== '' && !Number.isFinite(n))
        s.values[r] = Number.isFinite(n) ? n : 0
        refresh()
      })
      v.addEventListener('paste', pasteGrid)
      row.append(el('td', {}, v))
    })
    if (pointColours) row.append(el('td', {}, swatch(spec.pointColors[r] ?? null, pointColor({ ...spec, pointColors: [] }, r), (c) => ((spec.pointColors[r] = c), refresh()))))
    if (pie) {
      const all = spec.options.explode.includes('*')
      const c = el('input', { type: 'checkbox', checked: all || spec.options.explode.includes(label) })
      c.addEventListener('change', () => {
        const list = all ? spec.categories.slice() : spec.options.explode.slice()
        const name = spec.categories[r]
        spec.options.explode = c.checked ? [...new Set([...list, name])] : list.filter((x) => x !== name)
        refresh()
      })
      row.append(el('td', { className: 'cb-center' }, c))
    }
    row.append(el('td', {}, el('button', { type: 'button', className: 'cb-x', title: 'Remove row', textContent: '×', disabled: spec.categories.length <= 1, onclick: () => removeRow(r) })))
    tbody.append(row)
  })
  table.append(tbody)

  const tools = el(
    'div',
    { className: 'cb-grid-tools' },
    el('button', { type: 'button', textContent: '+ Row', onclick: addRow }),
    ...(pie ? [] : [el('button', { type: 'button', textContent: '+ Series', onclick: addSeries })]),
    el('span', { className: 'hint', textContent: 'Tip: paste cells from a spreadsheet into any cell.' })
  )
  const extra = pie && spec.series.length > 1 ? [el('div', { className: 'cb-notice', textContent: `A pie shows one series: “${spec.series[0].name || 'Series 1'}”. The others are dropped when you insert it.` })] : []
  return section('Data', ...extra, el('div', { className: 'cb-grid-wrap' }, table), tools)
}

function rebuild(): void {
  buildForm()
  refresh()
}

function addRow(): void {
  spec.categories.push(`Item ${spec.categories.length + 1}`)
  for (const s of spec.series) s.values.push(0)
  spec.pointColors.push(null)
  rebuild()
  const inputs = form.querySelectorAll<HTMLInputElement>('.cb-grid tbody tr:last-child input[type="text"]')
  inputs[0]?.focus()
  inputs[0]?.select()
}

function removeRow(r: number): void {
  const name = spec.categories[r]
  spec.categories.splice(r, 1)
  for (const s of spec.series) s.values.splice(r, 1)
  spec.pointColors.splice(r, 1)
  spec.options.explode = spec.options.explode.filter((x) => x !== name)
  rebuild()
}

function moveRow(r: number, d: number): void {
  const to = r + d
  const swap = <T>(a: T[]): void => {
    ;[a[r], a[to]] = [a[to], a[r]]
  }
  swap(spec.categories)
  swap(spec.pointColors)
  for (const s of spec.series) swap(s.values)
  rebuild()
}

function addSeries(): void {
  spec.series.push({ name: `Series ${spec.series.length + 1}`, values: spec.categories.map(() => 0) })
  rebuild()
}

function removeSeries(i: number): void {
  spec.series.splice(i, 1)
  rebuild()
}

/**
 * Cells pasted from a spreadsheet (tab-separated; comma or semicolon for
 * CSV): first column labels, the rest values. A first row whose value cells
 * are not numbers names the series. A single value pastes as usual.
 */
function pasteGrid(e: ClipboardEvent): void {
  const text = e.clipboardData?.getData('text/plain') ?? ''
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim())
  const sep = text.includes('\t') ? '\t' : text.includes(';') ? ';' : ','
  if (lines.length < 2 && !text.includes('\t')) return
  e.preventDefault()
  const rows = lines.map((l) => l.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, '$1')))
  const isNum = (c: string): boolean => c !== '' && Number.isFinite(Number(c.replace(/,/g, '')))
  const header = rows[0].slice(1).length > 0 && !rows[0].slice(1).some(isNum) ? rows.shift()! : null
  const width = Math.max(1, ...rows.map((r) => r.length - 1))
  const pie = spec.type === 'pie3d'
  const cols = pie ? 1 : width
  spec.categories = rows.map((r) => r[0] ?? '')
  spec.series = Array.from({ length: cols }, (_, c) => ({
    name: header?.[c + 1] ?? spec.series[c]?.name ?? (cols > 1 ? `Series ${c + 1}` : ''),
    color: spec.series[c]?.color,
    values: rows.map((r) => {
      const n = Number((r[c + 1] ?? '').replace(/,/g, ''))
      return Number.isFinite(n) ? n : 0
    })
  }))
  spec.pointColors = spec.categories.map(() => null)
  spec.options.explode = []
  rebuild()
}
