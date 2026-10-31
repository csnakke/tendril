import type { RevealTarget } from '../preload/index'
import { mountIcons } from './icons/index'
import { alertBox, errorMessage } from './messageBox'

/**
 * Eye buttons on password fields. Text being typed is shown and hidden at
 * once. A saved password (the field is empty) comes from pass only after the
 * store's master passphrase is typed; the main process checks it for real
 * (main/ssh/remote.ts). A shown saved password is cleared again when hidden or
 * when the form is reset, and typedValue() ignores it, so saving the form
 * does not write it back.
 */

interface Eye {
  input: HTMLInputElement
  btn: HTMLButtonElement
  /** What is saved for this field, or null when nothing is (or it is a plain field). */
  saved?: () => RevealTarget | null
}

const eyes = new Map<HTMLInputElement, Eye>()
/** Inputs showing a revealed saved password, with that password. */
const revealed = new WeakMap<HTMLInputElement, string>()

function setShown(eye: Eye, shown: boolean): void {
  eye.input.type = shown ? 'text' : 'password'
  eye.btn.title = shown ? 'Hide password' : 'Show password'
  eye.btn.setAttribute('aria-pressed', String(shown))
  eye.btn.innerHTML = `<i data-icon="${shown ? 'eye-off' : 'eye'}"></i>`
  mountIcons(eye.btn)
}

/** Hide the field again; a revealed saved password is taken out of it. */
export function hideSecret(input: HTMLInputElement): void {
  const eye = eyes.get(input)
  if (!eye) return
  if (revealed.has(input)) {
    if (input.value === revealed.get(input)) input.value = ''
    revealed.delete(input)
  }
  setShown(eye, false)
}

/** Hide every eye field under `root` (the form is reset, Settings closes, …). */
export function hideSecrets(root: ParentNode): void {
  for (const input of eyes.keys()) if (root.contains(input)) hideSecret(input)
}

/** What was typed: '' while the field only shows the saved password, so saving keeps it as it is. */
export function typedValue(input: HTMLInputElement): string {
  return revealed.has(input) && input.value === revealed.get(input) ? '' : input.value
}

async function toggle(eye: Eye): Promise<void> {
  const { input } = eye
  if (input.type === 'text') return hideSecret(input)
  if (input.value || !eye.saved) return setShown(eye, true)
  const target = eye.saved()
  if (!target) {
    await alertBox('Nothing is saved here', 'There is no saved password for this field yet. What you type here is shown when you click the eye.')
    return
  }
  const st = await window.api.sshPassStatus()
  if (!st.ready) {
    await alertBox('Nothing is saved here', 'Tendril’s password store is not set up, so no password is saved yet.')
    return
  }
  // Loaded when needed: the prompt dialog has an eye of its own, from here.
  const { promptSecret } = await import('./sshPrompt')
  const passphrase = await promptSecret('Show saved password', 'Enter the passphrase of Tendril’s password store (the one chosen when it was set up).', 'Show')
  if (passphrase === null) return
  try {
    const value = await window.api.secretReveal(target, passphrase)
    if (!input.isConnected) return
    input.value = value
    revealed.set(input, value)
    setShown(eye, true)
  } catch (err) {
    await alertBox('Could not show the password', errorMessage(err))
  }
}

/**
 * Give `input` an eye button. With `saved`, an empty field can show the saved
 * password (after the master passphrase); without, the eye only shows what
 * is typed.
 */
export function addEye(input: HTMLInputElement, saved?: () => RevealTarget | null): HTMLButtonElement {
  const known = eyes.get(input)
  if (known) return known.btn
  const wrap = document.createElement('span')
  wrap.className = 'pw-wrap'
  input.replaceWith(wrap)
  wrap.append(input)
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'pw-eye'
  wrap.append(btn)
  const eye: Eye = { input, btn, saved }
  eyes.set(input, eye)
  setShown(eye, false)
  // A click keeps focus in the field (Tab still reaches the button).
  btn.addEventListener('mousedown', (e) => e.preventDefault())
  btn.addEventListener('click', () => void toggle(eye))
  // A new value typed over a revealed one is the user's own: saving writes it.
  input.addEventListener('input', () => {
    if (revealed.has(input) && input.value !== revealed.get(input)) revealed.delete(input)
  })
  return btn
}
