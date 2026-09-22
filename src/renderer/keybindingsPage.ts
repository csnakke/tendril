import { settings, updateSettings } from './appearance'
import { icon } from './icons/index'
import { KEYBINDINGS, acceleratorFromEvent, formatAccelerator, resolveBindings, type Keybindings } from '../shared/keybindings'

/**
 * Settings > Keybindings: every rebindable command grouped by menu, with its
 * current shortcut. Click a shortcut and press the new keys to change it;
 * Escape cancels. Rows also offer unbind and reset-to-default. Duplicate
 * shortcuts are allowed but flagged.
 */

const dialog = document.getElementById('settings') as HTMLDialogElement
const listEl = dialog.querySelector('#keybindings') as HTMLElement
const platform = window.api.platform

let recording: string | null = null

const keysButton = (id: string): HTMLButtonElement | null => listEl.querySelector(`.kb-row[data-id="${CSS.escape(id)}"] .kb-keys`)

/**
 * Enter/leave recording without rebuilding the list: replacing the focused
 * button would fire focusout and end the recording before it started. Only
 * the two affected buttons change, and recording never depends on focus.
 */
function setRecording(id: string | null): void {
  if (recording === id) return
  if ((recording !== null) !== (id !== null)) window.api.suspendMenu(id !== null)
  const prev = recording
  recording = id
  if (prev) {
    const b = keysButton(prev)
    if (b) b.innerHTML = keyCaps(resolveBindings(overrides())[prev] ?? '')
  }
  if (id) {
    const b = keysButton(id)
    if (b) {
      b.innerHTML = '<span class="recording">Press keys… (Esc to cancel)</span>'
      b.focus()
    }
  }
}

const overrides = (): Keybindings => settings().keybindings ?? {}

async function setBinding(id: string, accel: string | null): Promise<void> {
  const next = { ...overrides() }
  if (accel === null) delete next[id]
  else next[id] = accel
  await updateSettings({ keybindings: next })
  document.dispatchEvent(new CustomEvent('settings-changed'))
  renderKeybindings()
}

function keyCaps(accel: string): string {
  const parts = formatAccelerator(accel, platform)
  return parts.length ? parts.map((p) => `<kbd>${p}</kbd>`).join('<span class="plus">+</span>') : '<span class="unbound">unbound</span>'
}

export function renderKeybindings(): void {
  const keys = resolveBindings(overrides())
  const users = new Map<string, string[]>()
  for (const [id, k] of Object.entries(keys)) if (k) users.set(k, [...(users.get(k) ?? []), id])

  listEl.replaceChildren()
  let group = ''
  for (const def of KEYBINDINGS) {
    if (def.group !== group) {
      group = def.group
      const h = document.createElement('div')
      h.className = 'kb-group'
      h.textContent = group
      listEl.appendChild(h)
    }
    const row = document.createElement('div')
    row.className = 'kb-row'
    row.dataset.id = def.id
    const current = keys[def.id]
    const changed = current !== def.default
    const clash = current && (users.get(current)?.length ?? 0) > 1
    row.innerHTML =
      `<span class="kb-label"></span>` +
      `<button type="button" class="kb-keys${changed ? ' changed' : ''}${clash ? ' clash' : ''}" title="Click, then press the new shortcut">${keyCaps(current)}</button>` +
      `<span class="kb-actions">` +
      `<button type="button" class="kb-unbind" title="Remove shortcut"${current ? '' : ' disabled'}>${icon('x')}</button>` +
      `<button type="button" class="kb-reset" title="Reset to default"${changed ? '' : ' disabled'}>${icon('refresh-cw')}</button>` +
      `</span>`
    row.querySelector('.kb-label')!.textContent = def.label
    if (clash) {
      const others = users.get(current)!.filter((i) => i !== def.id).map((i) => KEYBINDINGS.find((k) => k.id === i)?.label ?? i)
      const warn = document.createElement('div')
      warn.className = 'kb-warn'
      warn.textContent = `Also used by: ${others.join(', ')}`
      row.appendChild(warn)
    }
    listEl.appendChild(row)
  }
  // The list was rebuilt underneath a recording (settings changed elsewhere): drop it.
  if (recording) {
    const id = recording
    recording = null
    setRecording(id)
  }
}

listEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement
  const row = t.closest<HTMLElement>('.kb-row')
  const id = row?.dataset.id
  if (!id) return
  if (t.closest('.kb-unbind')) return void setBinding(id, '')
  if (t.closest('.kb-reset')) return void setBinding(id, null)
  if (t.closest('.kb-keys')) {
    setRecording(recording === id ? null : id)
  }
})

// Capture the shortcut on keydown at the window, ahead of the editor and the
// dialog's own handling, and regardless of where focus ended up.
window.addEventListener(
  'keydown',
  (e) => {
    if (!recording) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') return setRecording(null)
    const accel = acceleratorFromEvent(e, platform)
    if (!accel) return // a lone modifier: keep waiting
    const id = recording
    setRecording(null)
    void setBinding(id, accel)
  },
  true
)

// Clicking anywhere but the recording button stops recording.
document.addEventListener(
  'mousedown',
  (e) => {
    if (recording && (e.target as HTMLElement).closest('.kb-keys') !== keysButton(recording)) setRecording(null)
  },
  true
)

dialog.addEventListener('close', () => recording && setRecording(null))

dialog.querySelector('#keybindings-reset')!.addEventListener('click', async () => {
  await updateSettings({ keybindings: {} })
  document.dispatchEvent(new CustomEvent('settings-changed'))
  renderKeybindings()
})
