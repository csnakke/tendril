import type { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/**
 * Pasting a URL over selected text turns the selection into a Markdown link,
 * `[text](url)`, the way Obsidian and GitHub's editor do. An empty selection
 * pastes the URL as usual. lang-markdown's own pasteURLAsLink is switched off
 * in favour of this: it refuses selections that touch any formatting, handles
 * only the main selection and keeps a trailing newline inside the link.
 *
 * Implemented as a clipboard input filter so CodeMirror's own paste code does
 * the insertion (it flushes pending DOM selection reads first, which a
 * handler dispatching on its own would race). The filter also runs for drops,
 * where the text lands at the pointer rather than over the selection, so a
 * paste listener marks the pastes it should act on.
 */

const URL_RE = /^((https?|ftp|mailto|xmpp):\S+|www\.\S+)$/i

/** The text to insert for pasting `text` over the selection: one link per selected range, or null for an ordinary paste. */
export function linkPasteText(state: EditorState, text: string): string | null {
  let url = text.trim()
  const { ranges } = state.selection
  if (!URL_RE.test(url) || ranges.some((r) => r.empty)) return null
  if (/^www\./i.test(url)) url = 'https://' + url
  // One line per range is how CodeMirror distributes a paste over several selections.
  const links = ranges.map((r) => `[${state.sliceDoc(r.from, r.to)}](${url})`)
  return links.length === 1 || links.every((l) => !l.includes('\n')) ? links.join('\n') : null
}

let pasting = false

export const linkPaste = [
  EditorView.domEventHandlers({
    paste: () => {
      pasting = true
      queueMicrotask(() => (pasting = false))
      return false
    }
  }),
  EditorView.clipboardInputFilter.of((text, state) => (pasting ? linkPasteText(state, text) : null) ?? text)
]
