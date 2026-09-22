import { EditorSelection, Prec, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, keymap } from '@codemirror/view'
import { settings } from './appearance'
import { icon } from './icons/index'
import { alertBox, errorMessage } from './messageBox'
import { closePopup, showPopup } from './tables/menu'

/**
 * "Prompt Me": a one-line prompt bar at the cursor. While the provider
 * (Settings › AI) is thinking, a "Waiting for LLM Response…" marker sits at the
 * caret and follows it wherever it moves; the reply then streams in from
 * wherever the caret is by then. Selected text goes along as context and stays
 * in place. Escape stops a reply that is still arriving.
 */

// Where the next piece of the reply goes. Kept in editor state so it follows
// any edits the user makes elsewhere while the reply is streaming in.
const setInsertPos = StateEffect.define<number | null>()
const insertPos = StateField.define<number | null>({
  create: () => null,
  update(pos, tr) {
    for (const e of tr.effects) if (e.is(setInsertPos)) return e.value
    return pos === null ? null : tr.changes.mapPos(pos, 1)
  }
})

// Whether a request is out and nothing has come back yet.
const setWaiting = StateEffect.define<boolean>()
const waiting = StateField.define<boolean>({
  create: () => false,
  update(on, tr) {
    for (const e of tr.effects) if (e.is(setWaiting)) return e.value
    return on
  }
})

/** The dots are animated in CSS, so the widget is pure markup and can be rebuilt freely. */
class WaitingWidget extends WidgetType {
  eq(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-llm-waiting'
    el.setAttribute('aria-live', 'polite')
    el.textContent = 'Waiting for LLM Response'
    const dots = el.appendChild(document.createElement('span'))
    dots.className = 'cm-llm-dots'
    return el
  }
}

const waitingWidget = Decoration.widget({ widget: new WaitingWidget(), side: 1 })

// Recomputed on every selection change, so the marker rides along with the caret.
// `to` is the caret, or the end of a selection that is still standing.
const waitingMarker = EditorView.decorations.compute([waiting, 'selection'], (state) =>
  state.field(waiting) ? Decoration.set([waitingWidget.range(state.selection.main.to)]) : Decoration.none
)

let busy = false

/** Editor extension: the waiting marker, reply position tracking, and Escape to stop a running reply. */
export const promptStream = [
  insertPos,
  waiting,
  waitingMarker,
  Prec.highest(
    keymap.of([
      {
        key: 'Escape',
        run: () => {
          if (!busy) return false
          window.api.llmCancel()
          return true
        }
      }
    ])
  )
]

export function openPromptBar(view: EditorView): void {
  if (settings().llmProvider === 'none') {
    void alertBox('No AI provider is active', 'Choose a local LLM or OpenRouter in Settings › AI first.')
    return
  }
  const bar = document.createElement('form')
  bar.className = 'prompt-bar'
  bar.innerHTML = `<span class="pb-icon">${icon('sparkles')}</span><input type="text" placeholder="Ask the model… (Enter to send, Esc to close)" autocomplete="off" spellcheck="false" /><button type="submit" title="Send">${icon('send')}</button>`
  const input = bar.querySelector('input')!
  const button = bar.querySelector('button')!
  if (busy) {
    input.disabled = button.disabled = true
    input.placeholder = 'A reply is still arriving (Esc in the editor stops it)…'
  }
  bar.addEventListener('submit', (e) => {
    e.preventDefault()
    const prompt = input.value.trim()
    if (!prompt || busy) return
    closePopup()
    void send(view, prompt)
  })
  // The bar hangs below the cursor line (or the selection's end).
  const { main } = view.state.selection
  const coords = view.coordsAtPos(main.to)
  const box = view.dom.getBoundingClientRect()
  showPopup(bar, box.left + 24, (coords?.bottom ?? box.top) + 6)
  bar.style.width = `${Math.max(320, Math.min(640, box.width - 48))}px`
  input.focus()
}

async function send(view: EditorView, prompt: string): Promise<void> {
  const { main } = view.state.selection
  const selection = main.empty ? '' : view.state.sliceDoc(main.from, main.to)
  // A box, not a plain local: the callback below assigns it, and TypeScript
  // does not track that through the closure.
  const out: { stream: Stream | null } = { stream: null }
  busy = true
  view.dispatch({ effects: setWaiting.of(true) })
  view.dom.classList.add('prompting')
  view.focus()
  try {
    const reply = await window.api.llmComplete(prompt, selection, (text) => {
      // The first piece decides the spot: wherever the caret has ended up.
      if (!out.stream) {
        stopWaiting(view)
        out.stream = new Stream(view, view.state.selection.main.to)
      }
      out.stream.append(text)
    })
    stopWaiting(view)
    out.stream?.finish(reply === null)
  } catch (err) {
    stopWaiting(view)
    out.stream?.finish(true)
    await alertBox('The model did not answer', errorMessage(err))
  } finally {
    busy = false
    view.dom.classList.remove('prompting')
  }
}

function stopWaiting(view: EditorView): void {
  if (view.state.field(waiting, false)) view.dispatch({ effects: setWaiting.of(false) })
}

/**
 * Writes the reply into the document piece by piece. Mid-line, the reply
 * becomes its own block (blank line before and after); leading whitespace is
 * dropped from the first piece and trailing whitespace trimmed at the end.
 * The caret rides along only while it sits at the insertion point.
 */
class Stream {
  /** The reply as inserted so far (prefix excluded); its trailing whitespace is what finish() trims. */
  private written = ''
  private readonly suffix: string
  private readonly prefix: string

  constructor(private readonly view: EditorView, at: number) {
    const line = view.state.doc.lineAt(at)
    this.prefix = view.state.sliceDoc(line.from, at).trim() ? '\n\n' : ''
    this.suffix = view.state.sliceDoc(at, line.to).trim() ? '\n\n' : ''
    view.dispatch({ effects: setInsertPos.of(at) })
  }

  append(text: string): void {
    const first = !this.written
    if (first) text = text.replace(/^\s+/, '')
    if (!text) return
    this.written += text
    this.insert(first ? this.prefix + text : text)
  }

  /** Tidy the end of the reply (or of whatever arrived before a cancel/error) and stop tracking. */
  finish(interrupted: boolean): void {
    const { view } = this
    const pos = view.state.field(insertPos)
    if (pos === null) return
    if (!this.written) return view.dispatch({ effects: setInsertPos.of(null) })
    const trailing = /\s*$/.exec(this.written)![0].length
    this.replace(pos - trailing, pos, interrupted ? '' : this.suffix, null)
  }

  private insert(text: string): void {
    const pos = this.view.state.field(insertPos)
    if (pos !== null) this.replace(pos, pos, text, pos + text.length)
  }

  /** One transaction: the edit, the next insertion point, and the caret if it was riding at the end of the reply. */
  private replace(from: number, to: number, insert: string, next: number | null): void {
    const { view } = this
    const { main } = view.state.selection
    const follow = main.empty && main.head === to
    view.dispatch({
      changes: { from, to, insert },
      effects: setInsertPos.of(next),
      selection: follow ? EditorSelection.cursor(from + insert.length) : undefined,
      scrollIntoView: follow,
      userEvent: 'input.prompt'
    })
  }
}
