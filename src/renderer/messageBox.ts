import iconUrl from '../../icons/icon.png'

/**
 * In-app replacement for window.alert / window.confirm / the native close
 * prompt: a <dialog> that follows the theme and interface font and shows the
 * app icon. One box at a time; opening another cancels the first.
 */

export interface MessageButton {
  label: string
  kind?: 'primary' | 'danger' | 'default'
}

export interface MessageOptions {
  title: string
  detail?: string
  buttons: MessageButton[]
  /** Button index returned on Escape / backdrop click; defaults to the last button. */
  cancel?: number
}

const dialog = document.getElementById('msgbox') as HTMLDialogElement
const $ = <T extends HTMLElement>(sel: string): T => dialog.querySelector(sel) as T
$<HTMLImageElement>('.mb-icon').src = iconUrl

let pending: ((index: number) => void) | null = null
let cancelIndex = 0

function finish(index: number): void {
  const resolve = pending
  pending = null
  if (dialog.open) dialog.close()
  resolve?.(index)
}

export function messageBox(opts: MessageOptions): Promise<number> {
  if (pending) finish(cancelIndex)
  cancelIndex = opts.cancel ?? opts.buttons.length - 1
  $('.mb-title').textContent = opts.title
  const detail = $('.mb-detail')
  detail.textContent = opts.detail ?? ''
  detail.hidden = !opts.detail
  const bar = $('.mb-buttons')
  bar.replaceChildren(
    ...opts.buttons.map((b, i) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = b.label
      btn.className = b.kind ?? 'default'
      btn.addEventListener('click', () => finish(i))
      return btn
    })
  )
  dialog.showModal()
  const primary = bar.querySelector<HTMLButtonElement>('button.primary') ?? bar.querySelector('button')
  primary?.focus()
  return new Promise((resolve) => (pending = resolve))
}

export const isMessageBoxOpen = (): boolean => pending !== null

/** An error's message for display; Electron wraps errors thrown by ipcMain.handle, keep only the message. */
export const errorMessage = (err: unknown): string =>
  String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function alertBox(title: string, detail?: string): Promise<void> {
  return messageBox({ title, detail, buttons: [{ label: 'OK', kind: 'primary' }] }).then(() => undefined)
}

export async function confirmBox(
  title: string,
  detail?: string,
  opts: { ok?: string; cancel?: string; danger?: boolean } = {}
): Promise<boolean> {
  const i = await messageBox({
    title,
    detail,
    buttons: [
      { label: opts.cancel ?? 'Cancel' },
      { label: opts.ok ?? 'OK', kind: opts.danger ? 'danger' : 'primary' }
    ],
    cancel: 0
  })
  return i === 1
}

// Escape and backdrop clicks cancel; Enter activates the focused (primary) button natively.
dialog.addEventListener('cancel', (e) => {
  e.preventDefault()
  finish(cancelIndex)
})
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) finish(cancelIndex)
})
