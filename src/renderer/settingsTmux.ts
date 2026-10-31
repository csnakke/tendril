import { terminalFontFamily } from './appearance'
import { confirmBox, errorMessage } from './messageBox'

/**
 * Settings › TMUX: the config the terminal's tmux starts with (main/tmux.ts).
 * Save has tmux check it first, then open terminals load it at once; Reset
 * puts the default back in the editor (saved only with Save).
 */

const page = document.querySelector('#settings section[data-page="tmux"]') as HTMLElement
const editor = page.querySelector('#tmux-conf') as HTMLTextAreaElement
const stateEl = page.querySelector('#tmux-state') as HTMLElement
const saveEl = page.querySelector('#tmux-save') as HTMLButtonElement

let saved = ''
let defaultText = ''

function setState(text: string, error = false): void {
  stateEl.textContent = text
  stateEl.classList.toggle('error', error)
}

const dirty = (): boolean => editor.value !== saved

export async function syncTmux(): Promise<void> {
  editor.style.fontFamily = terminalFontFamily()
  const c = await window.api.tmuxGetConfig()
  saved = c.text
  defaultText = c.defaultText
  editor.value = c.text
  page.querySelector<HTMLElement>('#tmux-missing')!.hidden = c.installed
  setState('')
}

/** Settings is closing: unsaved changes are kept only on Save. False to stay. */
export async function leaveTmux(): Promise<boolean> {
  if (!dirty()) return true
  const discard = await confirmBox('Discard the tmux changes?', 'The tmux config has changes that are not saved.', { ok: 'Discard', danger: true })
  if (discard) editor.value = saved
  return discard
}

editor.addEventListener('input', () => setState(dirty() ? 'Unsaved changes' : ''))
// Tab indents here instead of leaving the editor.
editor.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return
  e.preventDefault()
  editor.setRangeText('    ', editor.selectionStart, editor.selectionEnd, 'end')
  editor.dispatchEvent(new Event('input'))
})

saveEl.addEventListener('click', async () => {
  saveEl.disabled = true
  setState('Checking…')
  try {
    const text = editor.value
    const problem = await window.api.tmuxSaveConfig(text)
    if (problem) return setState(`Not saved. tmux says: ${problem}`, true)
    saved = text
    setState(dirty() ? 'Unsaved changes' : 'Saved. Open terminals use it now.')
  } catch (err) {
    setState(`Not saved: ${errorMessage(err)}`, true)
  } finally {
    saveEl.disabled = false
  }
})

page.querySelector('#tmux-reset')!.addEventListener('click', () => {
  editor.value = defaultText
  setState(dirty() ? 'Default config in the editor; Save to use it.' : '')
})
