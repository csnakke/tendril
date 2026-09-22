import { addCursorAbove, addCursorBelow } from '@codemirror/commands'
import { selectNextOccurrence, selectSelectionMatches } from '@codemirror/search'
import { EditorSelection, Prec, type Extension, type StateCommand } from '@codemirror/state'
import { EditorView, keymap, type Command, type KeyBinding } from '@codemirror/view'
import { KEYBINDINGS, resolveBindings, toCodeMirrorKey, type Keybindings } from '../shared/keybindings'

/**
 * Sublime-style multiple cursors on top of CodeMirror's built-ins (which
 * already allow several selection ranges and draw every caret):
 *
 *   Ctrl/Cmd+click, Alt+click     add a caret (drag adds a selection)
 *   Ctrl+D                        add the next occurrence of the selection
 *   Ctrl+Shift+L                  split a multi-line selection into one caret
 *                                 per line; on one line, select all matches
 *   Ctrl+Alt+↑ / ↓, Ctrl+Shift+↑ / ↓   add a caret on the line above / below
 *   Escape                        back to a single caret
 *
 * The Ctrl+Shift variants exist because GNOME grabs Ctrl+Alt+arrows for
 * workspace switching. Every key is rebindable in Settings > Keybindings.
 */

const isMac = navigator.platform.startsWith('Mac')

/** Every selected line gets its own caret at its end (Sublime's Ctrl+Shift+L). */
export const splitSelectionIntoLines: StateCommand = ({ state, dispatch }) => {
  const ranges: ReturnType<typeof EditorSelection.cursor>[] = []
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number
    const last = state.doc.lineAt(r.to).number
    if (first === last) {
      ranges.push(EditorSelection.cursor(r.to))
      continue
    }
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n)
      // A range ending at the very start of a line hasn't selected that line.
      if (n === last && r.to === line.from) break
      ranges.push(EditorSelection.cursor(n === last ? r.to : line.to))
    }
  }
  dispatch(state.update({ selection: EditorSelection.create(ranges), scrollIntoView: true, userEvent: 'select' }))
  return true
}

const spansLines = (view: EditorView): boolean =>
  view.state.selection.ranges.some((r) => view.state.doc.lineAt(r.from).number !== view.state.doc.lineAt(r.to).number)

/** Editor-scope commands by keybinding id, plus the key basicSetup already binds them to. */
const COMMANDS: Record<string, { run: Command; builtin?: string }> = {
  selectNextOccurrence: { run: selectNextOccurrence, builtin: 'Mod-d' },
  splitSelectionIntoLines: { run: (v) => (spansLines(v) ? splitSelectionIntoLines(v) : selectSelectionMatches(v)), builtin: 'Mod-Shift-l' },
  addCursorAbove: { run: addCursorAbove, builtin: 'Mod-Alt-ArrowUp' },
  addCursorBelow: { run: addCursorBelow, builtin: 'Mod-Alt-ArrowDown' }
}

/** The keymap for the user's bindings; rebuilt through a compartment when they change. */
export function multiCursorKeymap(overrides: Keybindings): Extension {
  const keys = resolveBindings(overrides)
  const bindings: KeyBinding[] = []
  const blocked: KeyBinding[] = []
  for (const def of KEYBINDINGS) {
    const cmd = COMMANDS[def.id]
    if (!cmd) continue
    const key = toCodeMirrorKey(keys[def.id])
    if (key) bindings.push({ key, run: cmd.run })
    // A customised command must not keep answering to basicSetup's own key.
    if (cmd.builtin && keys[def.id] !== def.default && key !== cmd.builtin) blocked.push({ key: cmd.builtin, run: () => true })
  }
  return Prec.high(keymap.of([...bindings, ...blocked]))
}

export const multiCursor: Extension = [
  EditorView.clickAddsSelectionRange.of((e) => e.altKey || (isMac ? e.metaKey : e.ctrlKey))
]
