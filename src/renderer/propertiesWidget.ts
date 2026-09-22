import { WidgetType, type EditorView } from '@codemirror/view'
import { CORE_SCHEMA, dump, load } from 'js-yaml'
import { icon } from './icons/index'

/**
 * Editable front-matter block for live preview (Obsidian-style properties).
 * Shown in place of the raw YAML while the cursor is elsewhere; edits are
 * written back as YAML into the document. Values keep their type: booleans
 * are checkboxes, numbers stay numbers, lists are comma-separated.
 */

type Data = Record<string, unknown>

function parse(yaml: string): { data: Data; error?: string } {
  try {
    // CORE schema: dates stay strings, so a round trip doesn't rewrite them.
    const v = load(yaml, { schema: CORE_SCHEMA })
    return { data: v && typeof v === 'object' && !Array.isArray(v) ? (v as Data) : {} }
  } catch (err) {
    return { data: {}, error: (err as Error).message }
  }
}

function serialise(data: Data): string {
  if (Object.keys(data).length === 0) return ''
  return dump(data, { schema: CORE_SCHEMA, flowLevel: 1, lineWidth: -1, noRefs: true })
    .replace(/\n$/, '')
    .replace(/^([^:\n]+): (null|'')$/gm, '$1:') // empty values stay bare, as people write them
}

/** Interpret an input's text in the spirit of the value it replaces. */
function coerce(text: string, previous: unknown): unknown {
  const t = text.trim()
  if (Array.isArray(previous)) return t ? t.split(',').map((s) => s.trim()).filter(Boolean) : []
  if (typeof previous === 'number' && t !== '' && !Number.isNaN(Number(t))) return Number(t)
  if (t === '') return null
  return t
}

export class PropertiesWidget extends WidgetType {
  constructor(
    /** YAML between the fences. */
    private yaml: string,
    /** Document range of the YAML lines (fences excluded). */
    private from: number,
    private to: number
  ) {
    super()
  }

  eq(o: PropertiesWidget): boolean {
    return o.yaml === this.yaml && o.from === this.from && o.to === this.to
  }

  ignoreEvent(): boolean {
    return true
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('div')
    root.className = 'lp-properties'
    root.contentEditable = 'false'
    const { data, error } = parse(this.yaml)

    const head = document.createElement('div')
    head.className = 'lp-properties-head'
    head.innerHTML = `<span class="lp-label">Properties</span><button type="button" class="lp-yaml" title="Edit as YAML">${icon('code')}</button>`
    head.querySelector('button')!.addEventListener('click', () => {
      view.dispatch({ selection: { anchor: this.from }, scrollIntoView: true })
      view.focus()
    })
    root.appendChild(head)

    if (error) {
      const p = document.createElement('div')
      p.className = 'lp-properties-error'
      p.textContent = `Invalid YAML: ${error}`
      root.appendChild(p)
      return root
    }

    const write = (next: Data): void => {
      view.dispatch({ changes: { from: this.from, to: this.to, insert: serialise(next) } })
    }

    const table = document.createElement('div')
    table.className = 'lp-properties-rows'
    for (const [key, value] of Object.entries(data)) {
      const row = document.createElement('div')
      row.className = 'lp-prop'
      const k = document.createElement('span')
      k.className = 'lp-prop-key'
      k.textContent = key
      row.appendChild(k)
      row.appendChild(this.control(key, value, data, write))
      const rm = document.createElement('button')
      rm.type = 'button'
      rm.className = 'lp-prop-remove'
      rm.title = 'Remove property'
      rm.innerHTML = icon('x')
      rm.addEventListener('click', () => {
        const next = { ...data }
        delete next[key]
        write(next)
      })
      row.appendChild(rm)
      table.appendChild(row)
    }
    root.appendChild(table)

    // "Add property": a key input that appears on demand.
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'lp-prop-add'
    add.textContent = '+ Add property'
    add.addEventListener('click', () => {
      add.hidden = true
      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'lp-prop-newkey'
      input.placeholder = 'property name'
      const done = (): void => {
        const key = input.value.trim()
        input.remove()
        add.hidden = false
        if (key && !(key in data)) write({ ...data, [key]: null })
      }
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') done()
        if (e.key === 'Escape') {
          input.value = ''
          done()
        }
      })
      input.addEventListener('blur', done)
      root.insertBefore(input, add)
      input.focus()
    })
    root.appendChild(add)
    return root
  }

  private control(key: string, value: unknown, data: Data, write: (next: Data) => void): HTMLElement {
    if (typeof value === 'boolean') {
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = value
      box.addEventListener('change', () => write({ ...data, [key]: box.checked }))
      return box
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const code = document.createElement('code')
      code.textContent = JSON.stringify(value)
      code.title = 'Nested values: edit as YAML'
      return code
    }
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'lp-prop-value' + (Array.isArray(value) ? ' list' : '')
    input.value = Array.isArray(value) ? value.map(String).join(', ') : value == null ? '' : String(value instanceof Date ? value.toISOString().slice(0, 10) : value)
    input.placeholder = Array.isArray(value) ? 'comma, separated' : 'empty'
    let committed = input.value
    const commit = (): void => {
      if (input.value === committed) return
      committed = input.value
      write({ ...data, [key]: coerce(input.value, value) })
    }
    input.addEventListener('change', commit)
    input.addEventListener('blur', commit)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur()
      if (e.key === 'Escape') {
        input.value = committed
        input.blur()
      }
    })
    return input
  }
}
