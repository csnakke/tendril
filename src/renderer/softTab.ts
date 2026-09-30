import { indentLess, indentMore } from '@codemirror/commands'
import { indentUnit } from '@codemirror/language'
import { EditorSelection, EditorState, countColumn, type Extension } from '@codemirror/state'
import { keymap, type Command } from '@codemirror/view'

/**
 * Tab inserts spaces, as in Sublime Text: up to the next tab stop at each
 * caret, or, when a selection spans lines, indents those lines instead.
 * Shift-Tab outdents. CodeMirror binds neither by default (Tab moves focus
 * out of the editor), so without this Tab did nothing useful.
 *
 * Inside a table, the table keymap (listed earlier) takes Tab first to move
 * between cells.
 */

const insertSoftTab: Command = (view) => {
  const { state } = view
  if (state.readOnly) return false
  const multiLine = state.selection.ranges.some((r) => state.doc.lineAt(r.from).number !== state.doc.lineAt(r.to).number)
  if (multiLine) return indentMore(view)
  const size = state.tabSize
  view.dispatch(
    state.update(
      state.changeByRange((r) => {
        const line = state.doc.lineAt(r.from)
        const col = countColumn(line.text.slice(0, r.from - line.from), size)
        const pad = ' '.repeat(size - (col % size))
        return { changes: { from: r.from, to: r.to, insert: pad }, range: EditorSelection.cursor(r.from + pad.length) }
      }),
      { scrollIntoView: true, userEvent: 'input.type' }
    )
  )
  return true
}

export const softTabKeymap = keymap.of([
  { key: 'Tab', run: insertSoftTab },
  { key: 'Shift-Tab', run: indentLess }
])

/** Tab width and indent unit for a tab size from Settings › Editor. */
export function tabSizeConfig(size: number): Extension {
  const n = Math.min(16, Math.max(1, Math.round(size) || 4))
  return [EditorState.tabSize.of(n), indentUnit.of(' '.repeat(n))]
}
