import type { SshPrompt } from '../preload/index'

/**
 * The dialog ssh's prompts appear in (askpass, answered in main/ssh/remote.ts):
 * a password or passphrase with "Save in pass", a host to trust, or a plain
 * question. Prompts queue up and are shown one at a time. Also asks for the
 * address of a quick connection.
 */

const dialog = document.getElementById('ssh-prompt') as HTMLDialogElement
const $ = <T extends HTMLElement>(sel: string): T => dialog.querySelector(sel) as T
const titleEl = $('.sp-title')
const detailEl = $('.sp-detail')
const inputEl = $<HTMLInputElement>('.sp-input')
const saveEl = $('.sp-save')
const saveBox = $<HTMLInputElement>('.sp-save input')
const okEl = $<HTMLButtonElement>('.sp-ok')
const cancelEl = $<HTMLButtonElement>('.sp-cancel')

interface Request {
  title: string
  detail: string
  kind: SshPrompt['kind']
  canSave: boolean
  placeholder?: string
  ok?: string
  done: (value: string | null, save: boolean) => void
}

const queue: Request[] = []
let current: Request | null = null

function show(): void {
  if (current || !queue.length) return
  current = queue.shift()!
  titleEl.textContent = current.title
  detailEl.textContent = current.detail
  detailEl.hidden = !current.detail
  inputEl.hidden = current.kind === 'confirm'
  inputEl.type = current.kind === 'secret' ? 'password' : 'text'
  inputEl.value = ''
  inputEl.placeholder = current.placeholder ?? ''
  saveEl.hidden = !current.canSave
  saveBox.checked = false
  okEl.textContent = current.ok ?? (current.kind === 'confirm' ? 'Trust and connect' : 'OK')
  cancelEl.textContent = current.kind === 'confirm' ? 'Don’t connect' : 'Cancel'
  dialog.showModal()
  ;(current.kind === 'confirm' ? cancelEl : inputEl).focus()
}

function finish(ok: boolean): void {
  const req = current
  if (!req) return
  current = null
  const value = ok ? (req.kind === 'confirm' ? 'yes' : inputEl.value) : null
  const save = ok && saveBox.checked
  inputEl.value = ''
  dialog.close()
  req.done(value, save)
  show()
}

okEl.addEventListener('click', () => finish(true))
cancelEl.addEventListener('click', () => finish(false))
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    finish(true)
  }
})
dialog.addEventListener('cancel', (e) => {
  e.preventDefault()
  finish(false)
})

window.api.onSshPrompt((p) => {
  queue.push({ ...p, done: (value, save) => window.api.sshPromptReply(p.id, value, save) })
  show()
})

/** Ask for a secret (a new passphrase, …); null when cancelled. */
export function promptSecret(title: string, detail: string, ok = 'OK'): Promise<string | null> {
  return new Promise((resolve) => {
    queue.push({ title, detail, kind: 'secret', canSave: false, ok, done: (v) => resolve(v) })
    show()
  })
}

/** Ask for one line of text (e.g. user@host for a quick connection); null when cancelled. */
export function promptText(title: string, detail: string, placeholder: string, ok = 'OK'): Promise<string | null> {
  return new Promise((resolve) => {
    queue.push({ title, detail, kind: 'text', canSave: false, placeholder, ok, done: (v) => resolve(v) })
    show()
  })
}
